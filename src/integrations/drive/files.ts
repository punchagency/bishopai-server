import { driveRequest } from './client';

// Google Drive file operations for WF1: find-or-create a per-client folder, and
// upsert a document by name (no duplicates — re-approving updates the same doc).
// Docs are created as Google Docs converted from Markdown.

const FILES = 'https://www.googleapis.com/drive/v3/files';
const UPLOAD = 'https://www.googleapis.com/upload/drive/v3/files';
const FOLDER_MIME = 'application/vnd.google-apps.folder';
const DOC_MIME = 'application/vnd.google-apps.document';

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
