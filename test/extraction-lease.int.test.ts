import { describe, it, expect, afterAll } from 'vitest';
import { pool } from '../src/db/pool';
import { reclaimStuckExtractions } from '../src/session/reclaim';

// Integration: the lease invariant the heartbeat depends on.
//
// A genuinely long extraction renews extraction_leased_at as it runs
// (startLeaseHeartbeat in process.ts). What makes that safe is that the reclaim
// sweep keys purely on lease age: a fresh lease is left alone, a stale one is
// reclaimed. If reclaim ever started ignoring the lease, a heartbeating long
// session would be reclaimed mid-flight — so guard both directions.
const dbUp = await pool
  .query('SELECT 1')
  .then(() => true)
  .catch(() => false);

const suite = dbUp ? describe : describe.skip;

suite('extraction lease reclaim (integration, real Postgres)', () => {
  afterAll(async () => {
    await pool.query(`DELETE FROM conversations WHERE source_id LIKE 'lease-%'`).catch(() => {});
    await pool.end();
  });

  async function makeProcessing(tag: string, leasedAtSql: string): Promise<string> {
    const r = await pool.query<{ id: string }>(
      `INSERT INTO conversations
              (source_id, source, starts_at, ends_at, transcript,
               extraction_status, extraction_leased_at, extraction_attempts)
            VALUES ($1, 'manual', now(), now(), 'x',
               'processing', ${leasedAtSql}, 0)
       RETURNING id`,
      [`lease-${tag}-${Math.random().toString(36).slice(2)}`],
    );
    return r.rows[0].id;
  }

  it('leaves a freshly-leased extraction alone (a heartbeating long session)', async () => {
    const id = await makeProcessing('fresh', 'now()');
    await reclaimStuckExtractions();
    const r = await pool.query<{ extraction_status: string; extraction_attempts: number }>(
      `SELECT extraction_status, extraction_attempts FROM conversations WHERE id = $1`,
      [id],
    );
    expect(r.rows[0].extraction_status).toBe('processing');
    expect(r.rows[0].extraction_attempts).toBe(0);
  });

  it('reclaims an extraction whose lease has gone stale (a dead process)', async () => {
    const id = await makeProcessing('stale', `now() - interval '20 minutes'`);
    await reclaimStuckExtractions();
    const r = await pool.query<{ extraction_status: string; extraction_attempts: number }>(
      `SELECT extraction_status, extraction_attempts FROM conversations WHERE id = $1`,
      [id],
    );
    expect(r.rows[0].extraction_status).toBe('failed');
    expect(r.rows[0].extraction_attempts).toBe(1);
  });
});
