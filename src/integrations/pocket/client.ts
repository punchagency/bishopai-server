import { fetchJson } from '../http';
import { pocketConfig } from './config';
import { fromRestData, fromRestList } from './normalize';
import type { PocketEnvelope, PocketRecording, PocketWebhookPayload } from './types';

// Pocket Public API client.
//
//   base    https://public.heypocketai.com/api/v1
//   auth    Authorization: Bearer pk_…
//   paths   note the doubled segment — the documented paths are `/public/…`
//           UNDER the `/api/v1` base, i.e. …/api/v1/public/recordings. That
//           looks like a typo and isn't; don't "fix" it.

export interface ListRecordingsParams {
  /** YYYY-MM-DD, interpreted by Pocket as UTC midnight. */
  startDate?: string;
  /** YYYY-MM-DD, interpreted by Pocket as UTC 23:59:59. */
  endDate?: string;
  tagIds?: string[];
  page?: number;
  /** Pocket caps this at 100. */
  limit?: number;
}

export interface ListRecordingsResult {
  recordings: PocketRecording[];
  hasMore: boolean;
  page: number;
  totalPages: number;
}

export interface SearchParams {
  query: string;
  /** Pocket accepts 1–20; defaults to 8. */
  limit?: number;
  filters?: Record<string, unknown>;
}

function authHeaders(): Record<string, string> {
  return {
    authorization: `Bearer ${pocketConfig().apiKey}`,
    accept: 'application/json',
  };
}

function url(path: string, query?: Record<string, string | number | undefined>): string {
  const u = new URL(`${pocketConfig().baseUrl}${path}`);
  for (const [k, v] of Object.entries(query ?? {})) {
    if (v !== undefined && v !== '') u.searchParams.set(k, String(v));
  }
  return u.toString();
}

/** One page of recordings, newest-first as Pocket returns them. */
export async function listRecordings(params: ListRecordingsParams = {}): Promise<ListRecordingsResult> {
  const limit = Math.min(Math.max(params.limit ?? 100, 1), 100);
  const env = await fetchJson<PocketEnvelope>(
    url('/public/recordings', {
      start_date: params.startDate,
      end_date: params.endDate,
      tag_ids: params.tagIds?.length ? params.tagIds.join(',') : undefined,
      page: params.page ?? 1,
      limit,
    }),
    { headers: authHeaders() },
  );

  const page = env.pagination?.page ?? params.page ?? 1;
  const totalPages = env.pagination?.total_pages ?? 1;
  return {
    recordings: fromRestList(env.data),
    // Trust has_more when Pocket sends it; otherwise fall back to the page
    // counter. Getting this wrong in the optimistic direction loops forever,
    // so the caller also bounds its own page count.
    hasMore: env.pagination?.has_more ?? page < totalPages,
    page,
    totalPages,
  };
}

/**
 * One recording with its transcript.
 *
 * Summarizations are skipped by default — we run our own clinical extraction
 * over the verbatim transcript, and Pocket's generic meeting summary is not
 * something that should ever reach a client's chart.
 */
export async function getRecording(
  id: string,
  opts: { includeTranscript?: boolean; includeSummarizations?: boolean } = {},
): Promise<PocketWebhookPayload> {
  const env = await fetchJson<PocketEnvelope>(
    url(`/public/recordings/${encodeURIComponent(id)}`, {
      include_transcript: String(opts.includeTranscript ?? true),
      include_summarizations: String(opts.includeSummarizations ?? false),
    }),
    { headers: authHeaders() },
  );
  const payload = fromRestData(env.data);
  // The detail body may omit the id it was fetched by; we know it either way,
  // and ingest deduplicates on it.
  if (payload.recording && !payload.recording.id) payload.recording.id = id;
  return payload;
}

/** Semantic search across transcripts, summaries and action items. */
export async function searchRecordings(params: SearchParams): Promise<PocketEnvelope> {
  return fetchJson<PocketEnvelope>(url('/public/search'), {
    method: 'POST',
    headers: { ...authHeaders(), 'content-type': 'application/json' },
    body: JSON.stringify({
      query: params.query,
      limit: Math.min(Math.max(params.limit ?? 8, 1), 20),
      ...(params.filters ? { filters: params.filters } : {}),
    }),
  });
}

/**
 * A short-lived link to the recording's audio.
 *
 * Not used by the pipeline — transcripts are what drive extraction — but it's
 * what Nicole would need to listen back to a session she's reviewing, so the
 * client exposes it rather than making the next person rediscover the endpoint.
 */
export async function getAudioDownloadUrl(id: string): Promise<string | null> {
  const env = await fetchJson<PocketEnvelope>(
    url(`/public/recordings/${encodeURIComponent(id)}/audio-download-url`),
    { headers: authHeaders() },
  );
  const d = env.data;
  if (typeof d === 'string') return d;
  if (d && typeof d === 'object') {
    const rec = d as Record<string, unknown>;
    for (const key of ['url', 'download_url', 'downloadUrl', 'audio_url']) {
      if (typeof rec[key] === 'string') return rec[key] as string;
    }
  }
  return null;
}
