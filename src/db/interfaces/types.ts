export interface Client {
  id: string;
  name: string;
  /** Nullable in pg (added by 0007, no backfill) — a PB client may have none. */
  email: string;
  phone?: string | null;
  /** Practice Better client id — unique when present. */
  pb_id?: string | null;
  /** Where this client's documents live in Drive. Created on first publish. */
  drive_folder_id?: string | null;
  /** The client's running Flow Sheet, a native Google Sheet appended in place (0014). */
  flow_sheet_id?: string | null;
  phase?: string | null;
  fullscript_patient_id?: string | null;
  created_at: string;
  updated_at: string;
}

export interface Appointment {
  id: string;
  /** Nullable: ON DELETE SET NULL in pg, and a walk-in recording may precede a client. */
  client_id: string | null;
  /** Denormalized for listing without a join (§3.4). */
  client_name?: string | null;
  /** PB appointment id — unique when present. */
  pb_id?: string | null;
  starts_at: string; // ISO date string (exact Postgres column name)
  ends_at: string;   // ISO date string (exact Postgres column name)
  status: string;
  service_type?: string | null;
  created_at: string;
  updated_at: string;
}

/**
 * `walk_in` is distinct from `manual`: manual means Nicole picked an EXISTING
 * appointment the correlator wasn't sure about; walk_in means no appointment
 * existed and one was created from the recording itself (0019).
 */
export type CorrelationStatus = 'unmatched' | 'matched' | 'manual' | 'walk_in';

/**
 * `processing` is NOT terminal. A crash between the claim and the write used to
 * strand rows there forever, so an appointment silently never got a sheet (0026).
 * `extraction_leased_at` is what lets the reclaim sweep tell a live call from an
 * abandoned one.
 */
export type ExtractionStatus = 'pending' | 'processing' | 'done' | 'failed' | 'needs_review';

export interface Conversation {
  id: string;
  bee_id: string;
  appointment_id?: string | null;
  client_id?: string | null;
  starts_at: string;
  ends_at: string;
  transcript?: string | null;
  correlation_status: CorrelationStatus;
  extraction_status: ExtractionStatus;
  extraction_attempts: number;
  /** When the row became eligible again. NULL means "now". */
  extraction_next_attempt_at?: string | null;
  /** Set at claim time; the reclaim sweep finds rows whose owner died. */
  extraction_leased_at?: string | null;
  extraction_error?: string | null;
  /** Raw model output on failure — without it, truncation, a schema violation and
   *  a refusal are indistinguishable after the fact. */
  extraction_raw?: string | null;
  /** Correlator scratch, kept for the review queue's candidate list. */
  match_confidence?: number | null;
  correlation_reason?: string | null;
  candidate_matches?: Array<{ appointment_id: string; score: number; reason?: string }>;
  created_at: string;
  updated_at: string;
}

export interface AppointmentClaim {
  id: string; // appointmentId
  conversation_id: string;
  claimed_at: string;
}

export interface SessionNoteRecord {
  id: string;
  appointment_id: string;
  conversation_id?: string | null;
  client_id?: string | null;
  note_data: Record<string, unknown>; // SessionNote schema
  status: 'draft' | 'approved';
  extraction_status: 'pending' | 'processing' | 'done' | 'failed';
  extraction_error?: string | null;
  created_at: string;
  updated_at: string;
}

/** 'in_review' is a real state in the CHECK constraint and in combineStatus. */
export type DocStatus = 'draft' | 'in_review' | 'approved';

/**
 * The practitioner-facing copy of the session note. Document id ==
 * appointment_id: `appointment_sheets_appointment_id_key` (0003) made it one per
 * appointment so extraction could upsert idempotently, and keying the document
 * that way turns writeBoth into an atomic two-ref update instead of a query.
 */
export interface AppointmentSheet {
  id: string;
  appointment_id: string;
  client_id?: string | null;
  /**
   * When the session HAPPENED, denormalized off the appointment (§3.4).
   *
   * Every ordering in the app is by this, never by updated_at — which is a
   * row-modification timestamp that reorders itself whenever a note is
   * re-approved or a seed re-runs. In Postgres it came from a JOIN; here it has
   * to live on the document, because Firestore cannot order one collection by a
   * field in another. It is also what makes "the client's approved sessions,
   * oldest first" a single indexed query rather than a fetch-then-sort.
   */
  starts_at?: string | null;
  /** Denormalized for listings and document titles (§3.4). */
  client_name?: string | null;
  content_json: Record<string, unknown>;
  status: DocStatus;
  /**
   * Which version the live content is. Starts at 1; each amendment files the
   * previous content in note_revisions under this number and then increments.
   *
   * A counter on the document, rather than `MAX(revision)` over the history:
   * Firestore has no MAX aggregate that can be read inside a transaction
   * alongside the row it guards, and the amend transaction needs both.
   */
  revision: number;
  created_at: string;
  updated_at: string;
}

