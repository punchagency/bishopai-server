import { fetchJson, type HttpOptions } from '../http';
import { pbConfig } from './config';

// OAuth2 client-credentials token client for Practice Better. Caches the bearer
// token until shortly before expiry, then re-mints. `pbRequest` attaches it and
// calls PB over the shared fetch helper.
//
// NOTE: the exact token-request encoding is confirmed once we have beta access.
// We send client credentials via HTTP Basic + a form body (the common
// client-credentials shape); adjust here if PB expects them elsewhere.
//
// Rate limit (confirmed with PB): 5 req/s sustained, burst 20, 10,000/day quota.
// Every caller (Schedule's live fetch, the sessions/protocols pollers, booking)
// shares one token bucket here so a coincidental pile-up across call sites can
// never itself trigger a 429 — `fetchJson` still retries on 429 as a backstop
// for the daily quota / anything outside our own throttling.
const RATE_PER_SEC = 5;
const BURST = 20;
let tokens = BURST;
let lastRefill = Date.now();

async function takeRateLimitToken(): Promise<void> {
  for (;;) {
    const now = Date.now();
    tokens = Math.min(BURST, tokens + ((now - lastRefill) / 1000) * RATE_PER_SEC);
    lastRefill = now;
    if (tokens >= 1) {
      tokens -= 1;
      return;
    }
    const waitMs = ((1 - tokens) / RATE_PER_SEC) * 1000;
    await new Promise((r) => setTimeout(r, waitMs));
  }
}

interface TokenResponse {
  access_token: string;
  token_type?: string;
  expires_in?: number; // seconds
  scope?: string;
}

let cached: { token: string; expiresAt: number } | null = null;

async function getAccessToken(): Promise<string> {
  if (cached && cached.expiresAt > Date.now() + 30_000) return cached.token;

  const { clientId, clientSecret, tokenUrl } = pbConfig();
  const res = await fetchJson<TokenResponse>(tokenUrl, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      accept: 'application/json',
    },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: clientId,
      client_secret: clientSecret,
      scope: 'read write',
    }).toString(),
  });

  const ttlMs = (res.expires_in ?? 3600) * 1000;
  cached = { token: res.access_token, expiresAt: Date.now() + ttlMs };
  return res.access_token;
}

/** Authenticated PB request. `path` is relative to the API base URL. */
export async function pbRequest<T>(path: string, init: HttpOptions = {}): Promise<T> {
  const { baseUrl } = pbConfig();
  const token = await getAccessToken();
  await takeRateLimitToken();
  return fetchJson<T>(new URL(path, baseUrl).toString(), {
    ...init,
    headers: {
      authorization: `Bearer ${token}`,
      accept: 'application/json',
      ...init.headers,
    },
  });
}

/** Test seam: drop the cached token (e.g. after a 401). */
export function resetPbToken(): void {
  cached = null;
}

/** Test seam: refill the rate-limit bucket to full burst capacity. */
export function resetPbRateLimit(): void {
  tokens = BURST;
  lastRefill = Date.now();
}
