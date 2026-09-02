#!/usr/bin/env node
/**
 * Preflight for the configured LLM: does the model still exist, and can it
 * actually answer?
 *
 * This exists because a pinned Groq model was decommissioned underneath a
 * working install. Every extraction stage began returning
 *
 *   404 The model `llama-3.3-70b-versatile` does not exist or you do not
 *       have access to it
 *
 * and the pipeline's own resilience hid it: a stage that fails is recorded as
 * `partial` and the session is saved with the rest intact, which is right when
 * one stage times out and wrong when the model is simply gone. The note still
 * arrived, just empty, and nothing said why. On a free tier whose model list
 * changes without notice, "is the thing we call still there" needs to be one
 * command rather than a forensic exercise.
 *
 * Also reports the tier's REAL rate limits, read off the response headers. The
 * extraction budget in llm/config.ts is derived from them, and they are not the
 * documented numbers — the free tier answered with 8000 tokens/minute where the
 * config had long assumed ~12000, which is the difference between a session
 * extracting in one pass and every stage 413ing before it starts.
 *
 * Usage:
 *   npm run check:llm
 */
import 'dotenv/config';
import { llmConfig } from '../src/llm/config.js';

interface Result {
  ok: boolean;
  detail: string;
}

const GROQ_BASE = 'https://api.groq.com/openai/v1';

