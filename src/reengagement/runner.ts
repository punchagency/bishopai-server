import { pool } from '../db/pool';
import { logEvent, logError } from '../observability/logger';
import { sendEmail } from '../integrations/outlook';
import { nextCadenceAction, FIXED_TRACK_STATUSES, trackNameFor, resolveTemplate, type LeadState } from './cadence';
import { queueEmail } from '../outbound/queue';
import { priorityForStep } from '../outbound/policy';
import { categoryForTrack } from '../outbound/policy';

// WF3 cadence pass (run by the scheduler): evaluate every active lead, send the
// due step (dry-run until Outlook is configured), and advance its sequence
// state. Cold leads past the deactivation window are closed out. Pure decision
// logic lives in cadence.ts; this is the DB + send side.

export interface ReengagementResult {
  scanned: number;
  /** Held for approval — nothing reaches a client from this pass. */
  queued: number;
  /** Sent outright: only the welcome to a brand-new enquiry is exempt. */
  sent: number;
  deactivated: number;
  skipped: number; // due to send but no email on file
}

export interface LeadDraft {
  subject: string;
  body: string;
  updated_at?: string;
}

export interface LeadSequenceState {
  sent?: string[];
  /** Steps sitting in the approval queue — rendered, not yet seen by a client. */
  queued?: string[];
  drafts?: Record<string, LeadDraft>;
}

interface LeadRow {
  id: string;
  email: string | null;
  status: string;
  sequence_state: LeadSequenceState | null;
  last_touch: string | null;
  created_at: string;
  cadence_cancelled_at: string | null;
}

const LEAD_COLUMNS = `id, email, status, sequence_state, last_touch, created_at, cadence_cancelled_at`;

/** Outcome of evaluating one lead — tallied by the batch runner. */
type LeadOutcome = 'sent' | 'queued' | 'deactivated' | 'skipped' | 'none';

/**
 * The enquiry welcome used to send without approval.
 *
 * The reasoning was sound and is preserved: someone who has just written in is
 * owed a reply now, and holding the welcome for the weekly review answers a
 * Tuesday enquiry on Friday. But that is an argument about LATENCY, not about
 * whether a person should see it — so it is now served by a faster lane through
 * the queue (outbound/policy.ts: priorityForStep) rather than by a way around
 * it. The welcome is queued 'urgent': reviewed today, dropped after a day.
 *
 * Nothing automated sends email any more. The only sends left in this file are
 * Nicole pressing send on one lead, which is an approval by definition.
 */

/**
 * Evaluate and action a single lead: send the due cadence step (dry-run until
 * Outlook is configured), deactivate a cold lead, or do nothing. Shared by the
 * batch pass and the on-intake immediate first response, so both take the exact
 * same send path. Never throws — logs and returns 'none' on failure.
 */
