-- A recording with no one speaking in it is filed as noise, not left for
-- identification.
--
-- Pocket's transcriber does not return an empty string for a recording that
-- caught no speech — it returns a single bracketed event tag and nothing else:
-- "[click]", "[background noise]", "[BLANK_AUDIO]". Two such rows landed within
-- a second of each other on 2026-09-03 — a 1-second "[click]" and a 15-second
-- "[background noise]", most likely the recorder switched on and straight back
-- off. Both went through the full correlate path, failed the matcher's
-- one-minute floor, and came to rest in the Unmatched review queue as ordinary
-- "tag a client" rows with nothing in them to tag or extract.
--
-- `ingestConversation` now recognises that shape before correlation runs and
-- files it 'discarded': a terminal state, in the same spirit as 'split' from
-- 0038 and 'needs_review' from 0036. The row is still stored — provenance, and
-- so a redelivery stays idempotent on (source, source_id) — but the review
-- queue, the extraction drain and the correlation sweep all pass over it.
ALTER TABLE conversations DROP CONSTRAINT IF EXISTS conversations_correlation_status_check;
ALTER TABLE conversations ADD CONSTRAINT conversations_correlation_status_check
  CHECK (correlation_status IN
    ('unmatched', 'matched', 'manual', 'walk_in', 'needs_review', 'split', 'discarded'));

-- Backfill the rows that already exist.
--
-- Scoped to rows the matcher never placed (no appointment, still 'unmatched'),
-- that are not a split parent's child slice, under a minute long, and whose
-- transcript has no alphanumeric character left once bracketed tags are removed.
-- That predicate is the SQL twin of classifyNoiseRecording() in ingest.ts; if
-- the two ever drift, this migration is a historical record and ingest.ts is
-- the one that decides.
UPDATE conversations
   SET correlation_status = 'discarded',
       correlation_hold_reason = COALESCE(
         correlation_hold_reason,
         'Transcript contains no speech; filed as noise (0041 backfill).'),
       updated_at = now()
 WHERE correlation_status = 'unmatched'
   AND appointment_id IS NULL
   AND parent_conversation_id IS NULL
   AND transcript IS NOT NULL
   AND EXTRACT(EPOCH FROM (ends_at - starts_at)) < 60
   AND regexp_replace(
         regexp_replace(transcript, '\[[^\]]*\]', ' ', 'g'),
         '[^[:alnum:]]', '', 'g'
       ) = '';
