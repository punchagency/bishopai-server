import { pool } from '../db/pool';

// WF3 lead intake: the single code path that lands a new inquiry into the
// `leads` table, from either the website contact/booking form or an Outlook
// inbox message forwarded to us. Mirrors `conversations/ingestConversation` —
// one idempotent entry point that the webhook (and a future Graph inbox poller)
// both call, so the cadence engine downstream is unchanged regardless of source.

export interface LeadIntakeInput {
  email: string;
  /** Optional display name — folded into the intake activity (no column on leads). */
  name?: string | null;
  /** Origin: 'website' | 'outlook' | ... Stored on the lead for reporting. */
  source?: string | null;
  /** Site path the inquiry came from, e.g. '/book-a-consult'. */
  path?: string | null;
  /** Free text — the form message or inbox subject/snippet. */
  detail?: string | null;
  /** lead_activity.type — defaults to 'form_submit'. */
  activityType?: string;
}

export interface LeadIntakeResult {
  leadId: string;
  /** true when a new lead row was created; false when an existing active lead was reused. */
  created: boolean;
}

// Statuses that mean "no longer in an active sequence" — a fresh inquiry from
// such an email starts a new lead rather than reviving a settled one.
const REUSE_EXCLUDED = ['closed', 'booked', 'replied'];

/**
 * Find-or-create a lead by email and record the inquiry as a lead_activity row.
 * Idempotent for rapid double-submits: an email with an active lead reuses it
 * (adds another activity, no duplicate lead); an email whose only leads are
 * closed/booked/replied starts a fresh lead so the welcome cadence runs again.
 */
export async function ingestLead(input: LeadIntakeInput): Promise<LeadIntakeResult> {
  const email = input.email.trim();
  const db = await pool.connect();
  try {
    await db.query('BEGIN');

    const found = await db.query<{ id: string }>(
      `SELECT id FROM leads
        WHERE lower(email) = lower($1) AND status <> ALL($2::text[])
     ORDER BY created_at DESC
        LIMIT 1`,
      [email, REUSE_EXCLUDED],
    );

    let leadId: string;
    let created = false;
    if (found.rowCount) {
      leadId = found.rows[0].id;
    } else {
      const ins = await db.query<{ id: string }>(
        `INSERT INTO leads (source, email, status) VALUES ($1, $2, 'new') RETURNING id`,
        [input.source ?? 'website', email],
      );
      leadId = ins.rows[0].id;
      created = true;
    }

    const detail = [input.name ? `name: ${input.name}` : null, input.detail]
      .filter(Boolean)
      .join(' — ') || null;
    await db.query(
      `INSERT INTO lead_activity (lead_id, type, path, detail) VALUES ($1, $2, $3, $4)`,
      [leadId, input.activityType ?? 'form_submit', input.path ?? null, detail],
    );

    await db.query('COMMIT');
    return { leadId, created };
  } catch (err) {
    await db.query('ROLLBACK');
    throw err;
  } finally {
    db.release();
  }
}
