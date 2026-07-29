import { pool } from '../db/pool';
import { computeRunOut, type DoseSchedule } from '../refills/project';
import { reminderLeadDays, reminderMessage, type RefillTier } from '../refills/reminders';
import { nextScheduledStep, type LeadState } from '../reengagement/cadence';

// Every automated email this system will send a client, before it sends it.
//
// The cadences (WF4 refill reminders, WF3 re-engagement) each hold their own
// state and decide at run time whether today is a send day. That is fine for the
// machine and useless to Nicole: she cannot see what is queued, so she cannot
// stop the reminder that would contradict what she told a client an hour ago.
// This module reads the same state the runners read and answers the read-only
// question instead — what goes out, to whom, and on what date.
//
// It never sends and never mutates. Cancelling is the routes' job.

export type ReminderKind = 'refill' | 'reengagement';

export interface ScheduledReminder {
  /** Stable UI key. The cancel route takes `kind` + `source_id`, not this. */
  id: string;
  kind: ReminderKind;
  /** refills.id or leads.id — what a cancel/restore acts on. */
  source_id: string;
  client_id: string | null;
  client_name: string;
  to_email: string | null;
  subject: string;
  /** Why this is going out — the dose for a refill, the cadence step for a lead. */
  detail: string | null;
  /** Date the send lands, yyyy-mm-dd. Today means "on the next scheduled pass". */
  send_at: string;
  /** Which step of the cadence this send is (1 = first reminder). */
  stage: number;
  /** Set when the cadence would fire but can't — e.g. no email on file. */
  blocked_reason: string | null;
}

const DAY_MS = 86_400_000;
const iso = (d: Date) => d.toISOString().slice(0, 10);
const addDays = (dateISO: string, days: number): string => iso(new Date(Date.parse(`${dateISO}T00:00:00Z`) + days * DAY_MS));
const daysBetween = (fromISO: string, toISO: string): number =>
  Math.round((Date.parse(`${toISO}T00:00:00Z`) - Date.parse(`${fromISO}T00:00:00Z`)) / DAY_MS);

export interface RefillReminderState {
  status: string;
  due_date: string | null;
  reminder_stage: number;
  reminder_next_at: string | null;
  /** Days the bottle lasts at the stated dose — sets the lead time. */
  days_supply?: number | null;
}

/**
 * The date the next reminder email for a refill will actually go out, or null
 * when no further email is coming (the refill is no longer pending, has no
 * projected run-out, or has only the auto-close step left).
 *
 * A date already in the past means the cadence is overdue to fire, which in
 * practice means the next daily pass — so it reports `today`, never a past date
 * Nicole would read as "already sent".
 */
export function nextRefillSendDate(r: RefillReminderState, today: string): string | null {
  if (r.status !== 'pending' || !r.due_date) return null;
  const notBeforeToday = (d: string) => (d < today ? today : d);

  if (r.reminder_stage === 0) {
    // Dose-scaled lead time: the first reminder fires this far before run-out.
    return notBeforeToday(addDays(r.due_date, -reminderLeadDays(r.days_supply)));
  }
  if (r.reminder_stage === 1) {
    return notBeforeToday(r.reminder_next_at ?? today);
  }
  return null; // stage >= 2: what remains is the auto-close, not an email
}

/** "2 caps twice daily · about 4 a day · 30-day supply" — whatever is known. */
export function doseSummary(dose: string | null, perDay: number | null, daysSupply: number | null): string | null {
  const parts: string[] = [];
  if (dose?.trim()) parts.push(dose.trim());
  if (perDay && perDay > 0) parts.push(`about ${Math.round(perDay * 10) / 10} a day`);
  if (daysSupply && daysSupply > 0) parts.push(`${daysSupply}-day supply`);
  return parts.length ? parts.join(' · ') : null;
}

/**
 * Cadence step ids as Nicole should read them. `cancelled_7d` on a row with a
 * Cancel button next to it is actively confusing — it names the track (a
 * cancelled booking), not the state of the reminder.
 */
const STEP_LABELS: Record<string, string> = {
  welcome: 'welcome note',
  nudge_3d: 'day-3 nudge',
  nudge_7d: 'day-7 nudge',
  final_14d: 'day-14 final note',
  cancelled_7d: 'day-7 reschedule nudge',
  cancelled_14d: 'day-14 reschedule nudge',
  maintenance_7d: 'day-7 check-in nudge',
  maintenance_14d: 'day-14 check-in nudge',
  first_appt_7d: 'day-7 post-first-visit note',
  first_appt_14d: 'day-14 return offer',
};

interface RefillRow {
  id: string;
  status: string;
  due_date: string | null;
  reminder_stage: number;
  reminder_next_at: string | null;
  client_id: string | null;
  client_name: string | null;
  email: string | null;
  supplement_name: string | null;
  dose: string | null;
  qty: number | null;
  start_date: string | null;
  schedule: DoseSchedule | null;
}

interface LeadRow {
  id: string;
  email: string | null;
  status: string;
  sequence_state: { sent?: string[] } | null;
  last_touch: string | null;
  created_at: string;
  client_id: string | null;
  client_name: string | null;
}

