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
  /** Retries on network error / timeout / 429 / 5xx (default 2). */
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
        // Retry transient errors — server 5xx, and 429 (rate limit). Surface
        // other 4xx immediately, they won't resolve by retrying.
        if ((res.status >= 500 || res.status === 429) && attempt < retries) {
          lastErr = new HttpError(res.status, `${method} ${url} → ${res.status}`, text);
          await (res.status === 429 ? retryAfterDelay(res, attempt) : backoff(attempt));
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
  if (err instanceof HttpError) return err.status >= 500 || err.status === 429;
  // AbortError (timeout) and network errors (TypeError from fetch) are retryable.
  return err instanceof Error && (err.name === 'AbortError' || err.name === 'TypeError');
}

function backoff(attempt: number): Promise<void> {
  const ms = Math.min(1000 * 2 ** attempt, 8000) + Math.random() * 250; // exp + jitter
  return new Promise((r) => setTimeout(r, ms));
}

/** On 429, prefer the server's own `Retry-After` (seconds or HTTP-date) over guessing. */
function retryAfterDelay(res: Response, attempt: number): Promise<void> {
  const header = res.headers.get('retry-after');
  if (header) {
    const seconds = Number(header);
    const ms = Number.isFinite(seconds) ? seconds * 1000 : new Date(header).getTime() - Date.now();
    if (Number.isFinite(ms)) return new Promise((r) => setTimeout(r, Math.min(Math.max(ms, 0), 30_000)));
  }
  return backoff(attempt);
}
