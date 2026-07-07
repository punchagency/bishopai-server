import { accountingGet } from './accounting';

// QuickBooks Online Customer read — the source for building the client→QBO
// customer mapping. Paginated: QBO caps a query at ~1000 and defaults to 100 per
// page, so we page until a short batch.

export interface Customer {
  id: string;
  displayName: string;
  email?: string;
  givenName?: string;
  familyName?: string;
  active?: boolean;
}

interface RawCustomer {
  Id: string;
  DisplayName?: string;
  GivenName?: string;
  FamilyName?: string;
  Active?: boolean;
  PrimaryEmailAddr?: { Address?: string };
}

/** Pure: normalize a raw QBO Customer. Exported for tests. */
export function normalizeCustomer(c: RawCustomer): Customer {
  return {
    id: c.Id,
    displayName: c.DisplayName ?? [c.GivenName, c.FamilyName].filter(Boolean).join(' '),
    email: c.PrimaryEmailAddr?.Address,
    givenName: c.GivenName,
    familyName: c.FamilyName,
    active: c.Active,
  };
}

const PAGE_SIZE = 100;

/** Read all customers for the company (paginated). */
export async function queryCustomers(): Promise<Customer[]> {
  const out: Customer[] = [];
  for (let start = 1; ; start += PAGE_SIZE) {
    const q = encodeURIComponent(`select * from Customer startposition ${start} maxresults ${PAGE_SIZE}`);
    const res = await accountingGet<{ QueryResponse?: { Customer?: RawCustomer[] } }>(`/query?query=${q}`);
    const batch = res.QueryResponse?.Customer ?? [];
    out.push(...batch.map(normalizeCustomer));
    if (batch.length < PAGE_SIZE) break;
  }
  return out;
}
