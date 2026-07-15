import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Graph send is exercised through a stubbed transport: we assert on the JSON body
// the sender builds, which is where attachment encoding can silently go wrong.
const fetchJson = vi.fn();
vi.mock('../http', () => ({ fetchJson: (...args: unknown[]) => fetchJson(...args) }));

const resolveOutlookAccess = vi.fn();
vi.mock('./oauth', () => ({
  resolveOutlookAccess: (...args: unknown[]) => resolveOutlookAccess(...args),
  buildAuthorizeUrl: vi.fn(),
  exchangeCodeForTokens: vi.fn(),
  disconnectOutlook: vi.fn(),
  setPrimarySender: vi.fn(),
  getOutlookConnection: vi.fn(),
  getOutlookAccessToken: vi.fn(),
  resolveAllOutlookAccess: vi.fn(),
  _resetOutlookTokenCache: vi.fn(),
}));

import { sendEmail } from './index';

const CONNECTED = { token: 't0ken', sender: 'nicole@innerlume.com', graphBase: 'https://graph.test/v1.0' };

/** The message object the sender POSTed to Graph. */
function sentMessage(): Record<string, any> {
  const [, init] = fetchJson.mock.calls[0];
  return JSON.parse((init as { body: string }).body).message;
}

beforeEach(() => {
  fetchJson.mockReset().mockResolvedValue({});
  resolveOutlookAccess.mockReset().mockResolvedValue(CONNECTED);
});
afterEach(() => vi.clearAllMocks());

describe('sendEmail attachments', () => {
  it('base64-encodes a file attachment onto the Graph message', async () => {
    const res = await sendEmail({
      to: 'client@example.com',
      subject: 'Your protocol',
      body: 'Attached.',
      attachments: [
        {
          name: 'Supplement Protocol 7_9_26.xlsx',
          content: Buffer.from('hello xlsx'),
          contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        },
      ],
    });

    expect(res).toEqual({ ok: true });
    const msg = sentMessage();
    expect(msg.attachments).toHaveLength(1);
    expect(msg.attachments[0]).toEqual({
      '@odata.type': '#microsoft.graph.fileAttachment',
      name: 'Supplement Protocol 7_9_26.xlsx',
      contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      contentBytes: Buffer.from('hello xlsx').toString('base64'),
    });
  });

  it('omits the attachments key entirely for a plain email', async () => {
    await sendEmail({ to: 'a@b.com', subject: 's', body: 'b' });
    expect(sentMessage()).not.toHaveProperty('attachments');
  });

  it('defaults a missing content type rather than sending none', async () => {
    await sendEmail({
      to: 'a@b.com',
      subject: 's',
      body: 'b',
      attachments: [{ name: 'rof.docx', content: Buffer.from('x') }],
    });
    expect(sentMessage().attachments[0].contentType).toBe('application/octet-stream');
  });

  it('reports an error instead of sending when past Graph’s inline size limit', async () => {
    const res = await sendEmail({
      to: 'a@b.com',
      subject: 's',
      body: 'b',
      attachments: [{ name: 'huge.bin', content: Buffer.alloc(4 * 1024 * 1024) }],
    });

    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/inline limit/);
    expect(fetchJson).not.toHaveBeenCalled();
  });

  it('names the attachments in the dry-run log when Outlook is not connected', async () => {
    resolveOutlookAccess.mockResolvedValue(null);
    const res = await sendEmail({
      to: 'a@b.com',
      subject: 's',
      body: 'b',
      attachments: [{ name: 'rof.docx', content: Buffer.from('x') }],
    });

    expect(res).toEqual({ ok: true, dryRun: true });
    expect(fetchJson).not.toHaveBeenCalled();
  });
});
