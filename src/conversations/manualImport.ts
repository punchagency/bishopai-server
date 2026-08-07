import { createHash } from 'node:crypto';

/**
 * A stable, content-derived id for a hand-imported transcript.
 *
 * The `(source, source_id)` unique index deduplicates ingest, so keying on the
 * transcript's hash makes re-pasting or re-dropping the exact same text a no-op
 * instead of a duplicate conversation. Namespaced `manual:` to be obviously not
 * a Pocket `rec_…` id, matching how 0027/0028 treat the id namespaces.
 */
export function manualSourceId(transcript: string): string {
  return 'manual:' + createHash('sha256').update(transcript, 'utf8').digest('hex');
}

// Otter.ai (and similar) exports label each turn with a speaker + a timestamp on
// its own line, then the spoken text on the following line(s):
//
//   Speaker 2 0:07
//   Okay. And what were you feeling two weeks ago?
//
// Pocket, by contrast, hands us one `Speaker: text` line per utterance. Bringing
// a pasted transcript to that same shape means the extractor sees the format it
// already works well on, and drops the per-line timestamps that are noise to it.
const SPEAKER_HEADER = /^(.+?)\s+\d{1,2}:\d{2}(?::\d{2})?$/;

/**
 * Best-effort normalization of a pasted transcript toward `Speaker: text`.
 *
 * Deliberately conservative: if the text shows no sign of the timestamped
 * speaker-header format (no header line matched), it is returned trimmed but
 * otherwise untouched, so arbitrary pasted text is never mangled.
 */
export function normalizeManualTranscript(raw: string): string {
  const lines = raw.replace(/\r\n?/g, '\n').split('\n');

  interface Turn {
    speaker: string;
    parts: string[];
  }
  const turns: Turn[] = [];
  let current: Turn | null = null;
  let matchedAnyHeader = false;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue; // blank lines only separate turns
    const header = SPEAKER_HEADER.exec(trimmed);
    if (header) {
      matchedAnyHeader = true;
      current = { speaker: header[1].trim(), parts: [] };
      turns.push(current);
    } else if (current) {
      current.parts.push(trimmed);
    } else {
      // Text before any header — keep it as an unattributed leading turn.
      current = { speaker: '', parts: [trimmed] };
      turns.push(current);
    }
  }

  if (!matchedAnyHeader) return raw.trim();

  return turns
    .map((t) => {
      const text = t.parts.join(' ').trim();
      if (!text) return null;
      return t.speaker ? `${t.speaker}: ${text}` : text;
    })
    .filter((l): l is string => l !== null)
    .join('\n');
}
