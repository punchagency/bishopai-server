-- Unified, append-only audit trail across every workflow.
--
-- Existing records (approvals, note_revisions, payment_reconciliation,
-- system_events) are siloed or ops-flavoured. This is the one place that answers
-- "everything that happened to this client / checkout / session, newest first,
-- and who did it." APPEND-ONLY by contract: no UPDATE, no DELETE — an audit you
-- can rewrite isn't one. (No updated_at, no trigger, intentionally.)
CREATE TABLE audit_log (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- What kind of thing this is about, and its id. entity_id is text (not a uuid
  -- FK) so singletons like 'office_hours' and never-deleted history both fit, and
  -- so a purge of the underlying row never cascades away its audit trail.
  entity_type  text NOT NULL,   -- 'checkout' | 'session' | 'conversation' | 'client' | 'task' | 'refill' | 'lead' | 'office_hours' | 'customer_map' | 'outlook'
  entity_id    text NOT NULL,
  action       text NOT NULL,   -- e.g. 'checkout.charge_captured', 'session.amended'
  -- Who did it: 'nicole' for a dashboard action, 'system' for the scheduler /
  -- webhooks / automatic correlation.
  actor        text NOT NULL DEFAULT 'system',
  summary      text NOT NULL,   -- human-readable one-liner for the activity feed
  metadata     jsonb,           -- structured detail (amounts, ids, before/after)
  created_at   timestamptz NOT NULL DEFAULT now()
);

-- Per-entity history: "show me this checkout's / client's trail, newest first."
CREATE INDEX audit_log_entity_idx ON audit_log(entity_type, entity_id, created_at DESC);
-- Global activity feed, newest first.
CREATE INDEX audit_log_recent_idx ON audit_log(created_at DESC);

-- Backfill existing approvals into the audit trail so past history is preserved.
INSERT INTO audit_log (entity_type, entity_id, action, actor, summary, metadata, created_at)
SELECT 
  CASE 
    WHEN type = 'session' THEN 'session'
    WHEN type = 'checkout' THEN 'checkout'
    WHEN type = 'refill_bulk_send' THEN 'refill'
    ELSE 'session'
  END AS entity_type,
  COALESCE(payload_json->>'appointment_id', payload_json->>'checkout_id', id::text) AS entity_id,
  CASE 
    WHEN type = 'session' THEN 'session.approved'
    WHEN type = 'checkout' THEN 'checkout.approved'
    WHEN type = 'refill_bulk_send' THEN 'refill.ordered'
    ELSE 'session.approved'
  END AS action,
  COALESCE(approved_by, 'nicole') AS actor,
  CASE
    WHEN type = 'session' THEN 'Approved session — documents published'
    WHEN type = 'checkout' THEN 'Approved checkout charge'
    WHEN type = 'refill_bulk_send' THEN 'Refill bulk send approved'
    ELSE 'Approved action'
  END AS summary,
  payload_json AS metadata,
  approved_at AS created_at
FROM approvals;

