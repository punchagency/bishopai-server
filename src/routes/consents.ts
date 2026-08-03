import { Router } from 'express';
import { z } from 'zod';
import { logError } from '../observability/logger';
import { listConsents, recordConsent } from '../consent/service';
import { isDocId } from '../db/ids.js';

// WF1 consent surface: Nicole records a client's consent (e.g. passive session
// recording) and can revoke it. Guarded by requireAuth (mounted in server.ts).
export const consentsRouter = Router();

// Path ids are Firestore document ids, not uuids — the port mints deterministic
// ones (`appt_…`, `client_…`, `${clientId}__${nameKey}`). Gating on uuid shape
// here would 404 every PB-synced record; see isDocId.
const isUuid = isDocId;

// GET /consents/:clientId — a client's consent records.
consentsRouter.get('/:clientId', async (req, res) => {
  if (!isUuid(req.params.clientId)) return res.status(404).json({ error: 'not found' });
  try {
    res.json({ client_id: req.params.clientId, consents: await listConsents(req.params.clientId) });
  } catch (err) {
    logError('consents.list', 'list failed', err, { client_id: req.params.clientId });
    res.status(500).json({ error: 'internal error' });
  }
});

// PUT /consents/:clientId/:type { granted, notes } — grant or revoke.
const bodySchema = z.object({ granted: z.boolean(), notes: z.string().max(1000).optional() });
consentsRouter.put('/:clientId/:type', async (req, res) => {
  if (!isUuid(req.params.clientId)) return res.status(404).json({ error: 'not found' });
  const parsed = bodySchema.safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).json({ error: 'invalid payload' });
  try {
    const row = await recordConsent(req.params.clientId, req.params.type, parsed.data.granted, parsed.data.notes);
    res.json(row);
  } catch (err) {
    logError('consents.record', 'record failed', err, { client_id: req.params.clientId });
    res.status(500).json({ error: 'internal error' });
  }
});
