import { ingestConversation, type ConversationInput, type IngestResult } from '../../conversations/ingest';
import { existingWithTranscript } from '../../conversations/known';
import { processConversation } from '../../session/process';
import { logError, logEvent, logWarn } from '../../observability/logger';
import { getRecording, listRecordings } from './client';
import { isPocketConfigured, pocketPollConfig } from './config';
import { toConversationInput } from './normalize';
import type { PocketRecording } from './types';

// The polling backstop.
//
// Webhooks are the fast path, but they are also the fragile one: they need a
// destination configured in Pocket's app, a publicly reachable backend, and a
// delivery that actually lands within its 3 retries. This sweep is what makes a
// missed delivery a latency problem instead of a lost session — it re-reads the
// last few days from Pocket and ingests anything we don't already hold.
//
// Ingest is idempotent on (source, source_id), so overlapping a webhook is
// harmless: the upsert refreshes the transcript and leaves an existing
// appointment assignment (possibly one Nicole made by hand) untouched.

export interface PollResult {
  skipped?: 'not_configured' | 'disabled';
  scanned: number;
  fetched: number;
  ingested: number;
  matched: number;
  unusable: number;
  failed: number;
}

export interface PollDeps {
  listRecordings: typeof listRecordings;
  getRecording: typeof getRecording;
  existingWithTranscript: typeof existingWithTranscript;
  ingest: (input: ConversationInput) => Promise<IngestResult>;
  process: (conversationId: string) => Promise<unknown>;
}

const defaultDeps: PollDeps = {
  listRecordings,
  getRecording,
  existingWithTranscript,
  ingest: ingestConversation,
  process: processConversation,
};

/** `YYYY-MM-DD` in UTC — the format Pocket's date filters expect. */
export function utcDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export async function pollPocketRecordings(
  overrides: Partial<PollDeps> = {},
  now: Date = new Date(),
): Promise<PollResult> {
  const deps = { ...defaultDeps, ...overrides };
  const empty: PollResult = { scanned: 0, fetched: 0, ingested: 0, matched: 0, unusable: 0, failed: 0 };

  if (!isPocketConfigured()) return { ...empty, skipped: 'not_configured' };
  const cfg = pocketPollConfig();
  if (!cfg.enabled) return { ...empty, skipped: 'disabled' };

  const startDate = utcDate(new Date(now.getTime() - cfg.lookbackDays * 86_400_000));
  const endDate = utcDate(now);

  // Page the window first, then decide what to fetch. Listing is cheap; detail
  // is one request per recording, so the skip check below is what keeps a sweep
  // over a busy few days from costing dozens of calls every tick.
  const recordings: PocketRecording[] = [];
  for (let page = 1; page <= cfg.maxPages; page++) {
    const res = await deps.listRecordings({ startDate, endDate, page, limit: 100 });
    recordings.push(...res.recordings);
    if (!res.hasMore || res.recordings.length === 0) break;
    if (page === cfg.maxPages) {
      logWarn('pocket.poll', 'hit the page cap; older recordings in this window were not scanned', {
        max_pages: cfg.maxPages,
        start_date: startDate,
      });
    }
  }

  const result: PollResult = { ...empty, scanned: recordings.length };

  const ids = recordings.map((r) => (typeof r.id === 'string' ? r.id.trim() : '')).filter(Boolean);
  const known = await deps.existingWithTranscript(ids);

  for (const id of ids) {
    if (known.has(id)) continue;
    try {
      result.fetched++;
      const payload = await deps.getRecording(id);
      const input = toConversationInput(payload);
      if (!input) {
        // Nothing to retry: without an id or a time window this recording can't
        // be placed, and it'll be reconsidered on the next sweep if Pocket
        // fills the fields in.
        result.unusable++;
        continue;
      }

      const { conversationId, correlation } = await deps.ingest(input);
      result.ingested++;
      if (correlation.status === 'matched') {
        result.matched++;
        await deps.process(conversationId).catch((err) =>
          logError('session.process', 'processing failed', err, { conversation_id: conversationId }),
        );
      }
    } catch (err) {
      // One unreadable recording must not abandon the rest of the sweep — the
      // whole point of the backstop is that it keeps making progress.
      result.failed++;
      await logError('pocket.poll', 'recording ingest failed', err, { recording_id: id });
    }
  }

  logEvent('info', 'pocket.poll', 'sweep complete', { ...result, start_date: startDate, end_date: endDate });
  return result;
}
