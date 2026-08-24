import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { PoolClient } from 'pg';
import { correlateConversation, recorrelateOverlappingConversations } from './correlate';

// Minimal fake PoolClient: returns canned rows so we test the decision logic
// (match / no-match / ambiguous) without a database.
function fakeDb(
  rows: Array<{ id: string; client_id: string | null; starts_at?: string; ends_at?: string; overlap_seconds?: number }>,
  updateRowCount = 0,
): PoolClient {
  return {
    query: vi.fn().mockImplementation(async (sql: string) => {
      // UPDATE calls get rowCount; SELECT calls get rows.
      if (sql.trim().toUpperCase().startsWith('UPDATE')) {
        return { rows: rows.slice(0, updateRowCount).map((r) => ({ id: r.id })), rowCount: updateRowCount };
      }
      return { rows, rowCount: rows.length };
    }),
  } as unknown as PoolClient;
}

// A candidate appointment row with default values for optional fields.
function appt(overrides: {
  id: string;
  client_id?: string | null;
  starts_at?: string;
  ends_at?: string;
  overlap_seconds?: number;
}) {
  return {
    id: overrides.id,
    client_id: overrides.client_id ?? 'c1',
    starts_at: overrides.starts_at ?? '2026-07-01T15:00:00Z',
    ends_at: overrides.ends_at ?? '2026-07-01T16:00:00Z',
    overlap_seconds: overrides.overlap_seconds ?? 3600, // 1 hr default — comfortably above any guard
  };
}

const START = '2026-07-01T15:00:00Z';
const END = '2026-07-01T16:00:00Z';

// ─── correlateConversation ────────────────────────────────────────────────────

describe('correlateConversation', () => {
  it('matches when exactly one appointment overlaps with sufficient overlap', async () => {
    const r = await correlateConversation(fakeDb([appt({ id: 'a1' })]), START, END);
    expect(r).toEqual({
      status: 'matched',
      appointmentId: 'a1',
      clientId: 'c1',
      overlapSeconds: 3600,
    });
  });

  it('returns no_candidates when nothing overlaps', async () => {
    const r = await correlateConversation(fakeDb([]), START, END);
    expect(r).toEqual({ status: 'unmatched', reason: 'no_candidates', candidateCount: 0 });
  });

  it('never auto-guesses: multiple overlaps -> ambiguous', async () => {
    const r = await correlateConversation(
      fakeDb([appt({ id: 'a1' }), appt({ id: 'a2', client_id: 'c2' })]),
      START,
      END,
    );
    expect(r).toEqual({ status: 'unmatched', reason: 'ambiguous', candidateCount: 2 });
  });

  it('passes the conversation window as the query parameters', async () => {
    let captured: unknown[] | undefined;
    const db = {
      query: vi.fn().mockImplementation(async (_sql: string, params?: unknown[]) => {
        captured = params;
        return { rows: [], rowCount: 0 };
      }),
    } as unknown as PoolClient;
    await correlateConversation(db, START, END);
    expect(captured).toEqual([START, END]);
  });

  it('blocks auto-match when recording is >1.5x appointment duration and >=35 min', async () => {
    const longStart = '2026-07-01T14:00:00Z';
    const longEnd   = '2026-07-01T17:00:00Z'; // 3 hours
    const candidate = appt({
      id: 'a1',
      starts_at: '2026-07-01T15:00:00Z',
      ends_at:   '2026-07-01T15:45:00Z', // 45 mins — 3hr recording is 4× the appointment
      overlap_seconds: 2700, // 45 min overlap
    });
    const r = await correlateConversation(fakeDb([candidate]), longStart, longEnd);
    expect(r).toEqual({ status: 'unmatched', reason: 'ambiguous', candidateCount: 1 });
  });

  // ── Gap 5: minimum overlap guard ────────────────────────────────────────────

  it('blocks auto-match when actual overlap is less than 5 min (absolute floor)', async () => {
    // Recording 20:55–21:30, appointment 19:00–20:58.
    // Overlap = 3 minutes — below the 5-minute absolute floor.
    const recStart  = '2026-07-01T20:55:00Z';
    const recEnd    = '2026-07-01T21:30:00Z';
    const candidate = appt({
      id: 'a1',
      starts_at: '2026-07-01T19:00:00Z',
      ends_at:   '2026-07-01T20:58:00Z', // 118-minute appointment
      overlap_seconds: 180, // 3 minutes — below max(300, 118*60*0.25 = 1770)
    });
    const r = await correlateConversation(fakeDb([candidate]), recStart, recEnd);
    expect(r).toEqual({ status: 'unmatched', reason: 'overlap_too_small', candidateCount: 1 });
  });

  it('blocks auto-match when overlap is less than 25% of a short appointment', async () => {
    // 30-min appointment: 25% = 7.5 min (450 s). Overlap of 360 s (6 min) should be rejected.
    // Recording is 15:24–15:50 (26 min), appointment is 15:00–15:30 (30 min).
    // Ratio = 26/30 = 0.87 — stays well below 1.5×, so only the overlap guard fires.
    const recStart  = '2026-07-01T15:24:00Z';
    const recEnd    = '2026-07-01T15:50:00Z';
    const candidate = appt({
      id: 'a1',
      starts_at: '2026-07-01T15:00:00Z',
      ends_at:   '2026-07-01T15:30:00Z', // 30-min appointment
      overlap_seconds: 360, // 6 min — below max(300, 1800*0.25 = 450)
    });
    const r = await correlateConversation(fakeDb([candidate]), recStart, recEnd);
    expect(r).toEqual({ status: 'unmatched', reason: 'overlap_too_small', candidateCount: 1 });
  });

  it('accepts a match when overlap meets the 25% threshold', async () => {
    // 30-min appointment: 25% = 7.5 min (450 s). Overlap of 480 s (8 min) should pass.
    // Recording is 15:22–15:50 (28 min). Ratio = 28/30 = 0.93 — below 1.5×.
    const recStart  = '2026-07-01T15:22:00Z';
    const recEnd    = '2026-07-01T15:50:00Z';
    const candidate = appt({
      id: 'a1',
      starts_at: '2026-07-01T15:00:00Z',
      ends_at:   '2026-07-01T15:30:00Z',
      overlap_seconds: 480, // 8 min — above max(300, 450)
    });
    const r = await correlateConversation(fakeDb([candidate]), recStart, recEnd);
    expect(r).toMatchObject({ status: 'matched', appointmentId: 'a1' });
  });
});

