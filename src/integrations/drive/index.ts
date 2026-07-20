import { logEvent } from '../../observability/logger';
import type { FlowSheetEntry } from '../docs/types';
import { driveConfig, isDriveConfigured } from './config';
import {
  findOrCreateFolder,
  upsertDoc,
  uploadBinary,
  resolveDocFolder,
  ensureConvertedSheet,
  type DocType,
} from './files';
import { appendFlowSheetEntry, rewriteFlowSheetEntry, type AppendResult } from './sheets';
import { demoDir, writeDemoBinary, appendDemoFlowSheet, writeDemoMarkdown } from './demoSink';

// Presentation mode: setting DEMO_OUTPUT_DIR makes every publish ALSO emit the
// real rendered file to a local folder — in addition to the real Drive write
// when Google creds are configured, not instead of it. So a live demo has
// tangible local artifacts to open regardless of whether Drive is wired up,
// and real Drive writes still happen whenever creds are present.
export const isDemoMode = (): boolean => demoDir() !== null;

export { isDriveConfigured, driveConfig } from './config';
export {
  findOrCreateFolder,
  upsertDoc,
  uploadBinary,
  resolveDocFolder,
  ensureConvertedSheet,
  DOCX_MIME,
  XLSX_MIME,
  SHEET_MIME,
  type DocType,
} from './files';
export { appendFlowSheetEntry, rewriteFlowSheetEntry } from './sheets';

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
  let demoPath: string | undefined;
  if (demoDir()) {
    try {
      demoPath = writeDemoMarkdown(input.clientName, input.title, input.markdown);
    } catch (err) {
      logEvent('warn', 'drive.publish', 'demo markdown write failed', { error: String(err) });
    }
  }

  if (!isDriveConfigured()) {
    logEvent('info', 'drive.publish', demoPath ? 'wrote demo document' : '[dry-run] would write document to Drive', {
      folder: input.clientName,
      title: input.title,
      bytes: input.markdown.length,
      demoPath,
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


export interface BinaryDocInput {
  clientName: string;
  /** Stable client folder id, if stored — preferred over name matching. */
  driveFolderId?: string | null;
  docType: DocType;
  /** File name to write (Supplement Protocols carry a date; the ROF is fixed). */
  fileName: string;
  bytes: Buffer;
  mimeType: string;
  /** Overwrite a same-named file vs always create a new one (dated Supplement). */
  update?: boolean;
  /** Leave an existing same-named file untouched (fill-once intake ROF). */
  skipIfExists?: boolean;
}

export interface BinaryDocResult {
  dryRun?: boolean;
  fileId?: string;
  updated?: boolean;
  /** A fill-once doc that already existed and was left as-is. */
  skipped?: boolean;
  /** The doc-type subfolder id the file landed in. */
  folderId?: string;
  /** The client folder id — persist it per client for next time. */
  clientFolderId?: string;
}

/**
 * Write a rendered binary doc (docx/xlsx) into `<Client>/<DocType>/`, preserving
 * the file as-is. Same dry-run contract as `publishDocument`.
 */
export async function publishBinaryDoc(input: BinaryDocInput): Promise<BinaryDocResult> {
  let demoPath: string | undefined;
  if (demoDir()) {
    try {
      demoPath = writeDemoBinary(input.clientName, input.docType, input.fileName, input.bytes);
    } catch (err) {
      logEvent('warn', 'drive.publishBinary', 'demo artifact write failed', { error: String(err) });
    }
  }

  if (!isDriveConfigured()) {
    logEvent('info', 'drive.publishBinary', demoPath ? 'wrote demo binary doc' : '[dry-run] would write a binary doc to Drive', {
      client: input.clientName,
      docType: input.docType,
      fileName: input.fileName,
      bytes: input.bytes.length,
      demoPath,
    });
    return { dryRun: true };
  }

  const { clientFolderId, folderId } = await resolveDocFolder(input.clientName, input.docType, {
    clientFolderId: input.driveFolderId,
    rootFolderId: driveConfig().rootFolderId,
  });
  const { id, updated, skipped } = await uploadBinary(folderId, input.fileName, input.bytes, input.mimeType, {
    update: input.update,
    skipIfExists: input.skipIfExists,
  });
  logEvent(
    'info',
    'drive.publishBinary',
    skipped
      ? 'binary doc already exists — left as-is'
      : updated
        ? 'updated binary doc in Drive'
        : 'wrote binary doc to Drive',
    { client: input.clientName, docType: input.docType, fileName: input.fileName, fileId: id },
  );
  return { fileId: id, updated, skipped, folderId, clientFolderId };
}

export interface FlowSheetInput {
  /** Client name, for logging only. */
  clientName: string;
  /** Google Sheet id of the client's Appointment Flow Sheet. */
  spreadsheetId: string;
  entry: FlowSheetEntry;
}

export interface FlowSheetPublishResult extends Partial<AppendResult> {
  dryRun?: boolean;
}

/**
 * Append a session block to the client's Flow Sheet (native Google Sheet). Same
 * dry-run contract as `publishDocument`: with no Google creds it logs the intended
 * write and returns `{ dryRun: true }`, so the post-session path is exercisable
 * offline and flips to real Sheets writes the moment credentials land.
 */
/**
 * Rewrite an amended session's own Flow Sheet block, rather than appending.
 * Same shape as publishFlowSheet (demo mirror, dry-run gate), but it overwrites
 * the block already carrying this entry's date — one visit, one block.
 */
export async function rewriteFlowSheetBlock(input: FlowSheetInput): Promise<FlowSheetPublishResult> {
  let demoPath: string | undefined;
  if (demoDir()) {
    try {
      demoPath = await appendDemoFlowSheet(input.clientName, input.entry, { rewrite: true });
    } catch (err) {
      logEvent('warn', 'drive.flowsheet', 'demo Flow Sheet rewrite failed', { error: String(err) });
    }
  }

  if (!isDriveConfigured()) {
    logEvent(
      'info',
      'drive.flowsheet',
      demoPath ? 'rewrote demo Flow Sheet block' : '[dry-run] would rewrite a Flow Sheet block',
      { client: input.clientName, spreadsheetId: input.spreadsheetId, date: input.entry.date, demoPath },
    );
    return { dryRun: true };
  }

  const res = await rewriteFlowSheetEntry(input.spreadsheetId, input.entry);
  logEvent('info', 'drive.flowsheet', 'rewrote Flow Sheet block', {
    client: input.clientName,
    spreadsheetId: input.spreadsheetId,
    block: res.blockIndex,
    rewritten: res.rewritten ?? false,
  });
  return res;
}

export async function publishFlowSheet(input: FlowSheetInput): Promise<FlowSheetPublishResult> {
  let demoPath: string | undefined;
  if (demoDir()) {
    try {
      demoPath = await appendDemoFlowSheet(input.clientName, input.entry);
    } catch (err) {
      logEvent('warn', 'drive.flowsheet', 'demo Flow Sheet write failed', { error: String(err) });
    }
  }

  if (!isDriveConfigured()) {
    logEvent('info', 'drive.flowsheet', demoPath ? 'appended demo Flow Sheet block' : '[dry-run] would append a Flow Sheet block', {
      client: input.clientName,
      spreadsheetId: input.spreadsheetId,
      date: input.entry.date,
      demoPath,
    });
    return { dryRun: true };
  }

  const res = await appendFlowSheetEntry(input.spreadsheetId, input.entry);
  logEvent('info', 'drive.flowsheet', 'appended Flow Sheet block', {
    client: input.clientName,
    spreadsheetId: input.spreadsheetId,
    block: res.blockIndex,
    headerRow: res.headerRow,
  });
  return res;
}
