import { describe, it, expect, afterAll } from 'vitest';
import { pool } from '../src/db/pool';
import { syncClientSupplements } from '../src/session/supplements';

// Integration: the WF1→WF2/WF4 linkage — approving a Protocol reconciles its
// supplement changes into the shared `supplements` plan. Skips (not fails) when
// the dev DB isn't reachable, matching the other DB-gated suites.
const dbUp = await pool
  .query('SELECT 1')
  .then(() => true)
  .catch(() => false);

const suite = dbUp ? describe : describe.skip;

suite('supplement sync (integration, real Postgres)', () => {
  let clientId = '';

  // pb_id outside the 'it-%' namespace correlation.int.test.ts bulk-deletes.
  async function makeClient(): Promise<string> {
    const r = await pool.query<{ id: string }>(
      `INSERT INTO clients (name, pb_id) VALUES ('SS SuppSync', 'sstest-suppsync') RETURNING id`,
    );
    return r.rows[0].id;
  }

  async function names(): Promise<string[]> {
    const r = await pool.query<{ name: string }>(
      `SELECT name FROM supplements WHERE client_id = $1 ORDER BY name`,
      [clientId],
    );
    return r.rows.map((x) => x.name);
  }

  const note = (supplements: unknown[]) => ({
    concerns: [],
    assessments: [],
    protocol_changes: [],
    supplements,
    follow_ups: [],
  });

  afterAll(async () => {
    await pool.query(`DELETE FROM supplements WHERE client_id = $1`, [clientId]).catch(() => {});
    await pool.query(`DELETE FROM clients WHERE pb_id = 'sstest-suppsync'`).catch(() => {});
    await pool.end();
  });

  it('starts, stops, upserts and is idempotent', async () => {
    clientId = await makeClient();
    const db = await pool.connect();
    try {
      // Start two supplements.
      const r1 = await syncClientSupplements(
        db,
        clientId,
        '2026-07-01',
        note([
          { name: 'Magnesium', dose: '2 caps daily', quantity: 60, change: 'start' },
          { name: 'Vitamin D', dose: '1 cap daily', quantity: 90, change: 'start' },
        ]),
      );
      expect(r1).toEqual({ upserted: 2, removed: 0 });
      expect(await names()).toEqual(['Magnesium', 'Vitamin D']);

      // Stop one, adjust the other (dose/qty updates in place, no new row).
      const r2 = await syncClientSupplements(
        db,
        clientId,
        '2026-08-01',
        note([
          { name: 'magnesium', dose: '3 caps daily', quantity: 90, change: 'increase' }, // case-insensitive match
          { name: 'Vitamin D', dose: null, quantity: null, change: 'stop' },
        ]),
      );
      expect(r2).toEqual({ upserted: 1, removed: 1 });
      // Matched case-insensitively (no duplicate row); the latest protocol's
      // spelling wins, so the stored name adopts the incoming 'magnesium'.
      expect(await names()).toEqual(['magnesium']);

      const mag = await pool.query<{ dose: string; qty: number; start_date: string }>(
        `SELECT dose, qty, start_date FROM supplements WHERE client_id = $1`,
        [clientId],
      );
      expect(mag.rows).toHaveLength(1); // updated in place, not duplicated
      expect(mag.rows[0].dose).toBe('3 caps daily');
      expect(mag.rows[0].qty).toBe(90);

      // Re-applying a note is a no-op on row count (idempotent upsert); the
      // canonical spelling can be restored by a later protocol.
      const r3 = await syncClientSupplements(
        db,
        clientId,
        '2026-08-01',
        note([{ name: 'Magnesium', dose: '3 caps daily', quantity: 90, change: 'continue' }]),
      );
      expect(r3).toEqual({ upserted: 1, removed: 0 });
      expect(await names()).toEqual(['Magnesium']);
    } finally {
      db.release();
    }
  });
});
