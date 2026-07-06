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

  it('creates a lead, reuses it on repeat, and auto-sends the welcome once', async () => {
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

    // Immediate first response: welcome (afterDays 0) sends now.
    expect(await runReengagementForLead(first.leadId)).toBe('sent');

    const lead = await pool.query<{ status: string; sequence_state: { sent?: string[] } }>(
      `SELECT status, sequence_state FROM leads WHERE id = $1`,
      [first.leadId],
    );
    expect(lead.rows[0].status).toBe('contacted');
    expect(lead.rows[0].sequence_state.sent).toContain('welcome');

    const msg = await pool.query<{ n: number }>(
      `SELECT count(*)::int n FROM messages WHERE lead_id = $1 AND channel = 'email'`,
      [first.leadId],
    );
    expect(msg.rows[0].n).toBe(1);

    // Idempotent: running again right away sends nothing (welcome already sent,
    // nudge_3d not yet due).
    expect(await runReengagementForLead(first.leadId)).toBe('none');
    const msg2 = await pool.query<{ n: number }>(
      `SELECT count(*)::int n FROM messages WHERE lead_id = $1`,
      [first.leadId],
    );
    expect(msg2.rows[0].n).toBe(1);
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
