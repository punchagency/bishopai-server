import { fetchInboxMessages, getOutlookConnection, type InboundMessage } from '../integrations/outlook';
import { getState, setState } from '../db/state';
import { randomUUID } from 'node:crypto';
import { getDatabase } from '../db/index.js';
import { logEvent, logError } from '../observability/logger';
import { ingestLead } from './intake';
import { runReengagementForLead } from './runner';
import { intakeSkipReason } from './inboxGuards';

// WF3 inbox poller — reads Nicole's Outlook inbox via Graph and, per sender:
//   • an active lead replied → mark `replied` (stop the cadence) + record a
//     `reply` activity so it surfaces to Nicole;
//   • an unknown sender (no lead, or only closed) → create a lead and send the
//     automated first response — subject to spam/loop guards (inboxGuards.ts);
//   • a booked/recently-replied sender → leave alone (known, don't re-welcome).
//
// Cursor-based (integration_state key `outlook.inbox.cursor`). First run does NOT
// sweep mailbox history: it initializes the cursor to "now" and only acts on mail
// arriving afterwards (an ascending fetch would otherwise start from the oldest
// message and re-engage ancient threads).

const CURSOR_KEY = 'outlook.inbox.cursor';
const STOP_STATUSES = new Set(['closed', 'booked', 'replied']); // not an active cadence

export interface InboxPollResult {
  checked: number;
  replied: number;
  newLeads: number;
}

export interface PollInboxOptions {
  /** Injectable for tests; defaults to the real Graph fetch. `mailbox` names the inbox. */
  fetchMessages?: (sinceIso: string | null, mailbox?: string) => Promise<InboundMessage[]>;
  /** Injectable clock for tests. */
  now?: () => Date;
  /** Override the mailbox list (tests); defaults to every connected account. */
  mailboxes?: string[];
}

