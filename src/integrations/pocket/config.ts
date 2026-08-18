// Pocket (heypocketai.com) connection config.
//
// Unlike Bee — whose data was end-to-end encrypted and readable only on the
// owner-authenticated machine, which is why a courier had to run on Nicole's
// laptop — Pocket exposes a plain server-to-server REST API behind a static
// API key. So the backend talks to it directly and nothing needs to run on her
// machine for transcripts to land.
//
// Two ingress paths, both optional and independently configurable:
//   • webhook — Pocket POSTs us on `summary.completed` etc. Low latency, but
//     needs POCKET_WEBHOOK_SECRET and a destination configured in the Pocket app.
//   • poller  — we sweep GET /public/recordings. Needs only POCKET_API_KEY.
// Running both is the intended setup: the webhook is the fast path, the poller
// is the backstop for a delivery that never arrived.

export interface PocketConfig {
  apiKey: string;
  baseUrl: string;
}

export interface PocketPollConfig {
  enabled: boolean;
  /** How far back each sweep looks. Covers a webhook outage of up to this long. */
  lookbackDays: number;
  /** Bounds a sweep so a bad `has_more` can't page forever. */
  maxPages: number;
}

export const POCKET_DEFAULT_BASE_URL = 'https://public.heypocketai.com/api/v1';

// How far back a sweep looks by default.
//
// This was 3 days, which is too short to be a backstop. A recording made on a
// Friday and never delivered by webhook is invisible by Monday-plus-one, and
// invisible permanently — the poller is the only other path, and once a
// recording ages out of the window nothing ever looks at it again. That is
// exactly what happened to a real 35-minute client session: it sat in Pocket
// `completed` with a full transcript while every sweep reported `scanned: 0`.
//
// 30 days costs nothing to scan — listing is one cheap call per 100 recordings,
// and the detail fetch is skipped for anything already ingested (see the poller)
// — and it turns "lost" back into "late".
export const DEFAULT_LOOKBACK_DAYS = 30;

/**
 * Whether the scheduler that OWNS the poll tick is actually running.
 *
 * Kept separate from `pocketPollConfig().enabled` on purpose: that answers "is
 * polling configured", and a status screen that conflates the two will cheerfully
 * report polling ON while nothing sweeps at all.
 */
export function isSchedulerEnabled(): boolean {
  return process.env.SCHEDULER_ENABLED === 'true';
}

/** True when the REST API is usable (poller + backfill). */
export function isPocketConfigured(): boolean {
  return !!process.env.POCKET_API_KEY;
}

/** True when inbound webhooks can be signature-verified. */
export function isPocketWebhookConfigured(): boolean {
  return !!process.env.POCKET_WEBHOOK_SECRET;
}

/** Resolve REST config, or throw when Pocket isn't configured. */
export function pocketConfig(): PocketConfig {
  const apiKey = process.env.POCKET_API_KEY;
  if (!apiKey) {
    throw new Error('Pocket not configured — set POCKET_API_KEY (a pk_… key from the Pocket app)');
  }
  return {
    apiKey,
    baseUrl: (process.env.POCKET_API_BASE_URL ?? POCKET_DEFAULT_BASE_URL).replace(/\/+$/, ''),
  };
}

/** The signing secret shown once when a webhook destination is created. */
export function pocketWebhookSecret(): string | null {
  return process.env.POCKET_WEBHOOK_SECRET || null;
}

export function pocketPollConfig(): PocketPollConfig {
  return {
    // Default ON whenever the API key is present: an operator who configured
    // only the key still gets transcripts, just a poll interval later. The
    // failure mode of the opposite default is silence, which looks like the
    // product being broken.
    enabled: process.env.POCKET_POLL_ENABLED !== 'false' && isPocketConfigured(),
    lookbackDays: positiveInt(process.env.POCKET_POLL_LOOKBACK_DAYS, DEFAULT_LOOKBACK_DAYS),
    maxPages: positiveInt(process.env.POCKET_POLL_MAX_PAGES, 20),
  };
}

function positiveInt(raw: string | undefined, fallback: number): number {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}
