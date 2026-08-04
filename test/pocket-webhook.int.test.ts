import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApp } from '../src/app';
import { pool } from '../src/db/pool';
import { signPocketPayload } from '../src/integrations/pocket/signature';

// End-to-end over the real Express app + real Postgres: a signed Pocket
// delivery lands a conversation, correlates it, and is safe to redeliver.
// DB-gated like the other integration suites.
let dbUp = true;
try {
  await pool.query('SELECT 1');
} catch {
  dbUp = false;
}

// The guard captures the secret when the router is MOUNTED (module import),
// matching the PB and shared-secret guards. So it has to be in the environment
// before ../src/app is imported — which hoisting puts ahead of any statement
// here, hence vi.hoisted.
const SECRET = vi.hoisted(() => {
  const s = 'whsec_pocket_int';
  process.env.POCKET_WEBHOOK_SECRET = s;
  return s;
});
const PB_PREFIX = 'pkt-';

describe.skipIf(!dbUp)('Pocket webhook → conversation (integration)', () => {
  let server: http.Server;
  let base = '';

  const cleanup = async () => {
    await pool.query(`DELETE FROM conversations WHERE source_id LIKE 'rec_pkt%'`).catch(() => {});
    await pool
      .query(`DELETE FROM appointments WHERE pb_id LIKE '${PB_PREFIX}%'`)
      .catch(() => {});
    await pool.query(`DELETE FROM clients WHERE pb_id LIKE '${PB_PREFIX}%'`).catch(() => {});
  };

  beforeAll(async () => {
    server = http.createServer(createApp());
    await new Promise<void>((r) => server.listen(0, r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    delete process.env.POCKET_WEBHOOK_SECRET;
    await cleanup();
    await new Promise<void>((r) => server.close(() => r()));
  });

  beforeEach(cleanup);

  /** POST a payload with a valid signature unless `signature` is overridden. */
  async function deliver(payload: unknown, over: { signature?: string; timestamp?: string } = {}) {
    const raw = JSON.stringify(payload);
    const timestamp = over.timestamp ?? String(Date.now());
    return fetch(`${base}/webhooks/pocket`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-heypocket-signature': over.signature ?? signPocketPayload(SECRET, timestamp, raw),
        'x-heypocket-timestamp': timestamp,
      },
      body: raw,
    });
  }

  const payloadFor = (id: string, createdAt: string, text = 'How have you been sleeping?') => ({
    event: 'summary.completed',
    timestamp: new Date().toISOString(),
    user: { id: 'user_abc', email: 'nicole@example.test' },
    recording: { id, title: 'Session', duration: 1800, createdAt },
    transcript: [{ speaker: 'Nicole', text, start: 0, end: 3.5 }],
  });

  async function makeAppointment(pbId: string, startsAt: Date): Promise<string> {
    const c = await pool.query<{ id: string }>(
      `INSERT INTO clients (name, pb_id) VALUES ('Pocket Test', $1)
       ON CONFLICT (pb_id) DO UPDATE SET name = EXCLUDED.name RETURNING id`,
      [`${PB_PREFIX}client`],
    );
    const a = await pool.query<{ id: string }>(
      `INSERT INTO appointments (client_id, pb_id, starts_at, ends_at, status)
            VALUES ($1, $2, $3, $4, 'confirmed')
       ON CONFLICT (pb_id) DO UPDATE SET starts_at = EXCLUDED.starts_at RETURNING id`,
      [c.rows[0].id, pbId, startsAt.toISOString(), new Date(startsAt.getTime() + 3600e3).toISOString()],
    );
    return a.rows[0].id;
  }

  it('rejects an unsigned delivery', async () => {
    const res = await deliver(payloadFor('rec_pkt1', new Date().toISOString()), { signature: 'nope' });
    expect(res.status).toBe(401);
    const { rowCount } = await pool.query(`SELECT 1 FROM conversations WHERE source_id = 'rec_pkt1'`);
    expect(rowCount).toBe(0);
  });

  it('rejects a replayed delivery whose timestamp is outside the tolerance', async () => {
    const stale = String(Date.now() - 10 * 60_000);
    const res = await deliver(payloadFor('rec_pkt2', new Date().toISOString()), { timestamp: stale });
    expect(res.status).toBe(401);
  });

  it('lands an unmatched conversation when no appointment overlaps', async () => {
    const res = await deliver(payloadFor('rec_pkt3', '2019-01-02T10:00:00.000Z'));
    expect(res.status).toBe(200);
    expect((await res.json()).correlation.status).toBe('unmatched');

    const { rows } = await pool.query(
      `SELECT source, source_id, transcript, correlation_status, starts_at, ends_at
         FROM conversations WHERE source_id = 'rec_pkt3'`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].source).toBe('pocket');
    expect(rows[0].transcript).toBe('Nicole: How have you been sleeping?');
    // createdAt + duration(1800s) — the window the correlator joins on.
    expect(new Date(rows[0].starts_at).toISOString()).toBe('2019-01-02T10:00:00.000Z');
    expect(new Date(rows[0].ends_at).toISOString()).toBe('2019-01-02T10:30:00.000Z');
  });

  it('matches a recording to the one appointment it overlaps', async () => {
    const start = new Date('2019-03-04T14:00:00.000Z');
    const apptId = await makeAppointment(`${PB_PREFIX}appt1`, start);

    const res = await deliver(payloadFor('rec_pkt4', '2019-03-04T14:05:00.000Z'));
    expect(res.status).toBe(200);
    expect((await res.json()).correlation).toMatchObject({ status: 'matched', appointmentId: apptId });
  });

  it('is idempotent on redelivery — Pocket guarantees at-least-once', async () => {
    const p = payloadFor('rec_pkt5', '2019-01-02T10:00:00.000Z');
    await deliver(p);
    await deliver(p);
    const { rows } = await pool.query(`SELECT count(*)::int AS n FROM conversations WHERE source_id = 'rec_pkt5'`);
    expect(rows[0].n).toBe(1);
  });

  it('does not blank a stored transcript when a later event arrives without one', async () => {
    await deliver(payloadFor('rec_pkt6', '2019-01-02T10:00:00.000Z'));
    const { transcript, ...noTranscript } = payloadFor('rec_pkt6', '2019-01-02T10:00:00.000Z');
    await deliver({ ...noTranscript, event: 'summary.regenerated' });

    const { rows } = await pool.query(`SELECT transcript FROM conversations WHERE source_id = 'rec_pkt6'`);
    expect(rows[0].transcript).toBe('Nicole: How have you been sleeping?');
  });

  it('acknowledges but ignores an event that carries no transcript', async () => {
    // recording.created fires BEFORE transcription; acting on it would burn the
    // recording's one shot at correlation against an empty body.
    const res = await deliver({ ...payloadFor('rec_pkt7', '2019-01-02T10:00:00.000Z'), event: 'recording.created' });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ignored: 'recording.created' });
    const { rowCount } = await pool.query(`SELECT 1 FROM conversations WHERE source_id = 'rec_pkt7'`);
    expect(rowCount).toBe(0);
  });

  it('acknowledges a payload it cannot place rather than making Pocket retry it', async () => {
    const res = await deliver({ event: 'summary.completed', recording: { id: 'rec_pkt8' } }); // no time window
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ignored: 'unusable_payload' });
  });
});
