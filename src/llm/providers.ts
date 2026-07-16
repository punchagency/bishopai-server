import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { GoogleGenAI } from '@google/genai';
import Groq from 'groq-sdk';
import type { z } from 'zod';
import { llmConfig } from './config';

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
}

export function generateStructured(req: StructuredRequest): Promise<unknown> {
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

// --- Anthropic (zod structured outputs) --------------------------------------
let anthropic: Anthropic | null = null;
function getAnthropic(): Anthropic {
  anthropic ??= new Anthropic({ apiKey: llmConfig.anthropic.apiKey || undefined });
  return anthropic;
}

async function anthropicExtract(req: StructuredRequest): Promise<unknown> {
  const res = await getAnthropic().messages.parse({
    model: llmConfig.anthropic.model,
    max_tokens: llmConfig.maxTokens,
    output_config: { effort: llmConfig.anthropic.effort, format: zodOutputFormat(req.zodSchema) },
    system: req.system,
    messages: [{ role: 'user', content: req.user }],
  });
  if (!res.parsed_output) {
    throw new Error(`Anthropic returned no structured output (stop_reason=${res.stop_reason})`);
  }
  return res.parsed_output;
}

// --- Google Gemini (JSON-schema structured output) ---------------------------
let google: GoogleGenAI | null = null;
function getGoogle(): GoogleGenAI {
  google ??= new GoogleGenAI({ apiKey: llmConfig.google.apiKey });
  return google;
}

async function googleExtract(req: StructuredRequest): Promise<unknown> {
  const res = await getGoogle().models.generateContent({
    model: llmConfig.google.model,
    contents: req.user,
    config: {
      systemInstruction: req.system,
      responseMimeType: 'application/json',
      responseJsonSchema: req.jsonSchema,
      temperature: 0,
      maxOutputTokens: llmConfig.maxTokens,
    },
  });
  const text = res.text;
  if (!text) throw new Error('Gemini returned no text output');
  return JSON.parse(text);
}

// --- Groq (OpenAI-compatible, JSON mode) -------------------------------------
let groq: Groq | null = null;
function getGroq(): Groq {
  groq ??= new Groq({ apiKey: llmConfig.groq.apiKey });
  return groq;
}

async function groqExtract(req: StructuredRequest): Promise<unknown> {
  const schemaStr = req.jsonSchema ? JSON.stringify(req.jsonSchema, null, 2) : '';
  const completion = await getGroq().chat.completions.create({
    model: llmConfig.groq.model,
    temperature: 0,
    max_completion_tokens: llmConfig.maxTokens,
    response_format: { type: 'json_object' },
    messages: [
      {
        role: 'system',
        content: req.system +
          '\n\nYou must return a JSON object matching this schema:\n' +
          schemaStr +
          '\n\nRespond with valid JSON only.'
      },
      { role: 'user',   content: req.user },
    ],
  });
  const text = completion.choices[0]?.message?.content;
  if (!text) throw new Error('Groq returned no content');
  return JSON.parse(text);
}
