import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApp } from '../src/app';
import { pool } from '../src/db/pool';

// Integration: getting a recording onto the right client.
//
// Correlation never guesses — one overlapping appointment or nothing. These
// cover the three ways a human resolves what's left: ranked candidates when the
// window is ambiguous, a walk-in that never had a booking at all, and undoing a
// match that went to the wrong person.
const dbUp = await pool
  .query('SELECT 1')
  .then(() => true)
  .catch(() => false);

const suite = dbUp ? describe : describe.skip;

suite('session assignment (integration, real Postgres)', () => {
  let server: http.Server;
  let base = '';
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

  async function makeClient(name: string, pb: string): Promise<string> {
    const r = await pool.query<{ id: string }>(
      `INSERT INTO clients (name, pb_id) VALUES ($1, $2) RETURNING id`,
      [name, pb],
    );
    return r.rows[0].id;
  }

  async function makeAppt(clientId: string, pb: string, s: string, e: string): Promise<string> {
    const r = await pool.query<{ id: string }>(
      `INSERT INTO appointments (client_id, pb_id, starts_at, ends_at, status)
       VALUES ($1, $2, $3, $4, 'completed') RETURNING id`,
      [clientId, pb, s, e],
    );
    return r.rows[0].id;
  }

  async function makeConversation(transcript: string, s: string, e: string): Promise<string> {
    const r = await pool.query<{ id: string }>(
      `INSERT INTO conversations (bee_id, starts_at, ends_at, transcript, correlation_status)
       VALUES ($1, $2, $3, $4, 'unmatched') RETURNING id`,
      [`asgn-${Math.random().toString(36).slice(2)}`, s, e, transcript],
    );
    return r.rows[0].id;
  }

  beforeAll(async () => {
    server = http.createServer(createApp());
    await new Promise<void>((r) => server.listen(0, r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    martaId = await makeClient('Marta Reyes', 'asgn-marta');
    danaId = await makeClient('Dana Kim', 'asgn-dana');
  });

  afterAll(async () => {
    await pool.query(
      `DELETE FROM conversations WHERE client_id IN
         (SELECT id FROM clients WHERE pb_id LIKE 'asgn-%') OR bee_id LIKE 'asgn-%'`,
    ).catch(() => {});
    for (const t of ['appointment_sheets', 'protocols', 'appointments']) {
      await pool
        .query(`DELETE FROM ${t} WHERE client_id IN (SELECT id FROM clients WHERE pb_id LIKE 'asgn-%')`)
        .catch(() => {});
    }
    await pool.query(`DELETE FROM clients WHERE pb_id LIKE 'asgn-%'`).catch(() => {});
    await pool.end();
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

    const appt = await pool.query<{ client_id: string; starts_at: Date; pb_id: string }>(
      `SELECT client_id, starts_at, pb_id FROM appointments WHERE id = $1`,
      [body.appointment_id],
    );
    expect(appt.rows[0].client_id).toBe(danaId);
    expect(appt.rows[0].pb_id).toBe(`walkin-${convId}`);
    // The appointment's window is the recording's — that's when it happened.
    expect(new Date(appt.rows[0].starts_at).toISOString()).toBe(new Date(at(11, 0)).toISOString());
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
    await pool.query(
      `UPDATE conversations SET appointment_id = $2, client_id = $3, correlation_status = 'matched'
        WHERE id = $1`,
      [convId, apptId, danaId],
    );
    await pool.query(
      `INSERT INTO appointment_sheets (appointment_id, client_id, content_json, status)
       VALUES ($1, $2, '{}'::jsonb, 'draft')`,
      [apptId, danaId],
    );

    const r = await post(`/review/conversations/${convId}/unmatch`, {});
    expect(r.status).toBe(200);

    const conv = await pool.query<{ appointment_id: string | null; correlation_status: string }>(
      `SELECT appointment_id, correlation_status FROM conversations WHERE id = $1`,
      [convId],
    );
    expect(conv.rows[0].appointment_id).toBeNull();
    expect(conv.rows[0].correlation_status).toBe('unmatched');

    // The draft attributed to the wrong client must not linger in her queue.
    const sheets = await pool.query(`SELECT 1 FROM appointment_sheets WHERE appointment_id = $1`, [apptId]);
    expect(sheets.rowCount).toBe(0);
  });

  it('refuses to unmatch once the note has been approved', async () => {
    const apptId = await makeAppt(danaId, 'asgn-approved', at(13, 0), at(13, 45));
    const convId = await makeConversation('Nicole: session.', at(13, 0), at(13, 45));
    await pool.query(
      `UPDATE conversations SET appointment_id = $2, client_id = $3, correlation_status = 'matched'
        WHERE id = $1`,
      [convId, apptId, danaId],
    );
    await pool.query(
      `INSERT INTO appointment_sheets (appointment_id, client_id, content_json, status)
       VALUES ($1, $2, '{}'::jsonb, 'approved')`,
      [apptId, danaId],
    );

    const r = await post(`/review/conversations/${convId}/unmatch`, {});
    expect(r.status).toBe(409);
    expect((await r.json()).error).toBe('already approved');

    // And nothing was destroyed on the way to refusing.
    const sheets = await pool.query(`SELECT 1 FROM appointment_sheets WHERE appointment_id = $1`, [apptId]);
    expect(sheets.rowCount).toBe(1);
  });

  it('removes the synthetic appointment when a walk-in is unmatched', async () => {
    const convId = await makeConversation('Nicole: walk-in.', at(14, 0), at(14, 30));
    const assigned = await (await post(`/review/unmatched/${convId}/assign-client`, { client_id: martaId })).json();

    expect((await post(`/review/conversations/${convId}/unmatch`, {})).status).toBe(200);

    const appt = await pool.query(`SELECT 1 FROM appointments WHERE id = $1`, [assigned.appointment_id]);
    expect(appt.rowCount).toBe(0);
  });

  it('reassigns from the session itself, not just the recording list', async () => {
    // The wrong client is usually noticed while reading the note, so the same
    // action has to be reachable from the session.
    const apptId = await makeAppt(danaId, 'asgn-from-session', at(10, 0), at(10, 45));
    const convId = await makeConversation('Nicole: session.', at(10, 0), at(10, 45));
    await pool.query(
      `UPDATE conversations SET appointment_id = $2, client_id = $3, correlation_status = 'matched'
        WHERE id = $1`,
      [convId, apptId, danaId],
    );
    const sheet = await pool.query<{ id: string }>(
      `INSERT INTO appointment_sheets (appointment_id, client_id, content_json, status)
       VALUES ($1, $2, '{}'::jsonb, 'draft') RETURNING id`,
      [apptId, danaId],
    );

    const r = await post(`/review/sheets/${sheet.rows[0].id}/unmatch`, {});
    expect(r.status).toBe(200);

    const conv = await pool.query<{ appointment_id: string | null }>(
      `SELECT appointment_id FROM conversations WHERE id = $1`,
      [convId],
    );
    expect(conv.rows[0].appointment_id).toBeNull();
  });

  it('blocks detaching a draft whose sibling document is already approved', async () => {
    // The case that surfaced this: a DRAFT protocol sitting under an appointment
    // whose appointment sheet was already approved. Approving either one
    // publishes documents and pins the client pairing, so the draft cannot be
    // moved even though it is still a draft itself.
    const apptId = await makeAppt(danaId, 'asgn-sibling', at(8, 0), at(8, 45));
    const convId = await makeConversation('Nicole: session.', at(8, 0), at(8, 45));
    await pool.query(
      `UPDATE conversations SET appointment_id = $2, client_id = $3, correlation_status = 'matched'
        WHERE id = $1`,
      [convId, apptId, danaId],
    );
    await pool.query(
      `INSERT INTO appointment_sheets (appointment_id, client_id, content_json, status)
       VALUES ($1, $2, '{}'::jsonb, 'approved')`,
      [apptId, danaId],
    );
    const proto = await pool.query<{ id: string }>(
      `INSERT INTO protocols (appointment_id, client_id, content_json, status)
       VALUES ($1, $2, '{}'::jsonb, 'draft') RETURNING id`,
      [apptId, danaId],
    );

    // The UI is told up front, so it never offers the action.
    const item = await (await get(`/review/protocols/${proto.rows[0].id}`)).json();
    expect(item.status).toBe('draft');
    expect(item.can_unmatch).toBe(false);
    expect(item.unmatch_blocked_reason).toMatch(/approved/i);

    // And the endpoint refuses anyway, with an explanation rather than a bare code.
    const r = await post(`/review/protocols/${proto.rows[0].id}/unmatch`, {});
    expect(r.status).toBe(409);
    expect((await r.json()).detail).toMatch(/Amend/i);
  });

  it('reports a detachable draft as detachable', async () => {
    const apptId = await makeAppt(martaId, 'asgn-ok', at(7, 0), at(7, 45));
    const convId = await makeConversation('Nicole: session.', at(7, 0), at(7, 45));
    await pool.query(
      `UPDATE conversations SET appointment_id = $2, client_id = $3, correlation_status = 'matched'
        WHERE id = $1`,
      [convId, apptId, martaId],
    );
    const proto = await pool.query<{ id: string }>(
      `INSERT INTO protocols (appointment_id, client_id, content_json, status)
       VALUES ($1, $2, '{}'::jsonb, 'draft') RETURNING id`,
      [apptId, martaId],
    );
    const item = await (await get(`/review/protocols/${proto.rows[0].id}`)).json();
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
