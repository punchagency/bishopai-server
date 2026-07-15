import { Router } from 'express';
import { z } from 'zod';
import { logError } from '../observability/logger';
import { createManualTask, listOpenTasks, setTaskStatus } from '../tasks/service';

// Nicole's open commitments — the follow-ups she made in session, now tracked.
// Read + tick off. Nothing here sends anything to anyone.
export const tasksRouter = Router();

const isUuid = (id: string) => z.uuid().safeParse(id).success;

const patchSchema = z.object({ status: z.enum(['open', 'done', 'dismissed']) });
const createSchema = z.object({
  client_id: z.uuid(),
  title: z.string().min(1).max(500),
  due_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullish(),
});

tasksRouter.get('/', async (req, res) => {
  const clientId = typeof req.query.client_id === 'string' ? req.query.client_id : undefined;
  if (clientId && !isUuid(clientId)) return res.status(400).json({ error: 'bad client_id' });
  try {
    return res.json({ tasks: await listOpenTasks(clientId) });
  } catch (err) {
    logError('tasks.list', 'list failed', err);
    return res.status(500).json({ error: 'internal error' });
  }
});

tasksRouter.post('/', async (req, res) => {
  const parsed = createSchema.safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).json({ error: 'invalid body' });
  try {
    const task = await createManualTask({
      clientId: parsed.data.client_id,
      title: parsed.data.title,
      dueDate: parsed.data.due_date ?? null,
    });
    return res.status(201).json(task);
  } catch (err) {
    logError('tasks.create', 'create failed', err);
    return res.status(500).json({ error: 'internal error' });
  }
});

tasksRouter.patch('/:id', async (req, res) => {
  if (!isUuid(req.params.id)) return res.status(404).json({ error: 'not found' });
  const parsed = patchSchema.safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).json({ error: 'invalid body' });
  try {
    const task = await setTaskStatus(req.params.id, parsed.data.status);
    return task ? res.json(task) : res.status(404).json({ error: 'not found' });
  } catch (err) {
    logError('tasks.patch', 'update failed', err, { id: req.params.id });
    return res.status(500).json({ error: 'internal error' });
  }
});
