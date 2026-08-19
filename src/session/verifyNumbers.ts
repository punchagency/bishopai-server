import type { SessionNote } from './schema';

// Numbers the transcript never said.
//
// The quote check in verifyEvidence answers "did the practitioner say this?" for
// the CITATION. It cannot answer it for the finding's own words, and that is
// where the residual fabrications live: the model cites a real turn about the
// client's weight and writes "172 lbs" into the concern, a figure that appears
// nowhere in the session. The citation verifies — it is a genuine turn, genuinely
// about that — so every provenance signal we have reads green while a number that
// was never spoken sits in a clinical record.
//
// A number is the one kind of invented detail that can be caught without a model
// and without a judgement call. Prose can be paraphrased in a hundred faithful
// ways; 172 is either in the transcript or it is not. So this checks exactly
// that and nothing more — no plausibility, no clinical reasoning, no thresholds.
//
// FLAG, NEVER DROP, for the same reason as the evidence check: an extraction
// that quietly deletes "172 lbs" leaves Nicole with a concern that reads fine and
// is missing the fact she would have questioned.
//
// Only STRING fields are checked. Numeric fields are derived by design —
// due_in_days is 28 because someone said "four weeks", units_per_dose is 2
// because someone said "twice" — and demanding the digit appear verbatim would
// flag the pipeline working correctly.

/** Words that carry a number, and what they are worth. */
const WORD_VALUES: Record<string, number> = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8,
  nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15,
  sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20, thirty: 30,
  forty: 40, fourty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90,
  // Ordinals: "the third visit" is where "3 visits" comes from.
  first: 1, second: 2, third: 3, fourth: 4, fifth: 5, sixth: 6, seventh: 7,
  eighth: 8, ninth: 9, tenth: 10, twelfth: 12,
  // Quantity words a practitioner uses instead of a figure. "A couple of years
  // ago" is where an extracted "2 years" legitimately comes from, and flagging
  // it would train Nicole to ignore the flag.
  couple: 2, pair: 2, dozen: 12, half: 0.5, once: 1, twice: 2, thrice: 3,
  single: 1, double: 2, triple: 3, both: 2,
};
const MULTIPLIERS: Record<string, number> = { hundred: 100, thousand: 1000 };

/**
 * Every number the transcript states, in digits, however it was said.
 *
 * Compounds are emitted whole AND in parts: "one hundred seventy two" yields
 * 172, 100, 70 and 2. The parts are what keep this from crying fabrication over
 * an extraction that wrote "70" from "seventy-two pounds" — a rounding, not an
 * invention. Erring permissive is deliberate: a flag on a real finding costs
 * Nicole's attention, which is the resource this whole layer exists to spend
 * carefully.
 */
export function statedNumbers(transcript: string): Set<number> {
  const found = new Set<number>();
  // Digits as written, commas and decimals included: "1,200" and "2.5".
  for (const m of transcript.matchAll(/\d[\d,]*(?:\.\d+)?/g)) {
    const n = Number(m[0].replace(/,/g, ''));
    if (Number.isFinite(n)) found.add(n);
  }

  const words = transcript
    .toLowerCase()
    .replace(/[^a-z\s-]/g, ' ')
    .split(/[\s-]+/)
    .filter(Boolean);

  let current = 0;
  let running = false;
  const flush = (): void => {
    if (running) found.add(current);
    current = 0;
    running = false;
  };
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    let value = WORD_VALUES[w];
    if (value !== undefined) {
      found.add(value);
      // "seventy two" is 72, not a 70 next to a 2.
      if (value >= 20 && value % 10 === 0) {
        const next = WORD_VALUES[words[i + 1]];
        if (next !== undefined && next >= 1 && next <= 9) {
          found.add(next);
          value += next;
          found.add(value);
          i++;
        }
      }
      // The one that matters most, because it is how a weight and a blood
      // pressure are actually said: "one seventy-two" is 172, and the extraction
      // writing "172 lbs" is copying it, not inventing it. Reading that as
      // 1 + 72 is how a correct finding gets called a fabrication.
      if (current >= 1 && current <= 9 && value >= 10) current = current * 100 + value;
      else current += value;
      found.add(current);
      running = true;
      continue;
    }
    const mult = MULTIPLIERS[w];
    if (mult !== undefined) {
      current = (current || 1) * mult;
      found.add(current);
      running = true;
      continue;
    }
    // "and" sits inside a spoken number ("a hundred and seventy two") and
    // nowhere else that matters, so it alone does not end the run.
    if (w === 'and' && running) continue;
    flush();
  }
  flush();

  return found;
}

/** The numbers a piece of extracted text asserts. */
function assertedNumbers(text: string): number[] {
  const out: number[] = [];
  for (const m of text.matchAll(/\d[\d,]*(?:\.\d+)?/g)) {
    const n = Number(m[0].replace(/,/g, ''));
    if (Number.isFinite(n)) out.push(n);
  }
  return out;
}

export interface UnstatedNumber {
  /** Dotted field path, matching the evidence paths: "concerns.0". */
  path: string;
  /** The extracted text, so review reads the claim rather than the figure. */
  value: string;
  /** The figures in it that the transcript never states. */
  numbers: number[];
}

/**
 * Field paths whose digits are not claims about the session.
 *
 * A product name is the obvious one: "Bio-D 5000" is spelled by the catalog, not
 * transcribed from speech, so its digits say nothing about what was said. The
 * name has its own correctness check (matchCatalog) and its own failure mode.
 */
const SKIP = /^supplements\.\d+\.(name|name_raw|change_raw)$/;

/** Walk every string in the note, skipping the server's own bookkeeping. */
function walkStrings(
  value: unknown,
  path: string,
  visit: (path: string, text: string) => void,
): void {
  if (typeof value === 'string') {
    if (!SKIP.test(path)) visit(path, value);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((v, i) => walkStrings(v, path ? `${path}.${i}` : String(i), visit));
    return;
  }
  if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      // `evidence` is checked against the transcript by verifyEvidence, and
      // `extraction` is ours — neither is a finding.
      if (!path && (k === 'evidence' || k === 'extraction')) continue;
      walkStrings(v, path ? `${path}.${k}` : k, visit);
    }
  }
}

/**
 * Findings that state a figure the session never did.
 *
 * Returns one entry per field, not per number, because that is the unit review
 * acts on: Nicole reads the concern and decides, she does not adjudicate a 172.
 */
export function findUnstatedNumbers(
  note: Pick<SessionNote, 'concerns'> & Record<string, unknown>,
  transcript: string,
): UnstatedNumber[] {
  const stated = statedNumbers(transcript);
  const out: UnstatedNumber[] = [];
  walkStrings(note, '', (path, text) => {
    const unstated = assertedNumbers(text).filter((n) => !stated.has(n));
    if (unstated.length) out.push({ path, value: text, numbers: unstated });
  });
  return out;
}
