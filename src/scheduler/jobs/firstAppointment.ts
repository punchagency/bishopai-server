import type { Job } from '../types';
import { logEvent } from '../../observability/logger';
import { enrollFirstAppointmentClients } from '../../reengagement/firstAppointment';

// WF3 — First-appointment conversion. Daily identification pass: find clients who
// came exactly once and haven't rebooked, and enroll them into the first-appointment
// cadence (mirrors cancelled, with an incentive on the 14-day step). The hourly
// reengagement job then sends the nudges. Disjoint from the maintenance track.
export const firstAppointmentJob: Job = {
  name: 'wf3.first_appointment',
  schedule: process.env.CRON_FIRST_APPT ?? '45 3 * * *', // nightly, 03:45
  async run() {
    const { scanned, enrolled, skipped } = await enrollFirstAppointmentClients();
    logEvent('info', 'scheduler.wf3', 'first-appointment enrollment tick', { scanned, enrolled, skipped });
  },
};
