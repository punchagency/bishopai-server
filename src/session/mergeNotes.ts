import type { Evidence, SessionNote } from './schema';
import { normalizeSupplementName } from './supplementName';

// Merging chunk results back into one session note.
//
// This is the riskiest code in the long-transcript path, because every mistake it
// makes is invisible: a dropped finding looks exactly like a finding the
// practitioner never called out, and that is precisely the lie the whole
// extraction pipeline is built to avoid. So the rules here are per field class,
// and where two chunks genuinely disagree the disagreement is REPORTED rather
// than resolved. Nicole picking between two readings is a five-second decision;
// silently keeping the wrong one is a clinical record with a wrong number in it.

export interface ChunkResult {
  /** Chunk order — later chunks are later in the session. */
  index: number;
  note: Partial<SessionNote>;
}

export interface Conflict {
  path: string;
  chosen: string | null;
  candidates: string[];
}

export interface MergeResult {
  note: Partial<SessionNote>;
  conflicts: Conflict[];
}

// --- Text similarity ---------------------------------------------------------

function tokens(s: string): Set<string> {
  return new Set(
    s
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter(Boolean),
  );
}

/** Token-set overlap in [0,1]. Overlapping chunks re-report the same finding in
 *  slightly different words; exact-match dedupe would keep both. */
export function similarity(a: string, b: string): number {
  const ta = tokens(a);
  const tb = tokens(b);
  if (!ta.size || !tb.size) return 0;
  let shared = 0;
  for (const t of ta) if (tb.has(t)) shared++;
  return shared / Math.max(ta.size, tb.size);
}

const DEDUPE_THRESHOLD = 0.8;
/** Below this many tokens, containment is meaningless — "sleep" is contained in
 *  half the transcript and must not swallow an unrelated longer finding. */
const MIN_CONTAINED_TOKENS = 3;

/**
 * Are these two captures of the same finding?
 *
 * Near-identical wording is the easy case. The one that matters more is the
 * chunk boundary: one chunk catches "pituitary is offline" mid-sentence while
 * its neighbour catches "pituitary is a little bit offline right now" in full.
 * Those score only 0.375 on a max-denominator overlap and would both survive as
 * two separate assessments of the same thing — so containment counts too.
 */
export function isDuplicate(a: string, b: string): boolean {
  const ta = tokens(a);
  const tb = tokens(b);
  if (!ta.size || !tb.size) return false;
  let shared = 0;
  for (const t of ta) if (tb.has(t)) shared++;
  if (shared / Math.max(ta.size, tb.size) >= DEDUPE_THRESHOLD) return true;
  const smaller = Math.min(ta.size, tb.size);
  return smaller >= MIN_CONTAINED_TOKENS && shared / smaller >= 0.95;
}

interface Traced<T> {
  value: T;
  chunk: number;
  /** Index within that chunk's array, for evidence re-pathing. */
  origin: number;
}

/**
 * Concatenate in chunk order, dropping near-duplicates. Keeps the LONGER of two
 * similar items: the overlap region is where a finding is most likely to have
 * been captured mid-sentence by one chunk and in full by the other.
 */
function dedupeStrings(items: Traced<string>[]): Traced<string>[] {
  const out: Traced<string>[] = [];
  for (const item of items) {
    const hitIndex = out.findIndex((k) => isDuplicate(k.value, item.value));
    if (hitIndex === -1) {
      out.push(item);
      continue;
    }
    if (item.value.length > out[hitIndex].value.length) out[hitIndex] = item;
  }
  return out;
}

// --- Scalar merge ------------------------------------------------------------

type Scalars = Record<string, unknown>;

/**
 * Merge nested findings objects (nrt, lifestyle) slot by slot.
 *
 * - one chunk filled it            → take it
 * - several agree                  → take it
 * - several DISAGREE               → take the latest chunk's reading and record
 *                                    a conflict, because a later reading in an
 *                                    NRT session is usually a re-test — but a
 *                                    re-test and a mis-slotted value look
 *                                    identical from here, so a human decides.
 */
