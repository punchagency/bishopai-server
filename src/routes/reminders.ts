import { Router } from 'express';
import { z } from 'zod';
import { getDatabase } from '../db/index.js';
import { logError } from '../observability/logger';
import { recordAudit } from '../audit/log';
import { listUpcomingReminders } from '../reminders/upcoming';
import { isDocId } from '../db/ids.js';

// The queue of client-facing emails the cadences will send, plus the one action
// Nicole needs over them: stop this one from going out. Read the module comment
// in ../reminders/upcoming.ts for why the listing exists at all.
//
// Cancelling silences a cadence; it never changes the underlying clinical state.
// A cancelled refill stays in the digest (the client IS running low, and Nicole
// may still want to send the order herself) — only the automated email stops.
export const remindersRouter = Router();

// Path ids are Firestore document ids, not uuids — the port mints deterministic
// ones (`appt_…`, `client_…`, `${clientId}__${nameKey}`). Gating on uuid shape
// here would 404 every PB-synced record; see isDocId.
const isUuid = isDocId;

const KINDS = { refill: 'refill', reengagement: 'reengagement' } as const;
type Kind = keyof typeof KINDS;

// Per-kind cancellation: which collection holds the flag, and how to describe it.
const TARGETS: Record<
  Kind,
  { collection: 'refills' | 'leads'; field: 'reminders_cancelled_at' | 'cadence_cancelled_at'; entity: 'refill' | 'lead'; label: string }
> = {
  refill: { collection: 'refills', field: 'reminders_cancelled_at', entity: 'refill', label: 'Refill reminders' },
  reengagement: { collection: 'leads', field: 'cadence_cancelled_at', entity: 'lead', label: 'Re-engagement emails' },
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
      // Collection/field come from the TARGETS map above, never from the request.
      const db = getDatabase();
      const cancelledAt = cancel ? new Date().toISOString() : null;
      const id = req.params.id;

      // `UPDATE … WHERE id = $1` with `rowCount === 0` meaning "not found" — so
      // the row has to be read first here, since a Firestore set(merge) on a
      // missing document would happily create one.
      if (target.collection === 'refills') {
        const refill = await db.refills.findById(id);
        if (!refill) return res.status(404).json({ error: 'not found' });
        await db.refills.save({ ...refill, reminders_cancelled_at: cancelledAt });
      } else {
        const lead = await db.reengagement.findLeadById(id);
        if (!lead) return res.status(404).json({ error: 'not found' });
        await db.reengagement.saveLead({ ...lead, cadence_cancelled_at: cancelledAt });
      }

      await recordAudit({
        entityType: target.entity,
        entityId: req.params.id,
        action: cancel ? 'reminder.cancelled' : 'reminder.restored',
        actor: 'nicole',
        summary: `${target.label} ${cancel ? 'cancelled' : 'restored'}`,
      });
      return res.json({ id, kind, cancelled_at: cancelledAt });
    } catch (err) {
      logError('reminders.cancel', 'reminder cancellation failed', err, { kind, id: req.params.id, cancel });
      return res.status(500).json({ error: 'internal error' });
    }
  };
}

remindersRouter.post('/:kind/:id/cancel', setCancelled(true));
remindersRouter.post('/:kind/:id/restore', setCancelled(false));