/**
 * The client-facing copy. Byte-identical content_json to the sheet — they differ
 * only in how they render — so both are written together, always. Document id ==
 * appointment_id (protocols_appointment_id_key, 0003).
 */
export interface SupplementProtocol {
  id: string;
  appointment_id: string;
  client_id: string;
  /** See AppointmentSheet.starts_at — the Flow Sheet rebuild orders on this. */
  starts_at?: string | null;
  client_name?: string | null;
  content_json: Record<string, unknown>;
  status: DocStatus;
  /** See AppointmentSheet.revision — the two move together. */
  revision: number;
  created_at: string;
  updated_at: string;
}

/**
 * The unified approvals record: money approvals (type='checkout') carry
 * checkout_id + amount_cents + summary_hash; lighter ones (session, refill
 * digest) reuse the same shape.
 *
 * Note `appointment_id` is denormalized to the top level here. In Postgres the
 * table had NO such column — session approvals stored it inside payload_json
 * (see the 0024 backfill, which reads `payload_json->>'appointment_id'`). A
 * top-level field is kept because Firestore cannot query into a nested map as
 * cheaply, and listApprovals(appointmentId) is a real access path. payload_json
 * still carries the full original payload.
 */
export interface Approval {
  id: string;
  checkout_id?: string | null;
  appointment_id?: string | null;
  type: 'checkout' | 'session' | 'refill_bulk_send' | string;
  payload_json: Record<string, unknown>;
  /**
   * Includes 'amended', which migration 0018 added to the CHECK constraint
   * specifically so an amendment files its own approval row rather than
   * overwriting the original sign-off. amendSession writes it.
   */
  status: 'pending' | 'approved' | 'rejected' | 'skipped' | 'amended';
  amount_cents?: number | null;
  currency?: string | null;
  /** Binds the approval to the exact figure Nicole saw. */
  summary_hash?: string | null;
  approved_by?: string | null;
  approved_at?: string | null;
  created_at: string;
}

/** 'appointment_sheets' | 'protocols' — which live row this history belongs to. */
export type NoteTable = 'appointment_sheets' | 'protocols';

/**
 * The content as it stood BEFORE the amendment that created this row (0017).
 *
 * Document id == `${source_table}__${source_id}__${revision}`, replacing
 * `note_revisions_unique (source_table, source_id, revision)`. That index exists
 * so a double-submitted amendment can't file the same superseded version twice,
 * and the deterministic id enforces it under concurrency rather than by a
 * read-then-write.
 *
 * Keyed on (source_table, source_id) rather than appointment_id because both the
 * sheet and the protocol are snapshotted, and either one's history must be
 * complete on its own.
 */
export interface NoteRevision {
  id: string;
  source_table: NoteTable;
  source_id: string;
  /** Denormalized so a session's whole history is one query (§3.4). */
  appointment_id?: string | null;
  revision: number;
  content_json: Record<string, unknown>;
  reason?: string | null;
  created_at: string;
}

/**
 * Exactly the checkout_status_check constraint after migration 0023.
 *
 * CHARGE_REVIEW is NOT a variant of CHARGE_FAILED: it means the charge outcome is
 * UNKNOWN (the process died mid-flight, or the provider returned an ambiguous
 * error after possibly capturing). Money may have moved, so it is never
 * auto-retried. CHARGE_FAILED means definitively no money moved, and is safe to
 * retry. Collapsing the two is how a captured charge goes silent.
 */
export type CheckoutStatus =
  | 'DETECTED'
  | 'SUMMARY_READY'
  | 'AWAITING_APPROVAL'
  | 'CHARGING'
  | 'CHARGED'
  | 'DOCS_UPDATED'
  | 'PB_MARKED'
  | 'CLOSED'
  | 'CHARGE_FAILED'
  | 'CHARGE_REVIEW';

