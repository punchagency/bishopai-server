import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Emailing a client their filled protocol sends clinical docs out of the practice,
// so the guard around it (opt-in flag + an address on file) is what these tests pin
// down. Drive/DB/Graph are all stubbed — we assert on what the mailer was handed.

const query = vi.fn();
vi.mock('../db/pool', () => ({ pool: { query: (...a: unknown[]) => query(...a) } }));

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

const NOTE = {
  concerns: ['Fatigue'],
  assessments: [],
  protocol_changes: [],
  supplements: [{ name: 'Cataplex B', dose: '2 daily', quantity: 1, change: 'start' }],
  follow_ups: [],
};

/** The protocol row publishClientTemplates loads, with an overridable client email. */
function protocolRow(email: string | null) {
  return {
    rowCount: 1,
    rows: [
      {
        content_json: NOTE,
        client_id: 'c1',
        client_name: 'Leeza Woodbury',
        client_email: email,
        drive_folder_id: null,
        flow_sheet_id: null,
        starts_at: '2026-07-09T15:00:00Z',
      },
    ],
  };
}

const prev = process.env.EMAIL_PROTOCOL_TO_CLIENT;

beforeEach(() => {
  query.mockReset().mockImplementation((sql: string) => {
    if (String(sql).includes('SELECT')) return Promise.resolve(protocolRow('leeza@example.com'));
    return Promise.resolve({ rowCount: 0, rows: [] }); // the persistIds UPDATE
  });
  sendEmail.mockReset().mockResolvedValue({ ok: true });
  // Default: ROF newly created (not skipped) → it rides along on the email.
  publishBinaryDoc.mockReset().mockResolvedValue({ fileId: 'f1', dryRun: true, skipped: false });
});

afterEach(() => {
  process.env.EMAIL_PROTOCOL_TO_CLIENT = prev ?? '';
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
    query.mockImplementation((sql: string) =>
      String(sql).includes('SELECT')
        ? Promise.resolve(protocolRow(null))
        : Promise.resolve({ rowCount: 0, rows: [] }),
    );

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
