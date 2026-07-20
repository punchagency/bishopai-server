import { z } from 'zod';
import { generateStructured } from '../llm/providers';
import { llmConfig } from '../llm/config';
import { mockExtractSessionNote } from './mockExtract';

// Structured session note (WF1 step 3): what the transcript parse produces,
// feeding both the Appointment Sheet and the Protocol.
// Nutrition Response Testing findings. These are muscle-testing results Nicole
// calls out during the session; they fill the ROF's NRT block and the Flow Sheet's
// FOUNDATION / BODY SCAN columns. Every field is nullable and stays null unless the
// transcript states it — a wrong clinical value is far worse than a blank one.

// Models frequently echo the prompt name back into the value: asked for HTA they
// answer "HTA is negative", or worse just "LAYING 1 FOUNDATIONS". The value then
// renders as "HTA: HTA is negative" on the flow sheet, and a bare label echo is
// indistinguishable from a real finding. Strip the echo deterministically rather
// than only asking the prompt to stop — the prompt is guidance, this is a
// guarantee.
const ECHO_CONNECTOR = String.raw`(?:\s+(?:is|was|are|were|shows?|reads?))?\s*[:\-–]?\s*`;

function stripEcho(value: string | null, aliases: string[]): string | null {
  if (!value) return null;
  let out = value.trim();
  for (const alias of aliases) {
    const re = new RegExp(`^${alias.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}${ECHO_CONNECTOR}`, 'i');
    const next = out.replace(re, '').trim();
    // A value that was ONLY the label carries no finding at all — that is a
    // blank, not a result, and must not read as one.
    if (next !== out) out = next;
  }
  return out.length ? out : null;
}

function stripEchoes<T extends Record<string, string | null>>(
  obj: T,
  labels: Record<keyof T, string[]>,
): T {
  const out = { ...obj };
  for (const key of Object.keys(out) as (keyof T)[]) {
    (out as Record<string, string | null>)[key as string] = stripEcho(out[key], labels[key] ?? []);
  }
  return out;
}

const FOUNDATION_LABELS = {
  laying1: ['laying 1 foundations', 'laying 1'],
  standing: ['standing foundations', 'standing'],
  hta: ['hta'],
  hta_post_run: ['hta post run', 'post run'],
  laying2: ['laying 2 foundations', 'laying 2'],
  art_open: ['art open', 'open'],
  art_switch: ['art switch', 'switch'],
  art_cns: ['art cns', 'cns'],
  art_dental: ['art dental', 'dental'],
  art_hormonal: ['art hormonal', 'hormonal'],
  additional: ['additional'],
};

const BODY_SCAN_LABELS = {
  art_ectoderm: ['art ectoderm', 'ectoderm'],
  art_priority: ['art priority', 'priority'],
  art_matrix: ['art matrix', 'matrix'],
  art_cell: ['art cell', 'cell'],
  additional_art: ['additional art'],
  scan_priority: ['scan priority', 'body scan priority', 'priority'],
  scan_matrix: ['scan matrix', 'body scan matrix', 'matrix'],
  scan_cell: ['scan cell', 'body scan cell', 'cell'],
  additional_nrt: ['additional nrt'],
};

const LIFESTYLE_LABELS = {
  bm: ['bowel movements', 'bowel movement', 'bm'],
  sleep: ['sleep'],
  water: ['water intake', 'water'],
  cycle: ['menstrual cycle', 'cycle'],
  exercise: ['exercise'],
  diet: ['diet'],
};

/** A field that stays null unless the transcript states it. */
const stated = (): z.ZodType<string | null, unknown> =>
  z.string().nullish().transform((v) => v?.trim() || null) as z.ZodType<string | null, unknown>;

// The FOUNDATION column (D) of the Flow Sheet is not free text — it is a fixed
// list of muscle-testing prompts Nicole works down in order. Modelling each prompt
// as its own field is what lets the review UI show her "HTA: 68" against a blank
// "HTA POST RUN", instead of one blob she has to read for what's missing.
// Legacy notes stored a single string here; it lands in `additional`.
export const FoundationSchema = z.preprocess(
  (v) => (typeof v === 'string' ? { additional: v } : v),
  z.object({
    laying1: stated(),
    standing: stated(),
    hta: stated(),
    hta_post_run: stated(),
    laying2: stated(),
    art_open: stated(),
    art_switch: stated(),
    art_cns: stated(),
    art_dental: stated(),
    art_hormonal: stated(),
    additional: stated(),
  }),
).transform((v) => (v ? stripEchoes(v, FOUNDATION_LABELS) : v));

