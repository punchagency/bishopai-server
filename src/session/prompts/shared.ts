// Extraction prompts, one module per stage.
//
// Version-stamped: the version is written onto every extracted note, so an
// accuracy regression spotted weeks later can be traced back to the prompt
// change that caused it rather than guessed at.
export const PROMPT_VERSION = '2026-08-17.1';

export interface PromptContext {
  /** Who the client is. Removes the single biggest source of speaker confusion:
   *  the model no longer has to infer which participant it's reading. */
  clientName?: string | null;
  practitionerName?: string | null;
  appointmentDate?: string | null;
  /** Supplement names already known to this client / the practice — a closed
   *  vocabulary to match garbled product names against. */
  catalog?: readonly string[];
  /** When the transcript is chunked, which slice this is. */
  chunk?: { index: number; total: number; startLabel: string | null; endLabel: string | null };
}

const NEVER_GUESS = [
  'CRITICAL: record only what is explicitly stated. Never infer, guess, or fill in a',
  'plausible clinical value. A blank field is correct and expected; a fabricated one',
  'is a clinical error. If the transcript does not state something, return null (for',
  'string fields) or an empty array.',
].join('\n');

const SPEAKERS = [
  'Turns are labelled PRACTITIONER, CLIENT, or UNKNOWN. These labels were assigned',
  'by an automated pass over an imperfect transcript, so treat them as strong',
  'evidence rather than ground truth — content decides when they conflict.',
  'UNKNOWN means the speaker could not be determined. Do NOT attribute UNKNOWN',
  'content to either party: leave it out of both the client-reported fields',
  '(concerns, goals, lifestyle) and the practitioner-only fields (assessments).',
].join('\n');

const EVIDENCE = [
  'EVIDENCE (required): alongside the findings, return an `evidence` object mapping',
  'each field you filled to the place in the transcript that justifies it:',
  '  { "nrt.hta": { "turn": 214, "quote": "HTA is coming in negative", "at_seconds": 412 },',
  '    "concerns.0": { "turn": 31, "quote": "the gallbladder pain is back", "at_seconds": 96 } }',
  'Keys are dotted field paths; array items use their index (concerns.0, supplements.1).',
  '',
  'Every turn in the transcript is numbered — the `#214` at the start of the line.',
  '`turn` is that number, for the ONE turn you read the finding from. This is the',
  'part that matters most: it is checked against the transcript automatically, so a',
  'number pointing at a turn that does not say this is worse than no answer at all.',
  'If a finding is built from several turns, cite the turn that states it most',
  'directly. If you genuinely cannot point to a turn, return null — never guess a',
  'number.',
  '',
  'The quote MUST be copied verbatim from that turn and be 25 words or fewer. Copy it',
  'character for character — do not tidy, shorten, or rephrase it, and take special',
  'care with any negation ("not", "no", "never"): dropping or adding one reverses the',
  'clinical finding.',
  'at_seconds is the timestamp on that turn, or null.',
  'Do not invent evidence to justify a field — if you cannot point at it, do not fill it.',
].join('\n');

/** Preamble shared by every stage. */
export function preamble(ctx: PromptContext): string {
  const lines = [
    'You are a clinical documentation assistant for a functional-medicine practice',
    'that uses Nutrition Response Testing (NRT).',
    'Extract structured session data from an appointment transcript.',
    '',
    NEVER_GUESS,
    '',
    SPEAKERS,
  ];

  const who: string[] = [];
  if (ctx.clientName) who.push(`The CLIENT in this session is ${ctx.clientName}.`);
  if (ctx.practitionerName) who.push(`The PRACTITIONER is ${ctx.practitionerName}.`);
  if (ctx.appointmentDate) who.push(`The appointment date is ${ctx.appointmentDate}.`);
  if (who.length) lines.push('', ...who);

  if (ctx.chunk && ctx.chunk.total > 1) {
    const { index, total, startLabel, endLabel } = ctx.chunk;
    const range = startLabel && endLabel ? ` (roughly ${startLabel}–${endLabel})` : '';
    lines.push(
      '',
      `This is part ${index + 1} of ${total} of a longer session${range}.`,
      'Extract ONLY what this part states. Do not summarise the session as a whole,',
      'and do not infer what earlier or later parts must have contained. Findings',
      'from every part are merged afterwards.',
    );
  }

  lines.push('', EVIDENCE);
  return lines.join('\n');
}

/** The closed product vocabulary, when we have one. */
export function catalogBlock(catalog: readonly string[] | undefined): string {
  if (!catalog?.length) return '';
  return [
    '',
    'KNOWN PRODUCTS (this practice\'s catalog):',
    catalog.map((c) => `  - ${c}`).join('\n'),
    'Transcription mangles product names. If a spoken name clearly refers to one of',
    'the products above, return that product\'s exact spelling. If it matches none of',
    'them, return the spoken name verbatim — do NOT force a match to the nearest',
    'entry. A product we do not recognise is normal; a wrong product is a clinical error.',
  ].join('\n');
}
