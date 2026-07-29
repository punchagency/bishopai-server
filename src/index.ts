import { onRequest } from 'firebase-functions/v2/https';
import { onSchedule } from 'firebase-functions/v2/scheduler';
import { createApp } from './app.js';
import { projectRefills } from './refills/project.js';
import { runReengagement } from './reengagement/runner.js';

const app = createApp();

// Export Cloud Function HTTP handler serving Express app
export const api = onRequest({ cors: true }, app);

// Export scheduled triggers for nightly background jobs
export const refillProjectionScheduler = onSchedule('every 24 hours', async () => {
  console.log('[Scheduler] Running nightly refill projections...');
  await projectRefills();
});

export const reengagementCadenceScheduler = onSchedule('every 24 hours', async () => {
  console.log('[Scheduler] Running re-engagement cadence...');
  await runReengagement();
});
