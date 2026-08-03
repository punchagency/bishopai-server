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
import { seedClient, seedAppointment, seedSessionDocs } from './fixtures';
import type { IDatabase } from '../src/db/interfaces/repositories';
import { combineStatus } from '../src/session/sessionService';

// A session is ONE note. The sheet and the protocol hold identical content and
// differ only in how they render, so every write has to move both — otherwise a
// correction reaches the prep brief (which reads the sheet) but never the
// client's documents (which build from the protocol).
const up = await emulatorUp();
const suite = up ? describe : describe.skip;
if (!up) {
  console.log('[sessionUnit.int] Firestore emulator not running - skipping. Start: npm run firestore:emulator');
}

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

// These cases run in order against ONE session (edit -> approve -> amend), so
// the fixture is built once in beforeAll rather than wiped between tests.
suite('session as one unit (integration)', () => {
  let server: http.Server;
  let base = '';
  let db: IDatabase;
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
    const docs = await db.sessionNotes.findSessionDocs(apptId);
    return {
      sheet: docs.sheet as { content_json: { concerns: string[] }; status: string },
      protocol: docs.protocol as { content_json: { concerns: string[] }; status: string },
    };
  };

  const sessionApprovals = async () =>
    (await db.sessionNotes.listApprovals(apptId)).filter((a) => a.status === 'approved');

  beforeAll(async () => {
    db = installFirestore('session-unit-int');
    await clearFirestore(db);

    server = http.createServer(createApp());
    await new Promise<void>((r) => server.listen(0, r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    const client = await seedClient(db, { name: 'SU Session', pb_id: 'sutest-session' });
    clientId = client.id;
    const appointment = await seedAppointment(db, {
      client_id: client.id,
      client_name: client.name,
      pb_id: 'sutest-appt',
      starts_at: new Date(Date.now() - 2 * 86_400_000).toISOString(),
      status: 'completed',
    });
    apptId = appointment.id;

    const docs = await seedSessionDocs(db, {
      client,
      appointment,
      sheet: { content_json: note('original') },
      protocol: { content_json: note('original') },
    });
    sheetId = docs.sheet.id;
    protocolId = docs.protocol.id;
  });

  afterAll(async () => {
    await new Promise<void>((r) => server.close(() => r()));
    uninstallFirestore();
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

  it('refuses to approve an already-approved session (no duplicate audit row)', async () => {
    const r = await send('POST', `/review/sheets/${sheetId}/approve`, {});
    expect(r.status).toBe(409);
    expect((await r.json()).error).toMatch(/approved/i);

    expect(await sessionApprovals()).toHaveLength(1);
  });

  it('records one approval for the session, not one per document', async () => {
    const approvals = await sessionApprovals();
    expect(approvals).toHaveLength(1);
    expect(approvals[0].type).toBe('session');
  });

  it('the queue lists the session once, not once per document', async () => {
    const q = await (await fetch(`${base}/review/queue?status=approved`)).json();
    const mine = q.sessions.filter((x: { appointment_id: string }) => x.appointment_id === apptId);
    expect(mine).toHaveLength(1);
    expect(mine[0].sheet_id).toBe(sheetId);
    expect(mine[0].protocol_id).toBe(protocolId);
  });

  it('filters the approved queue by client name (server-side)', async () => {
    // A name hit surfaces the session…
    const hit = await (await fetch(`${base}/review/queue?status=approved&q=SU%20Session`)).json();
    expect(hit.sessions.some((x: { appointment_id: string }) => x.appointment_id === apptId)).toBe(true);

    // …a partial, case-insensitive fragment still matches…
    const partial = await (await fetch(`${base}/review/queue?status=approved&q=su%20sess`)).json();
    expect(partial.sessions.some((x: { appointment_id: string }) => x.appointment_id === apptId)).toBe(true);

    // …and a non-matching query excludes it rather than returning everything.
    const miss = await (await fetch(`${base}/review/queue?status=approved&q=zzz-no-such-client`)).json();
    expect(miss.sessions.some((x: { appointment_id: string }) => x.appointment_id === apptId)).toBe(false);
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
