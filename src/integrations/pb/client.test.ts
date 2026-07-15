import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { pbRequest, resetPbToken, resetPbRateLimit } from './client';

function res(body: string): Response {
  return {
    ok: true,
    status: 200,
    text: () => Promise.resolve(body),
    headers: { get: () => null },
  } as unknown as Response;
}

function fetchMock(): ReturnType<typeof vi.fn> {
  return vi.fn().mockImplementation((url: string) =>
    Promise.resolve(
      String(url).includes('oauth2/token')
        ? res(JSON.stringify({ access_token: 't', expires_in: 3600 }))
        : res('{"items":[]}'),
    ),
  );
}

beforeEach(() => {
  process.env.PB_CLIENT_ID = 'id';
  process.env.PB_CLIENT_SECRET = 'secret';
  resetPbToken();
  resetPbRateLimit();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('pbRequest rate limiting (5 req/s, burst 20 — PB-confirmed limits)', () => {
  it('lets a full burst through without throttling', async () => {
    vi.stubGlobal('fetch', fetchMock());
    const start = Date.now();
    await Promise.all(Array.from({ length: 20 }, () => pbRequest('/consultant/sessions')));
    expect(Date.now() - start).toBeLessThan(200);
  });

  it('throttles a call beyond burst capacity to the sustained rate', async () => {
    vi.stubGlobal('fetch', fetchMock());
    await Promise.all(Array.from({ length: 20 }, () => pbRequest('/consultant/sessions')));

    const start = Date.now();
    await pbRequest('/consultant/sessions');
    const elapsed = Date.now() - start;
    // One token refills every 1/5s = 200ms; allow slack either side.
    expect(elapsed).toBeGreaterThanOrEqual(150);
    expect(elapsed).toBeLessThan(1000);
  });
});
