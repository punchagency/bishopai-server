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

export interface Approval {
  id: string;
  appointment_id: string;
  approved_by: string;
  approved_at: string;
  doc_hash?: string | null;
  amount_charged?: number | null;
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

export type CheckoutStatus =
  | 'AWAITING_APPROVAL'
  | 'CHARGING'
  | 'CHARGED'
  | 'PB_MARKED'
  | 'CLOSED'
  | 'CHARGE_FAILED'
  | 'RECONCILE_FAILED';

export interface Checkout {
  id: string;
  appointment_id: string;
  pb_appointment_id: string;
  amount: number;
  currency: string;
  status: CheckoutStatus;
  summary_snapshot?: Record<string, unknown> | null;
  hash?: string | null;
  qb_charge_id?: string | null;
  created_at: string;
  updated_at: string;
}

export interface PaymentReconciliation {
  id: string;
  checkout_id: string;
  status: 'PENDING' | 'COMPLETED' | 'NEEDS_REVIEW' | 'FAILED';
  attempts: number;
  last_error?: string | null;
  accounting_payment_id?: string | null;
  created_at: string;
  updated_at: string;
}

export interface ClientQboMap {
  client_id: string;
  qbo_customer_id: string;
  mapped_at: string;
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
