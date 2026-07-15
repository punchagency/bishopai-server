import type { Job } from '../types';
import { logEvent } from '../../observability/logger';
import { syncSessionsFromPb } from '../../appointments/pbSync';

// WF1/2/3 — PB sessions poll. Substitutes for PB's session/booking webhooks
// while the backend isn't publicly reachable (see appointments/pbSync.ts).
// Every 5 min: well inside PB's 5 req/s (this does 1 request per run, up to 5
// only if a window has 100+ sessions) and 10k/day quota (288 runs/day worst
// case ~1,440 requests — under 15% of quota).
export const sessionsPollJob: Job = {
  name: 'wf1.sessions_poll',
  schedule: process.env.CRON_SESSIONS_POLL ?? '*/5 * * * *',
  async run() {
    const r = await syncSessionsFromPb();
    if (r.upserted > 0 || r.checkoutsDetected > 0 || r.cancellationsEnrolled > 0) {
      logEvent('info', 'scheduler.wf1', 'sessions poll tick', { ...r });
    }
  },
};