/**
 * Every client email queued to send within `withinDays`, soonest first.
 * Cadences Nicole has cancelled are excluded — the dashboard offers an in-place
 * undo right after the cancel, and a cancelled reminder should not linger in a
 * list whose whole promise is "this is what will be sent".
 */
export async function listUpcomingReminders(
  today = new Date().toISOString().slice(0, 10),
  withinDays = 30,
): Promise<ScheduledReminder[]> {
  const horizon = addDays(today, withinDays);
  const out: ScheduledReminder[] = [];

  // --- WF4: refill reminders ------------------------------------------------
  const refills = await pool.query<RefillRow>(
    `SELECT rf.id, rf.status, to_char(rf.due_date, 'YYYY-MM-DD') AS due_date,
            rf.reminder_stage, to_char(rf.reminder_next_at, 'YYYY-MM-DD') AS reminder_next_at,
            c.id AS client_id, c.name AS client_name, c.email,
            s.name AS supplement_name, s.dose, s.qty,
            to_char(s.start_date, 'YYYY-MM-DD') AS start_date, s.schedule
       FROM refills rf
       JOIN clients c ON c.id = rf.client_id
  LEFT JOIN supplements s ON s.id = rf.supplement_id
      WHERE rf.status = 'pending' AND rf.due_date IS NOT NULL
        AND rf.reminders_cancelled_at IS NULL`,
  );

  for (const r of refills.rows) {
    const { perDay, daysSupply } = computeRunOut(r);
    const sendAt = nextRefillSendDate({ ...r, days_supply: daysSupply }, today);
    if (!sendAt || sendAt > horizon) continue;

    // Tier is judged at the send date, not today — a refill that runs out before
    // the reminder lands gets the overdue copy, so the preview matches the send.
    const tier: RefillTier = daysBetween(sendAt, r.due_date!) < 0 ? 'overdue' : 'soon';
    const stage = (r.reminder_stage === 0 ? 1 : 2) as 1 | 2;
    const supplement = r.supplement_name ?? 'supplement';
    const { subject } = reminderMessage(r.client_name ?? 'there', supplement, tier, stage, {
      dose: r.dose,
      perDay,
      daysLeft: daysBetween(sendAt, r.due_date!),
    });

    const dose = doseSummary(r.dose, perDay, daysSupply);
    out.push({
      id: `refill:${r.id}`,
      kind: 'refill',
      source_id: r.id,
      client_id: r.client_id,
      client_name: r.client_name ?? 'Unknown client',
      to_email: r.email,
      subject,
      detail: dose ? `${supplement} · ${dose}` : supplement,
      send_at: sendAt,
      stage,
      blocked_reason: r.email ? null : 'no email on file',
    });
  }

  // --- WF3: re-engagement cadence ------------------------------------------
  const leads = await pool.query<LeadRow>(
    // A lead may also exist as a client (they enquired, then booked); the
    // LATERAL keeps that a name lookup — one row per lead even if two client
    // records share the address.
    `SELECT l.id, l.email, l.status, l.sequence_state, l.last_touch, l.created_at,
            c.id AS client_id, c.name AS client_name
       FROM leads l
  LEFT JOIN LATERAL (
         SELECT id, name FROM clients
          WHERE l.email IS NOT NULL AND lower(email) = lower(l.email)
          LIMIT 1
       ) c ON true
      WHERE l.status NOT IN ('closed', 'booked')
        AND l.cadence_cancelled_at IS NULL`,
  );

  const now = new Date(`${today}T00:00:00Z`);
  for (const l of leads.rows) {
    const state: LeadState = {
      status: l.status,
      created_at: new Date(l.created_at),
      last_touch: l.last_touch ? new Date(l.last_touch) : null,
      sentSteps: l.sequence_state?.sent ?? [],
    };
    const step = nextScheduledStep(state, now);
    if (!step) continue;
    const sendAt = iso(step.sendAt);
    if (sendAt > horizon) continue;

    out.push({
      id: `reengagement:${l.id}`,
      kind: 'reengagement',
      source_id: l.id,
      client_id: l.client_id,
      client_name: l.client_name ?? l.email ?? 'Unknown lead',
      to_email: l.email,
      subject: step.subject,
      detail: `Re-engagement · ${STEP_LABELS[step.step] ?? step.step.replace(/_/g, ' ')}`,
      send_at: sendAt,
      stage: (state.sentSteps.length ?? 0) + 1,
      blocked_reason: l.email ? null : 'no email on file',
    });
  }

  // Soonest first. On the same day a refill outranks a re-engagement nudge —
  // one is a client about to run out of something they were prescribed, the
  // other is marketing, and only the top of this list fits on the dashboard.
  const rank = (k: ReminderKind) => (k === 'refill' ? 0 : 1);
  return out.sort(
    (a, b) =>
      a.send_at.localeCompare(b.send_at) || rank(a.kind) - rank(b.kind) || a.client_name.localeCompare(b.client_name),
  );
}
