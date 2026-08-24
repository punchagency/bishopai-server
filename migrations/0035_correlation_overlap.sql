-- Record how many seconds a recording actually overlapped the matched appointment.
--
-- A match where the recording bleeds 2 minutes into an appointment is qualitatively
-- different from one where the recording sits squarely inside it.  Persisting this
-- lets the review dashboard flag low-confidence matches (e.g. < 5 min overlap)
-- before they silently produce notes attributed to the wrong client.
--
-- NULL = unmatched, or matched before this migration.  Backfill is intentionally
-- skipped: historical matches already extracted cannot be re-evaluated cheaply, and
-- a NULL here is visually distinct from 0 (which would mean zero overlap — a bug).
ALTER TABLE conversations
  ADD COLUMN IF NOT EXISTS correlation_overlap_seconds INTEGER;

COMMENT ON COLUMN conversations.correlation_overlap_seconds IS
  'Seconds of overlap between the recording window and the matched appointment. '
  'NULL for unmatched rows or rows matched before this column existed. '
  'A small value (< 300) relative to the appointment duration signals a marginal match.';
