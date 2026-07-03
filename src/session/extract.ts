import { z } from 'zod';
import { generateStructured } from '../llm/providers';
import { llmConfig } from '../llm/config';
import { mockExtractSessionNote } from './mockExtract';

// Structured session note (WF1 step 3): what the transcript parse produces,
// feeding both the Appointment Sheet and the Protocol.
export const SessionNoteSchema = z.object({
  concerns: z.array(z.string()),
  assessments: z.array(z.string()),
  protocol_changes: z.array(
    z.object({
      description: z.string(),
      type: z.enum(['add', 'remove', 'adjust', 'continue']),
    }),
  ),
  supplements: z.array(
    z.object({
      name: z.string(),
      dose: z.string().nullable(),
      quantity: z.number().nullable(),
      change: z.enum(['start', 'stop', 'increase', 'decrease', 'continue']),
    }),
  ),
  follow_ups: z.array(z.string()),
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
    follow_ups: { type: 'array', items: { type: 'string' } },
  },
  required: ['concerns', 'assessments', 'protocol_changes', 'supplements', 'follow_ups'],
} as const;

const SYSTEM = [
  'You are a clinical documentation assistant for a functional-medicine practice.',
  'Extract structured session data from an appointment transcript.',
  'Record only what is explicitly stated; never infer clinical facts that were not said.',
  'If a field has no data, return an empty array.',
].join(' ');

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
