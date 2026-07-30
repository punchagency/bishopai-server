import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { emulatorUp, installFirestore, uninstallFirestore, clearFirestore } from './firestore';
import type { IDatabase } from '../src/db/interfaces/repositories';

const up = await emulatorUp();
const suite = up ? describe : describe.skip;
if (!up) {
  console.log('[session.firestore] Firestore emulator not running — skipping. Start: npm run firestore:emulator');
}

// The session/approval path against the real emulator.
//
// These are the Phase 5 guarantees, and they are here rather than against the
// in-memory mock for the reason the plan gives: the mock cannot catch a missing
// composite index, cannot catch an orderBy silently dropping documents that lack
// the field, and — most importantly here — cannot catch a compare-and-set that
// isn't one, because it has no concurrency to lose.

// Imported lazily so the adapter is installed before the modules resolve getDatabase.
let approveSession: typeof import('../src/session/sessionService')['approveSession'];
let amendSession: typeof import('../src/session/sessionService')['amendSession'];
let patchSession: typeof import('../src/session/sessionService')['patchSession'];
let listSessions: typeof import('../src/session/sessionService')['listSessions'];
let getSession: typeof import('../src/session/sessionService')['getSession'];
let fetchRevisions: typeof import('../src/session/revisions')['fetchRevisions'];
let listOpenTasks: typeof import('../src/tasks/service')['listOpenTasks'];

const APPT = 'appt-1';
const CLIENT = 'client-a';
const STARTS_AT = '2026-07-01T15:00:00Z';

const note = (over: Record<string, unknown> = {}) => ({
  concerns: ['Fatigue'],
  assessments: [],
  protocol_changes: [],
  supplements: [{ name: 'Cataplex B', dose: '2 daily', quantity: 60, change: 'start' }],
  follow_ups: [],
  ...over,
});

