import { generateStructured } from '../llm/providers';
import { llmConfig } from '../llm/config';
import { RateLimitError, RequestTooLargeError, TruncatedOutputError, isRetryable } from '../llm/errors';
import { logEvent } from '../observability/logger';
import { mockExtractSessionNote } from './mockExtract';
import {
  NARRATIVE_JSON_SCHEMA,
  NRT_JSON_SCHEMA,
  NarrativeStageSchema,
  NrtStageSchema,
  PROTOCOL_JSON_SCHEMA,
  ProtocolStageSchema,
  STAGE_WIRE,
  SessionNoteSchema,
  type Evidence,
  type SessionNote,
} from './schema';
import { mergeChunkNotes, mergeStages, type ChunkResult } from './mergeNotes';
import { narrativePrompt } from './prompts/narrative';
import { protocolPrompt } from './prompts/protocol';
import { nrtPrompt } from './prompts/nrt';
import { PROMPT_VERSION, type PromptContext } from './prompts/shared';
import { matchCatalog } from './supplementName';
import { chunkTurns, formatStamp, prepareTranscript, renderTurns, type Chunk } from './transcript';
import { summarize, verifyEvidence } from './verifyEvidence';

// Re-exported so the many existing importers of `./extract` keep working; the
// schemas themselves now live in ./schema.
export * from './schema';

/**
 * Everything the extractor knows about the session beyond the words themselves.
 * The client name in particular is nearly free accuracy: without it the model
 * has to infer which participant is which on the very distinction that decides
 * whether a sentence lands on the internal sheet or the client's Report of
 * Findings.
 */
export interface ExtractContext {
  clientName?: string | null;
  practitionerName?: string | null;
  appointmentDate?: string | null;
  /** Known product names to match garbled supplement names against. */
  catalog?: readonly string[];
}

interface Stage {
  name: 'narrative' | 'protocol' | 'nrt';
  prompt: (ctx: PromptContext) => string;
  zodSchema: typeof STAGE_WIRE[keyof typeof STAGE_WIRE];
  jsonSchema: unknown;
  parse: (raw: unknown) => Partial<SessionNote>;
  /** Whether this stage is run per-chunk on a long transcript. The narrative
   *  stage never is: concerns and goals are stated once, often in passing, and a
   *  chunk that doesn't contain them cannot know they exist. */
  chunked: boolean;
  /**
   * Output budget for THIS stage, sized to what its schema can actually emit.
   *
   * A blanket budget is not free: providers bill requested completion tokens
   * against rate limits, so asking for 4096 on a stage whose entire output is
   * ~26 nullable slots wastes most of a small per-minute allowance on tokens
   * that were never going to be generated. Undersizing is safe here because
   * truncation is a typed error that retries at double — the cost of guessing
   * low is one extra call, the cost of guessing high is every call.
   */
  maxTokens: number;
}

const STAGES: Stage[] = [
  {
    name: 'narrative',
    prompt: narrativePrompt,
    zodSchema: STAGE_WIRE.narrative,
    jsonSchema: NARRATIVE_JSON_SCHEMA,
    parse: (raw) => NarrativeStageSchema.parse(raw),
    chunked: false,
    // The largest output: verbatim assessments and concerns, each with a quote.
    maxTokens: Number(process.env.LLM_MAX_TOKENS_NARRATIVE ?? 3000),
  },
  {
    name: 'protocol',
    prompt: protocolPrompt,
    zodSchema: STAGE_WIRE.protocol,
    jsonSchema: PROTOCOL_JSON_SCHEMA,
    parse: (raw) => ProtocolStageSchema.parse(raw),
    chunked: true,
    // Supplements are verbose (7 schedule slots + structured dose each).
    maxTokens: Number(process.env.LLM_MAX_TOKENS_PROTOCOL ?? 2500),
  },
  {
    name: 'nrt',
    prompt: nrtPrompt,
    zodSchema: STAGE_WIRE.nrt,
    jsonSchema: NRT_JSON_SCHEMA,
    parse: (raw) => NrtStageSchema.parse(raw),
    chunked: true,
    // A fixed 26-slot grid, mostly nulls. Bounded and small.
    maxTokens: Number(process.env.LLM_MAX_TOKENS_NRT ?? 1500),
  },
];

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * One provider call, with the two retries that are actually worth making.
 *
 * Truncation → retry BIGGER: the model had the answer and ran out of room, so
 * an identical retry burns the same tokens to fail the same way.
 * Rate limited → retry LATER: on a small per-minute budget a long transcript's
 * chunks queue behind each other, and giving up on the first 429 throws away a
 * chunk of the session over a delay we could simply have waited out.
 * Too large → do not retry at all; only sending less can help, which is the
 * caller's decision, not this function's.
 */
