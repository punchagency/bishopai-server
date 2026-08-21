-- 0031_documents_metadata.sql
-- Extend documents table with appointment link, drive url, title/name and status.

ALTER TABLE documents
  ADD COLUMN IF NOT EXISTS appointment_id uuid REFERENCES appointments(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS drive_url      text,
  ADD COLUMN IF NOT EXISTS name           text,
  ADD COLUMN IF NOT EXISTS status         text NOT NULL DEFAULT 'published';

CREATE INDEX IF NOT EXISTS documents_appointment_id_idx ON documents(appointment_id);
