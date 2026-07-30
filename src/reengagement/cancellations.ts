import { getDatabase } from '../db/index.js';
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
const NOT_REUSABLE = new Set(['closed', 'cancelled']);

let seq = 0;
const newId = (kind: string): string =>
  `${kind}_${Date.now().toString(36)}_${(seq++).toString(36)}_${Math.random().toString(36).slice(2, 7)}`;

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
  const db = getDatabase();

  const appointment = await db.appointments.findByPbId(pbAppointmentId);
  const client = appointment?.client_id ? await db.clients.findById(appointment.client_id) : null;
  const email = client?.email?.trim().toLowerCase();
  if (!email) {
    logEvent('info', 'reengagement.cancelled', 'cancellation has no client email — cannot re-engage', {
      pb_appointment_id: pbAppointmentId,
    });
    return { outcome: 'skipped_no_email' };
  }
  const name = client?.name ?? null;

  // One read of this address's leads answers both questions the two SELECTs
  // asked — already on the cancelled track, and is there a reusable lead —
  // newest first, which is the ORDER BY.
  const leads = await db.reengagement.listLeadsByEmail(email);

  // Already on the cancelled track for this email? Idempotent no-op, which is
  // what makes a duplicate PB webhook harmless.
  const onTrack = leads.find((l) => l.status === 'cancelled');
  if (onTrack) return { outcome: 'noop', leadId: onTrack.id };

  const now = new Date().toISOString();
  const reusable = leads.find((l) => !NOT_REUSABLE.has(l.status));

  let leadId: string;
  let outcome: CancellationOutcome;
  if (reusable) {
    leadId = reusable.id;
    // Reset the cadence to start from now, on the cancelled track. created_at is
    // deliberately moved: the 7/14-day timings are measured from it, so a reset
    // lead counts from the cancellation rather than the original enquiry.
    await db.reengagement.saveLead({
      ...reusable,
      status: 'cancelled',
      sequence_state: { sent: [] },
      last_touch: null,
      created_at: now,
      updated_at: now,
    });
    outcome = 'converted';
  } else {
    leadId = newId('lead');
    await db.reengagement.saveLead({
      id: leadId,
      email,
      source: 'pb_cancellation',
      status: 'cancelled',
      sequence_state: { sent: [] },
      last_touch: null,
      cadence_cancelled_at: null,
      created_at: now,
      updated_at: now,
    });
    outcome = 'created';
  }

  await db.reengagement.logActivity({
    id: newId('activity'),
    lead_id: leadId,
    type: 'cancelled',
    path: null,
    detail: name ? `cancelled appointment — ${name}` : 'cancelled appointment',
    occurred_at: now,
    created_at: now,
  });

  logEvent('info', 'reengagement.cancelled', 'client enrolled in cancelled cadence', {
    pb_appointment_id: pbAppointmentId,
    lead_id: leadId,
    outcome,
  });
  return { outcome, leadId };
}
