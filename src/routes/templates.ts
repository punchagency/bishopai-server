import { Router } from 'express';
import { z } from 'zod';
import { pool } from '../db/pool';
import { logError, logEvent } from '../observability/logger';
import { CADENCE_DEFAULTS } from '../reengagement/cadence';
import { recordAudit } from '../audit/log';

// Email template CRUD — GET all effective copy, PUT to override a step,
// DELETE to reset a step to the hardcoded default. Mounted at /templates.

export const templatesRouter = Router();

const isKnown = (track: string, step: string): boolean =>
  !!(CADENCE_DEFAULTS[track]?.[step]);

// GET /templates — all tracks/steps with their effective copy.
// Response includes both DB overrides and hardcoded defaults so the UI can
// render every template without a second fetch.
templatesRouter.get('/', async (_req, res) => {
  try {
    const { rows } = await pool.query<{ track: string; step: string; subject: string; body: string; updated_at: string }>(
      `SELECT track, step, subject, body, updated_at FROM email_templates ORDER BY track, step`,
    );
    const overrides = new Map(rows.map((r) => [`${r.track}:${r.step}`, r]));

    const templates = Object.entries(CADENCE_DEFAULTS).flatMap(([track, steps]) =>
      Object.entries(steps).map(([step, def]) => {
        const override = overrides.get(`${track}:${step}`);
        return {
          track,
          step,
          subject: override?.subject ?? def.subject,
          body: override?.body ?? def.body,
          is_custom: !!override,
          updated_at: override?.updated_at ?? null,
        };
      }),
    );
    return res.json({ templates });
  } catch (err) {
    logError('templates.get', 'failed to fetch templates', err);
    return res.status(500).json({ error: 'internal error' });
  }
});

const templateBody = z.object({
  subject: z.string().min(1).max(500),
  body: z.string().min(1).max(5000),
});

// PUT /templates/:track/:step — upsert an override for one step.
templatesRouter.put('/:track/:step', async (req, res) => {
  const { track, step } = req.params;
  if (!isKnown(track, step)) {
    return res.status(404).json({ error: `unknown cadence step: ${track}/${step}` });
  }
  const parsed = templateBody.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'invalid payload', details: parsed.error.flatten() });
  }
  const { subject, body } = parsed.data;
  try {
    const { rows } = await pool.query<{ id: string; updated_at: string }>(
      `INSERT INTO email_templates (track, step, subject, body)
            VALUES ($1, $2, $3, $4)
       ON CONFLICT (track, step) DO UPDATE
            SET subject = EXCLUDED.subject,
                body = EXCLUDED.body,
                updated_at = now()
         RETURNING id, updated_at`,
      [track, step, subject, body],
    );
    await recordAudit({
      entityType: 'outlook',
      entityId: `template:${track}:${step}`,
      action: 'template.saved',
      actor: 'nicole',
      summary: `Email template updated — ${track}/${step}`,
      metadata: { track, step, subject },
    });
    logEvent('info', 'templates.put', 'template saved', { track, step });
    return res.json({ track, step, subject, body, is_custom: true, updated_at: rows[0].updated_at });
  } catch (err) {
    logError('templates.put', 'failed to save template', err);
    return res.status(500).json({ error: 'internal error' });
  }
});

// DELETE /templates/:track/:step — reset a step to the hardcoded default.
templatesRouter.delete('/:track/:step', async (req, res) => {
  const { track, step } = req.params;
  if (!isKnown(track, step)) {
    return res.status(404).json({ error: `unknown cadence step: ${track}/${step}` });
  }
  try {
    await pool.query(`DELETE FROM email_templates WHERE track = $1 AND step = $2`, [track, step]);
    await recordAudit({
      entityType: 'outlook',
      entityId: `template:${track}:${step}`,
      action: 'template.reset',
      actor: 'nicole',
      summary: `Email template reset to default — ${track}/${step}`,
    });
    logEvent('info', 'templates.delete', 'template reset to default', { track, step });
    const def = CADENCE_DEFAULTS[track][step];
    return res.json({ track, step, subject: def.subject, body: def.body, is_custom: false, updated_at: null });
  } catch (err) {
    logError('templates.delete', 'failed to reset template', err);
    return res.status(500).json({ error: 'internal error' });
  }
});
