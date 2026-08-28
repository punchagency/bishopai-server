import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { pollPocketRecordings, utcDate, type PollDeps } from './poller';
import type { PocketWebhookPayload } from './types';

// The poller's DB and HTTP edges are injected, so these exercise the sweep
// logic itself: what it fetches, what it skips, and what a failure costs.

const REC = (id: string, createdAt = '2026-02-18T11:30:00.000Z') => ({ id, createdAt, duration: 1800 });

function detail(id: string, text = 'hello'): PocketWebhookPayload {
  return { recording: REC(id), transcript: [{ speaker: 'Nicole', text }] };
}

function deps(over: Partial<PollDeps> = {}): PollDeps {
  return {
    listRecordings: vi.fn(async () => ({ recordings: [REC('rec_1')], hasMore: false, page: 1, totalPages: 1 })),
    getRecording: vi.fn(async (id: string) => detail(id)),
    existingWithTranscript: vi.fn(async () => new Set<string>()),
    ingest: vi.fn(async () => ({
      conversationId: 'conv-1',
      correlation: { status: 'unmatched' as const, reason: 'no_candidates' as const, candidateCount: 0 },
    })),
    enqueue: vi.fn(),
    ...over,
  };
}

const NOW = new Date('2026-02-18T12:00:00.000Z');

beforeEach(() => {
  process.env.POCKET_API_KEY = 'pk_test';
  delete process.env.POCKET_POLL_ENABLED;
  delete process.env.POCKET_POLL_LOOKBACK_DAYS;
  delete process.env.POCKET_POLL_MAX_PAGES;
});
afterEach(() => {
  delete process.env.POCKET_API_KEY;
});

describe('pollPocketRecordings', () => {
  it('does nothing without an API key, rather than throwing', async () => {
    delete process.env.POCKET_API_KEY;
    const d = deps();
    const r = await pollPocketRecordings(d, NOW);
    expect(r.skipped).toBe('not_configured');
    expect(d.listRecordings).not.toHaveBeenCalled();
  });

  it('can be turned off explicitly while the key stays configured', async () => {
    process.env.POCKET_POLL_ENABLED = 'false';
    const r = await pollPocketRecordings(deps(), NOW);
    expect(r.skipped).toBe('disabled');
  });

  it('sweeps the lookback window in UTC dates', async () => {
    process.env.POCKET_POLL_LOOKBACK_DAYS = '3';
    const d = deps();
    await pollPocketRecordings(d, NOW);
    expect(d.listRecordings).toHaveBeenCalledWith(
      expect.objectContaining({ startDate: '2026-02-15', endDate: '2026-02-18', page: 1, limit: 100 }),
    );
  });

  it('defaults to a 30-day window, so a recording missed by the webhook stays reachable', async () => {
    // Regression: the default was 3 days. A real client session recorded on a
    // Friday and never delivered by webhook aged out of every subsequent sweep
    // and became permanently invisible — the poller is the only other path in.
    delete process.env.POCKET_POLL_LOOKBACK_DAYS;
    const d = deps();
    await pollPocketRecordings(d, NOW);
    expect(d.listRecordings).toHaveBeenCalledWith(
      expect.objectContaining({ startDate: '2026-01-19', endDate: '2026-02-18' }),
    );
  });

  it('ingests a recording it has not seen, and fires extraction when it matches', async () => {
    const d = deps({
      ingest: vi.fn(async () => ({
        conversationId: 'conv-9',
        correlation: {
          status: 'matched' as const,
          appointmentId: 'appt-1',
          clientId: 'client-1',
          overlapSeconds: 1800,
        },
      })),
    });
    const r = await pollPocketRecordings(d, NOW);

    expect(d.ingest).toHaveBeenCalledWith(
      expect.objectContaining({ source_id: 'rec_1', source: 'pocket', transcript: 'Nicole: hello' }),
    );
    // Queued, not extracted inline: the sweep must not hold itself open for
    // however long N sessions take to read, nor run an extractor alongside the
    // drain's.
    expect(d.enqueue).toHaveBeenCalledWith('conv-9');
    expect(r).toMatchObject({ scanned: 1, fetched: 1, ingested: 1, matched: 1, failed: 0 });
  });

  it('does not fire extraction for an unmatched recording', async () => {
    const d = deps();
    const r = await pollPocketRecordings(d, NOW);
    expect(d.enqueue).not.toHaveBeenCalled();
    expect(r.matched).toBe(0);
  });

  it('skips the detail fetch for recordings whose transcript we already hold', async () => {
    // This is what keeps the backstop cheap when the webhook is working.
    const d = deps({ existingWithTranscript: vi.fn(async () => new Set(['rec_1'])) });
    const r = await pollPocketRecordings(d, NOW);
    expect(d.getRecording).not.toHaveBeenCalled();
    expect(r).toMatchObject({ scanned: 1, fetched: 0, ingested: 0 });
  });

  it('pages until has_more clears', async () => {
    const listRecordings = vi
      .fn()
      .mockResolvedValueOnce({ recordings: [REC('rec_1')], hasMore: true, page: 1, totalPages: 2 })
      .mockResolvedValueOnce({ recordings: [REC('rec_2')], hasMore: false, page: 2, totalPages: 2 });
    const d = deps({ listRecordings });
    const r = await pollPocketRecordings(d, NOW);
    expect(listRecordings).toHaveBeenCalledTimes(2);
    expect(r.scanned).toBe(2);
  });

  it('stops at the page cap so a stuck has_more cannot loop forever', async () => {
    process.env.POCKET_POLL_MAX_PAGES = '3';
    const listRecordings = vi.fn(async () => ({ recordings: [REC('rec_x')], hasMore: true, page: 1, totalPages: 99 }));
    const d = deps({ listRecordings });
    await pollPocketRecordings(d, NOW);
    expect(listRecordings).toHaveBeenCalledTimes(3);
  });

  it('counts an unplaceable recording without ingesting a half-built row', async () => {
    const d = deps({ getRecording: vi.fn(async () => ({ recording: { id: 'rec_1' } })) }); // no time window
    const r = await pollPocketRecordings(d, NOW);
    expect(d.ingest).not.toHaveBeenCalled();
    expect(r).toMatchObject({ fetched: 1, unusable: 1, ingested: 0 });
  });

  it('keeps sweeping after one recording fails', async () => {
    const listRecordings = vi.fn(async () => ({
      recordings: [REC('rec_bad'), REC('rec_good')],
      hasMore: false,
      page: 1,
      totalPages: 1,
    }));
    const getRecording = vi.fn(async (id: string) => {
      if (id === 'rec_bad') throw new Error('boom');
      return detail(id);
    });
    const d = deps({ listRecordings, getRecording });
    const r = await pollPocketRecordings(d, NOW);

    expect(r).toMatchObject({ scanned: 2, failed: 1, ingested: 1 });
    expect(d.ingest).toHaveBeenCalledWith(expect.objectContaining({ source_id: 'rec_good' }));
  });
});

describe('utcDate', () => {
  it('formats as YYYY-MM-DD in UTC, not local time', () => {
    // Pocket reads start_date as UTC midnight; a local-time date would shift the
    // window by a day for anyone west of Greenwich.
    expect(utcDate(new Date('2026-02-18T23:30:00.000Z'))).toBe('2026-02-18');
    expect(utcDate(new Date('2026-02-19T00:30:00.000Z'))).toBe('2026-02-19');
  });
});
