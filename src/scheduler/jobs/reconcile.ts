import type { Job } from '../types';
import { logEvent } from '../../observability/logger';
import { processDueReconciliations } from '../../checkout/reconcile';
import { sweepStuckCharges } from '../../checkout/machine';

// WF2 — payment reconciliation + crash recovery. The safety net behind the
// inline attempt: every few minutes, (1) flag any charge stranded in CHARGING by
// a crash mid-flight for manual review (M1), then (2) drive any due
// reconciliation outbox rows (PENDING, FAILED past backoff, or a RECORDING whose
// lease expired) to completion — idempotent, so re-running never double-records.
// Rows that exhaust their retries land in NEEDS_REVIEW.
export const reconcileJob: Job = {
  name: 'wf2.reconcile',
  schedule: process.env.CRON_RECONCILE ?? '*/5 * * * *', // every 5 minutes
  async run() {
    const { flagged } = await sweepStuckCharges();
    if (flagged > 0) logEvent('warn', 'scheduler.wf2', 'stuck charges flagged for review', { flagged });
    const { processed } = await processDueReconciliations();
    if (processed > 0) logEvent('info', 'scheduler.wf2', 'reconciliation tick', { processed });
  },
};
