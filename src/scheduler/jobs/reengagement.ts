import type { Job } from '../types';
import { logEvent } from '../../observability/logger';
import { runReengagement } from '../../reengagement/runner';

// WF3 — Lead & Re-engagement cadences. Runs in-process on a cron tick: evaluates
// each lead's sequence state in Postgres (no-booking nudges, cancelled-booking
// reschedule prompts, deactivation of cold leads) and sends via Microsoft Graph
// (Outlook), dry-run until configured. Rules live in src/reengagement/.
export const reengagementJob: Job = {
  name: 'wf3.reengagement',
  schedule: process.env.CRON_REENGAGEMENT ?? '0 * * * *', // hourly
  async run() {
    const { scanned, sent, deactivated, skipped } = await runReengagement();
    logEvent('info', 'scheduler.wf3', 'reengagement tick', { scanned, sent, deactivated, skipped });
  },
};
