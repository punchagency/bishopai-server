import { describe, it, expect, vi, beforeEach } from 'vitest';
import { RateLimitError, TruncatedOutputError } from '../llm/errors';
import { extractSessionNote } from './extract';

// The first tests in this file that drive a stage through the PROVIDER rather
// than through a pure function. They exist because the two bugs they cover were
// both invisible to every other kind of test: the note came back well-formed and
// merely thinner than the session, and the only signal was a `partial` marker
// nobody was asserting on.

const generateStructured = vi.fn();

vi.mock('../llm/providers', () => ({
  generateStructured: (...args: unknown[]) => generateStructured(...args),
  modelName: () => 'test-model',
}));

vi.mock('../llm/config', async () => {
  const actual = await vi.importActual<typeof import('../llm/config')>('../llm/config');
  return {
    ...actual,
    llmConfig: {
      ...actual.llmConfig,
      provider: 'openrouter',
      maxTokens: 4096,
      maxTokensExplicit: false,
      reasoningHeadroomTokens: 0,
      maxTokensCeiling: 64_000,
      truncationRetries: 3,
      tokensPerMinute: 1_000_000,
      chunkThresholdTokens: 200_000,
      chunkTargetTokens: 140_000,
      chunkOverlapTurns: 2,
      windowTokens: 300,
      chunkConcurrency: 3,
      rateLimitRetries: 3,
    },
  };
});

// Long enough to need several 300-token windows, and with a distinct concern in
// the LAST turn — the one a single whole-session call is most likely to skim.
function longTranscript(): string {
  const filler = Array.from(
    { length: 60 },
    (_, i) =>
      `Nicole: Tell me more about how week ${i} went for you overall.\n` +
      `Client: It was alright, the tiredness in the afternoons is still there in week ${i}.`,
  ).join('\n');
  return `${filler}\nClient: The other thing is my left knee has been swelling up since March.`;
}

// NOTE: extract.ts is imported STATICALLY and the module registry is never
// reset. `vi.resetModules()` would hand extract.ts a second copy of
// ../llm/errors, and the retry ladder dispatches on `instanceof
// TruncatedOutputError` — against a different class object every check fails,
// so a truncation would look like an ordinary failure and the stage would drop
// instead of retrying. The bug under test would then hide behind the harness.
beforeEach(() => {
  generateStructured.mockReset();
});

describe('narrative stage windowing', () => {
  it('reads a long session in windows instead of one unbounded call', async () => {
    const calls: { stage: string; part: string | null }[] = [];
    generateStructured.mockImplementation(async ({ system }: { system: string }) => {
      const part = system.match(/This is part (\d+ of \d+)/)?.[1] ?? null;
      const stage = /concerns, goals, follow_ups/.test(system)
        ? 'narrative'
        : /assessments/i.test(system)
          ? 'assessments'
          : 'other';
      calls.push({ stage, part });
      return { parsed: {}, raw: '{}' };
    });

    await extractSessionNote(longTranscript(), { clientName: 'Jodi' });

    const narrative = calls.filter((c) => c.stage === 'narrative');
    // The point of the change: more than one call, each told which part it is.
    expect(narrative.length).toBeGreaterThan(1);
    expect(narrative.every((c) => c.part !== null)).toBe(true);
  });

  it('unions findings across windows so a late concern survives the merge', async () => {
    let narrativeCall = 0;
    generateStructured.mockImplementation(async ({ system }: { system: string }) => {
      if (!/concerns, goals, follow_ups/.test(system)) return { parsed: {}, raw: '{}' };
      narrativeCall++;
      // Only the last window states the knee — exactly the finding that goes
      // missing when one call has to hold the whole session.
      return {
        parsed: {
          concerns:
            narrativeCall === 1
              ? ['afternoon tiredness']
              : ['left knee swelling since March'],
          goals: [],
          follow_ups: [],
        },
        raw: '{}',
      };
    });

    const note = await extractSessionNote(longTranscript(), { clientName: 'Jodi' });

    expect(note.concerns).toContain('afternoon tiredness');
    expect(note.concerns).toContain('left knee swelling since March');
    // Windows are this stage's reading, not a degradation, so the note is not
    // labelled partial for using them.
    expect(note.extraction?.partial ?? []).not.toContain('narrative');
  });

  it('still reads a short session in one call', async () => {
    const parts: (string | null)[] = [];
    generateStructured.mockImplementation(async ({ system }: { system: string }) => {
      if (/concerns, goals, follow_ups/.test(system)) {
        parts.push(system.match(/This is part (\d+ of \d+)/)?.[1] ?? null);
      }
      return { parsed: {}, raw: '{}' };
    });

    await extractSessionNote('Nicole: How are you?\nClient: Tired.', {});

    expect(parts).toEqual([null]);
  });
});

