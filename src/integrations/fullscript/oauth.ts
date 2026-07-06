import { fetchJson } from '../http';
import { getState, setState } from '../../db/state';
import { fullscriptConfig } from './config';

// Fullscript OAuth2 access-token manager. Access tokens live ~2h; we mint them
// on demand from the long-lived refresh token (RFC 6749 refresh_token grant) and
// cache in-process until shortly before expiry. If Fullscript rotates the refresh
// token on use, the new one is persisted to integration_state so it survives
// restarts (env FULLSCRIPT_REFRESH_TOKEN is only the initial seed).

const REFRESH_TOKEN_KEY = 'fullscript.refresh_token';
const EXPIRY_SKEW_MS = 60_000; // refresh a minute early

// Fullscript nests the token under `oauth` (verified against the OpenAPI spec).
interface TokenResponse {
  oauth?: {
    access_token: string;
    refresh_token?: string;
    expires_in?: number; // seconds
    token_type?: string;
    scope?: string;
  };
}

let cached: { token: string; expiresAt: number } | null = null;

/** Test seam: swap the HTTP call. */
export interface OAuthDeps {
  post?: (url: string, form: URLSearchParams) => Promise<TokenResponse>;
}

async function defaultPost(url: string, form: URLSearchParams): Promise<TokenResponse> {
  return fetchJson<TokenResponse>(url, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body: form.toString(),
  });
}

/** Reset the in-process cache (tests). */
export function _resetFullscriptTokenCache(): void {
  cached = null;
}

/**
 * Return a valid Fullscript access token, refreshing if needed. Uses the stored
 * (possibly rotated) refresh token, falling back to the configured seed.
 */
export async function getFullscriptAccessToken(deps: OAuthDeps = {}): Promise<string> {
  if (cached && Date.now() < cached.expiresAt) return cached.token;

  const cfg = fullscriptConfig();
  const refreshToken = (await getState(REFRESH_TOKEN_KEY)) ?? cfg.refreshToken;

  const form = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: cfg.clientId,
    client_secret: cfg.clientSecret,
  });

  const post = deps.post ?? defaultPost;
  const oauth = (await post(cfg.tokenUrl, form)).oauth;
  if (!oauth?.access_token) throw new Error('Fullscript token refresh returned no access_token');

  // Persist a rotated refresh token so we don't lock ourselves out.
  if (oauth.refresh_token && oauth.refresh_token !== refreshToken) {
    await setState(REFRESH_TOKEN_KEY, oauth.refresh_token);
  }

  const ttlMs = (oauth.expires_in ?? 7200) * 1000;
  cached = { token: oauth.access_token, expiresAt: Date.now() + Math.max(0, ttlMs - EXPIRY_SKEW_MS) };
  return cached.token;
}
