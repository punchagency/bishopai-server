-- 0003_session_extraction.sql — wire transcript extraction into the pipeline.
-- Tracks per-conversation extraction state and makes the generated artifacts
-- idempotent so a re-run upserts rather than duplicates.

ALTER TABLE conversations
  ADD COLUMN extraction_status text NOT NULL DEFAULT 'pending'
    CHECK (extraction_status IN ('pending', 'processing', 'done', 'failed'));
CREATE INDEX conversations_extraction_status_idx ON conversations(extraction_status);

-- One appointment sheet per appointment => idempotent upsert target.
CREATE UNIQUE INDEX appointment_sheets_appointment_id_key
  ON appointment_sheets(appointment_id);

-- Tie a generated protocol to its originating appointment. A plain unique
-- index treats NULLs as distinct, so hand-authored protocols without an
-- appointment_id are unaffected; generated ones upsert by appointment_id.
ALTER TABLE protocols
  ADD COLUMN appointment_id uuid REFERENCES appointments(id) ON DELETE SET NULL;
CREATE UNIQUE INDEX protocols_appointment_id_key ON protocols(appointment_id);
