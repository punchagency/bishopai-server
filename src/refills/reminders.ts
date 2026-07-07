// WF4 client-facing refill reminder cadence (pure). Decides, for a projected
// refill, whether to send the client a tiered reminder, a follow-up, or to
// auto-close it after the client never acted. Mirrors WF3's cadence shape:
// pure decision here, DB/send in the runner.

export const SOON_DAYS = 14; // first reminder fires when the refill is due within this window
export const FOLLOWUP_DAYS = 7; // gap before the follow-up, and before auto-close

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
}

function daysUntil(fromISO: string, toISO: string): number {
  const a = Date.parse(`${fromISO}T00:00:00Z`);
  const b = Date.parse(`${toISO}T00:00:00Z`);
  return Math.round((b - a) / 86_400_000);
}

/**
 * Next cadence step for a refill as of `today` (yyyy-mm-dd). Only `pending`
 * refills get reminders — once Nicole notifies/snoozes/closes, or the client
 * orders, the cadence stops. Stage 0 → first reminder inside the SOON window;
 * stage 1 → follow-up after FOLLOWUP_DAYS; stage 2 → auto-close after another.
 */
export function nextReminderAction(r: ReminderState, today: string): ReminderAction {
  if (r.status !== 'pending' || !r.due_date) return { kind: 'none' };
  const daysLeft = daysUntil(today, r.due_date);
  const tier: RefillTier = daysLeft < 0 ? 'overdue' : 'soon';
  const due = (at: string | null) => at != null && today >= at;

  if (r.reminder_stage === 0) {
    return daysLeft <= SOON_DAYS ? { kind: 'send', stage: 1, tier } : { kind: 'none' };
  }
  if (r.reminder_stage === 1) {
    return due(r.reminder_next_at) ? { kind: 'send', stage: 2, tier } : { kind: 'none' };
  }
  // stage >= 2: after the final window with still no action, auto-close.
  return due(r.reminder_next_at) ? { kind: 'close' } : { kind: 'none' };
}

/** Tiered client-facing reminder copy. */
export function reminderMessage(
  clientName: string,
  supplementName: string,
  tier: RefillTier,
  stage: 1 | 2,
): { subject: string; body: string } {
  const first = clientName.split(' ')[0] || 'there';
  if (tier === 'overdue') {
    return {
      subject: `Your ${supplementName} refill is overdue`,
      body: `Hi ${first},\n\nOur records show your ${supplementName} has run out. Let's get you restocked so you don't miss any days — reply here or use your Fullscript link to reorder.\n\nWarmly,\nNicole`,
    };
  }
  const nudge = stage === 2 ? ' Just a gentle follow-up on this.' : '';
  return {
    subject: `Your ${supplementName} refill is coming up`,
    body: `Hi ${first},\n\nYour ${supplementName} is due to run out soon.${nudge} We can send a refill through Fullscript whenever you're ready — just reply and we'll take care of it.\n\nWarmly,\nNicole`,
  };
}
