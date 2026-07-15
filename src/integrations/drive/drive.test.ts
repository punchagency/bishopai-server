import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { isDriveConfigured, driveConfig, publishDocument, publishFlowSheet, publishBinaryDoc, DOCX_MIME } from './index';
import { resetDriveToken } from './client';

function configureDrive() {
  process.env.GOOGLE_CLIENT_ID = 'id';
  process.env.GOOGLE_CLIENT_SECRET = 'secret';
  process.env.GOOGLE_REFRESH_TOKEN = 'refresh';
  resetDriveToken();
}

// Hermetic: these assert Drive's UNCONFIGURED (dry-run) behavior, so clear any
// GOOGLE_* creds a developer may have in .env before each test — otherwise a
// real .env flips isDriveConfigured() true and the dry-run assertions fail.
function clearDriveEnv() {
  delete process.env.GOOGLE_CLIENT_ID;
  delete process.env.GOOGLE_CLIENT_SECRET;
  delete process.env.GOOGLE_REFRESH_TOKEN;
}
beforeEach(clearDriveEnv);
afterEach(() => {
  vi.restoreAllMocks();
  clearDriveEnv();
});

describe('drive config gating', () => {
  it('isDriveConfigured reflects env', () => {
    expect(isDriveConfigured()).toBe(false);
    process.env.GOOGLE_CLIENT_ID = 'id';
    process.env.GOOGLE_CLIENT_SECRET = 'secret';
    process.env.GOOGLE_REFRESH_TOKEN = 'refresh';
    expect(isDriveConfigured()).toBe(true);
  });

  it('driveConfig throws when unset', () => {
    expect(() => driveConfig()).toThrow(/not configured/);
  });
});

describe('publishDocument', () => {
  it('dry-runs (no fetch) when Drive is unconfigured', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const result = await publishDocument({ clientName: 'Jane Doe', title: 'Protocol', markdown: '# hi' });
    expect(result.dryRun).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled(); // never touches Google when unconfigured
  });
});

