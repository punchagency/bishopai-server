/**
 * Is Pocket actually feeding us right now?
 *
 * Everything on our side is built and unit-tested. What no unit test can tell
 * you is whether the credential Nicole pasted works against the real service,
 * so this is the check to run the moment the `pk_…` key exists. It proves, in
 * order, the four things that must be true for a session to land:
 *
 *   1. The key is accepted (401 here means a bad/revoked key, not our bug).
 *   2. Recordings are listable — the poller's backstop can see the device.
 *   3. A real recording normalizes into an ingestable conversation. This is
 *      the one that matters: Pocket's REST `data` payload is undocumented, so
 *      a field rename upstream would show up here as "no time window" long
 *      before it showed up as a silently unmatched session in the review queue.
 *   4. The webhook ingress verifies signatures — checked by POSTing a signed
 *      `recording.created`, an event the handler acknowledges and ignores, so
 *      the probe writes nothing to the database.
 *
 * Read-only against Pocket. Nothing here creates, edits or deletes anything.
 *
 * Usage:
 *   npm run check:pocket                      # Pocket API only
 *   npm run check:pocket -- --webhook         # also probe http://localhost:3000
 *   npm run check:pocket -- --webhook https://host   # …or a deployed backend
 */
import 'dotenv/config';

import { getRecording, listRecordings } from '../src/integrations/pocket/client';
import {
  isPocketConfigured,
  isPocketWebhookConfigured,
  pocketConfig,
  pocketPollConfig,
} from '../src/integrations/pocket/config';
import { toConversationInput } from '../src/integrations/pocket/normalize';
import {
  POCKET_SIGNATURE_HEADER,
  POCKET_TIMESTAMP_HEADER,
  signPocketPayload,
} from '../src/integrations/pocket/signature';

const ok = (m: string): void => console.log(`  \x1b[32m✓\x1b[0m ${m}`);
const bad = (m: string): void => console.log(`  \x1b[31m✗\x1b[0m ${m}`);
const warn = (m: string): void => console.log(`  \x1b[33m!\x1b[0m ${m}`);
const fix = (m: string): void => console.log(`      → ${m}`);

const args = process.argv.slice(2);
const webhookFlag = args.indexOf('--webhook');
const webhookBase =
  webhookFlag === -1
    ? null
    : (args[webhookFlag + 1] && !args[webhookFlag + 1].startsWith('--')
        ? args[webhookFlag + 1]
        : 'http://localhost:3000'
      ).replace(/\/+$/, '');

/** Days back to look. Wide enough that a device paired yesterday still shows. */
const LOOKBACK_DAYS = 30;

function utcDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function main(): Promise<void> {
  console.log('\nPocket ingress\n');

  if (!isPocketConfigured()) {
    bad('POCKET_API_KEY not set — no transcript can reach the pipeline.');
    fix('Pocket app → Settings → Integrations → create an API key (pk_…).');
    fix('Put it in server/.env as POCKET_API_KEY, then re-run this.');
    process.exitCode = 1;
    return;
  }

  const cfg = pocketConfig();
  if (!/^pk_/.test(cfg.apiKey)) {
    warn(`Key does not start with "pk_" — check you copied the API key, not the webhook secret.`);
  }
  ok(`Key present (${cfg.apiKey.slice(0, 6)}…${cfg.apiKey.slice(-4)}), base ${cfg.baseUrl}`);

  // --- 1 + 2: does the key work, and can we see recordings? -----------------
  const now = new Date();
  let listed;
  try {
    listed = await listRecordings({
      startDate: utcDate(new Date(now.getTime() - LOOKBACK_DAYS * 86_400_000)),
      endDate: utcDate(now),
      limit: 10,
    });
  } catch (err) {
    const msg = message(err);
    if (/\b401\b|unauthor/i.test(msg)) {
      bad('Pocket rejected the key (401).');
      fix('Regenerate it in the Pocket app and update POCKET_API_KEY.');
    } else if (/\b403\b/.test(msg)) {
      bad('Key accepted but not permitted (403) — it may lack recordings access.');
    } else {
      bad(`Could not reach Pocket: ${msg}`);
      fix(`Confirm the host is reachable: ${cfg.baseUrl}/public/recordings`);
    }
    process.exitCode = 1;
    return;
  }
  ok('Key accepted — Pocket API is reachable.');

  const poll = pocketPollConfig();
  if (poll.enabled) ok(`Polling backstop ON (${poll.lookbackDays}d lookback, every 10 min by default).`);
  else warn('Polling backstop DISABLED (POCKET_POLL_ENABLED=false) — webhook is the only ingress.');

  if (listed.recordings.length === 0) {
    warn(`No recordings in the last ${LOOKBACK_DAYS} days.`);
    fix('Record a 1-minute test on the device, wait for it to transcribe, re-run.');
    console.log('');
    await probeWebhook();
    return;
  }
  ok(`${listed.recordings.length} recording(s) visible in the last ${LOOKBACK_DAYS} days.`);

  // --- 3: does a real recording become something we can ingest? ------------
  const newest = listed.recordings.find((r) => typeof r.id === 'string' && r.id.trim());
  if (!newest?.id) {
    bad('Recordings came back with no usable id — the poller cannot fetch details.');
    process.exitCode = 1;
    return;
  }

  console.log(`\n  Newest recording: ${newest.title ?? '(untitled)'} [${newest.id}]`);
  try {
    const detail = await getRecording(newest.id);
    const input = toConversationInput(detail);

    if (!input) {
      bad('Detail payload does NOT normalize — no id or no time window.');
      fix('This recording would land unmatched for a human. Field shapes seen:');
      fix(JSON.stringify(detail.recording ?? {}).slice(0, 300));
      process.exitCode = 1;
      return;
    }

    ok(`Time window resolved: ${input.starts_at} → ${input.ends_at}`);
    const chars = input.transcript?.length ?? 0;
    if (chars > 0) {
      ok(`Transcript present (${chars.toLocaleString()} chars) — extraction has something to read.`);
    } else {
      warn('No transcript text on this recording — still processing, or audio-only.');
      fix('A transcript-less conversation ingests but extracts nothing.');
    }
  } catch (err) {
    bad(`Could not fetch recording detail: ${message(err)}`);
    process.exitCode = 1;
    return;
  }

  console.log('');
  await probeWebhook();
}

