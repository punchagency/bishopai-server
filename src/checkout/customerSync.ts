import { pool } from '../db/pool';
import { logEvent } from '../observability/logger';
import { isQuickbooksConfigured } from '../integrations/quickbooks';
import { queryCustomers, type Customer } from '../integrations/quickbooks/customer';
import { setQboCustomerId } from './customerMap';

// Build the client → QBO Customer.Id mapping by matching our clients against the
// company's QuickBooks customers. A wrong mapping charges/reconciles the wrong
// person, so we only AUTO-apply an *unambiguous exact* match (email preferred,
// then exact display name). Ambiguous (>1 candidate) is never auto-applied — it
// is reported for a human to resolve via the manual override endpoint.

export function normalizeName(s: string | null | undefined): string {
  return (s ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
}
const normalizeEmail = (s: string | null | undefined): string => (s ?? '').trim().toLowerCase();

export interface MatchResult {
  via: 'email' | 'name' | 'none';
  customerId?: string;
  displayName?: string;
  ambiguous: boolean;
  candidateIds: string[];
}

/** Pure: match one client to the QBO customers. Email is the strong key; exact
 *  display name is the fallback. Returns ambiguous (no pick) when >1 match. */
export function matchCustomer(client: { name: string; email: string | null }, customers: Customer[]): MatchResult {
  const active = customers.filter((c) => c.active !== false);

  const email = normalizeEmail(client.email);
  if (email) {
    const hits = active.filter((c) => normalizeEmail(c.email) === email);
    if (hits.length === 1) return { via: 'email', customerId: hits[0].id, displayName: hits[0].displayName, ambiguous: false, candidateIds: [hits[0].id] };
    if (hits.length > 1) return { via: 'email', ambiguous: true, candidateIds: hits.map((h) => h.id) };
  }

  const name = normalizeName(client.name);
  if (name) {
    const hits = active.filter((c) => normalizeName(c.displayName) === name);
    if (hits.length === 1) return { via: 'name', customerId: hits[0].id, displayName: hits[0].displayName, ambiguous: false, candidateIds: [hits[0].id] };
    if (hits.length > 1) return { via: 'name', ambiguous: true, candidateIds: hits.map((h) => h.id) };
  }

  return { via: 'none', ambiguous: false, candidateIds: [] };
}

export interface SyncReport {
  ok: boolean;
  error?: string;
  customersScanned: number;
  clientsScanned: number;
  alreadyMapped: number;
  mapped: { clientId: string; clientName: string; qboCustomerId: string; via: 'email' | 'name' }[];
  ambiguous: { clientId: string; clientName: string; via: 'email' | 'name'; candidateIds: string[] }[];
  unmatched: { clientId: string; clientName: string }[];
}

/** Test seam: swap the QBO customer fetch. */
export interface SyncDeps {
  fetchCustomers?: () => Promise<Customer[]>;
}

const emptyCounts = { customersScanned: 0, clientsScanned: 0, alreadyMapped: 0, mapped: [], ambiguous: [], unmatched: [] };

/**
 * Pull QBO customers and auto-map every currently-unmapped client that has an
 * unambiguous exact match. Never overwrites an existing mapping (manual or
 * prior). Returns a report of what was mapped, what was ambiguous, and what had
 * no match — the latter two for human resolution.
 */
export async function syncCustomerMappings(deps: SyncDeps = {}): Promise<SyncReport> {
  if (!isQuickbooksConfigured()) return { ok: false, error: 'QuickBooks not configured', ...emptyCounts };

  const customers = await (deps.fetchCustomers ?? queryCustomers)();
  const alreadyMapped = Number(
    (await pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM client_qbo_map`)).rows[0].n,
  );

  // Only clients without an existing mapping — never clobber a manual/prior map.
  const clients = (
    await pool.query<{ id: string; name: string; email: string | null }>(
      `SELECT c.id, c.name, c.email FROM clients c
        WHERE NOT EXISTS (SELECT 1 FROM client_qbo_map m WHERE m.client_id = c.id)
        ORDER BY c.name`,
    )
  ).rows;

  const report: SyncReport = {
    ok: true,
    customersScanned: customers.length,
    clientsScanned: clients.length,
    alreadyMapped,
    mapped: [],
    ambiguous: [],
    unmatched: [],
  };

  for (const client of clients) {
    const m = matchCustomer(client, customers);
    if (m.customerId && !m.ambiguous) {
      await setQboCustomerId(client.id, m.customerId);
      report.mapped.push({ clientId: client.id, clientName: client.name, qboCustomerId: m.customerId, via: m.via as 'email' | 'name' });
    } else if (m.ambiguous) {
      report.ambiguous.push({ clientId: client.id, clientName: client.name, via: m.via as 'email' | 'name', candidateIds: m.candidateIds });
    } else {
      report.unmatched.push({ clientId: client.id, clientName: client.name });
    }
  }

  logEvent('info', 'checkout.customer_sync', 'customer mapping sync', {
    customers: customers.length,
    mapped: report.mapped.length,
    ambiguous: report.ambiguous.length,
    unmatched: report.unmatched.length,
  });
  return report;
}
