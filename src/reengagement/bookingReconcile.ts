import { pool } from '../db/pool';
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

export async function reconcileStuckBookings(): Promise<BookingReconcileResult> {
  try {
    const { rows } = await pool.query<{ id: string }>(
      `UPDATE leads
          SET status = $2
        WHERE status = 'booked'
          AND updated_at < now() - ($1 || ' minutes')::interval
          AND NOT EXISTS (
            SELECT 1 FROM lead_activity la
             WHERE la.lead_id = leads.id AND la.type = 'booked'
          )
      RETURNING id`,
      [String(GRACE_MINUTES), REOPEN_STATUS],
    );
    if (rows.length > 0) {
      logEvent('warn', 'reengagement.booking_reconcile', 'reopened stranded booking claims', {
        reopened: rows.length,
        lead_ids: rows.map((r) => r.id),
      });
    }
    return { reopened: rows.length };
  } catch (err) {
    logError('reengagement.booking_reconcile', 'stuck-booking sweep failed', err);
    return { reopened: 0 };
  }
}
