import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  emulatorUp,
  installFirestore,
  uninstallFirestore,
  clearFirestore,
} from './firestore';
import { seedLead } from './fixtures';
import type { IDatabase } from '../src/db/interfaces/repositories';
import { pollInbox } from '../src/reengagement/inboxPoller';
import type { InboundMessage } from '../src/integrations/outlook';

// Integration: WF3 Outlook inbox poller (reply detection). Emulator-gated;
// injects a fake message fetcher so no Graph creds are needed.
const up = await emulatorUp();
const suite = up ? describe : describe.skip;
if (!up) {
  console.log('[inbox-poller.int] Firestore emulator not running - skipping. Start: npm run firestore:emulator');
}

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

// These cases build on each other (the cursor advances across them), so this
// suite seeds ONCE in beforeAll rather than wiping between tests.
suite('inbox poller - reply detection + guarded intake (integration)', () => {
  let leadId = '';
  let db: IDatabase;

  beforeAll(async () => {
    db = installFirestore('inbox-poller-int');
    await clearFirestore(db);
    const lead = await seedLead(db, {
      source: 'website',
      email: LEAD_EMAIL,
      status: 'contacted',
      sequence_state: { sent: ['welcome'] },
    });
    leadId = lead.id;
    void ALL_EMAILS;
  });
  afterAll(() => uninstallFirestore());

  const leadByEmail = async (email: string) =>
    (await db.reengagement.listLeadsByEmail(email))[0] ?? null;
  const replyCount = async (id: string) =>
    (await db.reengagement.listActivities(id)).filter((a) => a.type === 'reply').length;

  it('first run initializes the cursor and processes nothing', async () => {
    // Even if the fetcher would return old mail, first run must not sweep it.
    const fetchMessages = async () => [msg(LEAD_EMAIL, 'ancient', '2000-01-01T00:00:00Z')];
    const res = await pollInbox({ fetchMessages, now: () => new Date('2026-07-06T12:00:00Z') });
    expect(res).toEqual({ checked: 0, replied: 0, newLeads: 0 });

    expect(await db.state.get(CURSOR_KEY)).toBe('2026-07-06T12:00:00.000Z');
    expect((await db.reengagement.findLeadById(leadId))!.status).toBe('contacted'); // untouched
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
    expect((await db.reengagement.findLeadById(leadId))!.status).toBe('replied');
    const replyActs = (await db.reengagement.listActivities(leadId)).filter((a) => a.type === 'reply');
    expect(replyActs).toHaveLength(1);
    expect(replyActs[0].detail).toContain('Re: your consult');

    // Intake: new lead created from the clean sender + automated first response.
    const created = await leadByEmail(NEW_SENDER);
    expect(created).not.toBeNull();
    expect(created!.source).toBe('outlook');
    expect(created!.status).toBe('contacted'); // welcome sent
    expect(created!.sequence_state.sent).toContain('welcome');

    // Guards: no lead created for the no-reply or auto-reply senders.
    for (const skipped of [NOREPLY, OOO]) {
      expect(await leadByEmail(skipped), skipped).toBeNull();
    }

    expect(await db.state.get(CURSOR_KEY)).toBe('2026-07-06T13:50:00Z'); // max received in the batch
  });

  it('polls multiple mailboxes with independent cursors and a shared self-guard', async () => {
    const BOX1 = 'hello@innerlumehealing.com';
    const BOX2 = 'nicole@innerlumehealing.com';
    const c1 = `${CURSOR_KEY}:${BOX1.toLowerCase()}`;
    const c2 = `${CURSOR_KEY}:${BOX2.toLowerCase()}`;
    const STRANGER = 'multi-stranger-it@example.test';
    await db.state.delete(c1);
    await db.state.delete(c2);

    // First run per mailbox: initialize both cursors, sweep nothing.
    const init = await pollInbox({
      mailboxes: [BOX1, BOX2],
      fetchMessages: async () => [msg(STRANGER, 'old', '2000-01-01T00:00:00Z')],
      now: () => new Date('2026-07-08T09:00:00Z'),
    });
    expect(init).toEqual({ checked: 0, replied: 0, newLeads: 0 });
    for (const k of [c1, c2]) {
      expect(await db.state.get(k)).toBe('2026-07-08T09:00:00.000Z');
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

    expect(await db.reengagement.listLeadsByEmail(STRANGER)).toHaveLength(1);
    expect(await leadByEmail(BOX2), 'our own mailbox must never become a lead').toBeNull();

    // Cursors advanced independently to each inbox's high-water mark.
    expect(await db.state.get(c1)).toBe('2026-07-08T10:05:00Z');
    expect(await db.state.get(c2)).toBe('2026-07-08T11:00:00Z');

    for (const lead of await db.reengagement.listLeadsByEmail(STRANGER)) {
      await db.reengagement.deleteLead(lead.id);
    }
    await db.state.delete(c1);
    await db.state.delete(c2);
  });

  it('is idempotent — re-delivered mail from settled leads does nothing', async () => {
    const fetchMessages = async () => [
      msg(LEAD_EMAIL, 'Re: your consult again', '2026-07-06T14:00:00Z'), // already replied → no-op
      msg(NEW_SENDER, 'following up', '2026-07-06T14:10:00Z'), // now an active lead → reply, not a 2nd welcome
    ];
    const res = await pollInbox({ fetchMessages });
    expect(res.newLeads).toBe(0); // no duplicate lead / welcome
    // The re-contacting new sender is now an active lead -> treated as a reply.
    expect(await replyCount((await leadByEmail(NEW_SENDER))!.id)).toBe(1);
    // The already-replied original lead gets no duplicate reply activity.
    expect(await replyCount(leadId)).toBe(1);
  });
});