// The BODY SCAN column (E): two testing passes — ART with polarity, then NRT
// without — each with its own PRIORITY / MATRIX / CELL readings.
export const BodyScanSchema = z.preprocess(
  (v) => (typeof v === 'string' ? { additional_nrt: v } : v),
  z.object({
    art_ectoderm: stated(),
    art_priority: stated(),
    art_matrix: stated(),
    art_cell: stated(),
    additional_art: stated(),
    scan_priority: stated(),
    scan_matrix: stated(),
    scan_cell: stated(),
    additional_nrt: stated(),
  }),
).transform((v) => (v ? stripEchoes(v, BODY_SCAN_LABELS) : v));

export const NrtFindingsSchema = z.object({
  pulse0: stated(),
  priority1: stated(),
  k27: stated(),
  // Some models return stressors as an array — join it into a string.
  stressors: z.union([z.string(), z.array(z.string())]).nullish().transform(
    (v) => (Array.isArray(v) ? v.join(', ') : (v ?? null)),
  ),
  foundation: FoundationSchema.nullish().transform((v) => v ?? null),
  body_scan: BodyScanSchema.nullish().transform((v) => v ?? null),
});

export type FoundationFindings = z.infer<typeof FoundationSchema>;
export type BodyScanFindings = z.infer<typeof BodyScanSchema>;

// The Flow Sheet's lifestyle log (column B), as reported by the client in-session.
export const LifestyleSchema = z
  .object({
    bm: stated(),
    sleep: stated(),
    water: stated(),
    cycle: stated(),
    exercise: stated(),
    diet: stated(),
  })
  .transform((v) => stripEchoes(v, LIFESTYLE_LABELS));

// The Supplement Protocol grid's time-of-day columns (D–J). Keys match
// ScheduleSlot in integrations/docs/types.ts.
export const ScheduleSchema = z.object({
  uponWaking: stated(),
  breakfast: stated(),
  midMorning: stated(),
  lunch: stated(),
  midAfternoon: stated(),
  dinner: stated(),
  beforeBed: stated(),
});

export const FollowUpSchema = z.object({
  text: z.string().default(''),
  // Only when a timeframe was actually said. "Recheck in 4 weeks" → 28. "Keep an
  // eye on her sleep" → null, and the task simply has no due date. Never guessed.
  due_in_days: z.number().int().nullish().transform((v) => v ?? null),
});

export const SessionNoteSchema = z.object({
  concerns: z.array(z.string()).default([]),
  goals: z.array(z.string()).nullish().transform((v) => v ?? []),
  assessments: z.array(z.string()).default([]),
  protocol_changes: z.array(
    z.object({
      description: z.string().nullish().transform((v) => v ?? ''),
      type: z.enum(['add', 'remove', 'adjust', 'continue']).nullish().transform((v) => v ?? 'continue'),
    }),
  ).default([]),
  supplements: z.array(
    z.object({
      name: z.string().default(''),
      dose: z.string().nullish().transform((v) => v ?? null),
      quantity: z.number().nullish().transform((v) => v ?? null),
      change: z.enum(['start', 'stop', 'increase', 'decrease', 'continue']).nullish().transform((v) => v ?? 'continue'),
      // Dosing slots on the Supplement Protocol's Daily Schedule grid. A slot is
      // filled only when the timing was actually spoken; an absent slot means
      // "not taken then", not "unknown".
      schedule: ScheduleSchema.optional(),
      // "Here | Fullscript" on the protocol grid — where the client gets it.
      // Rarely spoken aloud, so usually filled in by Nicole during review.
      obtained_from: stated().optional(),
    }),
  ).default([]),
  follow_ups: z.array(z.union([z.string(), FollowUpSchema])).default([]),
  // Optional so notes extracted before these fields existed still parse.
  nrt: NrtFindingsSchema.optional(),
  lifestyle: LifestyleSchema.optional(),
});


export type SessionNote = z.infer<typeof SessionNoteSchema>;

