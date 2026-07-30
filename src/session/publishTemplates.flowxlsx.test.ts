import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// FLOW_SHEET_AS_XLSX=true is the interim Flow Sheet transport: instead of the
// Sheets-API append, the whole sheet is rebuilt from the DB and the one .xlsx is
// overwritten in Drive. These pin that the flag routes to the binary-overwrite
// path (docType AppointmentFlowSheet, update:true) and never touches the native
// Sheets calls — so flipping the flag is a clean, side-effect-free swap.

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
import { setDatabaseAdapter, resetDatabaseAdapter, InMemoryMockDatabase } from '../db/index.js';

const NOTE = {
  concerns: ['Fatigue'],
  assessments: [],
  protocol_changes: [],
  supplements: [{ name: 'Cataplex B', dose: '2 daily', quantity: 1, change: 'start' }],
  follow_ups: [],
};

const STARTS_AT = '2026-07-09T15:00:00Z';
const prev = process.env.FLOW_SHEET_AS_XLSX;
let db: InMemoryMockDatabase;

beforeEach(async () => {
  process.env.FLOW_SHEET_AS_XLSX = 'true';
  db = new InMemoryMockDatabase();
  setDatabaseAdapter(db);

  await db.clients.save({
    id: 'c1',
    name: 'Leeza Woodbury',
    email: '',
    drive_folder_id: 'folder1',
    flow_sheet_id: null,
    created_at: STARTS_AT,
    updated_at: STARTS_AT,
  });
  await db.appointments.save({
    id: 'p1',
    client_id: 'c1',
    client_name: 'Leeza Woodbury',
    starts_at: STARTS_AT,
    ends_at: STARTS_AT,
    status: 'completed',
    created_at: STARTS_AT,
    updated_at: STARTS_AT,
  });
  // The protocol's document id IS the appointment id, and the rebuild orders on
  // the denormalized starts_at — a protocol without it is invisible to the
  // chronological query, which is the behaviour the emulator enforces too.
  await db.sessionNotes.saveProtocol({
    id: 'p1',
    appointment_id: 'p1',
    client_id: 'c1',
    client_name: 'Leeza Woodbury',
    starts_at: STARTS_AT,
    content_json: NOTE,
    status: 'approved',
    revision: 1,
    created_at: STARTS_AT,
    updated_at: STARTS_AT,
  });

  publishBinaryDoc.mockReset().mockResolvedValue({ fileId: 'file-x', dryRun: false, skipped: false });
  publishFlowSheet.mockReset();
  rewriteFlowSheetBlock.mockReset();
  ensureConvertedSheet.mockReset();
});

afterEach(() => {
  process.env.FLOW_SHEET_AS_XLSX = prev ?? '';
  resetDatabaseAdapter();
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

  it('rebuilds from every approved session of the client, in visit order', async () => {
    // A second, EARLIER approved session, plus a draft that must not appear.
    const earlier = '2026-05-02T15:00:00Z';
    await db.sessionNotes.saveProtocol({
      id: 'p0',
      appointment_id: 'p0',
      client_id: 'c1',
      starts_at: earlier,
      content_json: { ...NOTE, concerns: ['Earlier visit'] },
      status: 'approved',
      revision: 1,
      created_at: earlier,
      updated_at: earlier,
    });
    await db.sessionNotes.saveProtocol({
      id: 'p2',
      appointment_id: 'p2',
      client_id: 'c1',
      starts_at: '2026-08-01T15:00:00Z',
      content_json: { ...NOTE, concerns: ['Still a draft'] },
      status: 'draft',
      revision: 1,
      created_at: earlier,
      updated_at: earlier,
    });

    const rebuilt = await db.sessionNotes.listProtocolsByClient('c1', { status: 'approved' });
    expect(rebuilt.map((p) => p.id)).toEqual(['p0', 'p1']); // oldest visit first
    await publishClientTemplates('p1');
    expect(flowSheetCall()).toBeDefined();
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
