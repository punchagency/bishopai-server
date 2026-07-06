import type { Job } from '../types';
import { logEvent } from '../../observability/logger';
import { projectRefills } from '../../refills/project';
import { syncProtocolsFromPb } from '../../refills/pbSync';

// WF4 — Refill Intelligence. Nightly: first sync protocols from PB (dry-run
// until PB is configured), then project run-out dates from the supplements
// table and upsert `refills.due_date` for the dashboard digest.
export const refillsJob: Job = {
  name: 'wf4.refills',
  schedule: process.env.CRON_REFILLS ?? '0 3 * * *', // nightly, 03:00
  async run() {
    await syncProtocolsFromPb();
    const { scanned, projected, skipped } = await projectRefills();
    logEvent('info', 'scheduler.wf4', 'refill projection tick', { scanned, projected, skipped });
  },
};
