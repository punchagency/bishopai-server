import { Router } from 'express';
import { z } from 'zod';
import { pool } from '../db/pool';
import { logError } from '../observability/logger';
import { recordAudit } from '../audit/log';
import { listUpcomingReminders } from '../reminders/upcoming';

// The queue of client-facing emails the cadences will send, plus the one action
// Nicole needs over them: stop this one from going out. Read the module comment
// in ../reminders/upcoming.ts for why the listing exists at all.
//
// Cancelling silences a cadence; it never changes the underlying clinical state.
// A cancelled refill stays in the digest (the client IS running low, and Nicole
// may still want to send the order herself) — only the automated email stops.
export const remindersRouter = Router();

const isUuid = (id: string) => z.uuid().safeParse(id).success;

const KINDS = { refill: 'refill', reengagement: 'reengagement' } as const;
type Kind = keyof typeof KINDS;

// Per-kind cancellation: which table holds the flag, and how to describe it.
const TARGETS: Record<Kind, { table: 'refills' | 'leads'; column: string; entity: 'refill' | 'lead'; label: string }> = {
  refill: { table: 'refills', column: 'reminders_cancelled_at', entity: 'refill', label: 'Refill reminders' },
  reengagement: { table: 'leads', column: 'cadence_cancelled_at', entity: 'lead', label: 'Re-engagement emails' },
};

// ---------------------------------------------------------------------------
// GET /reminders/upcoming?days=30 — what will be emailed, and when.
// ---------------------------------------------------------------------------
const querySchema = z.object({ days: z.coerce.number().int().min(1).max(365).optional() });

remindersRouter.get('/upcoming', async (req, res) => {
  const parsed = querySchema.safeParse(req.query);
  if (!parsed.success) return res.status(400).json({ error: 'invalid query' });
  try {
    const reminders = await listUpcomingReminders(undefined, parsed.data.days ?? 30);
    return res.json({ reminders });
  } catch (err) {
    logError('reminders.upcoming', 'upcoming reminders query failed', err);
    return res.status(500).json({ error: 'internal error' });
  }
});

// ---------------------------------------------------------------------------
// POST /reminders/:kind/:id/cancel  — stop the remaining cadence.
// POST /reminders/:kind/:id/restore — undo, resuming where it left off.
// ---------------------------------------------------------------------------
function setCancelled(cancel: boolean) {
  return async (req: import('express').Request, res: import('express').Response) => {
    const kind = req.params.kind as Kind;
    const target = TARGETS[kind];
    if (!target) return res.status(404).json({ error: 'unknown reminder kind' });
    if (!isUuid(req.params.id)) return res.status(404).json({ error: 'not found' });

    try {
      // Table/column come from the TARGETS map above, never from the request.
      const r = await pool.query(
        `UPDATE ${target.table} SET ${target.column} = ${cancel ? 'now()' : 'NULL'}
          WHERE id = $1
      RETURNING id, ${target.column} AS cancelled_at`,
        [req.params.id],
      );
      if (r.rowCount === 0) return res.status(404).json({ error: 'not found' });

      await recordAudit({
        entityType: target.entity,
        entityId: req.params.id,
        action: cancel ? 'reminder.cancelled' : 'reminder.restored',
        actor: 'nicole',
        summary: `${target.label} ${cancel ? 'cancelled' : 'restored'}`,
      });
      return res.json({ id: r.rows[0].id, kind, cancelled_at: r.rows[0].cancelled_at });
    } catch (err) {
      logError('reminders.cancel', 'reminder cancellation failed', err, { kind, id: req.params.id, cancel });
      return res.status(500).json({ error: 'internal error' });
    }
  };
}

remindersRouter.post('/:kind/:id/cancel', setCancelled(true));
remindersRouter.post('/:kind/:id/restore', setCancelled(false));
