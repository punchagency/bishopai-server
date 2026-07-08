import crypto from 'node:crypto';
import { fetchJson } from '../http';
import { getState, setState, delState } from '../../db/state';
import { logEvent, logError } from '../../observability/logger';
import { graphBaseUrl, isStaticOutlookConfigured, outlookAppConfig, staticOutlookConfig } from './config';

// Microsoft Graph delegated-OAuth manager for WF3 — MULTI-mailbox. Two jobs:
//
//   • The CONNECT flow (authorization code + PKCE): buildAuthorizeUrl starts it,
//     exchangeCodeForTokens finishes it — appending (or updating) an account in
//     the stored list. Connecting a second mailbox does NOT overwrite the first.
//   • Ongoing SILENT token minting: per account, swap its stored refresh token
//     for a ~1h access token (RFC 6749 refresh_token grant), cached in-process
//     per sender until just before expiry. Microsoft ROTATES the refresh token on
//     refresh, so the newest value is persisted back — losing it forces reconnect.
//
// State: one JSON doc `outlook.accounts` = StoredAccount[]. Exactly one account
// is `primary` (WF3 sends from it); the inbox poller reads them all.

const ACCOUNTS_KEY = 'outlook.accounts';
// Pre-multi-account single-account keys — migrated on read, retired on write.
const LEGACY_REFRESH = 'outlook.refresh_token';
const LEGACY_SENDER = 'outlook.sender';
const LEGACY_CONNECTED_AT = 'outlook.connected_at';
// Each in-flight connect is stored under its OWN state value ({ verifier }) so a
// second (or attacker-initiated) /start can't clobber a legitimate pending
// attempt, and a code+state can't be replayed (consumed single-use on callback).
const PENDING_PREFIX = 'outlook.oauth.pending';
const pendingKey = (state: string) => `${PENDING_PREFIX}:${state}`;
const EXPIRY_SKEW_MS = 60_000; // refresh a minute early
const PENDING_TTL_MS = 15 * 60_000; // an auth attempt must complete within 15m

const norm = (s: string) => s.trim().toLowerCase();

interface TokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number; // seconds
  token_type?: string;
  scope?: string;
  error?: string;
  error_description?: string;
}

interface GraphMe {
  mail?: string;
  userPrincipalName?: string;
  displayName?: string;
}

interface StoredAccount {
  sender: string;
  refreshToken: string;
  connectedAt: string;
  primary: boolean;
}

/** Public view of a connected mailbox (no secrets). */
export interface OutlookAccount {
  sender: string;
  connectedAt: string | null;
  primary: boolean;
}

// Access-token cache, keyed by normalized sender.
const tokenCache = new Map<string, { token: string; expiresAt: number }>();

/** Test seam: swap the HTTP calls. */
export interface OutlookOAuthDeps {
  post?: (url: string, form: URLSearchParams) => Promise<TokenResponse>;
  getMe?: (accessToken: string, graphBase: string) => Promise<GraphMe>;
}

async function defaultPost(url: string, form: URLSearchParams): Promise<TokenResponse> {
  return fetchJson<TokenResponse>(url, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body: form.toString(),
  });
}

async function defaultGetMe(accessToken: string, graphBase: string): Promise<GraphMe> {
  return fetchJson<GraphMe>(`${graphBase}/me`, {
    headers: { authorization: `Bearer ${accessToken}`, accept: 'application/json' },
  });
}

/** Reset the in-process access-token cache (tests, and after (dis)connect). */
export function _resetOutlookTokenCache(): void {
  tokenCache.clear();
}

// --- Account store ------------------------------------------------------------

async function readAccounts(): Promise<StoredAccount[]> {
  const raw = await getState(ACCOUNTS_KEY).catch(() => null);
  if (raw) {
    try {
      const list = JSON.parse(raw) as StoredAccount[];
      if (Array.isArray(list)) return list.filter((a) => a && a.sender && a.refreshToken);
    } catch {
      /* corrupt doc — fall through to legacy/empty */
    }
  }
  // Legacy single-account migration (read-only here; writeAccounts persists the
  // new shape and clears the legacy keys next time we save).
  const [rt, sender, connectedAt] = await Promise.all([
    getState(LEGACY_REFRESH).catch(() => null),
    getState(LEGACY_SENDER).catch(() => null),
    getState(LEGACY_CONNECTED_AT).catch(() => null),
  ]);
  if (rt && sender) {
    return [{ sender, refreshToken: rt, connectedAt: connectedAt ?? new Date().toISOString(), primary: true }];
  }
  return [];
}

