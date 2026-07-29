import type { Job } from '../types';
import { logEvent } from '../../observability/logger';
import { processDueExtractions, reclaimStuckExtractions } from '../../session/reclaim';

// WF1 — transcript extraction crash recovery. The safety net behind the
// fire-and-forget call in the ingest handlers: every few minutes, (1) return any
// conversation stranded in `processing` by a dead process to `failed`, then
// (2) retry the ones that are due, with capped backoff. Rows that exhaust their
// attempts land in `needs_review` so a recording that never extracted is
// something Nicole is TOLD about rather than something she discovers when an
// appointment sheet is missing.
export const extractionJob: Job = {
  name: 'wf1.extraction',
  schedule: process.env.CRON_EXTRACTION ?? '*/5 * * * *', // every 5 minutes
  async run() {
    const { reclaimed } = await reclaimStuckExtractions();
    const { retried, deadLettered } = await processDueExtractions();
    if (reclaimed || retried || deadLettered) {
      logEvent('info', 'scheduler.wf1', 'extraction recovery tick', {
        reclaimed,
        retried,
        dead_lettered: deadLettered,
      });
    }
  },
};
