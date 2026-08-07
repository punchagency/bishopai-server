import 'dotenv/config';

export type Effort = 'low' | 'medium' | 'high' | 'max';
export type Provider = 'google' | 'anthropic' | 'groq' | 'mock';

// Central LLM config. Provider is swappable via LLM_PROVIDER; the transcript →
// SessionNote task is schema-constrained extraction, so the default is the
// cheapest workable model.
//
//   groq       — openai/gpt-oss-120b: fastest + free tier; OpenAI-compatible
//                JSON mode. Set GROQ_API_KEY.
//   google     — gemini-2.0-flash: cheap per token; JSON-schema structured
//                output. Set GOOGLE_API_KEY (or GEMINI_API_KEY).
//   anthropic  — claude-haiku-4-5: proven path (zod structured outputs).
//                Set ANTHROPIC_API_KEY.
//   mock       — deterministic heuristic extractor, no API key. Runs the whole
//                WF1 chain offline for demos/seed data.
//
// Resolve the provider: an explicit LLM_PROVIDER always wins; otherwise take
// whichever real key is present, in the order listed above (cheapest/fastest
// first), and fall back to the offline `mock` extractor when none is — so a dev
// server with no credentials still runs the whole WF1 chain instead of throwing
// on every transcript.
function resolveProvider(): Provider {
  const explicit = process.env.LLM_PROVIDER as Provider | undefined;
  if (explicit) return explicit;
  if (process.env.GROQ_API_KEY) return 'groq';
  if (process.env.GOOGLE_API_KEY || process.env.GEMINI_API_KEY) return 'google';
  if (process.env.ANTHROPIC_API_KEY) return 'anthropic';
  return 'mock';
}

const provider = resolveProvider();

export const llmConfig = {
  provider,
  // Per-minute token budget the rate limiter (llm/rateLimiter.ts) paces LLM calls
  // under, so the extraction fan-out queues instead of 429-bursting. Sized to the
  // active provider: Groq's free tier is ~12k TPM (counting requested completion
  // tokens), so default to 10k for headroom; other providers / paid tiers have
  // far higher limits, so effectively don't throttle unless LLM_TOKENS_PER_MINUTE
  // is set. Raise this the moment you move off the Groq free tier.
  tokensPerMinute: Number(
    process.env.LLM_TOKENS_PER_MINUTE ?? (provider === 'groq' ? 10_000 : 1_000_000),
  ),
  // Output budget for the FIRST attempt. Deliberately modest: providers bill
  // requested completion tokens against rate limits (Groq's free tier counts
  // max_completion_tokens toward its 12k TPM, so a pessimistic 16k budget 413s
  // every call on a short transcript), and most sessions need nothing like it.
  //
  // A small budget used to be dangerous — 4096 truncated a dense session
  // mid-JSON and the WHOLE extraction was lost. It is safe now because
  // truncation is a typed error that retries at double the budget, so the cost
  // of guessing low is one extra call on the rare session that needs it,
  // instead of a rate-limit failure on every ordinary one.
  maxTokens: Number(process.env.LLM_MAX_TOKENS ?? process.env.ANTHROPIC_MAX_TOKENS ?? 4096),
  /** Ceiling for the truncation retry, which doubles the budget and re-runs. */
  maxTokensCeiling: Number(process.env.LLM_MAX_TOKENS_CEILING ?? 32768),

  // Split a long transcript into chunks above this many input tokens. Below it a
  // single call sees the whole session and reads better; above it, long-context
  // recall on "find every scattered callout" decays silently, which is worse
  // than the merge cost of chunking.
  //
  // Tuned to the real workload: a typical 30-minute session is ~6k tokens, so
  // 6000 left her normal visit straddling the boundary — chunking some sessions
  // that would read better whole. 8000 keeps a normal (and up to ~40-minute)
  // session single-pass; chunking now only kicks in for genuinely long outliers.
  chunkThresholdTokens: Number(process.env.EXTRACTION_CHUNK_THRESHOLD_TOKENS ?? 8000),
  chunkTargetTokens: Number(process.env.EXTRACTION_CHUNK_TARGET_TOKENS ?? 3000),
  chunkOverlapTurns: Number(process.env.EXTRACTION_CHUNK_OVERLAP_TURNS ?? 2),
  /** Parallel chunk calls. Keeps a long session inside free-tier rate limits. */
  chunkConcurrency: Number(process.env.EXTRACTION_CHUNK_CONCURRENCY ?? 3),
  /** How many times to wait out a 429 before giving up on a chunk. On a small
   *  per-minute budget the chunks of one long session queue behind each other,
   *  and abandoning a chunk on the first rate limit loses that slice of the
   *  session over a delay we could have waited. */
  rateLimitRetries: Number(process.env.LLM_RATE_LIMIT_RETRIES ?? 3),

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
