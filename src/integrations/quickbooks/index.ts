import { fetchJson } from '../http';
import { logEvent } from '../../observability/logger';
import { isQuickbooksConfigured, quickbooksConfig } from './config';

export { isQuickbooksConfigured, quickbooksConfig } from './config';

// WF2 charging via QuickBooks Payments. The critical guarantee is idempotency:
// the caller passes a stable idempotencyKey (`checkout:{id}:charge`) sent as QB's
// request-id, so a retry/timeout/crash replays the SAME key and QB returns the
// original charge — never a second one. Dry-run gated like every other
// integration: no money moves until QB is configured, but the state machine and
// the idempotency contract are fully exercised.

export interface ChargeInput {
  amountCents: number;
  currency: string;
  idempotencyKey: string;
  invoiceId?: string;
}

export interface ChargeResult {
  ok: boolean;
  dryRun?: boolean;
  txnId?: string;
  error?: string;
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
    return { ok: true, dryRun: true, txnId: `dry-run-txn-${input.idempotencyKey}` };
  }

  const { accessToken, realmId, baseUrl } = quickbooksConfig();
  try {
    const res = await fetchJson<{ id: string }>(`${baseUrl}/payments/charges`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${accessToken}`,
        'content-type': 'application/json',
        'request-id': input.idempotencyKey, // QB idempotency
        'company-id': realmId,
      },
      body: JSON.stringify({
        amount: (input.amountCents / 100).toFixed(2),
        currency: input.currency,
        context: { mobile: false, isEcommerce: true },
      }),
    });
    logEvent('info', 'quickbooks.charge', 'charged card', { txn_id: res.id, amount_cents: input.amountCents });
    return { ok: true, txnId: res.id };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
