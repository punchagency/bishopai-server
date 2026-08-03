import { Router } from 'express';
import { z } from 'zod';
import { getDatabase } from '../db/index.js';
import { logError } from '../observability/logger';

// The client list, for anywhere Nicole has to pick a person rather than a
// record — currently assigning a walk-in recording that never had a booking.
export const clientsRouter = Router();

const querySchema = z.object({
  q: z.string().trim().max(120).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});

/**
 * GET /clients?q=<search> — clients, most recently seen first.
 *
 * Ordered by last appointment rather than alphabetically: when she's assigning a
 * recording, the person she just saw is far more likely than someone from two
 * years ago, so the useful answer is usually already at the top before she types.
 */
clientsRouter.get('/', async (req, res) => {
  const parsed = querySchema.safeParse(req.query);
  if (!parsed.success) return res.status(400).json({ error: 'invalid query' });
  const { q, limit = 50 } = parsed.data;

  try {
    const db = getDatabase();
    // ILIKE has no Firestore equivalent (§3.5), so the name/email search filters
    // in memory. That is affordable precisely because it is a solo practice's
    // client list, and it is applied BEFORE the per-client appointment reads so
    // a search doesn't pay for the whole roster's history.
    const needle = q?.toLowerCase();
    const matched = (await db.clients.listAll()).filter(
      (c) =>
        !needle ||
        c.name.toLowerCase().includes(needle) ||
        (c.email ?? '').toLowerCase().includes(needle),
    );

    const rows = await Promise.all(
      matched.map(async (c) => {
        const appointments = await db.appointments.listByClient(c.id);
        // listByClient is chronological, so the last element is max(starts_at).
        const lastSeen = appointments.length ? appointments[appointments.length - 1].starts_at : null;
        return {
          id: c.id,
          name: c.name,
          email: c.email ?? null,
          pb_id: c.pb_id ?? null,
          last_seen: lastSeen,
          visit_count: appointments.filter((a) => a.status !== 'cancelled').length,
        };
      }),
    );

    // `ORDER BY max(a.starts_at) DESC NULLS LAST, c.name ASC` — a client who has
    // never been seen sorts last, not first.
    rows.sort((a, b) => {
      if (a.last_seen !== b.last_seen) {
        if (!a.last_seen) return 1;
        if (!b.last_seen) return -1;
        return b.last_seen.localeCompare(a.last_seen);
      }
      return a.name.localeCompare(b.name);
    });

    return res.json({ clients: rows.slice(0, limit) });
  } catch (err) {
    logError('clients.list', 'client query failed', err);
    return res.status(500).json({ error: 'internal error' });
  }
});
