import { describe, it, expect } from 'vitest';
import { BodyScanSchema, FoundationSchema, LifestyleSchema } from './extract';

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
    // Half the prompt names are ordinary English words, and for the ART tests the
    // label word is also a legitimate RESULT — "open" is what OPEN tests for.
    // Stripping it turned "open on the right side only" into "on the right side
    // only", which reads as a location with no finding attached, and turned
    // "Cell membranes weak" into "membranes weak". A redundant-looking
    // "OPEN: open on the right side only" on the flow sheet is cosmetic; losing
    // the result is not, so an ambiguous label survives without a delimiter.
    const f = FoundationSchema.parse({ art_open: 'open on the right side only' });
    expect(f.art_open).toBe('open on the right side only');
    const b = BodyScanSchema.parse({ art_cell: 'cell membranes weak' });
    expect(b.art_cell).toBe('cell membranes weak');
  });

  it('still strips an ambiguous label when punctuation or a verb marks it', () => {
    // The echo is unmistakable here, so it goes — this is the case the stripper
    // exists for, and it survives the fix above.
    const f = FoundationSchema.parse({
      art_open: 'OPEN: clear',
      art_switch: 'switch is stuck',
      art_dental: 'DENTAL - amalgam on the lower left',
    });
    expect(f.art_open).toBe('clear');
    expect(f.art_switch).toBe('stuck');
    expect(f.art_dental).toBe('amalgam on the lower left');
  });

  it('strips only the first matching alias, never twice', () => {
    // 'hta post run' and 'post run' both match; applying both would leave "62"
    // stripped of the reading it belongs to.
    const f = FoundationSchema.parse({ hta_post_run: 'HTA POST RUN: post run 62' });
    expect(f.hta_post_run).toBe('post run 62');
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
