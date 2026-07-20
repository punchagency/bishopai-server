import { describe, it, expect } from 'vitest';
import { FoundationSchema, LifestyleSchema } from './extract';

// Real values pulled off the History grid, where a model had echoed the prompt
// name back into the value: the flow sheet then reads "HTA: HTA is negative",
// and a value that is ONLY the label is indistinguishable from a real finding.
describe('label echo stripping', () => {
  it('drops a leading prompt name and its connector', () => {
    const f = FoundationSchema.parse({
      laying1: 'LAYING 1 FOUNDATIONS is holding now',
      standing: 'STANDING FOUNDATIONS is clear',
      hta: 'HTA is negative',
      hta_post_run: 'HTA post run is clear',
    });
    expect(f.laying1).toBe('holding now');
    expect(f.standing).toBe('clear');
    expect(f.hta).toBe('negative');
    expect(f.hta_post_run).toBe('clear');
  });

  it('treats a bare label as no finding at all', () => {
    const f = FoundationSchema.parse({
      laying1: 'LAYING 1 FOUNDATIONS',
      standing: 'STANDING FOUNDATIONS',
    });
    expect(f.laying1).toBeNull();
    expect(f.standing).toBeNull();
  });

  it('leaves a real finding untouched', () => {
    const f = FoundationSchema.parse({
      hta: 'positive',
      art_cns: 'switched, corrected on the second pass',
      art_dental: 'clear',
    });
    expect(f.hta).toBe('positive');
    expect(f.art_cns).toBe('switched, corrected on the second pass');
    expect(f.art_dental).toBe('clear');
  });

  it('does not eat a value that merely starts with a similar word', () => {
    // "clear" must survive even though "cell"/"cns" share a prefix letter, and a
    // finding that legitimately begins with the label word keeps its meaning.
    const f = FoundationSchema.parse({ art_open: 'open on the right side only' });
    expect(f.art_open).toBe('on the right side only');
  });

  it('strips echoes in the lifestyle log too', () => {
    const l = LifestyleSchema.parse({
      sleep: 'Sleep is 6 hours, broken',
      water: 'water: 72 ounces a day',
      diet: 'DIET',
    });
    expect(l.sleep).toBe('6 hours, broken');
    expect(l.water).toBe('72 ounces a day');
    expect(l.diet).toBeNull();
  });
});
