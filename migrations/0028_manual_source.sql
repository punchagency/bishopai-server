-- A third recorder: the practitioner herself, by hand.
--
-- Pocket is the automated ingress, but a session recorded elsewhere (an
-- Otter.ai export, a transcript Pocket missed) has no way in. Manual import
-- lands such a transcript as an ordinary conversation so it flows through the
-- same correlate → review → publish pipeline. It needs its own `source` value
-- for two reasons that mirror why 'bee'/'pocket' are distinguished at all:
--   • its ids live in yet another namespace (`manual:<sha256>` of the pasted
--     text, so re-pasting the same transcript deduplicates), and
--   • provenance matters clinically — a note built from a hand-pasted transcript
--     should be traceable as such, not indistinguishable from a device capture.
--
-- The composite unique index from 0027 (source, source_id) already covers the
-- new namespace; only the CHECK needs widening. `correlation_status` is
-- untouched: a manual import lands 'unmatched' and reaches 'matched'/'walk_in'
-- through the existing manual-attach routes.
ALTER TABLE conversations DROP CONSTRAINT IF EXISTS conversations_source_check;
ALTER TABLE conversations ADD CONSTRAINT conversations_source_check
  CHECK (source IN ('bee', 'pocket', 'manual'));
