import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import { pool } from '../src/db/pool';
import { enrollCancelledAppointment } from '../src/reengagement/cancellations';
import { runReengagementForLead } from '../src/reengagement/runner';

// Integration: PB cancellation → WF3 cancelled cadence. Skips when DB is down.
const dbUp = await pool
  .query('SELECT 1')
  .then(() => true)
  .catch(() => false);

const suite = dbUp ? describe : describe.skip;

// Prefix deliberately outside the 'it-%' namespace that correlation.int.test.ts
// bulk-deletes in its cleanup — otherwise a parallel run can drop these rows mid-test.
const PB_APPT = 'citest-appt';
const PB_APPT_NOEMAIL = 'citest-appt-noemail';
const EMAIL = 'cancel-it@example.test';

suite('cancellation → cancelled cadence (integration)', () => {
  const cleanup = async () => {
    await pool.query(`DELETE FROM leads WHERE lower(email) = lower($1)`, [EMAIL]).catch(() => {});
    await pool.query(`DELETE FROM appointments WHERE pb_id LIKE 'citest-%'`).catch(() => {});
    await pool.query(`DELETE FROM clients WHERE pb_id LIKE 'citest-%'`).catch(() => {});
  };

  async function makeClientWithAppt(pbAppt: string, email: string | null): Promise<void> {
    const c = await pool.query<{ id: string }>(
      `INSERT INTO clients (name, pb_id, email) VALUES ($1, $2, $3)
       ON CONFLICT (pb_id) DO UPDATE SET email = EXCLUDED.email RETURNING id`,
      [`CI Cancel ${pbAppt}`, `citest-client-${pbAppt}`, email],
    );
    await pool.query(
      `INSERT INTO appointments (client_id, pb_id, starts_at, ends_at, status)
            VALUES ($1, $2, now() - interval '2 days', now() - interval '2 days' + interval '1 hour', 'cancelled')
       ON CONFLICT (pb_id) DO NOTHING`,
      [c.rows[0].id, pbAppt],
    );
  }

  beforeAll(cleanup);
  afterAll(async () => {
    await cleanup();
    await pool.end();
  });

  it('enrolls a cancelled client, is idempotent, and the cadence fires at 7 days', async () => {
    await makeClientWithAppt(PB_APPT, EMAIL);

    const first = await enrollCancelledAppointment(PB_APPT);
    expect(first.outcome).toBe('created');
    const leadId = first.leadId!;

    const lead = await pool.query<{ status: string }>(`SELECT status FROM leads WHERE id = $1`, [leadId]);
    expect(lead.rows[0].status).toBe('cancelled');

    // Duplicate webhook → no-op, same lead (no second cancelled lead).
    const again = await enrollCancelledAppointment(PB_APPT);
    expect(again.outcome).toBe('noop');
    expect(again.leadId).toBe(leadId);
    const n = await pool.query<{ n: number }>(
      `SELECT count(*)::int n FROM leads WHERE lower(email) = lower($1)`,
      [EMAIL],
    );
    expect(n.rows[0].n).toBe(1);

    // Nothing due immediately (cancelled_7d is at 7 days).
    expect(await runReengagementForLead(leadId, new Date())).toBe('none');

    // At day 8, the first reschedule prompt sends.
    const day8 = new Date(Date.now() + 8 * 86_400_000);
    expect(await runReengagementForLead(leadId, day8)).toBe('sent');
    const sent = await pool.query<{ sequence_state: { sent?: string[] }; status: string }>(
      `SELECT sequence_state, status FROM leads WHERE id = $1`,
      [leadId],
    );
    expect(sent.rows[0].sequence_state.sent).toContain('cancelled_7d');
    expect(sent.rows[0].status).toBe('cancelled'); // stays on the cancelled track
  });

  it('skips a cancellation when the client has no email', async () => {
    await makeClientWithAppt(PB_APPT_NOEMAIL, null);
    const r = await enrollCancelledAppointment(PB_APPT_NOEMAIL);
    expect(r.outcome).toBe('skipped_no_email');
  });
});
