import type { Job } from '../types';
import { logEvent } from '../../observability/logger';
import { expireStale, sendApproved } from '../../outbound/queue';

// The send half of the approval gate.
//
// Assembly is weekly, but dispatch is daily on purpose: a batch approved on
// Tuesday should reach people on Tuesday rather than waiting for the next
// assembly. This job sends only what has already been approved, then drops
// anything that sat unapproved past its window — a nudge written for day three
// of an enquiry is not worth delivering in week three.
export const outboundDispatchJob: Job = {
  name: 'outbound.dispatch',
  schedule: process.env.CRON_OUTBOUND_DISPATCH ?? '15 8 * * *', // daily, 08:15
  async run() {
    const { sent, failed } = await sendApproved();
    const expired = await expireStale();
    logEvent('info', 'scheduler.outbound', 'dispatch tick', { sent, failed, expired });
  },
};
