import { logEvent } from '../observability/logger';
import { runEnrollmentPass, type EnrollmentResult } from './enrollment';

// WF3 maintenance reactivation: identify established clients who've gone quiet —
// 2+ completed sessions (so this is a maintenance-phase client, not a one-visit
// conversion case — those go to the first-appointment track), whose most recent
// completed session is older than the gap threshold and who have no upcoming
// booking — and enroll them into the maintenance cadence (mirrors the cancelled
// 7d/14d track). Deactivation at 5 months is handled by the shared cadence.
//
// Identification (this pass) is separate from sending: it seeds `maintenance`
// leads that the hourly reengagement runner then nudges. Runs on a daily cron.

// How long since the last session before a client counts as maintenance-phase.
const GAP_DAYS = Number(process.env.MAINTENANCE_GAP_DAYS ?? 90);

export type MaintenanceResult = EnrollmentResult;

/**
 * Scan for maintenance-phase clients and enroll the ones not already in an
 * active sequence. Idempotent across runs: a client with any active lead (their
 * email, status not closed/booked) is skipped, so a daily re-run never stacks
 * duplicate maintenance leads or fights an in-flight cadence.
 */
export async function enrollMaintenanceClients(now: Date = new Date()): Promise<MaintenanceResult> {
  const result = await runEnrollmentPass(
    {
      // 2+ — disjoint from the first-appointment track by construction, so a
      // client can never land on both.
      sessionCount: (n) => n >= 2,
      afterDays: GAP_DAYS,
      track: 'maintenance',
      detail: (c, date) => `maintenance re-engagement — ${c.name ?? 'client'}, last session ${date}`,
    },
    now,
  );

  logEvent('info', 'reengagement.maintenance', 'maintenance enrollment pass complete', {
    gap_days: GAP_DAYS,
    ...result,
  });
  return result;
}
