import { fetchJson, HttpError } from '../http';
import { logEvent } from '../../observability/logger';
import { isQuickbooksConfigured, quickbooksConfig } from './config';
import { getQuickbooksAccessToken } from './oauth';

// WF2 reconciliation — record a Payment in QuickBooks Online Accounting against
// the invoice the card charge settled, so the invoice shows paid and the books
// balance. This is a SEPARATE system from the Payments charge; a charge alone
// leaves the invoice's Balance untouched.
//
// Idempotency here is the Accounting API's `requestid` QUERY PARAM (not the
// Payments `Request-Id` header) — a stable key means a retry replays the
// original Payment instead of creating a second one. Amounts are JSON numbers
// (unlike Payments' decimal strings).

export interface RecordPaymentInput {
  invoiceId: string;
  customerId: string;
  amountCents: number;
  currency: string;
  /** Stable per checkout (e.g. `checkout:{id}:payment`); used as the QBO requestid. */
  idempotencyKey: string;
}

export interface RecordPaymentResult {
  ok: boolean;
  dryRun?: boolean;
  paymentId?: string;
  error?: string;
  /** True for deterministic 4xx (validation) — do not retry; dead-letter instead. */
  permanent?: boolean;
}

interface PaymentBody {
  TotalAmt: number;
  CustomerRef: { value: string };
  Line: { Amount: number; LinkedTxn: { TxnId: string; TxnType: 'Invoice' }[] }[];
}

/** Pure: build the QBO Payment request body linking the amount to the invoice. Exported for tests. */
export function buildPaymentBody(input: RecordPaymentInput): PaymentBody {
  const amount = input.amountCents / 100;
  return {
    TotalAmt: amount,
    CustomerRef: { value: input.customerId },
    Line: [{ Amount: amount, LinkedTxn: [{ TxnId: input.invoiceId, TxnType: 'Invoice' }] }],
  };
}

export async function recordInvoicePayment(input: RecordPaymentInput): Promise<RecordPaymentResult> {
  if (!isQuickbooksConfigured()) {
    logEvent('info', 'quickbooks.payment', '[dry-run] would record invoice payment', {
      invoice_id: input.invoiceId,
      amount_cents: input.amountCents,
      idempotency_key: input.idempotencyKey,
    });
    // Deterministic synthetic id so a replay yields the same value.
    return { ok: true, dryRun: true, paymentId: `dry-run-pmt-${input.idempotencyKey}` };
  }

  const cfg = quickbooksConfig();
  try {
    const token = await getQuickbooksAccessToken();
    const url =
      `${cfg.accountingBase}/v3/company/${cfg.realmId}/payment` +
      `?requestid=${encodeURIComponent(input.idempotencyKey)}&minorversion=${cfg.minorVersion}`;
    const res = await fetchJson<{ Payment?: { Id?: string } }>(url, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        accept: 'application/json',
      },
      body: JSON.stringify(buildPaymentBody(input)),
    });
    const paymentId = res.Payment?.Id;
    if (!paymentId) return { ok: false, error: 'QuickBooks payment create returned no id' };
    logEvent('info', 'quickbooks.payment', 'recorded invoice payment', {
      payment_id: paymentId,
      invoice_id: input.invoiceId,
      amount_cents: input.amountCents,
    });
    return { ok: true, paymentId };
  } catch (err) {
    // 4xx (except 429) is deterministic — retrying won't help. 5xx / 429 / network are transient.
    const permanent = err instanceof HttpError && err.status >= 400 && err.status < 500 && err.status !== 429;
    return { ok: false, error: err instanceof Error ? err.message : String(err), permanent };
  }
}
