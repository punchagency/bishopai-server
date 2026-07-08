import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import { pool } from '../src/db/pool';
import { pollInbox } from '../src/reengagement/inboxPoller';
import type { InboundMessage } from '../src/integrations/outlook';

// Integration: WF3 Outlook inbox poller (reply detection). DB-gated; skips when
// Postgres is down. Injects a fake message fetcher so no Graph creds are needed.
const dbUp = await pool
  .query('SELECT 1')
  .then(() => true)
  .catch(() => false);

const suite = dbUp ? describe : describe.skip;

const CURSOR_KEY = 'outlook.inbox.cursor';
const LEAD_EMAIL = 'inbox-reply-it@example.test';
const NEW_SENDER = 'stranger-it@example.test'; // clean unknown → new lead
const NOREPLY = 'no-reply@vendor-it.example.test'; // automated → skipped
const OOO = 'ooo-person-it@example.test'; // auto-reply subject → skipped
const ALL_EMAILS = [LEAD_EMAIL, NEW_SENDER, NOREPLY, OOO];

const msg = (from: string, subject: string, receivedDateTime: string): InboundMessage => ({
  id: `m-${from}-${receivedDateTime}`,
  from,
  subject,
  receivedDateTime,
});

suite('inbox poller — reply detection + guarded intake (integration)', () => {
  let leadId = '';
  const cleanup = async () => {
    await pool.query(`DELETE FROM leads WHERE lower(email) = ANY($1)`, [ALL_EMAILS]).catch(() => {});
    await pool.query(`DELETE FROM integration_state WHERE key = $1`, [CURSOR_KEY]).catch(() => {});
  };

  beforeAll(async () => {
    await cleanup();
    const r = await pool.query<{ id: string }>(
      `INSERT INTO leads (source, email, status, sequence_state) VALUES ('website', $1, 'contacted', '{"sent":["welcome"]}') RETURNING id`,
      [LEAD_EMAIL],
    );
    leadId = r.rows[0].id;
  });
  afterAll(async () => {
    await cleanup();
    await pool.end();
  });

  it('first run initializes the cursor and processes nothing', async () => {
    // Even if the fetcher would return old mail, first run must not sweep it.
    const fetchMessages = async () => [msg(LEAD_EMAIL, 'ancient', '2000-01-01T00:00:00Z')];
    const res = await pollInbox({ fetchMessages, now: () => new Date('2026-07-06T12:00:00Z') });
    expect(res).toEqual({ checked: 0, replied: 0, newLeads: 0 });

    const cur = await pool.query<{ value: string }>(`SELECT value FROM integration_state WHERE key = $1`, [CURSOR_KEY]);
    expect(cur.rows[0].value).toBe('2026-07-06T12:00:00.000Z');

    const lead = await pool.query<{ status: string }>(`SELECT status FROM leads WHERE id = $1`, [leadId]);
    expect(lead.rows[0].status).toBe('contacted'); // untouched
  });

  it('detects a reply, creates a lead from a clean unknown sender, and skips automated mail', async () => {
    const fetchMessages = async (since: string | null) => {
      expect(since).toBe('2026-07-06T12:00:00.000Z'); // uses the initialized cursor
      return [
        msg(LEAD_EMAIL, 'Re: your consult', '2026-07-06T13:00:00Z'), // active lead → reply
        msg(NEW_SENDER, 'Do you have availability?', '2026-07-06T13:30:00Z'), // unknown → new lead
        msg(NOREPLY, 'Your receipt', '2026-07-06T13:40:00Z'), // automated → skip
        msg(OOO, 'Automatic reply: out of office', '2026-07-06T13:50:00Z'), // auto-reply → skip
      ];
    };
    const res = await pollInbox({ fetchMessages });
    expect(res).toEqual({ checked: 4, replied: 1, newLeads: 1 });

    // Reply: cadence stopped + activity recorded.
    const lead = await pool.query<{ status: string }>(`SELECT status FROM leads WHERE id = $1`, [leadId]);
    expect(lead.rows[0].status).toBe('replied');
    const replyAct = await pool.query<{ detail: string }>(
      `SELECT detail FROM lead_activity WHERE lead_id = $1 AND type = 'reply'`,
      [leadId],
    );
    expect(replyAct.rowCount).toBe(1);
    expect(replyAct.rows[0].detail).toContain('Re: your consult');

    // Intake: new lead created from the clean sender + automated first response.
    const created = await pool.query<{ status: string; source: string; sequence_state: { sent?: string[] } }>(
      `SELECT status, source, sequence_state FROM leads WHERE lower(email) = lower($1)`,
      [NEW_SENDER],
    );
    expect(created.rowCount).toBe(1);
    expect(created.rows[0].source).toBe('outlook');
    expect(created.rows[0].status).toBe('contacted'); // welcome sent
    expect(created.rows[0].sequence_state.sent).toContain('welcome');

    // Guards: no lead created for the no-reply or auto-reply senders.
    for (const skipped of [NOREPLY, OOO]) {
      const r = await pool.query(`SELECT 1 FROM leads WHERE lower(email) = lower($1)`, [skipped]);
      expect(r.rowCount, skipped).toBe(0);
    }

    const cur = await pool.query<{ value: string }>(`SELECT value FROM integration_state WHERE key = $1`, [CURSOR_KEY]);
    expect(cur.rows[0].value).toBe('2026-07-06T13:50:00Z'); // max received in the batch
  });

  it('polls multiple mailboxes with independent cursors and a shared self-guard', async () => {
    const BOX1 = 'hello@innerlumehealing.com';
    const BOX2 = 'nicole@innerlumehealing.com';
    const c1 = `${CURSOR_KEY}:${BOX1.toLowerCase()}`;
    const c2 = `${CURSOR_KEY}:${BOX2.toLowerCase()}`;
    const STRANGER = 'multi-stranger-it@example.test';
    await pool.query(`DELETE FROM integration_state WHERE key = ANY($1)`, [[c1, c2]]);
    await pool.query(`DELETE FROM leads WHERE lower(email) = $1`, [STRANGER]);

    // First run per mailbox: initialize both cursors, sweep nothing.
    const init = await pollInbox({
      mailboxes: [BOX1, BOX2],
      fetchMessages: async () => [msg(STRANGER, 'old', '2000-01-01T00:00:00Z')],
      now: () => new Date('2026-07-08T09:00:00Z'),
    });
    expect(init).toEqual({ checked: 0, replied: 0, newLeads: 0 });
    for (const k of [c1, c2]) {
      const cur = await pool.query<{ value: string }>(`SELECT value FROM integration_state WHERE key = $1`, [k]);
      expect(cur.rows[0].value).toBe('2026-07-08T09:00:00.000Z');
    }

    // Second run: each inbox returns its own mail. A message "from" BOX2 landing
    // in BOX1's inbox must be ignored (self-guard spans all connected mailboxes).
    const perBox: Record<string, InboundMessage[]> = {
      [BOX1]: [
        msg(STRANGER, 'Do you have space?', '2026-07-08T10:00:00Z'), // → new lead
        msg(BOX2, 'fwd', '2026-07-08T10:05:00Z'), // our own other mailbox → skipped as self
      ],
      [BOX2]: [msg(STRANGER, 'ping in box2', '2026-07-08T11:00:00Z')], // same person, other inbox
    };
    const res = await pollInbox({
      mailboxes: [BOX1, BOX2],
      fetchMessages: async (_since, mailbox) => perBox[mailbox ?? ''] ?? [],
    });
    expect(res.newLeads).toBe(1); // one lead for the stranger, not two
    expect(res.checked).toBe(3);

    const created = await pool.query(`SELECT 1 FROM leads WHERE lower(email) = lower($1)`, [STRANGER]);
    expect(created.rowCount).toBe(1);
    const self = await pool.query(`SELECT 1 FROM leads WHERE lower(email) = lower($1)`, [BOX2]);
    expect(self.rowCount, 'our own mailbox must never become a lead').toBe(0);

    // Cursors advanced independently to each inbox's high-water mark.
    const cur1 = await pool.query<{ value: string }>(`SELECT value FROM integration_state WHERE key = $1`, [c1]);
    const cur2 = await pool.query<{ value: string }>(`SELECT value FROM integration_state WHERE key = $1`, [c2]);
    expect(cur1.rows[0].value).toBe('2026-07-08T10:05:00Z');
    expect(cur2.rows[0].value).toBe('2026-07-08T11:00:00Z');

    await pool.query(`DELETE FROM leads WHERE lower(email) = $1`, [STRANGER]);
    await pool.query(`DELETE FROM integration_state WHERE key = ANY($1)`, [[c1, c2]]);
  });

  it('is idempotent — re-delivered mail from settled leads does nothing', async () => {
    const fetchMessages = async () => [
      msg(LEAD_EMAIL, 'Re: your consult again', '2026-07-06T14:00:00Z'), // already replied → no-op
      msg(NEW_SENDER, 'following up', '2026-07-06T14:10:00Z'), // now an active lead → reply, not a 2nd welcome
    ];
    const res = await pollInbox({ fetchMessages });
    expect(res.newLeads).toBe(0); // no duplicate lead / welcome
    // The re-contacting new sender is now an active lead → treated as a reply.
    const act = await pool.query<{ n: number }>(
      `SELECT count(*)::int n FROM lead_activity la JOIN leads l ON l.id = la.lead_id
        WHERE lower(l.email) = lower($1) AND la.type = 'reply'`,
      [NEW_SENDER],
    );
    expect(act.rows[0].n).toBe(1);
    // The already-replied original lead gets no duplicate reply activity.
    const orig = await pool.query<{ n: number }>(
      `SELECT count(*)::int n FROM lead_activity WHERE lead_id = $1 AND type = 'reply'`,
      [leadId],
    );
    expect(orig.rows[0].n).toBe(1);
  });
});
