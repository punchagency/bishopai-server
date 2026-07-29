import crypto from 'node:crypto';

/**
 * Deterministic doc ID helper for session tasks.
 * Unique constraint replacement for (appointment_id, title) where source='session'.
 */
export function taskDocId(appointmentId: string, title: string): string {
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
