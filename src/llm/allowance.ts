import { RateLimitError, isQuotaExhausted } from './errors';
import { logEvent } from '../observability/logger';

// One process-wide answer to "is the day's model allowance spent?".
//
// Everything else in this codebase learns that answer by ASKING the provider,
// and asking costs a request against the very cap being asked about. That is
// affordable once. It is not affordable the way extraction actually runs:
//
//   extractSessionNote  →  Promise.all over 4 stages          (4 requests)
//     each chunked stage →  pooled() over N windows           (× N)
//   processDueExtractions → sequential loop over M sessions   (× M)
//
// On 2026-08-24 that shape turned one spent cap into dozens of refusals, seven
// blank notes, and a retry ladder that spent four more requests per session
// re-asking a question already answered. Two of the three layers have since been
// fixed in isolation — markExtractionFailed no longer burns attempts on a spent
// cap, and the classifier no longer mistakes a per-day refusal for a paced one —
// but both fixes are per-row, and the fan-out above is not per-row. Four stages
// still fire together, and all four still pay to be told the same thing.
//
// So the gate: the FIRST refusal closes it, and every call after that fails
// instantly and for free until the allowance resets. The four stages of a
// session cost one request to discover the cap is gone instead of four, and the
// next session costs nothing at all.
//
// Deliberately in-process and not persisted. A restart reopens it, which sounds
// like a hole until you follow what a restart actually reaches: rows parked by
// markExtractionFailed carry extraction_next_attempt_at at the reset, and the
// queue will not claim them before then, so the gate has nothing to guard. It
// exists to stop a fan-out mid-flight, and a fan-out does not survive a restart.

/** Google's free tier resets at local midnight Pacific — not UTC midnight and
 *  not a rolling 24 hours. Shared with the SQL in reclaim.ts, which parks rows
 *  on the same instant; they must agree or a row wakes to a closed gate. */
const RESET_TZ = process.env.LLM_QUOTA_RESET_TZ ?? 'America/Los_Angeles';

/** When the allowance next resets, as an absolute instant. */
export function nextResetAt(now: Date = new Date()): Date {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone: RESET_TZ,
      hour12: false,
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    })
      .formatToParts(now)
      .map((p) => [p.type, p.value]),
  );
  // en-US with hour12:false renders midnight as "24", not "00".
  const h = Number(parts.hour) % 24;
  const intoDayMs = ((h * 60 + Number(parts.minute)) * 60 + Number(parts.second)) * 1000;
  return new Date(now.getTime() + (86_400_000 - intoDayMs));
}

let closedUntil: Date | null = null;
/** The provider's own words for why, kept so the row that trips over the gate
 *  stores the real refusal rather than a message this file made up. */
let closedBecause = '';

export interface AllowanceStatus {
  open: boolean;
  /** Null while open. */
  resetsAt: Date | null;
}

export function allowanceStatus(now: Date = new Date()): AllowanceStatus {
  if (closedUntil && closedUntil.getTime() > now.getTime()) {
    return { open: false, resetsAt: closedUntil };
  }
  if (closedUntil) {
    // Reopen exactly once, and say so: a silent reopen makes the first request
    // of a new day look like the gate was never closed.
    logEvent('info', 'llm.allowance', 'daily model allowance reset — gate reopened', {
      was_closed_until: closedUntil.toISOString(),
    });
    closedUntil = null;
    closedBecause = '';
  }
  return { open: true, resetsAt: null };
}

/**
 * Close the gate until the next reset. Idempotent: the twenty-third refusal of
 * the day is not news, so only the first one logs.
 */
export function closeAllowance(reason: string, now: Date = new Date()): void {
  if (!allowanceStatus(now).open) return;
  closedUntil = nextResetAt(now);
  closedBecause = reason.slice(0, 2000);
  logEvent('warn', 'llm.allowance', 'daily model allowance spent — refusing further calls', {
    reset_tz: RESET_TZ,
    resets_at: closedUntil.toISOString(),
    reason: closedBecause,
  });
}

/**
 * Throw if the allowance is known to be spent, without touching the network.
 *
 * The thrown error is the same shape the provider would have produced, so every
 * caller that already handles a spent cap — the stage-failure path, the note
 * merger, markExtractionFailed's parking — handles this identically and none of
 * them needs to know a gate exists.
 */
export function assertAllowance(): void {
  const status = allowanceStatus();
  if (status.open) return;
  throw new RateLimitError({
    provider: 'allowance-gate',
    retryAfterMs: status.resetsAt ? status.resetsAt.getTime() - Date.now() : null,
    exhausted: true,
    cause: new Error(closedBecause || 'daily request quota exhausted (per-day limit)'),
  });
}

/** Close the gate if this error says the cap is spent. Returns whether it did. */
export function noteProviderError(err: unknown): boolean {
  const spent =
    (err instanceof RateLimitError && err.exhausted) ||
    (err instanceof Error && isQuotaExhausted(err));
  if (spent) closeAllowance(err instanceof Error ? err.message : String(err));
  return spent;
}

/** Tests only — the gate is process-wide, so a test that closes it would
 *  otherwise leak into every test after it in the same worker. */
export function resetAllowanceForTests(): void {
  closedUntil = null;
  closedBecause = '';
}
