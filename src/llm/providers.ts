import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { GoogleGenAI } from '@google/genai';
import Groq from 'groq-sdk';
import type { z } from 'zod';
import { llmConfig } from './config';
import { assertAllowance, noteProviderError } from './allowance';
import { llmLimiter } from './rateLimiter';
import {
  ProviderError,
  RateLimitError,
  RequestTooLargeError,
  TransientServerError,
  isQuotaExhausted,
  SchemaViolationError,
  TruncatedOutputError,
} from './errors';

// One structured-extraction call, provider-agnostic. Each provider returns the
// raw parsed object; the caller validates it against the zod schema (the single
// source of truth), so switching providers never changes the output contract.
export interface StructuredRequest {
  system: string;
  user: string;
  /** For Anthropic structured outputs + the caller's final validation. */
  zodSchema: z.ZodTypeAny;
  /** JSON Schema for providers that take one (Gemini `responseJsonSchema`). */
  jsonSchema: unknown;
  /** Override the configured output budget — the truncation retry raises it. */
  maxTokens?: number;
  /**
   * Override the reasoning budget for this call.
   *
   * Sized per STAGE, because the stages ask for different work. Filling a fixed
   * grid of test readings is lookup; recalling every clinical statement in a
   * session, in order, without inventing one is not, and the pass that does it
   * is the pass whose recall was failing. Providers that do not expose a
   * reasoning budget ignore this.
   */
  thinkingBudget?: number;
}

export interface StructuredResponse {
  parsed: unknown;
  /** Raw model text, kept so a failure downstream is still diagnosable. */
  raw: string | null;
}

export async function generateStructured(req: StructuredRequest): Promise<StructuredResponse> {
  // Refuse before the network if the day's allowance is already known to be
  // spent. This is ahead of the token limiter on purpose: pacing a call we are
  // certain will be refused just makes the refusal slower, and on a fanned-out
  // stage it makes three more of them wait their turn to be refused too.
  assertAllowance();

  // Pace under the provider's per-minute token budget before dispatching. Cost is
  // the prompt (~4 chars/token) plus the requested output budget, which is what
  // Groq's free tier bills against the TPM ceiling.
  const estimatedCost =
    Math.ceil((req.system.length + req.user.length) / 4) + (req.maxTokens ?? llmConfig.maxTokens);
  await llmLimiter.acquire(estimatedCost);

  // Every provider funnels its failures through here, so one catch closes the
  // gate for all four rather than each of them having to remember to.
  try {
    switch (llmConfig.provider) {
      case 'openrouter':
        return await openrouterExtract(req);
      case 'anthropic':
        return await anthropicExtract(req);
      case 'google':
        return await googleExtract(req);
      case 'groq':
        return await groqExtract(req);
      default:
        throw new Error(`unknown LLM_PROVIDER: ${llmConfig.provider}`);
    }
  } catch (err) {
    // `await` above rather than bare `return` is what makes this reachable:
    // returning the promise unawaited would settle it in the caller's frame and
    // this catch would never see a rejection.
    noteProviderError(err);
    throw err;
  }
}

/** Providers signal an over-budget response with these; every one means the JSON
 *  is cut off mid-structure, not that the model chose to stop. */
const TRUNCATION_REASONS = new Set(['max_tokens', 'MAX_TOKENS', 'length', 'model_length']);

function isRateLimit(err: unknown): boolean {
  const status = (err as { status?: number })?.status;
  return status === 429 || status === 529;
}

/** A server-side blip: the provider is up, this request just did not land. */
function isTransient(err: unknown): boolean {
  const status = (err as { status?: number })?.status;
  if (status === 500 || status === 502 || status === 503 || status === 504) return true;
  const msg = String((err as { message?: string })?.message ?? '');
  return /currently unavailable|experiencing high demand|overloaded|try again later/i.test(msg);
}

/**
 * 413, or a 429 whose message says the REQUEST is too large rather than that
 * too many were sent. Providers conflate the two under `rate_limit_exceeded`
 * (Groq returns 413 with that code), but they need opposite responses: back off
 * and retry, versus send less. Getting this wrong means retrying an identical
 * oversized request until the attempts run out.
 */
function isTooLarge(err: unknown): boolean {
  const status = (err as { status?: number })?.status;
  if (status === 413) return true;
  const msg = String((err as { message?: string })?.message ?? '');
  return /request too large|too many tokens|reduce your message size|context length/i.test(msg);
}

function retryAfterMs(err: unknown): number | null {
  const h = (err as { headers?: Record<string, string> })?.headers?.['retry-after'];
  const secs = h ? Number(h) : NaN;
  return Number.isFinite(secs) ? secs * 1000 : null;
}

