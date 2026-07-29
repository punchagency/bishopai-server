import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// FLOW_SHEET_AS_XLSX=true is the interim Flow Sheet transport: instead of the
// Sheets-API append, the whole sheet is rebuilt from the DB and the one .xlsx is
// overwritten in Drive. These pin that the flag routes to the binary-overwrite
// path (docType AppointmentFlowSheet, update:true) and never touches the native
// Sheets calls — so flipping the flag is a clean, side-effect-free swap.

const query = vi.fn();
vi.mock('../db/pool', () => ({ pool: { query: (...a: unknown[]) => query(...a) } }));

vi.mock('../integrations/outlook', () => ({ sendEmail: vi.fn().mockResolvedValue({ ok: true }) }));

const publishBinaryDoc = vi.fn();
const publishFlowSheet = vi.fn();
const rewriteFlowSheetBlock = vi.fn();
const ensureConvertedSheet = vi.fn();
const resolveDocFolder = vi.fn();
vi.mock('../integrations/drive', () => ({
  publishBinaryDoc: (...a: unknown[]) => publishBinaryDoc(...a),
  publishFlowSheet: (...a: unknown[]) => publishFlowSheet(...a),
  rewriteFlowSheetBlock: (...a: unknown[]) => rewriteFlowSheetBlock(...a),
  resolveDocFolder: (...a: unknown[]) => resolveDocFolder(...a),
  ensureConvertedSheet: (...a: unknown[]) => ensureConvertedSheet(...a),
  isDriveConfigured: () => true,
  isDemoMode: () => false,
  driveConfig: () => ({ rootFolderId: null }),
  DOCX_MIME: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  XLSX_MIME: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
}));

import { publishClientTemplates, republishAmended } from './publishTemplates';

const NOTE = {
  concerns: ['Fatigue'],
  assessments: [],
  protocol_changes: [],
  supplements: [{ name: 'Cataplex B', dose: '2 daily', quantity: 1, change: 'start' }],
  follow_ups: [],
};

function protocolRow() {
  return {
    rowCount: 1,
    rows: [
      {
        content_json: NOTE,
        client_id: 'c1',
        client_name: 'Leeza Woodbury',
        client_email: null,
        drive_folder_id: 'folder1',
        flow_sheet_id: null,
        starts_at: '2026-07-09T15:00:00Z',
      },
    ],
  };
}

const prev = process.env.FLOW_SHEET_AS_XLSX;

beforeEach(() => {
  process.env.FLOW_SHEET_AS_XLSX = 'true';
  query.mockReset().mockImplementation((sql: string) =>
    String(sql).includes('SELECT') ? Promise.resolve(protocolRow()) : Promise.resolve({ rowCount: 0, rows: [] }),
  );
  publishBinaryDoc.mockReset().mockResolvedValue({ fileId: 'file-x', dryRun: false, skipped: false });
  publishFlowSheet.mockReset();
  rewriteFlowSheetBlock.mockReset();
  ensureConvertedSheet.mockReset();
});

afterEach(() => {
  process.env.FLOW_SHEET_AS_XLSX = prev ?? '';
  vi.clearAllMocks();
});

/** The publishBinaryDoc call that wrote the Flow Sheet, if any. */
function flowSheetCall(): Record<string, unknown> | undefined {
  return publishBinaryDoc.mock.calls
    .map((c) => c[0] as Record<string, unknown>)
    .find((i) => i.docType === 'AppointmentFlowSheet');
}

describe('publishClientTemplates — FLOW_SHEET_AS_XLSX', () => {
  it('overwrites the Flow Sheet as an .xlsx and never calls the Sheets API', async () => {
    await publishClientTemplates('p1');

    const call = flowSheetCall();
    expect(call).toBeDefined();
    expect(call!.update).toBe(true);
    expect(call!.fileName).toBe('Leeza Woodbury Appointment Flow Sheet.xlsx');
    expect((call!.bytes as Buffer).length).toBeGreaterThan(1000);

    // The native Sheets path is untouched.
    expect(publishFlowSheet).not.toHaveBeenCalled();
    expect(ensureConvertedSheet).not.toHaveBeenCalled();
  });

  it('rebuilds from the client’s approved sessions (queries protocols by client)', async () => {
    await publishClientTemplates('p1');
    const rebuildQuery = query.mock.calls.find(
      (c) => String(c[0]).includes('FROM protocols') && String(c[0]).includes("status = 'approved'"),
    );
    expect(rebuildQuery).toBeDefined();
    expect(rebuildQuery![1]).toEqual(['c1']);
  });

  it('reverts to the native Sheets path when the flag is off', async () => {
    process.env.FLOW_SHEET_AS_XLSX = '';
    publishFlowSheet.mockResolvedValue({ blockIndex: 0 });
    ensureConvertedSheet.mockResolvedValue({ id: 'sheet1', created: true });
    resolveDocFolder.mockResolvedValue({ folderId: 'ff', clientFolderId: 'cf' });

    await publishClientTemplates('p1');

    expect(publishFlowSheet).toHaveBeenCalled();
    expect(flowSheetCall()).toBeUndefined(); // no binary Flow Sheet written
  });
});

describe('republishAmended — FLOW_SHEET_AS_XLSX', () => {
  it('re-overwrites the .xlsx instead of rewriting a Sheet block', async () => {
    await republishAmended('p1');

    expect(flowSheetCall()).toBeDefined();
    expect(rewriteFlowSheetBlock).not.toHaveBeenCalled();
  });
});
