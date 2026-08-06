import 'dotenv/config';
import { setDefaultResultOrder } from 'node:dns';
import { pool } from './db/pool';
import { createApp } from './app';
import { startScheduler, stopScheduler } from './scheduler';
import { checkFullscriptPbReadiness } from './integrations/pb';
import { shutdownLogger, logError } from './observability/logger';

// Prefer IPv4 for every outbound call: Google, Pocket, PB, QuickBooks, Graph.
//
// All of them publish A and AAAA records. On a host where IPv6 is advertised
// but not routable, Node picks the AAAA and the call dies with ETIMEDOUT — and
// because each integration is written to degrade rather than crash, that
// surfaces as "the transcript never arrived" or "the document didn't publish"
// rather than as a network error anyone would think to look for.
//
// This belongs in code, not `NODE_OPTIONS=--dns-result-order=ipv4first` in an
// env file: the node binary reads NODE_OPTIONS at launch, while dotenv loads
// `.env` from inside the already-running process, so the env-file form silently
// does nothing. On a host with working IPv6 this is a no-op.
import { runMigrations } from './db/migrate';
import type { Server } from 'node:http';

setDefaultResultOrder('ipv4first');

const app = createApp();
const port = Number(process.env.PORT ?? 3000);
let server: Server | undefined;

async function startServer() {
  try {
    await runMigrations();
  } catch (err) {
    logError('server.startup', 'DB migration failed', err);
  }

  server = app.listen(port, () => {
    console.log(`bishopAI backend listening on :${port}`);
    startScheduler(); // WF3/WF4 cadences (opt-in via SCHEDULER_ENABLED)
    void checkFullscriptPbReadiness().catch((err) =>
      logError('server.startup', 'Fullscript readiness check failed', err),
    );
  });

  server.on('error', async (err) => {
    logError('server.listen', 'HTTP server error', err);
    await shutdownLogger().catch(() => {});
    process.exit(1);
  });
}

void startServer();

// --- Graceful shutdown --------------------------------------------------------
// Single teardown path: stop ingest, drain HTTP, flush logs, close the DB pool.
const SHUTDOWN_TIMEOUT_MS = Number(process.env.SHUTDOWN_TIMEOUT_MS ?? 10_000);
let shuttingDown = false;

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return; // ignore repeat signals
  shuttingDown = true;
  console.log(`Received ${signal}, shutting down gracefully...`);

  const forceExit = setTimeout(() => {
    console.error('Graceful shutdown timed out; forcing exit');
    process.exit(1);
  }, SHUTDOWN_TIMEOUT_MS);
  forceExit.unref();

  try {
    stopScheduler();
    if (server) {
      await new Promise<void>((resolve, reject) => {
        server?.close((err) => (err ? reject(err) : resolve()));
      });
    }

    await shutdownLogger();
    await pool.end();

    clearTimeout(forceExit);
    console.log('Shutdown complete.');
    process.exit(0);
  } catch (err) {
    logError('server.shutdown', 'error during graceful shutdown', err);
    await shutdownLogger().catch(() => {});
    process.exit(1);
  }
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => void shutdown(signal));
}

// Trigger reload

