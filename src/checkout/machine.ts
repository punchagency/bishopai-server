import crypto from 'node:crypto';
import type { PoolClient } from 'pg';
import { pool } from '../db/pool';
import { logEvent, logError } from '../observability/logger';
import {
  chargeCard,
  isQuickbooksConfigured,
  queryInvoices,
  type CardDetails,
  type Invoice,
} from '../integrations/quickbooks';
import { publishApproved } from '../session/publish';
import { enqueueReconciliation, reconcileCheckout } from './reconcile';
import { resolveQboCustomerId } from './customerMap';
import { recordCheckoutOutcome } from './docWriteback';
import { recordAudit } from '../audit/log';

/** Cents → a short "$150.00" for human-readable audit summaries. */
function money(cents: number, currency = 'USD'): string {
  return `${currency} ${(cents / 100).toFixed(2)}`;
}

// WF2 checkout state machine (§6). The one money flow, so every transition is an
// atomic guarded UPDATE (never restarts a charge), the charge carries a stable
// idempotency key, and the approval is bound to the exact figure Nicole saw via
// a summary hash. Charges are dry-run until QuickBooks is configured — the state
// machine and all guarantees run identically either way.
//
//   DETECTED → SUMMARY_READY → AWAITING_APPROVAL → CHARGING → CHARGED
//            → DOCS_UPDATED → PB_MARKED → CLOSED    (CHARGING → CHARGE_FAILED)

const SESSION_FEE_CENTS = Number(process.env.CHECKOUT_SESSION_FEE_CENTS ?? 15000);
const SUPPLEMENT_CENTS = Number(process.env.CHECKOUT_SUPPLEMENT_CENTS ?? 2500);

export interface LineItem {
  label: string;
  amount_cents: number;
}
export interface CheckoutSummary {
  currency: string;
  qb_invoice_id: string;
  line_items: LineItem[];
  total_cents: number;
  fullscript_changes: string[];
}

/**
 * Bind an approval to the exact figure shown. Canonicalised over the fields that
 * matter (currency, total, line items) so it's stable regardless of JSONB key
 * ordering when the snapshot round-trips through Postgres.
 */
export function summaryHash(s: CheckoutSummary): string {
  const canon = `${s.currency}|${s.total_cents}|${s.line_items.map((l) => `${l.label}:${l.amount_cents}`).join(',')}`;
  return crypto.createHash('sha256').update(canon).digest('hex');
}

/** Choose the invoice a session's charge settles: the most recent UNPAID invoice
 *  for the customer (a session just rendered → newest open invoice). Returns null
 *  when NONE is unpaid — settling a charge against an already-paid invoice would
 *  overpay it and post a credit, so the caller falls through to the computed
 *  summary instead. Pure — exported for tests. */
export function pickTargetInvoice(invoices: Invoice[]): Invoice | null {
  if (invoices.length === 0) return null;
  const byRecent = [...invoices].sort((a, b) => (b.txnDate ?? '').localeCompare(a.txnDate ?? ''));
  return byRecent.find((i) => i.balanceCents > 0) ?? null;
}

/** Build the frozen summary from a real QBO invoice. Total comes from the
 *  authoritative TotalAmt (NOT summed lines); synthetic subtotal rows were already
 *  filtered by the invoice reader. Pure — exported for tests. */
export function summaryFromInvoice(inv: Invoice, fullscriptChanges: string[]): CheckoutSummary {
  return {
    currency: inv.currency ?? 'USD',
    qb_invoice_id: inv.id,
    line_items: inv.lines.map((l) => ({
      label: l.description ?? l.itemName ?? 'Item',
      amount_cents: l.amountCents,
    })),
    total_cents: inv.totalCents,
    fullscript_changes: fullscriptChanges,
  };
}

// QBO Customer.Ids are numeric strings; guard the value we splice into a QBO
// query to avoid any query-string breakage/injection.
const SAFE_CUSTOMER_ID = /^[A-Za-z0-9-]+$/;

/** Try to source the summary from the client's real QuickBooks invoice. Returns
 *  null (caller falls back to the computed summary) if QB isn't configured, the
 *  client has no QBO customer mapping, or no invoice can be read. */
