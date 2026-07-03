// Outlook (Microsoft Graph) connection config for WF3 re-engagement emails.
// Graph uses OAuth2; a sending token/credentials go here once Nicole's Microsoft
// account is connected. Until then, sends run in dry-run mode.
export interface OutlookConfig {
  token: string;
  sender: string; // the from/mailbox address
  baseUrl: string;
}

export function isOutlookConfigured(): boolean {
  return !!(process.env.MS_GRAPH_TOKEN && process.env.MS_GRAPH_SENDER);
}

export function outlookConfig(): OutlookConfig {
  const token = process.env.MS_GRAPH_TOKEN;
  const sender = process.env.MS_GRAPH_SENDER;
  if (!token || !sender) {
    throw new Error('Outlook not configured — set MS_GRAPH_TOKEN and MS_GRAPH_SENDER');
  }
  return {
    token,
    sender,
    baseUrl: process.env.MS_GRAPH_BASE_URL ?? 'https://graph.microsoft.com/v1.0',
  };
}
