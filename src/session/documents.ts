import { pool } from '../db/pool';
import { logError } from '../observability/logger';

// A record of what was actually published, for which client, and where it landed.
//
// The `documents` table existed from the first migration and nothing ever wrote
// to it: publishing returned Drive file ids and threw them away. That left no way
// to answer the questions that matter when something looks wrong — did her ROF
// actually get written? which Supplement Protocol version is the current one? did
// the Flow Sheet append succeed, or did it fail quietly two months ago?
//
// Best-effort by design. A failure to record must never fail a publish that has
// already succeeded; a missing audit row is a smaller problem than a document
// that didn't reach the client.

export type DocumentType = 'ROF' | 'SupplementProtocol' | 'AppointmentFlowSheet' | 'Markdown';

export async function recordDocument(
  clientId: string | null,
  type: DocumentType,
  driveFileId: string | null | undefined,
): Promise<void> {
  if (!clientId || !driveFileId) return; // dry-run publishes have no file id
  try {
    await pool.query(
      `INSERT INTO documents (client_id, drive_file_id, type) VALUES ($1, $2, $3)`,
      [clientId, driveFileId, type],
    );
  } catch (err) {
    logError('documents.record', 'failed to record a published document', err, {
      client_id: clientId,
      type,
    });
  }
}

export interface PublishedDocument {
  id: string;
  drive_file_id: string | null;
  type: string | null;
  created_at: string;
}

/** Everything published for a client, newest first. */
export async function fetchClientDocuments(clientId: string): Promise<PublishedDocument[]> {
  const r = await pool.query<PublishedDocument>(
    `SELECT id, drive_file_id, type, created_at
       FROM documents WHERE client_id = $1 ORDER BY created_at DESC LIMIT 100`,
    [clientId],
  );
  return r.rows;
}
