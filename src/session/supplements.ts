import type { PoolClient } from 'pg';
import { pool } from '../db/pool';
import { coerceSessionNote } from './render';
import type { SessionNote } from './extract';
import { normalizeSupplementName } from './supplementName';
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
    // Identity is the NORMALIZED name, never the spoken one. Extraction is told
    // to preserve garbled product names verbatim, so keying on the raw string
    // made "Bio-C Plus" and "Bio C Plus" two rows on one plan — and two refill
    // projections for one product. `name` stays as spoken for the document.
    const key = normalizeSupplementName(name) || name.toLowerCase();

    if (s.change === 'stop') {
      // Chronology guard: a `stop` from an older session (approved late, out of
      // order) must not remove a plan a NEWER session already established. Only
      // stop rows dated at or before this session. A row with no date, or an
      // undated session, falls through to the old unconditional behaviour.
      const r = await db.query(
        `DELETE FROM supplements
          WHERE client_id = $1 AND name_key = $2
            AND ($3::date IS NULL OR start_date IS NULL OR start_date <= $3::date)`,
        [clientId, key, startDate],
      );
      removed += r.rowCount ?? 0;
      continue;
    }

    // start | increase | decrease | continue → keep one current row per name.
    const existing = await db.query<{ id: string; start_date: string | null }>(
      `SELECT id, start_date::text AS start_date FROM supplements
        WHERE client_id = $1 AND name_key = $2 LIMIT 1`,
      [clientId, key],
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

    const params = [
      clientId, name, s.dose, s.quantity, startDate, schedule, s.obtained_from ?? null, key,
      s.units_per_dose ?? null, s.doses_per_day ?? null,
    ];
    if (existing.rowCount) {
      await db.query(
        `UPDATE supplements
            SET name = $2, name_key = $8, dose = $3, qty = $4, start_date = $5, source = 'notes',
                schedule = COALESCE($6::jsonb, schedule),
                obtained_from = COALESCE($7, obtained_from),
                -- COALESCE, not overwrite: a session that restated the product
                -- without restating a countable dose must not erase the numbers
                -- an earlier session captured.
                units_per_dose = COALESCE($9::numeric, units_per_dose),
                doses_per_day = COALESCE($10::numeric, doses_per_day)
          WHERE id = $1`,
        [existing.rows[0].id, ...params.slice(1)],
      );
    } else {
      await db.query(
        `INSERT INTO supplements (client_id, name, name_key, dose, qty, start_date, source,
                                  schedule, obtained_from, units_per_dose, doses_per_day)
              VALUES ($1, $2, $8, $3, $4, $5, 'notes', $6::jsonb, $7, $9::numeric, $10::numeric)
         ON CONFLICT (client_id, name_key) DO UPDATE
              SET name = EXCLUDED.name, dose = EXCLUDED.dose, qty = EXCLUDED.qty,
                  start_date = EXCLUDED.start_date, source = 'notes',
                  schedule = COALESCE(EXCLUDED.schedule, supplements.schedule),
                  obtained_from = COALESCE(EXCLUDED.obtained_from, supplements.obtained_from),
                  units_per_dose = COALESCE(EXCLUDED.units_per_dose, supplements.units_per_dose),
                  doses_per_day = COALESCE(EXCLUDED.doses_per_day, supplements.doses_per_day)`,
        params,
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

// How long a fetched vocabulary stays good. Products change rarely; a few
// minutes of staleness costs nothing and keeps this off the extraction hot path.
const VOCAB_TTL_MS = 5 * 60_000;
const VOCAB_LIMIT = Number(process.env.EXTRACTION_CATALOG_LIMIT ?? 120);
let practiceVocab: { at: number; names: string[] } | null = null;

/**
 * Supplement names to ground extraction against: this client's own plan first,
 * then the practice's most-used products.
 *
 * The practice sells a bounded set of products, and the transcript mangles their
 * names — this is the closed vocabulary that turns "bio see plus" back into
 * "Bio-C Plus" instead of leaving a phonetic guess to become a new row on the
 * client's plan. Ordered client-first and capped, so the prompt never grows past
 * what the budget can carry.
 */
export async function fetchSupplementVocabulary(clientId: string | null): Promise<string[]> {
  const names: string[] = [];
  if (clientId) {
    const own = await pool.query<{ name: string }>(
      `SELECT name FROM supplements WHERE client_id = $1 ORDER BY name`,
      [clientId],
    );
    names.push(...own.rows.map((r) => r.name));
  }

  if (!practiceVocab || Date.now() - practiceVocab.at > VOCAB_TTL_MS) {
    const all = await pool.query<{ name: string }>(
      `SELECT name FROM supplements
        GROUP BY name_key, name
        ORDER BY count(*) DESC, name
        LIMIT $1`,
      [VOCAB_LIMIT],
    );
    practiceVocab = { at: Date.now(), names: all.rows.map((r) => r.name) };
  }
  names.push(...practiceVocab.names);

  const seen = new Set<string>();
  const out: string[] = [];
  for (const n of names) {
    const key = normalizeSupplementName(n);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(n);
    if (out.length >= VOCAB_LIMIT) break;
  }
  return out;
}

/** Test seam — drop the cached practice-wide vocabulary. */
export function resetSupplementVocabulary(): void {
  practiceVocab = null;
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
  // Same identity rule as syncClientSupplements — the preview would otherwise
  // show Nicole a grid the approval then merges differently.
  const map = new Map(current.map((r) => [normalizeSupplementName(r.name) || r.name.toLowerCase(), { ...r }]));
  for (const s of note.supplements) {
    const name = s.name?.trim();
    if (!name) continue;
    const key = normalizeSupplementName(name) || name.toLowerCase();
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
    after.supplements.map((s) => normalizeSupplementName(s.name)).filter(Boolean),
  );

  let removed = 0;
  for (const s of before.supplements) {
    const name = s.name?.trim();
    if (!name || s.change !== 'start') continue;
    const key = normalizeSupplementName(name) || name.toLowerCase();
    if (stillNamed.has(key)) continue;
    const r = await db.query(
      `DELETE FROM supplements WHERE client_id = $1 AND name_key = $2`,
      [clientId, key],
    );
    removed += r.rowCount ?? 0;
  }
  return removed;
}
