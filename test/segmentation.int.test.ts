import { describe, it, expect, afterAll, vi } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

// The segmenter's one model call is mocked to a fixed boundary so these exercise
// the queue, the store and the cached-serve path — not the LLM.
vi.mock('../src/llm/providers', () => ({
  generateStructured: vi.fn(async () => ({ parsed: { boundary_turns: [] } })),
}));

import { pool } from '../src/db/pool';
import { createApp } from '../src/app';
import { runSegmentation } from '../src/session/segmentation';

const dbUp = await pool
  .query('SELECT 1')
  .then(() => true)
  .catch(() => false);
const suite = dbUp ? describe : describe.skip;

// A back-to-back transcript: two consultations, a farewell/greeting handover in
// the middle. The deterministic scorer finds the seam without the LLM.
function turn(i: number, role: string, text: string) {
  return `#${i} ${role}\n${text}`;
}
const TRANSCRIPT = [
  ...Array.from({ length: 16 }, (_, i) =>
    i % 2 === 0
      ? turn(i + 1, 'PRACTITIONER', 'How are your energy levels since the last visit?')
      : turn(i + 1, 'CLIENT (SPEAKER 01)', 'A bit better, my sleep is still short though.'),
  ),
  turn(17, 'PRACTITIONER', "All right, I'll see you in four weeks. Take care."),
  turn(18, 'SPEAKER 03', 'Hi, come on in and have a seat. What brings you in today?'),
  ...Array.from({ length: 16 }, (_, i) =>
    i % 2 === 0
      ? turn(i + 19, 'PRACTITIONER', 'Tell me about your digestion this week.')
      : turn(i + 19, 'CLIENT (SPEAKER 02)', 'It flares up after meals, mostly in the evening.'),
  ),
].join('\n\n');

suite('segmentation queue (integration, real Postgres)', () => {
  let server: http.Server;
  let base = '';
  const ids: string[] = [];

  const get = (path: string) => fetch(`${base}${path}`);

  async function heldConversation(tag: string, transcript = TRANSCRIPT): Promise<string> {
    const r = await pool.query<{ id: string }>(
      `INSERT INTO conversations
              (source_id, source, starts_at, ends_at, transcript,
               correlation_status, correlation_hold_reason, segmentation_status)
            VALUES ($1, 'pocket', now() - interval '2 hours', now() - interval '1 hour', $2,
                    'needs_review', 'test hold', 'pending')
         RETURNING id`,
      [`seg-${tag}`, transcript],
    );
    ids.push(r.rows[0].id);
    return r.rows[0].id;
  }

  afterAll(async () => {
    if (ids.length) await pool.query(`DELETE FROM conversations WHERE id = ANY($1)`, [ids]);
    await pool.query(`DELETE FROM conversations WHERE source_id LIKE 'seg-%'`).catch(() => {});
    server?.close();
    await pool.end();
  });

  it('runSegmentation stores a proposal and marks the row done', async () => {
    const id = await heldConversation('store');
    const ran = await runSegmentation(id);
    expect(ran).toBe(true);

    const row = await pool.query<{
      segmentation_status: string;
      proposed_segments: { segments: unknown[]; turns: unknown[]; computed_at: string } | null;
    }>(
      `SELECT segmentation_status, proposed_segments FROM conversations WHERE id = $1`,
      [id],
    );
    expect(row.rows[0].segmentation_status).toBe('done');
    expect(Array.isArray(row.rows[0].proposed_segments?.segments)).toBe(true);
    expect(row.rows[0].proposed_segments?.segments.length).toBeGreaterThanOrEqual(1);
    expect(row.rows[0].proposed_segments?.turns.length).toBeGreaterThan(0);
    expect(typeof row.rows[0].proposed_segments?.computed_at).toBe('string');
  });

  it('runSegmentation is a no-op on a recording that is not held', async () => {
    const r = await pool.query<{ id: string }>(
      `INSERT INTO conversations (source_id, source, starts_at, ends_at, transcript, correlation_status)
            VALUES ('seg-nothold', 'pocket', now() - interval '2 hours', now() - interval '1 hour', $1, 'unmatched')
         RETURNING id`,
      [TRANSCRIPT],
    );
    ids.push(r.rows[0].id);
    const ran = await runSegmentation(r.rows[0].id);
    expect(ran).toBe(false);
    const row = await pool.query(`SELECT segmentation_status FROM conversations WHERE id = $1`, [r.rows[0].id]);
    expect(row.rows[0].segmentation_status).toBeNull();
  });

  it('surfaces the proposal on the unmatched list and serves it cached', async () => {
    server = http.createServer(createApp());
    await new Promise<void>((r) => server.listen(0, r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    const id = await heldConversation('list');
    await runSegmentation(id);

    const list = await (await get('/review/unmatched')).json();
    const row = list.conversations.find((c: { id: string }) => c.id === id);
    expect(row).toBeTruthy();
    expect(row.segmentation_status).toBe('done');
    expect(row.segment_count).toBeGreaterThanOrEqual(1);

    const segs = await (await get(`/review/unmatched/${id}/segments`)).json();
    expect(segs.source).toBe('cached');
    expect(segs.segments.length).toBeGreaterThanOrEqual(1);
  });
});
