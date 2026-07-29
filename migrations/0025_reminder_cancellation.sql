-- ---------------------------------------------------------------------------
-- Cancellable client-facing reminders.
--
-- Every automated email to a client (refill cadence, WF3 re-engagement) is now
-- listed on the dashboard before it goes out, with the date it will send. That
-- listing is only honest if Nicole can stop one — a client who told her in the
-- room "I already reordered" should not get a reminder three days later.
--
-- Cancelling is per-cadence, not per-send: it stops the whole remaining sequence
-- for that refill / lead. It is deliberately NOT a status change — the refill
-- stays in the digest so Nicole still sees it running low; only the automated
-- email is silenced. Nullable timestamp so it doubles as the audit trail (when),
-- and clearing it resumes the cadence exactly where it left off.
-- ---------------------------------------------------------------------------
ALTER TABLE refills
  ADD COLUMN IF NOT EXISTS reminders_cancelled_at timestamptz;

ALTER TABLE leads
  ADD COLUMN IF NOT EXISTS cadence_cancelled_at timestamptz;
