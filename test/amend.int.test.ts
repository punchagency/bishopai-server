import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApp } from '../src/app';
import {
  emulatorUp,
  installFirestore,
  uninstallFirestore,
  clearFirestore,
} from './firestore';
import { seedAppointment, seedClient, seedSessionDocs, seedSupplement } from './fixtures';
import type { IDatabase } from '../src/db/interfaces/repositories';
import type { Client } from '../src/db/interfaces/types';

// Integration: correcting a note AFTER Nicole approved it.
//
// The rule under test is that an approved note is never edited in place. Its
// documents are already in Drive and may already be with the client, so a silent
// rewrite would leave the record and the delivered copy disagreeing with nothing
// to show it happened.
const up = await emulatorUp();
const suite = up ? describe : describe.skip;
if (!up) {
  console.log('[amend.int] Firestore emulator not running - skipping. Start: npm run firestore:emulator');
}

// The cases here build on one session in order (draft -> approve -> amend ->
// amend again), so the fixture is created once and NOT wiped between tests.
suite('amending an approved note (integration)', () => {
  let server: http.Server;
  let base = '';
  let db: IDatabase;
  let client: Client;
  let clientId = '';
  let appointmentId = '';
  let protocolId = '';

  const get = (path: string) => fetch(`${base}${path}`);
  const send = (method: 'POST' | 'PATCH', path: string, body: unknown) =>
    fetch(`${base}${path}`, {
      method,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });

  const note = (concern: string) => ({
    concerns: [concern],
    goals: [],
    assessments: [],
    protocol_changes: [],
    supplements: [],
    follow_ups: [],
  });

  /**
   * A protocol on its own appointment. The document id is the appointment id
   * (see seedSessionDocs), which is also why each of these needs an appointment
   * of its own - two protocols under one appointment would be one document.
   */
  async function makeProtocol(
    owner: Client,
    pbId: string,
    daysAgo: number,
    content: Record<string, unknown>,
    status: 'draft' | 'approved' = 'draft',
  ): Promise<{ appointmentId: string; protocolId: string }> {
    const startsAt = new Date(Date.now() - daysAgo * 86_400_000).toISOString();
    const appointment = await seedAppointment(db, {
      client_id: owner.id,
      client_name: owner.name,
      pb_id: pbId,
      starts_at: startsAt,
      ends_at: startsAt,
      status: 'completed',
    });
    const docs = await seedSessionDocs(db, {
      appointment,
      client: owner,
      protocol: { content_json: content, status },
    });
    // Only the protocol is wanted here; the sheet would make the session's
    // combined status depend on a document these cases never touch.
    await db.sessionNotes.deleteSessionDocs(appointment.id);
    await db.sessionNotes.saveProtocol(docs.protocol);
    return { appointmentId: appointment.id, protocolId: docs.protocol.id };
  }

  beforeAll(async () => {
    db = installFirestore('amend-int');
    await clearFirestore(db);
    server = http.createServer(createApp());
    await new Promise<void>((r) => server.listen(0, r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    client = await seedClient(db, { name: 'AM Amend', pb_id: 'amtest-amend' });
    clientId = client.id;
    const made = await makeProtocol(client, 'amtest-appt', 2, note('original concern'));
    appointmentId = made.appointmentId;
    protocolId = made.protocolId;
  });

  afterAll(async () => {
    await new Promise<void>((r) => server.close(() => r()));
    uninstallFirestore();
  });

  it('allows a plain edit while the note is still a draft', async () => {
    const r = await send('PATCH', `/review/protocols/${protocolId}`, {
      content_json: note('edited while draft'),
    });
    expect(r.status).toBe(200);
    expect((await r.json()).content_json.concerns).toEqual(['edited while draft']);
  });

  it('refuses a plain edit once approved, pointing at amend', async () => {
    const ok = await send('POST', `/review/protocols/${protocolId}/approve`, {});
    expect(ok.status).toBe(200);

    const r = await send('PATCH', `/review/protocols/${protocolId}`, {
      content_json: note('sneaky post-approval edit'),
    });
    expect(r.status).toBe(409);
    expect((await r.json()).error).toBe('already approved');

    // The stored note must be untouched by the refused edit.
    const cur = await db.sessionNotes.findProtocolByAppointment(appointmentId);
    expect((cur!.content_json as { concerns: string[] }).concerns).toEqual(['edited while draft']);
  });

  it('amends by filing the superseded version, not overwriting it', async () => {
    const r = await send('POST', `/review/protocols/${protocolId}/amend`, {
      content_json: note('corrected concern'),
      reason: 'misheard on the recording',
    });
    expect(r.status).toBe(200);
    const amended = await r.json();
    expect(amended.revision).toBe(1);
    expect(amended.content_json.concerns).toEqual(['corrected concern']);

    // The version she originally approved is still recoverable.
    const hist = await (await get(`/review/protocols/${protocolId}/revisions`)).json();
    expect(hist.revisions).toHaveLength(1);
    expect(hist.revisions[0].revision).toBe(1);
    expect(hist.revisions[0].content_json.concerns).toEqual(['edited while draft']);
    expect(hist.revisions[0].reason).toBe('misheard on the recording');
  });

  it('stacks revisions so each amendment is separately recoverable', async () => {
    const r = await send('POST', `/review/protocols/${protocolId}/amend`, {
      content_json: note('corrected twice'),
    });
    expect(r.status).toBe(200);
    expect((await r.json()).revision).toBe(2);

    const hist = await (await get(`/review/protocols/${protocolId}/revisions`)).json();
    expect(hist.revisions.map((x: { revision: number }) => x.revision)).toEqual([2, 1]);
    // Newest superseded version is the one the previous amendment wrote.
    expect(hist.revisions[0].content_json.concerns).toEqual(['corrected concern']);
  });

  it('records every amendment in the approvals audit trail', async () => {
    const amended = (await db.sessionNotes.listApprovals(appointmentId)).filter(
      (a) => a.status === 'amended',
    );
    expect(amended).toHaveLength(2);
  });

  it('refuses to amend a note that was never approved', async () => {
    // The protocol's document id IS its appointment id, so this needs an
    // appointment of its own.
    const draft = await makeProtocol(client, 'amtest-appt-2', 1, note('still a draft'));
    const r = await send('POST', `/review/protocols/${draft.protocolId}/amend`, {
      content_json: note('nope'),
    });
    expect(r.status).toBe(409);
    expect((await r.json()).error).toBe('not approved');
  });

  it('retracts a supplement the amendment removed, but keeps ones it only stopped changing', async () => {
    // A fresh client so the plan starts empty and the assertions are unambiguous.
    const retractClient = await seedClient(db, { name: 'AM Retract', pb_id: 'amtest-retract' });
    const cid = retractClient.id;
    // Already on the plan from an earlier session.
    await seedSupplement(db, {
      client_id: cid,
      name: 'Zypan',
      dose: '1 w/ meals',
      qty: 2,
      source: 'notes',
    });

    const withBoth = {
      ...note('x'),
      supplements: [
        { name: 'Min-Tran', dose: '1 before bed', quantity: 1, change: 'start' },
        { name: 'Zypan', dose: '2 w/ meals', quantity: 2, change: 'increase' },
      ],
    };
    const { protocolId: pid } = await makeProtocol(
      retractClient, 'amtest-retract-appt', 3, withBoth,
    );
    expect((await send('POST', `/review/protocols/${pid}/approve`, {})).status).toBe(200);

    const planNames = async () =>
      (await db.refills.listSupplementsByClient(cid)).map((x) => x.name).sort();
    expect(await planNames()).toEqual(['Min-Tran', 'Zypan']);

    // She amends: Min-Tran was never actually prescribed, and the Zypan increase
    // is retracted too — but Zypan itself predates this session and must stay.
    const r = await send('POST', `/review/protocols/${pid}/amend`, {
      content_json: { ...note('x'), supplements: [] },
      reason: 'Min-Tran was not prescribed',
    });
    expect(r.status).toBe(200);

    expect(await planNames()).toEqual(['Zypan']);
  });

  it('reconciles tasks on amend: creates added follow-ups, dismisses removed ones', async () => {
    const tasksClient = await seedClient(db, { name: 'AM Tasks', pb_id: 'amtest-tasks' });
    const cid = tasksClient.id;
    const withFollowUps = {
      ...note('x'),
      follow_ups: [
        { text: 'Recheck iron in 4 weeks', due_in_days: 28 },
        { text: 'Send lab requisition', due_in_days: null },
      ],
    };
    const { protocolId: pid } = await makeProtocol(
      tasksClient, 'amtest-tasks-appt', 3, withFollowUps,
    );
    expect((await send('POST', `/review/protocols/${pid}/approve`, {})).status).toBe(200);

    const openTitles = async () =>
      (await db.tasks.listByClient(cid))
        .filter((t) => t.status === 'open')
        .map((t) => t.title)
        .sort();
    expect(await openTitles()).toEqual(['Recheck iron in 4 weeks', 'Send lab requisition']);

    // Amend: drop the lab requisition (misheard), keep the iron recheck, add a new one.
    const r = await send('POST', `/review/protocols/${pid}/amend`, {
      content_json: {
        ...note('x'),
        follow_ups: [
          { text: 'Recheck iron in 4 weeks', due_in_days: 28 },
          { text: 'Book a 6-week review', due_in_days: 42 },
        ],
      },
      reason: 'lab requisition was not needed',
    });
    expect(r.status).toBe(200);

    expect(await openTitles()).toEqual(['Book a 6-week review', 'Recheck iron in 4 weeks']);
    // The removed one is dismissed, not deleted — its history survives.
    const dropped = (await db.tasks.listByClient(cid)).find(
      (t) => t.title === 'Send lab requisition',
    );
    expect(dropped!.status).toBe('dismissed');
  });

  it('never offers this session back as its own history', async () => {
    // A protocol and its appointment sheet share an appointment but live in
    // different tables with different ids. Excluding only by row id let the
    // sheet from THIS very session be served as the "previous session", and
    // ordering by updated_at made whichever row was touched last win.
    const appointment = (await db.appointments.findById(appointmentId))!;
    await seedSessionDocs(db, {
      appointment,
      client,
      sheet: { content_json: note('same session, other collection'), status: 'approved' },
      protocol: (await db.sessionNotes.findProtocolByAppointment(appointmentId))!,
    });

    const ctx = await (await get(`/review/protocols/${protocolId}/context`)).json();
    expect(ctx.prior.sheet).toBeNull();
    expect(ctx.prior.protocol).toBeNull();
  });

  it('picks the previous session by appointment date, not row modification time', async () => {
    // Write the OLDER session LAST, so ordering by updated_at would pick it —
    // the whole point is that starts_at decides, which is why it is
    // denormalized onto the document (§3.4).
    await makeProtocol(client, 'amtest-middle', 10, note('ten days ago'), 'approved');
    await makeProtocol(client, 'amtest-older', 30, note('thirty days ago'), 'approved');

    const ctx = await (await get(`/review/protocols/${protocolId}/context`)).json();
    expect(ctx.prior.protocol.note.concerns).toEqual(['ten days ago']);
  });

  it('returns every earlier session for the history view, newest first', async () => {
    // The three earlier appointments seeded by the tests above: 30 days, 10 days,
    // and the 1-day one that carries an unapproved draft (so it must not appear).
    const h = await (await get(`/review/protocols/${protocolId}/history`)).json();
    const concerns = h.sessions.map((s: { note: { concerns: string[] } }) => s.note.concerns[0]);
    expect(concerns).toEqual(['ten days ago', 'thirty days ago']);

    // Newest first, and strictly before this session.
    const dates = h.sessions.map((s: { date: string }) => new Date(s.date).getTime());
    expect(dates[0]).toBeGreaterThan(dates[1]);
  });

  it('lists the session once, under the scope matching its combined status', async () => {
    // The queue is one row per SESSION now, not one per document — a sheet and a
    // protocol are the same note and were previously listed twice.
    const approved = await (await get('/review/queue?status=approved')).json();
    const mine = approved.sessions.filter(
      (x: { appointment_id: string }) => x.appointment_id === appointmentId,
    );
    expect(mine).toHaveLength(1);
    expect(mine[0].protocol_id).toBe(protocolId);
    expect(mine[0].status).toBe('approved');

    const pending = await (await get('/review/queue')).json();
    expect(
      pending.sessions.some((x: { appointment_id: string }) => x.appointment_id === appointmentId),
    ).toBe(false);
  });
});
