import type { PoolClient } from 'pg';
import { coerceSessionNote } from './render';

// WF1 → WF2/WF4 linkage: when Nicole approves a client's Protocol, persist its
// supplement changes into the `supplements` table — the shared "current plan"
// that the checkout summary (WF2) and the refill projection (WF4) both read.
// Before this, `supplements` was only ever written by the seed script, so those
// two workflows had no real data in production. This is the write that connects
// the WF1 spine to the rest.
//
// Model: one current row per (client, supplement name). A session that starts /
// increases / decreases / continues a supplement upserts that row (freshest
// dose, qty, and start date win); a `stop` removes it so WF4 stops projecting a
// refill for it. Source is tagged 'notes' (i.e. session notes) — the same bucket
// the seed uses and the documented source enum (notes | fullscript | pb).

export interface SupplementSyncResult {
  upserted: number;
  removed: number;
}

/**
 * Reconcile a client's supplement rows against an approved Protocol's session
 * note. Runs inside the approval transaction (atomic with the approve), so a
 * failure rolls the approval back rather than leaving a half-synced plan.
 * Idempotent: re-approving the same protocol yields the same rows.
 */
export async function syncClientSupplements(
  db: PoolClient,
  clientId: string,
  startDate: string | null,
  contentJson: unknown,
): Promise<SupplementSyncResult> {
  const note = coerceSessionNote(contentJson);
  let upserted = 0;
  let removed = 0;

  for (const s of note.supplements) {
    const name = s.name?.trim();
    if (!name) continue; // skip nameless entries — nothing to key on

    if (s.change === 'stop') {
      const r = await db.query(
        `DELETE FROM supplements WHERE client_id = $1 AND lower(name) = lower($2)`,
        [clientId, name],
      );
      removed += r.rowCount ?? 0;
      continue;
    }

    // start | increase | decrease | continue → keep one current row per name.
    const existing = await db.query<{ id: string }>(
      `SELECT id FROM supplements WHERE client_id = $1 AND lower(name) = lower($2) LIMIT 1`,
      [clientId, name],
    );
    if (existing.rowCount) {
      await db.query(
        `UPDATE supplements SET name = $2, dose = $3, qty = $4, start_date = $5, source = 'notes' WHERE id = $1`,
        [existing.rows[0].id, name, s.dose, s.quantity, startDate],
      );
    } else {
      await db.query(
        `INSERT INTO supplements (client_id, name, dose, qty, start_date, source) VALUES ($1, $2, $3, $4, $5, 'notes')`,
        [clientId, name, s.dose, s.quantity, startDate],
      );
    }
    upserted++;
  }

  return { upserted, removed };
}
