-- 0032_consent_status.sql
-- Add revoked_at column to consents table to support explicit consent revocation.

ALTER TABLE consents
  ADD COLUMN IF NOT EXISTS revoked_at timestamptz;
