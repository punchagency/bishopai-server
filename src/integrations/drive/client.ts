import { fetchJson, type HttpOptions } from '../http';
import { driveConfig } from './config';

// Google OAuth2: mint an access token from the stored refresh token, cache it
// until shortly before expiry. `driveRequest` attaches it. Same shape as the PB
// client — composed over the shared fetch helper, no shared base class.

interface TokenResponse {
  access_token: string;
  expires_in?: number;
}

let cached: { token: string; expiresAt: number } | null = null;

async function getAccessToken(): Promise<string> {
  if (cached && cached.expiresAt > Date.now() + 30_000) return cached.token;

  const { clientId, clientSecret, refreshToken, tokenUrl } = driveConfig();
  const res = await fetchJson<TokenResponse>(tokenUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
    }).toString(),
  });

  const ttlMs = (res.expires_in ?? 3600) * 1000;
  cached = { token: res.access_token, expiresAt: Date.now() + ttlMs };
  return res.access_token;
}

/** Authenticated Google API request. `url` is absolute (Drive uses two hosts). */
export async function driveRequest<T>(url: string, init: HttpOptions = {}): Promise<T> {
  const token = await getAccessToken();
  return fetchJson<T>(url, {
    ...init,
    headers: { authorization: `Bearer ${token}`, accept: 'application/json', ...init.headers },
  });
}

export function resetDriveToken(): void {
  cached = null;
}
