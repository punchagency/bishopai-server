// Transcript preparation: parse → attribute speakers → compact → chunk.
//
// Everything upstream of the LLM lives here, and it exists because the raw input
// is worse than it looks. Otter labels speakers "Speaker 1" / "Speaker 2" and its
// diarization flips mid-session: in the real Health Supplement Consultation
// transcript, "Speaker 1" says "what we're doing is adding in a B vitamin" at
// 0:02, "Speaker 2" says "Close your eyes. Pinky thumb together" at 0:42, and
// "Speaker 1" says "the central nervous system is clear" at 1:30 — all three are
// the practitioner. Half the SessionNote schema is split on exactly that
// distinction (concerns = what the CLIENT reports, assessments = the
// PRACTITIONER's conclusions), so leaving the model to guess it means guessing
// whether a sentence lands on the internal sheet or the client's Report of
// Findings.
//
// So: attribute per TURN, not per speaker label, and where a turn is genuinely
// ambiguous say so rather than picking. An UNKNOWN turn is content Nicole can
// still see; a misattributed one is a clinical record with the wrong person's
// words in it.

export type Role = 'PRACTITIONER' | 'CLIENT' | 'UNKNOWN';

export interface Turn {
  /**
   * Stable address of this turn within the session, and the unit the model cites
   * findings against.
   *
   * Global and assigned ONCE, after merging — never a position in whatever array
   * happens to be in hand. Compaction drops turns and chunking slices them, so a
   * positional index would mean something different in every stage: the model
   * would cite #12 of a compacted narrative and the server would resolve #12 of
   * the full transcript. Carrying the number on the turn makes every stage agree
   * on what a citation points at.
   */
  index: number;
  /** Original speaker label as written by the transcription tool. */
  speaker: string;
  /** Seconds from session start, when the transcript carries a timestamp. */
  startSeconds: number | null;
  text: string;
  /** Offset of `text` in the original transcript — provenance survives every
   *  transform below, so a quote can always be traced back to the source. */
  charOffset: number;
  role: Role;
  /** Attribution margin (practitioner score − client score). 0 means ambiguous. */
  roleConfidence: number;
}

/** Stamp sequential global indices. Call after merging, before anything slices. */
export function indexTurns(turns: Turn[]): Turn[] {
  return turns.map((t, i) => ({ ...t, index: i }));
}

