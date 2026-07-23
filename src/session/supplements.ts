import type { PoolClient } from 'pg';
import { pool } from '../db/pool';
import { coerceSessionNote } from './render';
import type { SessionNote } from './extract';
import type { ScheduleSlot } from '../integrations/docs/types';

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
      // Chronology guard: a `stop` from an older session (approved late, out of
      // order) must not remove a plan a NEWER session already established. Only
      // stop rows dated at or before this session. A row with no date, or an
      // undated session, falls through to the old unconditional behaviour.
      const r = await db.query(
        `DELETE FROM supplements
          WHERE client_id = $1 AND lower(name) = lower($2)
            AND ($3::date IS NULL OR start_date IS NULL OR start_date <= $3::date)`,
        [clientId, name, startDate],
      );
      removed += r.rowCount ?? 0;
      continue;
    }

    // start | increase | decrease | continue → keep one current row per name.
    const existing = await db.query<{ id: string; start_date: string | null }>(
      `SELECT id, start_date::text AS start_date FROM supplements
        WHERE client_id = $1 AND lower(name) = lower($2) LIMIT 1`,
      [clientId, name],
    );
    // Don't let an out-of-order approval walk the plan backwards: if the stored
    // row is dated NEWER than this session, a later session already owns it —
    // leave it. (Both dates must be known to compare; otherwise proceed.)
    if (
      existing.rowCount &&
      startDate &&
      existing.rows[0].start_date &&
      existing.rows[0].start_date > startDate
    ) {
      continue;
    }
    // Only overwrite the stored schedule when this session actually stated timing;
    // otherwise the row keeps whatever slot pattern an earlier session established.
    const schedule = s.schedule && Object.values(s.schedule).some(Boolean)
      ? JSON.stringify(s.schedule)
      : null;

    if (existing.rowCount) {
      await db.query(
        `UPDATE supplements
            SET name = $2, dose = $3, qty = $4, start_date = $5, source = 'notes',
                schedule = COALESCE($6::jsonb, schedule),
                obtained_from = COALESCE($7, obtained_from)
          WHERE id = $1`,
        [existing.rows[0].id, name, s.dose, s.quantity, startDate, schedule, s.obtained_from ?? null],
      );
    } else {
      await db.query(
        `INSERT INTO supplements (client_id, name, dose, qty, start_date, source, schedule, obtained_from)
         VALUES ($1, $2, $3, $4, $5, 'notes', $6::jsonb, $7)`,
        [clientId, name, s.dose, s.quantity, startDate, schedule, s.obtained_from ?? null],
      );
    }
    upserted++;
  }

  return { upserted, removed };
}

export interface CurrentSupplementRow {
  name: string;
  dose: string | null;
  qty: number | null;
  /** Dosing slots for the protocol grid's D–J columns; null if never stated. */
  schedule?: Partial<Record<ScheduleSlot, string | null>> | null;
  /** How the row entered the plan (notes | fullscript | pb) — provenance, not
   *  anything the client sees. */
  source?: string | null;
  /** Where the client obtains it — the grid's "Here | Fullscript" column. */
  obtained_from?: string | null;
}

/** The client's running supplement plan — accumulated across every approved
 *  protocol, not just the one being reviewed. This is what the Supplement
 *  Protocol document's grid should actually be built from. */
export async function fetchCurrentSupplements(clientId: string): Promise<CurrentSupplementRow[]> {
  const r = await pool.query<CurrentSupplementRow>(
    `SELECT name, dose, qty, schedule, source, obtained_from
       FROM supplements WHERE client_id = $1 ORDER BY name`,
    [clientId],
  );
  return r.rows;
}

/**
 * Pure preview of what `syncClientSupplements` WOULD produce for this note,
 * without writing anything — same upsert-by-name / stop-removes rules, so the
 * Review UI can show Nicole the grid as it will actually render before she
 * approves, not just this session's deltas.
 */
export function previewSupplementMerge(
  current: CurrentSupplementRow[],
  note: SessionNote,
): CurrentSupplementRow[] {
  const map = new Map(current.map((r) => [r.name.toLowerCase(), { ...r }]));
  for (const s of note.supplements) {
    const name = s.name?.trim();
    if (!name) continue;
    const key = name.toLowerCase();
    if (s.change === 'stop') {
      map.delete(key);
      continue;
    }
    const prior = map.get(key);
    const stated = s.schedule && Object.values(s.schedule).some(Boolean) ? s.schedule : null;
    map.set(key, {
      name,
      dose: s.dose,
      qty: s.quantity,
      // Mirrors the COALESCE in syncClientSupplements: an unstated schedule keeps
      // whatever an earlier session established rather than clearing it.
      schedule: stated ?? prior?.schedule ?? null,
      source: prior?.source ?? null,
      obtained_from: s.obtained_from ?? prior?.obtained_from ?? null,
    });
  }
  return [...map.values()];
}

/**
 * Undo supplements that an amendment took back out of the note.
 *
 * syncClientSupplements deliberately never removes a supplement just because a
 * note doesn't mention it — the plan is cumulative, so a supplement from an
 * earlier session must survive a session that didn't discuss it. That's right
 * for a normal approval and wrong for an amendment: "I added the wrong
 * supplement" is the single most likely reason to amend a protocol, and without
 * this the mistaken row would stay on the plan forever.
 *
 * Scoped narrowly on purpose. Only a supplement the superseded note itself
 * STARTED, and which the amended note no longer mentions at all, is removed.
 * A dropped 'increase'/'continue' is left alone: that supplement was already on
 * the plan before this session, so the amendment is retracting the change, not
 * the supplement.
 */
export async function removeSupplementsDroppedByAmendment(
  db: PoolClient,
  clientId: string,
  supersededNote: unknown,
  amendedNote: unknown,
): Promise<number> {
  const before = coerceSessionNote(supersededNote);
  const after = coerceSessionNote(amendedNote);
  const stillNamed = new Set(
    after.supplements.map((s) => s.name?.trim().toLowerCase()).filter(Boolean),
  );

  let removed = 0;
  for (const s of before.supplements) {
    const name = s.name?.trim();
    if (!name || s.change !== 'start') continue;
    if (stillNamed.has(name.toLowerCase())) continue;
    const r = await db.query(
      `DELETE FROM supplements WHERE client_id = $1 AND lower(name) = lower($2)`,
      [clientId, name],
    );
    removed += r.rowCount ?? 0;
  }
  return removed;
}
