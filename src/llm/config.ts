import 'dotenv/config';

export type Effort = 'low' | 'medium' | 'high' | 'max';
export type Provider = 'openrouter' | 'google' | 'anthropic' | 'groq' | 'mock';

// Central LLM config. Provider is swappable via LLM_PROVIDER; the transcript →
// SessionNote task is schema-constrained extraction, so the default is the
// cheapest workable model.
//
//   openrouter — nvidia/nemotron-3-super-120b-a12b:free: a 262k context window,
//                which is the point. Groq's free tier forces a 35-minute session
//                into 4 chunks x 3 stages = 12 calls against an 8k/min ceiling,
//                and the narrative stage is explicitly designed NOT to chunk —
//                a chunk that does not contain a concern cannot know it exists.
//                At 262k the whole transcript is one call per stage. Supports
//                response_format, structured_outputs AND reasoning_effort.
//                Set OPENROUTER_API_KEY.
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
  // Ahead of groq: the wide context removes chunking entirely, which is worth
  // more to this pipeline than raw tokens/sec.
  if (process.env.OPENROUTER_API_KEY) return 'openrouter';
  if (process.env.GROQ_API_KEY) return 'groq';
  if (process.env.GOOGLE_API_KEY || process.env.GEMINI_API_KEY) return 'google';
  if (process.env.ANTHROPIC_API_KEY) return 'anthropic';
  return 'mock';
}

const provider = resolveProvider();

/** Tokens of headroom left for the system prompt and schema on every call. */
const PROMPT_OVERHEAD_TOKENS = 800;

/**
 * Completion budget requested on the FIRST attempt.
 *
 * Providers charge the REQUESTED completion against the rate limit, not the
 * tokens actually produced — so this number is spent on every call whether the
 * answer needs it or not. On an 8k/minute tier a 4096 reservation means roughly
 * one call per minute, and a session that needs a dozen calls simply runs out of
 * minute before it runs out of work: chunks then fail on rate limits and the
 * stage lands `partial`.
 *
 * Tempting, therefore, to shrink it and buy more calls per minute. That was
 * measured and it backfires: at 1536 the narrative stage's JSON — concerns,
 * goals, assessments, follow-ups, lifestyle AND their evidence for a whole chunk
 * — truncates, every chunk burns a retry at double the budget, and the stage is
 * dropped outright rather than merely slowed. Recall fell from 14% to 3%.
 *
 * So the binding constraint is answer completeness, not call rate. 4096 stands
 * until there is a measurement that says otherwise.
 */
function defaultMaxTokens(): number {
  return 4096;
}

/**
 * Largest transcript we can still send in one piece.
 *
 * Both halves of a request — the transcript going up and the completion budget
 * reserved for the answer — are charged against the same per-minute allowance,
 * so a single-pass call is only viable when input + output + prompt fit inside
 * it. Anything larger must chunk, and finding that out from a 413 costs a whole
 * window per stage.
 */
function defaultChunkThreshold(): number {
  const budget = Number(
    process.env.LLM_TOKENS_PER_MINUTE ?? (provider === 'groq' ? 8_000 : 1_000_000),
  );
  const output = Number(
    process.env.LLM_MAX_TOKENS ?? process.env.ANTHROPIC_MAX_TOKENS ?? defaultMaxTokens(),
  );
  // Two independent ceilings, and a whole-transcript call has to clear both: how
  // many tokens the tier will serve in a minute, and how many the model can hold
  // at once. On groq the per-minute budget binds (8k), and that is what forced a
  // 7k session into chunks. On a wide-context provider the budget is effectively
  // unthrottled and the CONTEXT binds instead — take whichever is smaller so
  // neither is silently exceeded.
  const perMinute = budget - output - PROMPT_OVERHEAD_TOKENS;
  const contextLimit =
    provider === 'openrouter'
      ? Number(process.env.OPENROUTER_CONTEXT_TOKENS ?? 262_144)
      : provider === 'google'
        ? Number(process.env.GEMINI_CONTEXT_TOKENS ?? 1_048_576)
        : Number.POSITIVE_INFINITY;
  const perCall = contextLimit - output - PROMPT_OVERHEAD_TOKENS;
  // Never collapse to something so small that every session shatters into chunks.
  return Math.max(1500, Math.min(perMinute, perCall));
}

