import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import { pool } from '../src/db/pool';
import { ingestLead } from '../src/reengagement/intake';
import { runReengagementForLead } from '../src/reengagement/runner';

// Integration: WF3 lead intake → immediate automated first response. Skips (not
// fails) when the dev DB isn't reachable, like the other DB-gated suites.
const dbUp = await pool
  .query('SELECT 1')
  .then(() => true)
  .catch(() => false);

const suite = dbUp ? describe : describe.skip;

const EMAIL = 'intake-it@example.test';

suite('lead intake (integration, real Postgres)', () => {
  const cleanup = async () => {
    // outbound_emails.lead_id is ON DELETE SET NULL, so queued rows survive the
    // lead and would leak into the next run's assertions. Clear them by address.
    await pool.query(`DELETE FROM outbound_emails WHERE lower(to_email) = lower($1)`, [EMAIL]).catch(() => {});
    await pool
      .query(`DELETE FROM leads WHERE lower(email) = lower($1)`, [EMAIL])
      .catch(() => {}); // messages + lead_activity cascade on lead delete
  };
  beforeAll(cleanup);
  afterAll(async () => {
    await cleanup();
    await pool.end();
  });

  async function activityCount(leadId: string): Promise<number> {
    const r = await pool.query<{ n: number }>(
      `SELECT count(*)::int n FROM lead_activity WHERE lead_id = $1`,
      [leadId],
    );
    return r.rows[0].n;
  }

  it('creates a lead, reuses it on repeat, and queues the welcome once', async () => {
    // First inquiry → new lead + one activity.
    const first = await ingestLead({
      email: EMAIL,
      name: 'Test Person',
      source: 'website',
      path: '/book-a-consult',
      detail: 'Interested in a consult',
    });
    expect(first.created).toBe(true);
    expect(await activityCount(first.leadId)).toBe(1);

    // Repeat submission from the same email → reuse, no duplicate lead.
    const second = await ingestLead({ email: EMAIL, source: 'website' });
    expect(second.created).toBe(false);
    expect(second.leadId).toBe(first.leadId);
    expect(await activityCount(first.leadId)).toBe(2);

    // The welcome used to send itself here — it was the last automated email
    // that reached a client unreviewed. It is now HELD, like every other step.
    expect(await runReengagementForLead(first.leadId)).toBe('queued');

    const lead = await pool.query<{ status: string; sequence_state: { sent?: string[]; queued?: string[] } }>(
      `SELECT status, sequence_state FROM leads WHERE id = $1`,
      [first.leadId],
    );
    // The step is consumed so the next pass moves on rather than re-offering it,
    // but nothing has been SENT, so the lead has not progressed to 'contacted'.
    expect(lead.rows[0].sequence_state.queued).toContain('welcome');
    expect(lead.rows[0].sequence_state.sent ?? []).not.toContain('welcome');

    // The point of the whole gate: no message went to the client.
    const msg = await pool.query<{ n: number }>(
      `SELECT count(*)::int n FROM messages WHERE lead_id = $1 AND channel = 'email'`,
      [first.leadId],
    );
    expect(msg.rows[0].n).toBe(0);

    // It is waiting for approval, in the urgent lane, with a one-day window —
    // a welcome is worth sending today and not much after.
    const queued = await pool.query<{
      state: string;
      priority: string;
      category: string;
      window_hours: number;
    }>(
      `SELECT state, priority, category,
              round(extract(epoch FROM (expires_at - send_after)) / 3600)::int AS window_hours
         FROM outbound_emails WHERE lead_id = $1`,
      [first.leadId],
    );
    expect(queued.rows).toHaveLength(1);
    expect(queued.rows[0]).toMatchObject({
      state: 'pending',
      priority: 'urgent',
      category: 'enquiry',
      window_hours: 24,
    });

    // Idempotent: running again right away queues nothing more.
    expect(await runReengagementForLead(first.leadId)).toBe('none');
    const again = await pool.query<{ n: number }>(
      `SELECT count(*)::int n FROM outbound_emails WHERE lead_id = $1`,
      [first.leadId],
    );
    expect(again.rows[0].n).toBe(1);
  });

  it('starts a fresh lead when the prior one is closed', async () => {
    await pool.query(`UPDATE leads SET status = 'closed' WHERE lower(email) = lower($1)`, [EMAIL]);
    const again = await ingestLead({ email: EMAIL, source: 'website' });
    expect(again.created).toBe(true); // closed lead not reused
    const count = await pool.query<{ n: number }>(
      `SELECT count(*)::int n FROM leads WHERE lower(email) = lower($1)`,
      [EMAIL],
    );
    expect(count.rows[0].n).toBe(2);
  });
});
