// PB webhook event classification. Practice Better's exact event-type names are
// confirmed only once we have beta access (GET /webhooks/subscription/event/types),
// so this maps tolerantly on the shape/wording we expect and extracts the object
// id from the several places PB might put it. Pure + unit-tested, so the handler
// is correct the moment real deliveries arrive — no live access needed to verify.

export type PbEventKind = 'session_completed' | 'session_cancelled' | 'booking_updated' | 'unknown';

export interface PbEvent {
  kind: PbEventKind;
  eventType: string; // the raw event-type string (lowercased), for logging
  objectId: string | null; // appointment/session id, if present
}

function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' ? (v as Record<string, unknown>) : {};
}

export function classifyPbEvent(body: unknown): PbEvent {
  const b = asRecord(body);
  const eventType = String(b.eventType ?? b.type ?? b.event ?? 'unknown').toLowerCase();
  const data = asRecord(b.data ?? b);
  const rawId = b.id ?? data.id ?? data.appointmentId ?? data.sessionId ?? data.bookingId ?? null;
  const objectId = rawId == null ? null : String(rawId);

  let kind: PbEventKind = 'unknown';
  if (/cancel/.test(eventType)) kind = 'session_cancelled';
  else if (/complete|finished|checkout|marked.?done/.test(eventType)) kind = 'session_completed';
  else if (/session|appointment|booking/.test(eventType)) kind = 'booking_updated';

  return { kind, eventType, objectId };
}

/** Map a completed/cancelled event to the appointment status it implies. */
export function appointmentStatusFor(kind: PbEventKind): 'completed' | 'cancelled' | null {
  if (kind === 'session_completed') return 'completed';
  if (kind === 'session_cancelled') return 'cancelled';
  return null;
}