async function processLead(row: LeadRow, now: Date): Promise<LeadOutcome> {
  const state: LeadState = {
    status: row.status,
    created_at: new Date(row.created_at),
    last_touch: row.last_touch ? new Date(row.last_touch) : null,
    // A step already waiting for approval counts as done for scheduling purposes.
    // Without this the weekly assembly would offer the same nudge again every
    // time it ran, and the cadence would stall on whatever is sitting unapproved.
    sentSteps: [...(row.sequence_state?.sent ?? []), ...(row.sequence_state?.queued ?? [])],
    cadenceCancelled: row.cadence_cancelled_at !== null,
  };
  const action = nextCadenceAction(state, now);

  try {
    if (action.kind === 'deactivate') {
      await pool.query(`UPDATE leads SET status = 'closed' WHERE id = $1`, [row.id]);
      return 'deactivated';
    }
    if (action.kind === 'send') {
      if (!row.email) return 'skipped';
      // Per-lead custom draft wins over track template, which wins over hardcoded default.
      const trackName = trackNameFor(row.status);
      const draft = row.sequence_state?.drafts?.[action.step];
      const tpl = draft ?? (await resolveTemplate(trackName, action.step)) ??
        { subject: action.subject, body: action.body };
      // Inject available booking slots into emails that reference scheduling.
      const body = await appendSlotSuggestions(tpl.body, row.id);
      const subject = tpl.subject;

      // Every cadence step is held for approval — there is no longer an
      // exception. The step is recorded as queued so the next assembly moves on
      // rather than re-offering it, and it stays consumed if the item is later
      // rejected or expires: a nudge nobody approved is a nudge that should not
      // keep coming back.
      const res = await queueEmail(
        {
          category: categoryForTrack(trackName),
          priority: priorityForStep(action.step),
          toEmail: row.email,
          subject,
          body,
          sourceRef: `cadence:${trackName}:${action.step}`,
          leadId: row.id,
        },
        now,
      );
      if (!res.queued) return res.duplicate ? 'none' : 'skipped';
      await pool.query(
        `UPDATE leads
            SET sequence_state = jsonb_set(
                  coalesce(sequence_state, '{}'::jsonb), '{queued}',
                  coalesce(sequence_state->'queued', '[]'::jsonb) || to_jsonb($2::text)
                )
          WHERE id = $1`,
        [row.id, action.step],
      );
      return 'queued';
    }
    return 'none';
  } catch (err) {
    logError('reengagement.run', 'cadence step failed', err, { lead_id: row.id, action: action.kind });
    return 'none';
  }
}

export async function runReengagement(now: Date = new Date()): Promise<ReengagementResult> {
  const { rows } = await pool.query<LeadRow>(
    `SELECT ${LEAD_COLUMNS} FROM leads WHERE status NOT IN ('closed', 'booked')`,
  );

  let sent = 0;
  let deactivated = 0;
  let skipped = 0;
  let queued = 0;
  for (const row of rows) {
    const outcome = await processLead(row, now);
    if (outcome === 'sent') sent++;
    else if (outcome === 'queued') queued++;
    else if (outcome === 'deactivated') deactivated++;
    else if (outcome === 'skipped') skipped++;
  }

  logEvent('info', 'reengagement.run', 'cadence pass complete', {
    scanned: rows.length,
    queued,
    sent,
    deactivated,
    skipped,
  });
  return { scanned: rows.length, queued, sent, deactivated, skipped };
}

/**
 * Run the cadence for a single lead immediately — used on lead intake so a new
 * inquiry gets its first response "within minutes" instead of waiting for the
 * hourly batch. A no-op for a lead that's already closed/booked or has no step
 * due yet. Idempotent: won't resend a step already recorded in sequence_state.
 */
export async function runReengagementForLead(leadId: string, now: Date = new Date()): Promise<LeadOutcome> {
  const { rows } = await pool.query<LeadRow>(
    `SELECT ${LEAD_COLUMNS} FROM leads WHERE id = $1 AND status NOT IN ('closed', 'booked')`,
    [leadId],
  );
  if (rows.length === 0) return 'none';
  return processLead(rows[0], now);
}

/**
 * Send an email to a specific lead immediately — with optional custom subject
 * and body edited by Nicole before sending.
 */
