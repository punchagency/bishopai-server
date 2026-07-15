import { driveRequest } from './client';

// Google Drive file operations for WF1: find-or-create a per-client folder, and
// upsert a document by name (no duplicates — re-approving updates the same doc).
// Docs are created as Google Docs converted from Markdown.

const FILES = 'https://www.googleapis.com/drive/v3/files';
const UPLOAD = 'https://www.googleapis.com/upload/drive/v3/files';
const FOLDER_MIME = 'application/vnd.google-apps.folder';
const DOC_MIME = 'application/vnd.google-apps.document';

/** Office mime types for the binary renderers (kept as-is, never converted). */
export const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
export const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
/** Native Google Sheet — the Flow Sheet is converted to this so the Sheets API can append to it. */
export const SHEET_MIME = 'application/vnd.google-apps.spreadsheet';

/** Per-client Drive layout: <Client>/<DocType>/<file>. */
export type DocType = 'ROF' | 'SupplementProtocol' | 'AppointmentFlowSheet';

interface FileRef {
  id: string;
  name: string;
}

// Escape single quotes for Drive's query language.
const esc = (s: string) => s.replace(/'/g, "\\'");

async function findByName(name: string, mimeType: string, parentId?: string): Promise<string | null> {
  const clauses = [`name = '${esc(name)}'`, `mimeType = '${mimeType}'`, 'trashed = false'];
  if (parentId) clauses.push(`'${parentId}' in parents`);
  const q = encodeURIComponent(clauses.join(' and '));
  const res = await driveRequest<{ files: FileRef[] }>(
    `${FILES}?q=${q}&fields=files(id,name)&spaces=drive&pageSize=1`,
  );
  return res.files[0]?.id ?? null;
}

/** Find (or create) the client's folder, optionally under a root folder. */
export async function findOrCreateFolder(name: string, parentId?: string): Promise<string> {
  const existing = await findByName(name, FOLDER_MIME, parentId);
  if (existing) return existing;
  const res = await driveRequest<FileRef>(`${FILES}?fields=id`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name, mimeType: FOLDER_MIME, ...(parentId ? { parents: [parentId] } : {}) }),
  });
  return res.id;
}

/**
 * Resolve the doc-type subfolder for a client — `<Client>/<DocType>/` — creating
 * either level if missing. Pass the client's stable folder id when known to skip
 * name-matching the outer folder (avoids misfiling on a renamed/typo'd client).
 */
export async function resolveDocFolder(
  clientName: string,
  docType: DocType,
  opts: { clientFolderId?: string | null; rootFolderId?: string } = {},
): Promise<{ clientFolderId: string; folderId: string }> {
  const clientFolderId = opts.clientFolderId ?? (await findOrCreateFolder(clientName, opts.rootFolderId));
  const folderId = await findOrCreateFolder(docType, clientFolderId);
  return { clientFolderId, folderId };
}

export interface UploadBinaryOpts {
  /** Overwrite an existing same-named file (e.g. a re-rendered ROF). */
  update?: boolean;
  /** If a same-named file already exists, leave it and return it untouched — for
   *  fill-once docs (the intake ROF) that must not be regenerated each session. */
  skipIfExists?: boolean;
}

/**
 * Upload a binary file (docx/xlsx) into `folderId`, preserving it as-is (no Google
 * conversion — that's the whole point of the binary renderers). By default a new
 * file is always created (e.g. date-versioned Supplement Protocols, which must
 * never clobber a prior version). `update` overwrites a same-named file;
 * `skipIfExists` leaves an existing one in place (fill-once ROF).
 */
export async function uploadBinary(
  folderId: string,
  name: string,
  bytes: Buffer,
  mimeType: string,
  opts: UploadBinaryOpts = {},
): Promise<{ id: string; updated: boolean; skipped?: boolean }> {
  const { update = false, skipIfExists = false } = opts;
  const existingId = update || skipIfExists ? await findByName(name, mimeType, folderId) : null;
  if (existingId && skipIfExists) return { id: existingId, updated: false, skipped: true };
  const boundary = `innerlume-${Math.random().toString(36).slice(2)}`;
  // No mimeType in metadata → Drive keeps the uploaded Office type (no conversion).
  const metadata = existingId ? { name } : { name, parents: [folderId] };
  const body =
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n` +
    `${JSON.stringify(metadata)}\r\n` +
    `--${boundary}\r\nContent-Type: ${mimeType}\r\nContent-Transfer-Encoding: base64\r\n\r\n` +
    `${bytes.toString('base64')}\r\n` +
    `--${boundary}--`;

  const url = existingId
    ? `${UPLOAD}/${existingId}?uploadType=multipart&fields=id`
    : `${UPLOAD}?uploadType=multipart&fields=id`;

  const res = await driveRequest<FileRef>(url, {
    method: existingId ? 'PATCH' : 'POST',
    headers: { 'content-type': `multipart/related; boundary=${boundary}` },
    body,
  });
  return { id: res.id, updated: Boolean(existingId) };
}

/**
 * Find a native Google Sheet named `name` in `folderId`, or create one by
 * uploading `xlsxBytes` and letting Drive convert it. Idempotent per (folder,
 * name): the client's Flow Sheet is provisioned once, then appended to. Returns
 * the spreadsheet id and whether it was freshly created.
 */
export async function ensureConvertedSheet(
  folderId: string,
  name: string,
  xlsxBytes: Buffer,
): Promise<{ id: string; created: boolean }> {
  const existing = await findByName(name, SHEET_MIME, folderId);
  if (existing) return { id: existing, created: false };

  const boundary = `innerlume-${Math.random().toString(36).slice(2)}`;
  // Target mimeType = Google Sheet in metadata → Drive converts the xlsx media.
  const metadata = { name, mimeType: SHEET_MIME, parents: [folderId] };
  const body =
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n` +
    `${JSON.stringify(metadata)}\r\n` +
    `--${boundary}\r\nContent-Type: ${XLSX_MIME}\r\nContent-Transfer-Encoding: base64\r\n\r\n` +
    `${xlsxBytes.toString('base64')}\r\n` +
    `--${boundary}--`;

  const res = await driveRequest<FileRef>(`${UPLOAD}?uploadType=multipart&fields=id`, {
    method: 'POST',
    headers: { 'content-type': `multipart/related; boundary=${boundary}` },
    body,
  });
  return { id: res.id, created: true };
}

/** Create or update a Google Doc (from Markdown) named `name` in `folderId`. */
export async function upsertDoc(
  folderId: string,
  name: string,
  markdown: string,
): Promise<{ id: string; updated: boolean }> {
  const existingId = await findByName(name, DOC_MIME, folderId);
  const boundary = `innerlume-${Math.random().toString(36).slice(2)}`;
  const metadata = existingId ? { name } : { name, mimeType: DOC_MIME, parents: [folderId] };
  const body =
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n` +
    `${JSON.stringify(metadata)}\r\n` +
    `--${boundary}\r\nContent-Type: text/markdown\r\n\r\n${markdown}\r\n` +
    `--${boundary}--`;

  const url = existingId
    ? `${UPLOAD}/${existingId}?uploadType=multipart&fields=id`
    : `${UPLOAD}?uploadType=multipart&fields=id`;

  const res = await driveRequest<FileRef>(url, {
    method: existingId ? 'PATCH' : 'POST',
    headers: { 'content-type': `multipart/related; boundary=${boundary}` },
    body,
  });
  return { id: res.id, updated: Boolean(existingId) };
}
