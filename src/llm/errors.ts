// Typed extraction failures.
//
// Every provider failure used to arrive as a bare Error and land in the same
// `failed` bucket: a truncated response, a schema violation, and a 429 were
// indistinguishable in the logs, and the raw model output was never kept, so
// nobody could tell them apart afterwards either. They want different responses —
// truncation should retry with a bigger budget, a rate limit should back off, a
// schema violation is a prompt bug — so they get different types.

export class ProviderError extends Error {
  /** Raw model output, when we got one. Persisted for post-hoc diagnosis. */
  readonly raw: string | null;
  readonly provider: string;
  constructor(message: string, opts: { provider: string; raw?: string | null; cause?: unknown }) {
    // Fold the underlying message into our own. Callers log `err.message`, and a
    // bare "groq request failed" is exactly the uninformative failure this file
    // exists to prevent — the cause is where the actual reason lives.
    const cause = opts.cause;
    const detail =
      cause instanceof Error ? cause.message : typeof cause === 'string' ? cause : '';
    super(detail ? `${message}: ${detail}` : message, { cause });
    this.name = 'ProviderError';
    this.provider = opts.provider;
    this.raw = opts.raw ?? null;
  }
}

/**
 * The model ran out of output budget mid-JSON. Retryable, and specifically
 * retryable with a LARGER max_tokens — retrying at the same budget just burns
 * the same tokens to fail identically.
 */
export class TruncatedOutputError extends ProviderError {
  constructor(opts: { provider: string; raw?: string | null; finishReason?: string }) {
    super(
      `model output truncated (finish_reason=${opts.finishReason ?? 'unknown'}) — raise LLM_MAX_TOKENS`,
      opts,
    );
    this.name = 'TruncatedOutputError';
  }
}

/** Well-formed response that doesn't satisfy the schema — a prompt/schema bug,
 *  not a transient fault. Retrying rarely helps, so it shouldn't burn attempts. */
export class SchemaViolationError extends ProviderError {
  constructor(message: string, opts: { provider: string; raw?: string | null; cause?: unknown }) {
    super(message, opts);
    this.name = 'SchemaViolationError';
  }
}

/**
 * The request itself is too big for the model or the account's per-minute
 * budget. Distinct from RateLimitError because WAITING DOES NOT HELP — the same
 * request will be too large in a minute's time. The only remedy is sending less,
 * so this is what tells the extractor to fall back to chunking.
 */
export class RequestTooLargeError extends ProviderError {
  constructor(opts: { provider: string; cause?: unknown }) {
    super('request too large for the model or rate-limit window', opts);
    this.name = 'RequestTooLargeError';
  }
}

/** Rate limited / overloaded. Retryable after a wait — unless `exhausted`. */
export class RateLimitError extends ProviderError {
  readonly retryAfterMs: number | null;
  /**
   * The allowance is SPENT, not merely paced: a per-day request cap or a
   * billing limit, which no amount of waiting inside this run will restore.
   *
   * The distinction is not cosmetic. Every response to an ordinary rate limit —
   * back off and retry, or split the transcript into chunks and send those —
   * makes an exhausted quota strictly worse, because each one spends MORE
   * requests against the cap that just refused this one. Google's free tier is
   * 20 requests per day; a session that reacts by chunking into four turns one
   * refusal into five, and reports the difference as a partial extraction rather
   * than as "the key is out of quota".
   */
  readonly exhausted: boolean;
  constructor(opts: {
    provider: string;
    retryAfterMs?: number | null;
    exhausted?: boolean;
    cause?: unknown;
  }) {
    super(opts.exhausted ? 'provider quota exhausted' : 'provider rate limited', opts);
    this.name = 'RateLimitError';
    this.retryAfterMs = opts.retryAfterMs ?? null;
    this.exhausted = opts.exhausted ?? false;
  }
}

/**
 * A 429 that will still be a 429 in an hour.
 *
 * Providers return the same status for "you are going too fast" and "you have
 * used your allowance for the day", and only the body tells them apart: Google
 * names the quota it refused on (`...PerDayPerProjectPerModel-FreeTier`), and
 * OpenAI-compatible tiers say `insufficient_quota`. The retry-after they attach
 * is about the former and is meaningless for the latter — Google offers "retry
 * in 8s" on a cap that resets at midnight.
 *
 * Deliberately narrow. Reading an ordinary per-minute limit as exhausted would
 * abandon a session the provider was willing to serve thirty seconds later,
 * which is the more expensive mistake of the two.
 */
export function isQuotaExhausted(err: unknown): boolean {
  const msg = String((err as { message?: string })?.message ?? '');
  if (/generate_content_free_tier_requests|limit: \d+|retry (?:in|after)|RetryInfo/i.test(msg)) {
    return false;
  }
  return /per[-_ ]?day|daily (?:limit|quota)|insufficient_quota/i.test(msg);
}

/**
 * The provider is up but this request did not land: 500, 502, 503, 504.
 *
 * Distinct from a rate limit, which says the account has asked for too much, and
 * from a quota, which says it has asked for too much today. This says nothing
 * about us at all — "the model is currently experiencing high demand" is the
 * provider having a moment, and the correct response is the one thing the
 * extractor was NOT doing: try again shortly.
 *
 * It cost a whole measurement to find. A 503 on the two stages being measured
 * dropped them both, and only the degraded-run check stopped the resulting zeros
 * from being recorded as a catastrophic regression.
 */
export class TransientServerError extends ProviderError {
  readonly retryAfterMs: number | null;
  constructor(opts: { provider: string; status?: number; retryAfterMs?: number | null; cause?: unknown }) {
    super(`provider temporarily unavailable${opts.status ? ` (${opts.status})` : ''}`, opts);
    this.name = 'TransientServerError';
    this.retryAfterMs = opts.retryAfterMs ?? null;
  }
}

/** Is this worth another attempt at all? */
export function isRetryable(err: unknown): boolean {
  if (err instanceof SchemaViolationError) return false;
  // Waiting cannot shrink the request; only the caller sending less can.
  if (err instanceof RequestTooLargeError) return false;
  if (err instanceof TruncatedOutputError) return true;
  if (err instanceof TransientServerError) return true;
  // A spent daily allowance does not come back within a run, and every retry
  // spends another request against the cap that refused this one.
  if (err instanceof RateLimitError) return !err.exhausted;
  if (err instanceof ProviderError) return true;
  // Unknown errors (network, DNS, timeouts) are usually transient.
  return true;
}

/** Raw model output carried by an error, if any — for `extraction_raw`. */
export function rawFromError(err: unknown): string | null {
  return err instanceof ProviderError ? err.raw : null;
}
