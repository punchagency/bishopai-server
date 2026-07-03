import { describe, it, expect, vi, afterEach } from 'vitest';
import { fetchJson, HttpError } from './http';
import { isPbConfigured, pbConfig } from './pb/config';

function res(status: number, body: string): Response {
  return { ok: status >= 200 && status < 300, status, text: () => Promise.resolve(body) } as unknown as Response;
}

afterEach(() => vi.restoreAllMocks());

describe('fetchJson', () => {
  it('parses JSON on 2xx', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(res(200, '{"ok":true}')));
    await expect(fetchJson('https://x/y')).resolves.toEqual({ ok: true });
  });

  it('throws HttpError on 4xx without retrying', async () => {
    const fetchMock = vi.fn().mockResolvedValue(res(404, 'nope'));
    vi.stubGlobal('fetch', fetchMock);
    await expect(fetchJson('https://x/y', { retries: 2 })).rejects.toBeInstanceOf(HttpError);
    expect(fetchMock).toHaveBeenCalledTimes(1); // 4xx is not retried
  });

  it('retries 5xx then succeeds', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(res(503, 'busy'))
      .mockResolvedValueOnce(res(200, '{"ok":1}'));
    vi.stubGlobal('fetch', fetchMock);
    await expect(fetchJson('https://x/y', { retries: 2 })).resolves.toEqual({ ok: 1 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe('pb config gating', () => {
  it('isPbConfigured reflects env', () => {
    delete process.env.PB_CLIENT_ID;
    delete process.env.PB_CLIENT_SECRET;
    expect(isPbConfigured()).toBe(false);
    process.env.PB_CLIENT_ID = 'id';
    process.env.PB_CLIENT_SECRET = 'secret';
    expect(isPbConfigured()).toBe(true);
  });

  it('pbConfig throws when unset, resolves defaults when set', () => {
    delete process.env.PB_CLIENT_ID;
    delete process.env.PB_CLIENT_SECRET;
    expect(() => pbConfig()).toThrow(/not configured/);
    process.env.PB_CLIENT_ID = 'id';
    process.env.PB_CLIENT_SECRET = 'secret';
    const c = pbConfig();
    expect(c.baseUrl).toContain('practicebetter.io');
    expect(c.tokenUrl).toContain('/oauth2/token');
  });
});
