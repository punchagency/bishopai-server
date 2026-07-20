import type { PoolClient } from 'pg';
import { pool } from '../db/pool';

// History behind an approved note. Amending doesn't overwrite: it files the
// superseded content in `note_revisions` and then updates the live row, so what
// Nicole originally signed off on is always recoverable — and so the record can
// be reconciled against documents that were already delivered to the client.

export type NoteTable = 'appointment_sheets' | 'protocols';

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

/** Full history for a row, newest superseded version first. */
export async function fetchRevisions(table: NoteTable, id: string): Promise<Revision[]> {
  const r = await pool.query<Revision>(
    `SELECT revision, content_json, reason, created_at
       FROM note_revisions
      WHERE source_table = $1 AND source_id = $2
      ORDER BY revision DESC`,
    [table, id],
  );
  return r.rows;
}
