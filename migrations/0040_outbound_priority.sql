-- ---------------------------------------------------------------------------
-- Priority lane for the outbound approval queue
--
-- Closes the last automated send path. The enquiry welcome used to bypass the
-- queue entirely (reengagement/runner.ts's EXEMPT_STEP), on the sound reasoning
-- that someone who has just written in is owed a reply NOW and holding it for a
-- weekly review answers a Tuesday enquiry on Friday.
--
-- That reasoning is about LATENCY, not about approval — so the fix is a faster
-- lane through the queue rather than a way around it. An urgent item is
-- reviewed the same day and dropped after one, instead of sitting a week:
-- a "thanks for reaching out" that lands three days late is worse than one that
-- was never promised.
--
-- Existing rows are 'normal', which is what they have always behaved as.
-- ---------------------------------------------------------------------------

ALTER TABLE outbound_emails
  ADD COLUMN IF NOT EXISTS priority text NOT NULL DEFAULT 'normal';

ALTER TABLE outbound_emails
  DROP CONSTRAINT IF EXISTS outbound_emails_priority_check;
ALTER TABLE outbound_emails
  ADD CONSTRAINT outbound_emails_priority_check
  CHECK (priority IN ('urgent', 'normal'));

-- The Overview's "needs you today" count, and the urgent-first ordering in the
-- review panel. Partial: only pending rows are ever asked about.
CREATE INDEX IF NOT EXISTS outbound_emails_priority_idx
  ON outbound_emails (priority, send_after)
  WHERE state = 'pending';
