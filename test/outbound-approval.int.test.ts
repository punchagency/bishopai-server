import { describe, it, expect, afterEach, afterAll } from 'vitest';
import { pool } from '../src/db/pool';
import { approve, expireStale, queueEmail, reject, sendApproved } from '../src/outbound/queue';
import { runReengagement } from '../src/reengagement/runner';

// The promise this feature makes, tested against a real database: an automated
// email reaches nobody until a person approves it.
//
// The unit tests cover the rules; these cover the wiring, which is where the
// guarantee would actually fail — a runner that still calls the mailer, a queue
// row that sends without approval, a re-assembly that duplicates a nudge.

const dbUp = await pool
  .query('SELECT 1')
  .then(() => true)
  .catch(() => false);
const suite = dbUp ? describe : describe.skip;

const DAY = 86_400_000;

suite('outbound approval gate (integration)', () => {
  const leadIds: string[] = [];

  const newLead = async (email: string, status = 'new', createdDaysAgo = 0) => {
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO leads (source, email, status, created_at)
            VALUES ('test', $1, $2, now() - ($3 || ' days')::interval)
         RETURNING id`,
      [email, status, String(createdDaysAgo)],
    );
    leadIds.push(rows[0].id);
    return rows[0].id;
  };

  const sentCount = async (email: string): Promise<number> => {
    const { rows } = await pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM email_send_log WHERE to_email = $1`,
      [email],
    );
    return Number(rows[0].n);
  };

  afterEach(async () => {
    for (const id of leadIds.splice(0)) {
      await pool.query(`DELETE FROM outbound_emails WHERE lead_id = $1`, [id]);
      await pool.query(`DELETE FROM messages WHERE lead_id = $1`, [id]);
      await pool.query(`DELETE FROM leads WHERE id = $1`, [id]);
    }
    await pool.query(`DELETE FROM outbound_emails WHERE to_email LIKE 'gate-%@test.local'`);
    await pool.query(`DELETE FROM email_send_log WHERE to_email LIKE 'gate-%@test.local'`);
  });

  afterAll(async () => {
    await pool.end();
  });

  it('holds a due cadence step instead of sending it', async () => {
    // A lead old enough that the 3-day nudge is due. Before the gate this pass
    // mailed them; now it must produce a pending row and nothing else.
    const email = 'gate-nudge@test.local';
    const leadId = await newLead(email, 'contacted', 5);
    await pool.query(
      `UPDATE leads SET sequence_state = '{"sent":["welcome"]}'::jsonb WHERE id = $1`,
      [leadId],
    );

    const before = await sentCount(email);
    await runReengagement();

    const { rows } = await pool.query<{ state: string; list: string; category: string }>(
      `SELECT state, list, category FROM outbound_emails WHERE lead_id = $1`,
      [leadId],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].state).toBe('pending');
    expect(rows[0].list).toBe('normal');
    expect(rows[0].category).toBe('enquiry');
    expect(await sentCount(email)).toBe(before);
  });

  it('does not queue the same step twice when the assembly re-runs', async () => {
    const email = 'gate-dupe@test.local';
    const leadId = await newLead(email, 'contacted', 5);
    await pool.query(
      `UPDATE leads SET sequence_state = '{"sent":["welcome"]}'::jsonb WHERE id = $1`,
      [leadId],
    );

    await runReengagement();
    await runReengagement();

    const { rows } = await pool.query(`SELECT id FROM outbound_emails WHERE lead_id = $1`, [leadId]);
    expect(rows).toHaveLength(1);
  });

  it('sends only after approval, exactly once', async () => {
    const email = 'gate-approve@test.local';
    const res = await queueEmail({
      category: 'enquiry',
      toEmail: email,
      subject: 'Hello',
      body: 'Body',
      sourceRef: 'test:approve',
    });
    expect(res.queued).toBe(true);

    // Unapproved: the dispatcher must ignore it entirely.
    expect(await sendApproved()).toMatchObject({ sent: 0 });
    expect(await sentCount(email)).toBe(0);

    await approve([res.id!], 'tester');
    const after = await sendApproved();
    expect(after.sent).toBe(1);
    expect(await sentCount(email)).toBe(1);

    // A second dispatch must not re-send it.
    await sendApproved();
    expect(await sentCount(email)).toBe(1);
  });

  it('never sends something that was rejected', async () => {
    const email = 'gate-reject@test.local';
    const res = await queueEmail({
      category: 'cancelled',
      toEmail: email,
      subject: 'Reschedule?',
      body: 'Body',
      sourceRef: 'test:reject',
    });
    await reject([res.id!], 'tester', 'not appropriate');
    await sendApproved();
    expect(await sentCount(email)).toBe(0);
  });

  it('expires what nobody approved rather than sending it late', async () => {
    const email = 'gate-stale@test.local';
    const past = new Date(Date.now() - 30 * DAY);
    const res = await queueEmail(
      {
        category: 'dose_lapse',
        toEmail: email,
        subject: 'Running low',
        body: 'Body',
        sourceRef: 'test:stale',
        sendAfter: past,
      },
      past,
    );
    expect(res.queued).toBe(true);

    expect(await expireStale()).toBeGreaterThanOrEqual(1);
    const { rows } = await pool.query<{ state: string }>(
      `SELECT state FROM outbound_emails WHERE id = $1`,
      [res.id],
    );
    expect(rows[0].state).toBe('expired');

    // Even approving afterwards must not resurrect it: approval only moves a
    // pending row, and the dispatcher filters on the window as well.
    await approve([res.id!], 'tester');
    await sendApproved();
    expect(await sentCount(email)).toBe(0);
  });

  it('routes a cancelled-booking win-back to its own list', async () => {
    const email = 'gate-cancelled@test.local';
    const leadId = await newLead(email, 'cancelled', 10);

    await runReengagement();

    const { rows } = await pool.query<{ list: string; category: string }>(
      `SELECT list, category FROM outbound_emails WHERE lead_id = $1`,
      [leadId],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].list).toBe('cancelled');
    expect(rows[0].category).toBe('cancelled');
  });
});
