import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApp } from '../src/app';
import { pool } from '../src/db/pool';

// Integration: importing a transcript by hand (POST /review/import).
//
// The manual ingress reuses the one ingest path, so it lands an ordinary
// conversation, deduplicates on the transcript hash, and correlates by time
// like any recording. These cover: it lands unmatched when its window matches
// no appointment, re-import is a no-op, and an empty payload is refused.
const dbUp = await pool
  .query('SELECT 1')
  .then(() => true)
  .catch(() => false);

const suite = dbUp ? describe : describe.skip;

suite('manual transcript import (integration, real Postgres)', () => {
  let server: http.Server;
  let base = '';

  const post = (path: string, body: unknown) =>
    fetch(`${base}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });

  // A window well away from any seeded/booked appointment, so correlation finds
  // nothing and the import lands unmatched — the case Nicole then resolves.
  const OCCURRED = new Date('2019-03-14T15:00:00Z').toISOString();
  const TRANSCRIPT =
    'Speaker 2 0:07\nHow have you been sleeping?\n\nSpeaker 3 0:12\nBetter since the magnesium.';

  beforeAll(async () => {
    // Hermetic: the count-based idempotency assertion below must not see manual
    // rows left by other runs (or by hand) in a shared dev database.
    await pool.query(`DELETE FROM conversations WHERE source = 'manual'`).catch(() => {});
    server = http.createServer(createApp());
    await new Promise<void>((r) => server.listen(0, r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await pool.query(`DELETE FROM conversations WHERE source = 'manual'`).catch(() => {});
    await pool.end();
  });

  it('lands a pasted transcript as an unmatched, source=manual conversation', async () => {
    const r = await post('/review/import', { transcript: TRANSCRIPT, occurred_at: OCCURRED });
    expect(r.status).toBe(201);
    const body = await r.json();
    expect(body.correlation.status).toBe('unmatched');
    expect(body.conversation_id).toBeTruthy();

    const row = await pool.query<{ source: string; correlation_status: string; transcript: string }>(
      `SELECT source, correlation_status, transcript FROM conversations WHERE id = $1`,
      [body.conversation_id],
    );
    expect(row.rows[0].source).toBe('manual');
    expect(row.rows[0].correlation_status).toBe('unmatched');
    // Stored transcript is normalized to `Speaker: text`, timestamps dropped.
    expect(row.rows[0].transcript).toContain('Speaker 2: How have you been sleeping?');
    expect(row.rows[0].transcript).not.toContain('0:07');

    // It shows up in the queue Nicole resolves from.
    const unmatched = await fetch(`${base}/review/unmatched`).then((x) => x.json());
    expect(
      unmatched.conversations.some((c: { id: string }) => c.id === body.conversation_id),
    ).toBe(true);
  });

  it('is idempotent — re-importing the same text returns the same conversation', async () => {
    const first = await post('/review/import', { transcript: TRANSCRIPT, occurred_at: OCCURRED }).then((x) => x.json());
    const second = await post('/review/import', { transcript: TRANSCRIPT }).then((x) => x.json());
    expect(second.conversation_id).toBe(first.conversation_id);

    const count = await pool.query(
      `SELECT count(*)::int AS n FROM conversations WHERE source = 'manual'`,
    );
    expect(count.rows[0].n).toBe(1);
  });

  it('refuses an empty transcript', async () => {
    const r = await post('/review/import', { transcript: '   ' });
    expect(r.status).toBe(400);
  });

  it('accepts a long transcript over the old 100KB body-parser default', async () => {
    // ~150KB — larger than express.json()'s 100KB default (which would 413
    // before the handler), still under MAX_TRANSCRIPT_CHARS. Regression guard
    // for the body-limit/cap mismatch.
    const big = 'Speaker 1 0:01\n' + 'the client reports better sleep this week. '.repeat(3500);
    expect(big.length).toBeGreaterThan(120_000);
    const r = await post('/review/import', { transcript: big, occurred_at: OCCURRED });
    expect(r.status).toBe(201);
  });

  it('refuses a transcript over the character cap', async () => {
    const tooBig = 'x'.repeat(200_001);
    const r = await post('/review/import', { transcript: tooBig });
    expect(r.status).toBe(400);
  });
});
