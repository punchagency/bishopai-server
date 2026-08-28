// How hard, and how often, extraction tries.
//
// Split out of reclaim.ts because the queue needs the same numbers to decide
// what is eligible, and importing them from reclaim.ts made a three-way cycle
// (reclaim → queue → process → reclaim). Two copies of "how many attempts is
// too many" is the worse alternative: the queue would offer a row the retry
// sweep had already dead-lettered.

/** How long a claim may go unfinished before we assume its owner died. A live
 *  extraction renews its lease (see startLeaseHeartbeat in process.ts), so this
 *  bounds crash-recovery latency, not how long a legitimate extraction may run. */
export const LEASE_MINUTES = Number(process.env.EXTRACTION_LEASE_MINUTES ?? 10);

/** Attempts before a conversation stops retrying and asks for a human. */
export const MAX_ATTEMPTS = Number(process.env.EXTRACTION_MAX_ATTEMPTS ?? 4);

/** Capped backoff. Index by attempt count; past the end, use the last. */
const BACKOFF_MINUTES = [1, 5, 15, 60];

export function backoffMinutes(attempts: number): number {
  return BACKOFF_MINUTES[Math.min(attempts, BACKOFF_MINUTES.length - 1)];
}