// "Speaker 1  0:02" / "Speaker 1:" / "#47 SPEAKER 02" / "Nicole 12:03" / "[00:12:03] Speaker 2"
const SPEAKER_LINE =
  /^[ \t]*(?<hash>#\d+[ \t]+)?(?:\[(?<lead>\d{1,2}:\d{2}(?::\d{2})?)\][ \t]*)?(?<name>[A-Za-z][\w .'()-]{0,40}?)[ \t]*:?[ \t]*(?<time>\d{1,2}:\d{2}(?::\d{2})?)?[ \t]*$/;

// The other shape, and the one the live recorder actually produces:
// "SPEAKER_00: And it flares up here and there." — label and utterance on ONE
// line, no timestamp. The seeded transcripts use it too ("Nicole: ...").
//
// This cannot be detected per-line, because "So here's the thing: I was tired"
// looks identical to a speaker line. What separates them is repetition: a real
// speaker label recurs throughout the transcript, an accidental one appears
// once. So candidates are gathered first and only accepted as labels if they
// behave like labels across the whole document.
const INLINE_SPEAKER =
  /^[ \t]*(?:\[(?<lead>\d{1,2}:\d{2}(?::\d{2})?)\][ \t]*)?(?<name>[A-Za-z][\w .'()-]{0,30}?)[ \t]*:[ \t]+(?<text>\S.*)$/;

/**
 * Does this look like a person's name rather than the start of a sentence?
 *
 * "Nicole", "Marta", "SPEAKER_00", "Speaker 1" — every word capitalised, all
 * caps, or a number. "Stressors are food" is not: a mid-sentence colon is the
 * false positive that would shred a turn in half, and lowercase interior words
 * are what give it away.
 */
function looksLikeName(label: string): boolean {
  // Diarization tools bracket the raw channel onto the role — "CLIENT (SPEAKER
  // 01)" — so the parens are part of the label, not prose. Strip them before
  // the capitalisation test and allow the extra words they add.
  const words = label
    .replace(/[()]/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
  if (words.length === 0 || words.length > 4) return false;
  return words.every((w) => /^\d+$/.test(w) || /^[A-Z][\w.'-]*$/.test(w));
}

/** Labels that recur often enough, and look enough like names, to be speakers. */
function detectInlineLabels(lines: string[]): Set<string> {
  const counts = new Map<string, number>();
  let nonEmpty = 0;
  for (const line of lines) {
    if (!line.trim()) continue;
    nonEmpty++;
    const name = line.match(INLINE_SPEAKER)?.groups?.name?.trim();
    if (!name || !looksLikeName(name)) continue;
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  if (nonEmpty === 0) return new Set();

  // A real speaker label recurs; a one-off is punctuation that happened to fit.
  const repeated = [...counts.entries()].filter(([, n]) => n >= 2);
  // Too many distinct labels means we're matching prose, not diarization.
  if (repeated.length === 0 || repeated.length > 12) return new Set();
  // A low floor on purpose: when a turn wraps across several lines only the
  // first carries the label, so coverage in a well-formed dialogue can sit near
  // a fifth. The name shape above is what excludes prose, not this ratio.
  const covered = repeated.reduce((n, [, c]) => n + c, 0);
  if (covered / nonEmpty < 0.15) return new Set();

  // The repeated labels establish that this transcript IS speaker-prefixed
  // dialogue. Once that's settled, a name-shaped label appearing only once is a
  // participant who spoke once, not punctuation — and dropping it is not
  // harmless: their lines fold into the previous speaker's turn, which then
  // merges away entirely and attributes their words to someone else.
  if (counts.size <= 12) return new Set(counts.keys());
  return new Set(repeated.map(([name]) => name));
}

function toSeconds(stamp: string | undefined): number | null {
  if (!stamp) return null;
  const parts = stamp.split(':').map(Number);
  if (parts.some(Number.isNaN)) return null;
  // mm:ss or hh:mm:ss
  return parts.length === 3
    ? parts[0] * 3600 + parts[1] * 60 + parts[2]
    : parts[0] * 60 + parts[1];
}

/**
 * Parse a transcript into turns. Handles the Otter shape (a speaker/timestamp
 * line followed by the utterance) and degrades gracefully: a transcript with no
 * recognizable speaker lines comes back as a single UNKNOWN turn holding the
 * whole text, so every downstream stage still works on unstructured input.
 */
export function parseTranscript(raw: string): Turn[] {
  const lines = raw.split(/\r?\n/);
  const turns: Turn[] = [];
  let current: { speaker: string; startSeconds: number | null; body: string[]; offset: number } | null =
    null;
  let offset = 0;

  const flush = (): void => {
    if (!current) return;
    const text = current.body.join('\n').trim();
    if (text) {
      turns.push({
        index: turns.length,
        speaker: current.speaker,
        startSeconds: current.startSeconds,
        text,
        charOffset: current.offset,
        role: 'UNKNOWN',
        roleConfidence: 0,
      });
    }
    current = null;
  };

  const inlineLabels = detectInlineLabels(lines);

  for (const line of lines) {
    const lineStart = offset;
    offset += line.length + 1; // +1 for the newline we split on

    if (inlineLabels.size) {
      const inline = line.match(INLINE_SPEAKER);
      const name = inline?.groups?.name?.trim();
      if (name && inlineLabels.has(name)) {
        flush();
        current = {
          speaker: name,
          startSeconds: toSeconds(inline?.groups?.lead),
          body: [inline?.groups?.text ?? ''],
          // Offset of the utterance itself, not the label.
          offset: lineStart + line.indexOf(inline?.groups?.text ?? ''),
        };
        continue;
      }
      // A continuation line inside the current speaker's turn.
      if (!current) {
        if (!line.trim()) continue;
        current = { speaker: 'UNKNOWN', startSeconds: null, body: [], offset: lineStart };
      }
      current.body.push(line);
      continue;
    }

    const m = line.match(SPEAKER_LINE);
    // A header must have a timestamp OR be short and followed by content; a bare
    // sentence that happens to end in a colon is not a speaker change.
    //
    // The `#47 SPEAKER 02` shape carries no timestamp at all, so the turn number
    // is what marks it as a header. That is only safe with the name test: "#5
    // minutes later" fits the same regex and is prose, and lowercase interior
    // words are what separate the two.
    const hashHeader =
      !!m?.groups?.hash && !!m.groups.name && looksLikeName(m.groups.name.trim());
    if (m?.groups && (m.groups.time || m.groups.lead || hashHeader) && m.groups.name) {
      flush();
      current = {
        speaker: m.groups.name.trim(),
        startSeconds: toSeconds(m.groups.time ?? m.groups.lead),
        body: [],
        offset: lineStart + line.length + 1,
      };
      continue;
    }
    if (!current) {
      if (!line.trim()) continue;
      current = { speaker: 'UNKNOWN', startSeconds: null, body: [], offset: lineStart };
    }
    current.body.push(line);
  }
  flush();

  if (turns.length === 0 && raw.trim()) {
    return [
      {
        index: 0,
        speaker: 'UNKNOWN',
        startSeconds: null,
        text: raw.trim(),
        charOffset: 0,
        role: 'UNKNOWN',
        roleConfidence: 0,
      },
    ];
  }
  return turns;
}

// --- Speaker attribution -----------------------------------------------------

/**
 * Otter fragments a conversation hard: the real transcripts here produce 178–192
 * turns and up to TEN speaker labels for a two-person session. Most fragments are
 * too short to carry any signal ("Yeah.", "Okay."), which starves per-turn
 * scoring. Gluing adjacent same-label turns back together produces fewer, richer
 * turns to score, and costs nothing — consecutive turns under the same label were
 * one utterance before the transcriber split them.
 *
 * Only merges across a small time gap: the same label reappearing five minutes
 * later is a different utterance, and possibly a different person.
 *
 * And only up to `maxWords`. The gap guard silently does nothing on a transcript
 * with no timestamps — a null start makes every gap read as 0 — which is exactly
 * the shape the live recorder produces, so merging there had no brake at all. On
 * Patricia's session that glued a 272-word source turn into a 498-word one.
 *
 * That matters beyond tidiness: a turn is the unit a finding is cited against,
 * and verification asks whether the cited turn says the thing. A 498-word turn
 * re-creates the wide matching window the verifier deliberately dropped, and it
 * is where that session's one real fabrication hid. Merging exists to give
 * speaker attribution richer turns to score, and it gets that from a paragraph
 * just as well as from a page.
 */
/**
 * A goodbye to one client followed by a hello to the next — the seam between two
 * consultations in a back-to-back recording.
 *
 * These live here, in the turn layer, rather than in the segmenter that needs
 * them, because the merge below has to know about them too and the dependency
 * only runs one way. Two copies of "what a handover looks like" would drift, and
 * the drift would be invisible: the merge would fuse a seam the segmenter was
 * still looking for.
 *
 * Anchored to the EDGES rather than searched across the whole turn. A farewell
 * belongs at the end of what someone was saying and a greeting at the start of
 * what they say next; a "take care" in the middle of a sentence about a client's
 * mother is not a handover, and matching it anywhere would split sessions apart
 * on ordinary conversation.
 */
const HANDOVER_EDGE_CHARS = 80;
const FAREWELL_RE = /\b(all right.*see you|see you|bye|take care|have a good day|goodbye)\b/i;
const GREETING_RE = /\b(hi|hello|welcome|introduce yourself|good to see you|how are you|hey|come on in|have a seat|what brings you|next patient)\b/i;

/** True when `before` ends by saying goodbye and `after` opens by saying hello. */
export function looksLikeHandover(before: string, after: string): boolean {
  const tail = before.slice(-HANDOVER_EDGE_CHARS);
  const head = after.slice(0, HANDOVER_EDGE_CHARS);
  return FAREWELL_RE.test(tail) && GREETING_RE.test(head);
}

/** Exported for the segmenter, which scores the same two signals across turns
 *  that this refused to merge. One definition, two readers. */
export const HANDOVER_PATTERNS = { FAREWELL_RE, GREETING_RE } as const;

export function mergeAdjacentTurns(turns: Turn[], maxGapSeconds = 30, maxWords = 120): Turn[] {
  const out: Turn[] = [];
  // Track lengths alongside, so a long run of merges stays linear rather than
  // re-counting the accumulated text on every step.
  const lengths: number[] = [];
  const countWords = (s: string): number => s.split(/\s+/).filter(Boolean).length;

  for (const t of turns) {
    const prev = out[out.length - 1];
    const gap =
      prev && prev.startSeconds != null && t.startSeconds != null
        ? t.startSeconds - prev.startSeconds
        : 0;
    const words = countWords(t.text);
    if (
      prev &&
      prev.speaker === t.speaker &&
      gap <= maxGapSeconds &&
      lengths[lengths.length - 1] + words <= maxWords &&
      // Never merge across a session handover.
      //
      // This is the one place where two turns under the same label are NOT one
      // utterance: in a back-to-back recording the practitioner says goodbye to
      // one client and hello to the next without anyone else speaking, and
      // merging fuses the seam into a single turn. The damage is not cosmetic —
      // a boundary is a turn index, so once the farewell and the greeting are
      // the same turn there is no index that separates them, and the incoming
      // client's greeting (a direct address, the strongest identity signal we
      // have) lands inside the OUTGOING client's segment. Measured on a
      // two-appointment recording that swapped both clients outright.
      !looksLikeHandover(prev.text, t.text)
    ) {
      prev.text = `${prev.text} ${t.text}`;
      lengths[lengths.length - 1] += words;
      continue;
    }
    out.push({ ...t });
    lengths.push(words);
  }
  return out;
}

// Second person vs first person is the most reliable ROLE signal in a clinical
// interview, and unlike a keyword list it generalizes past this practice's
// vocabulary: the practitioner asks and instructs ("how are YOUR bowels", "take
// two of these"), the client narrates their own body ("I've been so tired", "my
// sleep is off"). Everything below is a refinement on top of that.
const SECOND_PERSON = /\b(?:you|your|you're|you've|yourself)\b/gi;
const FIRST_PERSON = /\b(?:i|i'm|i've|my|me|mine|myself)\b/gi;

function countMatches(text: string, re: RegExp): number {
  return (text.match(re) ?? []).length;
}

// The muscle-testing script. Nicole says these; a client never does. They're the
// single most reliable practitioner signal in an NRT transcript because the
// procedure is verbatim-repetitive.
const PRACTITIONER_PATTERNS: [RegExp, number][] = [
  [/\b(?:close|open) your eyes\b/i, 3],
  [/\bpinky (?:and|thumb)|thumb together|ring finger\b/i, 3],
  [/\bfingertips? together|place all (?:ten|10)\b/i, 3],
  [/\bopen your hand|pop the elbows\b/i, 3],
  [/\bbelly button\b/i, 2],
  // Plan language — the practitioner owns the protocol.
  [/\b(?:we're|we are|we'll|we will) (?:going to |gonna )?(?:add|start|stop|take you off|switch|keep)\b/i, 3],
  [/\bi want you to\b/i, 2],
  [/\blet's (?:add|start|stop|keep|try|go ahead)\b/i, 2],
  [/\b(?:take|takes?) (?:one|two|three|1|2|3) (?:cap|capsule|tab|tablet|scoop)/i, 2],
  [/\b(?:with|before|after) (?:breakfast|lunch|dinner|bed)\b/i, 1],
  // Clinical vocabulary.
  [/\b(?:central nervous system|hpa axis|adrenal|pituitary|gallbladder|cortisol|parasympathetic)\b/i, 2],
  [/\b(?:is|are) (?:clear|offline|stressed|blocked|holding|negative|positive)\b/i, 2],
  [/\b(?:priority|matrix|ectoderm|foundation|body scan|k[- ]?27|hta)\b/i, 2],
  [/\bwe're finding|i'm seeing|what i'm getting\b/i, 2],
];

const CLIENT_PATTERNS: [RegExp, number][] = [
  [/\bi(?:'ve| have) been (?:having|feeling|getting)\b/i, 3],
  [/\bmy (?:sleep|energy|stomach|pain|cycle|period|digestion|anxiety|headaches?)\b/i, 3],
  [/\bi (?:feel|felt|noticed|can't|cannot|couldn't|didn't|haven't)\b/i, 2],
  [/\bi (?:take|took|started|stopped) (?:the|my|it)\b/i, 1],
  [/\bit (?:hurts|helps|helped|got worse|got better)\b/i, 2],
];

function patternScore(text: string, patterns: [RegExp, number][]): number {
  let total = 0;
  for (const [re, weight] of patterns) if (re.test(text)) total += weight;
  return total;
}

/** Practitioner / client evidence for one turn, from all features. */
function scoreTurn(text: string): { p: number; c: number } {
  let p = patternScore(text, PRACTITIONER_PATTERNS);
  let c = patternScore(text, CLIENT_PATTERNS);

  // Pronoun lean. Capped so a long turn can't swamp the keyword evidence, and
  // scaled by the margin so a turn using both pronouns evenly stays neutral.
  const second = countMatches(text, SECOND_PERSON);
  const first = countMatches(text, FIRST_PERSON);
  const margin = Math.min(4, Math.abs(second - first));
  if (second > first) p += margin;
  else if (first > second) c += margin;

  // The practitioner runs the interview, so questions lean practitioner — but
  // only when they aren't also narrating in first person ("I don't know, should
  // I keep taking it?" is the client).
  const questions = countMatches(text, /\?/g);
  if (questions > 0 && second >= first) p += Math.min(2, questions);

  return { p, c };
}

/**
 * Label every turn PRACTITIONER / CLIENT / UNKNOWN.
 *
 * Direct per-turn evidence decides. Where a turn has none, we fall back to the
 * speaker LABEL's aggregate lean — but only when the transcript's labels look
 * trustworthy at all. With ten labels for a two-person session (the real case
 * here) they carry no information, and a confident wrong attribution is exactly
 * the failure this module exists to prevent. In that regime an unscored turn
 * stays UNKNOWN, and the prompt is told not to attribute it. Backchannels
 * ("Yeah.", "Okay.") make up most of those turns and carry no clinical content,
 * so the cost is far lower than the count of UNKNOWN turns suggests.
 */
export function attributeSpeakers(turns: Turn[]): Turn[] {
  const scored = turns.map((t) => ({ turn: t, ...scoreTurn(t.text) }));

  const labels = new Set(turns.map((t) => t.speaker));
  // Two or three labels for a two-person session is plausible diarization; more
  // than that means the tool was guessing, and so would we be.
  const labelsTrustworthy = labels.size > 0 && labels.size <= 3;

  const byLabel = new Map<string, { p: number; c: number }>();
  if (labelsTrustworthy) {
    for (const { turn, p, c } of scored) {
      const agg = byLabel.get(turn.speaker) ?? { p: 0, c: 0 };
      agg.p += p;
      agg.c += c;
      byLabel.set(turn.speaker, agg);
    }
  }

  return scored.map(({ turn, p, c }) => {
    if (p !== c) {
      return {
        ...turn,
        role: p > c ? ('PRACTITIONER' as const) : ('CLIENT' as const),
        roleConfidence: Math.abs(p - c),
      };
    }
    // No direct evidence. confidence stays 0 so callers can tell a prior from a
    // reading.
    const agg = byLabel.get(turn.speaker);
    const lean = agg ? agg.p - agg.c : 0;
    const total = agg ? agg.p + agg.c : 0;
    const role: Role =
      total >= 6 && Math.abs(lean) / total >= 0.6
        ? lean > 0
          ? 'PRACTITIONER'
          : 'CLIENT'
        : 'UNKNOWN';
    return { ...turn, role, roleConfidence: 0 };
  });
}

/** Share of transcript WORDS that got a role. The count of UNKNOWN turns
 *  overstates the problem — most are one-word backchannels. */
export function attributionCoverage(turns: Turn[]): number {
  let total = 0;
  let attributed = 0;
  for (const t of turns) {
    const words = t.text.split(/\s+/).filter(Boolean).length;
    total += words;
    if (t.role !== 'UNKNOWN') attributed += words;
  }
  return total === 0 ? 1 : attributed / total;
}

/**
 * Render attributed turns back to text for the prompt, with real role labels and
 * the turn's global number.
 *
 * The `#n` is what the model cites findings against. Numbering the source it is
 * already reading costs nothing and turns provenance from prose the model has to
 * reproduce from memory into a reference it only has to point at — and pointing
 * is checkable, where reproducing is not.
 */
export function renderTurns(turns: Turn[]): string {
  return turns
    .map((t) => {
      const stamp = t.startSeconds != null ? ` [${formatStamp(t.startSeconds)}]` : '';
      return `#${t.index} ${t.role}${stamp}: ${t.text}`;
    })
    .join('\n\n');
}

/** Turns keyed by their global index, for resolving a citation back to source. */
export function turnsByIndex(turns: Turn[]): Map<number, Turn> {
  return new Map(turns.map((t) => [t.index, t]));
}

export function formatStamp(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

// --- Compaction --------------------------------------------------------------

// The muscle-testing procedure is spoken aloud and repeated dozens of times per
// session ("Pinky and thumb. Add your ring finger. Open your hand."). It's pure
// volume for the narrative pass — it says nothing about what the client is
// worried about or what they want. Dropping it buys back context budget where it
// matters.
const BOILERPLATE =
  /\b(?:close your eyes|open your eyes|pinky (?:and|thumb)|thumb together|add your ring finger|open your hand|back to (?:your|the) pinky|fingertips? together|place all (?:ten|10)|center of your chest|pop the elbows|stay there|good,? much better|hold that)\b/gi;

/** Share of a turn's words that belong to the muscle-testing script. */
function boilerplateRatio(text: string): number {
  const words = text.split(/\s+/).filter(Boolean).length;
  if (words === 0) return 1;
  let covered = 0;
  for (const m of text.matchAll(BOILERPLATE)) covered += m[0].split(/\s+/).length;
  return covered / words;
}

/**
 * Drop turns that are almost entirely muscle-testing instructions.
 *
 * NARRATIVE STAGE ONLY. The NRT findings are interleaved with exactly this
 * boilerplate — "Okay, so the central nervous system is clear" arrives in the
 * middle of the hand-position script — so compacting the NRT input would delete
 * the readings we're trying to extract.
 */
export function compactForNarrative(turns: Turn[], threshold = 0.5): Turn[] {
  return turns.filter((t) => boilerplateRatio(t.text) < threshold);
}

// --- Session-restart detection ----------------------------------------------

/**
 * Words spoken when someone ARRIVES. A single consultation contains exactly one
 * of these exchanges, at the top, so a second one deeper in the recording means
 * a second person walked in.
 *
 * This exists because every other multi-session signal is blind to the case that
 * actually happens most often here. Nicole records back-to-back clients
 * continuously, and when two consultations are cleanly sequential the diarizer
 * does NOT open new labels for them — it reuses SPEAKER_01 for the second
 * client, because it is separating voices, not people. Measured on the
 * 2026-08-21 recording (`92f683ed`, 180 turns, two clients): two speaker labels,
 * so the >=4-label signal cannot fire, and no client name is ever spoken, so the
 * foreign-name signal cannot fire either. What IS in the transcript, in plain
 * words, is one client saying goodbye and the next saying hello.
 */
const ARRIVAL_GREETING =
  /\b(hi|hello|hey|welcome|come on in|come in|have a seat|good to see you|nice to see you|what brings you|next patient)\b/i;

/**
 * Spoken in an arrival exchange, but also constantly in the middle of one
 * ("how are you" is small talk as often as it is a greeting). It may ANSWER an
 * arrival greeting; it may never open one on its own. Requiring the opener to
 * be an ARRIVAL_GREETING is what keeps mid-session chat from scoring.
 */
const STATUS_GREETING = /\b(how are you|how are we|how(?:'ve| have) you been|how you doing)\b/i;

/** Below this a recording is too short to plausibly hold two consultations. */
const MIN_TURNS_FOR_RESTART = 30;
/** The opening greeting is legitimate; only look past it. */
const MIN_OPENING_TURNS = 8;
const OPENING_SHARE = 0.1;
/** A greeting is answered immediately or it was not a greeting. */
const GREETING_REPLY_WINDOW = 2;

/**
 * The turn at which a NEW consultation appears to begin, or null.
 *
 * Deliberately requires a two-party EXCHANGE — an arrival greeting from one
 * speaker answered by a different speaker within a turn or two — rather than a
 * lone "hi". A practitioner greeting someone at the door mid-session, or a
 * stray "hey" inside a sentence, does not produce an exchange; an arriving
 * client does.
 *
 * Returns a 1-based index in `parseTurns` numbering, which is what the review
 * UI renders and what the splitter's `from_turn`/`to_turn` mean. `parseTranscript`
 * numbering is NOT the same (it does not merge adjacent same-speaker turns:
 * 208 vs 180 on the recording above) and mixing the two silently moves a cut.
 */
export function findSessionRestart(raw: string): number | null {
  const turns = prepareTurns(raw);
  if (turns.length < MIN_TURNS_FOR_RESTART) return null;

  const openingEnd = Math.max(MIN_OPENING_TURNS, Math.ceil(turns.length * OPENING_SHARE));
  for (let i = openingEnd; i < turns.length - 1; i++) {
    if (!ARRIVAL_GREETING.test(turns[i].text)) continue;
    const limit = Math.min(i + GREETING_REPLY_WINDOW, turns.length - 1);
    for (let j = i + 1; j <= limit; j++) {
      if (turns[j].speaker === turns[i].speaker) continue;
      if (ARRIVAL_GREETING.test(turns[j].text) || STATUS_GREETING.test(turns[j].text)) {
        return turns[i].index + 1;
      }
    }
  }
  return null;
}

// --- Sizing + chunking -------------------------------------------------------

/** Rough token estimate. ~4 chars/token is close enough to size a budget, and
 *  avoids a tokenizer dependency that would differ per provider anyway. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export interface Chunk {
  turns: Turn[];
  index: number;
  total: number;
  startSeconds: number | null;
  endSeconds: number | null;
}

/**
 * Split turns into overlapping chunks on TURN boundaries.
 *
 * Never splits mid-turn: half an utterance is worse than none, because a
 * fragment reads as a complete statement to the model. Consecutive chunks
 * overlap by `overlapTurns` so a finding straddling a boundary is seen whole by
 * at least one chunk — the merge dedupes the double-capture, which is the cheap
 * direction of that trade.
 */
export function chunkTurns(
  turns: Turn[],
  opts: { targetTokens?: number; overlapTurns?: number } = {},
): Chunk[] {
  const targetTokens = opts.targetTokens ?? 3000;
  const overlapTurns = opts.overlapTurns ?? 2;
  if (turns.length === 0) return [];

  const groups: Turn[][] = [];
  let currentGroup: Turn[] = [];
  let currentTokens = 0;

  for (const turn of turns) {
    const cost = estimateTokens(turn.text) + 8; // + role/timestamp header
    // A single turn over budget still gets its own chunk — splitting it would
    // break the never-split-a-turn rule for no accuracy gain.
    if (currentGroup.length && currentTokens + cost > targetTokens) {
      groups.push(currentGroup);
      currentGroup = currentGroup.slice(-overlapTurns);
      currentTokens = currentGroup.reduce((n, t) => n + estimateTokens(t.text) + 8, 0);
    }
    currentGroup.push(turn);
    currentTokens += cost;
  }
  if (currentGroup.length) groups.push(currentGroup);

  return groups.map((g, i) => ({
    turns: g,
    index: i,
    total: groups.length,
    startSeconds: g.find((t) => t.startSeconds != null)?.startSeconds ?? null,
    endSeconds: [...g].reverse().find((t) => t.startSeconds != null)?.startSeconds ?? null,
  }));
}

export interface PreparedTranscript {
  raw: string;
  turns: Turn[];
  /** Attributed + rendered, for stages that want the whole session. */
  full: string;
  /** Boilerplate-stripped, for the narrative stage. */
  narrative: string;
  tokens: number;
  /** Share of words that got a role — a health signal worth logging. */
  attributionCoverage: number;
}

/** One-shot preparation used by the extractor. */
/**
 * The canonical turn list for a transcript — the one thing that defines what
 * "turn #12" means.
 *
 * Every consumer numbers turns through here. The segmenter used to run its own
 * parser, which merged nothing and counted from 1, so its `from_turn` and the
 * review pane's citations were two different coordinate systems over the same
 * recording and the gap grew with every merged pair. Sharing the pipeline is
 * what makes a turn number portable between them.
 */
export function prepareTurns(raw: string): Turn[] {
  // Index AFTER merging: merging collapses turns, so numbering before it would
  // leave gaps and point citations at turns that no longer exist.
  return attributeSpeakers(indexTurns(mergeAdjacentTurns(parseTranscript(raw))));
}

export function prepareTranscript(raw: string): PreparedTranscript {
  const turns = prepareTurns(raw);
  const full = renderTurns(turns);
  return {
    raw,
    turns,
    full,
    narrative: renderTurns(compactForNarrative(turns)),
    tokens: estimateTokens(full),
    attributionCoverage: attributionCoverage(turns),
  };
}