/**
 * Prove the webhook ingress end to end without writing anything.
 *
 * `recording.created` is deliberate: it is outside TRANSCRIPT_EVENTS, so the
 * handler acknowledges and ignores it. That exercises routing, raw-body
 * capture and signature verification while leaving the conversations table
 * untouched — a self-test must never invent a session in Nicole's queue.
 */
async function probeWebhook(): Promise<void> {
  const secretSet = isPocketWebhookConfigured();

  if (!webhookBase) {
    if (secretSet) ok('POCKET_WEBHOOK_SECRET set — deliveries will be signature-verified.');
    else warn('POCKET_WEBHOOK_SECRET not set — the webhook accepts UNSIGNED posts (dev only).');
    fix('Add --webhook [url] to actually POST a signed probe at the running server.');
    return;
  }

  const target = `${webhookBase}/webhooks/pocket`;
  const body = JSON.stringify({
    event: 'recording.created',
    timestamp: new Date().toISOString(),
    recording: { id: `check-pocket-probe-${Date.now()}`, title: 'check:pocket probe' },
  });
  const ts = String(Date.now());

  const post = (headers: Record<string, string>) =>
    fetch(target, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body });

  // Signed delivery — must be accepted and ignored.
  try {
    const signed = await post({
      [POCKET_SIGNATURE_HEADER]: signPocketPayload(process.env.POCKET_WEBHOOK_SECRET ?? '', ts, body),
      [POCKET_TIMESTAMP_HEADER]: ts,
    });
    if (signed.ok) ok(`Signed probe accepted by ${target} (HTTP ${signed.status}, ignored as designed).`);
    else {
      bad(`Signed probe rejected by ${target} (HTTP ${signed.status}).`);
      fix(signed.status === 401 ? 'The server\'s POCKET_WEBHOOK_SECRET differs from this one.' : 'Check server logs.');
      process.exitCode = 1;
    }
  } catch (err) {
    bad(`Webhook unreachable at ${target}: ${message(err)}`);
    fix('Is the server running? Pocket also needs this URL to be public, not localhost.');
    process.exitCode = 1;
    return;
  }

  // Forged delivery — must be refused. Only meaningful once a secret is set;
  // unset deliberately fails open so the offline demo runs credential-free.
  if (!secretSet) {
    warn('Forgery check skipped — no POCKET_WEBHOOK_SECRET, so the endpoint fails open.');
    fix('Set it from the Pocket webhook destination before going live.');
    return;
  }
  const forged = await post({ [POCKET_SIGNATURE_HEADER]: 'deadbeef', [POCKET_TIMESTAMP_HEADER]: ts });
  if (forged.status === 401) ok('Forged signature refused (401) — the endpoint is genuinely protected.');
  else {
    bad(`Forged signature was NOT refused (HTTP ${forged.status}) — anyone can post fake sessions.`);
    fix('Confirm POCKET_WEBHOOK_SECRET is set in the SERVER\'s environment, not just locally.');
    process.exitCode = 1;
  }
}

main()
  .then(() => {
    console.log(
      process.exitCode ? '\n  Pocket ingress: \x1b[31mBLOCKED\x1b[0m — fix the ✗ items above\n' : '\n  Pocket ingress: \x1b[32mREADY\x1b[0m\n',
    );
  })
  .catch((err) => {
    console.error('check failed:', err);
    process.exit(1);
  });
