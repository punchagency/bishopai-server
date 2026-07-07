-- ---------------------------------------------------------------------------
-- WF4 client-facing refill reminders + follow-up/auto-close cadence.
--
-- The supplier push (refill_orders → Fullscript) already exists; this adds the
-- CLIENT-facing side: a tiered "your refill is coming / overdue" reminder, one
-- follow-up, then auto-close if the client never acts. State lives on the refill
-- row so the daily cadence pass is idempotent and resumable.
--   reminder_stage: 0 = none sent, 1 = first reminder, 2 = follow-up sent
--   reminder_next_at: date the next cadence step becomes due
-- ---------------------------------------------------------------------------
ALTER TABLE refills
  ADD COLUMN IF NOT EXISTS reminder_stage   integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS reminded_at      timestamptz,
  ADD COLUMN IF NOT EXISTS reminder_next_at date;
