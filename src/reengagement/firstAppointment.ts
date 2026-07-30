import { logEvent } from '../observability/logger';
import { runEnrollmentPass, type EnrollmentResult } from './enrollment';

// WF3 first-appointment conversion: a client who came exactly once and hasn't
// rebooked. Treated like the cancelled flow (7d/14d), with an incentive on the
// 14-day step to encourage them to return or commit to a plan. Disjoint from the
// maintenance track by definition — maintenance requires 2+ completed sessions,
// this requires exactly one — so a client can't land on both.
//
// Identification (this pass) seeds `first_appointment` leads that the hourly
// reengagement runner then nudges. Runs on a daily cron.

// How long after the single session before we nudge — gives the client a few
// days to rebook on their own first.
const AFTER_DAYS = Number(process.env.FIRST_APPT_AFTER_DAYS ?? 3);

export type FirstAppointmentResult = EnrollmentResult;

/**
 * Scan for one-and-done clients and enroll the ones not already in an active
 * sequence. Idempotent across runs (skips any client with an active lead), so a
 * daily re-run never stacks duplicates or fights an in-flight cadence.
 */
export async function enrollFirstAppointmentClients(
  now: Date = new Date(),
): Promise<FirstAppointmentResult> {
  const result = await runEnrollmentPass(
    {
      sessionCount: (n) => n === 1,
      afterDays: AFTER_DAYS,
      track: 'first_appointment',
      detail: (c, date) =>
        `first-appointment conversion — ${c.name ?? 'client'}, first session ${date}`,
    },
    now,
  );

  logEvent('info', 'reengagement.first_appointment', 'first-appointment enrollment pass complete', {
    after_days: AFTER_DAYS,
    ...result,
  });
  return result;
}