/** Ensure exactly one account is primary (the first, if none/many are flagged). */
function normalizePrimary(list: StoredAccount[]): void {
  if (list.length === 0) return;
  let seen = false;
  for (const a of list) {
    if (a.primary && !seen) seen = true;
    else a.primary = false;
  }
  if (!seen) list[0].primary = true;
}

async function writeAccounts(list: StoredAccount[]): Promise<void> {
  normalizePrimary(list);
  await setState(ACCOUNTS_KEY, JSON.stringify(list));
  // Retire the legacy single-account keys now that the list is the source of truth.
  await Promise.all([delState(LEGACY_REFRESH), delState(LEGACY_SENDER), delState(LEGACY_CONNECTED_AT)]);
}

// --- PKCE helpers -------------------------------------------------------------

function base64url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function makePkce(): { verifier: string; challenge: string } {
  const verifier = base64url(crypto.randomBytes(32));
  const challenge = base64url(crypto.createHash('sha256').update(verifier).digest());
  return { verifier, challenge };
}

// --- Connect flow -------------------------------------------------------------

/**
 * Begin a "Connect (another) mailbox" flow: mint a PKCE verifier + CSRF state,
 * stash them, and return the Microsoft authorize URL to open in the browser.
 * `prompt=select_account` lets the user pick which mailbox to add.
 */
export async function buildAuthorizeUrl(): Promise<string> {
  const cfg = outlookAppConfig();
  const state = base64url(crypto.randomBytes(16));
  const { verifier, challenge } = makePkce();
  await setState(pendingKey(state), JSON.stringify({ state, verifier, createdAt: Date.now() }));

  const params = new URLSearchParams({
    client_id: cfg.clientId,
    response_type: 'code',
    redirect_uri: cfg.redirectUri,
    response_mode: 'query',
    scope: cfg.scopes,
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    prompt: 'select_account',
  });
  return `${cfg.authorizeUrl}?${params.toString()}`;
}

/**
 * Complete a connect flow: validate the returned state, exchange the code (with
 * the PKCE verifier) for tokens, confirm the address via GET /me, then UPSERT it
 * into the account list (first account becomes primary; existing one is refreshed
 * in place). Returns the confirmed sender.
 */
export async function exchangeCodeForTokens(
  code: string,
  state: string,
  deps: OutlookOAuthDeps = {},
): Promise<{ sender: string }> {
  const cfg = outlookAppConfig();

  // Look up the pending attempt BY its state value; an unknown/forged state has
  // no entry. Consume it single-use up front so a captured code+state can't be
  // replayed even if the exchange below fails.
  const key = pendingKey(state);
  const pendingRaw = await getState(key);
  if (!pendingRaw) throw new Error('unknown or already-used Outlook authorization state (start the connect flow again)');
  await delState(key);
  const pending = JSON.parse(pendingRaw) as { state: string; verifier: string; createdAt: number };
  if (!pending.state || pending.state !== state) {
    throw new Error('Outlook authorization state mismatch');
  }
  if (Date.now() - (pending.createdAt ?? 0) > PENDING_TTL_MS) {
    throw new Error('Outlook authorization expired (start the connect flow again)');
  }

  const form = new URLSearchParams({
    grant_type: 'authorization_code',
    client_id: cfg.clientId,
    client_secret: cfg.clientSecret,
    code,
    redirect_uri: cfg.redirectUri,
    code_verifier: pending.verifier,
  });

  const post = deps.post ?? defaultPost;
  const tok = await post(cfg.tokenUrl, form);
  if (tok.error || !tok.access_token || !tok.refresh_token) {
    throw new Error(`Outlook code exchange failed: ${tok.error_description || tok.error || 'no tokens returned'}`);
  }

  // Confirm the address this mailbox sends from.
  const getMe = deps.getMe ?? defaultGetMe;
  const me = await getMe(tok.access_token, cfg.graphBase);
  const sender = (me.mail || me.userPrincipalName || '').trim();
  if (!sender) throw new Error('could not resolve the Outlook sending address from /me');

  // Upsert into the account list — never overwrite a different mailbox.
  const list = await readAccounts();
  const connectedAt = new Date().toISOString();
  const existing = list.find((a) => norm(a.sender) === norm(sender));
  if (existing) {
    existing.refreshToken = tok.refresh_token;
    existing.connectedAt = connectedAt;
  } else {
    list.push({ sender, refreshToken: tok.refresh_token, connectedAt, primary: list.length === 0 });
  }
  await writeAccounts(list);

  // Prime the cache with the freshly-issued access token.
  const ttlMs = (tok.expires_in ?? 3600) * 1000;
  tokenCache.set(norm(sender), { token: tok.access_token, expiresAt: Date.now() + Math.max(0, ttlMs - EXPIRY_SKEW_MS) });

  logEvent('info', 'outlook.oauth', 'Outlook mailbox connected', { sender, mailboxes: list.length });
  return { sender };
}

