// QuickBooks connection config (WF2 — charge via Payments API, read invoice via
// Accounting API). Auth is OAuth2 authorization-code: run the one-time
// authorize→code→token exchange for Nicole's QuickBooks Online company, put the
// refresh_token in QB_REFRESH_TOKEN, and this backend mints ~1h access tokens
// from it (see oauth.ts). realmId (a.k.a. company id) comes off the same auth
// callback. Until the creds land, charges run in dry-run — no money moves, but
// the whole checkout state machine is exercisable.
//
// Base hosts are the canonical values from Intuit's "create basic requests" doc.
// NOTE two distinct hosts: Payments (api.intuit.com) and Accounting
// (quickbooks.api.intuit.com) — sandbox variants differ again. The OAuth token
// endpoint is a third host and is the SAME for sandbox and production.

export type QuickbooksEnv = 'production' | 'sandbox';

interface EnvHosts {
  paymentsBase: string; // Payments API host, e.g. https://api.intuit.com
  accountingBase: string; // Accounting API host, e.g. https://quickbooks.api.intuit.com
}

const HOSTS: Record<QuickbooksEnv, EnvHosts> = {
  production: {
    paymentsBase: 'https://api.intuit.com',
    accountingBase: 'https://quickbooks.api.intuit.com',
  },
  sandbox: {
    paymentsBase: 'https://sandbox.api.intuit.com',
    accountingBase: 'https://sandbox-quickbooks.api.intuit.com',
  },
};

const OAUTH_TOKEN_URL = 'https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer';

export interface QuickbooksConfig extends EnvHosts {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  realmId: string;
  tokenUrl: string;
  minorVersion: string;
}

function env(): QuickbooksEnv {
  return process.env.QB_ENV === 'production' ? 'production' : 'sandbox';
}

/** OAuth is fully configured when we can mint access tokens and address a company. */
export function isQuickbooksConfigured(): boolean {
  return !!(
    process.env.QB_CLIENT_ID &&
    process.env.QB_CLIENT_SECRET &&
    process.env.QB_REFRESH_TOKEN &&
    process.env.QB_REALM_ID
  );
}

export function quickbooksConfig(): QuickbooksConfig {
  const clientId = process.env.QB_CLIENT_ID;
  const clientSecret = process.env.QB_CLIENT_SECRET;
  const refreshToken = process.env.QB_REFRESH_TOKEN;
  const realmId = process.env.QB_REALM_ID;
  if (!clientId || !clientSecret || !refreshToken || !realmId) {
    throw new Error('QuickBooks not configured — set QB_CLIENT_ID / _SECRET / _REFRESH_TOKEN / _REALM_ID');
  }
  const hosts = HOSTS[env()];
  return {
    clientId,
    clientSecret,
    refreshToken,
    realmId,
    paymentsBase: process.env.QB_PAYMENTS_BASE_URL ?? hosts.paymentsBase,
    accountingBase: process.env.QB_ACCOUNTING_BASE_URL ?? hosts.accountingBase,
    tokenUrl: process.env.QB_OAUTH_TOKEN_URL ?? OAUTH_TOKEN_URL,
    minorVersion: process.env.QB_MINOR_VERSION ?? '75',
  };
}