function mergeScalars(
  candidates: { value: Scalars; chunk: number }[],
  prefix: string,
  conflicts: Conflict[],
): Scalars | undefined {
  const present = candidates.filter((c) => c.value && typeof c.value === 'object');
  if (!present.length) return undefined;

  const keys = new Set<string>();
  for (const c of present) for (const k of Object.keys(c.value)) keys.add(k);

  const out: Scalars = {};
  for (const key of keys) {
    const path = `${prefix}.${key}`;
    const vals = present
      .map((c) => ({ v: c.value[key], chunk: c.chunk }))
      .filter((x) => x.v !== null && x.v !== undefined);

    if (!vals.length) {
      out[key] = null;
      continue;
    }
    // Nested object (foundation / body_scan) — recurse.
    if (vals.every((x) => typeof x.v === 'object' && !Array.isArray(x.v))) {
      out[key] =
        mergeScalars(
          vals.map((x) => ({ value: x.v as Scalars, chunk: x.chunk })),
          path,
          conflicts,
        ) ?? null;
      continue;
    }

    const distinct = [...new Set(vals.map((x) => String(x.v).trim()).filter(Boolean))];
    if (distinct.length <= 1) {
      out[key] = distinct[0] ?? null;
      continue;
    }
    // Two chunks read this slot differently. Latest wins, and Nicole is told.
    const latest = vals.reduce((a, b) => (b.chunk >= a.chunk ? b : a));
    out[key] = latest.v;
    conflicts.push({ path, chosen: String(latest.v), candidates: distinct });
  }
  return out;
}

// --- Supplements -------------------------------------------------------------

type Supplement = SessionNote['supplements'][number];

/**
 * Merge by normalized name. Field-by-field, last non-null wins — a later chunk
 * refining "two caps" to "two caps with breakfast" is an improvement, not a
 * disagreement — EXCEPT for `change`, where a genuine contradiction (one chunk
 * says start, another says stop) is flagged. Schedule slots are unioned: the
 * practitioner states them one at a time, often minutes apart.
 */
function mergeSupplements(
  items: Traced<Supplement>[],
  conflicts: Conflict[],
): { merged: Supplement[]; originOf: Map<number, Traced<Supplement>[]> } {
  const byKey = new Map<string, Traced<Supplement>[]>();
  for (const item of items) {
    const key = normalizeSupplementName(item.value.name) || `__unnamed_${item.chunk}_${item.origin}`;
    const list = byKey.get(key) ?? [];
    list.push(item);
    byKey.set(key, list);
  }

  const merged: Supplement[] = [];
  const originOf = new Map<number, Traced<Supplement>[]>();

  for (const group of byKey.values()) {
    const ordered = [...group].sort((a, b) => a.chunk - b.chunk);
    const base = { ...ordered[0].value };

    for (const { value: next } of ordered.slice(1)) {
      for (const field of ['dose', 'quantity', 'func', 'obtained_from', 'unit',
        'units_per_dose', 'doses_per_day', 'name_matched_to'] as const) {
        const v = next[field];
        if (v !== null && v !== undefined) (base as Record<string, unknown>)[field] = v;
      }
      // Prefer a spoken name that survived as the longest form — transcription
      // truncates ("Bio C" vs "Bio C Plus") and the fuller spelling is likelier
      // to be right.
      if (next.name && next.name.length > base.name.length) base.name = next.name;

      if (next.schedule) {
        const schedule: Record<string, string | null> = { ...(base.schedule ?? {}) };
        for (const [slot, amount] of Object.entries(next.schedule)) {
          if (amount != null && String(amount).trim()) schedule[slot] = amount as string;
        }
        base.schedule = schedule as Supplement['schedule'];
      }

      // `change` is the field that moves a supplement on or off the client's
      // plan, so a contradiction here is never merged away silently.
      if (next.change !== base.change) {
        const resolvedNext = !next.change_unresolved;
        const resolvedBase = !base.change_unresolved;
        if (resolvedNext && resolvedBase) {
          conflicts.push({
            path: `supplements.${base.name}.change`,
            chosen: next.change,
            candidates: [base.change, next.change],
          });
          base.change = next.change;
        } else if (resolvedNext) {
          // A real reading beats a placeholder — that isn't a disagreement.
          base.change = next.change;
          base.change_raw = next.change_raw;
          base.change_unresolved = next.change_unresolved;
        }
      }
    }

    originOf.set(merged.length, ordered);
    merged.push(base);
  }
  return { merged, originOf };
}

// --- Evidence ----------------------------------------------------------------

/**
 * Re-path evidence onto the merged arrays.
 *
 * Chunk 2's "concerns.0" points into CHUNK 2's array, which after dedupe may be
 * merged index 5 or gone entirely. Left unremapped, every quote past the first
 * chunk would point at the wrong finding — which is worse than no quote at all,
 * since the whole point of provenance is that Nicole can trust it.
 */
function remapEvidence(
  perChunk: { chunk: number; evidence: Evidence[] }[],
  moves: Map<string, string>,
): Evidence[] {
  const out: Evidence[] = [];
  const seen = new Set<string>();
  for (const { chunk, evidence } of perChunk) {
    for (const e of evidence) {
      const mapped = moves.get(`${chunk}::${e.path}`);
      // Scalar paths (nrt.hta, lifestyle.sleep) are stable across chunks and
      // need no remap; array paths that vanished in dedupe are dropped.
      const path = mapped ?? (e.path.match(/\.\d+$/) ? null : e.path);
      if (!path) continue;
      const dedupeKey = `${path}::${e.quote}`;
      if (seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);
      out.push({ ...e, path });
    }
  }
  return out;
}

