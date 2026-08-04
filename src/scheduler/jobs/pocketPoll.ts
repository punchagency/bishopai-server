import type { Job } from '../types';
import { logEvent } from '../../observability/logger';
import { pollPocketRecordings } from '../../integrations/pocket/poller';

// Pocket polling backstop. The webhook is the fast path; this sweep catches
// anything that never arrived — a delivery that exhausted Pocket's 3 retries
// while we were down, or a deployment where no webhook destination was ever
// configured. No-op until POCKET_API_KEY is set.
export const pocketPollJob: Job = {
  name: 'pocket.poll',
  schedule: process.env.CRON_POCKET_POLL ?? '*/10 * * * *', // every 10 min
  async run() {
    const result = await pollPocketRecordings();
    if (result.skipped) return; // not configured / disabled — stay quiet
    logEvent('info', 'scheduler.pocket', 'pocket poll tick', { ...result });
  },
};
