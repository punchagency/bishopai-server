import type { Job } from '../types';
import { logEvent } from '../../observability/logger';
import { pollInbox } from '../../reengagement/inboxPoller';

// WF3 — Outlook inbox poller. Reads new messages from Nicole's inbox via Graph:
// replies from active leads stop their cadence (+ surface to Nicole); unknown
// senders become new leads with an automated first response (spam/loop guarded).
// Dry-run (no-op) until MS_GRAPH_TOKEN/MS_GRAPH_SENDER are set.
export const inboxPollerJob: Job = {
  name: 'wf3.inbox.poller',
  schedule: process.env.CRON_INBOX_POLL ?? '*/5 * * * *', // every 5 min
  async run() {
    const { checked, replied, newLeads } = await pollInbox();
    logEvent('info', 'scheduler.wf3', 'inbox poll tick', { checked, replied, newLeads });
  },
};