/** Parse JSON, distinguishing "cut off" from "malformed". */
function parseJson(text: string, provider: string, finishReason: string | undefined): unknown {
  try {
    return JSON.parse(text);
  } catch (cause) {
    // A truncated response is nearly always unbalanced JSON. Prefer that
    // diagnosis when the provider told us it hit the cap, but fall back to it on
    // the shape too — Groq's JSON mode doesn't always set a finish reason.
    if (TRUNCATION_REASONS.has(finishReason ?? '') || looksTruncated(text)) {
      throw new TruncatedOutputError({ provider, raw: text, finishReason });
    }
    throw new SchemaViolationError('model returned unparseable JSON', { provider, raw: text, cause });
  }
}

function looksTruncated(text: string): boolean {
  const t = text.trimEnd();
  if (!t) return false;
  // Balanced JSON ends on a closing brace/bracket. Anything else mid-value.
  return !t.endsWith('}') && !t.endsWith(']');
}

// --- Anthropic (zod structured outputs) --------------------------------------
let anthropic: Anthropic | null = null;
function getAnthropic(): Anthropic {
  anthropic ??= new Anthropic({ apiKey: llmConfig.anthropic.apiKey || undefined });
  return anthropic;
}

async function anthropicExtract(req: StructuredRequest): Promise<StructuredResponse> {
  let res;
  try {
    res = await getAnthropic().messages.parse({
      model: llmConfig.anthropic.model,
      max_tokens: req.maxTokens ?? llmConfig.maxTokens,
      // Deterministic: this is constrained extraction, not generation. Sampling
      // variance here shows up as a clinical field that appears in one run and
      // not the next.
      temperature: 0,
      output_config: { effort: llmConfig.anthropic.effort, format: zodOutputFormat(req.zodSchema) },
      system: req.system,
      messages: [{ role: 'user', content: req.user }],
    });
  } catch (err) {
    if (isTooLarge(err)) throw new RequestTooLargeError({ provider: 'anthropic', cause: err });
    if (isTransient(err)) {
      throw new TransientServerError({
        provider: 'anthropic',
        status: (err as { status?: number })?.status,
        retryAfterMs: retryAfterMs(err),
        cause: err,
      });
    }
    if (isRateLimit(err)) {
      throw new RateLimitError({
        provider: 'anthropic',
        retryAfterMs: retryAfterMs(err),
        exhausted: isQuotaExhausted(err),
        cause: err,
      });
    }
    throw new ProviderError('anthropic request failed', { provider: 'anthropic', cause: err });
  }

  const text = res.content
    ?.map((b) => (b.type === 'text' ? b.text : ''))
    .join('') || null;

  if (!res.parsed_output) {
    if (TRUNCATION_REASONS.has(res.stop_reason ?? '')) {
      throw new TruncatedOutputError({ provider: 'anthropic', raw: text, finishReason: res.stop_reason ?? undefined });
    }
    throw new SchemaViolationError(
      `anthropic returned no structured output (stop_reason=${res.stop_reason})`,
      { provider: 'anthropic', raw: text },
    );
  }
  return { parsed: res.parsed_output, raw: text };
}

// --- Google Gemini (JSON-schema structured output) ---------------------------
let google: GoogleGenAI | null = null;
function getGoogle(): GoogleGenAI {
  google ??= new GoogleGenAI({ apiKey: llmConfig.google.apiKey });
  return google;
}

function extractGoogleRetryAfterMs(err: unknown): number | null {
  const std = retryAfterMs(err);
  if (std !== null) return std;
  const msg = String((err as { message?: string })?.message ?? '');
  const m = msg.match(/retry in ([0-9.]+)s/i);
  if (m) {
    const secs = Number.parseFloat(m[1]);
    if (Number.isFinite(secs)) return Math.ceil(secs * 1000);
  }
  return null;
}

