import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import { pool } from '../src/db/pool';
import { enrollMaintenanceClients } from '../src/reengagement/maintenance';
import { runReengagementForLead } from '../src/reengagement/runner';

// Integration: WF3 maintenance reactivation — identify quiet clients by session
// gap and enroll them. Skips when DB is down. Uses a 'mtest-' pb_id namespace so
// it doesn't collide with correlation.int.test.ts's 'it-%' bulk cleanup.
const dbUp = await pool
  .query('SELECT 1')
  .then(() => true)
  .catch(() => false);

const suite = dbUp ? describe : describe.skip;

// GAP_DAYS defaults to 90; 'gap' clients last saw us >90d ago.
const GAP = 'gap-mtest@example.test'; // eligible: last session 120d ago, no upcoming
const RECENT = 'recent-mtest@example.test'; // ineligible: last session 20d ago
const UPCOMING = 'upcoming-mtest@example.test'; // ineligible: gap but has a future booking
const ONEVISIT = 'onevisit-mtest@example.test'; // ineligible for maintenance: only 1 session (first-appt track)

suite('maintenance reactivation (integration)', () => {
  const cleanup = async () => {
    await pool
      .query(`DELETE FROM leads WHERE lower(email) = ANY($1)`, [[GAP, RECENT, UPCOMING, ONEVISIT]])
      .catch(() => {});
    await pool.query(`DELETE FROM appointments WHERE pb_id LIKE 'mtest-%'`).catch(() => {});
    await pool.query(`DELETE FROM clients WHERE pb_id LIKE 'mtest-%'`).catch(() => {});
  };

  async function client(pbSuffix: string, email: string): Promise<string> {
    const r = await pool.query<{ id: string }>(
      `INSERT INTO clients (name, pb_id, email) VALUES ($1, $2, $3) RETURNING id`,
      [`M ${pbSuffix}`, `mtest-client-${pbSuffix}`, email],
    );
    return r.rows[0].id;
  }
  async function appt(clientId: string, pbSuffix: string, daysFromNow: number, status: string): Promise<void> {
    await pool.query(
      `INSERT INTO appointments (client_id, pb_id, starts_at, ends_at, status)
            VALUES ($1, $2, now() + ($3 || ' days')::interval, now() + ($3 || ' days')::interval + interval '1 hour', $4)`,
      [clientId, `mtest-appt-${pbSuffix}`, String(daysFromNow), status],
    );
  }

  beforeAll(cleanup);
  afterAll(async () => {
    await cleanup();
    await pool.end();
  });

  it('enrolls only quiet clients, respecting recency and upcoming bookings; idempotent', async () => {
    // Maintenance requires 2+ completed sessions (an established client).
    const gapId = await client('gap', GAP);
    await appt(gapId, 'gap-1', -200, 'completed'); // earlier session…
    await appt(gapId, 'gap-2', -120, 'completed'); // …most recent, 120d ago

    const recentId = await client('recent', RECENT);
    await appt(recentId, 'recent-1', -200, 'completed');
    await appt(recentId, 'recent-2', -20, 'completed'); // too recent

    const upcomingId = await client('upcoming', UPCOMING);
    await appt(upcomingId, 'upcoming-1', -200, 'completed');
    await appt(upcomingId, 'upcoming-old', -120, 'completed'); // old session…
    await appt(upcomingId, 'upcoming-next', 7, 'confirmed'); // …but rebooked

    const oneVisitId = await client('onevisit', ONEVISIT);
    await appt(oneVisitId, 'onevisit', -120, 'completed'); // only ONE session → first-appt track, not maintenance

    const r1 = await enrollMaintenanceClients();
    expect(r1.enrolled).toBeGreaterThanOrEqual(1);

    const enrolled = await pool.query<{ email: string; status: string; source: string }>(
      `SELECT email, status, source FROM leads WHERE lower(email) = ANY($1)`,
      [[GAP, RECENT, UPCOMING, ONEVISIT]],
    );
    const byEmail = new Map(enrolled.rows.map((x) => [x.email, x]));
    expect(byEmail.get(GAP)).toMatchObject({ status: 'maintenance', source: 'maintenance' });
    expect(byEmail.has(RECENT)).toBe(false); // too recent → not enrolled
    expect(byEmail.has(UPCOMING)).toBe(false); // has a future booking → not enrolled
    expect(byEmail.has(ONEVISIT)).toBe(false); // only one session → not maintenance

    // The maintenance cadence fires the 7-day nudge at day 8.
    const leadId = byEmail.get(GAP)!;
    const gapLead = await pool.query<{ id: string }>(`SELECT id FROM leads WHERE lower(email) = lower($1)`, [GAP]);
    const day8 = new Date(Date.now() + 8 * 86_400_000);
    expect(await runReengagementForLead(gapLead.rows[0].id, day8)).toBe('sent');
    const sent = await pool.query<{ sequence_state: { sent?: string[] }; status: string }>(
      `SELECT sequence_state, status FROM leads WHERE id = $1`,
      [gapLead.rows[0].id],
    );
    expect(sent.rows[0].sequence_state.sent).toContain('maintenance_7d');
    expect(sent.rows[0].status).toBe('maintenance'); // stays on the maintenance track
    void leadId;

    // Idempotent: re-running enrolls nobody new (the gap client now has an active lead).
    const r2 = await enrollMaintenanceClients();
    const gapLeadCount = await pool.query<{ n: number }>(
      `SELECT count(*)::int n FROM leads WHERE lower(email) = lower($1)`,
      [GAP],
    );
    expect(gapLeadCount.rows[0].n).toBe(1);
    expect(r2.skipped).toBeGreaterThanOrEqual(1);
  });
});