async function trySummaryFromQbo(
  clientId: string | null,
  fullscriptChanges: string[],
): Promise<CheckoutSummary | null> {
  if (!isQuickbooksConfigured()) return null;
  const customerId = await resolveQboCustomerId(clientId);
  if (!customerId || !SAFE_CUSTOMER_ID.test(customerId)) return null;
  try {
    const invoices = await queryInvoices(`CustomerRef = '${customerId}'`);
    const target = pickTargetInvoice(invoices);
    if (!target) return null;
    logEvent('info', 'checkout.summary', 'sourced summary from QBO invoice', {
      invoice_id: target.id,
      total_cents: target.totalCents,
    });
    return summaryFromInvoice(target, fullscriptChanges);
  } catch (err) {
    logError('checkout.summary', 'QBO invoice read failed; falling back to computed summary', err, {
      customer_id: customerId,
    });
    return null;
  }
}

/**
 * Assemble the frozen summary Nicole approves (not a live re-pull at charge
 * time). Prefer the client's real QuickBooks invoice (line items + authoritative
 * total); fall back to a computed summary from the appointment's supplements when
 * QuickBooks isn't configured or no invoice is resolvable (offline demo / dry-run).
 */
export async function assembleSummary(appointmentId: string): Promise<CheckoutSummary | null> {
  const appt = await pool.query<{ client_id: string | null }>(
    `SELECT client_id FROM appointments WHERE id = $1`,
    [appointmentId],
  );
  if (appt.rowCount === 0) return null;
  const clientId = appt.rows[0].client_id;

  const supps = clientId
    ? (await pool.query<{ name: string }>(`SELECT name FROM supplements WHERE client_id = $1 ORDER BY name`, [clientId])).rows
    : [];
  // The client's current plan (supplements table), synced from the approved
  // Protocol in WF1. This is the authoritative source: Fullscript is reached only
  // through PB, and PB does not expose a plan's product contents (only its
  // externalId + failure flags) — so there is no live "what changed this session"
  // read to prefer over the local plan.
  const fullscript_changes = supps.map((s) => s.name);

  // Prefer the real QuickBooks invoice.
  const fromQbo = await trySummaryFromQbo(clientId, fullscript_changes);
  if (fromQbo) return fromQbo;

  // Fallback: computed summary (mock invoice id → reconciliation dead-letters in
  // live mode rather than posting a payment against a fabricated invoice).
  const line_items: LineItem[] = [
    { label: 'Consultation', amount_cents: SESSION_FEE_CENTS },
    ...supps.map((s) => ({ label: s.name, amount_cents: SUPPLEMENT_CENTS })),
  ];
  const total_cents = line_items.reduce((sum, l) => sum + l.amount_cents, 0);
  return {
    currency: 'USD',
    qb_invoice_id: `mock-inv-${appointmentId.slice(0, 8)}`,
    line_items,
    total_cents,
    fullscript_changes,
  };
}

/** Atomic guarded transition. Returns true only if the row was in `from`. */
async function transition(db: PoolClient | typeof pool, id: string, from: string, to: string): Promise<boolean> {
  const r = await db.query(`UPDATE checkout SET status = $3 WHERE id = $1 AND status = $2`, [id, from, to]);
  return r.rowCount === 1;
}

export interface DetectResult {
  checkoutId: string;
  status: string;
}

/**
 * DETECTED → AWAITING_APPROVAL. Idempotent on pb_appointment_id (unique), so a
 * re-detection (PB retry) returns the existing checkout untouched.
 */
