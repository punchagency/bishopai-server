// WF3 cadence rules — pure decision logic (unit-tested), separate from the DB
// pass in runner.ts. Given a lead's state and the current time, decide the next
// automated action: send a specific step, deactivate, or do nothing. Replies and
// bookings stop the automation (build plan §5.3/§5.4).

export interface LeadState {
  status: string; // new | contacted | nurturing | booked | cancelled | replied | closed
  created_at: Date;
  last_touch: Date | null;
  sentSteps: string[]; // cadence steps already sent (from leads.sequence_state.sent)
  hasUpcomingBooking?: boolean;
}

export interface CadenceStep {
  step: string;
  afterDays: number; // send once the lead is at least this old (since created_at)
  subject: string;
  body: string;
}

export type CadenceAction =
  | { kind: 'send'; step: string; subject: string; body: string }
  | { kind: 'deactivate' }
  | { kind: 'none' };

// Deactivate a cold lead after 5 months of no engagement.
export const DEACTIVATE_AFTER_DAYS = 150;

// Inquiry track: someone reached out / opened the intake but hasn't booked.
const INQUIRY_STEPS: CadenceStep[] = [
  {
    step: 'welcome',
    afterDays: 0,
    subject: 'Thanks for reaching out to Innerlume',
    body: "Hi! Thanks for your interest in working together. When you're ready, you can book a consult here — I'd love to help.",
  },
  {
    step: 'nudge_3d',
    afterDays: 3,
    subject: 'Still here when you’re ready',
    body: 'Just checking in — happy to answer any questions before you book your first session.',
  },
  {
    step: 'nudge_7d',
    afterDays: 7,
    subject: 'A gentle nudge from Innerlume',
    body: 'No rush at all. If now’s a good time, here’s the link to book a consult whenever it suits you.',
  },
  {
    step: 'final_14d',
    afterDays: 14,
    subject: 'Last note for now',
    body: "I'll leave the door open — reach out any time and we'll find a time that works.",
  },
];

// Cancelled track: a booking was cancelled (fed by the PB cancelled webhook).
const CANCELLED_STEPS: CadenceStep[] = [
  {
    step: 'cancelled_7d',
    afterDays: 7,
    subject: 'Want to reschedule?',
    body: 'Sorry we missed each other — would you like to find a new time that works better?',
  },
  {
    step: 'cancelled_14d',
    afterDays: 14,
    subject: 'Still happy to reschedule',
    body: 'The offer stands whenever you’re ready — just reply and we’ll get you booked.',
  },
];

/** The step sequence a lead is on, by status. */
export function trackFor(status: string): CadenceStep[] {
  return status === 'cancelled' ? CANCELLED_STEPS : INQUIRY_STEPS;
}

const STOP_STATUSES = new Set(['booked', 'replied', 'closed']);

const dayspan = (from: Date, to: Date) => (to.getTime() - from.getTime()) / 86_400_000;

/**
 * Decide the next cadence action for a lead. The first not-yet-sent step whose
 * threshold has passed is due; if none are due and the lead has gone cold past
 * the deactivation window, deactivate; otherwise nothing.
 */
export function nextCadenceAction(lead: LeadState, now: Date = new Date()): CadenceAction {
  // Replies/bookings stop automation; booked-ahead leads are left alone.
  if (STOP_STATUSES.has(lead.status) || lead.hasUpcomingBooking) return { kind: 'none' };

  const ageDays = dayspan(lead.created_at, now);
  const track = trackFor(lead.status);
  const sent = new Set(lead.sentSteps);

  for (const step of track) {
    if (!sent.has(step.step) && ageDays >= step.afterDays) {
      return { kind: 'send', step: step.step, subject: step.subject, body: step.body };
    }
  }

  // Nothing left to send. If the lead has gone cold, close it out.
  const lastTouch = lead.last_touch ?? lead.created_at;
  if (dayspan(lastTouch, now) >= DEACTIVATE_AFTER_DAYS) return { kind: 'deactivate' };

  return { kind: 'none' };
}
