import { getDatabase } from '../db/index.js';

// WF3 lead intake: the single code path that lands a new inquiry into the
// `leads` collection, from either the website contact/booking form or an Outlook
// inbox message forwarded to us. Mirrors `conversations/ingestConversation` —
// one idempotent entry point that the webhook (and the Graph inbox poller) both
// call, so the cadence engine downstream is unchanged regardless of source.

export interface LeadIntakeInput {
  email: string;
  /** Optional display name — folded into the intake activity (no field on leads). */
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
  /** true when a new lead was created; false when an existing active lead was reused. */
  created: boolean;
}

// Statuses that mean "no longer in an active sequence" — a fresh inquiry from
// such an email starts a new lead rather than reviving a settled one.
const REUSE_EXCLUDED = new Set(['closed', 'booked', 'replied']);

let seq = 0;
const newId = (kind: string): string =>
  `${kind}_${Date.now().toString(36)}_${(seq++).toString(36)}_${Math.random().toString(36).slice(2, 7)}`;

/**
 * Find-or-create a lead by email and record the inquiry as a lead_activity row.
 * Idempotent for rapid double-submits: an email with an active lead reuses it
 * (adds another activity, no duplicate lead); an email whose only leads are
 * closed/booked/replied starts a fresh lead so the welcome cadence runs again.
 *
 * The pg version wrapped both writes in a transaction, but there was never a
 * unique index on email — so a genuine double-submit could always produce two
 * leads, in either store. What the transaction did buy was "never a lead
 * without its intake activity", and the ordering here keeps that: the lead is
 * written first, so a failure leaves a lead with no activity (visible, and the
 * next submit attaches to it) rather than an activity pointing at nothing.
 */
export async function ingestLead(input: LeadIntakeInput): Promise<LeadIntakeResult> {
  const db = getDatabase();
  // Stored lowercased — that normalization is what replaces `lower(email)`,
  // since Firestore cannot compare case-insensitively at query time.
  const email = input.email.trim().toLowerCase();
  const now = new Date().toISOString();

  const active = (await db.reengagement.listLeadsByEmail(email)).find(
    (l) => !REUSE_EXCLUDED.has(l.status),
  );

  let leadId: string;
  let created = false;
  if (active) {
    leadId = active.id;
  } else {
    leadId = newId('lead');
    await db.reengagement.saveLead({
      id: leadId,
      email,
      source: input.source ?? 'website',
      status: 'new',
      sequence_state: {},
      last_touch: null,
      cadence_cancelled_at: null,
      created_at: now,
      updated_at: now,
    });
    created = true;
  }

  const detail =
    [input.name ? `name: ${input.name}` : null, input.detail].filter(Boolean).join(' — ') || null;
  await db.reengagement.logActivity({
    id: newId('activity'),
    lead_id: leadId,
    type: input.activityType ?? 'form_submit',
    path: input.path ?? null,
    detail,
    occurred_at: now,
    created_at: now,
  });

  return { leadId, created };
}
