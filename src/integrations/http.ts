// Shared HTTP helper for the integration clients (§14). Small on purpose:
// timeout + bounded retry with backoff over the global fetch. Each service
// module composes this — no base class, no shared client object.

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly body?: string,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

export interface HttpOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  /** Abort after this many ms (default 15s). */
  timeoutMs?: number;
  /** Retries on network error / timeout / 5xx (default 2). */
  retries?: number;
}

/** Fetch + parse JSON, with timeout and bounded retry. Throws HttpError on 4xx/5xx. */
export async function fetchJson<T>(url: string, opts: HttpOptions = {}): Promise<T> {
  const { method = 'GET', headers = {}, body, timeoutMs = 15_000, retries = 2 } = opts;
  let lastErr: unknown;

  for (let attempt = 0; attempt <= retries; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(url, { method, headers, body, signal: ctrl.signal });
      const text = await res.text();
      if (!res.ok) {
        // Retry transient server errors; surface 4xx immediately.
        if (res.status >= 500 && attempt < retries) {
          lastErr = new HttpError(res.status, `${method} ${url} → ${res.status}`, text);
          await backoff(attempt);
          continue;
        }
        throw new HttpError(res.status, `${method} ${url} → ${res.status}: ${text.slice(0, 300)}`, text);
      }
      return (text ? JSON.parse(text) : undefined) as T;
    } catch (err) {
      if (attempt < retries && isRetryable(err)) {
        lastErr = err;
        await backoff(attempt);
        continue;
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastErr;
}

function isRetryable(err: unknown): boolean {
  if (err instanceof HttpError) return err.status >= 500;
  // AbortError (timeout) and network errors (TypeError from fetch) are retryable.
  return err instanceof Error && (err.name === 'AbortError' || err.name === 'TypeError');
}

function backoff(attempt: number): Promise<void> {
  const ms = Math.min(1000 * 2 ** attempt, 8000) + Math.random() * 250; // exp + jitter
  return new Promise((r) => setTimeout(r, ms));
}
