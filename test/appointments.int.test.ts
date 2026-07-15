import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll, vi } from 'vitest';
import { pool } from '../src/db/pool';
import { deriveAvailableSlots, isSlotOfferable, type OfficeHours, type UpcomingSession } from '../src/routes/appointments';

const mockListSessions = vi.fn();
const mockCreateClientRecord = vi.fn();
const mockListServices = vi.fn();
const mockCreateSession = vi.fn();

vi.mock('../src/integrations/pb/reads', () => ({
  listSessions: (...args: any[]) => mockListSessions(...args),
  createClientRecord: (...args: any[]) => mockCreateClientRecord(...args),
  listServices: (...args: any[]) => mockListServices(...args),
  createSession: (...args: any[]) => mockCreateSession(...args),
}));


// Integration + unit tests for the appointments / schedule feature.
// - deriveAvailableSlots is a pure function — fully unit-testable with no DB.
// - The HTTP endpoint is tested via the real Express app mounted on an
//   ephemeral port (same pattern as routes.integration.test.ts).

let dbUp = true;
try {
  await pool.query('SELECT 1');
} catch {
  dbUp = false;
}

// Default OfficeHours used for unit tests (UTC avoids any server-TZ surprises)
const OH: OfficeHours = {
  timezone: 'UTC',
  days: [1, 2, 3, 4, 5],    // Mon–Fri
  start_hour: 9,
  end_hour: 17,
  session_duration_min: 60,
  slot_horizon_days: 7,
  max_slots: 3,
};

// 2026-07-13 is a Monday — use UTC 09:00 so timezone 'UTC' gives us hour=9.
const MON_9AM_UTC = new Date('2026-07-13T09:00:00.000Z');

// ---------------------------------------------------------------------------
// Unit tests for deriveAvailableSlots — no DB needed
// ---------------------------------------------------------------------------

describe('isSlotOfferable (unit)', () => {
  const monday10 = '2026-07-13T10:00:00.000Z'; // Mon 10:00 UTC, inside 9–17

  it('accepts a valid free slot inside office hours', () => {
    expect(isSlotOfferable(monday10, [], OH, MON_9AM_UTC)).toBe(true);
  });

  it('rejects an invalid / non-date slot', () => {
    expect(isSlotOfferable('not-a-date', [], OH, MON_9AM_UTC)).toBe(false);
  });

  it('rejects a slot in the past', () => {
    expect(isSlotOfferable('2026-07-13T08:00:00.000Z', [], OH, new Date('2026-07-13T12:00:00.000Z'))).toBe(false);
  });

  it('rejects a slot outside office hours (before start_hour)', () => {
    expect(isSlotOfferable('2026-07-13T07:00:00.000Z', [], OH, MON_9AM_UTC)).toBe(false);
  });

  it('rejects a slot whose end spills past end_hour', () => {
    // 16:30 + 60min = 17:30 > 17:00 end
    expect(isSlotOfferable('2026-07-13T16:30:00.000Z', [], OH, MON_9AM_UTC)).toBe(false);
  });

  it('rejects a slot on a non-office day (weekend)', () => {
    expect(isSlotOfferable('2026-07-11T10:00:00.000Z', [], OH, MON_9AM_UTC)).toBe(false); // Saturday
  });

  it('rejects a slot overlapping a booked session', () => {
    const booked: UpcomingSession[] = [{
      id: 'a', pb_id: null, client_name: null,
      starts_at: '2026-07-13T10:30:00.000Z', ends_at: '2026-07-13T11:30:00.000Z',
      status: 'confirmed', service_type: null, source: 'local',
    }];
    expect(isSlotOfferable(monday10, booked, OH, MON_9AM_UTC)).toBe(false);
  });

  it('ignores max_slots (a slot past the top-N is still valid)', () => {
    // A slot late in the day the derive list (max_slots 3) would not include.
    expect(isSlotOfferable('2026-07-13T15:00:00.000Z', [], OH, MON_9AM_UTC)).toBe(true);
  });
});

