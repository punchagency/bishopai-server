import cron, { type ScheduledTask } from 'node-cron';
import { logError, logEvent } from '../observability/logger';
import type { Job } from './types';
import { reengagementJob } from './jobs/reengagement';
import { refillsJob } from './jobs/refills';

// In-process scheduler for the WF3/WF4 cadences (§14). Opt-in via
// SCHEDULER_ENABLED=true so dev/tests don't run background jobs. Each tick is
// wrapped so one failing job never takes down the timer or the process.
const jobs: Job[] = [reengagementJob, refillsJob];
let tasks: ScheduledTask[] = [];

export function startScheduler(): void {
  if (process.env.SCHEDULER_ENABLED !== 'true') {
    console.log('Scheduler disabled (set SCHEDULER_ENABLED=true to run WF3/WF4 cadences)');
    return;
  }
  for (const job of jobs) {
    if (!cron.validate(job.schedule)) {
      logError('scheduler', 'invalid cron expression; job skipped', undefined, {
        job: job.name,
        schedule: job.schedule,
      });
      continue;
    }
    tasks.push(cron.schedule(job.schedule, () => void runJob(job)));
    logEvent('info', 'scheduler', 'job scheduled', { job: job.name, schedule: job.schedule });
  }
  console.log(`Scheduler started: ${tasks.length} job(s)`);
}

async function runJob(job: Job): Promise<void> {
  try {
    await job.run();
  } catch (err) {
    logError('scheduler', 'job failed', err, { job: job.name });
  }
}

/** Stop all scheduled jobs — call during graceful shutdown. */
export function stopScheduler(): void {
  for (const t of tasks) t.stop();
  tasks = [];
}
