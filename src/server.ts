import 'dotenv/config';
import { pool } from './db/pool';
import { createApp } from './app';
import { startScheduler, stopScheduler } from './scheduler';
import { checkFullscriptPbReadiness } from './integrations/pb';
import { shutdownLogger, logError } from './observability/logger';

const app = createApp();
const port = Number(process.env.PORT ?? 3000);
const server = app.listen(port, () => {
  console.log(`bishopAI backend listening on :${port}`);
  startScheduler(); // WF3/WF4 cadences (opt-in via SCHEDULER_ENABLED)
  // Fire-and-forget: warn if Nicole's Fullscript-in-PB levers would silently
  // break WF4 hand-offs. Never blocks startup; no-op until PB is configured.
  void checkFullscriptPbReadiness().catch((err) =>
    logError('server.startup', 'Fullscript readiness check failed', err),
  );
});

// A listen failure (e.g. EADDRINUSE) emits an 'error' event; without a handler
// Node crashes with an unhandled exception. Log it and exit cleanly instead.
server.on('error', async (err) => {
  logError('server.listen', 'HTTP server error', err);
  await shutdownLogger().catch(() => {});
  process.exit(1);
});

// Bee ingest arrives over HTTP at POST /webhooks/bee/conversation. On Nicole's
// machine the Electron app's Bee courier (main process) runs the `bee` CLI,
// polls for new conversations, and forwards them here — Bee is E2E-encrypted and
// only readable on her owner-authenticated device, so there is no stream for the
// backend to hold. See docs: bee-access-model / electron-client.

// --- Graceful shutdown --------------------------------------------------------
// Single teardown path: stop ingest, drain HTTP, flush logs, close the DB pool.
const SHUTDOWN_TIMEOUT_MS = Number(process.env.SHUTDOWN_TIMEOUT_MS ?? 10_000);
let shuttingDown = false;

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return; // ignore repeat signals
  shuttingDown = true;
  console.log(`Received ${signal}, shutting down gracefully...`);

  // Hard cap: if any step hangs (a stuck HTTP connection, an unresponsive DB),
  // force-exit rather than linger. unref() so this timer can't block exit.
  const forceExit = setTimeout(() => {
    console.error('Graceful shutdown timed out; forcing exit');
    process.exit(1);
  }, SHUTDOWN_TIMEOUT_MS);
  forceExit.unref();

  try {
    // 1. Stop scheduled jobs, then stop accepting new HTTP connections.
    stopScheduler();
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });

    // 2. Flush buffered logs and stop the flush timer (before the pool closes).
    await shutdownLogger();

    // 3. Close the DB pool.
    await pool.end();

    clearTimeout(forceExit);
    console.log('Shutdown complete.');
    process.exit(0);
  } catch (err) {
    // logError prints synchronously; flush once more before exiting non-zero.
    logError('server.shutdown', 'error during graceful shutdown', err);
    await shutdownLogger().catch(() => {});
    process.exit(1);
  }
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => void shutdown(signal));
}
// Trigger reload

