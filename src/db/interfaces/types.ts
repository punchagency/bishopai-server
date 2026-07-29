export interface Client {
  id: string;
  name: string;
  email: string;
  phone?: string | null;
  fullscript_patient_id?: string | null;
  created_at: string;
  updated_at: string;
}

export interface Appointment {
  id: string;
  client_id: string;
  client_name?: string | null;
  pb_id?: string | null;
  starts_at: string; // ISO date string (exact Postgres column name)
  ends_at: string;   // ISO date string (exact Postgres column name)
  status: string;
  service_type?: string | null;
  created_at: string;
}

export interface Conversation {
  id: string;
  bee_id?: string | null;
  appointment_id?: string | null;
  transcript: string;
  duration_seconds?: number | null;
  audio_url?: string | null;
  status: 'matched' | 'unmatched' | 'processed';
  match_confidence?: number | null;
  correlation_reason?: string | null;
  candidate_matches?: Array<{ appointment_id: string; score: number; reason?: string }>;
  created_at: string;
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

export interface AppointmentSheet {
  id: string;
  appointment_id: string;
  content_json: Record<string, unknown>;
  status: 'draft' | 'approved';
  created_at: string;
  updated_at: string;
}

export interface SupplementProtocol {
  id: string;
  appointment_id: string;
  content_json: Record<string, unknown>;
  status: 'draft' | 'approved';
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
  status: 'pending' | 'approved' | 'rejected' | 'skipped';
  amount_cents?: number | null;
  currency?: string | null;
  /** Binds the approval to the exact figure Nicole saw. */
  summary_hash?: string | null;
  approved_by?: string | null;
  approved_at?: string | null;
  created_at: string;
}

export interface NoteRevision {
  id: string;
  appointment_id: string;
  revision: number;
  content_json: Record<string, unknown>;
  reason?: string | null;
  revised_by: string;
  revised_at: string;
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

export interface Supplement {
  id: string;
  client_id: string;
  name: string;
  dose: string | null;
  qty: number | null;
  start_date: string | null;
  source: string | null;
  schedule?: Record<string, string | null> | null;
  units_per_dose?: number | null;
  doses_per_day?: number | null;
  created_at: string;
}

export interface Refill {
  id: string;
  client_id: string;
  client_name?: string | null;
  supplement_id: string;
  supplement_name: string;
  dose?: string | null;
  due_date: string; // ISO date string (yyyy-mm-dd)
  status: 'pending' | 'snoozed' | 'skipped' | 'closed';
  snooze_until?: string | null;
  skip_until?: string | null;
  updated_at: string;
}

export interface RefillOrder {
  id: string;
  client_id: string;
  fullscript_order_id?: string | null;
  items: Array<{ supplement_name: string; quantity: number }>;
  status: 'pending' | 'sent' | 'failed';
  created_at: string;
}

export interface Lead {
  id: string;
  name: string;
  email: string;
  source: string;
  cadence_state: string;
  last_contacted_at?: string | null;
  created_at: string;
}

export interface LeadActivity {
  id: string;
  lead_id: string;
  activity_type: string;
  payload?: Record<string, unknown> | null;
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

export interface DocumentRecord {
  id: string;
  client_id: string;
  appointment_id: string;
  doc_type: 'rof' | 'supplement-protocol' | 'flow-sheet';
  drive_file_id?: string | null;
  storage_path?: string | null; // Cloud Storage archival path per §9.2
  created_at: string;
}

export interface Consent {
  id: string; // ${clientId}__${type}
  client_id: string;
  type: string;
  consented_at: string;
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
