import { describe, it, expect, afterEach, afterAll } from 'vitest';
import { pool } from '../src/db/pool';
import { reconcileStuckBookings } from '../src/reengagement/bookingReconcile';

// Stuck-booking sweep: reopens leads left 'booked' with no 'booked' activity
// (crash between claim and record), but only after the grace window and never a
// legitimately-booked or in-flight one.

const dbUp = await pool
  .query('SELECT 1')
  .then(() => true)
  .catch(() => false);
const suite = dbUp ? describe : describe.skip;

suite('reconcileStuckBookings (integration)', () => {
  const leadIds: string[] = [];

  async function mkLead(status: string, updatedMinutesAgo: number): Promise<string> {
    // Set updated_at at INSERT — the leads_set_updated_at trigger is BEFORE
    // UPDATE only, so an UPDATE would overwrite it back to now().
    const r = await pool.query<{ id: string }>(
      `INSERT INTO leads (email, status, updated_at)
            VALUES ($1, $2, now() - ($3 || ' minutes')::interval)
         RETURNING id`,
      [`stuck-${Math.random().toString(36).slice(2)}@x.com`, status, String(updatedMinutesAgo)],
    );
    const id = r.rows[0].id;
    leadIds.push(id);
    return id;
  }

  afterEach(async () => {
    for (const id of leadIds.splice(0)) await pool.query(`DELETE FROM leads WHERE id = $1`, [id]);
  });
  afterAll(async () => {
    await pool.end();
  });

  it('reopens a stranded booked lead past the grace window', async () => {
    const id = await mkLead('booked', 30);
    const { reopened } = await reconcileStuckBookings();
    expect(reopened).toBeGreaterThanOrEqual(1);
    const { rows } = await pool.query<{ status: string }>(`SELECT status FROM leads WHERE id = $1`, [id]);
    expect(rows[0].status).toBe('nurturing');
  });

  it('leaves an in-flight (recent) booked lead alone', async () => {
    const id = await mkLead('booked', 1); // within grace
    await reconcileStuckBookings();
    const { rows } = await pool.query<{ status: string }>(`SELECT status FROM leads WHERE id = $1`, [id]);
    expect(rows[0].status).toBe('booked');
  });

  it('leaves a legitimately booked lead (has a booked activity) alone', async () => {
    const id = await mkLead('booked', 30);
    await pool.query(`INSERT INTO lead_activity (lead_id, type, detail) VALUES ($1, 'booked', 'ok')`, [id]);
    await reconcileStuckBookings();
    const { rows } = await pool.query<{ status: string }>(`SELECT status FROM leads WHERE id = $1`, [id]);
    expect(rows[0].status).toBe('booked');
  });
});
