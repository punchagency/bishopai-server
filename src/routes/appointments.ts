import { Router } from 'express';
import { z } from 'zod';
import { pool } from '../db/pool';
import { logEvent, logError } from '../observability/logger';
import { isPbConfigured } from '../integrations/pb/config';
import { listSessions } from '../integrations/pb/reads';
import { clientRecordName } from '../integrations/pb/types';
import type { PbSession } from '../integrations/pb/types';
import { buildBrief } from '../brief/service';
import { recordAudit } from '../audit/log';

// ---------------------------------------------------------------------------
// Schedule / Appointments route
//
// GET  /appointments/upcoming        — next N days of sessions (PB or local DB)
// GET  /appointments/slots           — derived free slots (TZ-correct)
// GET  /appointments/office-hours    — Nicole's current office hours config
// PUT  /appointments/office-hours    — Nicole sets her schedule from Settings
// ---------------------------------------------------------------------------

export const appointmentsRouter = Router();

// --- Office hours config types ----------------------------------------------

export interface OfficeHours {
  timezone: string;          // IANA tz, e.g. "Europe/London"
  days: number[];            // JS day-of-week 0=Sun, e.g. [1,2,3,4,5]
  start_hour: number;        // 0–23 (in Nicole's timezone)
  end_hour: number;          // 0–23 (in Nicole's timezone)
  session_duration_min: number;
  slot_horizon_days: number;
  max_slots: number;
  service_id?: string;
  service_type?: string;
}

const DEFAULT_OFFICE_HOURS: OfficeHours = {
  timezone: 'Europe/London',
  days: [1, 2, 3, 4, 5],
  start_hour: 9,
  end_hour: 17,
  session_duration_min: 60,
  slot_horizon_days: 7,
  max_slots: 3,
  service_id: '',
  service_type: 'virtual',
};

/** True if `tz` is a valid IANA timezone (Intl throws RangeError otherwise). */
function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-GB', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

const officeHoursSchema = z
  .object({
    timezone: z.string().min(1).refine(isValidTimeZone, { message: 'invalid IANA timezone' }),
    days: z.array(z.number().int().min(0).max(6)).min(1),
    start_hour: z.number().int().min(0).max(23),
    end_hour: z.number().int().min(1).max(24),
    session_duration_min: z.number().int().min(15).max(480),
    slot_horizon_days: z.number().int().min(1).max(30),
    max_slots: z.number().int().min(1).max(10),
    service_id: z.string().optional(),
    service_type: z.string().optional(),
  })
  .refine((d) => d.start_hour < d.end_hour, {
    message: 'start_hour must be before end_hour',
    path: ['end_hour'],
  });

// --- Session types ----------------------------------------------------------

export interface UpcomingSession {
  id: string;
  pb_id: string | null;
  client_name: string | null;
  starts_at: string;   // ISO-8601 UTC
  ends_at: string | null;
  status: string;
  service_type: string | null;
  source: 'pb' | 'local';
}

export interface BookingSlot {
  starts_at: string;   // ISO-8601 UTC
  ends_at: string;
  label: string;       // formatted in Nicole's TZ, e.g. "Wednesday 2:00 PM"
}

// --- DB helpers -------------------------------------------------------------

export async function loadOfficeHours(): Promise<OfficeHours> {
  try {
    const { rows } = await pool.query<{ value: string }>(
      `SELECT value FROM integration_state WHERE key = 'office_hours'`,
    );
    if (rows[0]?.value) return { ...DEFAULT_OFFICE_HOURS, ...JSON.parse(rows[0].value) };
  } catch {
    // fall through to default
  }
  return DEFAULT_OFFICE_HOURS;
}

