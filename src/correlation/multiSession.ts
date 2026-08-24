import { findSessionRestart, parseTranscript } from '../session/transcript';

/**
 * Does this recording look like it holds more than one client's consultation?
 *
 * This is a SAFETY GATE, not a segmenter. It answers one question — "is it safe
 * to file this audio under a single client without a human looking?" — and it
 * answers conservatively, because the two outcomes are not symmetric. A false
 * hold costs Nicole one click. A false clear puts one client's symptoms,
 * supplements and quoted words permanently into another client's chart, and
 * nothing downstream can detect it: the note parses, the evidence quotes verify
 * against the transcript, and every metric reads green.
 *
 * That asymmetry is why this runs on cheap deterministic signals rather than the
 * LLM boundary detector in session/segmenter.ts. The expensive detector decides
 * WHERE to cut, which only matters once a human has decided to cut at all; this
 * runs on every ingest and only has to decide whether to ask.
 *
 * Measured against the 2026-08-20 recordings, both of which the correlator filed
 * confidently under a single client and both of which were wrong:
 *   - a 41-minute recording carrying three consecutive consultations, four
 *     diarized speakers, and the name "Steve Broderick" spoken in a segment
 *     filed under a different client;
 *   - a 60-minute recording overlapping two appointments closely enough that
 *     both cleared the overlap guard.
 */

export interface MultiSessionRisk {
  /** True when a human must look before any of this reaches a chart. */
  hold: boolean;
  /** One line per signal that fired, for the review queue. */
  reasons: string[];
}

/**
 * A two-party consultation diarizes to two labels. Three is routine drift — one
 * speaker split in half when the room changes, which is what happens when a
 * client moves to the treatment table and the mic distance changes.
 *
 * Four is not drift. Four means the tool heard voices it could not reconcile
 * into two people, and on a back-to-back clinic day the likeliest reason is that
 * it heard more than two people.
 */
const SPEAKER_LABEL_HOLD_THRESHOLD = 4;

/** Overlap below this is a neighbouring appointment bleeding in, not a session. */
const MIN_MEANINGFUL_OVERLAP_SECONDS = 300;

export interface OverlapCandidate {
  appointmentId: string;
  clientName: string | null;
  overlapSeconds: number;
}

/**
 * Names spoken in the transcript that belong to a DIFFERENT client than the one
 * this recording is about to be filed under.
 *
 * Matched on first name and only against names that are actually on the calendar
 * near this recording — a bare surname scan would fire on every mention of a
 * family member, and a full-name scan would never fire at all, because nobody
 * says "Steven Broderick" twice in a consultation.
 *
 * Deliberately NOT used to reassign the recording. A name in the audio says
 * someone was discussed, not whose appointment this is; a practitioner recapping
 * a referral says another client's name without that client being in the room.
 * It is evidence that a human should look, and nothing more.
 */
export function foreignClientNames(
  transcript: string,
  matchedClientName: string | null,
  otherClientNames: readonly string[],
): string[] {
  const matchedFirst = matchedClientName?.trim().split(/\s+/)[0]?.toLowerCase() ?? null;
  const hits = new Set<string>();
  for (const full of otherClientNames) {
    const parts = full.trim().split(/\s+/);
    const first = parts[0];
    const last = parts.length > 1 ? parts[parts.length - 1] : null;
    if (!first) continue;
    if (matchedFirst && first.toLowerCase() === matchedFirst) continue;

    const patterns: RegExp[] = [];
    // The calendar's spelling and the spoken one routinely differ by a
    // diminutive: the booking says "Steve Broderick" and the practitioner says
    // "Steven". Allowing up to two trailing letters covers Steve/Steven and
    // Dan/Danny while still refusing Stevenson, which is a different word and,
    // on a transcript, usually a different subject entirely.
    if (first.length >= 3) patterns.push(new RegExp(`\\b${escapeRe(first)}[a-z]{0,2}\\b`, 'i'));
    // Surnames are said rarely but almost never by accident, so they need no
    // fuzz. Short ones are skipped for the same reason short first names are.
    if (last && last.length >= 4) patterns.push(new RegExp(`\\b${escapeRe(last)}\\b`, 'i'));

    if (patterns.some((re) => re.test(transcript))) hits.add(full);
  }
  return [...hits].sort();
}

/** Distinct speaker labels the transcription tool assigned. */
const escapeRe = (v: string): string => v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function speakerLabelCount(transcript: string): number {
  return new Set(parseTranscript(transcript).map((t) => t.speaker)).size;
}

export function assessMultiSessionRisk(opts: {
  transcript: string | null;
  /** Every non-cancelled appointment overlapping the recording window. */
  candidates: readonly OverlapCandidate[];
  /** The client the correlator wants to file this under, if it picked one. */
  matchedClientName: string | null;
}): MultiSessionRisk {
  const reasons: string[] = [];
  const { transcript, candidates, matchedClientName } = opts;

  // No transcript yet: nothing to read, and nothing gets extracted either. Let
  // correlation proceed — the gate runs again when the transcript arrives.
  if (!transcript?.trim()) return { hold: false, reasons: [] };

  const speakers = speakerLabelCount(transcript);
  if (speakers >= SPEAKER_LABEL_HOLD_THRESHOLD) {
    reasons.push(
      `${speakers} distinct speakers in the audio — a two-person consultation diarizes to 2, occasionally 3`,
    );
  }

  // The signal that does not depend on the calendar, on diarization, or on
  // anyone's name being spoken. Two consecutive consultations reuse the same two
  // speaker labels and may never name a client, but the handover is always
  // audible: one client leaves and the next is greeted.
  const restartTurn = findSessionRestart(transcript);
  if (restartTurn !== null) {
    reasons.push(
      `a second consultation appears to begin at turn ${restartTurn} — one client is sent off and another is greeted`,
    );
  }

  const meaningful = candidates.filter((c) => c.overlapSeconds >= MIN_MEANINGFUL_OVERLAP_SECONDS);
  if (meaningful.length > 1) {
    const list = meaningful
      .map((c) => `${c.clientName ?? 'unknown client'} (${Math.round(c.overlapSeconds / 60)}m)`)
      .join(', ');
    reasons.push(`recording spans ${meaningful.length} booked appointments: ${list}`);
  }

  const others = candidates
    .map((c) => c.clientName)
    .filter((n): n is string => !!n && n !== matchedClientName);
  const foreign = foreignClientNames(transcript, matchedClientName, others);
  if (foreign.length) {
    reasons.push(
      `transcript names another client booked nearby: ${foreign.join(', ')}` +
        (matchedClientName ? ` (filing under ${matchedClientName})` : ''),
    );
  }

  return { hold: reasons.length > 0, reasons };
}
