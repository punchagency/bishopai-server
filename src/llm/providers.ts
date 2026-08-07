import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { GoogleGenAI } from '@google/genai';
import Groq from 'groq-sdk';
import type { z } from 'zod';
import { llmConfig } from './config';
import { llmLimiter } from './rateLimiter';
import {
  ProviderError,
  RateLimitError,
  RequestTooLargeError,
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
}

export interface StructuredResponse {
  parsed: unknown;
  /** Raw model text, kept so a failure downstream is still diagnosable. */
  raw: string | null;
}

export async function generateStructured(req: StructuredRequest): Promise<StructuredResponse> {
  // Pace under the provider's per-minute token budget before dispatching. Cost is
  // the prompt (~4 chars/token) plus the requested output budget, which is what
  // Groq's free tier bills against the TPM ceiling.
  const estimatedCost =
    Math.ceil((req.system.length + req.user.length) / 4) + (req.maxTokens ?? llmConfig.maxTokens);
  await llmLimiter.acquire(estimatedCost);

  switch (llmConfig.provider) {
    case 'anthropic':
      return anthropicExtract(req);
    case 'google':
      return googleExtract(req);
    case 'groq':
      return groqExtract(req);
    default:
      throw new Error(`unknown LLM_PROVIDER: ${llmConfig.provider}`);
  }
}

/** Providers signal an over-budget response with these; every one means the JSON
 *  is cut off mid-structure, not that the model chose to stop. */
const TRUNCATION_REASONS = new Set(['max_tokens', 'MAX_TOKENS', 'length', 'model_length']);

function isRateLimit(err: unknown): boolean {
  const status = (err as { status?: number })?.status;
  return status === 429 || status === 529;
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
    if (isRateLimit(err)) {
      throw new RateLimitError({ provider: 'anthropic', retryAfterMs: retryAfterMs(err), cause: err });
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
      },
    });
  } catch (err) {
    if (isTooLarge(err)) throw new RequestTooLargeError({ provider: 'google', cause: err });
    if (isRateLimit(err)) {
      throw new RateLimitError({ provider: 'google', retryAfterMs: retryAfterMs(err), cause: err });
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
    if (isRateLimit(err)) {
      throw new RateLimitError({ provider: 'groq', retryAfterMs: retryAfterMs(err), cause: err });
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
