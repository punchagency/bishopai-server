import type { Evidence, VerificationStatus } from './schema';
import { parseTranscript, mergeAdjacentTurns, indexTurns, type Turn } from './transcript';

// Checking provenance back against the transcript.
//
// The model is asked where each finding came from. That makes review fast —
// Nicole confirms against the practitioner's own sentence instead of recalling
// the session — but it also buys something review can't: a citation that does
// not hold up is a fabricated finding, and detecting that needs no human.
//
// The rule is FLAG, never drop. A real finding whose citation drifted must still
// reach Nicole; the flag tells her which fields to read closely, and the
// aggregate rate is a live production proxy for the eval harness's fabrication
// metric.
//
// There are two ways to cite, and they are not equally trustworthy.
//
// A QUOTE is prose the model reproduces from memory, and models paraphrase when
// they mean to copy. So a failed text match cannot distinguish "invented the
// finding" from "invented only the wording" — and matching loosely enough to
// forgive the paraphrase is what lets the fabrication through. Widening the
// match window to accept "adrenal ... stressed" also accepts "my cholesterol is
// not high", because over enough words every content word turns up somewhere.
// There is no threshold that separates those two; the measure is the problem.
//
// A TURN NUMBER cannot be paraphrased. The model points at #47, and the server
// reads #47 and checks whether it says this. The comparison is against a
// bounded, real unit of the transcript rather than a window chosen to be
// forgiving, so "supported" means supported by the words the practitioner
// actually said in one breath. That is why spans are the primary path and text
// is the fallback for notes extracted before citations existed.

const STOP_WORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'by', 'for', 'from', 'has', 'he',
  'in', 'is', 'it', 'its', 'of', 'on', 'or', 'that', 'the', 'to', 'was', 'were',
  'will', 'with', 'i', 'my', 'you', 'your', 'we', 'our', 'so', 'um', 'uh', 'like',
  'all', 'but', 'me', 'she', 'her', 'this', 'too', 'just', 'there', 'them', 'then',
]);

// Negation is the one word class a bag-of-words comparison must not average
// away. "my cholesterol is not high" and "my cholesterol is high" share every
// content word but assert opposite findings, and the inverted one is the more
// dangerous to wave through. So negators are pulled out of the ratio entirely
// and required to appear verbatim in the matched window instead.
const NEGATORS = new Set([
  'not', 'no', 'never', 'none', 'nothing', 'nobody', 'nor', 'neither', 'without',
  'cannot', "don't", "doesn't", "didn't", "isn't", "aren't", "wasn't", "weren't",
  "can't", "won't", "haven't", "hasn't", "hadn't", "shouldn't", "wouldn't",
  "couldn't", "ain't",
]);

/** Exported so the eval's gold matcher stems the same way this does. Two
 *  hand-rolled stemmers in one repo drift, and the one that drifts is the one
 *  nobody is looking at. */
export function stem(word: string): string {
  const w = word.toLowerCase().replace(/[^a-z0-9]/g, '');
  if (w.length <= 3) return w;
  if (w.endsWith('sses')) return w.slice(0, -2);
  if (w.endsWith('ies')) return `${w.slice(0, -3)}y`;
  if (w.endsWith('ss')) return w;
  if (w.endsWith('eed')) return w.slice(0, -1);
  if (w.endsWith('ed')) return w.slice(0, -2);
  if (w.endsWith('ing')) return w.slice(0, -3);
  if (w.endsWith('ly')) return w.slice(0, -2);
  if (w.endsWith('s')) return w.slice(0, -1);
  return w;
}

/**
 * Speech disfluencies, which a quote drops and the transcript keeps.
 *
 * Nicole says "the thyroid is, like, crashing"; the model quotes "thyroid is
 * crashing", which is a faithful copy of what she said and NOT a substring of
 * it. That single interpolated "like" was enough to push a real clinical finding
 * out of verbatim matching and into the flagged pile — so fillers come out of
 * both sides before comparing.
 *
 * Only in the parenthetical form (", like,", "um,") that marks a disfluency.
 * Stripping the words outright would turn "I like garlic" into "I garlic" and
 * "I feel like I'm crashing" into a different claim.
 */
const FILLERS = /(?:^|,)\s*(?:um|uh|er|like|you know|i mean)\s*,/g;

/** Collapse the differences transcription and quoting introduce, so a genuine
 *  quote isn't flagged over a comma, a capital letter, or an "um". */
