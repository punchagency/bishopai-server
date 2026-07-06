import { parseDailyDose } from '../../refills/project';

// Map a free-text supplement dose (e.g. "2 caps twice daily") + bottle quantity
// into Fullscript's structured recommendation dosage. Every value emitted is one
// of the enum strings the API accepts (verified against the OpenAPI spec); we
// only include a field when we can parse it confidently — sending a wrong enum
// would be rejected, and omission is safe (all dosage fields are optional).

export type DoseFrequency =
  | 'once per day' | 'twice per day' | 'three times per day' | 'four times per day' | 'every morning' | 'every night';
export type DoseFormat =
  | 'capsule' | 'chewable' | 'gel' | 'liquid' | 'lozenge' | 'packet' | 'pellet' | 'drops' | 'powder' | 'strip' | 'suppository' | 'tablet';
export type DoseTime = 'upon waking' | 'morning' | 'afternoon' | 'evening' | 'bedtime';

export interface FullscriptDosage {
  amount?: string; // "1", "1-2", "1/2"
  frequency?: DoseFrequency;
  format?: DoseFormat;
  duration?: string; // number of days, or "as needed" / "ongoing"
  time_of_day?: DoseTime[];
}

// Order matters: match the more specific frequencies before the generic "daily".
const FREQUENCY: ReadonlyArray<[RegExp, DoseFrequency]> = [
  [/\b(?:qid|four times|4\s*x)\b/, 'four times per day'],
  [/\b(?:tid|three times|thrice|3\s*x)\b/, 'three times per day'],
  [/\b(?:bid|twice|two times|2\s*x)\b/, 'twice per day'],
  [/\b(?:each|every)\s+morning\b/, 'every morning'],
  [/\b(?:nightly|each night|every night|at night|before bed|bedtime|qhs)\b/, 'every night'],
  [/\b(?:qd|once|one time|1\s*x|daily|per day|a day)\b/, 'once per day'],
];

const FORMAT: ReadonlyArray<[RegExp, DoseFormat]> = [
  [/\bcaps?|capsules?\b/, 'capsule'],
  [/\btab(?:let)?s?\b/, 'tablet'],
  [/\bsoftgels?|gels?\b/, 'gel'],
  [/\bscoops?|powder\b/, 'powder'],
  [/\bdrops?\b/, 'drops'],
  [/\bgummies|gummy|chewables?\b/, 'chewable'],
  [/\blozenges?\b/, 'lozenge'],
  [/\bpackets?|sachets?\b/, 'packet'],
  [/\bliquid\b/, 'liquid'],
];

const TIMES: ReadonlyArray<[RegExp, DoseTime]> = [
  [/\bupon waking\b/, 'upon waking'],
  [/\bmorning\b/, 'morning'],
  [/\bafternoon\b/, 'afternoon'],
  [/\bevening\b/, 'evening'],
  [/\b(?:night|nightly|bedtime|before bed)\b/, 'bedtime'],
];

// A count directly attached to a form word ("2 caps", "1-2 capsules", "1/2 tab").
// Requiring the form word avoids grabbing a strength like the "400" in "400mg".
const AMOUNT =
  /(\d+(?:\s*[-–]\s*\d+|\/\d+)?)\s*(?:caps?|capsules?|tab(?:let)?s?|softgels?|gels?|scoops?|drops?|gummies|gummy|lozenges?|packets?|sachets?|pills?)\b/;

export function parseFullscriptDosage(
  dose: string | null | undefined,
  qty?: number | null,
): FullscriptDosage | undefined {
  const out: FullscriptDosage = {};
  const s = (dose ?? '').toLowerCase();

  if (s) {
    const amt = s.match(AMOUNT);
    if (amt) out.amount = amt[1].replace(/\s*[-–]\s*/, '-');

    for (const [re, freq] of FREQUENCY) if (re.test(s)) { out.frequency = freq; break; }
    for (const [re, fmt] of FORMAT) if (re.test(s)) { out.format = fmt; break; }

    const times = TIMES.filter(([re]) => re.test(s)).map(([, t]) => t);
    if (times.length) out.time_of_day = [...new Set(times)];
  }

  // Days-supply from the bottle quantity (how long it lasts) → duration.
  if (typeof qty === 'number' && qty > 0 && s) {
    const perDay = parseDailyDose(dose ?? undefined);
    const days = Math.floor(qty / perDay);
    if (days > 0) out.duration = String(days);
  }

  return Object.keys(out).length ? out : undefined;
}
