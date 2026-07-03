import { fetchJson } from '../http';
import { logEvent } from '../../observability/logger';
import { fullscriptConfig, isFullscriptConfigured } from './config';

export { isFullscriptConfigured, fullscriptConfig } from './config';

// WF4 bulk send: forward approved refill orders to Fullscript in one action.
// Dry-run gated exactly like Drive (src/integrations/drive) — until
// FULLSCRIPT_API_TOKEN is set, sends log what they would do and return a
// synthetic order id, so the bulk-refill path is exercisable before the
// integration path is confirmed, and flips to real calls with no wiring change.

export interface RefillOrderLine {
  /** Our refill_orders row id — echoed back so the caller can update status. */
  orderId: string;
  clientName: string;
  supplementName: string;
}

export interface OrderSendResult {
  orderId: string;
  ok: boolean;
  fullscriptOrderId?: string;
  error?: string;
}

interface FullscriptOrderResponse {
  id: string;
}

/**
 * Send a batch of refill orders to Fullscript. Best-effort per line — one
 * failed order doesn't sink the batch; each line's outcome comes back so the
 * caller can persist per-order status. Dry-run when unconfigured.
 */
export async function sendBulkRefillOrders(lines: RefillOrderLine[]): Promise<OrderSendResult[]> {
  if (!isFullscriptConfigured()) {
    logEvent('info', 'fullscript.bulk', '[dry-run] would send refill orders to Fullscript', {
      count: lines.length,
      clients: [...new Set(lines.map((l) => l.clientName))].length,
    });
    return lines.map((l) => ({ orderId: l.orderId, ok: true, fullscriptOrderId: `dry-run-${l.orderId}` }));
  }

  const { apiToken, baseUrl } = fullscriptConfig();
  const results: OrderSendResult[] = [];
  for (const line of lines) {
    try {
      const res = await fetchJson<FullscriptOrderResponse>(new URL('/v1/orders', baseUrl).toString(), {
        method: 'POST',
        headers: {
          authorization: `Bearer ${apiToken}`,
          'content-type': 'application/json',
          accept: 'application/json',
        },
        body: JSON.stringify({ client_name: line.clientName, supplement: line.supplementName }),
      });
      results.push({ orderId: line.orderId, ok: true, fullscriptOrderId: res.id });
    } catch (err) {
      results.push({ orderId: line.orderId, ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  }
  logEvent('info', 'fullscript.bulk', 'sent refill orders to Fullscript', {
    count: lines.length,
    ok: results.filter((r) => r.ok).length,
  });
  return results;
}
