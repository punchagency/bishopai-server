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

  it('never auto-guesses: two bookings at the same time are too close to call', async () => {
    const r = await correlateConversation(
      fakeDb([appt({ id: 'a1' }), appt({ id: 'a2', client_id: 'c2' })]),
      START,
      END,
    );
    // Both start at 15:00, so neither is nearer — margin 0, well under the 15-min
    // floor. Same abstention the overlap rule made, reached on the real reason.
    expect(r).toEqual({ status: 'unmatched', reason: 'margin_too_tight', candidateCount: 2 });
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

  // ── Start-distance and margin guards ────────────────────────────────────────

  it('blocks auto-match when the nearest booking starts too long ago', async () => {
    // Recording 20:55–21:30, appointment 19:00–20:58 — they overlap by 3 minutes,
    // but the recording starts 115 minutes after the booking did. No clinic runs
    // that far behind; this is a different session that happens to touch the slot.
    const recStart  = '2026-07-01T20:55:00Z';
    const recEnd    = '2026-07-01T21:30:00Z';
    const candidate = appt({
      id: 'a1',
      starts_at: '2026-07-01T19:00:00Z',
      ends_at:   '2026-07-01T20:58:00Z', // 118-minute appointment
      overlap_seconds: 180,
    });
    const r = await correlateConversation(fakeDb([candidate]), recStart, recEnd);
    expect(r).toEqual({ status: 'unmatched', reason: 'start_too_far', candidateCount: 0 });
  });

  it('matches a late-running session that barely overlaps its own booking', async () => {
    // Recording 15:24–15:50 (26 min) against a 15:00–15:30 booking: 6 minutes of
    // overlap, which the old 25%-of-appointment floor rejected outright.
    //
    // The corpus says that rejection was wrong. This is the shape of a clinic
    // running behind — Devin Brooks (+31 min, 26 min recording, 30 min booking)
    // and Nell-Rose Foreman (+43 min) look exactly like this, overlap their true
    // booking by zero seconds, and are still the right answer. With nothing else
    // within three hours, 24 minutes late is a late start, not a different client.
    const recStart  = '2026-07-01T15:24:00Z';
    const recEnd    = '2026-07-01T15:50:00Z';
    const candidate = appt({
      id: 'a1',
      starts_at: '2026-07-01T15:00:00Z',
      ends_at:   '2026-07-01T15:30:00Z',
      overlap_seconds: 360,
    });
    const r = await correlateConversation(fakeDb([candidate]), recStart, recEnd);
    expect(r).toMatchObject({ status: 'matched', appointmentId: 'a1' });
  });

  it('accepts a match that starts close to its booking', async () => {
    // Recording 15:22–15:50 (28 min) against a 15:00–15:30 booking — 22 minutes
    // late, ratio 0.93, nothing else nearby.
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

  // ── The case overlap arithmetic could never reach ────────────────────────────

  it('matches a late-running session with ZERO overlap of its own booking', async () => {
    // Steve Broderick, from the corpus: booked 15:00–15:30, recorder ran
    // 15:35–16:09. The two windows do not intersect at all, so the old
    // range-overlap query returned no rows and the recording came back
    // `no_candidates` — not merely unmatched, but invisible. Start distance is
    // 35 minutes, which is an ordinary amount for a clinic running behind.
    const recStart  = '2026-07-01T15:35:00Z';
    const recEnd    = '2026-07-01T16:09:00Z';
    const candidate = appt({
      id: 'a1',
      starts_at: '2026-07-01T15:00:00Z',
      ends_at:   '2026-07-01T15:30:00Z',
      overlap_seconds: 0,
    });
    const r = await correlateConversation(fakeDb([candidate]), recStart, recEnd);
    expect(r).toEqual({
      status: 'matched',
      appointmentId: 'a1',
      clientId: 'c1',
      overlapSeconds: 0, // reported honestly; it no longer decides anything
    });
  });

  it('picks the nearer booking when one clearly wins on start distance', async () => {
    // 15:32 recording against 15:30 and 16:30 bookings: 2 minutes vs 58, a
    // 56-minute margin. The old rule would have abstained the moment both
    // appointments overlapped the window.
    const near = appt({
      id: 'near',
      starts_at: '2026-07-01T15:30:00Z',
      ends_at:   '2026-07-01T16:00:00Z',
      overlap_seconds: 1680,
    });
    const far = appt({
      id: 'far',
      client_id: 'c2',
      starts_at: '2026-07-01T16:30:00Z',
      ends_at:   '2026-07-01T17:00:00Z',
      overlap_seconds: 0,
    });
    const r = await correlateConversation(
      fakeDb([near, far]),
      '2026-07-01T15:32:00Z',
      '2026-07-01T16:00:00Z',
    );
    expect(r).toMatchObject({ status: 'matched', appointmentId: 'near', clientId: 'c1' });
  });

  it('refuses a sub-minute recording before querying at all', async () => {
    // A 0-minute artefact is not a consultation. Checked first so a stub cannot
    // consume a real booking, and cheaply enough to skip the query entirely.
    const db = fakeDb([appt({ id: 'a1' })]);
    const r = await correlateConversation(db, START, '2026-07-01T15:00:30Z');
    expect(r).toEqual({ status: 'unmatched', reason: 'recording_too_short', candidateCount: 0 });
    expect(db.query).not.toHaveBeenCalled();
  });
});

// ─── recorrelateOverlappingConversations ─────────────────────────────────────

describe('recorrelateOverlappingConversations', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('never re-correlates a split parent', async () => {
    // A split parent keeps correlation_status 'unmatched' forever: its content
    // now lives in its children, each attached to a client by a human. Matching
    // the parent would file the same consultation a second time, under whichever
    // booking the parent's window happened to sit near.
    //
    // The old overlap rule made this safe by accident — a parent's own
    // appointments are already taken by its children, and nothing else
    // overlapped, so it returned no_candidates. Start-proximity ranking reaches
    // a neighbouring booking happily, so the exclusion has to be explicit.
    //
    // Asserted against the SQL because the guard IS the query: a fake client
    // returns whatever rows it is given regardless of the WHERE clause.
    let selectSql = '';
    const db = {
      query: vi.fn().mockImplementation(async (sql: string) => {
        if (!selectSql) selectSql = sql;
        return { rows: [], rowCount: 0 };
      }),
    } as unknown as PoolClient;

    await recorrelateOverlappingConversations(db, START, END);

    const normalised = selectSql.replace(/\s+/g, ' ');
    expect(normalised).toContain('parent_conversation_id IS NULL');
    // Structural guard: catches a half-written split (children exist, parent
    // status update never ran) as well as any row predating migration 0038.
    expect(normalised).toMatch(
      /NOT EXISTS \( SELECT 1 FROM conversations child WHERE child\.parent_conversation_id = conversations\.id \)/,
    );
    // Status guard: a split parent has appointment_id NULL, so without this it
    // slips through the `appointment_id IS NULL` branch and becomes matchable.
    expect(normalised).toContain("correlation_status <> 'split'");
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
