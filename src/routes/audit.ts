import { Router } from 'express';
import { z } from 'zod';
import { logError } from '../observability/logger';
import { auditForEntity, recentActivity } from '../audit/log';

// The unified activity trail. Two reads: the global feed (Activity view) and one
// entity's history (the History panel on a checkout / session / client). Read-only
// — the audit log is append-only and written by the actions themselves.
export const auditRouter = Router();

const isUuidish = (s: string) => s.length > 0 && s.length <= 64;

// GET /audit — global activity feed, newest first. ?type= to filter by entity
// type, ?limit= (default 100, max 500).
auditRouter.get('/', async (req, res) => {
  const type = typeof req.query.type === 'string' ? req.query.type : undefined;
  const limit = Math.min(Number(req.query.limit) || 100, 500);
  try {
    const events = await recentActivity(limit, type);
    return res.json({ events });
  } catch (err) {
    logError('audit.list', 'activity query failed', err);
    return res.status(500).json({ error: 'internal error' });
  }
});

// GET /audit/:entityType/:entityId — one entity's history, newest first.
const paramsSchema = z.object({ entityType: z.string().max(40), entityId: z.string().max(64) });
auditRouter.get('/:entityType/:entityId', async (req, res) => {
  const parsed = paramsSchema.safeParse(req.params);
  if (!parsed.success || !isUuidish(parsed.data.entityId)) {
    return res.status(400).json({ error: 'invalid entity' });
  }
  try {
    const events = await auditForEntity(parsed.data.entityType, parsed.data.entityId);
    return res.json({ events });
  } catch (err) {
    logError('audit.entity', 'entity history query failed', err, { ...parsed.data });
    return res.status(500).json({ error: 'internal error' });
  }
});
