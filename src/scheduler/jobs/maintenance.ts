import type { Job } from '../types';
import { logEvent } from '../../observability/logger';
import { enrollMaintenanceClients } from '../../reengagement/maintenance';

// WF3 — Maintenance reactivation. Daily identification pass: find established
// clients past the session-gap threshold with no upcoming booking and enroll
// them into the maintenance cadence. The hourly reengagement job then sends the
// 7d/14d nudges; deactivation at 5 months is handled by the shared cadence.
export const maintenanceJob: Job = {
  name: 'wf3.maintenance',
  schedule: process.env.CRON_MAINTENANCE ?? '30 3 * * *', // nightly, 03:30 (after refills)
  async run() {
    const { scanned, enrolled, skipped } = await enrollMaintenanceClients();
    logEvent('info', 'scheduler.wf3', 'maintenance enrollment tick', { scanned, enrolled, skipped });
  },
};
