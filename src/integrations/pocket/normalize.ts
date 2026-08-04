import type { ConversationInput } from '../../conversations/ingest';
import type { PocketRecording, PocketTranscriptSegment, PocketWebhookPayload } from './types';

// Turning a Pocket recording into something the correlator can use.
//
// The correlator joins on TIME — it overlaps the recording's window against the
// appointment calendar — so deriving that window correctly is the whole game.
// Everything else (transcript text) is just formatting.

/**
 * Absolute start/end of a recording.
 *
 * Pocket's transcript segments carry `start`/`end` in seconds RELATIVE to the
 * recording, so they can't produce a wall-clock window on their own. The
 * recording object gives us `createdAt` + `duration`, and Pocket's own
 * documented example is self-consistent with createdAt being the moment the
 * recording STARTED (createdAt 11:30 + duration 1800s = the 12:00 event
 * timestamp), which is what we rely on.
 *
 * Explicit start/end fields win when present — they're undocumented, but if
 * Pocket ever sends them they are strictly better than an inference.
 *
 * Returns null when there is no usable start: a recording we can't place in
 * time is not something to guess about.
 */
export function recordingWindow(rec: PocketRecording | undefined): { starts_at: string; ends_at: string } | null {
  if (!rec) return null;

  const start = firstDate(rec.startedAt, rec.started_at, rec.createdAt, rec.created_at);
  if (!start) return null;

  const explicitEnd = firstDate(rec.endedAt, rec.ended_at);
  if (explicitEnd && explicitEnd.getTime() >= start.getTime()) {
    return { starts_at: start.toISOString(), ends_at: explicitEnd.toISOString() };
  }

  const duration = Number(rec.duration);
  // A missing or nonsensical duration collapses the window to the start instant
  // rather than inventing a length. `tstzrange(t, t)` is EMPTY in Postgres and
  // overlaps nothing, so this would send every such recording to the unmatched
  // queue — correct on the "never guess" rule, but it would also throw away a
  // real match we can justify. One millisecond is the narrowest truthful claim:
  // it asserts only that the recording existed at its own start instant, and an
  // appointment spanning that instant is a genuine overlap, not an inference.
  const ms = Number.isFinite(duration) && duration > 0 ? duration * 1000 : 1;
  return {
    starts_at: start.toISOString(),
    ends_at: new Date(start.getTime() + ms).toISOString(),
  };
}

/**
 * Render diarized segments the way the extraction prompt expects: one
 * `Speaker: text` line per utterance, in order.
 *
 * Segments with no text are dropped (they carry no information); segments with
 * text but no speaker keep the text — an unattributed line is still clinical
 * content, and inventing a speaker label would be a guess about who said it.
 */
export function transcriptText(segments: PocketTranscriptSegment[] | undefined): string | undefined {
  if (!segments?.length) return undefined;
  const lines = segments
    .map((s) => {
      const text = typeof s.text === 'string' ? s.text.trim() : '';
      if (!text) return null;
      const speaker = typeof s.speaker === 'string' ? s.speaker.trim() : '';
      return speaker ? `${speaker}: ${text}` : text;
    })
    .filter((l): l is string => !!l);
  return lines.length ? lines.join('\n') : undefined;
}

/**
 * Webhook payload (or a normalized REST recording) → ingest input.
 *
 * Returns null when the payload can't be placed: no recording id (nothing to
 * deduplicate on) or no usable time window (nothing to correlate on).
 */
export function toConversationInput(payload: PocketWebhookPayload): ConversationInput | null {
  const id = typeof payload.recording?.id === 'string' ? payload.recording.id.trim() : '';
  if (!id) return null;

  const window = recordingWindow(payload.recording);
  if (!window) return null;

  return {
    source_id: id,
    source: 'pocket',
    starts_at: window.starts_at,
    ends_at: window.ends_at,
    // undefined, not null: ingest COALESCEs, so an event that arrives without
    // transcript text (a summary regeneration, say) must not blank the
    // transcript a previous delivery already stored.
    transcript: transcriptText(payload.transcript),
  };
}

/**
 * Pull `{recording, transcript}` out of a REST `data` payload.
 *
 * The spec types `data` as `unknown`, so this accepts the shapes Pocket
 * plausibly returns rather than asserting one: the recording fields inline at
 * the top level, or nested under `recording`, with the transcript either
 * alongside as an array or nested under `transcript.segments`. Anything else
 * yields a payload that `toConversationInput` will reject, which is the
 * intended outcome — an unrecognized body must not become a half-built row.
 */
export function fromRestData(data: unknown): PocketWebhookPayload {
  if (!data || typeof data !== 'object') return {};
  const d = data as Record<string, unknown>;

  const recording = (isObject(d.recording) ? d.recording : d) as PocketRecording;

  let transcript: PocketTranscriptSegment[] | undefined;
  if (Array.isArray(d.transcript)) transcript = d.transcript as PocketTranscriptSegment[];
  else if (isObject(d.transcript) && Array.isArray((d.transcript as Record<string, unknown>).segments)) {
    transcript = (d.transcript as { segments: PocketTranscriptSegment[] }).segments;
  } else if (Array.isArray(d.segments)) transcript = d.segments as PocketTranscriptSegment[];
  else if (Array.isArray(d.utterances)) transcript = d.utterances as PocketTranscriptSegment[];

  return { recording, transcript };
}

/** The list endpoint's `data` — an array of recordings, however it's wrapped. */
export function fromRestList(data: unknown): PocketRecording[] {
  if (Array.isArray(data)) return data as PocketRecording[];
  if (isObject(data)) {
    for (const key of ['recordings', 'items', 'results']) {
      const v = (data as Record<string, unknown>)[key];
      if (Array.isArray(v)) return v as PocketRecording[];
    }
  }
  return [];
}

function isObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

function firstDate(...vals: unknown[]): Date | null {
  for (const v of vals) {
    if (typeof v !== 'string' || !v) continue;
    const d = new Date(v);
    if (!Number.isNaN(d.getTime())) return d;
  }
  return null;
}