describe('deriveAvailableSlots (unit)', () => {
  it('returns up to max_slots slots on a free day', () => {
    const slots = deriveAvailableSlots([], OH, MON_9AM_UTC);
    expect(slots.length).toBeGreaterThan(0);
    expect(slots.length).toBeLessThanOrEqual(OH.max_slots);
  });

  it('excludes times occupied by a booked session', () => {
    const booked: UpcomingSession[] = [{
      id: 'a', pb_id: null, client_name: 'Test',
      starts_at: '2026-07-13T10:00:00.000Z',
      ends_at:   '2026-07-13T11:00:00.000Z',
      status: 'confirmed', service_type: null, source: 'local',
    }];
    const slots = deriveAvailableSlots(booked, OH, MON_9AM_UTC);
    const occupied = slots.some(
      (s) => new Date(s.starts_at).getTime() === new Date('2026-07-13T10:00:00.000Z').getTime(),
    );
    expect(occupied).toBe(false);
  });

  it('does not return slots that overlap any booked session', () => {
    // Block UTC 09–17 on Monday
    const booked: UpcomingSession[] = Array.from({ length: 8 }, (_, i) => ({
      id: String(i), pb_id: null, client_name: null,
      starts_at: new Date(Date.UTC(2026, 6, 13, 9 + i, 0, 0)).toISOString(),
      ends_at:   new Date(Date.UTC(2026, 6, 13, 10 + i, 0, 0)).toISOString(),
      status: 'confirmed', service_type: null, source: 'local' as const,
    }));
    const slots = deriveAvailableSlots(booked, OH, MON_9AM_UTC);
    for (const slot of slots) {
      const sStart = new Date(slot.starts_at).getTime();
      const sEnd   = new Date(slot.ends_at).getTime();
      const overlaps = booked.some((b) => {
        const bStart = new Date(b.starts_at).getTime();
        const bEnd   = new Date(b.ends_at!).getTime();
        return bStart < sEnd && bEnd > sStart;
      });
      expect(overlaps).toBe(false);
    }
  });

  it('slot starts_at is always after now', () => {
    const slots = deriveAvailableSlots([], OH, MON_9AM_UTC);
    for (const s of slots) {
      expect(new Date(s.starts_at).getTime()).toBeGreaterThan(MON_9AM_UTC.getTime());
    }
  });

  it('each slot has a non-empty label', () => {
    const slots = deriveAvailableSlots([], OH, MON_9AM_UTC);
    for (const s of slots) {
      expect(typeof s.label).toBe('string');
      expect(s.label.length).toBeGreaterThan(0);
    }
  });

  it('respects custom session_duration_min — 90-min slots do not exceed end_hour', () => {
    const oh90: OfficeHours = { ...OH, session_duration_min: 90, max_slots: 10 };
    const slots = deriveAvailableSlots([], oh90, MON_9AM_UTC);
    for (const s of slots) {
      const endHour = new Date(s.ends_at).getUTCHours();
      expect(endHour).toBeLessThanOrEqual(OH.end_hour);
    }
  });

  it('skips weekends when days = [1,2,3,4,5]', () => {
    // Start from a Saturday (UTC)
    const SAT = new Date('2026-07-11T09:00:00.000Z'); // Saturday
    const slots = deriveAvailableSlots([], OH, SAT);
    // All returned slots should fall on Mon–Fri
    const WEEKDAY_MAP: Record<number, boolean> = { 1: true, 2: true, 3: true, 4: true, 5: true };
    for (const s of slots) {
      const day = new Date(s.starts_at).getUTCDay();
      expect(WEEKDAY_MAP[day]).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// Integration test — GET /appointments/upcoming via real DB (skipped without DB)
// ---------------------------------------------------------------------------

import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApp } from '../src/app';

describe.skipIf(!dbUp)('appointments route (integration)', () => {
  let server: http.Server;
  let base = '';

  beforeAll(async () => {
    await pool.query('INSERT INTO auth_config (id, enabled) VALUES (true, false) ON CONFLICT DO NOTHING');
    server = http.createServer(createApp());
    await new Promise<void>((r) => server.listen(0, r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  const get = (path: string) => fetch(`${base}${path}`);

  it('GET /appointments/upcoming returns sessions + office_hours', async () => {
    const res = await get('/appointments/upcoming');
    expect(res.status).toBe(200);
    const body = await res.json() as { pb_configured: boolean; sessions: unknown[]; slots: unknown[]; office_hours: OfficeHours };
    expect(typeof body.pb_configured).toBe('boolean');
    expect(Array.isArray(body.sessions)).toBe(true);
    expect(Array.isArray(body.slots)).toBe(true); // server-derived, shared with emails
    expect(typeof body.office_hours.timezone).toBe('string');
    expect(Array.isArray(body.office_hours.days)).toBe(true);
  });

  it('GET /appointments/slots returns slots array', async () => {
    const res = await get('/appointments/slots');
    expect(res.status).toBe(200);
    const body = await res.json() as { slots: unknown[]; office_hours: OfficeHours };
    expect(Array.isArray(body.slots)).toBe(true);
  });

  it('GET /appointments/office-hours returns the configured office hours', async () => {
    const res = await get('/appointments/office-hours');
    expect(res.status).toBe(200);
    const oh = await res.json() as OfficeHours;
    expect(typeof oh.timezone).toBe('string');
    expect(typeof oh.start_hour).toBe('number');
    expect(typeof oh.end_hour).toBe('number');
  });

  it('PUT /appointments/office-hours saves and returns updated config', async () => {
    const payload: OfficeHours = {
      timezone: 'Europe/London', days: [1, 2, 3], start_hour: 8, end_hour: 16,
      session_duration_min: 45, slot_horizon_days: 5, max_slots: 2,
    };
    const res = await fetch(`${base}/appointments/office-hours`, {
      method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload),
    });
    expect(res.status).toBe(200);
    const saved = await res.json() as OfficeHours;
    expect(saved.start_hour).toBe(8);
    expect(saved.session_duration_min).toBe(45);
    expect(saved.days).toEqual([1, 2, 3]);
  });

  const putOfficeHours = (over: Partial<OfficeHours>) =>
    fetch(`${base}/appointments/office-hours`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        timezone: 'Europe/London', days: [1, 2, 3, 4, 5], start_hour: 9, end_hour: 17,
        session_duration_min: 60, slot_horizon_days: 7, max_slots: 3, ...over,
      }),
    });

  it('PUT /appointments/office-hours rejects start_hour >= end_hour', async () => {
    const res = await putOfficeHours({ start_hour: 17, end_hour: 9 });
    expect(res.status).toBe(400);
  });

  it('PUT /appointments/office-hours rejects an invalid timezone', async () => {
    const res = await putOfficeHours({ timezone: 'Not/AReal_Zone' });
    expect(res.status).toBe(400);
  });

  describe('Public Booking Endpoints', () => {
    const testLeadId = 'c0000000-0000-0000-0000-000000000001';

    /**
     * Derived, never pinned. This was a literal ISO date, which passed until the day
     * that date fell into the past — then every booking test started failing on a
     * correct 409 (the slot guard refuses to book history). Compute the next weekday
     * at 10:00 UTC, which sits inside the default 09:00–17:00 Europe/London hours.
     */
    const nextWeekdaySlot = (): string => {
      const d = new Date();
      d.setUTCDate(d.getUTCDate() + 1);
      d.setUTCHours(10, 0, 0, 0);
      while (d.getUTCDay() === 0 || d.getUTCDay() === 6) d.setUTCDate(d.getUTCDate() + 1);
      return d.toISOString();
    };
    const testSlot = nextWeekdaySlot();

    /**
     * Booking a lead provisions a client + an appointment. Both must go, and the
     * appointment must go FIRST: appointments.client_id is ON DELETE SET NULL, so
     * deleting the client on its own strands the appointment as an orphan that the
     * cockpit renders as an "(unknown)" session. Matching on client_id (rather than a
     * pb_id prefix) also catches appointments whose id pattern we don't control.
     */
    const clearBookingFixtures = async (): Promise<void> => {
      await pool.query(
        `DELETE FROM appointments
          WHERE pb_id LIKE 'pb-session-%'
             OR pb_id LIKE 'dry-session-%'
             OR client_id IN (SELECT id FROM clients WHERE email = 'test-lead@example.com')`,
      );
      await pool.query(`DELETE FROM lead_activity WHERE lead_id = $1`, [testLeadId]);
      await pool.query(`DELETE FROM leads WHERE id = $1`, [testLeadId]);
      await pool.query(`DELETE FROM clients WHERE email = 'test-lead@example.com'`);
    };

    beforeEach(async () => {
      mockListSessions.mockReset().mockResolvedValue({ items: [] });
      mockCreateClientRecord.mockReset();
      mockListServices.mockReset();
      mockCreateSession.mockReset();

      await clearBookingFixtures();
    });

    // Also AFTER the last test: a beforeEach-only cleanup always leaves the final
    // run's fixtures behind, which is how the stray 'Lead Inquiry' client and its
    // "(unknown)" session kept reappearing in the cockpit.
    afterAll(clearBookingFixtures);

    it('GET /webhooks/appointments/book returns 400 for non-existent lead', async () => {
      const res = await fetch(`${base}/webhooks/appointments/book?leadId=${testLeadId}&slot=${testSlot}`);
      expect(res.status).toBe(400);
      const text = await res.text();
      expect(text).toContain('Link Expired');
    });

    it('GET /webhooks/appointments/book rejects a hostile / non-date slot without reflecting it', async () => {
      await pool.query(
        `INSERT INTO leads (id, source, email, status) VALUES ($1, 'website', 'test-lead@example.com', 'new')`,
        [testLeadId]
      );
      const hostile = '"><script>alert(1)</script>';
      const res = await fetch(`${base}/webhooks/appointments/book?leadId=${testLeadId}&slot=${encodeURIComponent(hostile)}`);
      expect(res.status).toBe(400);
      const text = await res.text();
      expect(text).not.toContain('<script>alert(1)'); // payload must not be reflected
    });

    it('GET /webhooks/appointments/book renders confirmation page for active lead', async () => {
      await pool.query(
        `INSERT INTO leads (id, source, email, status) VALUES ($1, 'website', 'test-lead@example.com', 'new')`,
        [testLeadId]
      );
      const res = await fetch(`${base}/webhooks/appointments/book?leadId=${testLeadId}&slot=${testSlot}`);
      expect(res.status).toBe(200);
      const text = await res.text();
      expect(text).toContain('Confirm Appointment');
      expect(text).toContain(testLeadId);
      expect(text).toContain(testSlot);
    });

    afterEach(() => {
      delete process.env.PB_CLIENT_ID;
      delete process.env.PB_CLIENT_SECRET;
    });

    it('POST /webhooks/appointments/book books the session, creates client in PB + local, updates lead status', async () => {
      process.env.PB_CLIENT_ID = 'test-id';
      process.env.PB_CLIENT_SECRET = 'test-secret';
      // Setup active lead and activity with name
      await pool.query(
        `INSERT INTO leads (id, source, email, status) VALUES ($1, 'website', 'test-lead@example.com', 'new')`,
        [testLeadId]
      );
      await pool.query(
        `INSERT INTO lead_activity (lead_id, type, detail) VALUES ($1, 'form_submit', 'name: James Bond')`,
        [testLeadId]
      );

      // Mock PB responses
      mockCreateClientRecord.mockResolvedValue({ id: 'pb-client-james' });
      mockListServices.mockResolvedValue({
        items: [{ id: 'pb-service-consult', name: 'Consultation', duration: 45, serviceTypes: ['virtual'] }]
      });
      mockCreateSession.mockResolvedValue({ id: 'pb-session-james' });

      // Request booking
      const res = await fetch(`${base}/webhooks/appointments/book`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ leadId: testLeadId, slot: testSlot }),
      });

      expect(res.status).toBe(200);
      const text = await res.text();
      expect(text).toContain('Booking Confirmed!');

      // Check lead is marked booked
      const leadCheck = await pool.query(`SELECT status FROM leads WHERE id = $1`, [testLeadId]);
      expect(leadCheck.rows[0].status).toBe('booked');

      // Check local client created
      const clientCheck = await pool.query(`SELECT * FROM clients WHERE email = 'test-lead@example.com'`);
      expect(clientCheck.rowCount).toBe(1);
      expect(clientCheck.rows[0].pb_id).toBe('pb-client-james');
      expect(clientCheck.rows[0].name).toBe('James Bond');

      // Check local appointment created
      const apptCheck = await pool.query(`SELECT * FROM appointments WHERE pb_id = 'pb-session-james'`);
      expect(apptCheck.rowCount).toBe(1);
      expect(new Date(apptCheck.rows[0].starts_at).toISOString()).toBe(testSlot);
      expect(apptCheck.rows[0].status).toBe('confirmed');
    });

    it('POST books locally with a dry-run id when PB is not configured', async () => {
      // No PB creds set → dry-run path (no PB calls).
      await pool.query(
        `INSERT INTO leads (id, source, email, status) VALUES ($1, 'website', 'test-lead@example.com', 'new')`,
        [testLeadId]
      );

      const res = await fetch(`${base}/webhooks/appointments/book`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ leadId: testLeadId, slot: testSlot }),
      });

      expect(res.status).toBe(200);
      expect(await res.text()).toContain('Booking Confirmed!');

      // No PB calls happened.
      expect(mockCreateSession).not.toHaveBeenCalled();
      expect(mockCreateClientRecord).not.toHaveBeenCalled();

      // Lead booked + a local appointment recorded with a synthetic id.
      const leadCheck = await pool.query(`SELECT status FROM leads WHERE id = $1`, [testLeadId]);
      expect(leadCheck.rows[0].status).toBe('booked');
      const apptCheck = await pool.query(
        `SELECT pb_id FROM appointments WHERE pb_id LIKE 'dry-session-%' ORDER BY created_at DESC LIMIT 1`,
      );
      expect(apptCheck.rowCount).toBe(1);
    });
  });
});
