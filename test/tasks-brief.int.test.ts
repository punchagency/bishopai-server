import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import {
  emulatorUp,
  installFirestore,
  uninstallFirestore,
  clearFirestore,
} from './firestore';
import { seedAppointment, seedClient, seedSessionDocs, seedSupplement } from './fixtures';
import type { IDatabase } from '../src/db/interfaces/repositories';
import { createTasksFromNote, listOpenTasks, setTaskStatus } from '../src/tasks/service';
import { buildBrief, renderBriefText } from '../src/brief/service';
import type { SessionNote } from '../src/session/extract';

const up = await emulatorUp();
const suite = up ? describe : describe.skip;
if (!up) {
  console.log('[tasks-brief.int] Firestore emulator not running - skipping. Start: npm run firestore:emulator');
}

const NOTE: SessionNote = {
  concerns: ['Fatigue', 'Bloating'],
  goals: ['Sleep through the night'],
  assessments: ['Adrenal fatigue pattern'],
  protocol_changes: [{ description: 'Start Magnesium 2 caps', type: 'add' }],
  supplements: [{ name: 'Magnesium', dose: '2 caps', quantity: 60, change: 'start' }],
  follow_ups: [
    { text: 'Recheck B12 levels', due_in_days: 28 },
    { text: 'Watch her sleep', due_in_days: null },
  ],
  nrt: {
    pulse0: '78, thready',
    priority1: null, // never got to it
    k27: null, // never got to it
    stressors: 'chemical',
    foundation: 'CNS switched',
    body_scan: null, // never got to it
  },
  lifestyle: {
    bm: 'once daily',
    sleep: 'waking at 3am',
    water: '2L',
    cycle: null, // not discussed
    exercise: null, // not discussed
    diet: 'mostly whole foods',
  },
};

suite('tasks + prep brief (integration)', () => {
  let db: IDatabase;

  beforeAll(() => {
    db = installFirestore('tasks-brief-int');
  });
  afterAll(() => uninstallFirestore());
  beforeEach(async () => {
    await clearFirestore(db);
  });

  /** A client with a past (approved) session and a future appointment to brief for. */
  async function fixture() {
    const client = await seedClient(db, { name: 'Brief Test' });

    const past = await seedAppointment(db, {
      client_id: client.id,
      client_name: client.name,
      starts_at: new Date(Date.now() - 28 * 86_400_000).toISOString(),
      status: 'completed',
    });
    await seedSessionDocs(db, {
      client,
      appointment: past,
      sheet: { content_json: NOTE as unknown as Record<string, unknown>, status: 'approved' },
    });

    const next = await seedAppointment(db, {
      client_id: client.id,
      client_name: client.name,
      starts_at: new Date(Date.now() + 86_400_000).toISOString(),
      status: 'confirmed',
    });

    return { client: client.id, past: past.id, next: next.id };
  }

  it('promotes follow-ups to tasks, dating only the one that was given a timeframe', async () => {
    const { client, past } = await fixture();
    const sessionDate = new Date('2026-06-01T10:00:00Z');

    const r = await createTasksFromNote({
      clientId: client,
      appointmentId: past,
      sessionDate,
      note: NOTE,
    });
    expect(r.created).toBe(2);

    const tasks = await listOpenTasks(client);
    expect(tasks.map((t) => t.title)).toEqual(['Recheck B12 levels', 'Watch her sleep']);
    // 28 days after the SESSION, not after approval.
    expect(tasks[0].due_date).toBe('2026-06-29');
    // No timeframe was spoken, so there is no due date. Not a default, not a guess.
    expect(tasks[1].due_date).toBeNull();
  });

  it('is idempotent — sheet + protocol approval, and re-approval, never duplicate', async () => {
    const { client, past } = await fixture();
    const args = { clientId: client, appointmentId: past, sessionDate: new Date(), note: NOTE };

    expect((await createTasksFromNote(args)).created).toBe(2);
    expect((await createTasksFromNote(args)).created).toBe(0); // protocol approval
    expect((await createTasksFromNote(args)).created).toBe(0); // re-approval

    expect((await listOpenTasks(client)).length).toBe(2);
  });

  it('completing a task drops it out of the open list', async () => {
    const { client, past } = await fixture();
    await createTasksFromNote({ clientId: client, appointmentId: past, sessionDate: new Date(), note: NOTE });

    const [first] = await listOpenTasks(client);
    const done = await setTaskStatus(first.id, 'done');
    expect(done?.status).toBe('done');
    expect(done?.completed_at).not.toBeNull();

    const open = await listOpenTasks(client);
    expect(open.length).toBe(1);
    expect(open[0].title).toBe('Watch her sleep');
  });

  it('builds a brief carrying the last session, open tasks and the plan', async () => {
    const { client, past, next } = await fixture();
    await createTasksFromNote({ clientId: client, appointmentId: past, sessionDate: new Date(), note: NOTE });
    await seedSupplement(db, { client_id: client, name: 'Magnesium', dose: '2 caps', qty: 60 });

    const brief = await buildBrief(next);
    expect(brief).not.toBeNull();
    expect(brief!.client_name).toBe('Brief Test');
    expect(brief!.visit_number).toBe(2); // one prior visit
    expect(brief!.last_session?.concerns).toEqual(['Fatigue', 'Bloating']);
    expect(brief!.last_session?.assessments).toEqual(['Adrenal fatigue pattern']);
    expect(brief!.open_tasks.map((t) => t.title)).toContain('Recheck B12 levels');
    expect(brief!.supplements.map((s) => s.name)).toEqual(['Magnesium']);
  });

  it('reports what was NOT covered last time — the blanks are the point', async () => {
    const { next } = await fixture();
    const brief = await buildBrief(next);

    // Recorded last session → must NOT be flagged as a gap.
    expect(brief!.not_covered_last_time).not.toContain('Pulse 0');
    expect(brief!.not_covered_last_time).not.toContain('Sleep');
    // Never got to these → they come back as her checklist for this visit.
    expect(brief!.not_covered_last_time).toEqual(
      expect.arrayContaining(['Priority #1', 'K-27', 'Body scan', 'Cycle', 'Exercise']),
    );
  });

  it('returns null for an appointment with no client', async () => {
    // client_id is genuinely nullable - a walk-in recording can precede its
    // client - so the brief has to answer null rather than throw.
    const now = new Date().toISOString();
    const orphan = randomUUID();
    await db.appointments.save({
      id: orphan,
      client_id: null,
      client_name: null,
      starts_at: now,
      ends_at: new Date(Date.now() + 3_600_000).toISOString(),
      status: 'confirmed',
      created_at: now,
      updated_at: now,
    });
    expect(await buildBrief(orphan)).toBeNull();
  });

  it('renders a readable text brief for the morning digest', async () => {
    const { client, past, next } = await fixture();
    await createTasksFromNote({ clientId: client, appointmentId: past, sessionDate: new Date(), note: NOTE });

    const text = renderBriefText((await buildBrief(next))!);
    expect(text).toContain('Brief Test');
    expect(text).toContain('visit 2');
    expect(text).toContain('Recheck B12 levels');
    expect(text).toContain('Not covered last time');
    expect(text).toContain('K-27');
  });
});
