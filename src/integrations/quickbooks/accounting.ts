import { fetchJson } from '../http';
import { quickbooksConfig } from './config';
import { getQuickbooksAccessToken } from './oauth';

// Shared GET against the QuickBooks Online Accounting API for the configured
// company: adds the realmId path segment, the required `minorversion`, an
// Accept: application/json header (QBO can default to XML), and bearer auth.
// One source of truth for invoice + customer reads.
export async function accountingGet<T>(path: string): Promise<T> {
  const cfg = quickbooksConfig();
  const token = await getQuickbooksAccessToken();
  const sep = path.includes('?') ? '&' : '?';
  const url = `${cfg.accountingBase}/v3/company/${cfg.realmId}${path}${sep}minorversion=${cfg.minorVersion}`;
  return fetchJson<T>(url, { headers: { authorization: `Bearer ${token}`, accept: 'application/json' } });
}