/**
 * Forget a mailbox (or all). Removing the primary promotes another to primary.
 * `sender` omitted → disconnect every mailbox.
 */
export async function disconnectOutlook(sender?: string): Promise<void> {
  if (!sender) {
    await delState(ACCOUNTS_KEY);
    await Promise.all([delState(LEGACY_REFRESH), delState(LEGACY_SENDER), delState(LEGACY_CONNECTED_AT)]);
    tokenCache.clear();
    logEvent('info', 'outlook.oauth', 'Outlook disconnected (all mailboxes)');
    return;
  }
  const list = await readAccounts();
  const next = list.filter((a) => norm(a.sender) !== norm(sender));
  tokenCache.delete(norm(sender));
  if (next.length === 0) {
    await delState(ACCOUNTS_KEY);
    await Promise.all([delState(LEGACY_REFRESH), delState(LEGACY_SENDER), delState(LEGACY_CONNECTED_AT)]);
  } else {
    await writeAccounts(next); // normalizePrimary promotes a new primary if needed
  }
  logEvent('info', 'outlook.oauth', 'Outlook mailbox disconnected', { sender, remaining: next.length });
}

/** Choose which connected mailbox WF3 sends re-engagement email from. */
export async function setPrimarySender(sender: string): Promise<void> {
  const list = await readAccounts();
  if (!list.some((a) => norm(a.sender) === norm(sender))) {
    throw new Error(`no connected Outlook mailbox for ${sender}`);
  }
  for (const a of list) a.primary = norm(a.sender) === norm(sender);
  await writeAccounts(list);
  logEvent('info', 'outlook.oauth', 'Outlook primary sender set', { sender });
}

// --- Silent token minting -----------------------------------------------------

/** Mint (or reuse a cached) access token for one account; persist rotation. */
async function mintForAccount(acct: StoredAccount, deps: OutlookOAuthDeps): Promise<string> {
  const key = norm(acct.sender);
  const c = tokenCache.get(key);
  if (c && Date.now() < c.expiresAt) return c.token;

  const cfg = outlookAppConfig();
  const form = new URLSearchParams({
    grant_type: 'refresh_token',
    client_id: cfg.clientId,
    client_secret: cfg.clientSecret,
    refresh_token: acct.refreshToken,
    scope: cfg.scopes,
  });
  const post = deps.post ?? defaultPost;
  const tok = await post(cfg.tokenUrl, form);
  if (tok.error || !tok.access_token) {
    // A dead refresh token (revoked, or >90d idle) means this mailbox must reconnect.
    throw new Error(`Outlook token refresh failed for ${acct.sender}: ${tok.error_description || tok.error || 'no access_token'}`);
  }
  if (tok.refresh_token && tok.refresh_token !== acct.refreshToken) {
    await persistRotatedToken(acct.sender, tok.refresh_token);
    acct.refreshToken = tok.refresh_token;
  }
  const ttlMs = (tok.expires_in ?? 3600) * 1000;
  const entry = { token: tok.access_token, expiresAt: Date.now() + Math.max(0, ttlMs - EXPIRY_SKEW_MS) };
  tokenCache.set(key, entry);
  return entry.token;
}

