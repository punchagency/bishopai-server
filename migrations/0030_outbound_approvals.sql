-- ---------------------------------------------------------------------------
-- Outbound approval queue
--
-- Every automated client-facing email is written here first and sends only once
-- a person has approved it. Before this, `runner.ts` and `remindersRunner.ts`
-- called sendEmail() the moment a step fell due — the scheduler was already
-- enabled, and the only thing standing between the cadences and a client's inbox
-- was that no Outlook mailbox had been connected yet.
--
-- `list` is the split Nicole reviews by: 'cancelled' is the win-back track for
-- people who cancelled a booking, 'normal' is everything else. `category` is the
-- reason within a list, so a weekly review can be read a group at a time:
--   enquiry           — new prospect cadence
--   appointment_lapse — came once and never rebooked, or past the session gap
--   dose_lapse        — supplements running out / already overdue
--   protocol          — protocol documents mailed to the client
--   cancelled         — the win-back track itself
--
-- dedupe_key is what makes the weekly assembly safe to re-run: it is derived
-- from the recipient plus what generated the item, so a second pass over the
-- same due step updates nothing rather than queueing a duplicate. Only live
-- rows participate — a rejected or expired item must not block the same nudge
-- being offered again in a later cycle — which is why the uniqueness is a
-- partial index over pending/approved rather than a column constraint.
-- ---------------------------------------------------------------------------

CREATE TABLE outbound_emails (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  list            text NOT NULL,          -- normal | cancelled
  category        text NOT NULL,          -- enquiry | appointment_lapse | dose_lapse | protocol | cancelled
  lead_id         uuid REFERENCES leads(id) ON DELETE SET NULL,
  client_id       uuid REFERENCES clients(id) ON DELETE SET NULL,
  to_email        text NOT NULL,
  subject         text NOT NULL,
  body            text NOT NULL,

  -- When the cadence says this is due, and the point past which sending it does
  -- more harm than not sending it: a "just checking in" that lands three weeks
  -- late reads worse than silence.
  send_after      timestamptz NOT NULL DEFAULT now(),
  expires_at      timestamptz NOT NULL,

  state           text NOT NULL DEFAULT 'pending',
                  -- pending | approved | rejected | sent | expired | failed
  approved_by     text,
  approved_at     timestamptz,
  rejected_reason text,

  -- What produced this, e.g. 'cadence:first_appointment:first_appt_7d' or
  -- 'refill:<uuid>'. Kept so review can say WHY an email exists, and so the
  -- cadence step can be marked consumed when the item expires.
  source_ref      text NOT NULL,
  dedupe_key      text NOT NULL,

  sent_at         timestamptz,
  error           text,
  created_at      timestamptz NOT NULL DEFAULT now()
);

-- One live item per recipient per reason. Rejected/expired/sent rows fall out of
-- the index so a later cycle can legitimately offer the same step again.
CREATE UNIQUE INDEX outbound_emails_live_dedupe
  ON outbound_emails (dedupe_key)
  WHERE state IN ('pending', 'approved');

-- The review screen: pending, oldest first, filtered by list.
CREATE INDEX outbound_emails_pending_idx
  ON outbound_emails (list, state, send_after);

-- The daily send pass and the expiry sweep.
CREATE INDEX outbound_emails_state_idx ON outbound_emails (state, send_after);
CREATE INDEX outbound_emails_lead_idx  ON outbound_emails (lead_id, created_at DESC);