// JSON-Schema mirror of SessionNoteSchema for providers that take one (Gemini).
// Hand-kept in sync — small + stable; zod stays the validation source of truth.
const SESSION_NOTE_JSON_SCHEMA = {
  type: 'object',
  properties: {
    concerns: { type: 'array', items: { type: 'string' } },
    assessments: { type: 'array', items: { type: 'string' } },
    protocol_changes: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          description: { type: 'string' },
          type: { type: 'string', enum: ['add', 'remove', 'adjust', 'continue'] },
        },
        required: ['description', 'type'],
      },
    },
    supplements: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          dose: { type: 'string', nullable: true },
          quantity: { type: 'number', nullable: true },
          change: { type: 'string', enum: ['start', 'stop', 'increase', 'decrease', 'continue'] },
          schedule: {
            type: 'object',
            nullable: true,
            properties: {
              uponWaking: { type: 'string', nullable: true },
              breakfast: { type: 'string', nullable: true },
              midMorning: { type: 'string', nullable: true },
              lunch: { type: 'string', nullable: true },
              midAfternoon: { type: 'string', nullable: true },
              dinner: { type: 'string', nullable: true },
              beforeBed: { type: 'string', nullable: true },
            },
            required: [
              'uponWaking', 'breakfast', 'midMorning', 'lunch',
              'midAfternoon', 'dinner', 'beforeBed',
            ],
          },
        },
        required: ['name', 'dose', 'quantity', 'change', 'schedule'],
      },
    },
    follow_ups: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          text: { type: 'string' },
          due_in_days: { type: 'number', nullable: true },
        },
        required: ['text', 'due_in_days'],
      },
    },
    goals: { type: 'array', items: { type: 'string' } },
    nrt: {
      type: 'object',
      properties: {
        pulse0: { type: 'string', nullable: true },
        priority1: { type: 'string', nullable: true },
        k27: { type: 'string', nullable: true },
        stressors: { type: 'string', nullable: true },
        foundation: {
          type: 'object',
          nullable: true,
          properties: {
            laying1: { type: 'string', nullable: true },
            standing: { type: 'string', nullable: true },
            hta: { type: 'string', nullable: true },
            hta_post_run: { type: 'string', nullable: true },
            laying2: { type: 'string', nullable: true },
            art_open: { type: 'string', nullable: true },
            art_switch: { type: 'string', nullable: true },
            art_cns: { type: 'string', nullable: true },
            art_dental: { type: 'string', nullable: true },
            art_hormonal: { type: 'string', nullable: true },
            additional: { type: 'string', nullable: true },
          },
          required: [
            'laying1', 'standing', 'hta', 'hta_post_run', 'laying2',
            'art_open', 'art_switch', 'art_cns', 'art_dental', 'art_hormonal', 'additional',
          ],
        },
        body_scan: {
          type: 'object',
          nullable: true,
          properties: {
            art_ectoderm: { type: 'string', nullable: true },
            art_priority: { type: 'string', nullable: true },
            art_matrix: { type: 'string', nullable: true },
            art_cell: { type: 'string', nullable: true },
            additional_art: { type: 'string', nullable: true },
            scan_priority: { type: 'string', nullable: true },
            scan_matrix: { type: 'string', nullable: true },
            scan_cell: { type: 'string', nullable: true },
            additional_nrt: { type: 'string', nullable: true },
          },
          required: [
            'art_ectoderm', 'art_priority', 'art_matrix', 'art_cell', 'additional_art',
            'scan_priority', 'scan_matrix', 'scan_cell', 'additional_nrt',
          ],
        },
      },
      required: ['pulse0', 'priority1', 'k27', 'stressors', 'foundation', 'body_scan'],
    },
    lifestyle: {
      type: 'object',
      properties: {
        bm: { type: 'string', nullable: true },
        sleep: { type: 'string', nullable: true },
        water: { type: 'string', nullable: true },
        cycle: { type: 'string', nullable: true },
        exercise: { type: 'string', nullable: true },
        diet: { type: 'string', nullable: true },
      },
      required: ['bm', 'sleep', 'water', 'cycle', 'exercise', 'diet'],
    },
  },
  required: [
    'concerns',
    'goals',
    'assessments',
    'protocol_changes',
    'supplements',
    'follow_ups',
    'nrt',
    'lifestyle',
  ],
} as const;

