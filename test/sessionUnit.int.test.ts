import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApp } from '../src/app';
import { pool } from '../src/db/pool';
import { combineStatus } from '../src/session/sessionService';

// A session is ONE note. The sheet and the protocol hold identical content and
// differ only in how they render, so every write has to move both — otherwise a
// correction reaches the prep brief (which reads the sheet) but never the
// client's documents (which build from the protocol).
const dbUp = await pool.query('SELECT 1').then(() => true).catch(() => false);
const suite = dbUp ? describe : describe.skip;

describe('combineStatus', () => {
  it('is approved only when every document present is approved', () => {
    expect(combineStatus('approved', 'approved')).toBe('approved');
    expect(combineStatus('approved', 'draft')).toBe('draft');
    expect(combineStatus('draft', 'approved')).toBe('draft');
  });

  it('decides on the sheet alone when there is no protocol', () => {
    // A session with no client attached never gets a protocol; requiring both
    // would leave it permanently unapprovable.
    expect(combineStatus('approved', null)).toBe('approved');
    expect(combineStatus('draft', null)).toBe('draft');
  });

  it('surfaces in_review over draft', () => {
    expect(combineStatus('in_review', 'draft')).toBe('in_review');
  });
});

suite('session as one unit (integration, real Postgres)', () => {
  let server: http.Server;
  let base = '';
  let clientId = '';
  let apptId = '';
  let sheetId = '';
  let protocolId = '';

  const send = (method: 'POST' | 'PATCH', path: string, body: unknown) =>
    fetch(`${base}${path}`, {
      method,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });

  const note = (concern: string) => ({
    concerns: [concern], goals: [], assessments: [],
    protocol_changes: [], supplements: [], follow_ups: [],
  });

  const contents = async () => {
    const s = await pool.query<{ content_json: { concerns: string[] }; status: string }>(
      `SELECT content_json, status FROM appointment_sheets WHERE id = $1`, [sheetId]);
    const p = await pool.query<{ content_json: { concerns: string[] }; status: string }>(
      `SELECT content_json, status FROM protocols WHERE id = $1`, [protocolId]);
    return { sheet: s.rows[0], protocol: p.rows[0] };
  };

  beforeAll(async () => {
    server = http.createServer(createApp());
    await new Promise<void>((r) => server.listen(0, r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const c = await pool.query<{ id: string }>(
      `INSERT INTO clients (name, pb_id) VALUES ('SU Session', 'sutest-session') RETURNING id`);
    clientId = c.rows[0].id;
    const a = await pool.query<{ id: string }>(
      `INSERT INTO appointments (client_id, pb_id, starts_at, ends_at, status)
       VALUES ($1, 'sutest-appt', now() - interval '2 days', now() - interval '2 days', 'completed')
       RETURNING id`, [clientId]);
    apptId = a.rows[0].id;
    const s = await pool.query<{ id: string }>(
      `INSERT INTO appointment_sheets (appointment_id, client_id, content_json, status)
       VALUES ($1, $2, $3, 'draft') RETURNING id`,
      [apptId, clientId, JSON.stringify(note('original'))]);
    sheetId = s.rows[0].id;
    const p = await pool.query<{ id: string }>(
      `INSERT INTO protocols (appointment_id, client_id, content_json, status)
       VALUES ($1, $2, $3, 'draft') RETURNING id`,
      [apptId, clientId, JSON.stringify(note('original'))]);
    protocolId = p.rows[0].id;
  });

  afterAll(async () => {
    for (const t of ['note_revisions']) {
      await pool.query(`DELETE FROM ${t} WHERE source_id IN ($1, $2)`, [sheetId, protocolId]).catch(() => {});
    }
    for (const t of ['appointment_sheets', 'protocols', 'supplements', 'tasks', 'appointments']) {
      await pool.query(`DELETE FROM ${t} WHERE client_id = $1`, [clientId]).catch(() => {});
    }
    await pool.query(`DELETE FROM clients WHERE pb_id = 'sutest-session'`).catch(() => {});
    await pool.end();
  });

  it('editing either document writes both, so they cannot drift apart', async () => {
    // This is the bug the session model closes: previously an edit to the sheet
    // left the protocol stale, and the client's documents build from the protocol.
    const r = await send('PATCH', `/review/sheets/${sheetId}`, { content_json: note('corrected') });
    expect(r.status).toBe(200);

    const { sheet, protocol } = await contents();
    expect(sheet.content_json.concerns).toEqual(['corrected']);
    expect(protocol.content_json.concerns).toEqual(['corrected']);
  });

  it('approving either document approves the whole session', async () => {
    const r = await send('POST', `/review/protocols/${protocolId}/approve`, {});
    expect(r.status).toBe(200);

    const { sheet, protocol } = await contents();
    expect(sheet.status).toBe('approved');
    expect(protocol.status).toBe('approved');
  });

  it('records one approval for the session, not one per document', async () => {
    const r = await pool.query(
      `SELECT type FROM approvals
        WHERE payload_json->>'appointment_id' = $1 AND status = 'approved'`, [apptId]);
    expect(r.rowCount).toBe(1);
    expect(r.rows[0].type).toBe('session');
  });

  it('the queue lists the session once, not once per document', async () => {
    const q = await (await fetch(`${base}/review/queue?status=approved`)).json();
    const mine = q.sessions.filter((x: { appointment_id: string }) => x.appointment_id === apptId);
    expect(mine).toHaveLength(1);
    expect(mine[0].sheet_id).toBe(sheetId);
    expect(mine[0].protocol_id).toBe(protocolId);
  });

  it('amending writes both documents and files history against each', async () => {
    const r = await send('POST', `/review/sheets/${sheetId}/amend`, {
      content_json: note('amended'),
      reason: 'misheard',
    });
    expect(r.status).toBe(200);

    const { sheet, protocol } = await contents();
    expect(sheet.content_json.concerns).toEqual(['amended']);
    expect(protocol.content_json.concerns).toEqual(['amended']);

    // Either document's history is complete on its own.
    for (const id of [sheetId, protocolId]) {
      const h = await (await fetch(`${base}/review/${id === sheetId ? 'sheets' : 'protocols'}/${id}/revisions`)).json();
      expect(h.revisions[0].content_json.concerns).toEqual(['corrected']);
    }
  });
});
