-- 0002_system_events.sql — persistent error/event log.
-- Errors and operationally-significant warnings land here (not just stdout) so
-- failures that need manual follow-up survive a restart and are queryable.

CREATE TABLE system_events (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  level      text NOT NULL CHECK (level IN ('error', 'warn', 'info')),
  source     text NOT NULL,                 -- e.g. 'webhook.bee_conversation', 'bee.stream'
  message    text NOT NULL,
  context    jsonb,                          -- error message/stack + any structured detail
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX system_events_created_at_idx ON system_events(created_at DESC);
CREATE INDEX system_events_level_idx ON system_events(level);
