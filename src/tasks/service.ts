import { getDatabase } from '../db/index.js';
import type { SessionNote } from '../session/extract.js';
import { dueDateFrom, normalizeFollowUps } from '../session/followups.js';
import { recordAudit } from '../audit/log.js';
import { taskDocId } from '../db/ids.js';
import type { TaskItem } from '../db/interfaces/types.js';

export type TaskStatus = 'open' | 'done' | 'dismissed';

/**
 * Sort sentinel for tasks with no due date. Firestore excludes documents that are
 * MISSING an orderBy field from the result entirely, and `0015_tasks.sql` calls a
 * null due_date a legitimate, common value ("keep an eye on her sleep"). Writing
 * a far-future sentinel keeps those tasks in the result and sorts them last,
 * reproducing `ORDER BY due_date ASC NULLS LAST`.
 */
const DUE_SORT_NEVER = '9999-12-31';

const randomTaskId = (kind: 'session' | 'manual'): string =>
  `task_${kind}_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;

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

export async function createTasksFromNote(
  args: { clientId: string; appointmentId: string | null; sessionDate: Date; note: SessionNote },
): Promise<{ created: number }> {
  const followUps = normalizeFollowUps(args.note.follow_ups);
  if (followUps.length === 0) return { created: 0 };

  const db = getDatabase();
  const client = await db.clients.findById(args.clientId);
  let created = 0;

  for (const f of followUps) {
    const title = f.text;
    const dueDate = dueDateFrom(args.sessionDate, f.dueInDays);
    // Appointment-bound tasks get a deterministic id so a replayed approval
    // collides instead of duplicating. Tasks with no appointment carry no
    // uniqueness — same as the partial Postgres index — so they get a fresh id.
    const id = taskDocId(args.appointmentId, title) ?? randomTaskId('session');

    const landed = await db.tasks.create({
      id,
      client_id: args.clientId,
      client_name: client?.name || null,
      appointment_id: args.appointmentId ?? null,
      title,
      due_date: dueDate ?? null,
      due_sort: dueDate ?? DUE_SORT_NEVER,
      status: 'open',
      source: 'session',
      created_at: new Date().toISOString(),
      completed_at: null,
    });
    if (landed) created++;
  }
  return { created };
}

export async function reconcileTasksAfterAmend(
  args: { clientId: string; appointmentId: string; sessionDate: Date; note: SessionNote },
): Promise<{ created: number; dismissed: number }> {
  const { created } = await createTasksFromNote(args);
  const keepTitles = normalizeFollowUps(args.note.follow_ups).map((f) => f.text);

  const database = getDatabase();
  const all = await database.tasks.listByClient(args.clientId);
  let dismissed = 0;

  for (const t of all) {
    if (
      t.appointment_id === args.appointmentId &&
      t.source === 'session' &&
      t.status === 'open' &&
      !keepTitles.includes(t.title)
    ) {
      await database.tasks.save({
        ...t,
        status: 'dismissed',
        completed_at: new Date().toISOString(),
      });
      dismissed++;
    }
  }
  return { created, dismissed };
}

export async function listOpenTasks(clientId?: string): Promise<TaskRow[]> {
  const db = getDatabase();
  const tasks = clientId ? await db.tasks.listByClient(clientId) : await db.tasks.listOpen();

  // client_name is denormalized onto the task at write time, so this no longer
  // reads the whole clients collection to build a lookup map.
  const openTasks = tasks
    .filter((t) => t.status === 'open')
    .map((t) => ({
      id: t.id,
      client_id: t.client_id,
      client_name: t.client_name ?? null,
      appointment_id: t.appointment_id || null,
      title: t.title,
      due_date: t.due_date || null,
      status: t.status,
      source: t.source,
      created_at: t.created_at,
      completed_at: t.completed_at || null,
    }));

  openTasks.sort((a, b) => {
    if (a.due_date === b.due_date) return a.created_at.localeCompare(b.created_at);
    if (!a.due_date) return 1;
    if (!b.due_date) return -1;
    return a.due_date.localeCompare(b.due_date);
  });

  return openTasks;
}

export async function setTaskStatus(id: string, status: TaskStatus): Promise<TaskRow | null> {
  const db = getDatabase();
  const task = await db.tasks.findById(id);
  if (!task) return null;

  const updated: TaskItem = {
    ...task,
    status,
    completed_at: status === 'open' ? null : new Date().toISOString(),
  };
  await db.tasks.save(updated);

  const row: TaskRow = {
    id: updated.id,
    client_id: updated.client_id,
    client_name: updated.client_name ?? null,
    appointment_id: updated.appointment_id || null,
    title: updated.title,
    due_date: updated.due_date || null,
    status: updated.status,
    source: updated.source,
    created_at: updated.created_at,
    completed_at: updated.completed_at || null,
  };

  await recordAudit({
    entityType: 'task',
    entityId: row.id,
    action: `task.${status}`,
    actor: 'nicole',
    summary: `Task ${status === 'done' ? 'completed' : status === 'dismissed' ? 'dismissed' : 'reopened'}: ${row.title}`,
    metadata: { client_id: row.client_id },
  });

  return row;
}

export async function createManualTask(args: {
  clientId: string;
  title: string;
  dueDate: string | null;
}): Promise<TaskRow> {
  const db = getDatabase();
  const id = randomTaskId('manual');
  const client = await db.clients.findById(args.clientId);

  const taskItem: TaskItem = {
    id,
    client_id: args.clientId,
    client_name: client?.name || null,
    appointment_id: null,
    title: args.title,
    due_date: args.dueDate || null,
    due_sort: args.dueDate || DUE_SORT_NEVER,
    status: 'open',
    source: 'manual',
    created_at: new Date().toISOString(),
    completed_at: null,
  };
  await db.tasks.save(taskItem);

  const row: TaskRow = {
    id: taskItem.id,
    client_id: taskItem.client_id,
    client_name: taskItem.client_name || null,
    appointment_id: null,
    title: taskItem.title,
    due_date: taskItem.due_date || null,
    status: taskItem.status,
    source: taskItem.source,
    created_at: taskItem.created_at,
    completed_at: null,
  };

  await recordAudit({
    entityType: 'task',
    entityId: id,
    action: 'task.created',
    actor: 'nicole',
    summary: `Manual task created: ${args.title}`,
    metadata: { client_id: args.clientId, due_date: args.dueDate },
  });

  return row;
}