export interface Checkout {
  /**
   * Document id == appointment_id. Migration 0023 moved the uniqueness from
   * pb_appointment_id to appointment_id precisely because an appointment with a
   * NULL pb_id could spawn two checkouts and therefore two charges for one
   * session (finding M5). appointment_id is the real unit.
   */
  id: string;
  appointment_id: string | null;
  client_id: string | null;
  pb_appointment_id: string | null;
  status: CheckoutStatus;
  detection_hash?: string | null;
  /** Frozen at detection — the figure Nicole approved, never a live re-pull. */
  summary_snapshot?: Record<string, unknown> | null;
  qb_invoice_id?: string | null;
  qb_txn_id?: string | null;
  /** `checkout:{id}:charge:{charge_attempts}` — unique; never double-charge. */
  charge_idempotency_key?: string | null;
  /** Bumped by resetFailedCharge so a post-decline retry is a NEW charge (M4). */
  charge_attempts: number;
  created_at: string;
  updated_at: string;
}

/**
 * Durable reconciliation outbox: one row per checkout, written in the SAME
 * transaction that marks the checkout CHARGED, so a captured charge can never
 * exist without its "record this payment in QuickBooks" intent.
 */
export interface PaymentReconciliation {
  /** Document id == checkout_id, which is what made enqueue idempotent in pg. */
  id: string;
  checkout_id: string;
  provider_txn_id?: string | null;
  invoice_id?: string | null;
  customer_id?: string | null;
  amount_cents: number;
  currency: string;
  status: 'PENDING' | 'RECORDING' | 'RECORDED' | 'FAILED' | 'NEEDS_REVIEW';
  /** Stable; doubles as the QBO `requestid` that makes the write idempotent. */
  idempotency_key: string;
  attempts: number;
  last_error?: string | null;
  next_attempt_at: string;
  accounting_payment_id?: string | null;
  created_at: string;
  updated_at: string;
}

export interface ClientQboMap {
  /** Document id == client_id (it was the primary key in pg). */
  client_id: string;
  qbo_customer_id: string;
  created_at: string;
  updated_at: string;
}

/**
 * One current row per (client, supplement). Document id ==
 * `${client_id}__${name_key}`, which is the replacement for
 * `supplements_client_name_key_unique` (0026) — the index that stops "Bio-C
 * Plus" and "Bio C Plus" becoming two rows on one plan, and therefore two refill
 * projections for one product.
 *
 * `name` stays as spoken (the document shows it); `name_key` is the normalized
 * identity everything else keys on.
 */
export interface Supplement {
  id: string;
  client_id: string;
  name: string;
  name_key: string;
  dose: string | null;
  qty: number | null;
  start_date: string | null;
  source: string | null;
  schedule?: Record<string, string | null> | null;
  /** Where the client obtains it — the protocol grid's "Here | Fullscript". */
  obtained_from?: string | null;
  units_per_dose?: number | null;
  doses_per_day?: number | null;
  created_at: string;
  updated_at: string;
}

/**
 * Status values are exactly the `refills_status_check` constraint (0001):
 * pending | notified | snoozed | closed.
 *
 * An earlier draft of this interface had 'skipped' instead of 'notified' and
 * added `snooze_until` / `skip_until` columns that do not exist. Nothing writes
 * those, but three live modules DO write and read 'notified'
 * (routes/refills.ts, routes/dashboard.ts, refills/adherence.ts) — so under the
 * draft shape the bulk-send would have written a status the type said was
 * impossible, and Firestore, having no CHECK constraint, would have stored it
 * without complaint.
 */
export type RefillStatus = 'pending' | 'notified' | 'snoozed' | 'closed';

export interface Refill {
  id: string;
  client_id: string;
  /** Denormalized for the digest and the dashboard, per §3.4. */
  client_name?: string | null;
  supplement_id: string;
  supplement_name: string;
  dose?: string | null;
  due_date: string; // ISO date string (yyyy-mm-dd)
  status: RefillStatus;
  /** 0 = none sent, 1 = first reminder, 2 = follow-up sent (0011). */
  reminder_stage?: number;
  reminded_at?: string | null;
  reminder_next_at?: string | null;
  /**
   * Silences the remaining cadence WITHOUT changing status (0025) — the refill
   * stays in Nicole's digest, only the automated email stops. Clearing it
   * resumes the cadence where it left off, so it doubles as the audit trail.
   */
  reminders_cancelled_at?: string | null;
  created_at?: string;
  updated_at: string;
}

/**
 * One client's refill send, as 0004 defines it — NOT a basket of items. An
 * earlier draft of this interface had an `items` array and a
 * pending|sent|failed status; the real table is one row per refill, grouped by
 * `batch_id` so Nicole can see which clients in a bulk send received theirs and
 * which didn't, with a `queued|sent|received|failed` status.
 *
 * `refill_id` is what the prep brief's "ordered" flag reads: it is the link
 * between a projected run-out and the invitation that was actually sent.
 */
export type RefillOrderStatus = 'queued' | 'sent' | 'received' | 'failed';

