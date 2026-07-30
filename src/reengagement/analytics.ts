import { getDatabase } from '../db/index.js';

// WF3 site-behavior ingest: land website analytics events (page views, form
// opens/submits, email opens) into `lead_activity`. Provider-agnostic — a
// PostHog/Hotjar webhook or a first-party pixel can POST here. Events with a
// known email attribute to that lead (and refresh its last_touch so the cadence
// sees engagement); anonymous events are still recorded (lead_id null) for
// funnel/heat-map analysis.

export const SITE_EVENT_TYPES = ['page_view', 'form_open', 'form_submit', 'email_open'] as const;
export type SiteEventType = (typeof SITE_EVENT_TYPES)[number];

export interface SiteEvent {
  email?: string | null;
  leadId?: string | null;
  type: SiteEventType;
  path?: string | null;
  detail?: string | null;
  occurredAt?: string | null;
}

let seq = 0;
const activityId = (): string =>
  `activity_${Date.now().toString(36)}_${(seq++).toString(36)}_${Math.random().toString(36).slice(2, 7)}`;

export async function ingestSiteEvent(
  e: SiteEvent,
): Promise<{ activityId: string; leadId: string | null }> {
  const db = getDatabase();

  let leadId: string | null = null;
  if (e.leadId) {
    leadId = e.leadId;
  } else if (e.email) {
    // Newest lead for the address — the same `ORDER BY created_at DESC LIMIT 1`,
    // which matters because one address can have several leads over time and the
    // engagement belongs to the current one.
    leadId = (await db.reengagement.listLeadsByEmail(e.email))[0]?.id ?? null;
  }

  const now = new Date().toISOString();
  const id = activityId();
  await db.reengagement.logActivity({
    id,
    lead_id: leadId,
    type: e.type,
    path: e.path ?? null,
    detail: e.detail ?? null,
    // COALESCE($5, now()) — a provider that reports when the event happened wins
    // over when we received it.
    occurred_at: e.occurredAt ?? now,
    created_at: now,
  });

  // Surface recent engagement to the cadence.
  if (leadId) {
    const lead = await db.reengagement.findLeadById(leadId);
    if (lead) await db.reengagement.saveLead({ ...lead, last_touch: now, updated_at: now });
  }

  return { activityId: id, leadId };
}
