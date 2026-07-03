-- ---------------------------------------------------------------------------
-- WF3 Lead & Re-engagement. `leads` + `messages` already exist (0001); this
-- adds `lead_activity` — the per-lead engagement trail (website visits, form
-- opens/submits, email opens, replies, bookings) that feeds both the cadence
-- decisions and the Engagement dashboard's "who's visiting / high-intent" view.
-- ---------------------------------------------------------------------------
CREATE TABLE lead_activity (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id     uuid REFERENCES leads(id) ON DELETE CASCADE,
  type        text NOT NULL,   -- page_view | form_open | form_submit | email_open | reply | booked
  path        text,            -- e.g. /book-a-consult (site activity)
  detail      text,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX lead_activity_lead_id_idx ON lead_activity(lead_id);
CREATE INDEX lead_activity_occurred_at_idx ON lead_activity(occurred_at);
CREATE INDEX lead_activity_type_idx ON lead_activity(type);
