import type { Job } from '../types';
import { logEvent } from '../../observability/logger';
import { runRefillReminders } from '../../refills/remindersRunner';

// WF4 — client-facing refill reminders. Daily: send tiered "coming up / overdue"
// reminders to clients, a follow-up a week later, then auto-close if they never
// act. Distinct from the nightly projection (which computes run-out dates) and
// from the supplier push to Fullscript.
export const refillRemindersJob: Job = {
  name: 'wf4.refill_reminders',
  schedule: process.env.CRON_REFILL_REMINDERS ?? '15 3 * * *', // daily, just after projection
  async run() {
    const r = await runRefillReminders();
    logEvent('info', 'scheduler.wf4', 'refill reminder tick', { ...r });
  },
};
