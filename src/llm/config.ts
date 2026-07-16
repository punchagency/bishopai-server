import 'dotenv/config';

export type Effort = 'low' | 'medium' | 'high' | 'max';
export type Provider = 'google' | 'anthropic' | 'groq' | 'mock';

// Central LLM config. Provider is swappable via LLM_PROVIDER; the transcript →
// SessionNote task is schema-constrained extraction, so the default is the
// cheapest workable model.
//
//   google (default) — gemini-2.5-flash-lite: cheapest per token; JSON-schema
//                       structured output. Set GOOGLE_API_KEY (or GEMINI_API_KEY).
//   anthropic        — claude-haiku-4-5: proven path (zod structured outputs).
//                       Set ANTHROPIC_API_KEY.
//   mock             — deterministic heuristic extractor, no API key. Runs the
//                       whole WF1 chain offline for demos/seed data.
// Resolve the provider: an explicit LLM_PROVIDER always wins; otherwise default
// to whichever real key is present, and fall back to the offline `mock`
// extractor when none is — so a dev server with no credentials still runs the
// whole WF1 chain instead of throwing on every transcript.
function resolveProvider(): Provider {
  const explicit = process.env.LLM_PROVIDER as Provider | undefined;
  if (explicit) return explicit;
  if (process.env.GROQ_API_KEY) return 'groq';
  if (process.env.GOOGLE_API_KEY || process.env.GEMINI_API_KEY) return 'google';
  if (process.env.ANTHROPIC_API_KEY) return 'anthropic';
  return 'mock';
}

export const llmConfig = {
  provider: resolveProvider(),
  maxTokens: Number(process.env.LLM_MAX_TOKENS ?? process.env.ANTHROPIC_MAX_TOKENS ?? 4096),

  groq: {
    apiKey: process.env.GROQ_API_KEY ?? '',
    model: process.env.GROQ_MODEL ?? 'openai/gpt-oss-120b',
  },
  google: {
    apiKey: process.env.GOOGLE_API_KEY ?? process.env.GEMINI_API_KEY ?? '',
    model: process.env.GEMINI_MODEL ?? 'gemini-2.0-flash',
  },
  anthropic: {
    apiKey: process.env.ANTHROPIC_API_KEY ?? '',
    model: process.env.ANTHROPIC_MODEL ?? 'claude-haiku-4-5',
    effort: (process.env.ANTHROPIC_EFFORT ?? 'low') as Effort,
  },
};
