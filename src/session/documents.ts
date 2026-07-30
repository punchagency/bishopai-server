import { getDatabase } from '../db/index.js';
import type { DocumentRecord, DocumentType } from '../db/interfaces/types.js';
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

export type { DocumentType };

let seq = 0;
/** Documents are append-only history, so ids only need to be unique. */
const documentId = (): string =>
  `doc_${Date.now().toString(36)}_${(seq++).toString(36)}_${Math.random().toString(36).slice(2, 7)}`;

export async function recordDocument(
  clientId: string | null,
  type: DocumentType,
  driveFileId: string | null | undefined,
  appointmentId?: string | null,
): Promise<void> {
  if (!clientId || !driveFileId) return; // dry-run publishes have no file id
  try {
    await getDatabase().documents.save({
      id: documentId(),
      client_id: clientId,
      appointment_id: appointmentId ?? null,
      type,
      drive_file_id: driveFileId,
      storage_path: null,
      created_at: new Date().toISOString(),
    });
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
  const rows: DocumentRecord[] = await getDatabase().documents.listByClient(clientId, 100);
  return rows.map((r) => ({
    id: r.id,
    drive_file_id: r.drive_file_id ?? null,
    type: r.type ?? null,
    created_at: r.created_at,
  }));
}