async function googleExtract(req: StructuredRequest): Promise<StructuredResponse> {
  let res;
  try {
    res = await getGoogle().models.generateContent({
      model: llmConfig.google.model,
      contents: req.user,
      config: {
        systemInstruction: req.system,
        responseMimeType: 'application/json',
        responseJsonSchema: req.jsonSchema,
        temperature: 0,
        maxOutputTokens: req.maxTokens ?? llmConfig.maxTokens,
        // Cap the thinking rather than letting it consume the answer's budget.
        // See llmConfig.google.thinkingBudget.
        thinkingConfig: {
          thinkingBudget: req.thinkingBudget ?? llmConfig.google.thinkingBudget,
        },
      },
    });
  } catch (err) {
    if (isTooLarge(err)) throw new RequestTooLargeError({ provider: 'google', cause: err });
    if (isTransient(err)) {
      throw new TransientServerError({
        provider: 'google',
        status: (err as { status?: number })?.status,
        retryAfterMs: retryAfterMs(err),
        cause: err,
      });
    }
    if (isRateLimit(err)) {
      const waitMs = extractGoogleRetryAfterMs(err);
      throw new RateLimitError({
        provider: 'google',
        retryAfterMs: waitMs,
        exhausted: isQuotaExhausted(err),
        cause: err,
      });
    }
    throw new ProviderError('gemini request failed', { provider: 'google', cause: err });
  }

  const finishReason = res.candidates?.[0]?.finishReason as string | undefined;
  const text = res.text ?? null;
  if (!text) {
    if (TRUNCATION_REASONS.has(finishReason ?? '')) {
      throw new TruncatedOutputError({ provider: 'google', raw: null, finishReason });
    }
    throw new SchemaViolationError(`gemini returned no text output (finishReason=${finishReason})`, {
      provider: 'google',
      raw: null,
    });
  }
  return { parsed: parseJson(text, 'google', finishReason), raw: text };
}

// --- Groq (OpenAI-compatible, JSON mode) -------------------------------------
let groq: Groq | null = null;
function getGroq(): Groq {
  groq ??= new Groq({ apiKey: llmConfig.groq.apiKey });
  return groq;
}

/** Which Groq models accept `reasoning_effort`. Sending it to one that doesn't
 *  is a 400, so this stays a positive list rather than a try-and-see. */
function supportsReasoningEffort(model: string): boolean {
  return /gpt-oss|qwen3|deepseek-r1/i.test(model);
}

/**
 * Groq's 400 for "the model produced nothing valid to parse".
 *
 * Worth naming because it is thrown for a cause the message actively misleads
 * about: "Please adjust your prompt" reads as a schema problem, and on a
 * reasoning model it usually means the completion budget went on reasoning
 * tokens. Classified as truncation so the message points somewhere useful — but
 * note the retry-bigger path can 413 on a small tier, which is why the real fix
 * is reasoning_effort, not a larger budget.
 */
function isJsonValidateFailed(err: unknown): boolean {
  const msg = String((err as { message?: string })?.message ?? '');
  return /json_validate_failed|failed to validate json/i.test(msg);
}

/**
 * OpenRouter — an OpenAI-compatible gateway, used here for its wide-context free
 * models (default: nvidia/nemotron-3-super-120b-a12b:free, 262k).
 *
 * Plain `fetch` rather than a fifth SDK: the request is one POST, and the error
 * classifiers below key off `status`, which is easy to attach and hard to get
 * from a wrapper that has already reshaped the failure.
 *
 * The point of this provider is what it removes. On an 8k/min tier a 35-minute
 * session becomes 4 chunks x 3 stages = 12 calls, and the narrative stage is
 * documented as one that must NOT chunk — a chunk that does not contain a
 * concern cannot know the concern exists, which is exactly why `concerns` came
 * back empty run after run. With the whole transcript in one call that failure
 * mode does not exist.
 */
