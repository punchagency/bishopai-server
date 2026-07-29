import type { Evidence } from './schema';

// Checking provenance back against the transcript.
//
// The model is asked to quote the words that justify each finding. That makes
// review fast — Nicole confirms against the practitioner's own sentence instead
// of recalling the session — but it also buys something review can't: a quote
// that does not appear in the transcript is a fabricated finding, and detecting
// that needs no human at all.
//
// The rule is FLAG, never drop. A real finding whose quote drifted by a word
// must still reach Nicole; the flag tells her which fields to read closely, and
// the aggregate rate is a live production proxy for the eval harness's
// fabrication metric.

/** Collapse the differences transcription and quoting introduce, so a genuine
 *  quote isn't flagged over a comma or a capital letter. */
function canonical(s: string): string {
  return s
    .toLowerCase()
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[^a-z0-9'\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Verbatim quotes are checked by containment. Models also lightly paraphrase
 * ("the gallbladder pain is back" for "so the gallbladder pain's back again"),
 * which is not fabrication — so a quote whose words nearly all appear in one
 * window of the transcript passes too. Anything below that is unsupported.
 */
const NEAR_MATCH_RATIO = 0.85;

function nearMatch(quote: string, haystack: string): boolean {
  const words = quote.split(' ').filter(Boolean);
  if (words.length < 3) return false;
  // Slide a window the length of the quote and look for a run where nearly every
  // word of the quote is present. Cheap, and good enough to separate "said it
  // differently" from "made it up".
  const hay = haystack.split(' ');
  const window = words.length * 2;
  for (let i = 0; i < hay.length; i += Math.max(1, Math.floor(words.length / 2))) {
    const slice = new Set(hay.slice(i, i + window));
    let hits = 0;
    for (const w of words) if (slice.has(w)) hits++;
    if (hits / words.length >= NEAR_MATCH_RATIO) return true;
  }
  return false;
}

export interface VerificationSummary {
  total: number;
  unverified: number;
}

/** Mark each evidence item verified or not against the source transcript. */
export function verifyEvidence(evidence: Evidence[], transcript: string): Evidence[] {
  if (!evidence.length) return evidence;
  const hay = canonical(transcript);
  return evidence.map((e) => {
    const quote = canonical(e.quote ?? '');
    if (!quote) return { ...e, unverified: true };
    const found = hay.includes(quote) || nearMatch(quote, hay);
    return found ? { ...e, unverified: false } : { ...e, unverified: true };
  });
}

export function summarize(evidence: Evidence[]): VerificationSummary {
  return {
    total: evidence.length,
    unverified: evidence.filter((e) => e.unverified).length,
  };
}
