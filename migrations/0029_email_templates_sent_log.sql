-- ---------------------------------------------------------------------------
-- Email Templates & Send Log
--
-- email_templates: Nicole's overrides for the hardcoded cadence copy. One row
-- per (track, step); if a row exists it wins over the default at send time.
-- UNIQUE(track, step) ensures a safe upsert without duplicates.
--
-- email_send_log: append-only record of every email attempt (sent or dry-run).
-- The source of truth for history, the Queue tab (pending), and the Sent tab.
-- lead_id is a nullable FK (SET NULL) so history survives lead cleanup.
-- ---------------------------------------------------------------------------

CREATE TABLE email_templates (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  track       text NOT NULL,  -- inquiry | cancelled | maintenance | first_appointment
  step        text NOT NULL,  -- welcome | nudge_3d | nudge_7d | final_14d | cancelled_7d | …
  subject     text NOT NULL,
  body        text NOT NULL,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (track, step)
);

CREATE TABLE email_send_log (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id     uuid REFERENCES leads(id) ON DELETE SET NULL,
  track       text,           -- which cadence track drove this send
  step        text,           -- which step name (e.g. nudge_3d)
  to_email    text NOT NULL,
  subject     text NOT NULL,
  body        text NOT NULL,
  dry_run     boolean NOT NULL DEFAULT false,
  ok          boolean NOT NULL DEFAULT true,
  error       text,           -- populated when ok = false
  sent_at     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX email_send_log_lead_id_idx  ON email_send_log(lead_id, sent_at DESC);
CREATE INDEX email_send_log_sent_at_idx  ON email_send_log(sent_at DESC);
CREATE INDEX email_templates_track_step  ON email_templates(track, step);
