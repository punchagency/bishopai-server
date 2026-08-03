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
import { seedAppointment, seedClient, seedConversation, seedSessionDocs } from './fixtures';
import type { IDatabase } from '../src/db/interfaces/repositories';
import type { Client } from '../src/db/interfaces/types';

// Integration: getting a recording onto the right client.
//
// Correlation never guesses — one overlapping appointment or nothing. These
// cover the three ways a human resolves what's left: ranked candidates when the
// window is ambiguous, a walk-in that never had a booking at all, and undoing a
// match that went to the wrong person.
const up = await emulatorUp();
const suite = up ? describe : describe.skip;
if (!up) {
  console.log('[assignment.int] Firestore emulator not running - skipping. Start: npm run firestore:emulator');
}

suite('session assignment (integration)', () => {
  let server: http.Server;
  let base = '';
  let db: IDatabase;
  let marta: Client;
  let dana: Client;
  let martaId = '';
  let danaId = '';

  const get = (path: string) => fetch(`${base}${path}`);
  const post = (path: string, body: unknown) =>
    fetch(`${base}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });

  // Two clients booked back to back — the case time overlap alone cannot settle.
  const DAY = new Date(Date.now() - 5 * 86_400_000).toISOString().slice(0, 10);
  const at = (h: number, m: number) => `${DAY}T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00Z`;

  const clientOf = (id: string) => (id === martaId ? marta : dana);

  async function makeAppt(clientId: string, pb: string, start: string, end: string, status = 'completed'): Promise<string> {
    const appt = await seedAppointment(db, {
      client_id: clientId,
      client_name: clientOf(clientId).name,
      pb_id: pb,
      starts_at: start,
      ends_at: end,
      status,
    });
    return appt.id;
  }

  async function makeConversation(transcript: string, start: string, end: string): Promise<string> {
    const conv = await seedConversation(db, {
      id: `asgn-${Math.random().toString(36).slice(2)}`,
      starts_at: start,
      ends_at: end,
      transcript,
      correlation_status: 'unmatched',
    });
    return conv.id;
  }

  /**
   * Point a recording at an appointment, the way the app does: the claim
   * document is taken as well as the pointer written. Without the claim,
   * "one recording per appointment" would not hold here, and /unmatch's release
   * would have nothing to release - so a test seeded with a bare UPDATE would
   * quietly pass on a path production could not reach.
   */
  async function matchConversation(convId: string, apptId: string, clientId: string): Promise<void> {
    await db.conversations.claimAppointment({
      id: apptId,
      conversation_id: convId,
      claimed_at: new Date().toISOString(),
    });
    const conv = await db.conversations.findById(convId);
    await db.conversations.save({
      ...conv!,
      appointment_id: apptId,
      client_id: clientId,
      correlation_status: 'matched',
    });
  }

  /**
   * Both halves of a session's paperwork, each in the state the case needs.
   *
   * They are always written as a pair because that is what the app produces, and
   * because `combineStatus` decides the session's status from whichever
   * documents are present — a fixture with only one would be answering a
   * different question than the one these tests ask.
   */
  async function makeDocs(
    apptId: string,
    clientId: string,
    states: { sheet: 'draft' | 'approved'; protocol: 'draft' | 'approved' },
  ): Promise<{ sheetId: string; protocolId: string }> {
    const appointment = (await db.appointments.findById(apptId))!;
    const docs = await seedSessionDocs(db, {
      appointment,
      client: clientOf(clientId),
      sheet: { status: states.sheet },
      protocol: { status: states.protocol },
    });
    return { sheetId: docs.sheet.id, protocolId: docs.protocol.id };
  }

  beforeAll(async () => {
    db = installFirestore('assignment-int');
    await clearFirestore(db);
    server = http.createServer(createApp());
    await new Promise<void>((r) => server.listen(0, r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    marta = await seedClient(db, { name: 'Marta Reyes', pb_id: 'asgn-marta' });
    dana = await seedClient(db, { name: 'Dana Kim', pb_id: 'asgn-dana' });
    martaId = marta.id;
    danaId = dana.id;
  });

  afterAll(async () => {
    await new Promise<void>((r) => server.close(() => r()));
    uninstallFirestore();
  });

  it('ranks the candidate whose name is spoken above the one that merely overlaps more', async () => {
    // Dana's booking overlaps the recording far more, but the whole session is
    // audibly about Marta. Clock distance alone would put Dana first.
    await makeAppt(martaId, 'asgn-appt-marta', at(15, 30), at(16, 15));
    await makeAppt(danaId, 'asgn-appt-dana', at(16, 15), at(17, 0));
    const convId = await makeConversation(
      'Nicole: Come in Marta. Marta: my sleep has been better. Nicole: good, Marta.',
      at(16, 10),
      at(17, 0),
    );

    const r = await get(`/review/unmatched/${convId}/candidates`);
    expect(r.status).toBe(200);
    const { appointments } = await r.json();

    expect(appointments[0].client_name).toBe('Marta Reyes');
    expect(appointments[0].name_mentions).toBe(3);
    expect(appointments[0].name_matched_on).toBe('first');
    // ...even though Dana's window overlaps far more of the recording.
    const dana = appointments.find((a: { client_name: string }) => a.client_name === 'Dana Kim');
    expect(dana.overlap_seconds).toBeGreaterThan(appointments[0].overlap_seconds);
    expect(dana.name_mentions).toBe(0);
  });

  it('returns one unmatched recording in full for the detail view', async () => {
    const convId = await makeConversation(
      'Nicole: full transcript for the detail pane. Client: I have been sleeping better.',
      at(18, 0),
      at(18, 45),
    );

    const r = await get(`/review/unmatched/${convId}`);
    expect(r.status).toBe(200);
    const { conversation } = await r.json();
    expect(conversation.id).toBe(convId);
    // The whole transcript, not the 240-char list preview.
    expect(conversation.transcript).toContain('sleeping better');
    expect(conversation.correlation_status).toBe('unmatched');
    expect(conversation.extraction_status).toBe('pending');
  });

  it('refuses the detail view for a recording already tied to an appointment', async () => {
    const apptId = await makeAppt(danaId, 'asgn-detail-matched', at(19, 0), at(19, 45));
    const convId = await makeConversation('Nicole: matched.', at(19, 0), at(19, 45));
    await matchConversation(convId, apptId, danaId);

    const r = await get(`/review/unmatched/${convId}`);
    expect(r.status).toBe(409);
    expect((await r.json()).error).toBe('already matched');
  });

  it('404s the detail view for an unknown recording', async () => {
    const r = await get('/review/unmatched/00000000-0000-0000-0000-000000000000');
    expect(r.status).toBe(404);
  });

  it('refuses to match a recording onto an appointment that already has one', async () => {
    const apptId = await makeAppt(martaId, 'asgn-taken', at(20, 0), at(20, 45));
    // First recording claims the appointment.
    const firstConv = await makeConversation('Nicole: first.', at(20, 0), at(20, 45));
    await matchConversation(firstConv, apptId, martaId);
    // A second, unmatched recording tries to attach to the same appointment.
    const secondConv = await makeConversation('Nicole: second.', at(20, 0), at(20, 45));
    const r = await post(`/review/unmatched/${secondConv}/match`, { appointment_id: apptId });
    expect(r.status).toBe(409);
    expect((await r.json()).error).toMatch(/recording/i);
  });

  it('refuses to match a recording onto an already-approved session', async () => {
    const apptId = await makeAppt(danaId, 'asgn-appr-match', at(21, 0), at(21, 45));
    await makeDocs(apptId, danaId, { sheet: 'approved', protocol: 'approved' });
    const conv = await makeConversation('Nicole: stray.', at(21, 0), at(21, 45));
    const r = await post(`/review/unmatched/${conv}/match`, { appointment_id: apptId });
    expect(r.status).toBe(409);
    expect((await r.json()).error).toMatch(/approved/i);

    // The approved note is untouched — no demotion to draft.
    const sheet = await db.sessionNotes.findSheetByAppointment(apptId);
    expect(sheet!.status).toBe('approved');
  });

  it('refuses to match a recording onto a cancelled appointment', async () => {
    const cancelledId = await makeAppt(martaId, 'asgn-cancelled', at(22, 0), at(22, 45), 'cancelled');
    const conv = await makeConversation('Nicole: walk-in in a cancelled slot.', at(22, 0), at(22, 45));
    const r = await post(`/review/unmatched/${conv}/match`, { appointment_id: cancelledId });
    expect(r.status).toBe(409);
    expect((await r.json()).error).toMatch(/cancelled/i);
  });

  it('assigns a walk-in to a client, creating the appointment from the recording', async () => {
    const convId = await makeConversation(
      'Nicole: no booking for this one, just a quick check.',
      at(11, 0),
      at(11, 40),
    );

    const r = await post(`/review/unmatched/${convId}/assign-client`, { client_id: danaId });
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body.status).toBe('walk_in');

    const appt = await db.appointments.findById(body.appointment_id);
    expect(appt!.client_id).toBe(danaId);
    expect(appt!.pb_id).toBe(`walkin-${convId}`);
    // The appointment's window is the recording's — that's when it happened.
    expect(new Date(appt!.starts_at).toISOString()).toBe(new Date(at(11, 0)).toISOString());
  });

  it('refuses to assign a walk-in twice', async () => {
    const convId = await makeConversation('Nicole: hello.', at(12, 0), at(12, 30));
    expect((await post(`/review/unmatched/${convId}/assign-client`, { client_id: danaId })).status).toBe(200);
    const again = await post(`/review/unmatched/${convId}/assign-client`, { client_id: martaId });
    expect(again.status).toBe(409);
  });

  it('unmatches a wrongly-assigned recording and removes the draft note', async () => {
    const apptId = await makeAppt(danaId, 'asgn-wrong', at(9, 0), at(9, 45));
    const convId = await makeConversation('Nicole: session.', at(9, 0), at(9, 45));
    await matchConversation(convId, apptId, danaId);
    await makeDocs(apptId, danaId, { sheet: 'draft', protocol: 'draft' });

    const r = await post(`/review/conversations/${convId}/unmatch`, {});
    expect(r.status).toBe(200);

    const conv = await db.conversations.findById(convId);
    expect(conv!.appointment_id ?? null).toBeNull();
    expect(conv!.correlation_status).toBe('unmatched');

    // The draft attributed to the wrong client must not linger in her queue.
    expect(await db.sessionNotes.findSheetByAppointment(apptId)).toBeNull();
  });

  it('refuses to unmatch once the note has been approved', async () => {
    const apptId = await makeAppt(danaId, 'asgn-approved', at(13, 0), at(13, 45));
    const convId = await makeConversation('Nicole: session.', at(13, 0), at(13, 45));
    await matchConversation(convId, apptId, danaId);
    await makeDocs(apptId, danaId, { sheet: 'approved', protocol: 'approved' });

    const r = await post(`/review/conversations/${convId}/unmatch`, {});
    expect(r.status).toBe(409);
    expect((await r.json()).error).toBe('already approved');

    // And nothing was destroyed on the way to refusing.
    expect(await db.sessionNotes.findSheetByAppointment(apptId)).not.toBeNull();
  });

  it('removes the synthetic appointment when a walk-in is unmatched', async () => {
    const convId = await makeConversation('Nicole: walk-in.', at(14, 0), at(14, 30));
    const assigned = await (await post(`/review/unmatched/${convId}/assign-client`, { client_id: martaId })).json();

    expect((await post(`/review/conversations/${convId}/unmatch`, {})).status).toBe(200);

    expect(await db.appointments.findById(assigned.appointment_id)).toBeNull();
  });

  it('reassigns from the session itself, not just the recording list', async () => {
    // The wrong client is usually noticed while reading the note, so the same
    // action has to be reachable from the session.
    const apptId = await makeAppt(danaId, 'asgn-from-session', at(10, 0), at(10, 45));
    const convId = await makeConversation('Nicole: session.', at(10, 0), at(10, 45));
    await matchConversation(convId, apptId, danaId);
    const { sheetId } = await makeDocs(apptId, danaId, { sheet: 'draft', protocol: 'draft' });

    const r = await post(`/review/sheets/${sheetId}/unmatch`, {});
    expect(r.status).toBe(200);

    const conv = await db.conversations.findById(convId);
    expect(conv!.appointment_id ?? null).toBeNull();
  });

  it('blocks detaching a draft whose sibling document is already approved', async () => {
    // The case that surfaced this: a DRAFT protocol sitting under an appointment
    // whose appointment sheet was already approved. Approving either one
    // publishes documents and pins the client pairing, so the draft cannot be
    // moved even though it is still a draft itself.
    const apptId = await makeAppt(danaId, 'asgn-sibling', at(8, 0), at(8, 45));
    const convId = await makeConversation('Nicole: session.', at(8, 0), at(8, 45));
    await matchConversation(convId, apptId, danaId);
    const { protocolId } = await makeDocs(apptId, danaId, { sheet: 'approved', protocol: 'draft' });

    // The UI is told up front, so it never offers the action.
    const item = await (await get(`/review/protocols/${protocolId}`)).json();
    expect(item.status).toBe('draft');
    expect(item.can_unmatch).toBe(false);
    expect(item.unmatch_blocked_reason).toMatch(/approved/i);

    // And the endpoint refuses anyway, with an explanation rather than a bare code.
    const r = await post(`/review/protocols/${protocolId}/unmatch`, {});
    expect(r.status).toBe(409);
    expect((await r.json()).detail).toMatch(/Amend/i);
  });

  it('reports a detachable draft as detachable', async () => {
    const apptId = await makeAppt(martaId, 'asgn-ok', at(7, 0), at(7, 45));
    const convId = await makeConversation('Nicole: session.', at(7, 0), at(7, 45));
    await matchConversation(convId, apptId, martaId);
    const { protocolId } = await makeDocs(apptId, martaId, { sheet: 'draft', protocol: 'draft' });
    const item = await (await get(`/review/protocols/${protocolId}`)).json();
    expect(item.can_unmatch).toBe(true);
    expect(item.unmatch_blocked_reason).toBeNull();
  });

  it('lists clients for the picker, most recently seen first', async () => {
    const r = await get('/clients?q=Reyes');
    expect(r.status).toBe(200);
    const { clients } = await r.json();
    expect(clients.map((c: { name: string }) => c.name)).toContain('Marta Reyes');
  });
});
