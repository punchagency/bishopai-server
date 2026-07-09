import { logEvent, logError } from '../../observability/logger';
import { isPbConfigured } from './config';
import { listProtocols } from './reads';
import type { PbProtocol } from './types';

// Fullscript dispensary reconcile — the replacement for a Fullscript webhook.
//
// Fullscript exposes no API/webhooks to us; the only signal that a hand-off
// worked is on the PB protocol Nicole published: `fullscriptTreatmentPlan.
// externalId` means PB successfully auto-created the Fullscript plan, while
// `fullscriptTreatmentPlanCreationFailed` / `hasFailedDispensaryRecommendations`
// mean the push failed and needs her attention. Since there's no push
// notification, we poll protocols and surface the failures.

export type DispensaryStatus = 'created' | 'failed' | 'none';

/** Best-effort display name from a protocol's client record (flat name or profile). */
function clientRecordName(p: PbProtocol): string | undefined {
  const r = p.clientRecord;
  if (!r) return undefined;
  if (r.name) return r.name;
  const full = [r.profile?.firstName, r.profile?.lastName].filter(Boolean).join(' ').trim();
  return full || undefined;
}

/**
 * Classify a protocol's Fullscript push outcome. Pure — exported for tests.
 *   created — PB created the Fullscript plan (has an externalId, no failure flags)
 *   failed  — PB tried and failed (either failure flag set)
 *   none    — protocol carries no Fullscript linkage (not a dispensary protocol)
 */
export function dispensaryStatus(p: PbProtocol): DispensaryStatus {
  if (p.fullscriptTreatmentPlanCreationFailed || p.hasFailedDispensaryRecommendations) return 'failed';
  if (p.fullscriptTreatmentPlan?.externalId) return 'created';
  return 'none';
}

export interface DispensaryReconcileResult {
  scanned: number;
  created: number;
  failed: number;
  /** Protocols whose Fullscript push failed — for the digest / Nicole's review. */
  failures: Array<{ protocolId: string; protocolName?: string; clientName?: string }>;
}

export interface DispensaryReconcileOptions {
  /** PB client record ids to scope to (the `records[]` filter). Omit = all clients. */
  records?: string[];
  /** Page size (PB caps at 100). */
  limit?: number;
  /** Max pages to walk — bounds the global nightly sweep (there's no date filter). */
  maxPages?: number;
}

const DEFAULT_LIMIT = 100;
const DEFAULT_MAX_PAGES = 5;

/**
 * Poll non-archived protocols and report Fullscript push outcomes, logging each
 * failure so Nicole can re-publish. Pages forward via the `after_id` cursor,
 * bounded by `maxPages` (no date filter exists, so we cap the sweep); pass
 * `records` to scope to specific clients (cheap — used at hand-off time). No-op
 * (empty result) when PB isn't configured. Best-effort: a read failure is logged,
 * not thrown, so the scheduler tick stays green.
 */
export async function reconcileDispensaryPushes(
  opts: DispensaryReconcileOptions = {},
): Promise<DispensaryReconcileResult> {
  const result: DispensaryReconcileResult = { scanned: 0, created: 0, failed: 0, failures: [] };
  if (!isPbConfigured()) return result;

  const limit = opts.limit ?? DEFAULT_LIMIT;
  const maxPages = opts.maxPages ?? DEFAULT_MAX_PAGES;
  let afterId: string | undefined;

  for (let page = 0; page < maxPages; page++) {
    let batch: PbProtocol[];
    try {
      const res = await listProtocols({
        limit: String(limit),
        ...(afterId ? { after_id: afterId } : {}),
        ...(opts.records?.length ? { records: opts.records } : {}),
      });
      batch = res.items ?? [];
    } catch (err) {
      logError('pb.dispensary', 'protocol read failed; skipping reconcile', err, { page });
      break;
    }
    if (batch.length === 0) break;

    for (const p of batch) {
      if (p.isArchived) continue;
      const status = dispensaryStatus(p);
      if (status === 'none') continue;
      result.scanned++;
      if (status === 'created') {
        result.created++;
        continue;
      }
      result.failed++;
      const clientName = clientRecordName(p);
      result.failures.push({ protocolId: p.id, protocolName: p.name, clientName });
      logEvent('warn', 'pb.dispensary', 'Fullscript push failed for protocol — needs re-publish', {
        protocol_id: p.id,
        client: clientName,
      });
    }

    if (batch.length < limit) break; // last page
    afterId = batch[batch.length - 1].id; // cursor: ascending order → next page
  }

  logEvent('info', 'pb.dispensary', 'dispensary reconcile complete', {
    scanned: result.scanned,
    created: result.created,
    failed: result.failed,
  });
  return result;
}