async function checkGroq(): Promise<Result> {
  const key = process.env.GROQ_API_KEY;
  if (!key) return { ok: false, detail: 'GROQ_API_KEY is not set' };
  const want = llmConfig.groq.model;

  // 1. Is the configured model in the account's list at all?
  const listRes = await fetch(`${GROQ_BASE}/models`, {
    headers: { Authorization: `Bearer ${key}` },
  });
  if (!listRes.ok) {
    return { ok: false, detail: `could not list models: ${listRes.status} ${await listRes.text()}` };
  }
  const list = (await listRes.json()) as { data?: { id: string }[] };
  const available = (list.data ?? []).map((m) => m.id).sort();
  const present = available.includes(want);

  console.log(`  configured model : ${want}`);
  console.log(`  in model list    : ${present ? 'yes' : 'NO'}`);
  if (!present) {
    // The whole point of the check: name the replacements rather than leaving
    // whoever runs this to guess which of them is a chat model.
    const chatty = available.filter(
      (id) => !/whisper|guard|orpheus|tts|embedding/i.test(id),
    );
    console.log(`\n  available chat models:`);
    for (const id of chatty) console.log(`    - ${id}`);
    return {
      ok: false,
      detail: `model "${want}" is gone — set GROQ_MODEL to one of the above (or unset it to take the built-in default)`,
    };
  }

  // 2. Being listed is not the same as being callable. Ask it something tiny.
  const t0 = Date.now();
  const res = await fetch(`${GROQ_BASE}/chat/completions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: want,
      messages: [{ role: 'user', content: 'Reply with the single word: ok' }],
      max_completion_tokens: 8,
    }),
  });
  const body = await res.text();
  if (!res.ok) return { ok: false, detail: `completion failed: ${res.status} ${body}` };
  console.log(`  test completion  : ok (${Date.now() - t0}ms)`);

  // 3. The real limits, and whether our budget matches them.
  const limitTokens = Number(res.headers.get('x-ratelimit-limit-tokens') ?? 0);
  const limitReqs = res.headers.get('x-ratelimit-limit-requests') ?? '?';
  console.log(`\n  rate limits (from response headers):`);
  console.log(`    tokens/minute  : ${limitTokens || 'unknown'}`);
  console.log(`    requests/minute: ${limitReqs}`);
  console.log(`\n  extraction budget (llm/config.ts):`);
  console.log(`    tokensPerMinute      : ${llmConfig.tokensPerMinute}`);
  console.log(`    maxTokens (completion): ${llmConfig.maxTokens}`);
  console.log(`    chunkThresholdTokens : ${llmConfig.chunkThresholdTokens}`);
  console.log(`    chunkTargetTokens    : ${llmConfig.chunkTargetTokens}`);

  if (limitTokens && llmConfig.tokensPerMinute > limitTokens) {
    return {
      ok: false,
      detail:
        `budget is above the real ceiling (${llmConfig.tokensPerMinute} > ${limitTokens}). ` +
        `The limiter will admit calls the API refuses; set LLM_TOKENS_PER_MINUTE=${limitTokens}.`,
    };
  }
  // A chunk has to carry its completion reservation and the prompt with it.
  const worstChunk = llmConfig.chunkTargetTokens + llmConfig.maxTokens + 800;
  if (limitTokens && worstChunk > limitTokens) {
    return {
      ok: false,
      detail:
        `a full chunk call needs ~${worstChunk} tokens against a ${limitTokens} ceiling — ` +
        `every call will 413. Lower EXTRACTION_CHUNK_TARGET_TOKENS or LLM_MAX_TOKENS.`,
    };
  }
  console.log(`    worst-case call      : ~${worstChunk} (ceiling ${limitTokens || '?'})`);
  return { ok: true, detail: 'model reachable and budget fits the tier' };
}

const OPENROUTER_DEFAULT_BASE = 'https://openrouter.ai/api/v1';

async function checkOpenRouter(): Promise<Result> {
  const cfg = llmConfig.openrouter;
  if (!cfg.apiKey) return { ok: false, detail: 'OPENROUTER_API_KEY is not set' };
  const base = cfg.baseUrl || OPENROUTER_DEFAULT_BASE;
  const want = cfg.model;

  // 1. Is the configured model still offered? Free model ids come and go (and
  //    the ":free" suffix is dropped when a model leaves the free tier), so this
  //    is the same decommission trap that caught us on Groq.
  const listRes = await fetch(`${base}/models`);
  if (!listRes.ok) {
    return { ok: false, detail: `could not list models: ${listRes.status} ${await listRes.text()}` };
  }
  const list = (await listRes.json()) as {
    data?: { id: string; context_length?: number; supported_parameters?: string[] }[];
  };
  const found = (list.data ?? []).find((m) => m.id === want);

  console.log(`  configured model : ${want}`);
  console.log(`  in model list    : ${found ? 'yes' : 'NO'}`);
  if (!found) {
    const free = (list.data ?? []).filter((m) => m.id.endsWith(':free')).map((m) => m.id).sort();
    console.log(`\n  free models currently offered:`);
    for (const id of free.slice(0, 40)) console.log(`    - ${id}`);
    return { ok: false, detail: `model "${want}" is gone — set OPENROUTER_MODEL to one of the above` };
  }

  const params = found.supported_parameters ?? [];
  const ctx = found.context_length ?? 0;
  console.log(`  context window   : ${ctx.toLocaleString()} tokens`);
  console.log(`  structured JSON  : ${params.includes('response_format') ? 'response_format' : 'NO response_format'}` +
    `${params.includes('structured_outputs') ? ' + structured_outputs' : ''}`);
  console.log(`  reasoning_effort : ${params.includes('reasoning_effort') || params.includes('reasoning') ? 'yes' : 'no'}`);

  // The pipeline sends a JSON schema and parses the reply; a model that cannot
  // be constrained to JSON will fail on every single call, not occasionally.
  if (!params.includes('response_format')) {
    return {
      ok: false,
      detail: `"${want}" does not support response_format — every extraction call would return prose, not JSON`,
    };
  }

  // 2. Listed is not callable. Ask it something tiny.
  const t0 = Date.now();
  const res = await fetch(`${base}/chat/completions`, {
    method: 'POST',
    headers: { authorization: `Bearer ${cfg.apiKey}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      model: want,
      messages: [{ role: 'user', content: 'Reply with JSON: {"ok":true}' }],
      response_format: { type: 'json_object' },
      max_tokens: 32,
    }),
  });
  const body = await res.text();
  if (!res.ok) return { ok: false, detail: `completion failed: ${res.status} ${body}` };
  console.log(`  test completion  : ok (${Date.now() - t0}ms)`);

  // 3. Does a whole session fit in one call? This is the entire reason for the
  //    provider — if it does not, we are back to chunking and its failure modes.
  console.log(`\n  extraction budget (llm/config.ts):`);
  console.log(`    tokensPerMinute      : ${llmConfig.tokensPerMinute}`);
  console.log(`    maxTokens (completion): ${llmConfig.maxTokens}`);
  console.log(`    chunkThresholdTokens : ${llmConfig.chunkThresholdTokens}`);
  const typicalSession = 7_000; // the real 35-minute transcript measures ~6,960
  const singlePass = llmConfig.chunkThresholdTokens >= typicalSession;
  console.log(`    a ~${typicalSession}-token session : ${singlePass ? 'ONE call per stage' : 'CHUNKED'}`);
  if (!singlePass) {
    return {
      ok: false,
      detail:
        `threshold ${llmConfig.chunkThresholdTokens} is below a typical session — still chunking, ` +
        `which is the thing this provider was chosen to avoid.`,
    };
  }

  // 4. Free-tier limits are per-REQUEST, not per-minute-tokens. Worth showing.
  const keyRes = await fetch(`${base}/auth/key`, { headers: { authorization: `Bearer ${cfg.apiKey}` } });
  if (keyRes.ok) {
    const k = (await keyRes.json()) as { data?: Record<string, unknown> };
    const d = k.data ?? {};
    console.log(`\n  account:`);
    console.log(`    usage / limit  : ${String(d.usage ?? '?')} / ${d.limit ?? 'unlimited'}`);
    console.log(`    free tier      : ${d.is_free_tier === true ? 'yes' : 'no'}`);
    console.log(`    rate limit     : ${JSON.stringify(d.rate_limit ?? 'unknown')}`);
  }
  return { ok: true, detail: 'model reachable, JSON-capable, and a whole session fits one call' };
}

