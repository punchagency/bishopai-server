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

/** Rate limited / overloaded. Retryable after a wait. */
export class RateLimitError extends ProviderError {
  readonly retryAfterMs: number | null;
  constructor(opts: { provider: string; retryAfterMs?: number | null; cause?: unknown }) {
    super('provider rate limited', opts);
    this.name = 'RateLimitError';
    this.retryAfterMs = opts.retryAfterMs ?? null;
  }
}

/** Is this worth another attempt at all? */
export function isRetryable(err: unknown): boolean {
  if (err instanceof SchemaViolationError) return false;
  // Waiting cannot shrink the request; only the caller sending less can.
  if (err instanceof RequestTooLargeError) return false;
  if (err instanceof TruncatedOutputError) return true;
  if (err instanceof RateLimitError) return true;
  if (err instanceof ProviderError) return true;
  // Unknown errors (network, DNS, timeouts) are usually transient.
  return true;
}

/** Raw model output carried by an error, if any — for `extraction_raw`. */
export function rawFromError(err: unknown): string | null {
  return err instanceof ProviderError ? err.raw : null;
}