export async function detectCheckout(appointmentId: string): Promise<DetectResult | null> {
  const appt = await pool.query<{ client_id: string | null; pb_id: string | null }>(
    `SELECT client_id, pb_id FROM appointments WHERE id = $1`,
    [appointmentId],
  );
  if (appt.rowCount === 0) return null;
  const { client_id, pb_id } = appt.rows[0];

  // Claim (or find) the checkout row. Keyed on appointment_id — the real unit,
  // and never null for a real appointment. (Keying on pb_appointment_id let an
  // appointment with a null pb_id spawn two checkouts → two charges: see M5.)
  const ins = await pool.query<{ id: string; status: string }>(
    `INSERT INTO checkout (appointment_id, client_id, pb_appointment_id, status)
          VALUES ($1, $2, $3, 'DETECTED')
     ON CONFLICT (appointment_id) WHERE appointment_id IS NOT NULL DO NOTHING
       RETURNING id, status`,
    [appointmentId, client_id, pb_id],
  );
  let checkoutId: string;
  if (ins.rowCount === 1) {
    checkoutId = ins.rows[0].id;
  } else {
    const existing = await pool.query<{ id: string; status: string }>(
      `SELECT id, status FROM checkout WHERE appointment_id = $1`,
      [appointmentId],
    );
    if (existing.rowCount === 0) return null;
    // Already past detection — return as-is (idempotent).
    return { checkoutId: existing.rows[0].id, status: existing.rows[0].status };
  }

  // Assemble the frozen snapshot and move to AWAITING_APPROVAL.
  const summary = await assembleSummary(appointmentId);
  if (summary) {
    await pool.query(
      `UPDATE checkout SET summary_snapshot = $2, qb_invoice_id = $3, status = 'AWAITING_APPROVAL'
        WHERE id = $1 AND status = 'DETECTED'`,
      [checkoutId, JSON.stringify(summary), summary.qb_invoice_id],
    );
  }
  logEvent('info', 'checkout.detect', 'checkout ready for approval', { checkout_id: checkoutId });
  await recordAudit({
    entityType: 'checkout',
    entityId: checkoutId,
    action: 'checkout.detected',
    summary: summary ? `Checkout ready for approval — ${money(summary.total_cents, summary.currency)}` : 'Checkout detected',
    metadata: { appointment_id: appointmentId, total_cents: summary?.total_cents },
  });
  return { checkoutId, status: 'AWAITING_APPROVAL' };
}

export interface ApproveResult {
  status: string;
  qbTxnId?: string;
  error?: string;
}

export interface ApproveOptions {
  approvedBy?: string;
  /**
   * Payment source for the charge (Option A — backend tokenizes). Provide a
   * one-time `token` (preferred, e.g. tokenized client-side) or raw `card`
   * details, which are tokenized here and never stored or logged. Optional in
   * dry-run; required once QuickBooks is live or the charge fails.
   */
  card?: CardDetails;
  token?: string;
}

/**
 * Nicole's Approve → the system half (charge → docs → PB mark). Writes the
 * approval (bound to the summary hash), claims the charge with a stable
 * idempotency key, then walks the automated states. Money state is never
 * coupled to the PB write: a PB-mark failure leaves the charge captured.
 */
