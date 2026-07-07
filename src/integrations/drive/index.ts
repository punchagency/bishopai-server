import { logEvent } from '../../observability/logger';
import { driveConfig, isDriveConfigured } from './config';
import { findOrCreateFolder, upsertDoc } from './files';

export { isDriveConfigured, driveConfig } from './config';
export { findOrCreateFolder, upsertDoc } from './files';

export interface PublishInput {
  /** Client folder name (used only when no stable folder id is known yet). */
  clientName: string;
  /** Stable Drive folder id for this client, if we've stored one. Preferred over
   *  name matching so a renamed/typo'd client never misfiles into a shared bucket. */
  driveFolderId?: string | null;
  /** Document title. */
  title: string;
  markdown: string;
}

export interface PublishResult {
  dryRun?: boolean;
  fileId?: string;
  updated?: boolean;
  /** The folder id the doc was written into — persist it per client for next time. */
  folderId?: string;
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

  // Address the folder by its stable id when known; only fall back to name
  // matching (find-or-create) for a client we haven't filed for yet.
  const folderId = input.driveFolderId ?? (await findOrCreateFolder(input.clientName, driveConfig().rootFolderId));
  const { id, updated } = await upsertDoc(folderId, input.title, input.markdown);
  logEvent('info', 'drive.publish', updated ? 'updated document in Drive' : 'wrote document to Drive', {
    folder: input.clientName,
    title: input.title,
    fileId: id,
  });
  return { fileId: id, updated, folderId };
}