async function saveOfficeHours(oh: OfficeHours): Promise<void> {
  await pool.query(
    `INSERT INTO integration_state (key, value)
     VALUES ('office_hours', $1)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [JSON.stringify(oh)],
  );
}

// --- Fetch upcoming sessions (PB → local DB fallback) ----------------------

// PB /consultant/sessions supports `date_gte`/`date_lte` (confirmed) and returns
// most-recently-CREATED first (descending). We still page defensively — a busy
// slot we don't see would be offered as free (double-booking) — using the
// `before_id` cursor (the documented cursor for a descending list) and bound it
// with MAX_PAGES. We keep the server-side date filter AND re-filter client-side.
const SESSIONS_PAGE_SIZE = 100;
const SESSIONS_MAX_PAGES = 5;

async function fetchPbSessionsPaged(now: Date, horizon: Date): Promise<PbSession[]> {
  const all: PbSession[] = [];
  let beforeId: string | undefined;
  for (let page = 0; page < SESSIONS_MAX_PAGES; page++) {
    const res = await listSessions({
      date_gte: now.toISOString(),
      date_lte: horizon.toISOString(),
      limit: String(SESSIONS_PAGE_SIZE),
      ...(beforeId ? { before_id: beforeId } : {}),
    });
    const batch = res.items ?? [];
    all.push(...batch);
    if (batch.length < SESSIONS_PAGE_SIZE) break; // last page
    beforeId = batch[batch.length - 1]?.id;
    if (!beforeId) break;
  }
  return all;
}

/** True if a session is cancelled — the dedicated flag, with a status-string backup. */
function isCancelledSession(s: PbSession): boolean {
  if (s.cancelled) return true;
  return !!s.confirmationStatus && /cancel|declin|no.?show/i.test(s.confirmationStatus);
}

export async function fetchUpcoming(oh: OfficeHours): Promise<UpcomingSession[]> {
  const now = new Date();
  const horizon = new Date(now.getTime() + oh.slot_horizon_days * 86_400_000);

  if (isPbConfigured()) {
    try {
      const items = await fetchPbSessionsPaged(now, horizon);
      const results = items
        .filter((s) => {
          if (!s.sessionDate) return false;
          const d = new Date(s.sessionDate);
          if (d < now || d > horizon) return false;
          // A cancelled session must NOT count as busy, or we'd hide a free slot.
          return !isCancelledSession(s);
        })
        .map((s): UpcomingSession => ({
          id: s.id,
          pb_id: s.id,
          client_name: clientRecordName(s.clientRecord) ?? null,
          starts_at: s.sessionDate!,
          // Prefer PB's true end time; fall back to start + duration.
          ends_at: s.endDate ?? addMinutes(s.sessionDate!, s.duration ?? oh.session_duration_min),
          status: s.confirmationStatus ?? 'confirmed',
          service_type: s.serviceType ?? null,
          source: 'pb',
        }));
      logEvent('info', 'appointments.upcoming', 'fetched from PB', { count: results.length });
      return results;
    } catch (err) {
      logError('appointments.upcoming', 'PB fetch failed — falling back to local DB', err);
    }
  }

  // Local DB fallback — webhook-synced appointments
  const { rows } = await pool.query<{
    id: string; pb_id: string; client_name: string | null;
    starts_at: string; ends_at: string; status: string;
  }>(
    `SELECT a.id, a.pb_id, c.name AS client_name, a.starts_at, a.ends_at, a.status
       FROM appointments a
       LEFT JOIN clients c ON c.id = a.client_id
      WHERE a.starts_at BETWEEN $1 AND $2
        AND a.status NOT IN ('cancelled', 'completed')
      ORDER BY a.starts_at ASC
      LIMIT 100`,
    [now.toISOString(), horizon.toISOString()],
  );
  return rows.map((r): UpcomingSession => ({
    id: r.id,
    pb_id: r.pb_id,
    client_name: r.client_name,
    starts_at: r.starts_at,
    ends_at: r.ends_at,
    status: r.status,
    service_type: null,
    source: 'local',
  }));
}

// --- Slot derivation (TZ-correct) ------------------------------------------
//
// Key fix: we never call Date#getDay() or Date#getHours() — both depend on the
// server's local TZ. Instead we use Intl.DateTimeFormat to extract the
// calendar fields in Nicole's configured IANA timezone, so the answer is
// always correct regardless of where the server is running.

function localFields(d: Date, tz: string): { day: number; hour: number; minute: number } {
  try {
    const parts = new Intl.DateTimeFormat('en-GB', {
      timeZone: tz,
      weekday: 'short',   // Mon/Tue/...
      hour: 'numeric',
      minute: 'numeric',
      hour12: false,
    }).formatToParts(d);

    const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '0';

    // weekday short → JS day-of-week
    const WEEKDAY_MAP: Record<string, number> = {
      Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6,
    };
    const weekdayStr = get('weekday');
    const day = WEEKDAY_MAP[weekdayStr] ?? d.getUTCDay();
    let hour = Number(get('hour'));
    if (hour === 24) hour = 0; // some engines emit '24' for midnight

    return { day, hour, minute: Number(get('minute')) };
  } catch {
    // An invalid tz that somehow got persisted must degrade to UTC, not 500.
    return { day: d.getUTCDay(), hour: d.getUTCHours(), minute: d.getUTCMinutes() };
  }
}

function nextHourBoundaryInTz(from: Date, tz: string): Date {
  // Advance to the next whole-hour mark in Nicole's timezone.
  const { minute } = localFields(from, tz);
  const msToNextHour = (60 - minute) * 60_000 - from.getSeconds() * 1000 - from.getMilliseconds();
  return minute === 0 ? new Date(from.getTime() - from.getSeconds() * 1000 - from.getMilliseconds())
                      : new Date(from.getTime() + msToNextHour);
}

export function deriveAvailableSlots(booked: UpcomingSession[], oh: OfficeHours, now: Date = new Date()): BookingSlot[] {
  const slots: BookingSlot[] = [];
  const horizon = new Date(now.getTime() + oh.slot_horizon_days * 86_400_000);
  const durationMs = oh.session_duration_min * 60_000;

  // Build sorted busy list — use ends_at or derive from start + session_duration.
  const busy = booked.map((s) => ({
    start: new Date(s.starts_at).getTime(),
    end: s.ends_at ? new Date(s.ends_at).getTime() : new Date(s.starts_at).getTime() + durationMs,
  })).sort((a, b) => a.start - b.start);

  // Step by the session duration so shorter sessions yield back-to-back slots
  // (e.g. 30-min → :00, :30). Start at the next whole-hour boundary in Nicole's TZ.
  let cursor = nextHourBoundaryInTz(new Date(now.getTime() + 60_000), oh.timezone);

  while (cursor < horizon && slots.length < oh.max_slots) {
    const { day, hour } = localFields(cursor, oh.timezone);

    // Skip if the slot START is outside office days/hours. Advance by the slot
    // step; the local equivalent shifts correctly across DST because we re-derive
    // localFields each iteration.
    if (!oh.days.includes(day) || hour < oh.start_hour || hour >= oh.end_hour) {
      cursor = nextHourBoundaryInTz(new Date(cursor.getTime() + 60_000), oh.timezone);
      continue;
    }

    const slotStart = cursor.getTime();
    const slotEnd = slotStart + durationMs;

    // Reject if the slot END spills past end_hour in Nicole's TZ. A slot ending
    // exactly at end_hour:00 is allowed (end.minute === 0).
    const end = localFields(new Date(slotEnd), oh.timezone);
    if (end.hour > oh.end_hour || (end.hour === oh.end_hour && end.minute > 0)) {
      cursor = new Date(cursor.getTime() + durationMs);
      continue;
    }

    const overlap = busy.some((b) => b.start < slotEnd && b.end > slotStart);
    if (!overlap) {
      slots.push({
        starts_at: cursor.toISOString(),
        ends_at: new Date(slotEnd).toISOString(),
        label: formatSlotLabel(cursor, oh.timezone),
      });
    }

    cursor = new Date(cursor.getTime() + durationMs);
  }

  return slots;
}

/**
 * Validate that ONE specific slot is bookable right now — the booking endpoint's
 * guard against a hand-edited/stale `slot` value. Unlike deriveAvailableSlots it
 * ignores `max_slots` (a slot that dropped out of the top-N is still valid): it
 * only checks the slot is a real future time, inside office hours, and not
 * overlapping a known booked session. Pure — exported for tests.
 */
export function isSlotOfferable(
  slotIso: string,
  booked: UpcomingSession[],
  oh: OfficeHours,
  now: Date = new Date(),
): boolean {
  const start = new Date(slotIso);
  if (Number.isNaN(start.getTime()) || start.getTime() <= now.getTime()) return false;

  const durationMs = oh.session_duration_min * 60_000;
  const endMs = start.getTime() + durationMs;
  const sf = localFields(start, oh.timezone);
  const ef = localFields(new Date(endMs), oh.timezone);

  if (!oh.days.includes(sf.day)) return false;
  if (sf.hour < oh.start_hour || sf.hour >= oh.end_hour) return false;
  if (ef.hour > oh.end_hour || (ef.hour === oh.end_hour && ef.minute > 0)) return false;

  return !booked.some((b) => {
    const bStart = new Date(b.starts_at).getTime();
    const bEnd = b.ends_at ? new Date(b.ends_at).getTime() : bStart + durationMs;
    return bStart < endMs && bEnd > start.getTime();
  });
}

function formatSlotLabel(d: Date, tz: string): string {
  try {
    return new Intl.DateTimeFormat('en-GB', {
      timeZone: tz,
      weekday: 'long',
      hour: 'numeric',
      minute: '2-digit',
      hour12: true,
    }).format(d);
  } catch {
    return d.toISOString();
  }
}

function addMinutes(iso: string, min: number): string {
  return new Date(new Date(iso).getTime() + min * 60_000).toISOString();
}

// --- Route handlers ---------------------------------------------------------

appointmentsRouter.get('/upcoming', async (_req, res) => {
  try {
    const oh = await loadOfficeHours();
    const sessions = await fetchUpcoming(oh);
    // Include server-derived slots so the Schedule view shows EXACTLY what the
    // re-engagement emails offer (single source of truth — no client re-derive).
    const slots = deriveAvailableSlots(sessions, oh);
    res.json({ pb_configured: isPbConfigured(), sessions, slots, office_hours: oh });
  } catch (err) {
    logError('appointments.upcoming', 'fetch failed', err);
    res.status(500).json({ error: 'internal error' });
  }
});

appointmentsRouter.get('/slots', async (_req, res) => {
  try {
    const oh = await loadOfficeHours();
    const sessions = await fetchUpcoming(oh);
    const slots = deriveAvailableSlots(sessions, oh);
    res.json({ slots, office_hours: oh });
  } catch (err) {
    logError('appointments.slots', 'slot derivation failed', err);
    res.status(500).json({ error: 'internal error' });
  }
});

appointmentsRouter.get('/office-hours', async (_req, res) => {
  try {
    const oh = await loadOfficeHours();
    res.json(oh);
  } catch (err) {
    logError('appointments.office-hours', 'load failed', err);
    res.status(500).json({ error: 'internal error' });
  }
});

appointmentsRouter.put('/office-hours', async (req, res) => {
  const parsed = officeHoursSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'invalid payload', details: parsed.error.flatten() });
  }
  try {
    await saveOfficeHours(parsed.data);
    logEvent('info', 'appointments.office-hours', 'office hours updated', parsed.data);
    await recordAudit({ entityType: 'office_hours', entityId: 'office_hours', action: 'office_hours.updated', actor: 'nicole', summary: 'Office hours / availability updated', metadata: { ...parsed.data } });
    return res.json(parsed.data);
  } catch (err) {
    logError('appointments.office-hours', 'save failed', err);
    return res.status(500).json({ error: 'internal error' });
  }
});

appointmentsRouter.get('/services', async (_req, res) => {
  try {
    if (!isPbConfigured()) {
      return res.json({ pb_configured: false, items: [] });
    }
    const { listServices } = await import('../integrations/pb/reads');
    const svcs = await listServices();
    res.json({ pb_configured: true, items: svcs.items });
  } catch (err) {
    logError('appointments.services', 'list failed', err);
    res.status(500).json({ error: 'internal error' });
  }
});


// ---------------------------------------------------------------------------
// GET /appointments/:id/brief — the pre-session prep brief.
// ---------------------------------------------------------------------------
appointmentsRouter.get('/:id/brief', async (req, res) => {
  // No uuid check: the id may be a PB session id, which is what the Schedule view
  // holds for PB-sourced appointments. buildBrief resolves either.
  try {
    const brief = await buildBrief(req.params.id);
    return brief ? res.json(brief) : res.status(404).json({ error: 'not found' });
  } catch (err) {
    logError('appointments.brief', 'brief failed', err, { id: req.params.id });
    return res.status(500).json({ error: 'internal error' });
  }
});
