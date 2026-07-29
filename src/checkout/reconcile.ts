import { getDatabase } from '../db/index.js';
import type { PaymentReconciliation } from '../db/interfaces/types.js';
import { logEvent, logError } from '../observability/logger';
import { isQuickbooksConfigured } from '../integrations/quickbooks';
import { recordInvoicePayment, type RecordPaymentResult } from '../integrations/quickbooks/payment';
import { resolveQboCustomerId } from './customerMap';

// Durable reconciliation of a captured charge → a QuickBooks invoice Payment.
// The intent row is committed atomically with the checkout going CHARGED (see
// machine.ts); this module drives it to completion — inline once, then via the
// scheduler — with idempotency, capped exponential backoff, and a dead-letter
// (NEEDS_REVIEW) state so a stuck payment is loud, never silently dropped.

const MAX_ATTEMPTS = 8;
const BASE_BACKOFF_MS = 60_000; // 1 min
const MAX_BACKOFF_MS = 6 * 60 * 60_000; // 6h
// A row claimed into RECORDING but not advanced within this window is presumed
// crashed mid-record (M2). Reclaiming it is safe: the QBO `requestid` makes the
// Payment write idempotent, so a reclaim of a genuinely in-flight row replays
// the same Payment rather than creating a second.
const RECORDING_LEASE_MS = 15 * 60_000;

/** A row is due if PENDING/FAILED past its backoff, or a RECORDING whose lease expired. */
function dueWindow(): { now: string; leaseCutoff: string } {
  const t = Date.now();
  return {
    now: new Date(t).toISOString(),
    leaseCutoff: new Date(t - RECORDING_LEASE_MS).toISOString(),
  };
}

/** Exponential backoff with jitter, capped. Persisted, so it survives restarts. */
export function backoffMs(attempts: number): number {
  const base = Math.min(BASE_BACKOFF_MS * 2 ** attempts, MAX_BACKOFF_MS);
  return base + Math.floor(Math.random() * 0.25 * base);
}

export interface ReconRow {
  id: string;
  checkout_id: string;
  invoice_id: string | null;
  customer_id: string | null;
  amount_cents: number;
  currency: string;
  idempotency_key: string;
  attempts: number;
  provider_txn_id: string | null;
}

export interface EnqueueArgs {
  checkoutId: string;
  invoiceId: string | null;
  customerId: string | null;
  amountCents: number;
  currency: string;
  providerTxnId: string | null;
}

/**
 * Build the durable reconciliation intent.
 *
 * It is NOT written here. The caller hands it to
 * `checkouts.markChargedWithReconciliation`, which commits it in the SAME
 * transaction that marks the checkout CHARGED — so a captured charge can never
 * exist without its intent, and an intent can never exist for a checkout that
 * never charged.
 *
 * The document id is the checkout id, which is what makes the write idempotent:
 * the pg table carried UNIQUE(checkout_id) for the same reason.
 */
export function buildReconciliation(args: EnqueueArgs): PaymentReconciliation {
  const now = new Date().toISOString();
  return {
    id: args.checkoutId,
    checkout_id: args.checkoutId,
    invoice_id: args.invoiceId,
    customer_id: args.customerId,
    amount_cents: args.amountCents,
    currency: args.currency,
    provider_txn_id: args.providerTxnId,
    status: 'PENDING',
    // Stable, and doubles as the QBO `requestid` that makes the Payment write
    // idempotent — so a reclaim replays the same Payment, never a second one.
    idempotency_key: `checkout:${args.checkoutId}:payment`,
    attempts: 0,
    next_attempt_at: now,
    created_at: now,
    updated_at: now,
  };
}

/** Test seam: swap the accounting write. */
export interface ReconcileDeps {
  record?: (input: {
    invoiceId: string;
    customerId: string;
    amountCents: number;
    currency: string;
    idempotencyKey: string;
  }) => Promise<RecordPaymentResult>;
}

async function deadLetter(id: string, reason: string): Promise<void> {
  const db = getDatabase();
  // The outbox document id IS the checkout id (buildReconciliation), which is what
  // makes one-row-per-checkout hold, so this lookup is exact rather than a scan.
  const existing = await db.checkouts.findReconciliationByCheckout(id);
  if (existing) {
    await db.checkouts.saveReconciliation({
      ...existing,
      status: 'NEEDS_REVIEW',
      last_error: reason,
      updated_at: new Date().toISOString(),
    });
  }
  logError('checkout.reconcile', 'reconciliation needs manual review', undefined, {
    reconciliation_id: id,
    reason,
  });
}

/**
 * Attempt one reconciliation. Claims the row (PENDING/FAILED → RECORDING, only
 * when due) so concurrent workers can't double-process, then records the QBO
 * Payment and advances the row. Never throws for expected outcomes.
 */