suite('session approval against Firestore', () => {
  let db: IDatabase;

  beforeAll(async () => {
    db = installFirestore();
    const svc = await import('../src/session/sessionService');
    approveSession = svc.approveSession;
    amendSession = svc.amendSession;
    patchSession = svc.patchSession;
    listSessions = svc.listSessions;
    getSession = svc.getSession;
    fetchRevisions = (await import('../src/session/revisions')).fetchRevisions;
    listOpenTasks = (await import('../src/tasks/service')).listOpenTasks;
  });

  afterAll(() => uninstallFirestore());

  beforeEach(async () => {
    await clearFirestore(db);
    await db.clients.save({
      id: CLIENT,
      name: 'Leeza Woodbury',
      email: 'leeza@example.com',
      created_at: STARTS_AT,
      updated_at: STARTS_AT,
    });
    await db.appointments.save({
      id: APPT,
      client_id: CLIENT,
      client_name: 'Leeza Woodbury',
      starts_at: STARTS_AT,
      ends_at: '2026-07-01T16:00:00Z',
      status: 'completed',
      created_at: STARTS_AT,
      updated_at: STARTS_AT,
    });
  });

  const seedDraft = (content: Record<string, unknown> = note()) =>
    db.sessionNotes.saveExtractedNote({
      appointmentId: APPT,
      clientId: CLIENT,
      startsAt: STARTS_AT,
      clientName: 'Leeza Woodbury',
      content,
    });

  it('writes the same note to BOTH documents, so they can never disagree', async () => {
    await seedDraft();
    const docs = await db.sessionNotes.findSessionDocs(APPT);
    expect(docs.sheet?.content_json).toEqual(docs.protocol?.content_json);
    expect(docs.sheet?.status).toBe('draft');
    expect(docs.protocol?.status).toBe('draft');
  });

  it('approves both documents and files exactly one approval', async () => {
    await seedDraft();
    const out = await approveSession(APPT, 'nicole');
    expect(out.ok).toBe(true);

    const docs = await db.sessionNotes.findSessionDocs(APPT);
    expect(docs.sheet?.status).toBe('approved');
    expect(docs.protocol?.status).toBe('approved');

    const approvals = await db.sessionNotes.listApprovals(APPT);
    expect(approvals).toHaveLength(1);
    expect(approvals[0].status).toBe('approved');
    expect(approvals[0].approved_by).toBe('nicole');
  });

  it('two concurrent approvals produce ONE approval, not two', async () => {
    await seedDraft();
    // The whole point of the guarded write. In Postgres the FOR UPDATE blocked
    // the loser; Firestore aborts and retries it, and it must then observe the
    // approved status and refuse — not re-approve.
    const [a, b] = await Promise.all([approveSession(APPT, 'nicole'), approveSession(APPT, 'nicole')]);

    const winners = [a, b].filter((r) => r.ok);
    expect(winners).toHaveLength(1);
    const loser = [a, b].find((r) => !r.ok)!;
    expect(loser.ok).toBe(false);
    if (!loser.ok) expect(loser.code).toBe(409);

    expect(await db.sessionNotes.listApprovals(APPT)).toHaveLength(1);
  });

  it('re-approving after the fact is refused, not replayed', async () => {
    await seedDraft();
    await approveSession(APPT, 'nicole');
    const again = await approveSession(APPT, 'nicole');
    expect(again.ok).toBe(false);
    if (!again.ok) expect(again.code).toBe(409);
    expect(await db.sessionNotes.listApprovals(APPT)).toHaveLength(1);
  });

  it('refuses a plain edit once approved — that needs an amendment', async () => {
    await seedDraft();
    await approveSession(APPT, 'nicole');
    const patched = await patchSession(APPT, note({ concerns: ['Changed my mind'] }));
    expect(patched.ok).toBe(false);
    if (!patched.ok) expect(patched.code).toBe(409);
  });

  it('creates follow-up tasks on approval, including ones with no due date', async () => {
    await seedDraft(
      note({
        follow_ups: [
          { text: 'Recheck B12 in 4 weeks', due_in_days: 28 },
          { text: 'Keep an eye on her sleep' }, // no due date — a legitimate value
        ],
      }),
    );
    await approveSession(APPT, 'nicole');

    const tasks = await listOpenTasks(CLIENT);
    // The null-due-date task must be PRESENT and sorted last. Firestore drops
    // documents missing an orderBy field entirely, which is why tasks carry the
    // due_sort sentinel — a bug the in-memory mock cannot see.
    expect(tasks.map((t) => t.title)).toEqual([
      'Recheck B12 in 4 weeks',
      'Keep an eye on her sleep',
    ]);
    expect(tasks[1].due_date).toBeNull();
  });

  it('syncs the supplement plan on approval, keyed on the normalized name', async () => {
    await seedDraft();
    await approveSession(APPT, 'nicole');

    const plan = await db.refills.listSupplementsByClient(CLIENT);
    expect(plan).toHaveLength(1);
    expect(plan[0].name).toBe('Cataplex B');
    expect(plan[0].qty).toBe(60);
    expect(plan[0].source).toBe('notes');
  });

  it('records the approval on the activity feed', async () => {
    await seedDraft();
    await approveSession(APPT, 'nicole');
    const feed = await db.audit.listForEntity('session', APPT);
    expect(feed.map((e) => e.action)).toContain('session.approved');
  });

  it('an extraction result never demotes an approved note back to draft', async () => {
    await seedDraft();
    await approveSession(APPT, 'nicole');

    const res = await seedDraft(note({ concerns: ['Late arriving extraction'] }));
    expect(res.written).toBe(false);

    const docs = await db.sessionNotes.findSessionDocs(APPT);
    expect(docs.sheet?.status).toBe('approved');
    expect(docs.sheet?.content_json).toMatchObject({ concerns: ['Fatigue'] });
  });

  describe('amend', () => {
    beforeEach(async () => {
      await seedDraft();
      await approveSession(APPT, 'nicole');
    });

    it('files the superseded version against BOTH documents before overwriting', async () => {
      const out = await amendSession(APPT, note({ concerns: ['Corrected'] }), 'typo', 'nicole');
      expect(out.ok).toBe(true);
      if (out.ok) expect(out.revision).toBe(1);

      for (const table of ['appointment_sheets', 'protocols'] as const) {
        const history = await fetchRevisions(table, APPT);
        expect(history).toHaveLength(1);
        expect(history[0].revision).toBe(1);
        expect(history[0].reason).toBe('typo');
        expect(history[0].content_json).toMatchObject({ concerns: ['Fatigue'] });
      }

      const live = await getSession(APPT);
      expect(live?.content_json).toMatchObject({ concerns: ['Corrected'] });
    });

    it('numbers successive amendments and never re-files a version', async () => {
      await amendSession(APPT, note({ concerns: ['v2'] }), 'first', 'nicole');
      await amendSession(APPT, note({ concerns: ['v3'] }), 'second', 'nicole');

      const history = await fetchRevisions('protocols', APPT);
      expect(history.map((h) => h.revision)).toEqual([2, 1]);
      expect(history[1].content_json).toMatchObject({ concerns: ['Fatigue'] });
      expect(history[0].content_json).toMatchObject({ concerns: ['v2'] });
    });

    it('two concurrent amendments file one revision, not two under one number', async () => {
      const [a, b] = await Promise.all([
        amendSession(APPT, note({ concerns: ['A'] }), 'a', 'nicole'),
        amendSession(APPT, note({ concerns: ['B'] }), 'b', 'nicole'),
      ]);
      // Both may legitimately succeed — the session is approved before and after
      // each — but the deterministic revision id means the history can never hold
      // two different documents claiming to be the same superseded version.
      const history = await fetchRevisions('protocols', APPT);
      const numbers = history.map((h) => h.revision);
      expect(new Set(numbers).size).toBe(numbers.length);
      expect([a.ok, b.ok]).toContain(true);
    });

    it('refuses to amend a session that was never approved', async () => {
      await db.sessionNotes.clearAll();
      await seedDraft();
      const out = await amendSession(APPT, note({ concerns: ['nope'] }), null, 'nicole');
      expect(out.ok).toBe(false);
      if (!out.ok) expect(out.code).toBe(409);
    });

    it('removes a supplement the amendment took back out', async () => {
      expect(await db.refills.listSupplementsByClient(CLIENT)).toHaveLength(1);
      await amendSession(APPT, note({ supplements: [] }), 'added the wrong one', 'nicole');
      expect(await db.refills.listSupplementsByClient(CLIENT)).toHaveLength(0);
    });
  });

  describe('listSessions', () => {
    it('separates pending from approved', async () => {
      await seedDraft();
      expect((await listSessions('pending')).map((s) => s.appointment_id)).toEqual([APPT]);
      expect(await listSessions('approved')).toHaveLength(0);

      await approveSession(APPT, 'nicole');
      expect(await listSessions('pending')).toHaveLength(0);
      expect((await listSessions('approved')).map((s) => s.appointment_id)).toEqual([APPT]);
    });

    it('lists an appointment only once it actually has a session', async () => {
      await db.appointments.save({
        id: 'appt-empty',
        client_id: CLIENT,
        client_name: 'Leeza Woodbury',
        starts_at: '2026-07-02T15:00:00Z',
        ends_at: '2026-07-02T16:00:00Z',
        status: 'scheduled',
        created_at: STARTS_AT,
        updated_at: STARTS_AT,
      });
      await seedDraft();
      expect((await listSessions('pending')).map((s) => s.appointment_id)).toEqual([APPT]);
    });

    it('searches by client name without matching sessions that have no client', async () => {
      await seedDraft();
      expect(await listSessions('pending', 100, 'woodbury')).toHaveLength(1);
      expect(await listSessions('pending', 100, 'someone else')).toHaveLength(0);
    });
  });
});