export async function sendIndividualLeadEmail(
  leadId: string,
  custom?: { step?: string; subject?: string; body?: string },
): Promise<{ ok: boolean; step: string; subject: string; error?: string }> {
  const { rows } = await pool.query<LeadRow>(
    `SELECT ${LEAD_COLUMNS} FROM leads WHERE id = $1 AND status NOT IN ('closed', 'booked')`,
    [leadId],
  );
  if (rows.length === 0) return { ok: false, step: '', subject: '', error: 'Lead not found or already closed/booked' };
  const row = rows[0];
  if (!row.email) return { ok: false, step: '', subject: '', error: 'Lead has no email on file' };

  const now = new Date();
  const state: LeadState = {
    status: row.status,
    created_at: new Date(row.created_at),
    last_touch: row.last_touch ? new Date(row.last_touch) : null,
    sentSteps: row.sequence_state?.sent ?? [],
    cadenceCancelled: row.cadence_cancelled_at !== null,
  };

  const action = nextCadenceAction(state, now);
  const step = custom?.step ?? (action.kind === 'send' ? action.step : 'manual_email');
  const trackName = trackNameFor(row.status);

  // Resolution hierarchy: explicit payload > stored draft > template override > cadence default
  let subject = custom?.subject?.trim();
  let body = custom?.body?.trim();
  if (!subject || !body) {
    const draft = row.sequence_state?.drafts?.[step];
    const tpl = draft ?? (await resolveTemplate(trackName, step));
    subject = subject || tpl?.subject || (action.kind === 'send' ? action.subject : 'Message from Nicole');
    body = body || tpl?.body || (action.kind === 'send' ? action.body : '');
  }

  body = await appendSlotSuggestions(body, row.id);

  let result: import('../integrations/outlook').EmailResult;
  try {
    result = await sendEmail({ to: row.email, subject, body });
  } catch (err) {
    logError('reengagement.send_individual', 'sendEmail threw', err, { lead_id: row.id, step });
    return { ok: false, step, subject, error: err instanceof Error ? err.message : 'Send failed' };
  }

  await pool.query(
    `INSERT INTO email_send_log (lead_id, track, step, to_email, subject, body, dry_run, ok, error)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [row.id, trackName, step, row.email, subject, body,
      result.dryRun ?? false, result.ok, result.error ?? null],
  ).catch((e) => logError('reengagement.send_log', 'failed to write send log', e, { lead_id: row.id }));

  if (!result.ok) {
    return { ok: false, step, subject, error: result.error ?? 'Email send failed' };
  }

  await pool.query(
    `INSERT INTO messages (lead_id, channel, body, sent_at, status)
          VALUES ($1, 'email', $2, now(), 'sent')`,
    [row.id, `${subject}\n\n${body}`],
  );

  const nextStatus = FIXED_TRACK_STATUSES.has(row.status)
    ? row.status
    : row.status === 'new'
      ? 'contacted'
      : 'nurturing';

  await pool.query(
    `UPDATE leads
        SET sequence_state = (
              jsonb_set(
                coalesce(sequence_state, '{}'::jsonb), '{sent}',
                coalesce(sequence_state->'sent', '[]'::jsonb) || to_jsonb($2::text)
              ) #- ARRAY['drafts', $2::text]
            ),
            last_touch = now(),
            status = $3
      WHERE id = $1`,
    [row.id, step, nextStatus],
  );

  return { ok: true, step, subject };
}

// ---------------------------------------------------------------------------
// Slot injection — appends available booking suggestions to re-engagement
// emails whose body references scheduling keywords. Best-effort: on any
// failure the original body is returned unchanged so the send still goes out.
// ---------------------------------------------------------------------------

const BOOKING_KEYWORDS = /\b(book|reschedule|find a time|schedule|appointment|session|visit|consult)\b/i;

/**
 * The marker on the injected block.
 *
 * The desktop editor splits an approval body on this to let Nicole edit her
 * message while the buttons ride along untouched (renderer/src/lib/emailBody.ts),
 * and stripSlotBlock uses it to make re-injection idempotent. Renaming it breaks
 * both, and orphans every row already queued.
 */
export const SLOT_BLOCK_MARKER = 'data-innerlume="booking-slots"';

// Bodies injected before the marker existed. Matched on the heading text, since
// the styles have already changed.
const LEGACY_BLOCK = /\n?<div style="margin-top: 1\.5rem;[^"]*"\s*>\s*<p[^>]*>Some available times[\s\S]*$/i;

/** Remove any previously injected block, so the body can be re-rendered. */
export function stripSlotBlock(body: string): string {
  const marked = body.indexOf(`<div ${SLOT_BLOCK_MARKER}`);
  if (marked !== -1) return body.slice(0, marked).replace(/\n$/, '');
  return body.replace(LEGACY_BLOCK, '');
}

// Colours are light-first and taken from the LIGHT theme tokens. The block is
// appended to a plain-text body and sent as HTML with no wrapper (the Outlook
// integration auto-detects HTML), so it lands on the recipient's own background
// — white in almost every client. The original palette was copied from the app's
// DARK theme (#f3e9e2 text, a #c79b84→#aa7660 accent gradient), which is why the
// heading arrived invisible and the buttons arrived as bare text in Outlook.
// Measured on white: heading 17.3:1, hint 6.6:1, button 8.9:1. The palette they
// replace measured 1.2:1 and 2.4:1.
const INK = '#211913';        // --text
const INK_SOFT = '#6b5a50';   // --text-muted
const RULE = '#e7dcd4';       // --border
const BRAND = '#7f3111';      // --accent-active; 8.9:1 with white text
const FONT = "'Source Sans 3', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif";

/**
 * One booking button.
 *
 * Table-based rather than a styled <a>: Outlook on Windows drops border-radius,
 * linear-gradient and box-shadow, so the old gradient button rendered as dark
 * text on no background at all. A td with a bgcolor attribute is the one thing
 * every client honours; the radius is left as progressive enhancement.
 */
function slotButton(href: string, label: string): string {
  return `
      <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin: 0 0 10px;">
        <tr>
          <td bgcolor="${BRAND}" style="border-radius: 6px;">
            <a href="${href}" style="display: block; padding: 13px 24px; font-family: ${FONT}; font-size: 15px; font-weight: 600; line-height: 1; color: #ffffff; text-decoration: none; border-radius: 6px;">${label}</a>
          </td>
        </tr>
      </table>`;
}

/**
 * The whole appended block, from ready-made links.
 *
 * Takes hrefs rather than building them, so the same renderer serves both the
 * runner (fresh links, freshly signed) and scripts/refresh-slot-blocks.mts,
 * which re-renders queued mail and must carry each existing href through
 * untouched — its token is an HMAC bound to that exact slot, and re-signing it
 * anywhere without BOOKING_LINK_SECRET would silently strip it.
 */
export function renderSlotBlock(links: { href: string; label: string }[]): string {
  const buttons = links.map((l) => slotButton(l.href, l.label)).join('');

  return `<div ${SLOT_BLOCK_MARKER} style="margin-top: 28px; padding-top: 20px; border-top: 1px solid ${RULE}; font-family: ${FONT};">
  <p style="margin: 0 0 14px; font-family: ${FONT}; font-size: 16px; font-weight: 700; line-height: 1.4; color: ${INK};">Some available times that work for me</p>
${buttons}
  <p style="margin: 14px 0 0; font-family: ${FONT}; font-size: 14px; line-height: 1.5; color: ${INK_SOFT};">
    Tap a time to confirm it, or just reply with what suits you and I'll get you booked in.
  </p>
</div>`;
}

async function appendSlotSuggestions(body: string, leadId: string): Promise<string> {
  if (!BOOKING_KEYWORDS.test(body)) return body;
  try {
    // Import helpers lazily to avoid circular dep at module load time.
    const { fetchUpcoming, deriveAvailableSlots, loadOfficeHours } = await import('../routes/appointments');
    const oh = await (loadOfficeHours as () => Promise<import('../routes/appointments').OfficeHours>)();
    const booked = await fetchUpcoming(oh);
    const slots = deriveAvailableSlots(booked, oh);
    if (slots.length === 0) return body;

    const { signBookingToken } = await import('./bookingToken');
    const baseUrl = process.env.PUBLIC_BASE_URL || 'http://localhost:3000';

    const links = slots.map((s) => {
      const token = signBookingToken(leadId, s.starts_at);
      const tokenParam = token ? `&token=${encodeURIComponent(token)}` : '';
      return {
        href: `${baseUrl}/webhooks/appointments/book?leadId=${leadId}&slot=${encodeURIComponent(s.starts_at)}${tokenParam}`,
        label: s.label,
      };
    });

    // Strip first: a body that already carries a block (a re-render, or a
    // refreshed queue row) must not end up with two.
    const message = stripSlotBlock(body);
    const formattedBody = message.replace(/\n/g, '<br/>');

    return `${formattedBody}\n${renderSlotBlock(links)}`;
  } catch (err) {
    logError('reengagement.slots', 'slot injection failed — sending without slots', err);
    return body;
  }
}
