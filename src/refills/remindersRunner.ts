import { pool } from '../db/pool';
import { logEvent, logError } from '../observability/logger';
import { sendEmail } from '../integrations/outlook';
import { nextReminderAction, reminderMessage, FOLLOWUP_DAYS, type ReminderState } from './reminders';

// Daily WF4 pass: for each projected refill, send the client a tiered reminder,
// a follow-up, or auto-close it after the client never acted. Sends go to the
// CLIENT (via Outlook, dry-run until Graph is configured) — distinct from the
// supplier push to Fullscript. Idempotent: cadence state on the refill row means
// re-running the same day is a no-op.

export interface ReminderRunResult {
  scanned: number;
  sent: number;
  closed: number;
  skipped: number;
}

export async function runRefillReminders(today = new Date().toISOString().slice(0, 10)): Promise<ReminderRunResult> {
  const { rows } = await pool.query<
    ReminderState & { id: string; client_name: string | null; email: string | null; supplement_name: string | null }
  >(
    `SELECT rf.id, rf.status, to_char(rf.due_date, 'YYYY-MM-DD') AS due_date,
            rf.reminder_stage, to_char(rf.reminder_next_at, 'YYYY-MM-DD') AS reminder_next_at,
            c.name AS client_name, c.email, s.name AS supplement_name
       FROM refills rf
       JOIN clients c ON c.id = rf.client_id
  LEFT JOIN supplements s ON s.id = rf.supplement_id
      WHERE rf.status = 'pending' AND rf.due_date IS NOT NULL`,
  );

  const result: ReminderRunResult = { scanned: rows.length, sent: 0, closed: 0, skipped: 0 };

  for (const r of rows) {
    const action = nextReminderAction(r, today);
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
      const msg = reminderMessage(r.client_name ?? 'there', r.supplement_name ?? 'supplement', action.tier, action.stage);
      await sendEmail({ to: r.email, subject: msg.subject, body: msg.body });
      const next = new Date(`${today}T00:00:00Z`);
      next.setUTCDate(next.getUTCDate() + FOLLOWUP_DAYS);
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