export async function runReconciliation(row: ReconRow, deps: ReconcileDeps = {}): Promise<void> {
  const db = getDatabase();
  // Atomic claim — guards against the inline attempt and the job racing, and
  // reclaims a RECORDING row whose lease has expired (crashed mid-record, M2).
  // The claim also bumps attempts, so it is the single place that counts a try.
  if (!(await db.checkouts.claimReconciliation(row.id))) return; // lost the race

  // Resolve a missing customer id from the mapping table (may have been added since enqueue).
  let customerId = row.customer_id;
  if (!customerId) {
    const checkout = await db.checkouts.findById(row.checkout_id);
    customerId = await resolveQboCustomerId(checkout?.client_id ?? null);
    if (customerId) {
      const current = await db.checkouts.findReconciliationByCheckout(row.checkout_id);
      if (current) {
        await db.checkouts.saveReconciliation({ ...current, customer_id: customerId });
      }
    }
  }

  const configured = isQuickbooksConfigured();
  const invoiceUsable = !!row.invoice_id && !row.invoice_id.startsWith('mock-');

  // In live mode we refuse to guess: a missing mapping or a placeholder invoice
  // is a human problem, so dead-letter rather than post a wrong Payment.
  if (configured && (!customerId || !invoiceUsable)) {
    await deadLetter(row.id, !customerId ? 'no QBO customer mapping for client' : 'no real QBO invoice id');
    return;
  }

  const record = deps.record ?? recordInvoicePayment;
  const res = await record({
    invoiceId: row.invoice_id ?? `mock-inv-${row.checkout_id.slice(0, 8)}`,
    customerId: customerId ?? 'dry-run-customer',
    amountCents: row.amount_cents,
    currency: row.currency,
    idempotencyKey: row.idempotency_key,
  });

  if (res.ok) {
    const current = await db.checkouts.findReconciliationByCheckout(row.checkout_id);
    if (current) {
      await db.checkouts.saveReconciliation({
        ...current,
        status: 'RECORDED',
        accounting_payment_id: res.paymentId ?? null,
        last_error: null,
        updated_at: new Date().toISOString(),
      });
    }
    logEvent('info', 'checkout.reconcile', 'invoice payment recorded', {
      reconciliation_id: row.id,
      checkout_id: row.checkout_id,
      payment_id: res.paymentId,
      dry_run: res.dryRun ?? false,
    });
    return;
  }

  if (res.permanent) {
    await deadLetter(row.id, res.error ?? 'permanent failure');
    return;
  }

  // Transient — back off and retry, or dead-letter once we've exhausted attempts.
  const attempts = row.attempts + 1;
  if (attempts >= MAX_ATTEMPTS) {
    await deadLetter(row.id, `gave up after ${attempts} attempts: ${res.error ?? 'unknown'}`);
    return;
  }
  const next = new Date(Date.now() + backoffMs(attempts));
  const current = await db.checkouts.findReconciliationByCheckout(row.checkout_id);
  if (current) {
    await db.checkouts.saveReconciliation({
      ...current,
      status: 'FAILED',
      attempts,
      last_error: res.error ?? null,
      next_attempt_at: next.toISOString(),
      updated_at: new Date().toISOString(),
    });
  }
  logEvent('warn', 'checkout.reconcile', 'reconcile attempt failed; will retry', {
    reconciliation_id: row.id,
    attempts,
    next_attempt_at: next.toISOString(),
    error: res.error,
  });
}

/** Load and run the reconciliation for one checkout (used for the inline best-effort kick). */
export async function reconcileCheckout(checkoutId: string, deps: ReconcileDeps = {}): Promise<void> {
  const row = await getDatabase().checkouts.findReconciliationByCheckout(checkoutId);
  if (row) await runReconciliation(toReconRow(row), deps);
}

/** The outbox document, narrowed to what a reconciliation attempt reads. */
function toReconRow(r: PaymentReconciliation): ReconRow {
  return {
    id: r.id,
    checkout_id: r.checkout_id,
    invoice_id: r.invoice_id ?? null,
    customer_id: r.customer_id ?? null,
    amount_cents: r.amount_cents,
    currency: r.currency,
    idempotency_key: r.idempotency_key,
    attempts: r.attempts,
    provider_txn_id: r.provider_txn_id ?? null,
  };
}

/** Background worker: process all due reconciliations. Guarded claim makes concurrent runs safe. */
export async function processDueReconciliations(limit = 25, deps: ReconcileDeps = {}): Promise<{ processed: number }> {
  const { now, leaseCutoff } = dueWindow();
  const due = (await getDatabase().checkouts.listDueReconciliations(now, leaseCutoff))
    .slice(0, limit)
    .map(toReconRow);
  let processed = 0;
  for (const row of due) {
    try {
      await runReconciliation(row, deps);
      processed++;
    } catch (err) {
      logError('checkout.reconcile', 'reconciliation run threw', err, { reconciliation_id: row.id });
    }
  }
  return { processed };
}
