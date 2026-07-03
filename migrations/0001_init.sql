-- 0001_init.sql — Innerlume backend base schema (build plan v3, §4 + §6).
-- The migration runner wraps this file in a single transaction, so no
-- explicit BEGIN/COMMIT here.

CREATE EXTENSION IF NOT EXISTS pgcrypto;   -- gen_random_uuid()

-- Auto-maintain updated_at on tables that carry it.
CREATE OR REPLACE FUNCTION set_updated_at() RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- ---------------------------------------------------------------------------
-- clients
-- ---------------------------------------------------------------------------
CREATE TABLE clients (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name            text NOT NULL,
  pb_id           text UNIQUE,                 -- Practice Better client id
  drive_folder_id text,
  phase           text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER clients_set_updated_at BEFORE UPDATE ON clients
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------------
-- appointments (landed from Zapier booking webhooks — no PB read needed)
-- ---------------------------------------------------------------------------
CREATE TABLE appointments (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id  uuid REFERENCES clients(id) ON DELETE SET NULL,
  pb_id      text UNIQUE,                       -- PB appointment id
  starts_at  timestamptz NOT NULL,              -- 'start'/'end' are reserved words
  ends_at    timestamptz NOT NULL,
  status     text NOT NULL DEFAULT 'confirmed',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX appointments_client_id_idx ON appointments(client_id);
-- Correlation queries overlap a conversation window against this range.
CREATE INDEX appointments_time_idx ON appointments(starts_at, ends_at);
CREATE TRIGGER appointments_set_updated_at BEFORE UPDATE ON appointments
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------------
-- conversations — Bee recordings. appointment_id is THE join.
-- NULL appointment_id + 'unmatched' => held for manual tag, never auto-guessed.
-- ---------------------------------------------------------------------------
CREATE TABLE conversations (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  bee_id             text UNIQUE NOT NULL,
  starts_at          timestamptz NOT NULL,
  ends_at            timestamptz NOT NULL,
  transcript         text,
  appointment_id     uuid REFERENCES appointments(id) ON DELETE SET NULL,
  client_id          uuid REFERENCES clients(id) ON DELETE SET NULL,
  correlation_status text NOT NULL DEFAULT 'unmatched'
    CHECK (correlation_status IN ('unmatched', 'matched', 'manual')),
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX conversations_appointment_id_idx ON conversations(appointment_id);
CREATE INDEX conversations_time_idx ON conversations(starts_at, ends_at);
CREATE TRIGGER conversations_set_updated_at BEFORE UPDATE ON conversations
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------------
-- appointment_sheets (internal) + protocols (client-facing)
-- ---------------------------------------------------------------------------
CREATE TABLE appointment_sheets (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  appointment_id uuid NOT NULL REFERENCES appointments(id) ON DELETE CASCADE,
  client_id      uuid REFERENCES clients(id) ON DELETE SET NULL,
  content_json   jsonb NOT NULL DEFAULT '{}'::jsonb,
  status         text NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'in_review', 'approved')),
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER appointment_sheets_set_updated_at BEFORE UPDATE ON appointment_sheets
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE protocols (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id    uuid NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  content_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  status       text NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'in_review', 'approved')),
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER protocols_set_updated_at BEFORE UPDATE ON protocols
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------------
-- supplements — the refill timeline source
-- ---------------------------------------------------------------------------
CREATE TABLE supplements (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id  uuid NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  name       text NOT NULL,
  dose       text,
  qty        integer,
  start_date date,
  source     text,                              -- notes | fullscript | pb
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX supplements_client_id_idx ON supplements(client_id);
CREATE TRIGGER supplements_set_updated_at BEFORE UPDATE ON supplements
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------------
-- documents
-- ---------------------------------------------------------------------------
CREATE TABLE documents (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id     uuid NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  drive_file_id text,
  type          text,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX documents_client_id_idx ON documents(client_id);

-- ---------------------------------------------------------------------------
-- leads (WF3)
-- ---------------------------------------------------------------------------
CREATE TABLE leads (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source         text,
  email          text,
  status         text NOT NULL DEFAULT 'new',
  sequence_state jsonb NOT NULL DEFAULT '{}'::jsonb,
  last_touch     timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX leads_email_idx ON leads(email);
CREATE TRIGGER leads_set_updated_at BEFORE UPDATE ON leads
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------------
-- messages — belongs to exactly one of client / lead
-- ---------------------------------------------------------------------------
CREATE TABLE messages (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id  uuid REFERENCES clients(id) ON DELETE CASCADE,
  lead_id    uuid REFERENCES leads(id) ON DELETE CASCADE,
  channel    text NOT NULL,
  body       text,
  sent_at    timestamptz,
  status     text NOT NULL DEFAULT 'queued',
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT messages_one_recipient CHECK (
    (client_id IS NOT NULL)::int + (lead_id IS NOT NULL)::int = 1
  )
);
CREATE INDEX messages_client_id_idx ON messages(client_id);
CREATE INDEX messages_lead_id_idx ON messages(lead_id);

-- ---------------------------------------------------------------------------
-- checkout — WF2 state machine (§6). Declared before approvals (FK target).
-- ---------------------------------------------------------------------------
CREATE TABLE checkout (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  appointment_id         uuid REFERENCES appointments(id) ON DELETE SET NULL,
  client_id              uuid REFERENCES clients(id) ON DELETE SET NULL,
  pb_appointment_id      text,
  status                 text NOT NULL DEFAULT 'DETECTED'
    CHECK (status IN (
      'DETECTED', 'SUMMARY_READY', 'AWAITING_APPROVAL', 'CHARGING',
      'CHARGED', 'DOCS_UPDATED', 'PB_MARKED', 'CLOSED', 'CHARGE_FAILED'
    )),
  detection_hash         text,                  -- makes re-detection a no-op
  summary_snapshot       jsonb,                 -- frozen; what Nicole approves
  qb_invoice_id          text,
  qb_txn_id              text,
  charge_idempotency_key text UNIQUE,           -- QB request-id; never double-charge
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now()
);
-- One live checkout per PB appointment => re-detection is idempotent.
CREATE UNIQUE INDEX checkout_pb_appointment_id_idx
  ON checkout(pb_appointment_id) WHERE pb_appointment_id IS NOT NULL;
CREATE TRIGGER checkout_set_updated_at BEFORE UPDATE ON checkout
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------------
-- approvals — unified audit table (§4 + §6 + §7).
-- Money approvals carry checkout_id + amount + summary_hash; lighter approvals
-- (refill digest, review-queue edits) reuse the same table.
-- ---------------------------------------------------------------------------
CREATE TABLE approvals (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  checkout_id  uuid REFERENCES checkout(id) ON DELETE SET NULL,
  type         text NOT NULL,
  payload_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  status       text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'approved', 'rejected', 'skipped')),
  amount_cents integer,
  currency     text DEFAULT 'USD',
  summary_hash text,                            -- binds approval to the exact figure shown
  approved_by  text,
  approved_at  timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX approvals_checkout_id_idx ON approvals(checkout_id);

-- ---------------------------------------------------------------------------
-- refills (WF4)
-- ---------------------------------------------------------------------------
CREATE TABLE refills (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id     uuid NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  supplement_id uuid REFERENCES supplements(id) ON DELETE SET NULL,
  due_date      date,
  status        text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'notified', 'snoozed', 'closed')),
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX refills_due_date_idx ON refills(due_date);
CREATE TRIGGER refills_set_updated_at BEFORE UPDATE ON refills
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------------
-- consents — passive session-recording consent (Week 0 risk item)
-- ---------------------------------------------------------------------------
CREATE TABLE consents (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id  uuid NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  type       text NOT NULL,
  granted_at timestamptz,
  notes      text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX consents_client_id_idx ON consents(client_id);