// --- Entry point -------------------------------------------------------------

const STRING_ARRAYS = ['concerns', 'goals', 'assessments'] as const;

/**
 * Merge chunk-level extractions into one note. Pure — no LLM, no IO — so the
 * rules above are unit-testable on their own, which is the only way this stays
 * trustworthy.
 */
export function mergeChunkNotes(results: ChunkResult[]): MergeResult {
  const ordered = [...results].sort((a, b) => a.index - b.index);
  const conflicts: Conflict[] = [];
  const moves = new Map<string, string>();
  const note: Partial<SessionNote> = {};

  for (const field of STRING_ARRAYS) {
    const items: Traced<string>[] = [];
    for (const { index, note: n } of ordered) {
      (n[field] ?? []).forEach((value, origin) => items.push({ value, chunk: index, origin }));
    }
    if (!items.length) continue;
    const kept = dedupeStrings(items);
    kept.forEach((item, i) => moves.set(`${item.chunk}::${field}.${item.origin}`, `${field}.${i}`));
    note[field] = kept.map((k) => k.value);
  }

  // Follow-ups are a string|object union; dedupe on their text either way.
  {
    const items: Traced<SessionNote['follow_ups'][number]>[] = [];
    for (const { index, note: n } of ordered) {
      (n.follow_ups ?? []).forEach((value, origin) => items.push({ value, chunk: index, origin }));
    }
    if (items.length) {
      const asText = items.map((i) => ({
        ...i,
        value: typeof i.value === 'string' ? i.value : i.value.text,
      }));
      const kept = dedupeStrings(asText);
      kept.forEach((item, i) =>
        moves.set(`${item.chunk}::follow_ups.${item.origin}`, `follow_ups.${i}`),
      );
      note.follow_ups = kept.map(
        (k) => items.find((i) => i.chunk === k.chunk && i.origin === k.origin)!.value,
      );
    }
  }

  {
    const items: Traced<SessionNote['protocol_changes'][number]>[] = [];
    for (const { index, note: n } of ordered) {
      (n.protocol_changes ?? []).forEach((value, origin) =>
        items.push({ value, chunk: index, origin }),
      );
    }
    if (items.length) {
      const asText = items.map((i) => ({ ...i, value: i.value.description }));
      const kept = dedupeStrings(asText);
      kept.forEach((item, i) =>
        moves.set(`${item.chunk}::protocol_changes.${item.origin}`, `protocol_changes.${i}`),
      );
      note.protocol_changes = kept.map(
        (k) => items.find((i) => i.chunk === k.chunk && i.origin === k.origin)!.value,
      );
    }
  }

  {
    const items: Traced<Supplement>[] = [];
    for (const { index, note: n } of ordered) {
      (n.supplements ?? []).forEach((value, origin) => items.push({ value, chunk: index, origin }));
    }
    if (items.length) {
      const { merged, originOf } = mergeSupplements(items, conflicts);
      for (const [mergedIndex, sources] of originOf) {
        for (const s of sources) {
          moves.set(`${s.chunk}::supplements.${s.origin}`, `supplements.${mergedIndex}`);
        }
      }
      note.supplements = merged;
    }
  }

  const nrt = mergeScalars(
    ordered.filter((r) => r.note.nrt).map((r) => ({ value: r.note.nrt as Scalars, chunk: r.index })),
    'nrt',
    conflicts,
  );
  if (nrt) note.nrt = nrt as SessionNote['nrt'];

  const lifestyle = mergeScalars(
    ordered
      .filter((r) => r.note.lifestyle)
      .map((r) => ({ value: r.note.lifestyle as Scalars, chunk: r.index })),
    'lifestyle',
    conflicts,
  );
  if (lifestyle) note.lifestyle = lifestyle as SessionNote['lifestyle'];

  const evidence = remapEvidence(
    ordered.map((r) => ({ chunk: r.index, evidence: r.note.evidence ?? [] })),
    moves,
  );
  if (evidence.length) note.evidence = evidence;

  return { note, conflicts };
}

/** Combine the three stage results into one note. Stages own disjoint fields,
 *  so this is a plain shallow merge plus concatenated evidence. */
export function mergeStages(stages: Partial<SessionNote>[]): Partial<SessionNote> {
  const note: Partial<SessionNote> = {};
  const evidence: Evidence[] = [];
  for (const stage of stages) {
    const { evidence: stageEvidence, ...rest } = stage;
    Object.assign(note, rest);
    if (stageEvidence) evidence.push(...stageEvidence);
  }
  if (evidence.length) note.evidence = evidence;
  return note;
}
