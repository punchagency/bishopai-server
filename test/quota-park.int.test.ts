import { describe, it, expect, afterAll } from 'vitest';
import { pool } from '../src/db/pool';
import { markExtractionFailed } from '../src/session/reclaim';
import { RateLimitError } from '../src/llm/errors';

// Integration: a spent daily allowance must not consume the retry budget.
//
// The failure this guards is the second-order half of 2026-08-24. Once the day's
// 20 requests are gone, every extraction fails identically until the cap resets
// — so a retry ladder of 1/5/15/60 minutes spends four more requests on the cap
// that just refused, and four failures dead-letter the conversation to
// needs_review having never once reached the model. A healthy session ends up
// filed as broken, and the requests that could have extracted it tomorrow were
// spent proving it couldn't be extracted today.
const dbUp = await pool
  .query('SELECT 1')
  .then(() => true)
  .catch(() => false);

const suite = dbUp ? describe : describe.skip;

suite('quota parking (integration, real Postgres)', () => {
  afterAll(async () => {
    await pool.query(`DELETE FROM conversations WHERE source_id LIKE 'quotapark-%'`).catch(() => {});
    await pool.end();
  });

  async function makeFailing(tag: string): Promise<string> {
    const r = await pool.query<{ id: string }>(
      `INSERT INTO conversations
              (source_id, source, starts_at, ends_at, transcript,
               extraction_status, extraction_attempts)
            VALUES ($1, 'manual', now(), now(), 'x', 'processing', 0)
       RETURNING id`,
      [`quotapark-${tag}-${Math.random().toString(36).slice(2)}`],
    );
    return r.rows[0].id;
  }

  const read = async (id: string) =>
    (
      await pool.query<{
        extraction_status: string;
        extraction_attempts: number;
        next_at: string | null;
      }>(
        `SELECT extraction_status, extraction_attempts,
                extraction_next_attempt_at AS next_at
           FROM conversations WHERE id = $1`,
        [id],
      )
    ).rows[0];

  it('parks a spent allowance without burning an attempt', async () => {
    const id = await makeFailing('spent');
    const spent = new RateLimitError({ provider: 'google', exhausted: true });

    await markExtractionFailed(id, spent.message, null, spent);

    const row = await read(id);
    expect(row.extraction_status).toBe('failed');
    // The counter is what dead-letters to needs_review at 4. Nothing was tried,
    // so nothing is counted.
    expect(row.extraction_attempts).toBe(0);
    // And it waits hours, not the one minute the ordinary ladder starts at.
    const waitMs = new Date(row.next_at!).getTime() - Date.now();
    expect(waitMs).toBeGreaterThan(60 * 60 * 1000);
  });

  it('still counts and ladders an ordinary failure', async () => {
    const id = await makeFailing('broken');

    await markExtractionFailed(id, 'model returned malformed JSON', null, new Error('boom'));

    const row = await read(id);
    expect(row.extraction_status).toBe('failed');
    expect(row.extraction_attempts).toBe(1);
    // First rung of the existing ladder: about a minute, and certainly not a day.
    const waitMs = new Date(row.next_at!).getTime() - Date.now();
    expect(waitMs).toBeLessThan(10 * 60 * 1000);
  });

  it('treats a merely-paced rate limit as an ordinary failure', async () => {
    // Only `exhausted` parks. A per-minute 429 that reached this far is a real
    // failed attempt and keeps its place on the ladder.
    const id = await makeFailing('paced');
    const paced = new RateLimitError({ provider: 'google', retryAfterMs: 12_000 });

    await markExtractionFailed(id, paced.message, null, paced);

    const row = await read(id);
    expect(row.extraction_attempts).toBe(1);
  });
});