describe('truncation retry ladder', () => {
  it('climbs to the ceiling rather than giving up after one doubling', async () => {
    const budgets: number[] = [];
    generateStructured.mockImplementation(async (args: { system: string; maxTokens: number }) => {
      if (!/concerns, goals, follow_ups/.test(args.system)) return { parsed: {}, raw: '{}' };
      budgets.push(args.maxTokens);
      // Truncate the first three attempts; succeed on the fourth.
      if (budgets.length <= 3) {
        throw new TruncatedOutputError({ provider: 'openrouter', finishReason: 'length' });
      }
      return { parsed: { concerns: ['made it'], goals: [], follow_ups: [] }, raw: '{}' };
    });

    const note = await extractSessionNote('Nicole: How are you?\nClient: Tired.', {});

    // Four calls: the original plus three doublings. The old code stopped at two.
    expect(budgets).toEqual([8000, 16000, 32000, 64000]);
    expect(note.concerns).toEqual(['made it']);
    expect(note.extraction?.partial ?? []).not.toContain('narrative');
  });

  it('does not let a rate-limit wait spend the truncation budget', async () => {
    const budgets: number[] = [];
    let sawRateLimit = false;
    generateStructured.mockImplementation(async (args: { system: string; maxTokens: number }) => {
      if (!/concerns, goals, follow_ups/.test(args.system)) return { parsed: {}, raw: '{}' };
      // One 429 FIRST, then a truncation. Under the old shared counter the 429
      // consumed the single growth attempt and the truncation threw immediately.
      if (!sawRateLimit) {
        sawRateLimit = true;
        throw new RateLimitError({ provider: 'openrouter', retryAfterMs: 1 });
      }
      budgets.push(args.maxTokens);
      if (budgets.length === 1) {
        throw new TruncatedOutputError({ provider: 'openrouter', finishReason: 'length' });
      }
      return { parsed: { concerns: ['survived'], goals: [], follow_ups: [] }, raw: '{}' };
    });

    const note = await extractSessionNote('Nicole: How are you?\nClient: Tired.', {});

    expect(budgets).toEqual([8000, 16000]);
    expect(note.concerns).toEqual(['survived']);
  });
});

// Steve Broderick's session, 2026-08-24: all six stages dropped, evidence 0,
// every field blank — and `extraction_status = 'done'`, 0 attempts, no error.
// mergeStages had merged nothing into a valid empty note, so from the caller's
// side it looked like a clean run and nothing ever retried it.
describe('total stage failure', () => {
  it('throws instead of returning a blank note when every stage fails', async () => {
    // Exhausted rather than paced, so the retry ladder does not engage — this is
    // the shape a spent Gemini free-tier quota actually arrives in.
    generateStructured.mockRejectedValue(
      new RateLimitError({ provider: 'test', exhausted: true }),
    );

    await expect(
      extractSessionNote('Nicole: How have you been?\nClient: Tired.', { clientName: 'Steve' }),
    ).rejects.toThrow(/quota exhausted/);
  });

  it('rethrows the original error so retryability survives', async () => {
    // The distinction that matters downstream: a spent daily allowance must not
    // be retried the way a transient blip is. Rethrowing the original instance —
    // not a synthetic wrapper — is what keeps isRetryable() able to tell them
    // apart, and what lets rawFromError() recover the model output.
    const exhausted = new RateLimitError({ provider: 'test', exhausted: true });
    generateStructured.mockRejectedValue(exhausted);

    await expect(
      extractSessionNote('Nicole: How have you been?\nClient: Tired.', { clientName: 'Steve' }),
    ).rejects.toBe(exhausted);
  });

  it('still returns a note when only SOME stages fail', async () => {
    // The rule is "learned nothing", not "learned less". A note covering most of
    // a session with labelled gaps is worth having, and must not be thrown away.
    generateStructured.mockImplementation(async ({ system }: { system: string }) => {
      if (/concerns, goals, follow_ups/.test(system)) {
        return { parsed: { concerns: ['afternoon tiredness'], goals: [], follow_ups: [] }, raw: '{}' };
      }
      throw new TruncatedOutputError({ provider: 'test', finishReason: 'MAX_TOKENS' });
    });

    const note = await extractSessionNote(
      'Nicole: How have you been?\nClient: Tired in the afternoons.',
      { clientName: 'Steve' },
    );

    expect(note.concerns).toContain('afternoon tiredness');
    expect(note.extraction?.partial ?? []).not.toHaveLength(0);
  });
});
