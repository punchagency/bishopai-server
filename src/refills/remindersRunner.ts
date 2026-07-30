import { getDatabase } from '../db/index.js';
import { logEvent, logError } from '../observability/logger';
import { sendEmail } from '../integrations/outlook';
import { computeRunOut } from './project';
import { loadPendingRefills } from './pendingRefills';
import { nextReminderAction, reminderMessage, followUpDays } from './reminders';

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

export async function runRefillReminders(today = new Date().toISOString().slice(0, 10)): Promise<ReminderRunResult> {
  const db = getDatabase();
  const rows = await loadPendingRefills();

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
        // Guarded on `status = 'pending'`: a human may have acted on this refill
        // since the scan, and auto-close must never overwrite that.
        const current = await db.refills.findById(r.id);
        if (current?.status === 'pending') {
          await db.refills.save({ ...current, status: 'closed', updated_at: new Date().toISOString() });
          logEvent('info', 'refills.reminders', 'auto-closed refill after final reminder', { refill_id: r.id });
          result.closed++;
        } else {
          result.skipped++;
        }
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
      // Same `AND status = 'pending'` guard. Advancing the cadence on a refill
      // a human already closed would re-open a decision they made.
      const current = await db.refills.findById(r.id);
      if (current?.status === 'pending') {
        await db.refills.save({
          ...current,
          reminder_stage: action.stage,
          reminded_at: new Date().toISOString(),
          reminder_next_at: next.toISOString().slice(0, 10),
          updated_at: new Date().toISOString(),
        });
      }
      result.sent++;
    } catch (err) {
      logError('refills.reminders', 'reminder step failed', err, { refill_id: r.id });
      result.skipped++;
    }
  }

  logEvent('info', 'refills.reminders', 'refill reminder pass complete', { ...result });
  return result;
}
