import type { Job } from '../types';
import { logEvent } from '../../observability/logger';
import { reconcileStuckBookings } from '../../reengagement/bookingReconcile';

// Every 15 min: reopen leads left stranded as 'booked' by a crash mid-booking
// (claim succeeded, appointment never recorded). See bookingReconcile.ts.
export const bookingReconcileJob: Job = {
  name: 'wf3.booking_reconcile',
  schedule: process.env.CRON_BOOKING_RECONCILE ?? '*/15 * * * *',
  async run() {
    const { reopened } = await reconcileStuckBookings();
    if (reopened > 0) logEvent('info', 'scheduler.wf3', 'booking reconcile tick', { reopened });
  },
};
