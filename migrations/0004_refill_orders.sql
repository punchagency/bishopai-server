-- ---------------------------------------------------------------------------
-- WF4 Refill Intelligence.
--
-- (1) A partial unique index on refills(supplement_id) so the nightly
--     projection can upsert one refill row per supplement idempotently
--     (ON CONFLICT). supplement_id is nullable (ON DELETE SET NULL), so the
--     uniqueness only applies to rows that still point at a supplement.
--
-- (2) refill_orders — tracks bulk sends to Fullscript. One "batch" groups many
--     clients' orders sent in a single action; each row is one client's order
--     so Nicole can see which clients have received their refills and which
--     have not.
-- ---------------------------------------------------------------------------

CREATE UNIQUE INDEX refills_supplement_id_key
  ON refills(supplement_id) WHERE supplement_id IS NOT NULL;

CREATE TABLE refill_orders (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_id            uuid NOT NULL,               -- one bulk send groups many orders
  client_id           uuid REFERENCES clients(id) ON DELETE SET NULL,
  refill_id           uuid REFERENCES refills(id) ON DELETE SET NULL,
  supplement_name     text,
  status              text NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'sent', 'received', 'failed')),
  fullscript_order_id text,                        -- id returned by Fullscript
  error               text,                        -- populated when status='failed'
  sent_at             timestamptz,
  received_at         timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX refill_orders_batch_id_idx ON refill_orders(batch_id);
CREATE INDEX refill_orders_client_id_idx ON refill_orders(client_id);
CREATE INDEX refill_orders_status_idx ON refill_orders(status);
CREATE TRIGGER refill_orders_set_updated_at BEFORE UPDATE ON refill_orders
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
