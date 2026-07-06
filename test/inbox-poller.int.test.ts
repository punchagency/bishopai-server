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
