import { Router } from 'express';
import { z } from 'zod';
import { pool } from '../db/pool';
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
    const r = await pool.query(
      `SELECT c.id, c.name, c.email, c.pb_id,
              max(a.starts_at) AS last_seen,
              count(a.id) FILTER (WHERE a.status <> 'cancelled') AS visit_count
         FROM clients c
    LEFT JOIN appointments a ON a.client_id = c.id
        WHERE ($1::text IS NULL
               OR c.name ILIKE '%' || $1 || '%'
               OR c.email ILIKE '%' || $1 || '%')
     GROUP BY c.id, c.name, c.email, c.pb_id
     ORDER BY max(a.starts_at) DESC NULLS LAST, c.name ASC
        LIMIT $2`,
      [q && q.length ? q : null, limit],
    );
    return res.json({ clients: r.rows });
  } catch (err) {
    logError('clients.list', 'client query failed', err);
    return res.status(500).json({ error: 'internal error' });
  }
});
