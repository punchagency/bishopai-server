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

  // pb_id outside the 'it-%' namespace correlation.int.test.ts bulk-deletes, and
  // unique, so each test takes its own suffix rather than colliding.
  async function makeClient(suffix = ''): Promise<string> {
    const r = await pool.query<{ id: string }>(
      `INSERT INTO clients (name, pb_id) VALUES ('SS SuppSync', $1) RETURNING id`,
      [`sstest-suppsync${suffix}`],
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
    await pool
      .query(
        `DELETE FROM supplements WHERE client_id IN
           (SELECT id FROM clients WHERE pb_id LIKE 'sstest-suppsync%')`,
      )
      .catch(() => {});
    await pool.query(`DELETE FROM clients WHERE pb_id LIKE 'sstest-suppsync%'`).catch(() => {});
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

  it('does not let an out-of-order (older) approval walk the plan backwards', async () => {
    clientId = await makeClient('-chrono');
    const db = await pool.connect();
    const row = async () => {
      const r = await pool.query<{ dose: string; qty: number; start_date: string }>(
        `SELECT dose, qty, start_date::text AS start_date FROM supplements WHERE client_id = $1 AND name = 'Iron'`,
        [clientId],
      );
      return r.rows[0];
    };
    try {
      // The NEWER session (July) is approved first and establishes the plan.
      await syncClientSupplements(
        db, clientId, '2026-07-01',
        note([{ name: 'Iron', dose: '2 caps', quantity: 60, change: 'increase' }]),
      );
      expect(await row()).toMatchObject({ dose: '2 caps', qty: 60, start_date: '2026-07-01' });

      // The OLDER session (June) is approved late. Its dose must NOT overwrite
      // the newer one, and its start_date must not move backwards.
      const r = await syncClientSupplements(
        db, clientId, '2026-06-01',
        note([{ name: 'Iron', dose: '1 cap', quantity: 30, change: 'start' }]),
      );
      expect(r.upserted).toBe(0); // guarded out
      expect(await row()).toMatchObject({ dose: '2 caps', qty: 60, start_date: '2026-07-01' });

      // And an OLDER `stop` must not remove a supplement a newer session kept.
      const r2 = await syncClientSupplements(
        db, clientId, '2026-06-15',
        note([{ name: 'Iron', dose: null, quantity: null, change: 'stop' }]),
      );
      expect(r2.removed).toBe(0);
      expect(await row()).toMatchObject({ dose: '2 caps' });
    } finally {
      db.release();
    }
  });

  it('keeps a stated dosing schedule and does not clear it on a silent session', async () => {
    clientId = await makeClient('-sched');
    const db = await pool.connect();
    const scheduleOf = async (): Promise<unknown> => {
      const r = await pool.query<{ schedule: unknown }>(
        `SELECT schedule FROM supplements WHERE client_id = $1 AND name = 'Zypan'`,
        [clientId],
      );
      return r.rows[0]?.schedule;
    };
    try {
      // Session one states when it's taken.
      await syncClientSupplements(
        db,
        clientId,
        '2026-07-01',
        note([
          {
            name: 'Zypan',
            dose: '1 w/ meals',
            quantity: 2,
            change: 'start',
            schedule: { breakfast: '1 tab', dinner: '1 tab' },
          },
        ]),
      );
      // The schema normalises to all seven slots; unstated ones are explicitly
      // null, which is what keeps "not taken then" distinct from "unknown".
      expect(await scheduleOf()).toMatchObject({ breakfast: '1 tab', dinner: '1 tab', lunch: null });

      // Session two continues it without restating the timing. The established
      // pattern must survive — clearing it would silently blank the protocol
      // sheet's dosing columns for a supplement she never changed.
      await syncClientSupplements(
        db,
        clientId,
        '2026-08-01',
        note([{ name: 'Zypan', dose: '1 w/ meals', quantity: 2, change: 'continue' }]),
      );
      expect(await scheduleOf()).toMatchObject({ breakfast: '1 tab', dinner: '1 tab' });

      // A restated schedule replaces the old one outright.
      await syncClientSupplements(
        db,
        clientId,
        '2026-09-01',
        note([
          {
            name: 'Zypan',
            dose: '2 w/ meals',
            quantity: 2,
            change: 'increase',
            schedule: { lunch: '2 tabs' },
          },
        ]),
      );
      expect(await scheduleOf()).toMatchObject({ lunch: '2 tabs', breakfast: null, dinner: null });
    } finally {
      db.release();
    }
  });
});
