import type { Job } from '../types';
import { logEvent } from '../../observability/logger';
import { projectRefills } from '../../refills/project';

// WF4 — Refill Intelligence. Nightly projection: read each client's supplements
// (dose, qty, start date), compute run-out dates, and upsert `refills.due_date`
// so the dashboard's daily digest can surface who is running low. The digest +
// bulk-send actions live in the /refills routes.
export const refillsJob: Job = {
  name: 'wf4.refills',
  schedule: process.env.CRON_REFILLS ?? '0 3 * * *', // nightly, 03:00
  async run() {
    const { scanned, projected, skipped } = await projectRefills();
    logEvent('info', 'scheduler.wf4', 'refill projection tick', { scanned, projected, skipped });
  },
};