export async function approveAndCharge(checkoutId: string, opts: ApproveOptions = {}): Promise<ApproveResult> {
  const approvedBy = opts.approvedBy ?? 'nicole';
  const row = await pool.query<{
    status: string;
    summary_snapshot: CheckoutSummary | null;
    appointment_id: string | null;
    client_id: string | null;
    charge_attempts: number;
  }>(
    `SELECT status, summary_snapshot, appointment_id, client_id, charge_attempts FROM checkout WHERE id = $1`,
    [checkoutId],
  );
  if (row.rowCount === 0) return { status: 'not_found' };
  const { status, summary_snapshot, appointment_id, client_id, charge_attempts } = row.rows[0];
  if (status !== 'AWAITING_APPROVAL') return { status, error: 'not awaiting approval' };
  if (!summary_snapshot) return { status, error: 'no summary to approve' };

  const hash = summaryHash(summary_snapshot);

  // Claim: AWAITING_APPROVAL → CHARGING (atomic). If we lose the race, stop.
  const db = await pool.connect();
  try {
    await db.query('BEGIN');
    if (!(await transition(db, checkoutId, 'AWAITING_APPROVAL', 'CHARGING'))) {
      await db.query('ROLLBACK');
      return { status: 'CHARGING', error: 'already in progress' };
    }
    await db.query(
      `INSERT INTO approvals (checkout_id, type, amount_cents, currency, summary_hash, status, approved_by, approved_at)
            VALUES ($1, 'checkout', $2, $3, $4, 'approved', $5, now())`,
      [checkoutId, summary_snapshot.total_cents, summary_snapshot.currency, hash, approvedBy],
    );
    await db.query('COMMIT');
  } catch (err) {
    await db.query('ROLLBACK');
    logError('checkout.approve', 'approval failed', err, { checkout_id: checkoutId });
    return { status, error: 'approval failed' };
  } finally {
    db.release();
  }
  await recordAudit({
    entityType: 'checkout',
    entityId: checkoutId,
    action: 'checkout.approved',
    actor: approvedBy === 'nicole' ? 'nicole' : 'system',
    summary: `Approved charge of ${money(summary_snapshot.total_cents, summary_snapshot.currency)}`,
    metadata: { total_cents: summary_snapshot.total_cents, currency: summary_snapshot.currency, approved_by: approvedBy },
  });

  // Charge (idempotent). The key is stable PER ATTEMPT: a retry within an attempt
  // (network replay, the stuck-charge sweeper) reuses it and QB replays the
  // original charge; a retry after a clean decline goes through resetFailedCharge,
  // which bumps charge_attempts, so it's a genuinely NEW key and a NEW charge.
  const idempotencyKey = `checkout:${checkoutId}:charge:${charge_attempts}`;
  await pool.query(`UPDATE checkout SET charge_idempotency_key = $2 WHERE id = $1 AND charge_idempotency_key IS NULL`, [
    checkoutId,
    idempotencyKey,
  ]);

  const charge = await chargeCard({
    amountCents: summary_snapshot.total_cents,
    currency: summary_snapshot.currency,
    idempotencyKey,
    invoiceId: summary_snapshot.qb_invoice_id,
    token: opts.token,
    card: opts.card, // tokenized inside chargeCard; never persisted/logged
  });

  if (!charge.ok) {
    // Ambiguous (network/5xx after possible capture) → CHARGE_REVIEW, never
    // CHARGE_FAILED: recording maybe-captured money as failed is how a charge
    // goes silent. Only a clean decline is a safe, retryable CHARGE_FAILED.
    const target = charge.ambiguous ? 'CHARGE_REVIEW' : 'CHARGE_FAILED';
    await transition(pool, checkoutId, 'CHARGING', target);
    await recordChargeOutcome(checkoutId, { ok: false, status: charge.status ?? target, error: charge.error });
    logEvent(charge.ambiguous ? 'error' : 'warn', 'checkout.charge', charge.ambiguous ? 'charge outcome unknown — needs manual review' : 'charge failed', {
      checkout_id: checkoutId,
      error: charge.error,
      ambiguous: charge.ambiguous ?? false,
    });
    await recordAudit({
      entityType: 'checkout',
      entityId: checkoutId,
      action: charge.ambiguous ? 'checkout.charge_review' : 'checkout.charge_failed',
      summary: charge.ambiguous
        ? `Charge outcome UNKNOWN — verify in QuickBooks (${money(summary_snapshot.total_cents, summary_snapshot.currency)})`
        : `Charge failed — ${charge.error ?? 'declined'}`,
      metadata: { error: charge.error, ambiguous: charge.ambiguous ?? false },
    });
    return { status: target, error: charge.error };
  }

  // Mark CHARGED and enqueue the reconciliation intent in ONE transaction, so a
  // captured charge can never exist without its durable "record this payment in
  // QuickBooks" outbox row. The customer id is resolved from the mapping table
  // (may be null now — the reconciler re-resolves and dead-letters if still
  // missing in live mode).
  const qboCustomerId = await resolveQboCustomerId(client_id);
  const cdb = await pool.connect();
  try {
    await cdb.query('BEGIN');
    const marked = await cdb.query(
      `UPDATE checkout SET qb_txn_id = $2, status = 'CHARGED' WHERE id = $1 AND status = 'CHARGING'`,
      [checkoutId, charge.txnId ?? null],
    );
    if (marked.rowCount !== 1) {
      // The row moved out from under us — the stuck-charge sweeper flagged it
      // CHARGE_REVIEW while this charge was (slowly) succeeding. Don't enqueue a
      // reconciliation against a row that isn't CHARGED; the CHARGE_REVIEW state
      // already routes it to a human, who now also has the captured txn id.
      await cdb.query('ROLLBACK');
      logError('checkout.charged', 'charge captured but checkout no longer CHARGING (swept?) — manual review', undefined, {
        checkout_id: checkoutId,
        txn_id: charge.txnId,
      });
      await recordChargeOutcome(checkoutId, { ok: true, status: charge.status ?? 'CAPTURED', txnId: charge.txnId });
      return { status: 'CHARGE_REVIEW', qbTxnId: charge.txnId, error: 'charge captured after state moved — verify in QuickBooks' };
    }
    await enqueueReconciliation(cdb, {
      checkoutId,
      invoiceId: summary_snapshot.qb_invoice_id,
      customerId: qboCustomerId,
      amountCents: summary_snapshot.total_cents,
      currency: summary_snapshot.currency,
      providerTxnId: charge.txnId ?? null,
    });
    await cdb.query('COMMIT');
  } catch (err) {
    await cdb.query('ROLLBACK');
    // The charge already captured; surface but don't lose it — the row will be
    // re-enqueued on a later approve replay is not possible (state moved), so log loudly.
    logError('checkout.charged', 'failed to persist CHARGED + reconciliation intent', err, { checkout_id: checkoutId });
    throw err;
  } finally {
    cdb.release();
  }

  // Stamp the successful charge outcome onto the approval audit row (M8), so the
  // audit carries both the authorization AND what the money did.
  await recordChargeOutcome(checkoutId, { ok: true, status: charge.status ?? 'CAPTURED', txnId: charge.txnId });
  await recordAudit({
    entityType: 'checkout',
    entityId: checkoutId,
    action: 'checkout.charge_captured',
    summary: `${charge.dryRun ? '[dry-run] ' : ''}Charged ${money(summary_snapshot.total_cents, summary_snapshot.currency)}`,
    metadata: { qb_txn_id: charge.txnId ?? null, dry_run: charge.dryRun ?? false, total_cents: summary_snapshot.total_cents },
  });

  // Best-effort inline reconciliation (invoice shows paid promptly in the happy
  // path). Failure is fine — the durable row + scheduler guarantee completion.
  await reconcileCheckout(checkoutId).catch((err) =>
    logError('checkout.reconcile', 'inline reconcile failed (will retry via job)', err, { checkout_id: checkoutId }),
  );

  // Record the checkout outcome onto the docs (billing block on the internal
  // sheet; refreshed supplements on the client protocol) BEFORE publishing, so
  // the Drive render includes them. Best-effort — money is already CHARGED.
  await recordCheckoutOutcome(appointment_id, {
    status: charge.dryRun ? 'dry-run' : 'paid',
    amountCents: summary_snapshot.total_cents,
    currency: summary_snapshot.currency,
    qbTxnId: charge.txnId ?? null,
    qbInvoiceId: summary_snapshot.qb_invoice_id,
  }).catch((err) => logError('checkout.docs', 'failed to record outcome on docs', err, { checkout_id: checkoutId }));

  // Docs update (Drive) — publishApproved is dry-run until Drive is configured.
  // Money state is already CHARGED; a Drive failure does not un-capture it.
  const apptRows = await pool.query<{ sheet_id: string | null; protocol_id: string | null }>(
    `SELECT
       (SELECT id FROM appointment_sheets WHERE appointment_id = $1 LIMIT 1) AS sheet_id,
       (SELECT id FROM protocols WHERE appointment_id = $1 LIMIT 1) AS protocol_id`,
    [appointment_id],
  );
  const { sheet_id, protocol_id } = apptRows.rows[0] ?? {};
  await Promise.allSettled([
    sheet_id ? publishApproved('appointment_sheets', sheet_id) : Promise.resolve(),
    protocol_id ? publishApproved('protocols', protocol_id) : Promise.resolve(),
  ]);
  await transition(pool, checkoutId, 'CHARGED', 'DOCS_UPDATED');

  // PB billing write-back — dry-run until PB REST API beta is confirmed (Open Item #2).
  await transition(pool, checkoutId, 'DOCS_UPDATED', 'PB_MARKED');
  logEvent('info', 'checkout.pb', '[dry-run] would mark billing complete via PB REST API', {
    checkout_id: checkoutId,
  });

  return { status: 'PB_MARKED', qbTxnId: charge.txnId };
}

