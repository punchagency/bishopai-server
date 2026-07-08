// Outlook (Microsoft Graph) connection config for WF3 re-engagement emails.
//
// Two ways to be "configured", checked in this order at send/read time:
//
//   1. OAuth (the real path). Nicole clicks "Connect Outlook" once in Settings,
//      consents to "send mail as you" on Microsoft's screen, and the backend
//      stores the resulting refresh token (server-side, in integration_state —
//      never exposed to the Electron client) and silently mints ~1h Graph access
//      tokens from it forever after. The app only needs MS_CLIENT_ID /
//      MS_CLIENT_SECRET / MS_TENANT_ID (the Entra app registration) set for the
//      connect flow to be OFFERED; the per-user token is captured at runtime,
//      never from env. See oauth.ts.
//
//   2. A static MS_GRAPH_TOKEN + MS_GRAPH_SENDER (legacy / manual / tests). A
//      pre-minted bearer token; goes stale in ~1h, so it's only for a quick
//      manual test, not production.
//
// With neither, sends run in dry-run (logged, not sent) so the whole cadence is
// exercisable offline and flips to real sends with no wiring change.

/** Delegated-OAuth app registration (Entra) — what we need to OFFER the connect flow. */
export interface OutlookAppConfig {
  clientId: string;
  clientSecret: string;
  tenantId: string;
  authority: string; // https://login.microsoftonline.com/{tenant}
  authorizeUrl: string;
  tokenUrl: string;
  redirectUri: string;
  scopes: string; // space-delimited
  graphBase: string;
}

// Delegated scopes: offline_access for a refresh token; Mail.Send to send as
// Nicole; Mail.Read for the inbox poller (replies + inbound inquiries);
// User.Read + openid/profile/email to resolve/confirm the sending address.
const DEFAULT_SCOPES = 'offline_access openid profile email User.Read Mail.Send Mail.Read';

/** True when the Entra app is registered — i.e. we can run the "Connect Outlook" flow. */
export function isOutlookAppConfigured(): boolean {
  return !!(process.env.MS_CLIENT_ID && process.env.MS_CLIENT_SECRET);
}

export function outlookAppConfig(): OutlookAppConfig {
  const clientId = process.env.MS_CLIENT_ID;
  const clientSecret = process.env.MS_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new Error('Outlook OAuth not configured — set MS_CLIENT_ID and MS_CLIENT_SECRET');
  }
  // `common` works for any personal/work account; a specific tenant id (or
  // `organizations`) locks it to Nicole's Microsoft 365 org.
  const tenantId = process.env.MS_TENANT_ID || 'common';
  const authority = process.env.MS_AUTHORITY || `https://login.microsoftonline.com/${tenantId}`;
  const redirectUri =
    process.env.OUTLOOK_REDIRECT_URI ||
    `${(process.env.PUBLIC_BASE_URL || '').replace(/\/$/, '')}/auth/outlook/callback`;
  return {
    clientId,
    clientSecret,
    tenantId,
    authority,
    authorizeUrl: `${authority}/oauth2/v2.0/authorize`,
    tokenUrl: `${authority}/oauth2/v2.0/token`,
    redirectUri,
    scopes: process.env.MS_GRAPH_SCOPES || DEFAULT_SCOPES,
    graphBase: graphBaseUrl(),
  };
}

/** Graph API base; shared by the static and OAuth paths. */
export function graphBaseUrl(): string {
  return process.env.MS_GRAPH_BASE_URL ?? 'https://graph.microsoft.com/v1.0';
}

// --- Legacy static token path -------------------------------------------------

export interface StaticOutlookConfig {
  token: string;
  sender: string; // the from/mailbox address
  baseUrl: string;
}

/** A pre-minted bearer token is set (manual/testing shortcut). */
export function isStaticOutlookConfigured(): boolean {
  return !!(process.env.MS_GRAPH_TOKEN && process.env.MS_GRAPH_SENDER);
}

export function staticOutlookConfig(): StaticOutlookConfig | null {
  const token = process.env.MS_GRAPH_TOKEN;
  const sender = process.env.MS_GRAPH_SENDER;
  if (!token || !sender) return null;
  return { token, sender, baseUrl: graphBaseUrl() };
}
