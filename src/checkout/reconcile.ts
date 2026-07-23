import type { PoolClient } from 'pg';
import { pool } from '../db/pool';
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
const RECORDING_LEASE = `interval '15 minutes'`;
// Reusable predicate: a row is due if it's PENDING/FAILED and past its backoff,
// OR it's a RECORDING whose lease has expired.
const DUE_PREDICATE = `(
  (status IN ('PENDING', 'FAILED') AND next_attempt_at <= now())
  OR (status = 'RECORDING' AND updated_at < now() - ${RECORDING_LEASE})
)`;

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
 * Insert the durable reconciliation intent. MUST be called with the same db
 * client / transaction that marks the checkout CHARGED, so charge + intent
 * commit together. Idempotent on checkout_id (one row per checkout).
 */
export async function enqueueReconciliation(db: PoolClient, args: EnqueueArgs): Promise<void> {
  await db.query(
    `INSERT INTO payment_reconciliation
       (checkout_id, invoice_id, customer_id, amount_cents, currency, provider_txn_id, idempotency_key, status, next_attempt_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 'PENDING', now())
     ON CONFLICT (checkout_id) DO NOTHING`,
    [
      args.checkoutId,
      args.invoiceId,
      args.customerId,
      args.amountCents,
      args.currency,
      args.providerTxnId,
      `checkout:${args.checkoutId}:payment`,
    ],
  );
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
  await pool.query(
    `UPDATE payment_reconciliation SET status = 'NEEDS_REVIEW', last_error = $2 WHERE id = $1`,
    [id, reason],
  );
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
  // Atomic claim — guards against the inline attempt and the job racing, and
  // reclaims a RECORDING row whose lease has expired (crashed mid-record, M2).
  const claim = await pool.query(
    `UPDATE payment_reconciliation SET status = 'RECORDING'
      WHERE id = $1 AND ${DUE_PREDICATE}`,
    [row.id],
  );
  if (claim.rowCount !== 1) return; // lost the race, or not due yet

  // Resolve a missing customer id from the mapping table (may have been added since enqueue).
  let customerId = row.customer_id;
  if (!customerId) {
    const c = await pool.query<{ client_id: string | null }>(
      `SELECT client_id FROM checkout WHERE id = $1`,
      [row.checkout_id],
    );
    customerId = await resolveQboCustomerId(c.rows[0]?.client_id);
    if (customerId) {
      await pool.query(`UPDATE payment_reconciliation SET customer_id = $2 WHERE id = $1`, [row.id, customerId]);
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
    await pool.query(
      `UPDATE payment_reconciliation SET status = 'RECORDED', accounting_payment_id = $2, last_error = NULL WHERE id = $1`,
      [row.id, res.paymentId ?? null],
    );
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
  await pool.query(
    `UPDATE payment_reconciliation SET status = 'FAILED', attempts = $2, last_error = $3, next_attempt_at = $4 WHERE id = $1`,
    [row.id, attempts, res.error ?? null, next],
  );
  logEvent('warn', 'checkout.reconcile', 'reconcile attempt failed; will retry', {
    reconciliation_id: row.id,
    attempts,
    next_attempt_at: next.toISOString(),
    error: res.error,
  });
}

/** Load and run the reconciliation for one checkout (used for the inline best-effort kick). */
export async function reconcileCheckout(checkoutId: string, deps: ReconcileDeps = {}): Promise<void> {
  const r = await pool.query<ReconRow>(
    `SELECT id, checkout_id, invoice_id, customer_id, amount_cents, currency, idempotency_key, attempts, provider_txn_id
       FROM payment_reconciliation WHERE checkout_id = $1`,
    [checkoutId],
  );
  if (r.rowCount === 1) await runReconciliation(r.rows[0], deps);
}

/** Background worker: process all due reconciliations. Guarded claim makes concurrent runs safe. */
export async function processDueReconciliations(limit = 25, deps: ReconcileDeps = {}): Promise<{ processed: number }> {
  const due = await pool.query<ReconRow>(
    `SELECT id, checkout_id, invoice_id, customer_id, amount_cents, currency, idempotency_key, attempts, provider_txn_id
       FROM payment_reconciliation
      WHERE ${DUE_PREDICATE}
      ORDER BY next_attempt_at ASC
      LIMIT $1`,
    [limit],
  );
  let processed = 0;
  for (const row of due.rows) {
    try {
      await runReconciliation(row, deps);
      processed++;
    } catch (err) {
      logError('checkout.reconcile', 'reconciliation run threw', err, { reconciliation_id: row.id });
    }
  }
  return { processed };
}