async function callStage(
  stage: Stage,
  system: string,
  user: string,
): Promise<Partial<SessionNote>> {
  // Per-stage budget, capped by the global setting so LLM_MAX_TOKENS still works
  // as an override for a provider that needs more.
  let maxTokens = Math.min(stage.maxTokens, llmConfig.maxTokens);
  let rateLimitRetries = 0;
  for (let attempt = 0; ; attempt++) {
    try {
      const { parsed } = await generateStructured({
        system,
        user,
        zodSchema: stage.zodSchema,
        jsonSchema: stage.jsonSchema,
        maxTokens,
      });
      return stage.parse(parsed);
    } catch (err) {
      if (err instanceof RateLimitError && rateLimitRetries < llmConfig.rateLimitRetries) {
        rateLimitRetries++;
        const waitMs = err.retryAfterMs ?? 1000 * 2 ** rateLimitRetries;
        logEvent('info', 'session.extract', 'rate limited — waiting before retry', {
          stage: stage.name,
          attempt: rateLimitRetries,
          wait_ms: waitMs,
        });
        await sleep(Math.min(waitMs, 60_000));
        continue;
      }
      const canGrow = err instanceof TruncatedOutputError && maxTokens < llmConfig.maxTokensCeiling;
      if (!canGrow || attempt >= 1) throw err;
      maxTokens = Math.min(maxTokens * 2, llmConfig.maxTokensCeiling);
      logEvent('warn', 'session.extract', 'output truncated — retrying with a larger budget', {
        stage: stage.name,
        max_tokens: maxTokens,
      });
    }
  }
}

/** Run tasks with bounded concurrency so a long session stays inside provider
 *  rate limits instead of bursting every chunk at once. */
async function pooled<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<PromiseSettledResult<R>[]> {
  const results: PromiseSettledResult<R>[] = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    for (;;) {
      const i = cursor++;
      if (i >= items.length) return;
      try {
        results[i] = { status: 'fulfilled', value: await fn(items[i]) };
      } catch (reason) {
        results[i] = { status: 'rejected', reason };
      }
    }
  });
  await Promise.all(workers);
  return results;
}

function chunkLabel(chunk: Chunk): PromptContext['chunk'] {
  return {
    index: chunk.index,
    total: chunk.total,
    startLabel: chunk.startSeconds != null ? formatStamp(chunk.startSeconds) : null,
    endLabel: chunk.endSeconds != null ? formatStamp(chunk.endSeconds) : null,
  };
}

/**
 * Parse a session transcript into a structured session note.
 *
 * Three focused stages rather than one call doing everything: narrative
 * summarisation and dictated-checklist transcription are different tasks with
 * different failure modes, and under one prompt a single bad field discarded the
 * entire session. Now a stage that fails leaves the other two intact and the note
 * is marked partial — Nicole sees the session minus its NRT grid, which is worth
 * far more than nothing.
 *
 * Long transcripts additionally chunk the protocol and NRT stages. Below
 * `chunkThresholdTokens` a single call sees the whole session and reads better;
 * above it, long-context recall on "find every scattered callout" decays
 * silently, which is the worse failure.
 */
