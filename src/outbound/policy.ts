// Outbound approval policy — pure decisions, no DB, no IO.
//
// The gate this belongs to exists because nothing automated was ever seen by a
// person before it left. Four cadence tracks and the refill reminders called
// sendEmail() the moment a step fell due; the only thing between them and a
// client's inbox was that no mailbox had been connected yet.
//
// Kept pure and separate from queue.ts for the same reason cadence.ts is kept
// apart from runner.ts: these rules decide whether a real person receives a real
// email, and they should be readable and testable without a database.

/** The two lists a review is split into. */
export type OutboundList = 'normal' | 'cancelled';

/** Why an email exists — the grouping inside a list. */
export type OutboundCategory =
  | 'enquiry'
  | 'appointment_lapse'
  | 'dose_lapse'
  | 'protocol'
  | 'cancelled';

export type OutboundState = 'pending' | 'approved' | 'rejected' | 'sent' | 'expired' | 'failed';

/**
 * How fast this email needs a decision.
 *
 * 'urgent' is not "more important" — it is "worth less every hour it waits".
 * The enquiry welcome is the case it exists for: someone has just written in,
 * and a same-day reply is most of its value. It still requires approval; it
 * simply asks for one today rather than at the weekly review.
 */
export type OutboundPriority = 'urgent' | 'normal';

/**
 * How long an approved-but-unsent item stays valid.
 *
 * A cadence step is written for a moment: "just checking in" three days after an
 * enquiry means something, and the same words three weeks later read as an
 * automated system talking to itself. So an unapproved item is dropped rather
 * than delivered late, and the cadence moves on.
 */
export const EXPIRY_DAYS = 7;

/**
 * Urgent items get one day, not seven.
 *
 * The whole claim of the urgent lane is that this email is worth sending today
 * and not much afterwards. Letting it linger a week would contradict that and
 * quietly reintroduce the problem the exemption was protecting against — a
 * welcome arriving days after the enquiry, which reads worse than silence.
 */
export const URGENT_EXPIRY_DAYS = 1;

const DAY_MS = 86_400_000;

export function expiryFor(sendAfter: Date, days = EXPIRY_DAYS): Date {
  return new Date(sendAfter.getTime() + days * DAY_MS);
}

/** How long an item of this priority stays valid. */
export function expiryDaysFor(priority: OutboundPriority): number {
  return priority === 'urgent' ? URGENT_EXPIRY_DAYS : EXPIRY_DAYS;
}

/**
 * Which cadence steps decay fast enough to need a same-day decision.
 *
 * Deliberately a tiny list rather than a per-track rule. Everything here costs
 * Nicole an interruption, so a step earns its place by being worthless late —
 * not by being important. A win-back nudge matters a great deal and is still
 * perfectly good on Friday.
 */
export function priorityForStep(step: string): OutboundPriority {
  return step === 'welcome' ? 'urgent' : 'normal';
}

/**
 * Which list a cadence track is reviewed under.
 *
 * `cancelled` is its own list because winning back someone who cancelled is a
 * different conversation from nudging a prospect, and Nicole asked to see them
 * apart. Everything else — new enquiries, people who came once and never
 * rebooked, clients past the session gap, supplements running out — is the
 * normal list, grouped by category within it.
 */
export function listForTrack(track: string): OutboundList {
  return track === 'cancelled' ? 'cancelled' : 'normal';
}

export function categoryForTrack(track: string): OutboundCategory {
  switch (track) {
    case 'cancelled':
      return 'cancelled';
    case 'maintenance':
    case 'first_appointment':
      return 'appointment_lapse';
    case 'refill':
      return 'dose_lapse';
    case 'protocol':
      return 'protocol';
    default:
      return 'enquiry';
  }
}

export function listForCategory(category: OutboundCategory): OutboundList {
  return category === 'cancelled' ? 'cancelled' : 'normal';
}

/**
 * The identity of a queued email: who receives it, and what generated it.
 *
 * This is what makes the weekly assembly safe to re-run. The assembly pass has
 * no memory of its previous run — it re-derives what is due from the cadence
 * rules — so without a stable key a second pass would queue the same nudge
 * again, and Nicole would approve one and find another waiting.
 *
 * Deliberately does NOT include the subject or body: an item Nicole edited
 * before approving is still the same email to the same person for the same
 * reason, and a re-assembly must not slip a pristine copy in beside it.
 */
export function dedupeKeyFor(toEmail: string, sourceRef: string): string {
  return `${toEmail.trim().toLowerCase()}|${sourceRef}`;
}

/**
 * Only an approved item may be sent, and only once.
 *
 * Written as an explicit predicate rather than an `if` at the call site because
 * this is the single rule the whole feature exists to enforce — everything else
 * here is bookkeeping around it.
 */
export function isSendable(state: OutboundState, now: Date, sendAfter: Date, expiresAt: Date): boolean {
  if (state !== 'approved') return false;
  if (now < sendAfter) return false;
  return now < expiresAt;
}

/** A pending item past its window is dead: never send it, and let the cadence move on. */
export function isExpired(state: OutboundState, now: Date, expiresAt: Date): boolean {
  return (state === 'pending' || state === 'approved') && now >= expiresAt;
}

export interface QueuedEmailInput {
  list?: OutboundList;
  category: OutboundCategory;
  /** Defaults to 'normal'. See OutboundPriority. */
  priority?: OutboundPriority;
  toEmail: string;
  subject: string;
  body: string;
  /** What produced this — 'cadence:<track>:<step>', 'refill:<id>', 'protocol:<sessionId>'. */
  sourceRef: string;
  leadId?: string | null;
  clientId?: string | null;
  sendAfter?: Date;
  expiresAt?: Date;
}

/** Fill in what the caller didn't state, so every queue row is complete and consistent. */
export function normalizeQueueInput(
  input: QueuedEmailInput,
  now: Date,
): Required<Pick<QueuedEmailInput, 'list' | 'priority' | 'sendAfter' | 'expiresAt'>> & {
  dedupeKey: string;
} {
  const sendAfter = input.sendAfter ?? now;
  const priority = input.priority ?? 'normal';
  return {
    list: input.list ?? listForCategory(input.category),
    priority,
    sendAfter,
    // Derived from the priority rather than a fixed week, so an urgent item
    // cannot be queued with a seven-day window by omission.
    expiresAt: input.expiresAt ?? expiryFor(sendAfter, expiryDaysFor(priority)),
    dedupeKey: dedupeKeyFor(input.toEmail, input.sourceRef),
  };
}
