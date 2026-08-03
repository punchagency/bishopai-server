export type LogLevel = 'error' | 'warn' | 'info';

// Cloud Logging reads structured JSON on stdout/stderr and promotes these two
// fields: `severity` sets the log level in the console, `message` is the summary
// line. Anything else on the object is kept as structured payload, which is what
// makes `context` searchable rather than being flattened into a string.
const SEVERITY: Record<LogLevel, string> = {
  error: 'ERROR',
  warn: 'WARNING',
  info: 'INFO',
};

/**
 * Write one log entry straight through to Cloud Logging.
 *
 * This used to buffer entries and flush them into a `system_events` table on a
 * timer. In a function there is no graceful shutdown to flush on — the instance
 * is frozen and then torn down — so the buffer's tail was guaranteed to be lost,
 * and the entries lost would be exactly the ones written just before whatever
 * killed the instance. Cloud Logging captures stdout/stderr per invocation, so
 * writing through costs nothing extra and cannot lose the tail.
 *
 * Nothing read `system_events`, so no query surface goes away with it; log
 * search moves to the Cloud Logging console. Logging never throws.
 */
export function logEvent(
  level: LogLevel,
  source: string,
  message: string,
  context?: Record<string, unknown>,
): void {
  const entry = {
    severity: SEVERITY[level],
    source,
    message: `${source}: ${message}`,
    ...(context ? { context } : {}),
  };

  let line: string;
  try {
    line = JSON.stringify(entry);
  } catch {
    // A context holding a cycle or a BigInt must not take the request down with
    // it — drop the payload, keep the entry.
    line = JSON.stringify({ severity: entry.severity, source, message: entry.message });
  }

  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);
}

/**
 * Retained so callers written against the buffered logger keep working. There is
 * no buffer to flush now — every entry is already out by the time logEvent
 * returns.
 */
export async function flushLogs(): Promise<void> {
  /* no-op: entries are written through */
}

/** Retained for the same reason as flushLogs; there is nothing to wind down. */
export async function shutdownLogger(): Promise<void> {
  /* no-op: entries are written through */
}

/** Error helper that folds an Error's message/stack into the context. */
export function logError(
  source: string,
  message: string,
  err?: unknown,
  context?: Record<string, unknown>,
): void {
  const merged: Record<string, unknown> = { ...context };
  if (err instanceof Error) {
    merged.error = err.message;
    merged.stack = err.stack;
  } else if (err !== undefined) {
    merged.error = String(err);
  }
  logEvent('error', source, message, merged);
}

export const logWarn = (source: string, message: string, context?: Record<string, unknown>) =>
  logEvent('warn', source, message, context);
