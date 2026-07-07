import type { Job } from '../types';
import { logEvent } from '../../observability/logger';
import { processDueReconciliations } from '../../checkout/reconcile';

// WF2 — payment reconciliation. The safety net behind the inline attempt: every
// few minutes, drive any due reconciliation outbox rows (PENDING, or FAILED and
// past their backoff) to completion — idempotent, so re-running never
// double-records a payment. Rows that exhaust their retries land in NEEDS_REVIEW.
export const reconcileJob: Job = {
  name: 'wf2.reconcile',
  schedule: process.env.CRON_RECONCILE ?? '*/5 * * * *', // every 5 minutes
  async run() {
    const { processed } = await processDueReconciliations();
    if (processed > 0) logEvent('info', 'scheduler.wf2', 'reconciliation tick', { processed });
  },
};
