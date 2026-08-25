-- A recording that has been split is finished, not waiting.
--
-- handleSplitConversation writes each segment as a child conversation and then
-- leaves the parent exactly as it found it: correlation_status 'unmatched',
-- appointment_id NULL. Both of those are now false. The consultation content
-- lives in the children, each attached to a client by a human, and the parent is
-- a superseded original that nothing should act on again.
--
-- Having no state of its own broke two things:
--
-- 1. It never leaves the review queue. That queue is `WHERE appointment_id IS
--    NULL`, so a parent is indistinguishable from a recording still waiting to
--    be identified. Two of the three rows sitting in it today are parents whose
--    work was finished days ago.
--
-- 2. It stays a correlation candidate. Under overlap matching that was harmless
--    by accident — the parent's own appointments were already taken by its
--    children and nothing else overlapped, so correlation returned no candidates
--    and moved on. Ranking by start proximity reaches further, and a parent will
--    match the client booked in a neighbouring slot: one consultation filed
--    under two different people, which is the 2026-08-20 failure wearing a
--    different hat.
--
-- So: a terminal state, in the same spirit as 'needs_review' from 0036. Nothing
-- re-correlates it, nothing extracts it, and it drops out of the queue.
ALTER TABLE conversations DROP CONSTRAINT IF EXISTS conversations_correlation_status_check;
ALTER TABLE conversations ADD CONSTRAINT conversations_correlation_status_check
  CHECK (correlation_status IN ('unmatched', 'matched', 'manual', 'walk_in', 'needs_review', 'split'));

-- Backfill the parents that already exist.
--
-- Scoped hard to 'unmatched'. A parent that is somehow 'matched' would mean one
-- recording is attributed to a client AND split into children — the very
-- double-filing this prevents — but rewriting that row's status here would
-- quietly detach whatever chart it is feeding. There are none today; if one ever
-- appears it wants a human, not a migration.
UPDATE conversations c
   SET correlation_status = 'split',
       updated_at = now()
 WHERE c.correlation_status = 'unmatched'
   AND EXISTS (SELECT 1 FROM conversations child WHERE child.parent_conversation_id = c.id);
