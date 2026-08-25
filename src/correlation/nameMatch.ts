// Does the recording say who it's about?
//
// Time overlap alone decides nothing when appointments run back to back: a
// session that starts late or runs long overlaps two bookings and correlation
// correctly refuses to guess. But the transcript almost always contains the
// client's name, and that signal is currently thrown away — Nicole is shown two
// adjacent slots ordered by clock distance with nothing to tell them apart.
//
// This produces a RANKING SIGNAL ONLY. It never assigns anything on its own; a
// name in a transcript is evidence, not proof (a client can be discussed in
// someone else's session). The never-guess rule is unchanged — what changes is
// that the human choosing is given the evidence.

export interface NameSignal {
  /** How many times any form of the name is spoken. */
  mentions: number;
  /** Which form carried the strongest evidence. */
  matchedOn: 'full' | 'first' | 'last' | null;
  /** True when the name was spoken as a direct greeting/address (e.g. "Hi Steve"). */
  isDirectAddress?: boolean;
}

/** Names too short or too common to be evidence on their own. */
const MIN_PART_LENGTH = 3;

const escape = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function countOccurrences(haystack: string, needle: string): number {
  if (needle.length < MIN_PART_LENGTH) return 0;
  const re = new RegExp(`\\b${escape(needle)}\\b`, 'gi');
  return (haystack.match(re) ?? []).length;
}

function checkDirectAddress(text: string, namePart: string): boolean {
  if (namePart.length < MIN_PART_LENGTH) return false;
  const re = new RegExp(`\\b(hi|hello|welcome|hey|good morning|good afternoon|good evening)[,\\s]+${escape(namePart)}\\b`, 'i');
  return re.test(text);
}

/**
 * Score how strongly a transcript points at a given client name.
 *
 * A full-name hit outranks a first-name hit, which outranks a surname hit —
 * "Marta Reyes" said once is better evidence than "Marta" said once, and a bare
 * surname is the weakest because practitioners rarely use it in session.
 * Direct greetings ("Hi Marta") receive high priority to distinguish direct client
 * consultations from casual third-party name drops.
 */
export function scoreNameMatch(transcript: string | null | undefined, clientName: string | null | undefined): NameSignal {
  const text = transcript?.trim();
  const name = clientName?.trim();
  if (!text || !name) return { mentions: 0, matchedOn: null };

  // Demo/seed prefixes and parenthetical qualifiers aren't part of the spoken
  // name — "DEMO - Marta Reyes (multi-session)" is said aloud as "Marta".
  const cleaned = name
    .replace(/^DEMO\s*-\s*/i, '')
    .replace(/\(.*?\)/g, '')
    .trim();
  if (!cleaned) return { mentions: 0, matchedOn: null };

  const full = countOccurrences(text, cleaned);
  if (full > 0) {
    const parts = cleaned.split(/\s+/).filter(Boolean);
    const direct = checkDirectAddress(text, cleaned) || (parts[0] ? checkDirectAddress(text, parts[0]) : false);
    return { mentions: full, matchedOn: 'full', isDirectAddress: direct };
  }

  const parts = cleaned.split(/\s+/).filter(Boolean);
  if (parts.length === 0) return { mentions: 0, matchedOn: null };

  const first = countOccurrences(text, parts[0]);
  if (first > 0) {
    const direct = checkDirectAddress(text, parts[0]);
    return { mentions: first, matchedOn: 'first', isDirectAddress: direct };
  }

  const last = parts.length > 1 ? countOccurrences(text, parts[parts.length - 1]) : 0;
  if (last > 0) {
    const direct = checkDirectAddress(text, parts[parts.length - 1]);
    return { mentions: last, matchedOn: 'last', isDirectAddress: direct };
  }

  return { mentions: 0, matchedOn: null };
}

/** Rank order for the strength of a match — higher wins. */
export function nameSignalRank(s: NameSignal): number {
  if (!s.matchedOn) return 0;
  const weight = { full: 3, first: 2, last: 1 }[s.matchedOn];
  const directBonus = s.isDirectAddress ? 5000 : 0;
  // Mentions matter, but a single full-name hit must still beat five bare
  // surname hits, so the form dominates and the count only breaks ties.
  return directBonus + weight * 1000 + Math.min(s.mentions, 999);
}

/** Seconds the two windows overlap; 0 when they don't. */
export function overlapSeconds(
  aStart: string | Date,
  aEnd: string | Date,
  bStart: string | Date,
  bEnd: string | Date,
): number {
  const s = Math.max(new Date(aStart).getTime(), new Date(bStart).getTime());
  const e = Math.min(new Date(aEnd).getTime(), new Date(bEnd).getTime());
  return e > s ? Math.round((e - s) / 1000) : 0;
}