describe('publishFlowSheet', () => {
  it('dry-runs (no fetch) when Drive is unconfigured', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const result = await publishFlowSheet({
      clientName: 'Jane Doe',
      spreadsheetId: 'sheet1',
      entry: { date: 'Jul 9, 2026' },
    });
    expect(result.dryRun).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('writes into the first empty block via the Sheets API when configured', async () => {
    configureDrive();

    // Block 0 (date cell A2) is filled; block 1 (A15) is empty → target block 1.
    const colA = [['DATE', 'Jun 1, 2026', '', '', '', '', '', '', '', '', '', '', '', 'DATE', '']];
    let batchBody: unknown;
    const ok = (obj: unknown) => ({ ok: true, status: 200, text: async () => JSON.stringify(obj) });
    const fetchMock = vi.fn(async (url: string, init?: { method?: string; body?: string }) => {
      if (url.includes('oauth2') || url.includes('/token')) return ok({ access_token: 't', expires_in: 3600 });
      if (url.includes('fields=sheets('))
        return ok({ sheets: [{ properties: { title: 'Sheet1', gridProperties: { rowCount: 26 } } }] });
      if (url.includes('/values/') && (!init?.method || init.method === 'GET')) return ok({ values: colA });
      if (url.includes('values:batchUpdate')) {
        batchBody = JSON.parse(init!.body!);
        return ok({ totalUpdatedCells: 2 });
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const res = await publishFlowSheet({
      clientName: 'Jane Doe',
      spreadsheetId: 'sheetABC',
      entry: { date: 'Jul 9, 2026', symptoms: 'Fatigue' },
    });

    expect(res.dryRun).toBeUndefined();
    expect(res.blockIndex).toBe(1);
    expect(res.headerRow).toBe(14); // block 1 header row
    // Values targeted block 1's data rows (A15 = date, C15 = symptoms).
    const data = (batchBody as { valueInputOption: string; data: { range: string; values: string[][] }[] });
    expect(data.valueInputOption).toBe('RAW');
    const byRange = Object.fromEntries(data.data.map((d) => [d.range, d.values[0][0]]));
    expect(byRange['Sheet1!A15']).toBe('Jul 9, 2026');
    expect(byRange['Sheet1!C15']).toBe('Fatigue');
  });

  it('is idempotent by date — a block already carrying the date is not re-written', async () => {
    configureDrive();
    // Block 0's date cell (A2) already holds the entry's date.
    const colA = [['DATE', 'Jul 9, 2026', '', '', '', '', '', '', '', '', '', '', '', 'DATE', '']];
    const ok = (obj: unknown) => ({ ok: true, status: 200, text: async () => JSON.stringify(obj) });
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes('oauth2') || url.includes('/token')) return ok({ access_token: 't', expires_in: 3600 });
      if (url.includes('fields=sheets('))
        return ok({ sheets: [{ properties: { title: 'Sheet1', gridProperties: { rowCount: 26 } } }] });
      if (url.includes('/values/')) return ok({ values: colA });
      throw new Error(`unexpected fetch (should not batchUpdate): ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const res = await publishFlowSheet({
      clientName: 'Jane Doe',
      spreadsheetId: 'sheetABC',
      entry: { date: 'Jul 9, 2026', symptoms: 'Fatigue' },
    });
    expect(res.alreadyPresent).toBe(true);
    expect(res.blockIndex).toBe(0);
    // No batchUpdate was issued (the mock throws if one is attempted).
    expect(fetchMock.mock.calls.some((c) => String(c[0]).includes('batchUpdate'))).toBe(false);
  });
});

describe('publishBinaryDoc', () => {
  it('dry-runs (no fetch) when Drive is unconfigured', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const result = await publishBinaryDoc({
      clientName: 'Jane Doe',
      docType: 'ROF',
      fileName: 'ROF.docx',
      bytes: Buffer.from('hi'),
      mimeType: DOCX_MIME,
      update: true,
    });
    expect(result.dryRun).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('resolves <Client>/<DocType>/ and uploads the bytes as an unconverted, base64 file', async () => {
    configureDrive();
    const created: { name: string; parents?: string[] }[] = [];
    let uploadBody = '';
    let uploadMethod = '';
    const ok = (obj: unknown) => ({ ok: true, status: 200, text: async () => JSON.stringify(obj) });
    const fetchMock = vi.fn(async (url: string, init?: { method?: string; body?: string }) => {
      if (url.includes('oauth2') || url.includes('/token')) return ok({ access_token: 't', expires_in: 3600 });
      // Folder lookups: none exist yet → create. Track creation payloads.
      if (url.startsWith('https://www.googleapis.com/drive/v3/files?q=')) return ok({ files: [] });
      if (url.startsWith('https://www.googleapis.com/drive/v3/files?fields=id') && init?.method === 'POST') {
        const meta = JSON.parse(init.body!);
        created.push(meta);
        return ok({ id: `folder-${created.length}` });
      }
      if (url.startsWith('https://www.googleapis.com/upload/drive/v3/files')) {
        uploadMethod = init!.method!;
        uploadBody = init!.body!;
        return ok({ id: 'file-xyz' });
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const res = await publishBinaryDoc({
      clientName: 'Jane Doe',
      docType: 'ROF',
      fileName: 'ROF.docx',
      bytes: Buffer.from('DOCXBYTES'),
      mimeType: DOCX_MIME,
      update: true,
    });

    expect(res.fileId).toBe('file-xyz');
    // Created the client folder, then the ROF subfolder nested under it.
    expect(created[0]).toMatchObject({ name: 'Jane Doe' });
    expect(created[1]).toMatchObject({ name: 'ROF', parents: ['folder-1'] });
    // No existing ROF found (update lookup returned []), so it's a create (POST).
    expect(uploadMethod).toBe('POST');
    // Media part preserves the docx type and is base64 (no Google conversion).
    expect(uploadBody).toContain(`Content-Type: ${DOCX_MIME}`);
    expect(uploadBody).toContain('Content-Transfer-Encoding: base64');
    expect(uploadBody).toContain(Buffer.from('DOCXBYTES').toString('base64'));
    // Metadata has no Google mimeType (would force conversion).
    expect(uploadBody).not.toContain('application/vnd.google-apps');
  });
});
