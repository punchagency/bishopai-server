import crypto from 'node:crypto';

/**
 * Deterministic doc ID helper for session tasks — the replacement for
 * `tasks_session_unique (appointment_id, title) WHERE appointment_id IS NOT NULL`.
 *
 * Only appointment-bound tasks get a deterministic ID, because that index was
 * deliberately partial: Postgres placed NO uniqueness on tasks without an
 * appointment. Hashing an 'unbound' placeholder instead would invent a
 * constraint that never existed AND scope it globally, so two clients with the
 * same follow-up wording ("recheck B12 in 4 weeks") would collapse into one
 * document and one of them would lose their task. Returning null here keeps
 * those tasks on random IDs, exactly as Postgres allowed.
 */
export function taskDocId(appointmentId: string | null, title: string): string | null {
  if (!appointmentId) return null;
  const hash = crypto.createHash('sha1').update(title.trim()).digest('hex').slice(0, 12);
  return `${appointmentId}__${hash}`;
}

/**
 * Deterministic doc ID helper for client consents.
 * Unique constraint replacement for (client_id, type).
 */
export function consentDocId(clientId: string, type: string): string {
  return `${clientId}__${type}`;
}

/**
 * Deterministic doc ID helper for checkouts.
 * Unique constraint replacement on pb_appointment_id.
 */
export function checkoutDocId(pbAppointmentId: string): string {
  return pbAppointmentId;
}

/**
 * Appointment claim document ID helper for conversation 1-to-1 correlation.
 */
export function appointmentClaimDocId(appointmentId: string): string {
  return appointmentId;
}
