// Fullscript connection config. Hosts/URLs are the canonical values from
// Fullscript's integration-environments.json (production = *.fullscript.com,
// sandbox = *.fullscript.io; api_base includes the `/api` prefix). Auth is OAuth2
// authorization-code flow: run the one-time authorize→code→token exchange for the
// practitioner account, put the refresh_token in FULLSCRIPT_REFRESH_TOKEN, and
// this backend mints ~2h access tokens from it.

export type FullscriptRegion = 'us' | 'ca';
export type FullscriptEnv = 'production' | 'sandbox';

interface EnvUrls {
  apiBase: string; // includes /api
  tokenUrl: string;
  authorizeUrl: string;
  revokeUrl: string;
}

const ENVIRONMENTS: Record<FullscriptRegion, Record<FullscriptEnv, EnvUrls>> = {
  us: {
    production: {
      apiBase: 'https://api-us.fullscript.com/api',
      tokenUrl: 'https://api-us.fullscript.com/api/oauth/token',
      authorizeUrl: 'https://api-us.fullscript.com/api/oauth/authorize',
      revokeUrl: 'https://api-us.fullscript.com/api/oauth/revoke',
    },
    sandbox: {
      apiBase: 'https://api-us-snd.fullscript.io/api',
      tokenUrl: 'https://api-us-snd.fullscript.io/api/oauth/token',
      authorizeUrl: 'https://api-us-snd.fullscript.io/api/oauth/authorize',
      revokeUrl: 'https://api-us-snd.fullscript.io/api/oauth/revoke',
    },
  },
  ca: {
    production: {
      apiBase: 'https://api-ca.fullscript.com/api',
      tokenUrl: 'https://api-ca.fullscript.com/api/oauth/token',
      authorizeUrl: 'https://api-ca.fullscript.com/api/oauth/authorize',
      revokeUrl: 'https://api-ca.fullscript.com/api/oauth/revoke',
    },
    sandbox: {
      apiBase: 'https://api-ca-snd.fullscript.io/api',
      tokenUrl: 'https://api-ca-snd.fullscript.io/api/oauth/token',
      authorizeUrl: 'https://api-ca-snd.fullscript.io/api/oauth/authorize',
      revokeUrl: 'https://api-ca-snd.fullscript.io/api/oauth/revoke',
    },
  },
};

export interface FullscriptConfig extends EnvUrls {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
}

function region(): FullscriptRegion {
  return process.env.FULLSCRIPT_REGION === 'ca' ? 'ca' : 'us';
}
function env(): FullscriptEnv {
  return process.env.FULLSCRIPT_ENV === 'production' ? 'production' : 'sandbox';
}

/** API base (incl. /api) for the configured region/env; override with FULLSCRIPT_API_BASE_URL. */
export function fullscriptApiBase(): string {
  return process.env.FULLSCRIPT_API_BASE_URL ?? ENVIRONMENTS[region()][env()].apiBase;
}

/** OAuth is fully configured when we can mint access tokens from a refresh token. */
export function isFullscriptConfigured(): boolean {
  return !!(
    process.env.FULLSCRIPT_CLIENT_ID &&
    process.env.FULLSCRIPT_CLIENT_SECRET &&
    process.env.FULLSCRIPT_REFRESH_TOKEN
  );
}

export function fullscriptConfig(): FullscriptConfig {
  const clientId = process.env.FULLSCRIPT_CLIENT_ID;
  const clientSecret = process.env.FULLSCRIPT_CLIENT_SECRET;
  const refreshToken = process.env.FULLSCRIPT_REFRESH_TOKEN;
  if (!clientId || !clientSecret || !refreshToken) {
    throw new Error('Fullscript not configured — set FULLSCRIPT_CLIENT_ID / _SECRET / _REFRESH_TOKEN');
  }
  const urls = ENVIRONMENTS[region()][env()];
  return {
    clientId,
    clientSecret,
    refreshToken,
    apiBase: fullscriptApiBase(),
    tokenUrl: process.env.FULLSCRIPT_OAUTH_TOKEN_URL ?? urls.tokenUrl,
    authorizeUrl: process.env.FULLSCRIPT_OAUTH_AUTHORIZE_URL ?? urls.authorizeUrl,
    revokeUrl: urls.revokeUrl,
  };
}
