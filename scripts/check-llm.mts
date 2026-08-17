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

async function main(): Promise<void> {
  console.log(`\nLLM preflight — provider: ${llmConfig.provider}\n`);

  if (llmConfig.provider === 'mock') {
    console.log('  mock provider: no credentials needed, extraction runs offline.');
    process.exit(0);
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