/** Nicole's final Confirm: PB_MARKED → CLOSED. */
export async function closeCheckout(checkoutId: string): Promise<{ status: string }> {
  const ok = await transition(pool, checkoutId, 'PB_MARKED', 'CLOSED');
  if (ok) {
    logEvent('info', 'checkout.close', 'checkout closed', { checkout_id: checkoutId });
    await recordAudit({ entityType: 'checkout', entityId: checkoutId, action: 'checkout.closed', actor: 'nicole', summary: 'Checkout confirmed and closed' });
  }
  const r = await pool.query<{ status: string }>(`SELECT status FROM checkout WHERE id = $1`, [checkoutId]);
  return { status: r.rows[0]?.status ?? 'not_found' };
}

/**
 * Stamp a charge's outcome onto its most recent approval audit row (M8). The
 * approval records the AUTHORIZATION; this records what the money then did, so
 * the row carries both. Best-effort — never blocks or fails the money path.
 */
async function recordChargeOutcome(
  checkoutId: string,
  outcome: { ok: boolean; status: string; txnId?: string | null; error?: string | null },
): Promise<void> {
  await pool
    .query(
      `UPDATE approvals
          SET payload_json = payload_json || $2::jsonb
        WHERE id = (
          SELECT id FROM approvals
           WHERE checkout_id = $1 AND type = 'checkout'
        ORDER BY created_at DESC LIMIT 1
        )`,
      [
        checkoutId,
        JSON.stringify({
          charge_outcome: outcome.ok ? 'captured' : 'failed',
          charge_status: outcome.status,
          qb_txn_id: outcome.txnId ?? null,
          charge_error: outcome.error ?? null,
          charge_recorded_at: new Date().toISOString(),
        }),
      ],
    )
    .catch((err) => logError('checkout.audit', 'failed to stamp charge outcome on approval', err, { checkout_id: checkoutId }));
}

