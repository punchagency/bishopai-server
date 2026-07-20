import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApp } from '../src/app';
import { pool } from '../src/db/pool';

// Integration: correcting a note AFTER Nicole approved it.
//
// The rule under test is that an approved note is never edited in place. Its
// documents are already in Drive and may already be with the client, so a silent
// rewrite would leave the record and the delivered copy disagreeing with nothing
// to show it happened.
const dbUp = await pool
  .query('SELECT 1')
  .then(() => true)
  .catch(() => false);

const suite = dbUp ? describe : describe.skip;

suite('amending an approved note (integration, real Postgres)', () => {
  let server: http.Server;
  let base = '';
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

  beforeAll(async () => {
    server = http.createServer(createApp());
    await new Promise<void>((r) => server.listen(0, r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    const c = await pool.query<{ id: string }>(
      `INSERT INTO clients (name, pb_id) VALUES ('AM Amend', 'amtest-amend') RETURNING id`,
    );
    clientId = c.rows[0].id;
    const a = await pool.query<{ id: string }>(
      `INSERT INTO appointments (client_id, pb_id, starts_at, ends_at, status)
       VALUES ($1, 'amtest-appt', now() - interval '2 days', now() - interval '2 days', 'completed')
       RETURNING id`,
      [clientId],
    );
    appointmentId = a.rows[0].id;
    const p = await pool.query<{ id: string }>(
      `INSERT INTO protocols (client_id, appointment_id, content_json, status)
       VALUES ($1, $2, $3, 'draft') RETURNING id`,
      [clientId, appointmentId, JSON.stringify(note('original concern'))],
    );
    protocolId = p.rows[0].id;
  });

  afterAll(async () => {
    await new Promise<void>((r) => server.close(() => r()));
    await pool.query(`DELETE FROM note_revisions WHERE source_id = $1`, [protocolId]).catch(() => {});
    await pool.query(`DELETE FROM appointment_sheets WHERE client_id = $1`, [clientId]).catch(() => {});
    await pool.query(`DELETE FROM supplements WHERE client_id = $1`, [clientId]).catch(() => {});
    await pool.query(`DELETE FROM protocols WHERE client_id = $1`, [clientId]).catch(() => {});
    await pool.query(`DELETE FROM appointments WHERE client_id = $1`, [clientId]).catch(() => {});
    await pool.query(`DELETE FROM clients WHERE pb_id = 'amtest-amend'`).catch(() => {});
    await pool.end();
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
    const cur = await pool.query<{ content_json: { concerns: string[] } }>(
      `SELECT content_json FROM protocols WHERE id = $1`,
      [protocolId],
    );
    expect(cur.rows[0].content_json.concerns).toEqual(['edited while draft']);
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
    const r = await pool.query(
      `SELECT status FROM approvals
        WHERE payload_json->>'protocol_id' = $1 AND status = 'amended'`,
      [protocolId],
    );
    expect(r.rowCount).toBe(2);
  });

  it('refuses to amend a note that was never approved', async () => {
    // protocols.appointment_id is unique, so this needs an appointment of its own.
    const a2 = await pool.query<{ id: string }>(
      `INSERT INTO appointments (client_id, pb_id, starts_at, ends_at, status)
       VALUES ($1, 'amtest-appt-2', now() - interval '1 day', now() - interval '1 day', 'completed')
       RETURNING id`,
      [clientId],
    );
    const p = await pool.query<{ id: string }>(
      `INSERT INTO protocols (client_id, appointment_id, content_json, status)
       VALUES ($1, $2, $3, 'draft') RETURNING id`,
      [clientId, a2.rows[0].id, JSON.stringify(note('still a draft'))],
    );
    const r = await send('POST', `/review/protocols/${p.rows[0].id}/amend`, {
      content_json: note('nope'),
    });
    expect(r.status).toBe(409);
    expect((await r.json()).error).toBe('not approved');
  });

  it('retracts a supplement the amendment removed, but keeps ones it only stopped changing', async () => {
    // A fresh client so the plan starts empty and the assertions are unambiguous.
    const c = await pool.query<{ id: string }>(
      `INSERT INTO clients (name, pb_id) VALUES ('AM Retract', 'amtest-retract') RETURNING id`,
    );
    const cid = c.rows[0].id;
    const a = await pool.query<{ id: string }>(
      `INSERT INTO appointments (client_id, pb_id, starts_at, ends_at, status)
       VALUES ($1, 'amtest-retract-appt', now() - interval '3 days', now() - interval '3 days', 'completed')
       RETURNING id`,
      [cid],
    );
    // Already on the plan from an earlier session.
    await pool.query(
      `INSERT INTO supplements (client_id, name, dose, qty, source) VALUES ($1, 'Zypan', '1 w/ meals', 2, 'notes')`,
      [cid],
    );

    const withBoth = {
      ...note('x'),
      supplements: [
        { name: 'Min-Tran', dose: '1 before bed', quantity: 1, change: 'start' },
        { name: 'Zypan', dose: '2 w/ meals', quantity: 2, change: 'increase' },
      ],
    };
    const p = await pool.query<{ id: string }>(
      `INSERT INTO protocols (client_id, appointment_id, content_json, status)
       VALUES ($1, $2, $3, 'draft') RETURNING id`,
      [cid, a.rows[0].id, JSON.stringify(withBoth)],
    );
    const pid = p.rows[0].id;
    expect((await send('POST', `/review/protocols/${pid}/approve`, {})).status).toBe(200);

    let names = await pool.query<{ name: string }>(
      `SELECT name FROM supplements WHERE client_id = $1 ORDER BY name`,
      [cid],
    );
    expect(names.rows.map((r) => r.name)).toEqual(['Min-Tran', 'Zypan']);

    // She amends: Min-Tran was never actually prescribed, and the Zypan increase
    // is retracted too — but Zypan itself predates this session and must stay.
    const r = await send('POST', `/review/protocols/${pid}/amend`, {
      content_json: { ...note('x'), supplements: [] },
      reason: 'Min-Tran was not prescribed',
    });
    expect(r.status).toBe(200);

    names = await pool.query<{ name: string }>(
      `SELECT name FROM supplements WHERE client_id = $1 ORDER BY name`,
      [cid],
    );
    expect(names.rows.map((r) => r.name)).toEqual(['Zypan']);

    await pool.query(`DELETE FROM note_revisions WHERE source_id = $1`, [pid]);
    await pool.query(`DELETE FROM supplements WHERE client_id = $1`, [cid]);
    await pool.query(`DELETE FROM protocols WHERE client_id = $1`, [cid]);
    await pool.query(`DELETE FROM appointments WHERE client_id = $1`, [cid]);
    await pool.query(`DELETE FROM clients WHERE id = $1`, [cid]);
  });

  it('never offers this session back as its own history', async () => {
    // A protocol and its appointment sheet share an appointment but live in
    // different tables with different ids. Excluding only by row id let the
    // sheet from THIS very session be served as the "previous session", and
    // ordering by updated_at made whichever row was touched last win.
    const sheet = await pool.query<{ id: string }>(
      `INSERT INTO appointment_sheets (client_id, appointment_id, content_json, status)
       VALUES ($1, $2, $3, 'approved') RETURNING id`,
      [clientId, appointmentId, JSON.stringify(note('same session, other table'))],
    );
    expect(sheet.rowCount).toBe(1);

    const ctx = await (await get(`/review/protocols/${protocolId}/context`)).json();
    expect(ctx.prior.sheet).toBeNull();
    expect(ctx.prior.protocol).toBeNull();
  });

  it('picks the previous session by appointment date, not row modification time', async () => {
    const older = await pool.query<{ id: string }>(
      `INSERT INTO appointments (client_id, pb_id, starts_at, ends_at, status)
       VALUES ($1, 'amtest-older', now() - interval '30 days', now() - interval '30 days', 'completed')
       RETURNING id`,
      [clientId],
    );
    const middle = await pool.query<{ id: string }>(
      `INSERT INTO appointments (client_id, pb_id, starts_at, ends_at, status)
       VALUES ($1, 'amtest-middle', now() - interval '10 days', now() - interval '10 days', 'completed')
       RETURNING id`,
      [clientId],
    );
    // Insert the OLDER session last, so updated_at ordering would pick it.
    await pool.query(
      `INSERT INTO protocols (client_id, appointment_id, content_json, status)
       VALUES ($1, $2, $3, 'approved')`,
      [clientId, middle.rows[0].id, JSON.stringify(note('ten days ago'))],
    );
    await pool.query(
      `INSERT INTO protocols (client_id, appointment_id, content_json, status)
       VALUES ($1, $2, $3, 'approved')`,
      [clientId, older.rows[0].id, JSON.stringify(note('thirty days ago'))],
    );

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

  it('lists approved notes only under ?status=approved', async () => {
    const approved = await (await get('/review/queue?status=approved')).json();
    expect(approved.protocols.map((p: { id: string }) => p.id)).toContain(protocolId);

    const pending = await (await get('/review/queue')).json();
    expect(pending.protocols.map((p: { id: string }) => p.id)).not.toContain(protocolId);
  });
});