async function persistRotatedToken(sender: string, refreshToken: string): Promise<void> {
  const list = await readAccounts();
  const a = list.find((x) => norm(x.sender) === norm(sender));
  if (a) {
    a.refreshToken = refreshToken;
    await writeAccounts(list);
  }
}

/**
 * Return a valid Graph access token for a mailbox — `sender` names it, else the
 * primary. Throws if no matching account is connected.
 */
export async function getOutlookAccessToken(sender?: string, deps: OutlookOAuthDeps = {}): Promise<string> {
  const list = await readAccounts();
  const acct = sender ? list.find((a) => norm(a.sender) === norm(sender)) : list.find((a) => a.primary) ?? list[0];
  if (!acct) throw new Error('Outlook not connected — no mailbox stored');
  return mintForAccount(acct, deps);
}

// --- Connection state + access resolvers --------------------------------------

export interface OutlookConnection {
  available: boolean; // Entra app registered → the connect flow can be offered
  connected: boolean; // at least one mailbox can send right now
  sender: string | null; // the PRIMARY sender (kept for existing callers)
  primarySender: string | null;
  connectedAt: string | null; // the primary's connectedAt
  mode: 'oauth' | 'static' | 'none';
  accounts: OutlookAccount[];
}

/** Current connection status for the Settings UI. Never throws. */
export async function getOutlookConnection(): Promise<OutlookConnection> {
  const available = isStaticOutlookConfigured() || !!(process.env.MS_CLIENT_ID && process.env.MS_CLIENT_SECRET);

  const stat = staticOutlookConfig();
  if (stat) {
    const acct: OutlookAccount = { sender: stat.sender, connectedAt: null, primary: true };
    return {
      available,
      connected: true,
      sender: stat.sender,
      primarySender: stat.sender,
      connectedAt: null,
      mode: 'static',
      accounts: [acct],
    };
  }
  try {
    const list = await readAccounts();
    if (list.length > 0) {
      const primary = list.find((a) => a.primary) ?? list[0];
      const accounts: OutlookAccount[] = list.map((a) => ({
        sender: a.sender,
        connectedAt: a.connectedAt ?? null,
        primary: !!a.primary,
      }));
      return {
        available,
        connected: true,
        sender: primary.sender,
        primarySender: primary.sender,
        connectedAt: primary.connectedAt ?? null,
        mode: 'oauth',
        accounts,
      };
    }
  } catch {
    /* DB down — report not connected rather than throw */
  }
  return { available, connected: false, sender: null, primarySender: null, connectedAt: null, mode: 'none', accounts: [] };
}

export interface OutlookAccess {
  token: string;
  sender: string;
  graphBase: string;
}

/**
 * Resolve access for ONE mailbox — `sender` names it, else the primary — or null
 * when Outlook isn't configured (→ dry-run / no-op). Static env token wins.
 */
export async function resolveOutlookAccess(sender?: string, deps: OutlookOAuthDeps = {}): Promise<OutlookAccess | null> {
  const stat = staticOutlookConfig();
  if (stat) return { token: stat.token, sender: stat.sender, graphBase: stat.baseUrl };

  const list = await readAccounts().catch(() => [] as StoredAccount[]);
  if (list.length === 0) return null;
  const acct = sender ? list.find((a) => norm(a.sender) === norm(sender)) : list.find((a) => a.primary) ?? list[0];
  if (!acct) return null;
  const token = await mintForAccount(acct, deps);
  return { token, sender: acct.sender, graphBase: graphBaseUrl() };
}

/**
 * Resolve access for EVERY connected mailbox (the inbox poller reads them all).
 * A mailbox whose token refresh fails is skipped, not fatal.
 */
export async function resolveAllOutlookAccess(deps: OutlookOAuthDeps = {}): Promise<OutlookAccess[]> {
  const stat = staticOutlookConfig();
  if (stat) return [{ token: stat.token, sender: stat.sender, graphBase: stat.baseUrl }];

  const list = await readAccounts().catch(() => [] as StoredAccount[]);
  const out: OutlookAccess[] = [];
  for (const acct of list) {
    try {
      const token = await mintForAccount(acct, deps);
      out.push({ token, sender: acct.sender, graphBase: graphBaseUrl() });
    } catch (err) {
      logError('outlook.oauth', 'skipping mailbox — token refresh failed', err, { sender: acct.sender });
    }
  }
  return out;
}
