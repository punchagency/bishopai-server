import { pool } from '../db/pool';
import { logEvent, logError } from '../observability/logger';
import { sendEmail } from '../integrations/outlook';
import { computeRunOut, type DoseSchedule } from './project';
import { nextReminderAction, reminderMessage, followUpDays, type ReminderState } from './reminders';

// Daily WF4 pass: for each projected refill, send the client a tiered reminder,
// a follow-up, or auto-close it after the client never acted. Sends go to the
// CLIENT (via Outlook, dry-run until Graph is configured) — distinct from the
// supplier push to Fullscript. Idempotent: cadence state on the refill row means
// re-running the same day is a no-op.
//
// Everything about the timing derives from the dose: how far ahead the first
// reminder fires and how long we wait before chasing it both scale with the
// days of supply the dose buys (see reminders.ts).

export interface ReminderRunResult {
  scanned: number;
  sent: number;
  closed: number;
  skipped: number;
}

type ReminderRow = ReminderState & {
  id: string;
  client_name: string | null;
  email: string | null;
  supplement_name: string | null;
  dose: string | null;
  qty: number | null;
  start_date: string | null;
  schedule: DoseSchedule | null;
};

/** The columns the cadence needs, shared with the upcoming-reminders listing. */
export const REMINDER_SELECT = `rf.id, rf.status, to_char(rf.due_date, 'YYYY-MM-DD') AS due_date,
            rf.reminder_stage, to_char(rf.reminder_next_at, 'YYYY-MM-DD') AS reminder_next_at,
            rf.reminders_cancelled_at,
            c.name AS client_name, c.email,
            s.name AS supplement_name, s.dose, s.qty,
            to_char(s.start_date, 'YYYY-MM-DD') AS start_date, s.schedule`;

export const REMINDER_FROM = `FROM refills rf
       JOIN clients c ON c.id = rf.client_id
  LEFT JOIN supplements s ON s.id = rf.supplement_id`;

export async function runRefillReminders(today = new Date().toISOString().slice(0, 10)): Promise<ReminderRunResult> {
  const { rows } = await pool.query<ReminderRow>(
    `SELECT ${REMINDER_SELECT}
       ${REMINDER_FROM}
      WHERE rf.status = 'pending' AND rf.due_date IS NOT NULL
        AND rf.reminders_cancelled_at IS NULL`,
  );

  const result: ReminderRunResult = { scanned: rows.length, sent: 0, closed: 0, skipped: 0 };

  for (const r of rows) {
    // Dose drives the cadence: days of supply sets the lead time and the gap.
    const { perDay, daysSupply } = computeRunOut(r);
    const action = nextReminderAction({ ...r, days_supply: daysSupply }, today);
    if (action.kind === 'none') {
      result.skipped++;
      continue;
    }
    try {
      if (action.kind === 'close') {
        await pool.query(`UPDATE refills SET status = 'closed' WHERE id = $1 AND status = 'pending'`, [r.id]);
        logEvent('info', 'refills.reminders', 'auto-closed refill after final reminder', { refill_id: r.id });
        result.closed++;
        continue;
      }

      // action.kind === 'send' — needs a client email to reach.
      if (!r.email) {
        result.skipped++;
        continue;
      }
      const daysLeft = r.due_date ? Math.round((Date.parse(`${r.due_date}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86_400_000) : null;
      const msg = reminderMessage(r.client_name ?? 'there', r.supplement_name ?? 'supplement', action.tier, action.stage, {
        dose: r.dose,
        perDay,
        daysLeft,
      });
      await sendEmail({ to: r.email, subject: msg.subject, body: msg.body });
      const next = new Date(`${today}T00:00:00Z`);
      next.setUTCDate(next.getUTCDate() + followUpDays(daysSupply));
      await pool.query(
        `UPDATE refills SET reminder_stage = $2, reminded_at = now(), reminder_next_at = $3 WHERE id = $1 AND status = 'pending'`,
        [r.id, action.stage, next.toISOString().slice(0, 10)],
      );
      result.sent++;
    } catch (err) {
      logError('refills.reminders', 'reminder step failed', err, { refill_id: r.id });
      result.skipped++;
    }
  }

  logEvent('info', 'refills.reminders', 'refill reminder pass complete', { ...result });
  return result;
}