export async function extractSessionNote(
  transcript: string,
  ctx: ExtractContext = {},
): Promise<SessionNote> {
  // Offline path: deterministic heuristic extractor, no API key (demos/seed).
  if (llmConfig.provider === 'mock') {
    return SessionNoteSchema.parse(mockExtractSessionNote(transcript));
  }

  const prepared = prepareTranscript(transcript);
  const promptCtx: PromptContext = {
    clientName: ctx.clientName,
    practitionerName: ctx.practitionerName,
    appointmentDate: ctx.appointmentDate,
    catalog: ctx.catalog,
  };

  const shouldChunk = prepared.tokens > llmConfig.chunkThresholdTokens;
  // Always compute the plan, even below the threshold: it is also the fallback
  // for a whole-transcript call the provider refuses as too large.
  const chunkPlan = chunkTurns(prepared.turns, {
    targetTokens: llmConfig.chunkTargetTokens,
    overlapTurns: llmConfig.chunkOverlapTurns,
  });
  const chunks = shouldChunk ? chunkPlan : [];

  const partial: string[] = [];
  const conflicts: { path: string; chosen: string | null; candidates: string[] }[] = [];
  const gaps: { from: number | null; to: number | null }[] = [];

  const stageResults = await Promise.all(
    STAGES.map(async (stage): Promise<Partial<SessionNote> | null> => {
      const fail = (err: unknown, note: string): null => {
        partial.push(stage.name);
        logEvent('warn', 'session.extract', note, {
          stage: stage.name,
          error: err instanceof Error ? err.message : String(err),
          retryable: isRetryable(err),
        });
        return null;
      };

      const runWhole = async (): Promise<Partial<SessionNote> | null> => {
        const body = stage.name === 'narrative' ? prepared.narrative : prepared.full;
        try {
          return await callStage(stage, stage.prompt(promptCtx), `Transcript:\n\n${body}`);
        } catch (err) {
          // A stage that never chunks can still be too big for the model or the
          // account's per-minute budget. Losing the entire narrative pass over
          // that is far worse than the accuracy cost of chunking it, so degrade
          // rather than drop — and say so, since the note is now weaker.
          if ((err instanceof RequestTooLargeError || err instanceof RateLimitError) && chunkPlan.length) {
            logEvent('warn', 'session.extract', 'whole-transcript call too large — falling back to chunks', {
              stage: stage.name,
              chunks: chunkPlan.length,
            });
            partial.push(`${stage.name}:chunked-fallback`);
            return runChunked();
          }
          return fail(err, 'stage failed — note will be partial');
        }
      };

      const runChunked = async (): Promise<Partial<SessionNote> | null> => {
      const settled = await pooled(chunkPlan, llmConfig.chunkConcurrency, (chunk) =>
        callStage(
          stage,
          stage.prompt({ ...promptCtx, chunk: chunkLabel(chunk) }),
          `Transcript:\n\n${renderTurns(chunk.turns)}`,
        ),
      );

      const ok: ChunkResult[] = [];
      settled.forEach((r, i) => {
        if (r.status === 'fulfilled') ok.push({ index: chunkPlan[i].index, note: r.value });
        else gaps.push({ from: chunkPlan[i].startSeconds, to: chunkPlan[i].endSeconds });
      });

      // A minority of failed chunks still yields a usable note covering the rest
      // of the session — labelled, so Nicole knows which minutes are missing. A
      // majority failing means we learned nothing, and pretending otherwise
      // would hide a broken extraction behind a plausible-looking draft.
      if (ok.length === 0 || ok.length * 2 < chunkPlan.length) {
        partial.push(stage.name);
        logEvent('warn', 'session.extract', 'too many chunks failed — stage dropped', {
          stage: stage.name,
          ok: ok.length,
          total: chunkPlan.length,
        });
        return null;
      }
      if (ok.length < chunkPlan.length) partial.push(`${stage.name}:partial`);

      const merged = mergeChunkNotes(ok);
      conflicts.push(...merged.conflicts);
      return merged.note;
      };

      // `stage.chunked` says a stage PREFERS the whole session; it cannot
      // conjure budget that isn't there. The narrative pass wants every scattered
      // concern in one view, so it never opts into chunking — and on a tier
      // whose ceiling is below the transcript it would send a doomed call every
      // time, spend most of the window on the 413, and only then chunk with what
      // little was left. That is how the stage ended up `partial` while the two
      // stages that chunked up front came back whole.
      //
      // The fallback below still exists for the cases only the API can reveal.
      // This is for the case we can compute in advance: if it cannot fit, chunk
      // now and spend the budget on work instead of on being told no.
      const fitsWhole = prepared.tokens <= llmConfig.chunkThresholdTokens;
      const mustChunk = !fitsWhole && chunkPlan.length > 0;
      if (mustChunk && !stage.chunked) {
        logEvent('info', 'session.extract', 'transcript exceeds a single call — chunking up front', {
          stage: stage.name,
          tokens: prepared.tokens,
          threshold: llmConfig.chunkThresholdTokens,
          chunks: chunkPlan.length,
        });
        partial.push(`${stage.name}:chunked`);
      }
      return (shouldChunk && stage.chunked) || mustChunk ? runChunked() : runWhole();
    }),
  );

  const note = mergeStages(stageResults.filter((s): s is Partial<SessionNote> => s !== null));

  // Provenance is only worth anything if it's checked: a quote that isn't in the
  // transcript is a fabricated finding, and that is mechanically detectable
  // without a human. Flag, never drop — a real finding with a paraphrased quote
  // must not vanish.
  // Pass the SAME turns the prompt rendered. The model cited "#47" against that
  // numbering; re-deriving it here from scratch would work only by coincidence.
  const evidence = verifyEvidence(note.evidence ?? [], transcript, prepared.turns);
  const stats = summarize(evidence);
  const unverified = stats.unverified;

  const parsed = SessionNoteSchema.parse({
    ...note,
    evidence,
    extraction: {
      prompt_version: PROMPT_VERSION,
      provider: llmConfig.provider,
      model: modelName(),
      partial: partial.length ? partial : undefined,
      conflicts: conflicts.length ? conflicts : undefined,
      gaps: gaps.length ? gaps : undefined,
      attribution_coverage: prepared.attributionCoverage,
      chunks: chunks.length || null,
    },
  });

  logEvent('info', 'session.extract', 'extraction complete', {
    tokens: prepared.tokens,
    chunks: chunks.length,
    partial,
    conflicts: conflicts.length,
    evidence: evidence.length,
    unverified,
    // Share of findings anchored to a specific turn rather than matched as
    // prose — the health signal for whether citation is actually working.
    spans: stats.spans,
    verification: stats.byStatus,
    attribution_coverage: Number(prepared.attributionCoverage.toFixed(3)),
  });

  return applyCatalog(parsed, ctx.catalog);
}

function modelName(): string {
  switch (llmConfig.provider) {
    case 'anthropic':
      return llmConfig.anthropic.model;
    case 'google':
      return llmConfig.google.model;
    case 'groq':
      return llmConfig.groq.model;
    default:
      return llmConfig.provider;
  }
}

/**
 * Suggest a catalog product for each supplement whose spoken name nearly matches
 * one. An exact normalized hit is applied (it IS the same product under
 * different punctuation); anything less is only recorded as a suggestion for
 * Nicole to confirm, because forcing a near-match would rewrite a client's plan
 * to a product nobody prescribed.
 */
function applyCatalog(note: SessionNote, catalog: readonly string[] | undefined): SessionNote {
  if (!catalog?.length || !note.supplements.length) return note;
  return {
    ...note,
    supplements: note.supplements.map((s) => {
      if (!s.name) return s;
      const hit = matchCatalog(s.name, catalog);
      if (!hit) return s;
      if (hit.score === 1) return { ...s, name: hit.name };
      return { ...s, name_matched_to: hit.name };
    }),
  };
}

export type { Evidence };
