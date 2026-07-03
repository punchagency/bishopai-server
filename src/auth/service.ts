import crypto from 'node:crypto';
import { pool } from '../db/pool';

// Local single-user auth for Nicole's dashboard. Enforcement lives server-side
// (a client toggle alone wouldn't be security); the state is one `auth_config`
// row. No external dependency — password hashing is scrypt, session tokens are
// HMAC-signed with a per-install secret. Toggleable from the app Settings.

export interface AuthConfig {
  enabled: boolean;
  configured: boolean; // a password has been set
  passwordHash: string | null;
  tokenSecret: string | null;
}

const TOKEN_TTL_MS = Number(process.env.AUTH_TOKEN_TTL_MS ?? 30 * 24 * 60 * 60 * 1000); // 30d
const CACHE_TTL_MS = 3000; // avoid a DB round-trip on every guarded request
let cache: { at: number; cfg: AuthConfig } | null = null;

// --- password hashing (scrypt) ----------------------------------------------
export function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 32);
  return `${salt.toString('hex')}:${hash.toString('hex')}`;
}

export function verifyPassword(password: string, stored: string | null): boolean {
  if (!stored) return false;
  const [saltHex, hashHex] = stored.split(':');
  if (!saltHex || !hashHex) return false;
  const expected = Buffer.from(hashHex, 'hex');
  const actual = crypto.scryptSync(password, Buffer.from(saltHex, 'hex'), expected.length);
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

// --- session tokens (HMAC-signed, stateless) --------------------------------
// token = base64url({exp}) + '.' + hex(hmac-sha256(secret, base64url({exp})))
export function issueToken(secret: string, ttlMs: number = TOKEN_TTL_MS): string {
  const payload = Buffer.from(JSON.stringify({ exp: Date.now() + ttlMs })).toString('base64url');
  const sig = crypto.createHmac('sha256', secret).update(payload).digest('hex');
  return `${payload}.${sig}`;
}

export function verifyToken(token: string | undefined, secret: string | null): boolean {
  if (!token || !secret) return false;
  const [payload, sig] = token.split('.');
  if (!payload || !sig) return false;
  const expected = crypto.createHmac('sha256', secret).update(payload).digest('hex');
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return false;
  try {
    const { exp } = JSON.parse(Buffer.from(payload, 'base64url').toString());
    return typeof exp === 'number' && exp > Date.now();
  } catch {
    return false;
  }
}

// --- config load/save -------------------------------------------------------
export async function getAuthConfig(force = false): Promise<AuthConfig> {
  if (!force && cache && Date.now() - cache.at < CACHE_TTL_MS) return cache.cfg;
  const { rows } = await pool.query<{ enabled: boolean; password_hash: string | null; token_secret: string | null }>(
    `SELECT enabled, password_hash, token_secret FROM auth_config WHERE id = true`,
  );
  const row = rows[0] ?? { enabled: false, password_hash: null, token_secret: null };
  const cfg: AuthConfig = {
    enabled: row.enabled,
    configured: !!row.password_hash,
    passwordHash: row.password_hash,
    tokenSecret: row.token_secret,
  };
  cache = { at: Date.now(), cfg };
  return cfg;
}

export interface AuthUpdate {
  enabled?: boolean;
  password?: string;
}

/** Apply a settings change. Returns the new config. Throws on invalid state. */
export async function updateAuthConfig(update: AuthUpdate): Promise<AuthConfig> {
  const current = await getAuthConfig(true);
  const nextHash = update.password ? hashPassword(update.password) : current.passwordHash;
  const nextEnabled = update.enabled ?? current.enabled;

  // Can't require a login without a password to check against.
  if (nextEnabled && !nextHash) {
    throw new Error('set a password before enabling login');
  }
  // Mint a signing secret the first time we need one.
  const nextSecret = current.tokenSecret ?? crypto.randomBytes(32).toString('hex');

  await pool.query(
    `UPDATE auth_config SET enabled = $1, password_hash = $2, token_secret = $3 WHERE id = true`,
    [nextEnabled, nextHash, nextSecret],
  );
  cache = null; // bust
  return getAuthConfig(true);
}

/** Validate a password and mint a token, or null on failure. */
export async function login(password: string): Promise<string | null> {
  const cfg = await getAuthConfig(true);
  if (!verifyPassword(password, cfg.passwordHash) || !cfg.tokenSecret) return null;
  return issueToken(cfg.tokenSecret);
}
