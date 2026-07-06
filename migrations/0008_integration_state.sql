-- ---------------------------------------------------------------------------
-- integration_state — tiny key/value store for integration sync cursors (e.g.
-- the Outlook inbox poller's last-seen receivedDateTime). Keeps incremental
-- pollers idempotent across restarts without a bespoke table each.
-- ---------------------------------------------------------------------------
CREATE TABLE integration_state (
  key        text PRIMARY KEY,
  value      text,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER integration_state_set_updated_at BEFORE UPDATE ON integration_state
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
