import { logEvent } from '../../observability/logger';
import { isFullscriptConfigured } from './config';
import { httpFullscriptClient, type FullscriptClient, type PlanRecommendation } from './client';
import { parseFullscriptDosage } from './dosage';

export { isFullscriptConfigured, fullscriptConfig, fullscriptApiBase } from './config';
export { getFullscriptAccessToken } from './oauth';
export { verifyFullscriptSignature, requireFullscriptSignature } from './webhooks';
export { httpFullscriptClient, type FullscriptClient } from './client';

// WF4 bulk send: turn approved refills into Fullscript treatment plans. Verified
// against the Fullscript Partner API OpenAPI (2026-07). Real flow per patient:
//   1. find-or-create the patient (by email),
//   2. map each supplement name → a catalog variant id,
//   3. create ONE draft treatment plan with those product recommendations.
// Plans are created as drafts (activation needs Fullscript commercial approval);
// the practitioner/patient completes purchase via the plan's invitation_url.
// Dry-run until OAuth is configured.

export interface RefillOrderLine {
  /** Our refill_orders row id — echoed back so the caller can update status. */
  orderId: string;
  clientName: string;
  /** Patient email — required to create/find the Fullscript patient. */
  clientEmail?: string | null;
  supplementName: string;
  /** Free-text dose ("2 caps twice daily") → structured Fullscript dosage. */
  dose?: string | null;
  /** Bottle size (units per bottle) → drives the dosage duration (days supply). */
  qty?: number | null;
}

export interface OrderSendResult {
  orderId: string;
  ok: boolean;
  fullscriptPlanId?: string;
  invitationUrl?: string;
  error?: string;
}

export interface BulkSendOptions {
  client?: FullscriptClient; // injectable for tests
  /** Our reference id stamped onto each plan's metadata (traceability). */
  batchId?: string;
}

/** Split a full name into first/last for Fullscript patient creation. */
function splitName(name: string): { firstName: string; lastName: string } {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return { firstName: 'Patient', lastName: 'Patient' };
  if (parts.length === 1) return { firstName: parts[0], lastName: parts[0] };
  return { firstName: parts[0], lastName: parts.slice(1).join(' ') };
}

/**
 * Create one draft treatment plan per unique patient (grouped by email) with a
 * recommendation for each supplement that maps to a catalog variant. Every line
 * for a patient shares the plan's outcome; lines with no email, or a supplement
 * with no catalog match, fail with a reason. Best-effort per patient — one
 * failure doesn't sink the batch. Dry-run when OAuth isn't configured.
 */
export async function sendBulkRefillOrders(
  lines: RefillOrderLine[],
  opts: BulkSendOptions = {},
): Promise<OrderSendResult[]> {
  if (!isFullscriptConfigured()) {
    logEvent('info', 'fullscript.bulk', '[dry-run] would create Fullscript treatment plans', {
      lines: lines.length,
      patients: [...new Set(lines.map((l) => (l.clientEmail ?? l.clientName).toLowerCase()))].length,
    });
    return lines.map((l) => ({ orderId: l.orderId, ok: true, fullscriptPlanId: `dry-run-${l.orderId}` }));
  }

  const client = opts.client ?? httpFullscriptClient();
  const results: OrderSendResult[] = [];

  // Group lines by patient email; lines without an email can't be placed.
  const byEmail = new Map<string, RefillOrderLine[]>();
  for (const line of lines) {
    const email = line.clientEmail?.trim();
    if (!email) {
      results.push({ orderId: line.orderId, ok: false, error: 'no client email on file' });
      continue;
    }
    const list = byEmail.get(email.toLowerCase()) ?? [];
    list.push(line);
    byEmail.set(email.toLowerCase(), list);
  }

  for (const [email, group] of byEmail) {
    try {
      const patientId =
        (await client.findPatientByEmail(email)) ??
        (await client.createPatient({ email, ...splitName(group[0].clientName) }));

      // Map each line's supplement to a catalog variant + structured dosage.
      const recs: PlanRecommendation[] = [];
      const placed: RefillOrderLine[] = [];
      for (const line of group) {
        const variantId = await client.findVariantId(line.supplementName);
        if (!variantId) {
          results.push({ orderId: line.orderId, ok: false, error: `no Fullscript product match for "${line.supplementName}"` });
          continue;
        }
        // One bottle per refill (units_to_purchase); dose/qty drive the dosage.
        recs.push({ variantId, unitsToPurchase: 1, dosage: parseFullscriptDosage(line.dose, line.qty) });
        placed.push(line);
      }
      if (recs.length === 0) continue; // every supplement unmatched — all already failed

      const { planId, invitationUrl } = await client.createTreatmentPlan(patientId, recs, {
        metadataId: opts.batchId,
      });
      logEvent('info', 'fullscript.bulk', 'created draft treatment plan', {
        patient: email,
        plan_id: planId,
        recommendations: recs.length,
      });
      for (const line of placed) {
        results.push({ orderId: line.orderId, ok: true, fullscriptPlanId: planId, invitationUrl });
      }
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      // Fail only the lines we hadn't already resolved for this patient.
      const done = new Set(results.filter((r) => group.some((l) => l.orderId === r.orderId)).map((r) => r.orderId));
      for (const line of group) if (!done.has(line.orderId)) results.push({ orderId: line.orderId, ok: false, error });
    }
  }

  logEvent('info', 'fullscript.bulk', 'fullscript bulk send complete', {
    lines: lines.length,
    ok: results.filter((r) => r.ok).length,
  });
  return results;
}
