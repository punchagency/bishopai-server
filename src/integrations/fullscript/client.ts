import { fetchJson } from '../http';
import { fullscriptApiBase } from './config';
import { getFullscriptAccessToken } from './oauth';
import type { FullscriptDosage } from './dosage';

// Thin typed client over the Fullscript Partner API (verified against the
// OpenAPI spec). Paths are relative to the api base (which already includes
// `/api`). Every call carries a fresh OAuth access token. Injectable so the
// bulk-send orchestration can be unit-tested without network.

export interface PlanRecommendation {
  variantId: string;
  unitsToPurchase?: number;
  dosage?: FullscriptDosage;
}
export interface CreatedPlan {
  planId: string;
  invitationUrl?: string;
}

export interface FullscriptClient {
  /** Patient id for this email, or null if none exists. */
  findPatientByEmail(email: string): Promise<string | null>;
  /** Create a patient; returns the new patient id. */
  createPatient(p: { email: string; firstName: string; lastName: string }): Promise<string>;
  /** Best catalog variant id for a supplement name, or null if no match. */
  findVariantId(supplementName: string): Promise<string | null>;
  /** Create a DRAFT treatment plan with product recommendations. */
  createTreatmentPlan(
    patientId: string,
    recommendations: PlanRecommendation[],
    opts?: { metadataId?: string; sendToPatient?: boolean },
  ): Promise<CreatedPlan>;
  /** Product names on treatment plans created at/after `sinceISO` (session-change read). */
  listRecentSupplements(patientId: string, sinceISO: string): Promise<string[]>;
}

interface SearchPatientsResponse {
  patients?: { id: string; email: string }[];
}
interface PatientResponse {
  patient?: { id: string };
  id?: string;
}
interface SearchProductsResponse {
  products?: { id: string; name: string; primary_variant?: { id: string } }[];
}
interface TreatmentPlanResponse {
  treatment_plan?: { id: string; invitation_url?: string };
}
interface TreatmentPlansListResponse {
  treatment_plans?: {
    id: string;
    created_at?: string;
    recommendations?: { name?: string; product?: { name?: string }; variant?: { product?: { name?: string } } }[];
  }[];
}

async function req<T>(
  method: string,
  path: string,
  opts: { token: string; query?: Record<string, string>; body?: unknown },
): Promise<T> {
  const url = new URL(`${fullscriptApiBase()}${path}`);
  for (const [k, v] of Object.entries(opts.query ?? {})) url.searchParams.set(k, v);
  return fetchJson<T>(url.toString(), {
    method,
    headers: {
      authorization: `Bearer ${opts.token}`,
      accept: 'application/json',
      ...(opts.body ? { 'content-type': 'application/json' } : {}),
    },
    ...(opts.body ? { body: JSON.stringify(opts.body) } : {}),
  });
}

export function httpFullscriptClient(): FullscriptClient {
  return {
    async findPatientByEmail(email) {
      const token = await getFullscriptAccessToken();
      const res = await req<SearchPatientsResponse>('GET', '/clinic/search/patients', {
        token,
        query: { query: email },
      });
      const match = (res.patients ?? []).find((p) => p.email?.toLowerCase() === email.toLowerCase());
      return match?.id ?? null;
    },

    async createPatient(p) {
      const token = await getFullscriptAccessToken();
      const res = await req<PatientResponse>('POST', '/clinic/patients', {
        token,
        body: { email: p.email, first_name: p.firstName, last_name: p.lastName },
      });
      const id = res.patient?.id ?? res.id;
      if (!id) throw new Error('Fullscript createPatient returned no id');
      return id;
    },

    async findVariantId(supplementName) {
      const token = await getFullscriptAccessToken();
      const res = await req<SearchProductsResponse>('GET', '/catalog/search/products', {
        token,
        query: { query: supplementName },
      });
      return res.products?.[0]?.primary_variant?.id ?? null;
    },

    async createTreatmentPlan(patientId, recommendations, opts = {}) {
      const token = await getFullscriptAccessToken();
      const res = await req<TreatmentPlanResponse>('POST', `/clinic/patients/${patientId}/treatment_plans`, {
        token,
        body: {
          // Request-body fields are strings per the spec; created as a draft
          // (activation requires Fullscript commercial approval).
          recommendations: recommendations.map((r) => ({
            variant_id: r.variantId,
            units_to_purchase: String(r.unitsToPurchase ?? 1),
            ...(r.dosage ? { dosage: r.dosage } : {}),
          })),
          ...(opts.metadataId ? { metadata: { id: opts.metadataId } } : {}),
          ...(opts.sendToPatient != null ? { send_to_patient: opts.sendToPatient } : {}),
        },
      });
      const planId = res.treatment_plan?.id;
      if (!planId) throw new Error('Fullscript createTreatmentPlan returned no id');
      return { planId, invitationUrl: res.treatment_plan?.invitation_url };
    },

    async listRecentSupplements(patientId, sinceISO) {
      const token = await getFullscriptAccessToken();
      const res = await req<TreatmentPlansListResponse>('GET', `/clinic/patients/${patientId}/treatment_plans`, { token });
      const since = new Date(sinceISO).getTime();
      const names = new Set<string>();
      for (const plan of res.treatment_plans ?? []) {
        const created = plan.created_at ? new Date(plan.created_at).getTime() : NaN;
        if (Number.isNaN(created) || created < since) continue;
        for (const rec of plan.recommendations ?? []) {
          const name = rec.product?.name ?? rec.variant?.product?.name ?? rec.name;
          if (name) names.add(name);
        }
      }
      return [...names];
    },
  };
}
