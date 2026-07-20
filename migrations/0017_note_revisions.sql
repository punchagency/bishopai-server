-- Amending an approved note.
--
-- Once Nicole approves, documents are written to Drive and may already have been
-- emailed to the client. Correcting the record after that is a real need, but
-- overwriting it in place would leave no trace that what she signed off on has
-- changed. Clinical records are amended, not silently rewritten — so every
-- amendment snapshots the superseded content here first.
CREATE TABLE IF NOT EXISTS note_revisions (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- 'appointment_sheets' | 'protocols'. Not a FK: the row it points at stays
  -- live and keeps its id; this is the history behind it.
  source_table text NOT NULL,
  source_id    uuid NOT NULL,
  -- The content as it stood BEFORE the amendment that created this row.
  content_json jsonb NOT NULL,
  -- 1 for the originally approved version, incrementing per amendment.
  revision     integer NOT NULL,
  reason       text,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS note_revisions_source_idx
  ON note_revisions (source_table, source_id, revision DESC);

-- One superseded version per revision number, so a double-submit can't record
-- the same amendment twice.
CREATE UNIQUE INDEX IF NOT EXISTS note_revisions_unique
  ON note_revisions (source_table, source_id, revision);