// A charge that stays CHARGING past this is presumed crashed mid-flight (a real
// charge resolves in seconds within one request). Well beyond any legitimate
// in-flight charge, so the sweeper can't race a slow-but-live one.
const STUCK_CHARGE_MS = 10 * 60_000;

/**
 * Recover charges stranded in CHARGING by a crash between capture and the
 * CHARGED+outbox commit (M1). We can't know whether money moved without the card
 * token (never persisted) or a provider lookup, so we make it LOUD, not silent:
 * move it to CHARGE_REVIEW for a human to verify in QuickBooks. Returns how many
 * were flagged. Idempotent; safe to run on a schedule.
 */
export async function sweepStuckCharges(olderThanMs = STUCK_CHARGE_MS): Promise<{ flagged: number }> {
  const cutoff = new Date(Date.now() - olderThanMs);
  const r = await pool.query<{ id: string }>(
    `UPDATE checkout SET status = 'CHARGE_REVIEW'
      WHERE status = 'CHARGING' AND updated_at < $1
    RETURNING id`,
    [cutoff],
  );
  for (const row of r.rows) {
    logError('checkout.stuck_charge', 'checkout stuck in CHARGING — flagged for manual review', undefined, {
      checkout_id: row.id,
    });
    await recordAudit({
      entityType: 'checkout',
      entityId: row.id,
      action: 'checkout.charge_review',
      summary: 'Charge stuck mid-flight — flagged for manual review (verify in QuickBooks)',
    });
  }
  return { flagged: r.rowCount ?? 0 };
}

/**
 * Reopen a cleanly-declined checkout so Nicole can retry with another card (M4).
 * Only CHARGE_FAILED (definitely no money moved) is reopened — never
 * CHARGE_REVIEW, where a re-charge could double-charge. Bumps charge_attempts
 * and clears the stored key, so the next approve mints a NEW idempotency key and
 * is a genuinely new charge rather than a replay of the decline.
 */
export async function resetFailedCharge(checkoutId: string): Promise<{ status: string }> {
  const r = await pool.query<{ status: string }>(
    `UPDATE checkout
        SET status = 'AWAITING_APPROVAL',
            charge_attempts = charge_attempts + 1,
            charge_idempotency_key = NULL,
            qb_txn_id = NULL
      WHERE id = $1 AND status = 'CHARGE_FAILED'
    RETURNING status`,
    [checkoutId],
  );
  if (r.rowCount === 1) {
    logEvent('info', 'checkout.retry', 'reopened a failed charge for retry', { checkout_id: checkoutId });
    await recordAudit({ entityType: 'checkout', entityId: checkoutId, action: 'checkout.retry_reopened', actor: 'nicole', summary: 'Reopened a declined charge to retry with another card' });
    return { status: 'AWAITING_APPROVAL' };
  }
  const cur = await pool.query<{ status: string }>(`SELECT status FROM checkout WHERE id = $1`, [checkoutId]);
  return { status: cur.rows[0]?.status ?? 'not_found' };
}
