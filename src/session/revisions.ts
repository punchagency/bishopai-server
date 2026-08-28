import type { PoolClient } from 'pg';
import { pool } from '../db/pool';

// History behind an approved note. Amending doesn't overwrite: it files the
// superseded content in `note_revisions` and then updates the live row, so what
// Nicole originally signed off on is always recoverable — and so the record can
// be reconciled against documents that were already delivered to the client.
//
// One other path writes here: re-extraction snapshots the draft it is about to
// replace, so gambling on a nondeterministic model is not a destructive act.
// Those rows are NOT amendments — nothing about them was ever approved — and
// they only appear while the extraction pipeline is being tested, since a real
// session is extracted once. Listing them alongside amendments told the review
// pane a draft had been "amended" three times when it had merely been re-run,
// so they are filtered out of the history a reviewer sees.

export type NoteTable = 'appointment_sheets' | 'protocols';

/** Written as the `reason` on a draft snapshot, and the only thing marking those
 *  rows apart. Shared with the re-extract handler so the string that filters is
 *  the same one that was stored, rather than a copy that can drift from it. */
export const DRAFT_REPLACED_REASON = 're-extraction — draft replaced by a fresh run';

/**
 * Written as the `reason` on an extraction baseline.
 *
 * The model's output, filed the moment before a human first edits it. Together
 * with the edited note that replaces it, one row here is one training pair:
 * what the extractor produced, and what it should have produced.
 *
 * Nothing in the product reads these — they are filtered out of history exactly
 * like draft snapshots. They exist because the pair is only observable at the
 * instant of the first edit: after it, the extractor's version is gone and no
 * amount of later work recovers it. Every session edited before this was
 * running is a pair that no longer exists.
 */
export const EXTRACTION_BASELINE_REASON = 'extraction baseline — model output before any edit';

export interface Revision {
  revision: number;
  content_json: unknown;
  reason: string | null;
  created_at: string;
}

/**
 * Reasons whose rows are filtered out of the history a reviewer sees.
 *
 * They also number differently — see nextHiddenRevision. Kept as one list so
 * "hidden from history" and "outside the visible numbering" can never disagree:
 * a row in one and not the other is exactly the bug this pair was written for.
 */
const HIDDEN_REASONS: readonly string[] = [DRAFT_REPLACED_REASON, EXTRACTION_BASELINE_REASON];

/** Revision number the NEXT amendment of this row will supersede.
 *
 *  Counts only positive revisions, which is the same thing as counting only the
 *  amendments: hidden snapshots take negative numbers precisely so they cannot
 *  push this one along. */
export async function currentRevision(
  db: PoolClient,
  table: NoteTable,
  id: string,
): Promise<number> {
  const r = await db.query<{ max: number | null }>(
    `SELECT MAX(revision) AS max FROM note_revisions
      WHERE source_table = $1 AND source_id = $2 AND revision > 0`,
    [table, id],
  );
  // No history yet means the live row is still revision 1 (the approved one).
  return (r.rows[0]?.max ?? 0) + 1;
}

/**
 * The next slot for a snapshot nobody reads: -1, then -2, and downwards.
 *
 * A separate sequence because revision is user-visible. Amendments are numbered
 * for the person reading them — "amended twice" has to mean two amendments —
 * and a shared counter made every invisible capture bump that number. With the
 * baseline firing on the FIRST edit of every session, it would have shifted the
 * numbering on essentially every note in the practice.
 *
 * Negative rather than a second column so no migration is needed, and it stays
 * collision-free against rows already in production: existing draft snapshots
 * hold positive numbers, `currentRevision` still counts past them, and nothing
 * already written moves.
 */
async function nextHiddenRevision(
  db: PoolClient,
  table: NoteTable,
  id: string,
): Promise<number> {
  const r = await db.query<{ min: number | null }>(
    `SELECT MIN(revision) AS min FROM note_revisions
      WHERE source_table = $1 AND source_id = $2`,
    [table, id],
  );
  return Math.min(0, r.rows[0]?.min ?? 0) - 1;
}

/**
 * Snapshot the row's current content as a superseded revision. Runs inside the
 * amend transaction so a failed amendment can't leave orphaned history.
 */
export async function snapshotRevision(
  db: PoolClient,
  table: NoteTable,
  id: string,
  contentJson: unknown,
  reason: string | null,
): Promise<number> {
  const revision =
    reason !== null && HIDDEN_REASONS.includes(reason)
      ? await nextHiddenRevision(db, table, id)
      : await currentRevision(db, table, id);
  await db.query(
    `INSERT INTO note_revisions (source_table, source_id, content_json, revision, reason)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (source_table, source_id, revision) DO NOTHING`,
    [table, id, JSON.stringify(contentJson), revision, reason],
  );
  return revision;
}

/**
 * Amendment history for a row, newest superseded version first.
 *
 * Draft snapshots are excluded here rather than at the call site: they are the
 * re-extract button's undo buffer, not history anyone reviews, and every caller
 * of this wants the amendments. They stay in the table — filtered out of sight,
 * not deleted, so a bad re-run is still recoverable by hand.
 */
export async function fetchRevisions(table: NoteTable, id: string): Promise<Revision[]> {
  const r = await pool.query<Revision>(
    `SELECT revision, content_json, reason, created_at
       FROM note_revisions
      WHERE source_table = $1 AND source_id = $2
        AND (reason IS DISTINCT FROM $3)
        AND (reason IS DISTINCT FROM $4)
      ORDER BY revision DESC`,
    [table, id, DRAFT_REPLACED_REASON, EXTRACTION_BASELINE_REASON],
  );
  return r.rows;
}

/**
 * File the model's output before the first human edit lands on it. No-op if a
 * baseline for this row already stands.
 *
 * "Already stands" is deliberately not "already exists". A re-extraction throws
 * the draft away and replaces it with a fresh model run, which makes the old
 * baseline the wrong half of the pair — it is no longer the text anyone is
 * editing. So a baseline only counts if it was taken AFTER the most recent
 * re-extraction of the same row; otherwise the next edit captures a new one.
 *
 * Compared by capture time rather than revision number, because the two kinds
 * of row no longer share a scale: hidden snapshots count downwards, so "newer"
 * and "greater" are opposites here and a numeric comparison reads as its own
 * inverse. created_at is the thing actually being asked about.
 *
 * `>=` and not `>`: if the two ever landed in the same instant, treating the
 * baseline as standing skips a capture, while the other way round would file
 * Nicole's own edit as though the model had written it — a poisoned training
 * pair, and the failure that cannot be spotted later.
 *
 * Returns the revision written, or null if a baseline was already standing.
 */
export async function snapshotExtractionBaseline(
  db: PoolClient,
  table: NoteTable,
  id: string,
  contentJson: unknown,
): Promise<number | null> {
  const r = await db.query<{ standing: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM note_revisions
        WHERE source_table = $1 AND source_id = $2 AND reason = $3
          AND created_at >= COALESCE(
                (SELECT MAX(created_at) FROM note_revisions
                  WHERE source_table = $1 AND source_id = $2 AND reason = $4),
                '-infinity'::timestamptz)
     ) AS standing`,
    [table, id, EXTRACTION_BASELINE_REASON, DRAFT_REPLACED_REASON],
  );
  if (r.rows[0]?.standing) return null;
  return snapshotRevision(db, table, id, contentJson, EXTRACTION_BASELINE_REASON);
}
