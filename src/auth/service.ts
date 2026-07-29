import crypto from 'node:crypto';

export interface AuthConfig {
  enabled: boolean;
  configured: boolean;
  passwordHash: string | null;
  tokenSecret: string | null;
}

const TOKEN_TTL_MS = Number(process.env.AUTH_TOKEN_TTL_MS ?? 30 * 24 * 60 * 60 * 1000); // 30d

let authStore: AuthConfig = {
  enabled: false,
  configured: false,
  passwordHash: null,
  tokenSecret: null,
};

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
export async function getAuthConfig(_force = false): Promise<AuthConfig> {
  return { ...authStore };
}

export interface AuthUpdate {
  enabled?: boolean;
  password?: string;
}

export async function updateAuthConfig(update: AuthUpdate): Promise<AuthConfig> {
  const current = await getAuthConfig(true);
  const nextHash = update.password ? hashPassword(update.password) : current.passwordHash;
  const nextEnabled = update.enabled ?? current.enabled;

  if (nextEnabled && !nextHash) {
    throw new Error('set a password before enabling login');
  }
  const nextSecret = current.tokenSecret ?? crypto.randomBytes(32).toString('hex');

  authStore = {
    enabled: nextEnabled,
    configured: !!nextHash,
    passwordHash: nextHash,
    tokenSecret: nextSecret,
  };

  return { ...authStore };
}

export async function login(password: string): Promise<string | null> {
  const cfg = await getAuthConfig(true);
  if (!verifyPassword(password, cfg.passwordHash) || !cfg.tokenSecret) return null;
  return issueToken(cfg.tokenSecret);
}
