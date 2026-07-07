import { fetchJson } from '../http';
import { getState, setState } from '../../db/state';
import { quickbooksConfig } from './config';

// Intuit OAuth2 access-token manager. Access tokens live 1h; we mint them on
// demand from the refresh token (RFC 6749 refresh_token grant) and cache
// in-process until shortly before expiry. Intuit ROTATES the refresh token on
// (most) refreshes and it has a rolling 100-day expiry, so the newest value is
// persisted to integration_state — env QB_REFRESH_TOKEN is only the initial
// seed. If a refresh ever fails because the token lapsed (>100d idle), the user
// must re-authorize the app (surface a "reconnect QuickBooks" state upstream).
//
// Two differences from the Fullscript manager: (1) client creds go in the HTTP
// Basic auth header, not the form body; (2) the token response is flat, not
// nested under `oauth`.

const REFRESH_TOKEN_KEY = 'quickbooks.refresh_token';
const EXPIRY_SKEW_MS = 60_000; // refresh a minute early

interface TokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number; // seconds
  token_type?: string;
  x_refresh_token_expires_in?: number;
}

let cached: { token: string; expiresAt: number } | null = null;

/** Test seam: swap the HTTP call. */
export interface OAuthDeps {
  post?: (url: string, form: URLSearchParams, authHeader: string) => Promise<TokenResponse>;
}

async function defaultPost(url: string, form: URLSearchParams, authHeader: string): Promise<TokenResponse> {
  return fetchJson<TokenResponse>(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      accept: 'application/json',
      authorization: authHeader,
    },
    body: form.toString(),
  });
}

/** Reset the in-process cache (tests). */
export function _resetQuickbooksTokenCache(): void {
  cached = null;
}

/**
 * Return a valid QuickBooks access token, refreshing if needed. Uses the stored
 * (possibly rotated) refresh token, falling back to the configured seed.
 */
export async function getQuickbooksAccessToken(deps: OAuthDeps = {}): Promise<string> {
  if (cached && Date.now() < cached.expiresAt) return cached.token;

  const cfg = quickbooksConfig();
  const refreshToken = (await getState(REFRESH_TOKEN_KEY)) ?? cfg.refreshToken;

  const form = new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refreshToken });
  const authHeader = 'Basic ' + Buffer.from(`${cfg.clientId}:${cfg.clientSecret}`).toString('base64');

  const post = deps.post ?? defaultPost;
  const tok = await post(cfg.tokenUrl, form, authHeader);
  if (!tok.access_token) throw new Error('QuickBooks token refresh returned no access_token');

  // Persist a rotated refresh token so we don't lock ourselves out.
  if (tok.refresh_token && tok.refresh_token !== refreshToken) {
    await setState(REFRESH_TOKEN_KEY, tok.refresh_token);
  }

  const ttlMs = (tok.expires_in ?? 3600) * 1000;
  cached = { token: tok.access_token, expiresAt: Date.now() + Math.max(0, ttlMs - EXPIRY_SKEW_MS) };
  return cached.token;
}
