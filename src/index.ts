import { onRequest } from 'firebase-functions/v2/https';
import { onSchedule } from 'firebase-functions/v2/scheduler';
import { createApp } from './app.js';
import { jobs, runJob } from './scheduler/index.js';

/**
 * Cloud Functions entrypoint. `package.json` "main" must point at this file's
 * build output (dist/index.js) — Functions loads `main` to discover exports.
 * Pointing it at dist/server.js instead would boot the long-running Express
 * listener inside a function container and export no handlers at all.
 *
 * `server.ts` remains the entrypoint for local/long-running deployments.
 */

const app = createApp();

// The whole Express API behind one function; Hosting rewrites `**` to it, so
// route paths are unchanged and the Electron client needs no edits.
export const api = onRequest({ cors: true }, app);

/**
 * Scheduled triggers, derived from the SAME job list the in-process node-cron
 * scheduler uses (`src/scheduler/index.ts`).
 *
 * Deriving them matters: this file previously hand-wrote two triggers while the
 * scheduler defined eleven jobs, so nine cadences — inbox polling, extraction,
 * reconciliation, refill reminders, the morning brief, booking reconcile — would
 * simply never have run once compute moved to Functions. One source of truth
 * makes that class of omission impossible.
 *
 * Each job's `schedule` is a unix-cron expression, which Cloud Scheduler accepts
 * directly, so the cadences are identical to the node-cron ones.
 *
 * NOTE: a scheduled trigger can fire more than once for a single tick, so every
 * job must be idempotent. `runJob` also swallows and logs failures, so one bad
 * job never fails the others.
 */
const exportedJobs: Record<string, ReturnType<typeof onSchedule>> = {};
for (const job of jobs) {
  // Export names must be valid identifiers; job names are dotted (`wf4.refills`).
  const exportName = `job_${job.name.replace(/[^a-zA-Z0-9]/g, '_')}`;
  exportedJobs[exportName] = onSchedule(
    { schedule: job.schedule, timeZone: process.env.SCHEDULER_TZ ?? 'America/New_York' },
    async () => {
      await runJob(job);
    },
  );
}

export const {
  job_wf3_reengagement,
  job_wf4_refills,
  job_wf3_maintenance,
  job_wf3_first_appointment,
  job_wf3_inbox_poller,
  job_wf2_reconcile,
  job_wf4_refill_reminders,
  job_wf3_booking_reconcile,
  job_brief_morning_digest,
  job_wf1_sessions_poll,
  job_wf1_extraction,
} = exportedJobs;
