import { pool } from '../db/pool';
import { logEvent, logError } from '../observability/logger';
import { sendEmail } from '../integrations/outlook';
import { nextCadenceAction, FIXED_TRACK_STATUSES, type LeadState } from './cadence';

// WF3 cadence pass (run by the scheduler): evaluate every active lead, send the
// due step (dry-run until Outlook is configured), and advance its sequence
// state. Cold leads past the deactivation window are closed out. Pure decision
// logic lives in cadence.ts; this is the DB + send side.

export interface ReengagementResult {
  scanned: number;
  sent: number;
  deactivated: number;
  skipped: number; // due to send but no email on file
}

interface LeadRow {
  id: string;
  email: string | null;
  status: string;
  sequence_state: { sent?: string[] } | null;
  last_touch: string | null;
  created_at: string;
}

const LEAD_COLUMNS = `id, email, status, sequence_state, last_touch, created_at`;

/** Outcome of evaluating one lead — tallied by the batch runner. */
type LeadOutcome = 'sent' | 'deactivated' | 'skipped' | 'none';

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
    sentSteps: row.sequence_state?.sent ?? [],
  };
  const action = nextCadenceAction(state, now);

  try {
    if (action.kind === 'deactivate') {
      await pool.query(`UPDATE leads SET status = 'closed' WHERE id = $1`, [row.id]);
      return 'deactivated';
    }
    if (action.kind === 'send') {
      if (!row.email) return 'skipped';
      // Inject available booking slots into emails that reference scheduling.
      const body = await appendSlotSuggestions(action.body, row.id);
      await sendEmail({ to: row.email, subject: action.subject, body });
      await pool.query(
        `INSERT INTO messages (lead_id, channel, body, sent_at, status)
              VALUES ($1, 'email', $2, now(), 'sent')`,
        [row.id, `${action.subject}\n\n${body}`],
      );
      // Advance sequence state + status, and stamp last_touch. Fixed-track
      // leads (cancelled/maintenance) keep their status so they stay on that
      // track; inquiry leads progress new → contacted → nurturing.
      const nextStatus = FIXED_TRACK_STATUSES.has(row.status)
        ? row.status
        : row.status === 'new'
          ? 'contacted'
          : 'nurturing';
      await pool.query(
        `UPDATE leads
            SET sequence_state = jsonb_set(
                  coalesce(sequence_state, '{}'::jsonb), '{sent}',
                  coalesce(sequence_state->'sent', '[]'::jsonb) || to_jsonb($2::text)),
                last_touch = now(),
                status = $3
          WHERE id = $1`,
        [row.id, action.step, nextStatus],
      );
      return 'sent';
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
  for (const row of rows) {
    const outcome = await processLead(row, now);
    if (outcome === 'sent') sent++;
    else if (outcome === 'deactivated') deactivated++;
    else if (outcome === 'skipped') skipped++;
  }

  logEvent('info', 'reengagement.run', 'cadence pass complete', {
    scanned: rows.length,
    sent,
    deactivated,
    skipped,
  });
  return { scanned: rows.length, sent, deactivated, skipped };
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

// ---------------------------------------------------------------------------
// Slot injection — appends available booking suggestions to re-engagement
// emails whose body references scheduling keywords. Best-effort: on any
// failure the original body is returned unchanged so the send still goes out.
// ---------------------------------------------------------------------------

const BOOKING_KEYWORDS = /\b(book|reschedule|find a time|schedule|appointment|session|visit|consult)\b/i;

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
    const slotLines = slots.map((s) => {
      const token = signBookingToken(leadId, s.starts_at);
      const tokenParam = token ? `&token=${encodeURIComponent(token)}` : '';
      const bookUrl = `${baseUrl}/webhooks/appointments/book?leadId=${leadId}&slot=${encodeURIComponent(s.starts_at)}${tokenParam}`;
      return `  • ${s.label} — Confirm & book: ${bookUrl}`;
    }).join('\n');

    return `${body}\n\nSome available times that work for me:\n${slotLines}\n\nClick one of the links above to confirm your booking, or reply with your preferred slot and I'll get you booked in!`;
  } catch (err) {
    logError('reengagement.slots', 'slot injection failed — sending without slots', err);
    return body;
  }
}
