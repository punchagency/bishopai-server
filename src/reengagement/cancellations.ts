import { pool } from '../db/pool';
import { logEvent } from '../observability/logger';

// WF3 linkage: a Practice Better cancellation should enroll the client into the
// cancelled-appointment re-engagement cadence (7d/14d reschedule prompts). Bee↔PB
// aside, this is the join from an `appointments` status change to a `leads` row
// the cadence engine can act on — previously missing, so cancellations updated
// only the appointment and the cadence could never fire.

export type CancellationOutcome = 'created' | 'converted' | 'noop' | 'skipped_no_email';

export interface CancellationResult {
  outcome: CancellationOutcome;
  leadId?: string;
}

// A lead in one of these statuses is settled — not reused; but for cancellations
// we specifically want to (re)start the cancelled track, so we reuse any lead
// that isn't closed and isn't already on the cancelled track.
const REUSABLE = `status NOT IN ('closed', 'cancelled')`;

/**
 * Enroll the client behind a cancelled PB appointment into the cancelled cadence.
 * Timing (7/14 days) is measured from the lead's created_at, so a fresh/reset
 * lead makes the cadence count from the cancellation moment.
 *
 * - No client email on file → skip (can't re-engage; logged for visibility).
 * - Already on the cancelled track → no-op (idempotent for duplicate webhooks).
 * - An active non-cancelled lead exists → convert it, resetting the cadence.
 * - Otherwise → create a fresh cancelled lead.
 */
export async function enrollCancelledAppointment(pbAppointmentId: string): Promise<CancellationResult> {
  const client = await pool.query<{ email: string | null; name: string | null }>(
    `SELECT c.email, c.name
       FROM appointments a
       JOIN clients c ON c.id = a.client_id
      WHERE a.pb_id = $1`,
    [pbAppointmentId],
  );
  const email = client.rows[0]?.email?.trim();
  if (!email) {
    logEvent('info', 'reengagement.cancelled', 'cancellation has no client email — cannot re-engage', {
      pb_appointment_id: pbAppointmentId,
    });
    return { outcome: 'skipped_no_email' };
  }
  const name = client.rows[0]?.name ?? null;

  const db = await pool.connect();
  try {
    await db.query('BEGIN');

    // Already on the cancelled track for this email? Idempotent no-op.
    const onTrack = await db.query<{ id: string }>(
      `SELECT id FROM leads WHERE lower(email) = lower($1) AND status = 'cancelled' LIMIT 1`,
      [email],
    );
    if (onTrack.rowCount) {
      await db.query('COMMIT');
      return { outcome: 'noop', leadId: onTrack.rows[0].id };
    }

    // Reuse an active non-cancelled lead if present; else create one.
    const reusable = await db.query<{ id: string }>(
      `SELECT id FROM leads WHERE lower(email) = lower($1) AND ${REUSABLE} ORDER BY created_at DESC LIMIT 1`,
      [email],
    );

    let leadId: string;
    let outcome: CancellationOutcome;
    if (reusable.rowCount) {
      leadId = reusable.rows[0].id;
      // Reset the cadence to start from now, on the cancelled track.
      await db.query(
        `UPDATE leads
            SET status = 'cancelled',
                sequence_state = '{"sent": []}'::jsonb,
                last_touch = NULL,
                created_at = now()
          WHERE id = $1`,
        [leadId],
      );
      outcome = 'converted';
    } else {
      const ins = await db.query<{ id: string }>(
        `INSERT INTO leads (source, email, status) VALUES ('pb_cancellation', $1, 'cancelled') RETURNING id`,
        [email],
      );
      leadId = ins.rows[0].id;
      outcome = 'created';
    }

    await db.query(
      `INSERT INTO lead_activity (lead_id, type, detail) VALUES ($1, 'cancelled', $2)`,
      [leadId, name ? `cancelled appointment — ${name}` : 'cancelled appointment'],
    );

    await db.query('COMMIT');
    logEvent('info', 'reengagement.cancelled', 'client enrolled in cancelled cadence', {
      pb_appointment_id: pbAppointmentId,
      lead_id: leadId,
      outcome,
    });
    return { outcome, leadId };
  } catch (err) {
    await db.query('ROLLBACK');
    throw err;
  } finally {
    db.release();
  }
}
