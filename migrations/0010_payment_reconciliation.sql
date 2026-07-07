-- ---------------------------------------------------------------------------
-- WF2 payment reconciliation (books must reconcile).
--
-- A QuickBooks *charge* (Payments API) does NOT mark the *invoice* (Accounting
-- API) paid — they're separate systems. After a successful charge we must record
-- a linked Payment against the invoice so Nicole's books balance. That write can
-- fail independently of the charge, so it is modelled as a durable transactional
-- outbox: one row per checkout, inserted in the SAME transaction that marks the
-- checkout CHARGED, then driven to completion by a background worker with
-- idempotency + capped exponential backoff + a dead-letter (NEEDS_REVIEW) state.
-- ---------------------------------------------------------------------------

-- client → QuickBooks Online Customer.Id mapping. QBO has no knowledge of a
-- Practice Better client, so this bridge is populated per client (one-time sync
-- or manual). Reconciliation reads it to know which customer the Payment is for.
CREATE TABLE client_qbo_map (
  client_id       uuid PRIMARY KEY REFERENCES clients(id) ON DELETE CASCADE,
  qbo_customer_id text NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER client_qbo_map_set_updated_at BEFORE UPDATE ON client_qbo_map
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Durable reconciliation outbox / ledger. One row per checkout (UNIQUE), so
-- enqueue is idempotent and re-detection/replay can't create duplicates.
CREATE TABLE payment_reconciliation (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  checkout_id           uuid NOT NULL UNIQUE REFERENCES checkout(id) ON DELETE CASCADE,
  provider_txn_id       text,                  -- QB Payments charge id
  invoice_id            text,                  -- QBO invoice being settled
  customer_id           text,                  -- QBO Customer.Id (resolved via client_qbo_map)
  amount_cents          integer NOT NULL,
  currency              text NOT NULL DEFAULT 'USD',
  status                text NOT NULL DEFAULT 'PENDING'
    CHECK (status IN ('PENDING', 'RECORDING', 'RECORDED', 'FAILED', 'NEEDS_REVIEW')),
  idempotency_key       text NOT NULL UNIQUE,  -- stable; also the QBO `requestid`
  attempts              integer NOT NULL DEFAULT 0,
  last_error            text,
  next_attempt_at       timestamptz NOT NULL DEFAULT now(),
  accounting_payment_id text,                  -- QBO Payment.Id once recorded
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);
-- Worker scan: due rows (PENDING/FAILED with next_attempt_at reached), soonest first.
CREATE INDEX payment_reconciliation_due_idx
  ON payment_reconciliation(status, next_attempt_at);
CREATE TRIGGER payment_reconciliation_set_updated_at BEFORE UPDATE ON payment_reconciliation
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