// ─── recorrelateOverlappingConversations ─────────────────────────────────────

describe('recorrelateOverlappingConversations', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('triggers processConversation after a successful re-match', async () => {
    // Import the actual module so we can spy on processConversation.
    const { processConversation } = await import('../session/process');
    const processSpy = vi.spyOn({ processConversation }, 'processConversation').mockResolvedValue();

    // Fake DB: first SELECT returns an unmatched conversation; correlateConversation
    // is called with the conv's window, which needs a separate mock.
    // For simplicity, wire the db.query mock to return different things per call.
    let callCount = 0;
    const db = {
      query: vi.fn().mockImplementation(async () => {
        callCount++;
        if (callCount === 1) {
          // recorrelateOverlappingConversations' initial SELECT
          return {
            rows: [{
              id: 'conv-1',
              starts_at: '2026-07-01T15:00:00Z',
              ends_at: '2026-07-01T16:00:00Z',
              appointment_id: null,
              correlation_status: 'unmatched',
            }],
            rowCount: 1,
          };
        }
        if (callCount === 2) {
          // correlateConversation's inner SELECT — returns one matching appointment
          return {
            rows: [{
              id: 'appt-1',
              client_id: 'client-1',
              starts_at: '2026-07-01T15:00:00Z',
              ends_at: '2026-07-01T16:00:00Z',
              overlap_seconds: 3600,
            }],
            rowCount: 1,
          };
        }
        // UPDATE returning a row = successfully matched
        return { rows: [{ id: 'conv-1' }], rowCount: 1 };
      }),
    } as unknown as PoolClient;

    // Module spy: patch processConversation in the module the sweep imports it from.
    const processModule = await import('../session/process');
    const spy = vi.spyOn(processModule, 'processConversation').mockResolvedValue();

    await recorrelateOverlappingConversations(db, '2026-07-01T15:00:00Z', '2026-07-01T16:00:00Z');

    // Give the void promise a tick to resolve
    await new Promise((r) => setTimeout(r, 10));

    expect(spy).toHaveBeenCalledWith('conv-1');
    spy.mockRestore();
    processSpy.mockRestore();
  });

  it('skips conversations that are already matched to the correct appointment', async () => {
    // The WHERE in recorrelateOverlappingConversations filters out matched rows:
    //   AND (appointment_id IS NULL OR correlation_status = 'unmatched')
    // Simulate this by having the initial SELECT return zero rows — the DB has
    // already excluded the matched conversation from the result set.
    const db = {
      query: vi.fn().mockResolvedValue({ rows: [], rowCount: 0 }),
    } as unknown as PoolClient;

    await recorrelateOverlappingConversations(db, '2026-07-01T15:00:00Z', '2026-07-01T16:00:00Z');
    // Only the outer SELECT fired; no correlate or UPDATE calls were needed.
    expect((db.query as ReturnType<typeof vi.fn>).mock.calls.length).toBe(1);
  });
});
