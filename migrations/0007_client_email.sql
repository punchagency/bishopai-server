-- ---------------------------------------------------------------------------
-- clients.email — needed to re-engage a client who cancels (WF3 cancelled
-- cadence). Populated from the PB booking webhook when PB includes it; nullable
-- because older bookings and PB payloads without an email still upsert cleanly.
-- ---------------------------------------------------------------------------
ALTER TABLE clients ADD COLUMN IF NOT EXISTS email text;
CREATE INDEX IF NOT EXISTS clients_email_idx ON clients(email);
