export interface Client {
  id: string;
  name: string;
  email: string;
  phone?: string;
  fullscript_patient_id?: string;
  created_at: string;
  updated_at: string;
}

export interface Appointment {
  id: string;
  client_id: string;
  start_time: string; // ISO date string
  end_time: string;   // ISO date string
  status: string;
  service_type?: string;
  created_at: string;
}

export interface Conversation {
  id: string;
  appointment_id?: string | null;
  transcript: string;
  duration_seconds?: number;
  audio_url?: string;
  status: 'matched' | 'unmatched' | 'processed';
  match_confidence?: number;
  correlation_reason?: string;
  candidate_matches?: Array<{ appointment_id: string; score: number; reason?: string }>;
  created_at: string;
}

export interface SessionNoteRecord {
  id: string;
  appointment_id: string;
  conversation_id?: string;
  client_id?: string;
  note_data: Record<string, unknown>; // SessionNote schema
  status: 'draft' | 'approved';
  extraction_status: 'pending' | 'processing' | 'done' | 'failed';
  extraction_error?: string | null;
  created_at: string;
  updated_at: string;
}

export interface Approval {
  id: string;
  appointment_id: string;
  approved_by: string;
  approved_at: string;
  doc_hash?: string;
  amount_charged?: number;
}

export interface Revision {
  id: string;
  appointment_id: string;
  note_data: Record<string, unknown>;
  revised_by: string;
  revised_at: string;
}

export interface Checkout {
  id: string;
  appointment_id: string;
  amount: number;
  currency: string;
  status: 'pending' | 'approved' | 'charged' | 'reconciled' | 'failed';
  summary_snapshot?: Record<string, unknown>;
  hash?: string;
  qb_charge_id?: string;
  created_at: string;
  updated_at: string;
}

export interface Refill {
  id: string;
  client_id: string;
  supplement_name: string;
  dose?: string;
  schedule?: string;
  run_out_date: string;
  status: 'overdue' | 'due_soon' | 'normal' | 'snoozed' | 'skipped';
  snooze_until?: string | null;
  skip_until?: string | null;
  updated_at: string;
}

export interface RefillOrder {
  id: string;
  client_id: string;
  fullscript_order_id?: string;
  items: Array<{ supplement_name: string; quantity: number }>;
  status: 'pending' | 'sent' | 'failed';
  created_at: string;
}

export interface Lead {
  id: string;
  name: string;
  email: string;
  cadence_state: string;
  last_contacted_at?: string;
  created_at: string;
}

export interface LeadActivity {
  id: string;
  lead_id: string;
  activity_type: string;
  payload?: Record<string, unknown>;
  created_at: string;
}

export interface TaskItem {
  id: string;
  appointment_id?: string;
  client_id?: string;
  description: string;
  due_date?: string;
  status: 'pending' | 'completed';
  created_at: string;
}

export interface AuditLog {
  id: string;
  event_type: string;
  payload?: Record<string, unknown>;
  created_at: string;
}