async function openrouterExtract(req: StructuredRequest): Promise<StructuredResponse> {
  const cfg = llmConfig.openrouter;
  if (!cfg.apiKey) {
    throw new ProviderError('OpenRouter not configured — set OPENROUTER_API_KEY', {
      provider: 'openrouter',
    });
  }
  const schemaStr = req.jsonSchema ? JSON.stringify(req.jsonSchema) : '';

  let res: Response;
  try {
    res = await fetch(`${cfg.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${cfg.apiKey}`,
        'content-type': 'application/json',
        // Attribution only — OpenRouter shows these on the account's activity page.
        'HTTP-Referer': cfg.appUrl,
        'X-Title': cfg.appTitle,
      },
      body: JSON.stringify({
        model: cfg.model,
        temperature: 0,
        max_tokens: req.maxTokens ?? llmConfig.maxTokens,
        reasoning: { effort: cfg.reasoningEffort },
        response_format: { type: 'json_object' },
        messages: [
          {
            role: 'system',
            content:
              req.system +
              '\n\nYou must return a JSON object matching this schema:\n' +
              schemaStr +
              '\n\nRespond with valid JSON only.',
          },
          { role: 'user', content: req.user },
        ],
      }),
    });
  } catch (err) {
    // Network-level failure: no status to classify, and retrying immediately
    // would not help, so surface it as-is rather than guessing a category.
    throw new ProviderError('openrouter request failed', { provider: 'openrouter', cause: err });
  }

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    // Give the classifiers below the shape they expect from an SDK error.
    const err = Object.assign(new Error(`${res.status} ${body}`), { status: res.status, headers: hdrs(res) });
    if (isTooLarge(err)) throw new RequestTooLargeError({ provider: 'openrouter', cause: err });
    if (isTransient(err)) {
      throw new TransientServerError({
        provider: 'openrouter',
        status: (err as { status?: number })?.status,
        retryAfterMs: retryAfterMs(err),
        cause: err,
      });
    }
    if (isRateLimit(err)) {
      throw new RateLimitError({
        provider: 'openrouter',
        retryAfterMs: retryAfterMs(err),
        exhausted: isQuotaExhausted(err),
        cause: err,
      });
    }
    if (isJsonValidateFailed(err)) {
      throw new TruncatedOutputError({ provider: 'openrouter', raw: null, finishReason: 'json_validate_failed' });
    }
    throw new ProviderError('openrouter request failed', { provider: 'openrouter', cause: err });
  }

  const json = (await res.json()) as {
    choices?: { finish_reason?: string; message?: { content?: string | null } }[];
    error?: { message?: string };
  };
  // OpenRouter can answer 200 with an error body when an upstream provider fails.
  if (json.error) {
    throw new ProviderError(`openrouter upstream error: ${json.error.message ?? 'unknown'}`, {
      provider: 'openrouter',
      raw: null,
    });
  }
  const choice = json.choices?.[0];
  const finishReason = choice?.finish_reason;
  const text = choice?.message?.content ?? null;
  if (!text) {
    if (TRUNCATION_REASONS.has(finishReason ?? '')) {
      throw new TruncatedOutputError({ provider: 'openrouter', raw: null, finishReason });
    }
    throw new SchemaViolationError(`openrouter returned no content (finish_reason=${finishReason})`, {
      provider: 'openrouter',
      raw: null,
    });
  }
  return { parsed: parseJson(text, 'openrouter', finishReason), raw: text };
}

/** `retry-after` off a fetch Response, in the record shape retryAfterMs expects. */
function hdrs(res: Response): Record<string, string> {
  const out: Record<string, string> = {};
  const ra = res.headers.get('retry-after');
  if (ra) out['retry-after'] = ra;
  return out;
}

async function groqExtract(req: StructuredRequest): Promise<StructuredResponse> {
  // Compact (no indentation): the pretty-printed schema's whitespace is pure
  // token overhead on every call, and on the largest real transcripts those
  // ~hundreds of tokens are the difference between fitting the free-tier
  // per-minute budget and a 413. Same information, fewer tokens.
  const schemaStr = req.jsonSchema ? JSON.stringify(req.jsonSchema) : '';
  let completion;
  try {
    completion = await getGroq().chat.completions.create({
      model: llmConfig.groq.model,
      temperature: 0,
      max_completion_tokens: req.maxTokens ?? llmConfig.maxTokens,
      // See llmConfig.groq.reasoningEffort: without this a reasoning model burns
      // the whole completion budget thinking and returns nothing to validate.
      ...(supportsReasoningEffort(llmConfig.groq.model)
        ? { reasoning_effort: llmConfig.groq.reasoningEffort }
        : {}),
      response_format: { type: 'json_object' },
      messages: [
        {
          role: 'system',
          content:
            req.system +
            '\n\nYou must return a JSON object matching this schema:\n' +
            schemaStr +
            '\n\nRespond with valid JSON only.',
        },
        { role: 'user', content: req.user },
      ],
    });
  } catch (err) {
    if (isTooLarge(err)) throw new RequestTooLargeError({ provider: 'groq', cause: err });
    if (isTransient(err)) {
      throw new TransientServerError({
        provider: 'groq',
        status: (err as { status?: number })?.status,
        retryAfterMs: retryAfterMs(err),
        cause: err,
      });
    }
    if (isRateLimit(err)) {
      throw new RateLimitError({
        provider: 'groq',
        retryAfterMs: retryAfterMs(err),
        exhausted: isQuotaExhausted(err),
        cause: err,
      });
    }
    if (isJsonValidateFailed(err)) {
      throw new TruncatedOutputError({ provider: 'groq', raw: null, finishReason: 'json_validate_failed' });
    }
    throw new ProviderError('groq request failed', { provider: 'groq', cause: err });
  }

  const choice = completion.choices[0];
  const finishReason = choice?.finish_reason as string | undefined;
  const text = choice?.message?.content ?? null;
  if (!text) {
    if (TRUNCATION_REASONS.has(finishReason ?? '')) {
      throw new TruncatedOutputError({ provider: 'groq', raw: null, finishReason });
    }
    throw new SchemaViolationError(`groq returned no content (finish_reason=${finishReason})`, {
      provider: 'groq',
      raw: null,
    });
  }
  return { parsed: parseJson(text, 'groq', finishReason), raw: text };
}
