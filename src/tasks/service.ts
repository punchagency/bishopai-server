import type { Pool, PoolClient } from 'pg';
import { pool } from '../db/pool';
import type { SessionNote } from '../session/extract';
import { dueDateFrom, normalizeFollowUps } from '../session/followups';

// Follow-ups, promoted from text to tracked work. Created on approval — the same
// gate as every other side effect in the system: Nicole read the note and stood
// behind it, so its commitments are real. Nothing here contacts a client; tasks
// surface in the cockpit and in the next visit's prep brief, and that is all.

export type TaskStatus = 'open' | 'done' | 'dismissed';

export interface TaskRow {
  id: string;
  client_id: string;
  client_name: string | null;
  appointment_id: string | null;
  title: string;
  due_date: string | null;
  status: TaskStatus;
  source: 'session' | 'manual';
  created_at: string;
  completed_at: string | null;
}

type Db = Pool | PoolClient;

/**
 * Promote an approved note's follow-ups into tasks. Idempotent: the partial unique
 * index on (appointment_id, title) absorbs both the sheet-then-protocol double
 * approval and any re-approval, so this can be called freely.
 *
 * Due dates anchor to the appointment, not to approval time — a note signed off
 * three days late still means "four weeks from the session".
 */
export async function createTasksFromNote(
  db: Db,
  args: { clientId: string; appointmentId: string | null; sessionDate: Date; note: SessionNote },
): Promise<{ created: number }> {
  const followUps = normalizeFollowUps(args.note.follow_ups);
  if (followUps.length === 0) return { created: 0 };

  let created = 0;
  for (const f of followUps) {
    const r = await db.query(
      `INSERT INTO tasks (client_id, appointment_id, title, due_date, source)
            VALUES ($1, $2, $3, $4, 'session')
       ON CONFLICT DO NOTHING`,
      [args.clientId, args.appointmentId, f.text, dueDateFrom(args.sessionDate, f.dueInDays)],
    );
    created += r.rowCount ?? 0;
  }
  return { created };
}

const SELECT_TASK = `
  SELECT t.id, t.client_id, c.name AS client_name, t.appointment_id, t.title,
         t.due_date::text AS due_date, t.status, t.source, t.created_at, t.completed_at
    FROM tasks t
    LEFT JOIN clients c ON c.id = t.client_id`;

/** Open tasks for the cockpit: overdue and undated first, then by due date. */
export async function listOpenTasks(clientId?: string): Promise<TaskRow[]> {
  const where = clientId ? `WHERE t.status = 'open' AND t.client_id = $1` : `WHERE t.status = 'open'`;
  const r = await pool.query<TaskRow>(
    `${SELECT_TASK} ${where}
      ORDER BY t.due_date ASC NULLS LAST, t.created_at ASC`,
    clientId ? [clientId] : [],
  );
  return r.rows;
}

export async function setTaskStatus(id: string, status: TaskStatus): Promise<TaskRow | null> {
  const r = await pool.query<TaskRow>(
    `WITH upd AS (
       UPDATE tasks
          SET status = $2,
              completed_at = CASE WHEN $2 = 'open' THEN NULL ELSE now() END
        WHERE id = $1
        RETURNING *
     )
     ${SELECT_TASK.replace('FROM tasks t', 'FROM upd t')}`,
    [id, status],
  );
  return r.rows[0] ?? null;
}

export async function createManualTask(args: {
  clientId: string;
  title: string;
  dueDate: string | null;
}): Promise<TaskRow> {
  const r = await pool.query<{ id: string }>(
    `INSERT INTO tasks (client_id, title, due_date, source)
          VALUES ($1, $2, $3, 'manual') RETURNING id`,
    [args.clientId, args.title, args.dueDate],
  );
  const row = await pool.query<TaskRow>(`${SELECT_TASK} WHERE t.id = $1`, [r.rows[0].id]);
  return row.rows[0];
}
