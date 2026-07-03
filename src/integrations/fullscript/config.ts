// Fullscript connection config. Bulk refill orders are sent through Fullscript's
// API (OAuth/token-based); set once Fullscript's integration path is confirmed
// (Open Item — see build plan §13). Until then, sends run in dry-run mode.
export interface FullscriptConfig {
  apiToken: string;
  baseUrl: string;
}

export function isFullscriptConfigured(): boolean {
  return !!process.env.FULLSCRIPT_API_TOKEN;
}

export function fullscriptConfig(): FullscriptConfig {
  const apiToken = process.env.FULLSCRIPT_API_TOKEN;
  if (!apiToken) {
    throw new Error('Fullscript not configured — set FULLSCRIPT_API_TOKEN');
  }
  return {
    apiToken,
    baseUrl: process.env.FULLSCRIPT_API_BASE_URL ?? 'https://api.fullscript.com',
  };
}
