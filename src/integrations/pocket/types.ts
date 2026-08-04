// Pocket wire types.
//
// Source of truth caveat: Pocket's OpenAPI spec types every REST envelope as
// `{ data?: unknown; error?: string; pagination?: …; success?: boolean }` — the
// `data` payload is genuinely undocumented. The ONLY place Pocket documents real
// field names is the webhook payload, so that shape is treated as canonical here
// and the REST readers normalize defensively into it (see normalize.ts).
//
// Everything below is therefore optional on purpose. A missing field must
// degrade to "we don't know", never to a guess — a recording we can't place in
// time lands unmatched for a human, which is the correct outcome.

/** The generic envelope every Pocket REST endpoint returns. */
export interface PocketEnvelope<T = unknown> {
  data?: T;
  error?: string;
  pagination?: PocketPagination;
  success?: boolean;
}

export interface PocketPagination {
  has_more?: boolean;
  limit?: number;
  page?: number;
  total?: number;
  total_pages?: number;
}

/** One line of diarized speech. `start`/`end` are SECONDS into the recording. */
export interface PocketTranscriptSegment {
  speaker?: string;
  text?: string;
  start?: number;
  end?: number;
}

export interface PocketRecording {
  id?: string;
  title?: string;
  description?: string;
  /** Seconds. */
  duration?: number;
  language?: string;
  /** ISO 8601. Observed to be when the recording STARTED — see normalize.ts. */
  createdAt?: string;
  created_at?: string;
  /** Not documented, but preferred over createdAt+duration when present. */
  startedAt?: string;
  started_at?: string;
  endedAt?: string;
  ended_at?: string;
}

/** Events Pocket can deliver. Only the transcript-bearing ones drive ingest. */
export type PocketEventType =
  | 'transcription.completed'
  | 'summary.completed'
  | 'summary.regenerated'
  | 'summary.updated'
  | 'mind_map.completed'
  | 'action_items.regenerated'
  | 'speakers.labeled'
  | 'transcript.edited'
  | 'action_items.updated'
  | 'recording.created'
  | 'recording.deleted'
  | 'recording.merged'
  | 'translation.completed';

export interface PocketWebhookPayload {
  event?: string;
  timestamp?: string;
  user?: { id?: string; email?: string };
  organization?: { id?: string };
  recording?: PocketRecording;
  transcript?: PocketTranscriptSegment[];
  summarizations?: Record<string, unknown>;
}

/**
 * Events that carry (or revise) transcript text worth re-ingesting.
 *
 * `recording.created` is deliberately absent: it fires before transcription, so
 * acting on it would land a conversation with no transcript and immediately
 * burn its correlation against an empty body. The poller picks up anything the
 * transcript-bearing events miss.
 *
 * `speakers.labeled` and `transcript.edited` ARE included — both rewrite the
 * text we store, and the ingest upsert is idempotent, so a re-delivery just
 * refreshes the transcript in place.
 */
export const TRANSCRIPT_EVENTS: ReadonlySet<string> = new Set<PocketEventType>([
  'transcription.completed',
  'summary.completed',
  'summary.regenerated',
  'speakers.labeled',
  'transcript.edited',
  'translation.completed',
  'recording.merged',
]);
