import { getDatabase } from '../db/index.js';
import type { Lead } from '../db/interfaces/types.js';
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

/** Outcome of evaluating one lead — tallied by the batch runner. */
type LeadOutcome = 'sent' | 'deactivated' | 'skipped' | 'none';

let seq = 0;
const messageId = (): string =>
  `msg_${Date.now().toString(36)}_${(seq++).toString(36)}_${Math.random().toString(36).slice(2, 7)}`;

/**
 * Evaluate and action a single lead: send the due cadence step (dry-run until
 * Outlook is configured), deactivate a cold lead, or do nothing. Shared by the
 * batch pass and the on-intake immediate first response, so both take the exact
 * same send path. Never throws — logs and returns 'none' on failure.
 */
async function processLead(row: Lead, now: Date): Promise<LeadOutcome> {
  const db = getDatabase();
  const sentSteps = row.sequence_state?.sent ?? [];
  const state: LeadState = {
    status: row.status,
    created_at: new Date(row.created_at),
    last_touch: row.last_touch ? new Date(row.last_touch) : null,
    sentSteps,
    cadenceCancelled: !!row.cadence_cancelled_at,
  };
  const action = nextCadenceAction(state, now);

  try {
    if (action.kind === 'deactivate') {
      await db.reengagement.saveLead({ ...row, status: 'closed', updated_at: new Date().toISOString() });
      return 'deactivated';
    }
    if (action.kind === 'send') {
      if (!row.email) return 'skipped';
      // Inject available booking slots into emails that reference scheduling.
      const body = await appendSlotSuggestions(action.body, row.id);
      await sendEmail({ to: row.email, subject: action.subject, body });

      const stamp = new Date().toISOString();
      await db.reengagement.logMessage({
        id: messageId(),
        lead_id: row.id,
        client_id: null,
        channel: 'email',
        body: `${action.subject}\n\n${body}`,
        sent_at: stamp,
        status: 'sent',
        created_at: stamp,
      });

      // Advance sequence state + status, and stamp last_touch. Fixed-track
      // leads (cancelled/maintenance) keep their status so they stay on that
      // track; inquiry leads progress new → contacted → nurturing.
      const nextStatus = FIXED_TRACK_STATUSES.has(row.status)
        ? row.status
        : row.status === 'new'
          ? 'contacted'
          : 'nurturing';
      // `jsonb_set(... || to_jsonb(step))` becomes an array append on the map.
      // Appending the step is what makes the cadence idempotent — nextCadenceAction
      // never re-offers a step already listed here.
      await db.reengagement.saveLead({
        ...row,
        sequence_state: { ...row.sequence_state, sent: [...sentSteps, action.step] },
        last_touch: stamp,
        status: nextStatus,
        updated_at: stamp,
      });
      return 'sent';
    }
    return 'none';
  } catch (err) {
    logError('reengagement.run', 'cadence step failed', err, { lead_id: row.id, action: action.kind });
    return 'none';
  }
}

export async function runReengagement(now: Date = new Date()): Promise<ReengagementResult> {
  const rows = await getDatabase().reengagement.listActiveLeads();

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
  const lead = await getDatabase().reengagement.findLeadById(leadId);
  if (!lead || lead.status === 'closed' || lead.status === 'booked') return 'none';
  return processLead(lead, now);
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
