-- Follow-ups as real work items. Until now a session's follow_ups were dead text:
-- extracted, rendered into the note + Flow Sheet, and never tracked. A task is the
-- durable version — it has a due date, it can be completed, and it shows up in the
-- prep brief for the client's next visit.
CREATE TABLE IF NOT EXISTS tasks (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id      uuid NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  -- The session that produced it. NULL for tasks Nicole types in herself, and for
  -- session tasks whose appointment is later deleted (the task still stands).
  appointment_id uuid REFERENCES appointments(id) ON DELETE SET NULL,
  title          text NOT NULL,
  -- NULL is a legitimate, common value: "recheck in 4 weeks" carries a date,
  -- "keep an eye on her sleep" does not. We never invent one.
  due_date       date,
  status         text NOT NULL DEFAULT 'open'
                 CHECK (status IN ('open', 'done', 'dismissed')),
  source         text NOT NULL DEFAULT 'session'
                 CHECK (source IN ('session', 'manual')),
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  completed_at   timestamptz
);

-- Approving a sheet and its protocol both carry the same follow_ups, and a
-- re-approval replays them. This is what makes task creation idempotent: the
-- second write hits the conflict and does nothing.
CREATE UNIQUE INDEX IF NOT EXISTS tasks_session_unique
  ON tasks (appointment_id, title)
  WHERE appointment_id IS NOT NULL AND source = 'session';

CREATE INDEX IF NOT EXISTS tasks_client_idx ON tasks (client_id);
CREATE INDEX IF NOT EXISTS tasks_open_idx   ON tasks (status, due_date) WHERE status = 'open';

DROP TRIGGER IF EXISTS tasks_set_updated_at ON tasks;
CREATE TRIGGER tasks_set_updated_at BEFORE UPDATE ON tasks
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
