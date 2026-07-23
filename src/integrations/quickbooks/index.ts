import { createHash } from 'node:crypto';
import { fetchJson, HttpError } from '../http';
import { logEvent } from '../../observability/logger';
import { isQuickbooksConfigured, quickbooksConfig } from './config';
import { getQuickbooksAccessToken } from './oauth';

export { isQuickbooksConfigured, quickbooksConfig } from './config';
export { getQuickbooksAccessToken, _resetQuickbooksTokenCache } from './oauth';
export * from './invoice';
export * from './payment';
export * from './customer';

// WF2 charging via QuickBooks Payments. Idempotency: the caller passes a stable
// idempotencyKey (`checkout:{id}:charge`) sent as QB's Request-Id header, so a
// retry/timeout/crash replays the SAME key and QB returns the original charge —
// never a second one. Dry-run gated like every other integration: no money moves
// until QB is configured, but the state machine + idempotency contract are fully
// exercised.
//
// Card source: a charge MUST carry a token, card, or cardOnFile (per Intuit
// docs). We take the PCI-preferred path — tokenize the card (one-time,
// single-use, 15-min) then charge with the token — and never send raw PAN to the
// charges endpoint. Callers should pass a pre-minted `token` (ideally tokenized
// client-side); passing raw `card` is supported but tokenizes it here first.

export interface CardDetails {
  number: string;
  expMonth: string;
  expYear: string;
  cvc: string;
  name?: string;
  address?: Record<string, string>;
}

export interface ChargeInput {
  amountCents: number;
  currency: string;
  idempotencyKey: string;
  /** Preferred: a one-time Payments token (from createToken / client-side tokenization). */
  token?: string;
  /** Fallback: raw card details, tokenized here before charging. */
  card?: CardDetails;
  invoiceId?: string;
}

export interface ChargeResult {
  ok: boolean;
  dryRun?: boolean;
  txnId?: string;
  /** QB charge status: AUTHORIZED | CAPTURED | DECLINED | ... */
  status?: string;
  error?: string;
  /**
   * The outcome is UNKNOWN, not a clean decline: the request threw on the network
   * or a 5xx, so the charge MAY have captured. Callers must NOT treat this as a
   * definite failure (that risks marking captured money as failed) — route it to
   * manual review instead. A clean decline (non-capturable status) or a
   * deterministic 4xx is `ambiguous: false`.
   */
  ambiguous?: boolean;
}

// A charge is money-good only in these states. A DECLINED charge comes back 200
// with an id, so we MUST inspect status rather than trust the HTTP code.
const CAPTURABLE = new Set(['CAPTURED', 'AUTHORIZED', 'SETTLED']);

// Intuit caps request-id at 50 characters and rejects anything longer with
// PMT-4000. Our natural key — `checkout:{uuid}:charge` — is 52, and the tokenize
// variant is 58, so BOTH would have failed every live charge. Fold anything over
// the limit into a hash, which must stay deterministic: replaying the same logical
// operation has to produce the same request-id, since that is the entire mechanism
// stopping a retry from charging twice.
const MAX_REQUEST_ID = 50;

export function toRequestId(key: string): string {
  if (key.length <= MAX_REQUEST_ID) return key;
  return createHash('sha256').update(key).digest('hex').slice(0, MAX_REQUEST_ID);
}

async function paymentsHeaders(requestId?: string): Promise<Record<string, string>> {
  const token = await getQuickbooksAccessToken();
  const h: Record<string, string> = {
    authorization: `Bearer ${token}`,
    'content-type': 'application/json',
    accept: 'application/json',
  };
  if (requestId) h['request-id'] = toRequestId(requestId);
  return h;
}

/** Create a one-time Payments token from raw card details (PCI-preferred charge path). */
export async function createToken(card: CardDetails, requestId: string): Promise<string> {
  const { paymentsBase } = quickbooksConfig();
  const res = await fetchJson<{ value?: string }>(`${paymentsBase}/quickbooks/v4/payments/tokens`, {
    method: 'POST',
    headers: await paymentsHeaders(requestId),
    body: JSON.stringify({ card }),
  });
  if (!res.value) throw new Error('QuickBooks token creation returned no value');
  return res.value;
}

export async function chargeCard(input: ChargeInput): Promise<ChargeResult> {
  if (!isQuickbooksConfigured()) {
    logEvent('info', 'quickbooks.charge', '[dry-run] would charge card', {
      amount_cents: input.amountCents,
      currency: input.currency,
      idempotency_key: input.idempotencyKey,
    });
    // Deterministic synthetic txn id keyed on the idempotency key, so a replay
    // yields the same id — mirroring QB's real idempotent behaviour.
    return { ok: true, dryRun: true, status: 'CAPTURED', txnId: `dry-run-txn-${input.idempotencyKey}` };
  }

  const { paymentsBase } = quickbooksConfig();
  try {
    // Resolve a token; never charge raw card at the charges endpoint.
    let token = input.token;
    if (!token && input.card) token = await createToken(input.card, `${input.idempotencyKey}:token`);
    if (!token) return { ok: false, error: 'no payment token or card supplied' };

    const res = await fetchJson<{ id: string; status?: string }>(
      `${paymentsBase}/quickbooks/v4/payments/charges`,
      {
        method: 'POST',
        headers: await paymentsHeaders(input.idempotencyKey),
        body: JSON.stringify({
          token,
          amount: (input.amountCents / 100).toFixed(2),
          currency: input.currency,
          context: { mobile: 'false', isEcommerce: 'true' },
        }),
      },
    );
    return interpretChargeResponse(res, input.amountCents);
  } catch (err) {
    // A deterministic 4xx (validation, auth) means the request was rejected
    // before any capture — a definite failure, safe to retry with a fresh key. A
    // 5xx / network / timeout is AMBIGUOUS: the charge may have captured before
    // the response was lost, so it must not be recorded as a clean failure.
    const definite4xx = err instanceof HttpError && err.status >= 400 && err.status < 500 && err.status !== 429;
    return { ok: false, error: err instanceof Error ? err.message : String(err), ambiguous: !definite4xx };
  }
}

/** Pure: turn a charge response into a result, honouring `status`. Exported for tests. */
export function interpretChargeResponse(
  res: { id: string; status?: string },
  amountCents?: number,
): ChargeResult {
  const status = res.status ?? 'UNKNOWN';
  if (!CAPTURABLE.has(status)) {
    logEvent('warn', 'quickbooks.charge', 'charge not captured', { txn_id: res.id, status });
    return { ok: false, txnId: res.id, status, error: `charge ${status.toLowerCase()}` };
  }
  logEvent('info', 'quickbooks.charge', 'charged card', { txn_id: res.id, status, amount_cents: amountCents });
  return { ok: true, txnId: res.id, status };
}