export const llmConfig = {
  provider,
  // Per-minute token budget the rate limiter (llm/rateLimiter.ts) paces LLM calls
  // under, so the extraction fan-out queues instead of 429-bursting.
  //
  // 8000 is Groq's ACTUAL free-tier ceiling, read off `x-ratelimit-limit-tokens`
  // on a live response — not the ~12k this was originally written against. The
  // gap was not academic: the limiter was admitting calls the API then refused,
  // so every stage of a real session burned a request on a 413 before falling
  // back to chunks. Other providers / paid tiers have far higher limits, so they
  // effectively don't throttle unless LLM_TOKENS_PER_MINUTE is set.
  //
  // Check it rather than assume it — the tier's limits and its model list both
  // change without notice (`npm run check:llm`).
  //
  // But pace UNDER that ceiling, not at it. Setting the budget to exactly 8000 was
  // measured on a real session and it starves: 42 rate-limit events in one
  // extraction, every call at every retry level across all three stages, until
  // each burned its full six-retry backoff (2s→4→8→16→32→60) to make one request.
  // A 35-minute session took 38 minutes and still hadn't finished.
  //
  // Two errors compound at the ceiling. The limiter's cost estimate uses ~4
  // chars/token and measured ~8% low against Groq's own count (3227 actual vs
  // ~2972 estimated on one narrative chunk), and a token bucket refilling at
  // exactly the provider's rate has no room to absorb that — nor any for the
  // difference between our bucket and their window accounting. Every estimate
  // error becomes a call the API refuses, and a refusal costs far more than the
  // throughput that admitting it would have won.
  //
  // 85% buys back the estimate error with room to spare. The ~8-minute token
  // floor for a long session is unchanged — that is arithmetic, not pacing — but
  // the retry stalls on top of it should mostly disappear.
  tokensPerMinute: Number(
    process.env.LLM_TOKENS_PER_MINUTE ?? (provider === 'groq' ? 6_800 : 1_000_000),
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
  maxTokens: Number(
    process.env.LLM_MAX_TOKENS ?? process.env.ANTHROPIC_MAX_TOKENS ?? defaultMaxTokens(),
  ),
  /**
   * Whether `maxTokens` above is a deliberate setting or just the default.
   *
   * It matters because the per-stage budgets in extract.ts are capped by it, and
   * capping a stage that was deliberately sized larger by a GLOBAL DEFAULT is
   * silent damage: the narrative stage asks for every concern, assessment and
   * follow-up in a 45-minute session, each with a verbatim quote, and 4096 does
   * not hold that. Truncation would at least be caught and retried — but a model
   * near its budget compresses instead, returning five general findings where
   * twenty specific ones were stated, and nothing anywhere reports a problem.
   * So an explicit override still binds every stage; the bare default does not.
   */
  maxTokensExplicit:
    process.env.LLM_MAX_TOKENS != null || process.env.ANTHROPIC_MAX_TOKENS != null,
  /**
   * Extra completion budget for models that bill THINKING against it.
   *
   * A stage's `maxTokens` is an output budget — sized to the JSON its schema can
   * emit. On a reasoning model that is not the request budget: the model spends
   * tokens thinking first, and they come out of the same allowance, so a stage
   * budgeted for exactly its JSON truncates before writing any. Measured on
   * nemotron-3-super at effort=low: ~114 reasoning tokens to answer a one-line
   * question, scaling with the task — against a 3000-token narrative budget that
   * is the difference between an answer and `finish_reason=length` on every call.
   *
   * Zero on Groq, where it cannot be afforded anyway: its 8k/min ceiling is the
   * binding constraint and `reasoning_effort: 'low'` is the lever that works
   * there. On OpenRouter the free tier limits REQUESTS, not tokens per minute,
   * so headroom is genuinely free — and the cost of guessing low is a truncation
   * retry at double, while the cost of guessing high is nothing at all.
   */
  reasoningHeadroomTokens: Number(
    process.env.LLM_REASONING_HEADROOM_TOKENS ??
      (provider === 'openrouter' || provider === 'google' ? 12_000 : 0),
  ),
  /**
   * Ceiling for the truncation retry, which doubles the budget and re-runs.
   *
   * 32768 is a Groq-era number: on an 8k/min tier nothing above it was servable
   * anyway, so the cap cost nothing. It is wrong for a wide-context provider —
   * the narrative stage truncated at 30000 even with reasoning headroom, because
   * it is the heaviest ask in the pipeline (every concern, goal and assessment
   * in the session, each with a verbatim quote) AND it now sees the whole
   * transcript in one pass rather than a quarter of it. Nemotron's own output
   * limit is 262144 and the free tier bills requests, not tokens, so a high
   * ceiling costs nothing and a low one silently drops the most important stage.
   */
  maxTokensCeiling: Number(
    process.env.LLM_MAX_TOKENS_CEILING ??
      (provider === 'openrouter' ? 96_000 : provider === 'google' ? 60_000 : 32_768),
  ),
  /**
   * How many times the truncation retry may double before giving up.
   *
   * One was not enough and the ceiling was never the reason. The narrative stage
   * started at 20,000 (8,000 budget + 12,000 reasoning headroom), doubled once to
   * 40,000, truncated again and threw — with `maxTokensCeiling` sitting at 96,000
   * and more than half of it never asked for. The stage came back partial and the
   * only lever anyone reached for was an env var and a manual re-run.
   *
   * Three rungs reach the ceiling from any sane starting budget. They cost
   * requests, not tokens on a request-metered tier, and only on a session that
   * has already demonstrated it needs the room.
   */
  truncationRetries: Number(process.env.LLM_TRUNCATION_RETRIES ?? 3),

  // Split a long transcript into chunks above this many input tokens. Below it a
  // single call sees the whole session and reads better; above it, long-context
  // recall on "find every scattered callout" decays silently, which is worse
  // than the merge cost of chunking.
  //
  // The ceiling is not a taste question, it is arithmetic: a whole-transcript
  // call sends the input AND reserves the completion budget against the same
  // per-minute allowance, so it is only possible when both fit inside it. On
  // Groq's 8k tier a 7k-token session plus a 4k completion reservation is ~11k
  // and CANNOT be served — the old fixed 8000 looked only at the input, judged
  // it single-pass, and sent a request guaranteed to 413. Three stages did that
  // in turn, spending most of the minute's budget before any real work started.
  //
  // So derive it: chunk whenever a whole call would not fit, and keep a margin
  // for the prompt itself. On a high-limit provider this stays far above any
  // real session, preserving the single-pass reading that reads better.
  chunkThresholdTokens: Number(
    process.env.EXTRACTION_CHUNK_THRESHOLD_TOKENS ?? defaultChunkThreshold(),
  ),
  // Sized as a FRACTION of the ceiling, not right at it. A chunk built to the
  // exact limit leaves nothing for the ~4 chars/token estimate being wrong, and
  // being wrong means a 413 that costs the whole window. Paying for an extra
  // chunk is the cheap side of that trade.
  chunkTargetTokens: Number(
    process.env.EXTRACTION_CHUNK_TARGET_TOKENS ?? Math.max(1200, Math.floor(defaultChunkThreshold() * 0.7)),
  ),
  chunkOverlapTurns: Number(process.env.EXTRACTION_CHUNK_OVERLAP_TURNS ?? 2),
  /**
   * Window size for the stages that read in windows BY CHOICE rather than
   * because a call would not fit.
   *
   * Deliberately independent of the provider's context limit and of
   * chunkTargetTokens, which is derived from it: on a million-token model that
   * derivation makes the whole session one window, which is exactly the reading
   * the windowing is meant to avoid. This number answers "how much can be read
   * closely at once", and the answer does not change when the context window
   * does.
   */
  windowTokens: Number(process.env.EXTRACTION_WINDOW_TOKENS ?? 2500),
  /** Parallel chunk calls. Keeps a long session inside free-tier rate limits. */
  chunkConcurrency: Number(process.env.EXTRACTION_CHUNK_CONCURRENCY ?? 3),
  /** How many times to wait out a 429 before giving up on a chunk. On a small
   *  per-minute budget the chunks of one long session queue behind each other,
   *  and abandoning a chunk on the first rate limit loses that slice of the
   *  session over a delay we could have waited. */
  rateLimitRetries: Number(process.env.LLM_RATE_LIMIT_RETRIES ?? (provider === 'groq' ? 6 : 3)),

  openrouter: {
    apiKey: process.env.OPENROUTER_API_KEY ?? '',
    model: process.env.OPENROUTER_MODEL ?? 'nvidia/nemotron-3-super-120b-a12b:free',
    baseUrl: (process.env.OPENROUTER_BASE_URL ?? 'https://openrouter.ai/api/v1').replace(/\/+$/, ''),
    /** Same reason as groq's: a reasoning model that thinks past its completion
     *  budget returns nothing to parse. See the note on groq.reasoningEffort. */
    reasoningEffort: reasoningEffort(process.env.OPENROUTER_REASONING_EFFORT),
    /**
     * The model's context window, used to cap the single-pass threshold.
     *
     * OpenRouter's free tier limits REQUESTS, not tokens per minute, so the
     * token budget below is effectively unthrottled — but "unthrottled" must not
     * be read as "infinite context". Without this cap the derived chunk
     * threshold lands near a million tokens and a genuinely long transcript
     * would be sent whole to a model that cannot hold it.
     */
    contextTokens: Number(process.env.OPENROUTER_CONTEXT_TOKENS ?? 262_144),
    /** Sent as HTTP-Referer/X-Title; OpenRouter uses them for attribution only. */
    appUrl: process.env.PUBLIC_BASE_URL ?? 'https://innerlume.local',
    appTitle: 'Innerlume',
  },

  groq: {
    apiKey: process.env.GROQ_API_KEY ?? '',
    model: process.env.GROQ_MODEL ?? 'openai/gpt-oss-120b',
    /**
     * Reasoning budget for gpt-oss models. 'low' is not a quality compromise
     * here — it is what makes structured output work at all.
     *
     * gpt-oss-120b is a reasoning model, and at the default effort it spends the
     * completion budget thinking before it emits any JSON. The budget runs out
     * first, Groq receives an empty generation, and the call fails with
     *
     *   400 json_validate_failed ... "failed_generation": ""
     *
     * which reads like a schema bug and is not one. Measured on a real narrative
     * chunk: default effort fails outright; 'low' returns clean JSON using 767
     * reasoning + 1417 total completion tokens, comfortably inside the same 3000
     * budget. Raising max_completion_tokens instead does NOT work — 6000 puts the
     * call at ~9200 tokens against an 8000 TPM ceiling and it 413s.
     */
    reasoningEffort: reasoningEffort(process.env.GROQ_REASONING_EFFORT),
  },
  google: {
    apiKey: process.env.GOOGLE_API_KEY ?? process.env.GEMINI_API_KEY ?? '',
    /**
     * This defaulted to `gemini-2.0-flash`, which Google has since retired — the
     * same decommission trap that took out a pinned Groq model mid-install and
     * turned every extraction into a silent `partial`. `npm run check:llm`
     * verifies the configured model is still listed before anything depends on it.
     *
     * And "listed" is not enough: gemini-2.5-flash still appears in the models
     * endpoint but answers 404 for new keys — "no longer available to new users".
     * That is why the preflight also sends a real completion rather than trusting
     * the catalogue.
     */
    model: process.env.GEMINI_MODEL ?? 'gemini-3.6-flash',
    /** 1,048,576 in, 65,536 out — read off the models endpoint. The input limit
     *  is what removes chunking; the output limit is what makes the thinking
     *  headroom below affordable. */
    contextTokens: Number(process.env.GEMINI_CONTEXT_TOKENS ?? 1_048_576),
    /**
     * Gemini flash models think before answering, and those tokens come out of
     * maxOutputTokens — the identical trap that made every OpenRouter narrative
     * call return `finish_reason=length`. Budgeting it explicitly rather than
     * discovering it again.
     */
    thinkingBudget: Number(process.env.GEMINI_THINKING_BUDGET ?? 4_096),
  },
  anthropic: {
    apiKey: process.env.ANTHROPIC_API_KEY ?? '',
    model: process.env.ANTHROPIC_MODEL ?? 'claude-haiku-4-5',
    effort: (process.env.ANTHROPIC_EFFORT ?? 'low') as Effort,
  },
};

/** Groq accepts a fixed set here; anything else is a 400, so an unrecognised
 *  env value falls back to the default rather than breaking every call. */
function reasoningEffort(raw: string | undefined): 'none' | 'low' | 'medium' | 'high' | 'default' {
  const v = (raw ?? '').toLowerCase();
  return v === 'none' || v === 'low' || v === 'medium' || v === 'high' || v === 'default' ? v : 'low';
}