async function checkGoogle(): Promise<Result> {
  const cfg = llmConfig.google;
  const keys = cfg.apiKeys;
  if (!keys.length) return { ok: false, detail: 'GOOGLE_API_KEY (or GEMINI_API_KEY) is not set' };
  const base = 'https://generativelanguage.googleapis.com/v1beta';
  const want = cfg.model;
  const key = keys[0];

  const listRes = await fetch(`${base}/models?key=${key}`);
  if (!listRes.ok) {
    return { ok: false, detail: `could not list models: ${listRes.status} ${await listRes.text()}` };
  }
  const list = (await listRes.json()) as {
    models?: { name: string; inputTokenLimit?: number; outputTokenLimit?: number;
               supportedGenerationMethods?: string[] }[];
  };
  const usable = (list.models ?? []).filter((m) =>
    (m.supportedGenerationMethods ?? []).includes('generateContent'),
  );
  const found = usable.find((m) => m.name.replace('models/', '') === want);

  console.log(`  configured model : ${want}`);
  console.log(`  in model list    : ${found ? 'yes' : 'NO'}`);
  if (!found) {
    // The reason this check exists: the built-in default was gemini-2.0-flash
    // long after Google retired it.
    const flash = usable
      .map((m) => m.name.replace('models/', ''))
      .filter((n) => /^gemini-[\d.]+-(flash|pro)/.test(n) && !n.includes('preview'))
      .sort();
    console.log(`\n  stable gemini chat models available:`);
    for (const n of flash) console.log(`    - ${n}`);
    return { ok: false, detail: `model "${want}" is gone — set GEMINI_MODEL to one of the above` };
  }
  console.log(`  context window   : ${(found.inputTokenLimit ?? 0).toLocaleString()} in / ` +
    `${(found.outputTokenLimit ?? 0).toLocaleString()} out`);

  const t0 = Date.now();
  const res = await fetch(`${base}/models/${want}:generateContent?key=${key}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      contents: [{ parts: [{ text: 'Reply with JSON: {"ok":true}' }] }],
      generationConfig: { responseMimeType: 'application/json', maxOutputTokens: 64 },
    }),
  });
  const body = await res.text();
  if (!res.ok) return { ok: false, detail: `completion failed: ${res.status} ${body}` };
  console.log(`  test completion  : ok (${Date.now() - t0}ms)`);

  // Spare keys. llm/keyring.ts rotates onto these the moment the primary answers
  // "per-day quota exhausted", which is the worst possible time to discover that
  // a spare was revoked, mistyped, or never enabled for this API. One request
  // each, spent deliberately here rather than mid-extraction.
  if (keys.length > 1) {
    console.log(`\n  failover keys    : ${keys.length - 1} spare`);
    for (let i = 1; i < keys.length; i++) {
      const spare = keys[i];
      const label = `key ${i + 1} of ${keys.length} (…${spare.slice(-4)})`;
      const probe = await fetch(`${base}/models/${want}:generateContent?key=${spare}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: 'Reply with JSON: {"ok":true}' }] }],
          generationConfig: { responseMimeType: 'application/json', maxOutputTokens: 64 },
        }),
      });
      if (probe.ok) {
        console.log(`    ${label}: ok`);
      } else {
        const detail = (await probe.text()).replace(/\s+/g, ' ').slice(0, 180);
        console.log(`    ${label}: FAILED ${probe.status} ${detail}`);
        return {
          ok: false,
          detail: `failover ${label} does not work — it will not save an exhausted primary`,
        };
      }
    }
    // Worth stating plainly: the free-tier per-day cap is scoped to the Google
    // Cloud PROJECT, not to the key. Two keys minted in one project share one
    // allowance, so the rotation would move onto a key that is already spent.
    console.log(`    note: a spare adds allowance only if it is in a DIFFERENT Google Cloud project`);
  }

  console.log(`\n  extraction budget (llm/config.ts):`);
  console.log(`    maxTokens (completion): ${llmConfig.maxTokens}`);
  console.log(`    thinking headroom     : ${llmConfig.reasoningHeadroomTokens}`);
  console.log(`    thinkingBudget        : ${cfg.thinkingBudget}`);
  console.log(`    chunkThresholdTokens  : ${llmConfig.chunkThresholdTokens}`);
  const typicalSession = 7_000;
  const singlePass = llmConfig.chunkThresholdTokens >= typicalSession;
  console.log(`    a ~${typicalSession}-token session : ${singlePass ? 'ONE call per stage' : 'CHUNKED'}`);
  if (!singlePass) {
    return { ok: false, detail: `threshold ${llmConfig.chunkThresholdTokens} is below a typical session — still chunking` };
  }
  return { ok: true, detail: 'model reachable, JSON-capable, and a whole session fits one call' };
}

async function main(): Promise<void> {
  console.log(`\nLLM preflight — provider: ${llmConfig.provider}\n`);

  if (llmConfig.provider === 'mock') {
    console.log('  mock provider: no credentials needed, extraction runs offline.');
    process.exit(0);
  }
  if (llmConfig.provider === 'google') {
    const result = await checkGoogle();
    console.log(`\n${result.ok ? 'OK' : 'FAILED'}: ${result.detail}\n`);
    process.exit(result.ok ? 0 : 1);
  }
  if (llmConfig.provider === 'openrouter') {
    const result = await checkOpenRouter();
    console.log(`\n${result.ok ? 'OK' : 'FAILED'}: ${result.detail}\n`);
    process.exit(result.ok ? 0 : 1);
  }
  if (llmConfig.provider !== 'groq') {
    console.log(`  no preflight implemented for "${llmConfig.provider}" yet.`);
    process.exit(0);
  }

  const result = await checkGroq();
  console.log(`\n${result.ok ? 'OK' : 'FAILED'}: ${result.detail}\n`);
  process.exit(result.ok ? 0 : 1);
}

main().catch((err) => {
  console.error(`\nFAILED: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
