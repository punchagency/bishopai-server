import type { Job } from '../types';
import { logEvent } from '../../observability/logger';
import { projectRefills } from '../../refills/project';
import { syncProtocolsFromPb } from '../../refills/pbSync';
import { reconcileDispensaryPushes } from '../../integrations/pb/dispensary';

// WF4 — Refill Intelligence. Nightly: sync protocols from PB, project run-out
// dates from the supplements table into `refills.due_date`, then reconcile the
// Fullscript dispensary hand-off — surface any protocol whose Fullscript push
// failed (there's no Fullscript webhook, so polling PB is the only signal).
// All PB-dependent steps are dry-run/no-op until PB is configured.
export const refillsJob: Job = {
  name: 'wf4.refills',
  schedule: process.env.CRON_REFILLS ?? '0 3 * * *', // nightly, 03:00
  async run() {
    await syncProtocolsFromPb();
    const { scanned, projected, skipped } = await projectRefills();
    logEvent('info', 'scheduler.wf4', 'refill projection tick', { scanned, projected, skipped });
    const dispensary = await reconcileDispensaryPushes();
    logEvent('info', 'scheduler.wf4', 'dispensary reconcile tick', {
      scanned: dispensary.scanned,
      failed: dispensary.failed,
    });
  },
};
