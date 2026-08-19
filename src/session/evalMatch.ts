import { nameSimilarity } from './supplementName';
import { stem } from './verifyEvidence';

// Matching an extraction against a hand-written gold set.
//
// This lives in src/ rather than in the eval script because it is not glue: it
// decides what the accuracy numbers mean, and it can be wrong in ways that look
// exactly like the model being wrong.
//
// It has been. The eval reported, for months, that the model swapped two
// supplements' actions — one product started that should have been reduced, one
// reduced that should have been started. The extraction was correct every time.
// Gold "Beta Plus" was matched against the extraction by taking the FIRST entry
// scoring at least 0.5, and "Beta Plus" against "Livatrit Plus" scores exactly
// 0.5 on the shared word "Plus". Gold claimed the wrong row, read its action off
// it, and reported a clinical error that never happened — while the real row sat
// unclaimed and was then handed the other gold entry, producing the mirror image
// and making the whole thing look like a systematic model failure.
//
// Two rules come out of that, and they are why this is a module with tests:
//
// 1. BEST MATCH, NEVER FIRST MATCH. A threshold says "close enough to consider",
//    not "this is the one". Where several candidates clear it, the answer is the
//    closest, and greedy first-past-the-post silently mis-binds every pair that
//    shares a suffix — which product names do constantly ("... Plus", "...
//    Complex", "Bio-...").
// 2. Product names go through nameSimilarity, the same normaliser production
//    uses to match spoken names against the catalog, rather than a second
//    hand-rolled one that drifts from it.

/**
 * Numbers as spoken, so a gold item and an extraction that chose the other form
 * are not counted as different facts. Gold says "three PM crash", the model
 * writes "3 PM" — that is one finding written two ways, and scoring it as a miss
 * AND an invention (which is what happened) punishes the extraction twice for a
 * choice of notation.
 */
const NUMBER_WORDS: Record<string, string> = {
  zero: '0', one: '1', two: '2', three: '3', four: '4', five: '5', six: '6',
  seven: '7', eight: '8', nine: '9', ten: '10', eleven: '11', twelve: '12',
  first: '1', second: '2', third: '3', fourth: '4', fifth: '5',
};

/**
 * Words reduced to what they assert.
 *
 * Stemmed, because "pre-diabetic" and "pre-diabetes diagnosis" are the same
 * finding and scored as two different ones — a miss and a fabrication from a
 * single correct answer. The stemmer is the one verifyEvidence already uses, not
 * a second copy.
 *
 * This is surface form only. It must never be widened into matching MEANING:
 * "soreness in joints" against "joint pain flare" is a judgement a reader makes
 * and a token overlap cannot, and a metric that pretends otherwise stops
 * measuring recall and starts flattering it.
 */
export function tokens(s: string): Set<string> {
  const words = s.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(Boolean);
  return new Set(words.map((w) => NUMBER_WORDS[w] ?? stem(w)).filter(Boolean));
}

function shared(a: Set<string>, b: Set<string>): number {
  let n = 0;
  for (const t of a) if (b.has(t)) n++;
  return n;
}

export function similarity(a: string, b: string): number {
  const ta = tokens(a);
  const tb = tokens(b);
  if (!ta.size || !tb.size) return 0;
  return shared(ta, tb) / Math.max(ta.size, tb.size);
}

/**
 * How much of the GOLD item the extraction carries, ignoring what it adds.
 *
 * `similarity` divides by the longer string, which penalises the right answer
 * for being more complete — an extraction that keeps the practitioner's stated
 * cause attached scored as both a miss and an invention. The length cap is what
 * keeps this honest: an item may carry its own attribution, not a paragraph that
 * happens to contain the gold words.
 */
const MAX_LENGTH_RATIO = 4;

export function coverage(got: string, want: string): number {
  const tg = tokens(got);
  const tw = tokens(want);
  if (!tg.size || !tw.size) return 0;
  if (tg.size > tw.size * MAX_LENGTH_RATIO) return 0;
  return shared(tw, tg) / tw.size;
}

export const MATCH_THRESHOLD = 0.5;
/** Higher than MATCH_THRESHOLD: coverage is the easier test to pass, so it has
 *  to demand more of the gold item's words before calling it found. */
export const COVERAGE_THRESHOLD = 0.7;
/** Same threshold production uses to suggest a catalog match. */
export const NAME_THRESHOLD = 0.5;

/** 0 when this is not a match at all; otherwise how good a match it is, so
 *  callers can pick the best rather than the first. */
export function matchScore(got: string, want: string): number {
  const sim = similarity(got, want);
  const cov = coverage(got, want);
  return Math.max(sim >= MATCH_THRESHOLD ? sim : 0, cov >= COVERAGE_THRESHOLD ? cov : 0);
}

export function matches(got: string, want: string): boolean {
  return matchScore(got, want) > 0;
}

/**
 * Index of the BEST match in `candidates`, or -1.
 *
 * `score` returns 0 for "not a match". Ties keep the earlier candidate, which
 * only matters when two are equally close — at which point the eval cannot tell
 * them apart and neither could a reader.
 */
export function bestMatch<T>(candidates: T[], score: (candidate: T) => number): number {
  let bestIndex = -1;
  let bestScore = 0;
  candidates.forEach((candidate, i) => {
    const s = score(candidate);
    if (s > bestScore) {
      bestScore = s;
      bestIndex = i;
    }
  });
  return bestIndex;
}

/** How well an extracted product name matches a gold entry and its known
 *  mis-transcriptions. Uses the production normaliser, so pack sizes and
 *  punctuation are handled the one way. */
export function nameScore(got: string, names: readonly string[]): number {
  let best = 0;
  for (const n of names) {
    const s = nameSimilarity(got, n);
    if (s >= NAME_THRESHOLD && s > best) best = s;
  }
  return best;
}
