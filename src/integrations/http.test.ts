import { describe, it, expect, vi, afterEach } from 'vitest';
import { fetchJson, HttpError } from './http';
import { isPbConfigured, pbConfig } from './pb/config';

function res(status: number, body: string, headers: Record<string, string> = {}): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: () => Promise.resolve(body),
    headers: { get: (k: string) => headers[k.toLowerCase()] ?? null },
  } as unknown as Response;
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

  it('retries 429 (rate limited) then succeeds', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(res(429, 'slow down'))
      .mockResolvedValueOnce(res(200, '{"ok":1}'));
    vi.stubGlobal('fetch', fetchMock);
    await expect(fetchJson('https://x/y', { retries: 2 })).resolves.toEqual({ ok: 1 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('honors Retry-After on 429 instead of guessing a backoff', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(res(429, 'slow down', { 'retry-after': '0' }))
      .mockResolvedValueOnce(res(200, '{"ok":1}'));
    vi.stubGlobal('fetch', fetchMock);
    const start = Date.now();
    await expect(fetchJson('https://x/y', { retries: 2 })).resolves.toEqual({ ok: 1 });
    // Retry-After: 0 should resolve near-instantly, not wait out the exp backoff floor.
    expect(Date.now() - start).toBeLessThan(500);
  });

  it('throws HttpError on 429 once retries are exhausted', async () => {
    const fetchMock = vi.fn().mockResolvedValue(res(429, 'slow down', { 'retry-after': '0' }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(fetchJson('https://x/y', { retries: 1 })).rejects.toBeInstanceOf(HttpError);
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
