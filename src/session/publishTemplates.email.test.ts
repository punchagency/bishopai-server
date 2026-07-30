import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Emailing a client their filled protocol sends clinical docs out of the practice,
// so the guard around it (opt-in flag + an address on file) is what these tests pin
// down. Drive/DB/Graph are all stubbed — we assert on what the mailer was handed.

const sendEmail = vi.fn();
vi.mock('../integrations/outlook', () => ({ sendEmail: (...a: unknown[]) => sendEmail(...a) }));

const publishBinaryDoc = vi.fn();
vi.mock('../integrations/drive', () => ({
  publishBinaryDoc: (...a: unknown[]) => publishBinaryDoc(...a),
  publishFlowSheet: vi.fn().mockResolvedValue({ blockIndex: 0 }),
  resolveDocFolder: vi.fn(),
  ensureConvertedSheet: vi.fn(),
  isDriveConfigured: () => false,
  isDemoMode: () => false,
  driveConfig: () => ({ rootFolderId: null }),
  DOCX_MIME: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  XLSX_MIME: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
}));

import { publishClientTemplates } from './publishTemplates';
import { setDatabaseAdapter, resetDatabaseAdapter, InMemoryMockDatabase } from '../db/index.js';

const NOTE = {
  concerns: ['Fatigue'],
  assessments: [],
  protocol_changes: [],
  supplements: [{ name: 'Cataplex B', dose: '2 daily', quantity: 1, change: 'start' }],
  follow_ups: [],
};

const STARTS_AT = '2026-07-09T15:00:00Z';
const prev = process.env.EMAIL_PROTOCOL_TO_CLIENT;
let db: InMemoryMockDatabase;

/** Seed one approved protocol, with an overridable address on the client. */
async function seed(email: string): Promise<void> {
  await db.clients.save({
    id: 'c1',
    name: 'Leeza Woodbury',
    email,
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
}

beforeEach(async () => {
  db = new InMemoryMockDatabase();
  setDatabaseAdapter(db);
  await seed('leeza@example.com');
  sendEmail.mockReset().mockResolvedValue({ ok: true });
  // Default: ROF newly created (not skipped) → it rides along on the email.
  publishBinaryDoc.mockReset().mockResolvedValue({ fileId: 'f1', dryRun: true, skipped: false });
});

afterEach(() => {
  process.env.EMAIL_PROTOCOL_TO_CLIENT = prev ?? '';
  resetDatabaseAdapter();
  vi.clearAllMocks();
});

describe('publishClientTemplates — emailing the client', () => {
  it('does not email at all unless explicitly enabled', async () => {
    process.env.EMAIL_PROTOCOL_TO_CLIENT = '';
    const res = await publishClientTemplates('p1');

    expect(sendEmail).not.toHaveBeenCalled();
    expect(res.emailed).toBeUndefined();
  });

  it('attaches the ROF and the dated Supplement on the intake session', async () => {
    process.env.EMAIL_PROTOCOL_TO_CLIENT = 'true';
    const res = await publishClientTemplates('p1');

    expect(res.emailed).toBe(true);
    const [input] = sendEmail.mock.calls[0];
    expect(input.to).toBe('leeza@example.com');
    expect(input.body).toContain('Hi Leeza,');
    expect(input.attachments.map((a: { name: string }) => a.name)).toEqual([
      'ROF.docx',
      'Supplement Protocol 7_9_26.xlsx',
    ]);
    // Real rendered bytes, not placeholders.
    expect(input.attachments[1].content.length).toBeGreaterThan(1000);
  });

  it('leaves the ROF off a follow-up, where it already existed', async () => {
    process.env.EMAIL_PROTOCOL_TO_CLIENT = 'true';
    publishBinaryDoc
      .mockResolvedValueOnce({ fileId: 'f1', dryRun: true, skipped: true }) // ROF already there
      .mockResolvedValueOnce({ fileId: 'f2', dryRun: true, skipped: false }); // Supplement

    await publishClientTemplates('p1');

    const [input] = sendEmail.mock.calls[0];
    expect(input.attachments.map((a: { name: string }) => a.name)).toEqual([
      'Supplement Protocol 7_9_26.xlsx',
    ]);
    expect(input.body).not.toContain('Report of Findings');
  });

  it('skips the email when the client has no address on file', async () => {
    process.env.EMAIL_PROTOCOL_TO_CLIENT = 'true';
    await seed(''); // no address — pg stored NULL, the document stores empty

    const res = await publishClientTemplates('p1');
    expect(sendEmail).not.toHaveBeenCalled();
    expect(res.emailed).toBeUndefined();
  });

  it('still publishes the docs when the email fails', async () => {
    process.env.EMAIL_PROTOCOL_TO_CLIENT = 'true';
    sendEmail.mockResolvedValue({ ok: false, error: 'mailbox unavailable' });

    const res = await publishClientTemplates('p1');

    // The docs are in Drive; a mail failure is reported, not thrown.
    expect(res.emailed).toBe(false);
    expect(res.supplementFileId).toBe('f1');
  });
});
