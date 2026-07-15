import type { Job } from '../types';
import { logEvent } from '../../observability/logger';
import { runMorningDigest } from '../../brief/morningDigest';

// The morning prep digest: today's clients, each with their brief, emailed to
// Nicole before she's at her desk. Recipient is PRACTITIONER_EMAIL — unset means
// the job no-ops rather than guessing an address.
export const morningBriefJob: Job = {
  name: 'brief.morning_digest',
  schedule: process.env.CRON_MORNING_BRIEF ?? '0 7 * * *', // 07:00 daily
  async run() {
    const r = await runMorningDigest();
    logEvent('info', 'scheduler.brief', 'morning digest tick', { ...r });
  },
};
