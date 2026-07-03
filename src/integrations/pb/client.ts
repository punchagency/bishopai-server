import { fetchJson, type HttpOptions } from '../http';
import { pbConfig } from './config';

// OAuth2 client-credentials token client for Practice Better. Caches the bearer
// token until shortly before expiry, then re-mints. `pbRequest` attaches it and
// calls PB over the shared fetch helper.
//
// NOTE: the exact token-request encoding is confirmed once we have beta access.
// We send client credentials via HTTP Basic + a form body (the common
// client-credentials shape); adjust here if PB expects them elsewhere.

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
  const basic = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
  const res = await fetchJson<TokenResponse>(tokenUrl, {
    method: 'POST',
    headers: {
      authorization: `Basic ${basic}`,
      'content-type': 'application/x-www-form-urlencoded',
      accept: 'application/json',
    },
    body: new URLSearchParams({ grant_type: 'client_credentials', scope: 'read write' }).toString(),
  });

  const ttlMs = (res.expires_in ?? 3600) * 1000;
  cached = { token: res.access_token, expiresAt: Date.now() + ttlMs };
  return res.access_token;
}

/** Authenticated PB request. `path` is relative to the API base URL. */
export async function pbRequest<T>(path: string, init: HttpOptions = {}): Promise<T> {
  const { baseUrl } = pbConfig();
  const token = await getAccessToken();
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
