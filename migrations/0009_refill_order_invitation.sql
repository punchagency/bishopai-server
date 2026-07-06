-- ---------------------------------------------------------------------------
-- refill_orders.invitation_url — the Fullscript treatment-plan link returned
-- when a refill is sent, persisted so the dashboard can show it on the refill
-- card across reloads (not just in the transient send response).
-- ---------------------------------------------------------------------------
ALTER TABLE refill_orders ADD COLUMN IF NOT EXISTS invitation_url text;
