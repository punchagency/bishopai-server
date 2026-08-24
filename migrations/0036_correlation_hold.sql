-- A recording that may span more than one consultation must not land in any
-- chart, and must not sit in `unmatched` either.
--
-- `unmatched` is a queue the correlation sweep keeps retrying, and retrying is
-- exactly wrong here: the failure is not "we could not find the appointment",
-- it is "this audio contains more than one client, so no single appointment is
-- the right answer". Left in `unmatched` the sweep would eventually find one
-- overlapping appointment and confidently file three people's clinical content
-- under whoever it picked. That is what happened on 2026-08-20.
--
-- So: a third terminal state that neither extracts nor re-correlates, and only
-- a human (splitting the recording) can move out of.
ALTER TABLE conversations DROP CONSTRAINT IF EXISTS conversations_correlation_status_check;
ALTER TABLE conversations ADD CONSTRAINT conversations_correlation_status_check
  CHECK (correlation_status IN ('unmatched', 'matched', 'manual', 'walk_in', 'needs_review'));

-- Why it was held, in words a human can act on. Without this the review queue
-- shows a held recording with no way to tell "four speakers" from "two clients
-- named in the transcript" from "two appointments overlap this window" — and
-- those want different actions from Nicole.
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS correlation_hold_reason text;

-- The sweep and the review queue both filter on this state; without an index
-- they scan every conversation ever recorded to find the handful being held.
CREATE INDEX IF NOT EXISTS conversations_needs_review_idx
  ON conversations (starts_at DESC)
  WHERE correlation_status = 'needs_review';