function canonical(s: string): string {
  return s
    .toLowerCase()
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(FILLERS, ' ')
    .replace(/[^a-z0-9'\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const NEAR_MATCH_RATIO = 0.65;

/**
 * Does `haystack` contain the claim `quote` makes?
 *
 * Verbatim containment first; otherwise the quote's content stems must appear
 * together in a short window. The window stays close to the length of the quote
 * on purpose — over 35 words of conversation nearly any common word turns up by
 * chance, and at that point the check has stopped measuring whether this was
 * said and started measuring whether anything was.
 */
function supports(quote: string, haystack: string): boolean {
  const cQuote = canonical(quote);
  const cHay = canonical(haystack);
  if (!cQuote || !cHay) return false;
  if (cHay.includes(cQuote)) return true;

  const rawWords = cQuote.split(' ').filter(Boolean);
  if (rawWords.length === 0) return false;

  const quoteNegators = rawWords.filter((w) => NEGATORS.has(w));
  const contentWords = rawWords
    .filter((w) => !STOP_WORDS.has(w) && !NEGATORS.has(w))
    .map(stem)
    .filter((w) => w.length >= 2);
  const quoteStems = contentWords.length > 0 ? contentWords : rawWords.map(stem);

  const hayWords = cHay.split(' ').filter(Boolean);
  const hayStems = hayWords.map(stem);
  const windowSize = Math.max(8, quoteStems.length * 4);

  for (let i = 0; i < hayStems.length; i += 3) {
    const rawSlice = new Set(hayWords.slice(i, i + windowSize));
    const windowSlice = new Set(hayStems.slice(i, i + windowSize));
    let hits = 0;
    for (const w of quoteStems) {
      if (windowSlice.has(w)) hits++;
    }
    if (hits / quoteStems.length < NEAR_MATCH_RATIO) continue;
    // Every negator the quote asserts must actually be there.
    if (!quoteNegators.every((n) => rawSlice.has(n))) continue;
    return true;
  }
  return false;
}

/**
 * How much of `text` is actually the practitioner's wording, 0–1.
 *
 * The quote check asks whether the transcript backs a finding. This asks a
 * different question the same evidence can answer: whether the finding is still
 * in the words that were said. An assessment is meant to be a span of the
 * practitioner's speech trimmed of filler — but models rewrite clinical speech
 * into chart-note prose by default ("the gallbladder is showing stress" becomes
 * "cholestatic pattern noted"), and that rewrite verifies perfectly: the turn is
 * real, the quote is copied from it, and only the item Nicole reads has changed.
 *
 * So: what share of the finding's content words appear in the turn it was read
 * from. 1.0 is a trimmed quote; a low score is prose the model composed. It is a
 * measurement, not a gate — nothing is rejected on it, because a faithful item
 * can legitimately drop or reorder words, and the point is to see the rate move
 * when a prompt changes.
 */
export function wordingFidelity(text: string, turnText: string): number {
  const cText = canonical(text);
  const cTurn = canonical(turnText);
  if (!cText || !cTurn) return 0;
  if (cTurn.includes(cText)) return 1;

  const stems = cText
    .split(' ')
    .filter((w) => w && !STOP_WORDS.has(w))
    .map(stem)
    .filter((w) => w.length >= 2);
  if (!stems.length) return 1;
  const turnStems = new Set(cTurn.split(' ').map(stem));
  let hits = 0;
  for (const w of stems) if (turnStems.has(w)) hits++;
  return hits / stems.length;
}

/** Verbatim containment only — the strong form, used to decide whether a quote
 *  is real even though the model pointed at the wrong turn. */
function containsVerbatim(quote: string, haystack: string): boolean {
  const cQuote = canonical(quote);
  if (!cQuote) return false;
  return canonical(haystack).includes(cQuote);
}

/** The turn that actually contains this quote, so a citation can be corrected
 *  rather than merely rejected. */
function findSupportingTurn(quote: string, turns: Turn[]): Turn | null {
  return turns.find((t) => containsVerbatim(quote, t.text)) ?? null;
}

/**
 * How far off a citation may be and still count as pointing at the right place.
 *
 * Off-by-one is a systematic failure when a model references numbered items, not
 * a sign it invented anything: on Patricia's session the model cited turn #161
 * correctly four times and #160 — the turn immediately before — four more times,
 * for findings that are plainly in #161. Flagging those as fabrications would
 * bury the one finding on that page that really was invented.
 *
 * One turn, and no further. This is a bounded tolerance for a known counting
 * error, not a threshold to be relaxed when flags feel too numerous: a quote
 * that matches nothing within a turn of where the model pointed has not been
 * miscounted, it has been made up. The resolved `turn` records where the
 * evidence actually is, and `turn_cited` keeps what the model said, so the drift
 * stays measurable instead of disappearing into a pass.
 */
const SPAN_DRIFT = 1;

function findNearbySupport(quote: string, cited: number, byIndex: Map<number, Turn>): Turn | null {
  for (let d = 1; d <= SPAN_DRIFT; d++) {
    for (const idx of [cited - d, cited + d]) {
      const turn = byIndex.get(idx);
      if (turn && supports(quote, turn.text)) return turn;
    }
  }
  return null;
}

export interface VerificationSummary {
  total: number;
  unverified: number;
  /** Findings anchored to a specific turn — the share of provenance that is
   *  checkable rather than approximate. */
  spans: number;
  byStatus: Record<string, number>;
}

/**
 * Mark each evidence item against the source transcript.
 *
 * `turns` is optional so callers that only have raw text still work; it is
 * derived the same way the extractor derived it, which is what keeps a cited
 * `#n` meaning the same thing on both sides.
 */
export function verifyEvidence(
  evidence: Evidence[],
  transcript: string,
  turns?: Turn[],
): Evidence[] {
  if (!evidence.length) return evidence;

  const allTurns = turns ?? indexTurns(mergeAdjacentTurns(parseTranscript(transcript)));
  const byIndex = new Map(allTurns.map((t) => [t.index, t]));

  return evidence.map((e) => {
    const quote = e.quote ?? '';
    const cited = typeof e.turn === 'number' && Number.isInteger(e.turn) ? e.turn : null;

    // `unverified` means the transcript does not back this finding — not that
    // the citation was weak. A near match is weaker provenance than a span, and
    // the status field says so, but it is still support; flagging it would bury
    // the genuinely unsupported findings among ordinary paraphrases.
    const UNSUPPORTED: VerificationStatus[] = ['unsupported', 'misattributed', 'bad_span'];
    const mark = (
      verification: VerificationStatus,
      turnText: string | null,
    ): Evidence => ({
      ...e,
      verification,
      turn_text: turnText,
      unverified: UNSUPPORTED.includes(verification),
    });

    if (!canonical(quote)) {
      // No quote at all. A bare turn citation is still real provenance — the
      // turn's own words are what review reads anyway.
      const turn = cited != null ? byIndex.get(cited) : undefined;
      return turn ? mark('span', turn.text) : mark('unsupported', null);
    }

    if (cited != null) {
      const turn = byIndex.get(cited);
      if (turn) {
        // Word for word out of the turn it points at — the strongest evidence
        // available, and what a model that copied rather than recalled produces.
        if (containsVerbatim(quote, turn.text)) return mark('span', turn.text);
        // Right turn, reworded. Still supported, but the words are the model's,
        // so review reads the turn rather than the quote.
        if (supports(quote, turn.text)) return mark('span_near', turn.text);
        // Pointed somewhere specific and was wrong. If the words are genuinely
        // in the transcript the finding survives — correct the citation to the
        // turn that does say it rather than throwing the evidence away.
        const actual = findSupportingTurn(quote, allTurns);
        if (actual) {
          return { ...mark('exact', actual.text), turn: actual.index, turn_cited: cited };
        }
        // Miscounted by one rather than invented.
        const nearby = findNearbySupport(quote, cited, byIndex);
        if (nearby) {
          return { ...mark('span_near', nearby.text), turn: nearby.index, turn_cited: cited };
        }
        return mark('misattributed', turn.text);
      }
      // Cited a turn that does not exist.
      const actual = findSupportingTurn(quote, allTurns);
      if (actual) return { ...mark('exact', actual.text), turn: actual.index };
      return mark('bad_span', null);
    }

    // No citation — the pre-span path, kept for notes extracted before this
    // existed and for models that omit the field.
    const actual = findSupportingTurn(quote, allTurns);
    if (actual) return { ...mark('exact', actual.text), turn: actual.index };
    if (supports(quote, transcript)) return mark('near', null);
    return mark('unsupported', null);
  });
}

export function summarize(evidence: Evidence[]): VerificationSummary {
  const byStatus: Record<string, number> = {};
  for (const e of evidence) {
    const key = e.verification ?? 'unknown';
    byStatus[key] = (byStatus[key] ?? 0) + 1;
  }
  return {
    total: evidence.length,
    unverified: evidence.filter((e) => e.unverified).length,
    spans: evidence.filter(
      (e) => e.verification === 'span' || e.verification === 'span_near',
    ).length,
    byStatus,
  };
}
