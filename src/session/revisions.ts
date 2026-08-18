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

export interface Revision {
  revision: number;
  content_json: unknown;
  reason: string | null;
  created_at: string;
}

/** Revision number the NEXT amendment of this row will supersede. */
export async function currentRevision(
  db: PoolClient,
  table: NoteTable,
  id: string,
): Promise<number> {
  const r = await db.query<{ max: number | null }>(
    `SELECT MAX(revision) AS max FROM note_revisions WHERE source_table = $1 AND source_id = $2`,
    [table, id],
  );
  // No history yet means the live row is still revision 1 (the approved one).
  return (r.rows[0]?.max ?? 0) + 1;
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
  const revision = await currentRevision(db, table, id);
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
      ORDER BY revision DESC`,
    [table, id, DRAFT_REPLACED_REASON],
  );
  return r.rows;
}
