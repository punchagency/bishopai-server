import { pool } from '../db/pool';

export type LogLevel = 'error' | 'warn' | 'info';

interface LogEntry {
  level: LogLevel;
  source: string;
  message: string;
  context: Record<string, unknown> | null;
  created_at: Date; // captured at enqueue time, not flush time
}

// Flush when the buffer reaches this many entries, or when the timer fires,
// whichever comes first. MAX_BUFFER caps memory if the DB is unreachable.
const FLUSH_MAX = Number(process.env.LOG_FLUSH_MAX ?? 50);
const FLUSH_INTERVAL_MS = Number(process.env.LOG_FLUSH_INTERVAL_MS ?? 5000);
const MAX_BUFFER = Number(process.env.LOG_BUFFER_MAX ?? 10_000);
const INSERT_CHUNK = 500; // rows per INSERT — keeps well under PG's param limit

let buffer: LogEntry[] = [];
let flushing = false;
let timer: NodeJS.Timeout | null = null;

function ensureTimer(): void {
  if (timer) return;
  timer = setInterval(() => void flushLogs(), FLUSH_INTERVAL_MS);
  timer.unref(); // don't keep the process alive just for the flush timer
}

/**
 * Log to console immediately, then enqueue for a batched DB write. The console
 * line is synchronous so nothing is lost if the process dies before a flush.
 * The DB write is best-effort and batched: on failure the batch is re-queued
 * and retried on the next flush, and logging never throws.
 */
export function logEvent(
  level: LogLevel,
  source: string,
  message: string,
  context?: Record<string, unknown>,
): void {
  const line = `[${level}] ${source}: ${message}`;
  if (level === 'error') console.error(line, context ?? '');
  else if (level === 'warn') console.warn(line, context ?? '');
  else console.log(line, context ?? '');

  buffer.push({ level, source, message, context: context ?? null, created_at: new Date() });
  if (buffer.length > MAX_BUFFER) buffer.splice(0, buffer.length - MAX_BUFFER); // drop oldest

  ensureTimer();
  if (buffer.length >= FLUSH_MAX) void flushLogs();
}

/** Write buffered entries to system_events in chunked, multi-row INSERTs. */
export async function flushLogs(): Promise<void> {
  if (flushing || buffer.length === 0) return;
  flushing = true;
  const batch = buffer;
  buffer = []; // new entries during the flush accumulate here

  try {
    for (let i = 0; i < batch.length; i += INSERT_CHUNK) {
      const slice = batch.slice(i, i + INSERT_CHUNK);
      const values: unknown[] = [];
      const rows = slice.map((e, j) => {
        const b = j * 5;
        values.push(e.level, e.source, e.message, e.context ? JSON.stringify(e.context) : null, e.created_at);
        return `($${b + 1}, $${b + 2}, $${b + 3}, $${b + 4}, $${b + 5})`;
      });
      try {
        await pool.query(
          `INSERT INTO system_events (level, source, message, context, created_at)
                VALUES ${rows.join(', ')}`,
          values,
        );
      } catch (err) {
        // Re-queue this slice and everything after it; retry next flush.
        buffer = batch.slice(i).concat(buffer);
        if (buffer.length > MAX_BUFFER) buffer.splice(0, buffer.length - MAX_BUFFER);
        console.error('system_events flush failed; re-queued for retry', err);
        return;
      }
    }
  } finally {
    flushing = false;
  }
}

/** Flush remaining entries and stop the timer — call on graceful shutdown. */
export async function shutdownLogger(): Promise<void> {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
  await flushLogs();
}

// Best-effort flush on a natural exit (e.g. a short-lived script that isn't
// wired for signals). Signal-driven shutdown is coordinated in server.ts, which
// calls shutdownLogger() as part of its teardown sequence.
process.once('beforeExit', () => void flushLogs());

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
