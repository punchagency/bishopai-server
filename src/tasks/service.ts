import { getDatabase } from '../db/index.js';
import type { SessionNote } from '../session/extract.js';
import { dueDateFrom, normalizeFollowUps } from '../session/followups.js';
import { recordAudit } from '../audit/log.js';

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

export async function createTasksFromNote(
  _db: unknown,
  args: { clientId: string; appointmentId: string | null; sessionDate: Date; note: SessionNote },
): Promise<{ created: number }> {
  const followUps = normalizeFollowUps(args.note.follow_ups);
  if (followUps.length === 0) return { created: 0 };

  const db = getDatabase();
  const existing = await db.tasks.listAll();
  let created = 0;

  for (const f of followUps) {
    const title = f.text;
    const isDuplicate = existing.some(
      (t) => t.appointment_id === args.appointmentId && (t as unknown as TaskRow).title === title,
    );
    if (!isDuplicate) {
      const id = `task_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
      const dueDate = dueDateFrom(args.sessionDate, f.dueInDays);
      await db.tasks.save({
        id,
        client_id: args.clientId,
        appointment_id: args.appointmentId ?? undefined,
        description: title,
        due_date: dueDate ?? undefined,
        status: 'pending',
        created_at: new Date().toISOString(),
      });
      created++;
    }
  }
  return { created };
}

export async function reconcileTasksAfterAmend(
  db: unknown,
  args: { clientId: string; appointmentId: string; sessionDate: Date; note: SessionNote },
): Promise<{ created: number; dismissed: number }> {
  const { created } = await createTasksFromNote(db, args);
  const keepTitles = normalizeFollowUps(args.note.follow_ups).map((f) => f.text);

  const database = getDatabase();
  const all = await database.tasks.listAll();
  let dismissed = 0;

  for (const t of all) {
    const row = t as unknown as TaskRow;
    if (
      row.appointment_id === args.appointmentId &&
      row.source === 'session' &&
      row.status === 'open' &&
      !keepTitles.includes(row.title || t.description)
    ) {
      await database.tasks.save({
        ...t,
        status: 'completed',
      });
      dismissed++;
    }
  }
  return { created, dismissed };
}

export async function listOpenTasks(clientId?: string): Promise<TaskRow[]> {
  const db = getDatabase();
  const tasks = clientId ? await db.tasks.listByClient(clientId) : await db.tasks.listAll();
  const clients = await db.clients.listAll();
  const clientMap = new Map(clients.map((c) => [c.id, c.name]));

  return tasks
    .filter((t) => t.status === 'pending')
    .map((t) => ({
      id: t.id,
      client_id: t.client_id || '',
      client_name: clientMap.get(t.client_id || '') || null,
      appointment_id: t.appointment_id || null,
      title: t.description,
      due_date: t.due_date || null,
      status: 'open' as TaskStatus,
      source: 'session',
      created_at: t.created_at,
      completed_at: null,
    }));
}

export async function setTaskStatus(id: string, status: TaskStatus): Promise<TaskRow | null> {
  const db = getDatabase();
  const task = await db.tasks.findById(id);
  if (!task) return null;

  const newStatus = status === 'open' ? 'pending' : 'completed';
  const updated = await db.tasks.save({
    ...task,
    status: newStatus,
  });

  const client = task.client_id ? await db.clients.findById(task.client_id) : null;
  const row: TaskRow = {
    id: updated.id,
    client_id: updated.client_id || '',
    client_name: client?.name || null,
    appointment_id: updated.appointment_id || null,
    title: updated.description,
    due_date: updated.due_date || null,
    status,
    source: 'session',
    created_at: updated.created_at,
    completed_at: status === 'open' ? null : new Date().toISOString(),
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
  const id = `task_manual_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
  const saved = await db.tasks.save({
    id,
    client_id: args.clientId,
    description: args.title,
    due_date: args.dueDate || undefined,
    status: 'pending',
    created_at: new Date().toISOString(),
  });

  const client = await db.clients.findById(args.clientId);
  const row: TaskRow = {
    id: saved.id,
    client_id: saved.client_id || '',
    client_name: client?.name || null,
    appointment_id: null,
    title: saved.description,
    due_date: saved.due_date || null,
    status: 'open',
    source: 'manual',
    created_at: saved.created_at,
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
