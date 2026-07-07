-- ---------------------------------------------------------------------------
-- WF1 consent capture. One consent record per (client, type) so recording a
-- grant/revocation is an idempotent upsert. `granted_at` NULL = not granted /
-- revoked; non-NULL = granted at that time.
-- ---------------------------------------------------------------------------
CREATE UNIQUE INDEX IF NOT EXISTS consents_client_type_key ON consents(client_id, type);
