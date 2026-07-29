// WF4 client-facing refill reminder cadence (pure). Decides, for a projected
// refill, whether to send the client a tiered reminder, a follow-up, or to
// auto-close it after the client never acted. Mirrors WF3's cadence shape:
// pure decision here, DB/send in the runner.
//
// The cadence is DOSE-AWARE. A fixed 14-day heads-up is wrong at both ends of
// the dosing range: on a 90-day bottle it is a fine warning, but on a 20-day
// bottle taken 4/day it lands while the client is barely a week in, and the
// 7-day follow-up gap can fall after they have already run out. Lead time and
// follow-up gap are therefore scaled to the supply the dose actually buys.

export const SOON_DAYS = 14; // maximum lead time, and the default when supply is unknown
export const MIN_LEAD_DAYS = 5; // never warn less than this far ahead
export const FOLLOWUP_DAYS = 7; // maximum gap before the follow-up / auto-close
export const MIN_FOLLOWUP_DAYS = 3;

export type RefillTier = 'overdue' | 'soon';

export type ReminderAction =
  | { kind: 'none' }
  | { kind: 'send'; stage: 1 | 2; tier: RefillTier }
  | { kind: 'close' };

export interface ReminderState {
  status: string; // refills.status
  due_date: string | null; // yyyy-mm-dd
  reminder_stage: number;
  reminder_next_at: string | null; // yyyy-mm-dd
  /** Whole days the bottle lasts at the stated dose (from computeRunOut). */
  days_supply?: number | null;
  /** Set once Nicole cancels this refill's reminders — the cadence stops. */
  reminders_cancelled_at?: string | Date | null;
}

function daysUntil(fromISO: string, toISO: string): number {
  const a = Date.parse(`${fromISO}T00:00:00Z`);
  const b = Date.parse(`${toISO}T00:00:00Z`);
  return Math.round((b - a) / 86_400_000);
}

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

/**
 * How many days before run-out the first reminder fires, given the days of
 * supply the dose buys. Roughly a third of the supply, capped at SOON_DAYS and
 * floored at MIN_LEAD_DAYS — so a 90-day bottle still gets the full two weeks'
 * notice, while a 15-day bottle gets 5 days rather than a warning sent almost
 * the moment it was dispensed. Unknown supply falls back to SOON_DAYS.
 */
export function reminderLeadDays(daysSupply: number | null | undefined): number {
  if (daysSupply == null || !Number.isFinite(daysSupply) || daysSupply <= 0) return SOON_DAYS;
  return clamp(Math.ceil(daysSupply / 3), MIN_LEAD_DAYS, SOON_DAYS);
}

/**
 * Gap between the first reminder and the follow-up (and between the follow-up
 * and auto-close). Half the lead time, so a fast-burning supply gets chased
 * before it runs out instead of a week later.
 */
export function followUpDays(daysSupply: number | null | undefined): number {
  return clamp(Math.round(reminderLeadDays(daysSupply) / 2), MIN_FOLLOWUP_DAYS, FOLLOWUP_DAYS);
}

/**
 * Next cadence step for a refill as of `today` (yyyy-mm-dd). Only `pending`
 * refills whose reminders Nicole hasn't cancelled get them — once she
 * notifies/snoozes/closes/cancels, or the client orders, the cadence stops.
 * Stage 0 → first reminder inside the dose-scaled lead window; stage 1 →
 * follow-up after the gap; stage 2 → auto-close after another.
 */
export function nextReminderAction(r: ReminderState, today: string): ReminderAction {
  if (r.status !== 'pending' || !r.due_date) return { kind: 'none' };
  if (r.reminders_cancelled_at) return { kind: 'none' };
  const daysLeft = daysUntil(today, r.due_date);
  const tier: RefillTier = daysLeft < 0 ? 'overdue' : 'soon';
  const due = (at: string | null) => at != null && today >= at;

  if (r.reminder_stage === 0) {
    return daysLeft <= reminderLeadDays(r.days_supply) ? { kind: 'send', stage: 1, tier } : { kind: 'none' };
  }
  if (r.reminder_stage === 1) {
    return due(r.reminder_next_at) ? { kind: 'send', stage: 2, tier } : { kind: 'none' };
  }
  // stage >= 2: after the final window with still no action, auto-close.
  return due(r.reminder_next_at) ? { kind: 'close' } : { kind: 'none' };
}

/** What the client is actually taking — carried into the reminder copy. */
export interface DoseContext {
  /** The dose as Nicole wrote it ("2 caps twice daily"). */
  dose?: string | null;
  /** Units per day, from the schedule grid or the dose text. */
  perDay?: number | null;
  /** Days until run-out as of the send (negative = already out). */
  daysLeft?: number | null;
}

/** "2 caps twice daily (about 4 a day)" — omits whatever we don't know. */
function dosePhrase(d: DoseContext | undefined): string {
  const dose = d?.dose?.trim();
  const perDay = d?.perDay && d.perDay > 0 ? d.perDay : null;
  if (dose && perDay) {
    const units = perDay === 1 ? '1 a day' : `${round1(perDay)} a day`;
    return ` (${dose} — about ${units})`;
  }
  if (dose) return ` (${dose})`;
  if (perDay) return ` (about ${perDay === 1 ? '1 a day' : `${round1(perDay)} a day`})`;
  return '';
}

const round1 = (n: number) => String(Math.round(n * 10) / 10);

/** "in about 5 days" / "in about a week" — only when we have a day count. */
function timingPhrase(daysLeft: number | null | undefined): string {
  if (daysLeft == null || !Number.isFinite(daysLeft) || daysLeft < 0) return '';
  if (daysLeft === 0) return ' — by our count that is today';
  if (daysLeft === 1) return ' — by our count that is tomorrow';
  return ` — by our count that is about ${daysLeft} days from now`;
}

/**
 * Tiered client-facing reminder copy. The dose is stated back to the client
 * because it is what makes the timing credible ("2 caps twice daily" is why the
 * bottle is empty in 30 days) and because a client who has since changed how
 * much they take can correct us by replying.
 */
export function reminderMessage(
  clientName: string,
  supplementName: string,
  tier: RefillTier,
  stage: 1 | 2,
  dose?: DoseContext,
): { subject: string; body: string } {
  const first = clientName.split(' ')[0] || 'there';
  const taking = dosePhrase(dose);
  if (tier === 'overdue') {
    return {
      subject: `Your ${supplementName} refill is overdue`,
      body: `Hi ${first},\n\nOur records show your ${supplementName}${taking} has run out. Let's get you restocked so you don't miss any days — reply here or use your Fullscript link to reorder.\n\nIf you've been taking a different amount than the above, just let me know and I'll update your protocol.\n\nWarmly,\nNicole`,
    };
  }
  const nudge = stage === 2 ? ' Just a gentle follow-up on this.' : '';
  return {
    subject: `Your ${supplementName} refill is coming up`,
    body: `Hi ${first},\n\nYour ${supplementName}${taking} is due to run out soon${timingPhrase(dose?.daysLeft)}.${nudge} We can send a refill through Fullscript whenever you're ready — just reply and we'll take care of it.\n\nIf you've been taking a different amount than the above, just let me know and I'll update your protocol.\n\nWarmly,\nNicole`,
  };
}
