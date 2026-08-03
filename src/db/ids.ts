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

/**
 * Deterministic doc ID for a client's supplement row — the replacement for
 * `supplements_client_name_key_unique (client_id, name_key)` (0026).
 *
 * Keyed on the NORMALIZED name, never the spoken one. Extraction deliberately
 * preserves garbled product names verbatim, so keying on the raw string made
 * "Bio-C Plus" and "Bio C Plus" two rows on one plan — and therefore two refill
 * projections for one product.
 */
export function supplementDocId(clientId: string, nameKey: string): string {
  return `${clientId}__${encodeIdSegment(nameKey)}`;
}

/**
 * Deterministic doc ID for a superseded note version — the replacement for
 * `note_revisions_unique (source_table, source_id, revision)` (0017), which
 * exists so a double-submitted amendment can't file the same version twice.
 */
export function noteRevisionDocId(
  sourceTable: string,
  sourceId: string,
  revision: number,
): string {
  return `${sourceTable}__${sourceId}__${revision}`;
}

/**
 * Conversation doc ID == bee_id, which is `bee_id text UNIQUE NOT NULL` (0001)
 * and the key ingest's whole idempotency rests on. Making it the document id
 * turns `ON CONFLICT (bee_id)` into a create/get rather than a query-then-write,
 * which races.
 */
export function conversationDocId(beeId: string): string {
  return encodeIdSegment(beeId);
}

/**
 * Index-document id for a Practice Better id.
 *
 * `clients.pb_id` and `appointments.pb_id` were UNIQUE columns. Firestore has no
 * unique index on a non-ID field, and the local documents keep their own ids, so
 * uniqueness moves to a claim document in a side collection: `{pbId} -> localId`,
 * created inside the same transaction as the record it points at (§3.1).
 */
export function pbIndexDocId(pbId: string): string {
  return encodeIdSegment(pbId);
}

/**
 * Make an arbitrary external string safe as a Firestore document id.
 *
 * Firestore forbids '/' in an id and reserves '.' and '..' as whole ids; a
 * value that violates either is rejected at write time, which would turn a
 * merely unusual Bee id or supplement name into a failed ingest. Percent-encode
 * the few offenders and leave everything else legible, so a document id still
 * reads as what it is in the console.
 */
export function encodeIdSegment(raw: string): string {
  const safe = raw.replace(/%/g, '%25').replace(/\//g, '%2F');
  return safe === '.' || safe === '..' ? `${safe}%2E` : safe;
}

/**
 * Is this string usable as a document id we'd accept off the wire?
 *
 * The routes used to gate every `:id` path param with a UUID check, because pg
 * would raise on an invalid `::uuid` cast. Under Firestore that check became
 * actively wrong: the deterministic ids this module mints are NOT uuids
 * (`appt_…`, `client_…`, `${clientId}__${nameKey}`, a Bee id, a PB id), so a
 * uuid gate 404s every PB-synced appointment's checkout — including the approve
 * route, which is the one action Nicole has to be able to take.
 *
 * So the gate becomes Firestore's own document-id rule, which is what actually
 * has to hold: non-empty, at most 1500 bytes, no '/', and not '.' or '..'.
 * Control characters are refused too, since nothing we mint contains one and
 * they only ever arrive from a malformed request.
 */
export function isDocId(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  if (value.length === 0 || Buffer.byteLength(value, 'utf8') > 1500) return false;
  if (value === '.' || value === '..') return false;
  if (value.includes('/')) return false;
  // eslint-disable-next-line no-control-regex
  return !/[\u0000-\u001f\u007f]/.test(value);
}
