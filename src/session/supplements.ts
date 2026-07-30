import { getDatabase } from '../db/index.js';
import { supplementDocId } from '../db/ids.js';
import type { Supplement } from '../db/interfaces/types.js';
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

/** The normalized identity a supplement row is keyed on. */
export function supplementKey(name: string): string {
  return normalizeSupplementName(name) || name.toLowerCase();
}

/**
 * Reconcile a client's supplement rows against an approved Protocol's session
 * note. Idempotent: re-approving the same protocol yields the same rows.
 *
 * Runs AFTER the approval transaction rather than inside it. In Postgres this
 * shared the approve transaction, so a failure rolled both back; a Firestore
 * transaction is retried on contention and would re-run this whole loop, and it
 * spans an unbounded number of documents besides. What replaces the atomicity is
 * idempotency — every write here is keyed on (client, name_key), so a caller
 * that fails partway and retries converges on the same plan.
 */
export async function syncClientSupplements(
  clientId: string,
  startDate: string | null,
  contentJson: unknown,
): Promise<SupplementSyncResult> {
  const note = coerceSessionNote(contentJson);
  const db = getDatabase();
  let upserted = 0;
  let removed = 0;

  for (const s of note.supplements) {
    const name = s.name?.trim();
    if (!name) continue; // skip nameless entries — nothing to key on
    // Identity is the NORMALIZED name, never the spoken one. Extraction is told
    // to preserve garbled product names verbatim, so keying on the raw string
    // made "Bio-C Plus" and "Bio C Plus" two rows on one plan — and two refill
    // projections for one product. `name` stays as spoken for the document.
    const key = supplementKey(name);
    const existing = await db.refills.findSupplement(clientId, key);

    if (s.change === 'stop') {
      // Chronology guard: a `stop` from an older session (approved late, out of
      // order) must not remove a plan a NEWER session already established. Only
      // stop rows dated at or before this session. A row with no date, or an
      // undated session, falls through to the old unconditional behaviour.
      if (!existing) continue;
      if (startDate && existing.start_date && existing.start_date > startDate) continue;
      if (await db.refills.deleteSupplement(clientId, key)) removed++;
      continue;
    }

    // start | increase | decrease | continue → keep one current row per name.
    //
    // Don't let an out-of-order approval walk the plan backwards: if the stored
    // row is dated NEWER than this session, a later session already owns it —
    // leave it. (Both dates must be known to compare; otherwise proceed.)
    if (existing && startDate && existing.start_date && existing.start_date > startDate) {
      continue;
    }

    // Only overwrite the stored schedule when this session actually stated
    // timing; otherwise the row keeps whatever slot pattern an earlier session
    // established. Same rule for the rest: these are COALESCE, not overwrite —
    // a session that restated the product without restating a countable dose
    // must not erase the numbers an earlier session captured.
    const stated = s.schedule && Object.values(s.schedule).some(Boolean) ? s.schedule : null;
    const now = new Date().toISOString();

    const row: Supplement = {
      id: supplementDocId(clientId, key),
      client_id: clientId,
      name,
      name_key: key,
      dose: s.dose,
      qty: s.quantity,
      start_date: startDate,
      source: 'notes',
      schedule: stated ?? existing?.schedule ?? null,
      obtained_from: s.obtained_from ?? existing?.obtained_from ?? null,
      units_per_dose: s.units_per_dose ?? existing?.units_per_dose ?? null,
      doses_per_day: s.doses_per_day ?? existing?.doses_per_day ?? null,
      created_at: existing?.created_at ?? now,
      updated_at: now,
    };
    await db.refills.saveSupplement(row);
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
  const rows = await getDatabase().refills.listSupplementsByClient(clientId);
  return rows.map((r) => ({
    name: r.name,
    dose: r.dose,
    qty: r.qty,
    schedule: r.schedule,
    source: r.source,
    obtained_from: r.obtained_from ?? null,
  }));
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
  const db = getDatabase();
  const names: string[] = [];
  if (clientId) {
    names.push(...(await db.refills.listSupplementsByClient(clientId)).map((r) => r.name));
  }

  if (!practiceVocab || Date.now() - practiceVocab.at > VOCAB_TTL_MS) {
    // `GROUP BY name_key ORDER BY count(*) DESC` has no Firestore equivalent, so
    // the frequency ranking is computed here over the whole collection. That is
    // the one deliberate full scan in the port (§3.6): a solo practice's plan
    // rows number in the hundreds, the result is cached for VOCAB_TTL_MS, and
    // the alternative — a denormalized counter per product — would drift out of
    // step with the plan it is supposed to describe.
    const counts = new Map<string, { name: string; n: number }>();
    for (const row of await db.refills.listAllSupplements()) {
      const key = row.name_key || supplementKey(row.name);
      const seen = counts.get(key);
      if (seen) seen.n++;
      else counts.set(key, { name: row.name, n: 1 });
    }
    practiceVocab = {
      at: Date.now(),
      names: [...counts.values()]
        .sort((a, b) => b.n - a.n || a.name.localeCompare(b.name))
        .slice(0, VOCAB_LIMIT)
        .map((c) => c.name),
    };
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
  clientId: string,
  supersededNote: unknown,
  amendedNote: unknown,
): Promise<number> {
  const before = coerceSessionNote(supersededNote);
  const after = coerceSessionNote(amendedNote);
  const stillNamed = new Set(
    after.supplements.map((s) => normalizeSupplementName(s.name)).filter(Boolean),
  );

  const db = getDatabase();
  let removed = 0;
  for (const s of before.supplements) {
    const name = s.name?.trim();
    if (!name || s.change !== 'start') continue;
    const key = supplementKey(name);
    if (stillNamed.has(key)) continue;
    if (await db.refills.deleteSupplement(clientId, key)) removed++;
  }
  return removed;
}
