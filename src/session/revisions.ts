import { getDatabase } from '../db/index.js';
import type { NoteTable } from '../db/interfaces/types.js';

// History behind an approved note. Amending doesn't overwrite: it files the
// superseded content in `note_revisions` and then updates the live row, so what
// Nicole originally signed off on is always recoverable — and so the record can
// be reconciled against documents that were already delivered to the client.
//
// The snapshot itself no longer lives here. It happens inside the amend
// transaction, in ISessionNotesRepository.guardedWrite, because filing the
// superseded version and advancing the live one have to be one atomic step:
// between them, the record would claim a revision whose content was nowhere.
// This module is now just the read side.

export type { NoteTable };

export interface Revision {
  revision: number;
  content_json: unknown;
  reason: string | null;
  created_at: string;
}

/** Full history for a row, newest superseded version first. */
export async function fetchRevisions(table: NoteTable, id: string): Promise<Revision[]> {
  const rows = await getDatabase().sessionNotes.listRevisions(table, id);
  return rows.map((r) => ({
    revision: r.revision,
    content_json: r.content_json,
    reason: r.reason ?? null,
    created_at: r.created_at,
  }));
}
