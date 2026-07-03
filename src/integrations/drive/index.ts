import { logEvent } from '../../observability/logger';
import { driveConfig, isDriveConfigured } from './config';
import { findOrCreateFolder, upsertDoc } from './files';

export { isDriveConfigured, driveConfig } from './config';
export { findOrCreateFolder, upsertDoc } from './files';

export interface PublishInput {
  /** Client folder name (documents are grouped per client). */
  clientName: string;
  /** Document title. */
  title: string;
  markdown: string;
}

export interface PublishResult {
  dryRun?: boolean;
  fileId?: string;
  updated?: boolean;
}

/**
 * Write a rendered document into the client's Drive folder (find-or-create the
 * folder, upsert the doc by name). When Drive isn't configured yet, this is a
 * **dry run**: it logs exactly what would be written, so the WF1 approve→Drive
 * path is exercisable before Google OAuth is set up, and flips to real writes
 * the moment credentials land — no wiring change.
 */
export async function publishDocument(input: PublishInput): Promise<PublishResult> {
  if (!isDriveConfigured()) {
    logEvent('info', 'drive.publish', '[dry-run] would write document to Drive', {
      folder: input.clientName,
      title: input.title,
      bytes: input.markdown.length,
    });
    return { dryRun: true };
  }

  const folderId = await findOrCreateFolder(input.clientName, driveConfig().rootFolderId);
  const { id, updated } = await upsertDoc(folderId, input.title, input.markdown);
  logEvent('info', 'drive.publish', updated ? 'updated document in Drive' : 'wrote document to Drive', {
    folder: input.clientName,
    title: input.title,
    fileId: id,
  });
  return { fileId: id, updated };
}
