// WF3 cadence rules — pure decision logic (unit-tested), separate from the DB
// pass in runner.ts. Given a lead's state and the current time, decide the next
// automated action: send a specific step, deactivate, or do nothing. Replies and
// bookings stop the automation (build plan §5.3/§5.4).
import { pool } from '../db/pool';

export interface LeadState {
  status: string; // new | contacted | nurturing | booked | cancelled | replied | closed
  created_at: Date;
  last_touch: Date | null;
  sentSteps: string[]; // cadence steps already sent (from leads.sequence_state.sent)
  hasUpcomingBooking?: boolean;
  /** Nicole cancelled this lead's remaining cadence from the dashboard. */
  cadenceCancelled?: boolean;
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

// Maintenance track: an established client who's gone quiet (identified by
// session-gap). Mirrors the cancelled cadence's 7/14-day timing, with copy that
// nudges a maintenance booking rather than a reschedule.
const MAINTENANCE_STEPS: CadenceStep[] = [
  {
    step: 'maintenance_7d',
    afterDays: 7,
    subject: 'Time for a check-in?',
    body: "It's been a while since your last visit — a maintenance session can help keep your progress on track. Want to book one?",
  },
  {
    step: 'maintenance_14d',
    afterDays: 14,
    subject: 'Still here when you’re ready',
    body: 'No pressure at all — whenever you’d like a tune-up, just reply and we’ll find a time that works.',
  },
];

// First-appointment track: a client who came once and hasn't rebooked. Mirrors
// the cancelled cadence's 7/14-day timing.
//
// The 14-day step used to offer "15% off your next visit if you book this month".
// A standing discount, mailed automatically to everyone who has not rebooked in a
// fortnight, is a pricing decision — and it was living in a code default where
// nobody had agreed to it. Removed 2026-08-19. If a promotion is wanted it should
// be a deliberate campaign with an end date, not a line in a cadence.
const FIRST_APPOINTMENT_STEPS: CadenceStep[] = [
  {
    step: 'first_appt_7d',
    afterDays: 7,
    subject: 'How are you feeling after your first session?',
    body: "It was great meeting you! Booking your follow-up is the best way to build on what we started — want to find a time?",
  },
  {
    step: 'first_appt_14d',
    afterDays: 14,
    subject: 'Picking up where we left off',
    body: "The work we started builds on itself, and the second visit is where most of that progress happens. Whenever you're ready, just reply and we'll find a time that suits you.",
  },
];

// Statuses that pin a lead to a fixed re-engagement track (not the inquiry
// new→contacted→nurturing progression). Exported so the runner keeps them.
export const FIXED_TRACK_STATUSES = new Set(['cancelled', 'maintenance', 'first_appointment']);

/** The step sequence a lead is on, by status. */
export function trackFor(status: string): CadenceStep[] {
  if (status === 'cancelled') return CANCELLED_STEPS;
  if (status === 'maintenance') return MAINTENANCE_STEPS;
  if (status === 'first_appointment') return FIRST_APPOINTMENT_STEPS;
  return INQUIRY_STEPS;
}

/** The track name string (as stored in email_templates) for a given lead status. */
export function trackNameFor(status: string): string {
  if (status === 'cancelled') return 'cancelled';
  if (status === 'maintenance') return 'maintenance';
  if (status === 'first_appointment') return 'first_appointment';
  return 'inquiry';
}

const STOP_STATUSES = new Set(['booked', 'replied', 'closed']);

const dayspan = (from: Date, to: Date) => (to.getTime() - from.getTime()) / 86_400_000;

/**
 * Decide the next cadence action for a lead. The first not-yet-sent step whose
 * threshold has passed is due; if none are due and the lead has gone cold past
 * the deactivation window, deactivate; otherwise nothing.
 */
export function nextCadenceAction(lead: LeadState, now: Date = new Date()): CadenceAction {
  // Replies/bookings stop automation; booked-ahead leads are left alone; and a
  // cadence Nicole cancelled sends nothing further (not even the deactivation).
  if (STOP_STATUSES.has(lead.status) || lead.hasUpcomingBooking || lead.cadenceCancelled) return { kind: 'none' };

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

/** The next cadence email a lead will get, and the date it goes out. */
export interface ScheduledStep {
  step: string;
  subject: string;
  body: string;
  /** When it sends. A step already past due sends on the next pass — i.e. `now`. */
  sendAt: Date;
}

// ---------------------------------------------------------------------------
// Template resolution — DB overrides win over hardcoded defaults.
// Exported so the templates API route can enumerate all valid (track,step)
// pairs and include effective copy in every response.
// ---------------------------------------------------------------------------

/** Every valid cadence step across all tracks — used to enumerate + validate. */
export const CADENCE_DEFAULTS: Record<string, Record<string, { subject: string; body: string }>> = {};

function buildDefaults(): void {
  const tracks: Record<string, CadenceStep[]> = {
    inquiry: INQUIRY_STEPS,
    cancelled: CANCELLED_STEPS,
    maintenance: MAINTENANCE_STEPS,
    first_appointment: FIRST_APPOINTMENT_STEPS,
  };
  for (const [track, steps] of Object.entries(tracks)) {
    CADENCE_DEFAULTS[track] = {};
    for (const s of steps) {
      CADENCE_DEFAULTS[track][s.step] = { subject: s.subject, body: s.body };
    }
  }
}
buildDefaults();

/**
 * Return the effective subject + body for a (track, step) pair: DB override if
 * Nicole has edited it, otherwise the hardcoded default. Returns null for unknown
 * (track, step) combinations so the caller can validate input.
 */
export async function resolveTemplate(
  track: string,
  step: string,
): Promise<{ subject: string; body: string } | null> {
  const def = CADENCE_DEFAULTS[track]?.[step];
  try {
    const r = await pool.query<{ subject: string; body: string }>(
      `SELECT subject, body FROM email_templates WHERE track = $1 AND step = $2 LIMIT 1`,
      [track, step],
    );
    if (r.rowCount) return r.rows[0];
  } catch {
    // DB error — fall through to default so a send is never silently blocked.
  }
  return def ?? null;
}

/**
 * The next email this lead is queued to receive, without sending anything —
 * the read-only counterpart to nextCadenceAction, so the dashboard can show
 * Nicole what is about to go out and let her stop it first. Returns null when
 * the lead is off the cadence (replied/booked/cancelled) or has exhausted its
 * track.
 */
export function nextScheduledStep(lead: LeadState, now: Date = new Date()): ScheduledStep | null {
  if (STOP_STATUSES.has(lead.status) || lead.hasUpcomingBooking || lead.cadenceCancelled) return null;

  const sent = new Set(lead.sentSteps);
  for (const step of trackFor(lead.status)) {
    if (sent.has(step.step)) continue;
    const at = new Date(lead.created_at.getTime() + step.afterDays * 86_400_000);
    return { step: step.step, subject: step.subject, body: step.body, sendAt: at.getTime() < now.getTime() ? now : at };
  }
  return null;
}
