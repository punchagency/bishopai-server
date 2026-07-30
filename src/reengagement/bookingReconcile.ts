import { getDatabase } from '../db/index.js';
import { logEvent, logError } from '../observability/logger';

// Stuck-booking reconcile — recovers from the one crash window in the public
// booking flow (webhooks.ts POST /appointments/book).
//
// That flow CLAIMS the lead (status → 'booked') before calling PB, then records
// the appointment + a 'booked' lead_activity in a short local transaction after
// PB confirms. A crash between the claim and that final record leaves a lead
// stranded as 'booked' with no appointment — the client sees a failure and can't
// rebook via the link. This sweep reopens such leads so the cadence re-engages
// them.
//
// Detection is precise: a SUCCESSFULLY booked lead always has a 'booked'
// lead_activity (written in the same txn as the appointment). So "status='booked'
// with NO 'booked' activity" is a stranded claim. The grace window ensures we
// never touch an in-flight booking (which completes in seconds); `updated_at` is
// bumped to the claim time by the leads trigger.

const GRACE_MINUTES = Number(process.env.BOOKING_RECONCILE_GRACE_MIN ?? 15);
// Where a stranded lead goes — an active, non-fixed status the cadence processes.
const REOPEN_STATUS = 'nurturing';

export interface BookingReconcileResult {
  reopened: number;
}

export async function reconcileStuckBookings(now: Date = new Date()): Promise<BookingReconcileResult> {
  try {
    const db = getDatabase();
    const cutoff = new Date(now.getTime() - GRACE_MINUTES * 60_000).toISOString();
    const stamp = new Date().toISOString();

    // The single UPDATE … WHERE NOT EXISTS becomes a query plus a per-lead
    // check. The set is tiny by construction: it is only the leads currently
    // claimed as booked, and a stranded one is a crash-window artefact.
    const claimed = await db.reengagement.listLeadsByStatus('booked');
    const reopened: string[] = [];

    for (const lead of claimed) {
      // The grace window ensures an in-flight booking (which completes in
      // seconds) is never touched.
      if ((lead.updated_at ?? lead.created_at) >= cutoff) continue;

      // Detection is precise: a SUCCESSFULLY booked lead always has a 'booked'
      // activity, written alongside the appointment. So "claimed as booked with
      // NO booked activity" is a stranded claim and nothing else.
      const activities = await db.reengagement.listActivities(lead.id);
      if (activities.some((a) => a.type === 'booked')) continue;

      await db.reengagement.saveLead({ ...lead, status: REOPEN_STATUS, updated_at: stamp });
      reopened.push(lead.id);
    }

    if (reopened.length > 0) {
      logEvent('warn', 'reengagement.booking_reconcile', 'reopened stranded booking claims', {
        reopened: reopened.length,
        lead_ids: reopened,
      });
    }
    return { reopened: reopened.length };
  } catch (err) {
    logError('reengagement.booking_reconcile', 'stuck-booking sweep failed', err);
    return { reopened: 0 };
  }
}
