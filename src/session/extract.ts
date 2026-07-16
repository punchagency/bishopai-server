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
const NrtFindingsSchema = z.object({
  pulse0: z.string().nullish().transform((v) => v ?? null),
  priority1: z.string().nullish().transform((v) => v ?? null),
  k27: z.string().nullish().transform((v) => v ?? null),
  // Some models return stressors as an array — join it into a string.
  stressors: z.union([z.string(), z.array(z.string())]).nullish().transform(
    (v) => (Array.isArray(v) ? v.join(', ') : (v ?? null)),
  ),
  foundation: z.string().nullish().transform((v) => v ?? null),
  body_scan: z.string().nullish().transform((v) => v ?? null),
});

// The Flow Sheet's lifestyle log (column B), as reported by the client in-session.
const LifestyleSchema = z.object({
  bm: z.string().nullish().transform((v) => v ?? null),
  sleep: z.string().nullish().transform((v) => v ?? null),
  water: z.string().nullish().transform((v) => v ?? null),
  cycle: z.string().nullish().transform((v) => v ?? null),
  exercise: z.string().nullish().transform((v) => v ?? null),
  diet: z.string().nullish().transform((v) => v ?? null),
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
        },
        required: ['name', 'dose', 'quantity', 'change'],
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
        foundation: { type: 'string', nullable: true },
        body_scan: { type: 'string', nullable: true },
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
  '- nrt.pulse0: the Pulse 0 / pulse-point reading, verbatim as spoken.',
  '- nrt.priority1: the stated "Priority #1" finding.',
  '- nrt.k27: the K-27 (kidney-27 reflex point) result.',
  '- nrt.stressors: the stressors identified (immune, food, metal, chemical, scar, etc.).',
  '- nrt.foundation: results of the foundation / laying + standing muscle testing.',
  '- nrt.body_scan: results of the body-scan / ART / matrix testing.',
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