export interface RefillOrder {
  id: string;
  /** One bulk send groups many orders. */
  batch_id: string;
  client_id: string | null;
  refill_id: string | null;
  supplement_name?: string | null;
  status: RefillOrderStatus;
  fullscript_order_id?: string | null;
  /** The Fullscript treatment-plan link, persisted so the card survives reloads (0009). */
  invitation_url?: string | null;
  /** Populated when status = 'failed'. */
  error?: string | null;
  sent_at?: string | null;
  received_at?: string | null;
  created_at: string;
  updated_at?: string;
}

/**
 * A WF3 enquiry. Reconciled to the real 0001 columns — the earlier draft had a
 * required `name` (leads have none; the address is the identity), a
 * `cadence_state` string in place of the `sequence_state` map the cadence
 * actually reads, and no `cadence_cancelled_at`, so a cancelled sequence would
 * have kept sending.
 */
export interface Lead {
  id: string;
  email: string | null;
  source?: string | null;
  status: string;
  /** Which cadence steps have already gone out — `{ sent: [...] }`. */
  sequence_state: { sent?: string[] } & Record<string, unknown>;
  last_touch?: string | null;
  /**
   * Silences the remaining cadence without changing status (0025). Clearing it
   * resumes where it left off, so it doubles as the audit trail of the stop.
   */
  cadence_cancelled_at?: string | null;
  created_at: string;
  updated_at?: string;
}

/**
 * A message sent to exactly one of a client or a lead (0001).
 *
 * `messages_one_recipient` was a CHECK constraint; Firestore has none (§7), so
 * the exclusivity is validated on write at the repository boundary instead. A
 * message addressed to both, or neither, is a message nobody can answer for.
 */
export interface MessageRecord {
  id: string;
  client_id?: string | null;
  lead_id?: string | null;
  channel: string;
  body?: string | null;
  sent_at?: string | null;
  status: string;
  created_at: string;
}

/** page_view | form_open | form_submit | email_open | reply | booked (0006). */
export interface LeadActivity {
  id: string;
  /**
   * Nullable: an anonymous site event (a page view from someone who hasn't left
   * an address) is still recorded for funnel analysis, with no lead to attach
   * it to. The pg column is a nullable FK for exactly that.
   */
  lead_id: string | null;
  type: string;
  /** e.g. /book-a-consult — site activity. */
  path?: string | null;
  detail?: string | null;
  occurred_at: string;
  created_at: string;
}

export interface TaskItem {
  id: string;
  client_id: string;
  client_name?: string | null;
  appointment_id?: string | null;
  title: string; // Exact Postgres column name
  due_date?: string | null;
  due_sort?: string; // Sentinel string for sorting null due dates per §3.5
  status: 'open' | 'done' | 'dismissed'; // Exact Postgres enum
  source: 'session' | 'manual';
  created_at: string;
  completed_at?: string | null;
}

/**
 * What was published, for which client, and where it landed.
 *
 * `type` carries the exact values the pg column already holds — the codebase
 * writes 'ROF' | 'SupplementProtocol' | 'AppointmentFlowSheet' | 'Markdown' and
 * the earlier Firestore draft renamed them to a different vocabulary, which
 * would have silently orphaned every historical row on migration.
 */
export type DocumentType = 'ROF' | 'SupplementProtocol' | 'AppointmentFlowSheet' | 'Markdown';

export interface DocumentRecord {
  id: string;
  client_id: string;
  /** Nullable: the pg table has no such column, so backfilled rows won't have one. */
  appointment_id?: string | null;
  type: DocumentType;
  drive_file_id?: string | null;
  storage_path?: string | null; // Cloud Storage archival path per §9.2
  created_at: string;
}

/**
 * Document id == `${client_id}__${type}`, replacing `0012_consent_unique`.
 *
 * `granted_at` is nullable and IS the grant: a revoked consent keeps its row
 * with a null timestamp rather than being deleted, so the record shows that
 * consent was considered and withdrawn, not that it was never asked for. An
 * earlier draft called this non-null `consented_at`, which cannot express a
 * revocation at all.
 */
export interface Consent {
  id: string;
  client_id: string;
  type: string;
  granted_at: string | null;
  notes?: string | null;
  created_at: string;
}

export interface AuthState {
  enabled: boolean;
  password_hash: string | null;
  token_secret: string | null;
  updated_at: string;
}

export interface IntegrationState {
  key: string;
  value: string;
  updated_at: string;
}

export interface AuditLog {
  id: string;
  entity_type: string;
  entity_id: string;
  action: string;
  actor: string;
  summary: string;
  metadata?: Record<string, unknown> | null;
  created_at: string;
}
