// Practice Better connection config. OAuth2 client credentials (verified from
// swagger: POST /oauth2/token, scopes read/write) — NOT a static API key.
export interface PbConfig {
  clientId: string;
  clientSecret: string;
  baseUrl: string;
  tokenUrl: string;
}

/** True when PB credentials are present (gate calls on this in dev). */
export function isPbConfigured(): boolean {
  return !!(process.env.PB_CLIENT_ID && process.env.PB_CLIENT_SECRET);
}

/** Resolve config, or throw if PB isn't configured (beta not yet granted). */
export function pbConfig(): PbConfig {
  const clientId = process.env.PB_CLIENT_ID;
  const clientSecret = process.env.PB_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new Error('Practice Better not configured — set PB_CLIENT_ID and PB_CLIENT_SECRET');
  }
  const baseUrl = process.env.PB_API_BASE_URL ?? 'https://api.practicebetter.io';
  return {
    clientId,
    clientSecret,
    baseUrl,
    tokenUrl: process.env.PB_OAUTH_TOKEN_URL ?? `${baseUrl}/oauth2/token`,
  };
}