export async function pollInbox(opts: PollInboxOptions = {}): Promise<InboxPollResult> {
  const fetchMessages = opts.fetchMessages ?? fetchInboxMessages;
  const now = opts.now ?? (() => new Date());
  const empty: InboxPollResult = { checked: 0, replied: 0, newLeads: 0 };

  // Which mailboxes to poll, and each one's OWN cursor key. With connected OAuth
  // accounts we read every inbox; the single-mailbox fallback keeps the original
  // cursor key (and is the shape the injected-fetcher tests exercise).
  let boxes: { sender: string; cursorKey: string }[];
  if (opts.mailboxes) {
    boxes = opts.mailboxes.map((s) => ({ sender: s, cursorKey: `${CURSOR_KEY}:${s.toLowerCase()}` }));
  } else {
    const conn = await getOutlookConnection().catch(() => null);
    if (conn && conn.accounts.length > 0) {
      boxes = conn.accounts.map((a) => ({ sender: a.sender, cursorKey: `${CURSOR_KEY}:${a.sender.toLowerCase()}` }));
    } else {
      boxes = [{ sender: process.env.MS_GRAPH_SENDER ?? conn?.sender ?? '', cursorKey: CURSOR_KEY }];
    }
  }

  // All our own addresses back the self-loop guard (never re-ingest our sends).
  const selves = new Set(boxes.map((b) => b.sender.toLowerCase()).filter(Boolean));

  // Fetch each mailbox against its own cursor; first run initializes without
  // sweeping history. Collect all new mail; remember each cursor's new high-water.
  const collected: InboundMessage[] = [];
  const cursorUpdates: { key: string; value: string }[] = [];
  for (const box of boxes) {
    let cursor: string | null;
    try {
      cursor = await getState(box.cursorKey);
    } catch (err) {
      logError('inbox.poll', 'failed to read cursor', err, { mailbox: box.sender });
      continue;
    }
    if (!cursor) {
      try {
        await setState(box.cursorKey, now().toISOString());
      } catch (err) {
        logError('inbox.poll', 'failed to initialize cursor', err, { mailbox: box.sender });
      }
      continue; // first run: start watching from now, don't crawl history
    }
    let messages: InboundMessage[];
    try {
      messages = await fetchMessages(cursor, box.sender || undefined);
    } catch (err) {
      logError('inbox.poll', 'failed to fetch inbox messages', err, { mailbox: box.sender });
      continue;
    }
    let maxReceived = cursor;
    for (const m of messages) {
      collected.push(m);
      if (m.receivedDateTime > maxReceived) maxReceived = m.receivedDateTime;
    }
    if (maxReceived !== cursor) cursorUpdates.push({ key: box.cursorKey, value: maxReceived });
  }

  if (collected.length === 0) return empty;

  // Most recent message per sender (for the activity/intake detail), merged
  // across all polled inboxes.
  const latestBySender = new Map<string, InboundMessage>();
  for (const m of collected) {
    const key = m.from.toLowerCase();
    const prev = latestBySender.get(key);
    if (!prev || m.receivedDateTime > prev.receivedDateTime) latestBySender.set(key, m);
  }

  let replied = 0;
  let newLeads = 0;
  try {
    const senderEmails = [...latestBySender.keys()];
    // `lower(email) = ANY(...)` becomes one indexed lookup per sender. Addresses
    // are stored lowercased on write, which is what replaces `lower()` — see
    // listLeadsByEmail. Plural on purpose: one address can have several leads
    // over time, and the caller distinguishes an active one from a settled one.
    const db = getDatabase();
    const leadsByEmail = new Map<string, { id: string; status: string }[]>();
    await Promise.all(
      senderEmails.map(async (email) => {
        const leads = await db.reengagement.listLeadsByEmail(email);
        if (leads.length) {
          leadsByEmail.set(
            email,
            leads.map((l) => ({ id: l.id, status: l.status })),
          );
        }
      }),
    );

    for (const [email, msg] of latestBySender) {
      const leads = leadsByEmail.get(email) ?? [];
      const active = leads.filter((l) => !STOP_STATUSES.has(l.status));

      if (active.length > 0) {
        // Reply from an active lead → stop cadence + surface to Nicole.
        for (const lead of active) {
          if (await markReplied(lead.id, msg)) replied++;
        }
      } else if (leads.some((l) => l.status === 'booked' || l.status === 'replied')) {
        // Known and settled/engaged — don't welcome them again.
        continue;
      } else {
        // No lead, or only closed → candidate for a fresh inquiry. Guard first.
        const reason = intakeSkipReason(msg, selves);
        if (reason) {
          logEvent('info', 'inbox.poll', 'skipped inbound (not an inquiry)', { from: email, reason });
          continue;
        }
        try {
          const { leadId, created } = await ingestLead({
            email,
            source: 'outlook',
            detail: msg.subject || undefined,
            activityType: 'inquiry',
          });
          if (created) {
            await runReengagementForLead(leadId); // automated first response now
            newLeads++;
          }
        } catch (err) {
          logError('inbox.poll', 'inbox intake failed', err, { from: email });
        }
      }
    }
  } catch (err) {
    logError('inbox.poll', 'failed to process senders', err);
    return { checked: collected.length, replied, newLeads };
  }

  // Advance each mailbox's cursor. Re-processing on a save failure is harmless:
  // replied leads are excluded from active-match, and intake reuses an existing
  // active lead rather than re-welcoming.
  for (const u of cursorUpdates) {
    try {
      await setState(u.key, u.value);
    } catch (err) {
      logError('inbox.poll', 'failed to save cursor', err, { key: u.key });
    }
  }

  logEvent('info', 'inbox.poll', 'inbox poll complete', {
    checked: collected.length,
    replied,
    newLeads,
    mailboxes: boxes.length,
  });
  return { checked: collected.length, replied, newLeads };
}

/** Mark one active lead replied + record the reply activity, atomically. */
async function markReplied(leadId: string, msg: InboundMessage): Promise<boolean> {
  const detail = `inbox reply: ${msg.subject || '(no subject)'}`.slice(0, 500);
  const now = new Date().toISOString();
  try {
    const lead = await getDatabase().reengagement.markLeadReplied(leadId, {
      id: randomUUID(),
      lead_id: leadId,
      type: 'reply',
      path: null,
      detail,
      occurred_at: now,
      created_at: now,
    });
    if (!lead) return false;
    // `last_touch = now()` rode along with the status change in pg. It is not
    // part of the atomic pair (the cadence only reads it to space sends), so it
    // is written after rather than widening the transaction.
    await getDatabase().reengagement.saveLead({ ...lead, last_touch: now });
    return true;
  } catch (err) {
    logError('inbox.poll', 'failed to mark lead replied', err, { lead_id: leadId });
    return false;
  }
}
