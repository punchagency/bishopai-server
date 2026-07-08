import type { InboundMessage } from '../integrations/outlook';

// Guards for inbox-originated lead intake. Auto-creating a lead and emailing a
// welcome to any unknown inbound sender risks mail loops (bounce-backs,
// autoresponders, no-reply senders, newsletters). These pure predicates decide
// whether a message is safe to treat as a genuine new inquiry.

// Local-parts that are clearly machine senders (never a real prospect).
const AUTOMATED_LOCALPARTS =
  /^(no-?reply|do-?not-?reply|donotreply|mailer-daemon|postmaster|bounce|bounces|notifications?|alerts?|automated|auto-confirm|mailer)$/i;

// Subjects that signal an automated message rather than a person reaching out.
const AUTO_SUBJECT =
  /(out of office|automatic reply|auto(?:matic)?[-\s]?response|undeliverable|delivery status notification|mail delivery (?:failed|subsystem)|returned mail|read receipt)/i;

function header(msg: InboundMessage, name: string): string | undefined {
  return msg.headers?.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value;
}

/**
 * Reason to NOT treat this message as a new-lead inquiry, or null if it's safe.
 * `mailbox` is our own address(es) — one string, or the set of all connected
 * mailboxes — so we never welcome ourselves.
 */
export function intakeSkipReason(msg: InboundMessage, mailbox: string | Iterable<string>): string | null {
  const from = msg.from.trim().toLowerCase();
  if (!from || !from.includes('@')) return 'no-sender';
  const selves =
    typeof mailbox === 'string'
      ? new Set([mailbox.trim().toLowerCase()].filter(Boolean))
      : new Set([...mailbox].map((m) => m.trim().toLowerCase()).filter(Boolean));
  if (selves.has(from)) return 'self';

  const localPart = from.split('@')[0];
  if (AUTOMATED_LOCALPARTS.test(localPart)) return 'automated-sender';

  if (AUTO_SUBJECT.test(msg.subject || '')) return 'auto-reply';

  // RFC 3834 / common bulk-mail headers → not a person reaching out.
  const autoSubmitted = header(msg, 'auto-submitted');
  if (autoSubmitted && autoSubmitted.trim().toLowerCase() !== 'no') return 'auto-submitted';
  const precedence = header(msg, 'precedence');
  if (precedence && /\b(bulk|list|junk)\b/i.test(precedence)) return 'bulk';
  if (header(msg, 'list-unsubscribe') || header(msg, 'list-id')) return 'bulk-list';

  return null;
}
