import { pool } from '../db/pool';

// WF3 site-behavior ingest: land website analytics events (page views, form
// opens/submits, email opens) into `lead_activity`. Provider-agnostic — a
// PostHog/Hotjar webhook or a first-party pixel can POST here. Events with a
// known email attribute to that lead (and refresh its last_touch so the cadence
// sees engagement); anonymous events are still recorded (lead_id NULL) for
// funnel/heat-map analysis.

export const SITE_EVENT_TYPES = ['page_view', 'form_open', 'form_submit', 'email_open'] as const;
export type SiteEventType = (typeof SITE_EVENT_TYPES)[number];

export interface SiteEvent {
  email?: string | null;
  type: SiteEventType;
  path?: string | null;
  detail?: string | null;
  occurredAt?: string | null;
}

export async function ingestSiteEvent(e: SiteEvent): Promise<{ activityId: string; leadId: string | null }> {
  let leadId: string | null = null;
  if (e.email) {
    const r = await pool.query<{ id: string }>(
      `SELECT id FROM leads WHERE lower(email) = lower($1) ORDER BY created_at DESC LIMIT 1`,
      [e.email],
    );
    leadId = r.rows[0]?.id ?? null;
  }

  const ins = await pool.query<{ id: string }>(
    `INSERT INTO lead_activity (lead_id, type, path, detail, occurred_at)
          VALUES ($1, $2, $3, $4, COALESCE($5::timestamptz, now()))
       RETURNING id`,
    [leadId, e.type, e.path ?? null, e.detail ?? null, e.occurredAt ?? null],
  );

  // Surface recent engagement to the cadence.
  if (leadId) await pool.query(`UPDATE leads SET last_touch = now() WHERE id = $1`, [leadId]);

  return { activityId: ins.rows[0].id, leadId };
}