const SYSTEM = [
  'You are a clinical documentation assistant for a functional-medicine practice',
  'that uses Nutrition Response Testing (NRT).',
  'Extract structured session data from an appointment transcript.',
  '',
  'CRITICAL: record only what is explicitly stated. Never infer, guess, or fill in a',
  'plausible clinical value. A blank field is correct and expected; a fabricated one',
  'is a clinical error. If the transcript does not state something, return null (for',
  'string fields) or an empty array.',
  '',
  'Field guidance:',
  '- concerns: symptoms/complaints the CLIENT reports (e.g. pain, panic attacks,',
  '  fatigue). Capture them verbatim in full — include any context the client gives',
  '  (e.g. "gallbladder pain — stones confirmed on ultrasound, surgeon wanted removal").',
  '- goals: what the CLIENT explicitly says they want to achieve.',
  '- assessments: the PRACTITIONER\'s working conclusions and findings — capture every',
  '  distinct clinical statement made by the practitioner, verbatim or near-verbatim.',
  '  Include organ/system findings, stress-pattern conclusions, neuro/hormonal',
  '  observations, and any body-system the practitioner says needs support.',
  '  Each finding should be a separate item. Do not merge or summarise.',
  '  Examples: "pituitary is a little bit offline", "HPA axis under stress",',
  '  "gallbladder stress affecting digestion, bile production and detoxification",',
  '  "adrenal cortex needs support to calm cortisol and fight-or-flight response",',
  '  "body needs to reset its safety signal after chronic stress".',
  '- protocol_changes: every supplement change the practitioner states — match the',
  '  type field to the action: "add"/"start" → add, "stop"/"remove"/"take out" → remove,',
  '  "continue"/"keep" → continue, dose or frequency changes → adjust.',
  '  If product names are garbled in transcription, preserve the best phonetic match.',
  '  Include ALL changes mentioned: continues, removals, additions.',
  '- supplements: only for NEW supplements being added with explicit name + change type.',
  '- supplements[].schedule: when the practitioner states WHEN a supplement is taken,',
  '  put the amount in that slot: uponWaking, breakfast, midMorning, lunch,',
  '  midAfternoon, dinner, beforeBed. "two caps with breakfast and one before bed"',
  '  → {breakfast: "2 caps", beforeBed: "1 cap"}. Leave every slot null if no timing',
  '  was spoken — do NOT spread a daily dose across meals to make it add up.',
  '- nrt.pulse0: the Pulse 0 / pulse-point reading, verbatim as spoken.',
  '- nrt.priority1: the stated "Priority #1" finding.',
  '- nrt.k27: the K-27 (kidney-27 reflex point) result.',
  '- nrt.stressors: the stressors identified (immune, food, metal, chemical, scar, etc.).',
  '- nrt.foundation: the foundation muscle-testing pass, prompt by prompt. Fill only',
  '  the prompts the practitioner actually calls a result for; leave the rest null.',
  '    laying1 = "LAYING 1 FOUNDATIONS", standing = "STANDING FOUNDATIONS",',
  '    hta = "HTA", hta_post_run = "HTA POST RUN", laying2 = "LAYING 2 FOUNDATIONS",',
  '    art_open = ART "OPEN", art_switch = ART "SWITCH", art_cns = ART "CNS",',
  '    art_dental = ART "DENTAL", art_hormonal = ART "HORMONAL",',
  '    additional = any foundation finding that fits none of the above.',
  '  Record ONLY the result, never the prompt name: "negative", not "HTA is',
  '  negative" and never just "HTA". A value that only repeats the prompt is a',
  '  blank — leave it null.',
  '- nrt.body_scan: the body-scan pass, prompt by prompt. Two testing rounds:',
  '    ART W/ POL → art_ectoderm ("ECTODERM"), art_priority ("PRIORITY"),',
  '      art_matrix ("MATRIX"), art_cell ("CELL"), additional_art ("ADDITIONAL ART"),',
  '    NRT W/O POL → scan_priority ("PRIORITY"), scan_matrix ("MATRIX"),',
  '      scan_cell ("CELL"), additional_nrt ("ADDITIONAL NRT").',
  '  Do not copy an ART reading into the NRT round or vice versa — they are separate',
  '  tests and Nicole compares them. If you cannot tell which round a reading belongs',
  '  to, put it in additional_art or additional_nrt rather than guessing a slot.',
  '- lifestyle: the client\'s self-reported log — bowel movements (bm), sleep, water',
  '  intake, menstrual cycle, exercise, and diet. Null any the client did not mention.',
  '- follow_ups: each is an action someone committed to, as {text, due_in_days}.',
  '  Set due_in_days ONLY from a timeframe actually spoken ("recheck in 4 weeks" → 28,',
  '  "back in a month" → 30, "next week" → 7). If no timeframe was given, due_in_days',
  '  is null — an undated task is correct. Do not assign a default interval.',
].join('\n');

/**
 * Parse a Bee transcript into a structured session note. Provider + model come
 * from llmConfig (swappable via LLM_PROVIDER, no code change). Uses structured
 * outputs; the result is validated against SessionNoteSchema regardless of
 * provider, so the output contract is identical across models.
 */
export async function extractSessionNote(transcript: string): Promise<SessionNote> {
  // Offline path: deterministic heuristic extractor, no API key (demos/seed).
  if (llmConfig.provider === 'mock') {
    return SessionNoteSchema.parse(mockExtractSessionNote(transcript));
  }
  const raw = await generateStructured({
    system: SYSTEM,
    user: `Transcript:\n\n${transcript}`,
    zodSchema: SessionNoteSchema,
    jsonSchema: SESSION_NOTE_JSON_SCHEMA,
  });
  return SessionNoteSchema.parse(raw);
}
