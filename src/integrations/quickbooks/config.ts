// QuickBooks Payments connection config (WF2 charging). OAuth2 + a realm id once
// Nicole's QuickBooks is connected. Until then, charges run in dry-run mode — no
// money moves, but the whole checkout state machine is exercisable.
export interface QuickbooksConfig {
  accessToken: string;
  realmId: string;
  baseUrl: string;
}

export function isQuickbooksConfigured(): boolean {
  return !!(process.env.QB_ACCESS_TOKEN && process.env.QB_REALM_ID);
}

export function quickbooksConfig(): QuickbooksConfig {
  const accessToken = process.env.QB_ACCESS_TOKEN;
  const realmId = process.env.QB_REALM_ID;
  if (!accessToken || !realmId) {
    throw new Error('QuickBooks not configured — set QB_ACCESS_TOKEN and QB_REALM_ID');
  }
  return {
    accessToken,
    realmId,
    baseUrl: process.env.QB_API_BASE_URL ?? 'https://api.intuit.com/quickbooks/v4',
  };
}
