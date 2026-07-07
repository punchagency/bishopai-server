import { accountingGet } from './accounting';

// WF2 "pull invoice line items + total" — the Accounting API read half. The
// Accounting host + realmId-in-path differ from the Payments API; every request
// carries `?minorversion=` and Accept: application/json (QBO can default to XML).
//
// Response shape gotcha: Invoice.Line[] mixes real item rows with synthetic
// SubTotalLineDetail / DiscountLineDetail rows — summing them naïvely
// double-counts. We keep only SalesItemLineDetail rows for display and take the
// grand total from the read-only TotalAmt field.

export interface InvoiceLine {
  description?: string;
  amountCents: number;
  qty?: number;
  unitPriceCents?: number;
  itemName?: string;
}

export interface Invoice {
  id: string;
  docNumber?: string;
  totalCents: number;
  balanceCents: number;
  currency?: string;
  customerName?: string;
  customerId?: string;
  txnDate?: string;
  dueDate?: string;
  lines: InvoiceLine[];
}

// QBO amounts are decimals (e.g. 362.07). Cents via round to dodge float drift.
const toCents = (n?: number): number => Math.round((n ?? 0) * 100);

interface RawLine {
  Amount?: number;
  Description?: string;
  DetailType?: string;
  SalesItemLineDetail?: {
    Qty?: number;
    UnitPrice?: number;
    ItemRef?: { name?: string; value?: string };
  };
}

interface RawInvoice {
  Id: string;
  DocNumber?: string;
  TotalAmt?: number;
  Balance?: number;
  TxnDate?: string;
  DueDate?: string;
  CurrencyRef?: { value?: string };
  CustomerRef?: { name?: string; value?: string };
  Line?: RawLine[];
}

/** Pure: map a raw QBO Invoice to our normalized shape. Exported for tests. */
export function normalizeInvoice(inv: RawInvoice): Invoice {
  const lines = (inv.Line ?? [])
    .filter((l) => l.DetailType === 'SalesItemLineDetail')
    .map((l) => ({
      description: l.Description,
      amountCents: toCents(l.Amount),
      qty: l.SalesItemLineDetail?.Qty,
      unitPriceCents:
        l.SalesItemLineDetail?.UnitPrice != null ? toCents(l.SalesItemLineDetail.UnitPrice) : undefined,
      itemName: l.SalesItemLineDetail?.ItemRef?.name,
    }));
  return {
    id: inv.Id,
    docNumber: inv.DocNumber,
    totalCents: toCents(inv.TotalAmt),
    balanceCents: toCents(inv.Balance),
    currency: inv.CurrencyRef?.value,
    customerName: inv.CustomerRef?.name,
    customerId: inv.CustomerRef?.value,
    txnDate: inv.TxnDate,
    dueDate: inv.DueDate,
    lines,
  };
}

/** Read a single invoice by id. */
export async function readInvoice(invoiceId: string): Promise<Invoice> {
  const res = await accountingGet<{ Invoice: RawInvoice }>(`/invoice/${encodeURIComponent(invoiceId)}`);
  return normalizeInvoice(res.Invoice);
}

/**
 * Query invoices with a QBO SQL-like WHERE clause (without the leading "where").
 * e.g. queryInvoices(`CustomerRef = '24' order by TxnDate desc`).
 */
export async function queryInvoices(where: string): Promise<Invoice[]> {
  const q = encodeURIComponent(`select * from Invoice where ${where}`);
  const res = await accountingGet<{ QueryResponse: { Invoice?: RawInvoice[] } }>(`/query?query=${q}`);
  return (res.QueryResponse.Invoice ?? []).map(normalizeInvoice);
}
