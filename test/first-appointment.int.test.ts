import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import { pool } from '../src/db/pool';
import { enrollFirstAppointmentClients } from '../src/reengagement/firstAppointment';
import { runReengagementForLead } from '../src/reengagement/runner';

// Integration: WF3 first-appointment conversion — identify one-and-done clients
// and enroll them. Skips when DB is down. 'ftest-' pb_id namespace avoids the
// 'it-%' bulk cleanup in correlation.int.test.ts.
const dbUp = await pool
  .query('SELECT 1')
  .then(() => true)
  .catch(() => false);

const suite = dbUp ? describe : describe.skip;

const ONE = 'one-ftest@example.test'; // eligible: exactly one session, 30d ago, no rebooking
const TWO = 'two-ftest@example.test'; // ineligible: two sessions (maintenance territory)
const REBOOKED = 'rebooked-ftest@example.test'; // ineligible: one session but has an upcoming booking
const FRESH = 'fresh-ftest@example.test'; // ineligible: session was yesterday (within the wait window)

suite('first-appointment conversion (integration)', () => {
  const emails = [ONE, TWO, REBOOKED, FRESH];
  const cleanup = async () => {
    await pool.query(`DELETE FROM leads WHERE lower(email) = ANY($1)`, [emails]).catch(() => {});
    await pool.query(`DELETE FROM appointments WHERE pb_id LIKE 'ftest-%'`).catch(() => {});
    await pool.query(`DELETE FROM clients WHERE pb_id LIKE 'ftest-%'`).catch(() => {});
  };

  async function client(sfx: string, email: string): Promise<string> {
    const r = await pool.query<{ id: string }>(
      `INSERT INTO clients (name, pb_id, email) VALUES ($1, $2, $3) RETURNING id`,
      [`F ${sfx}`, `ftest-client-${sfx}`, email],
    );
    return r.rows[0].id;
  }
  async function appt(clientId: string, sfx: string, daysFromNow: number, status: string): Promise<void> {
    await pool.query(
      `INSERT INTO appointments (client_id, pb_id, starts_at, ends_at, status)
            VALUES ($1, $2, now() + ($3 || ' days')::interval, now() + ($3 || ' days')::interval + interval '1 hour', $4)`,
      [clientId, `ftest-appt-${sfx}`, String(daysFromNow), status],
    );
  }

  beforeAll(cleanup);
  afterAll(async () => {
    await cleanup();
    await pool.end();
  });

  it('enrolls only one-and-done clients; excludes 2-session, rebooked, and too-fresh; idempotent', async () => {
    const oneId = await client('one', ONE);
    await appt(oneId, 'one', -30, 'completed');

    const twoId = await client('two', TWO);
    await appt(twoId, 'two-1', -60, 'completed');
    await appt(twoId, 'two-2', -30, 'completed'); // two sessions → not first-appt

    const rebookedId = await client('rebooked', REBOOKED);
    await appt(rebookedId, 'rebooked-1', -30, 'completed');
    await appt(rebookedId, 'rebooked-next', 5, 'confirmed'); // has a future booking

    const freshId = await client('fresh', FRESH);
    await appt(freshId, 'fresh', -1, 'completed'); // within the wait window

    const r1 = await enrollFirstAppointmentClients();
    expect(r1.enrolled).toBeGreaterThanOrEqual(1);

    const rows = await pool.query<{ email: string; status: string; source: string }>(
      `SELECT email, status, source FROM leads WHERE lower(email) = ANY($1)`,
      [emails],
    );
    const byEmail = new Map(rows.rows.map((x) => [x.email, x]));
    expect(byEmail.get(ONE)).toMatchObject({ status: 'first_appointment', source: 'first_appointment' });
    expect(byEmail.has(TWO)).toBe(false);
    expect(byEmail.has(REBOOKED)).toBe(false);
    expect(byEmail.has(FRESH)).toBe(false);

    // The cadence sends the 7-day nudge at day 8, then the 14-day incentive.
    const lead = await pool.query<{ id: string }>(`SELECT id FROM leads WHERE lower(email) = lower($1)`, [ONE]);
    const leadId = lead.rows[0].id;
    expect(await runReengagementForLead(leadId, new Date(Date.now() + 8 * 86_400_000))).toBe('sent');
    expect(await runReengagementForLead(leadId, new Date(Date.now() + 15 * 86_400_000))).toBe('sent');
    const sent = await pool.query<{ sequence_state: { sent?: string[] }; status: string }>(
      `SELECT sequence_state, status FROM leads WHERE id = $1`,
      [leadId],
    );
    expect(sent.rows[0].sequence_state.sent).toEqual(
      expect.arrayContaining(['first_appt_7d', 'first_appt_14d']),
    );
    expect(sent.rows[0].status).toBe('first_appointment'); // stays on track

    // Idempotent: re-running enrolls nobody new.
    await enrollFirstAppointmentClients();
    const n = await pool.query<{ n: number }>(
      `SELECT count(*)::int n FROM leads WHERE lower(email) = lower($1)`,
      [ONE],
    );
    expect(n.rows[0].n).toBe(1);
    // Heavy: 8 inserts + an enroll + two cadence passes + an idempotency check.
    // In isolation it runs in ~3s, but sharing Postgres with the parallel suite
    // it can brush the default 5s. A wider ceiling keeps it from flaking there.
  }, 15_000);
});
