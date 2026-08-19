import { describe, it, expect } from 'vitest';
import { narrativePrompt } from './prompts/narrative';
import { assessmentsPrompt } from './prompts/assessments';
import { protocolPrompt } from './prompts/protocol';
import { nrtPrompt } from './prompts/nrt';

const ctx = { clientName: 'Patricia', practitionerName: 'Nicole' };

describe('stage prompts', () => {
  it('gives each field exactly one owner', () => {
    // Two stages both claiming `assessments` is the failure this guards: the
    // narrative pass would fill them, the assessments pass would fill them
    // again, and mergeStages would keep whichever finished last — silently
    // halving recall with nothing in the logs to say so.
    expect(narrativePrompt(ctx)).not.toMatch(/^- assessments:/m);
    expect(narrativePrompt(ctx)).toContain('concerns, goals, follow_ups');
    expect(assessmentsPrompt(ctx)).toContain('Extract ONE field in this pass: assessments');
  });

  it('tells every stage to ignore what another stage owns', () => {
    expect(narrativePrompt(ctx)).toMatch(/Ignore supplements/);
    expect(assessmentsPrompt(ctx)).toMatch(/Ignore everything else in the session/);
    expect(protocolPrompt(ctx)).toMatch(/Ignore client symptoms/);
    expect(nrtPrompt(ctx)).toMatch(/Ignore/);
  });

  it('names no clinical finding or product a session might not contain', () => {
    // A prompt that exemplifies its CONTENT gets that content copied into the
    // output: a session with none of those problems came back asserting them.
    // Illustrating the SHAPE of an answer is safe; naming a real finding or a
    // real product is not.
    const all = [narrativePrompt(ctx), assessmentsPrompt(ctx), protocolPrompt(ctx)].join('\n');
    for (const banned of ['Beta Plus', 'Livatrit', 'Equifem', 'neck pain', 'Lyme', 'HPA axis']) {
      expect(all, banned).not.toContain(banned);
    }
  });

  it('tells a windowed pass it is reading one part of a session', () => {
    const windowed = assessmentsPrompt({
      ...ctx,
      chunk: { index: 1, total: 4, startLabel: '8:00', endLabel: '16:00' },
    });
    expect(windowed).toContain('part 2 of 4');
    expect(windowed).toContain('Extract ONLY what this part states');
  });
});
