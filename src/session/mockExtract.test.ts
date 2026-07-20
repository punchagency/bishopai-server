import { describe, it, expect } from 'vitest';
import { mockExtractSessionNote } from './mockExtract';

// The offline extractor feeds every demo and the seeded cockpit, so its NRT /
// lifestyle capture is what Nicole actually sees in her documents. Two things must
// hold: values are captured verbatim (casing intact — they land in a clinical doc),
// and anything the session didn't state stays null rather than being guessed.

const FULL =
  "Maya's been having trouble sleeping and low energy for weeks. " +
  'She wants to get through the afternoon without crashing. ' +
  'Pulse 0 is 78, thready. K-27 was switched, corrected on the rub. ' +
  'Priority #1 is an immune stressor in the upper GI. Stressors are immune challenge and food, mainly dairy. ' +
  'Foundation testing shows HTA positive with the CNS switched; dental is clear. ' +
  'Body scan shows matrix at the liver and cell at the adrenal. ' +
  'Her BM is every other day and sluggish, sleep is 5 to 6 hours waking around 3am, water is about 40oz a day, ' +
  'cycle is regular at 28 days, exercise is walking twice a week, and her diet is high sugar. ' +
  "Let's start magnesium glycinate at night. Recheck in 4 weeks.";

const PARTIAL =
  "Lena's main concern is anxiety. Sleep is disrupted, about 4 hours a night. " +
  'Pulse 0 is 84 and jumpy. Stressors are chemical, likely her cleaning products. ' +
  'Foundation shows the CNS switched. We ran short on time so no body scan today. ' +
  'Water is barely 30oz a day and her diet is skipping meals under stress. ' +
  "Let's begin ashwagandha twice daily.";

describe('mockExtractSessionNote — NRT findings', () => {
  it('captures each finding verbatim, preserving clinical casing', () => {
    const { nrt } = mockExtractSessionNote(FULL);
    expect(nrt?.pulse0).toBe('78, thready');
    expect(nrt?.priority1).toBe('an immune stressor in the upper GI'); // "GI" not "gi"
    expect(nrt?.k27).toBe('switched, corrected on the rub');
    expect(nrt?.stressors).toBe('immune challenge and food, mainly dairy');
  });

  it('routes a named prompt to its own slot', () => {
    const { nrt } = mockExtractSessionNote(FULL);
    expect(nrt?.foundation?.art_dental).toBe('clear'); // "dental is clear"
  });

  it('never files an ART reading under the NRT pass', () => {
    // Both passes state a PRIORITY / MATRIX / CELL. Matching a bare "matrix"
    // would take the ART value and attribute it to a test that never ran.
    const { nrt } = mockExtractSessionNote(
      'ART matrix is gallbladder. ART cell is spleen. ART priority is liver.',
    );
    expect(nrt?.body_scan?.art_matrix).toBe('gallbladder');
    expect(nrt?.body_scan?.scan_matrix).toBeNull();
    expect(nrt?.body_scan?.scan_cell).toBeNull();
    expect(nrt?.body_scan?.scan_priority).toBeNull();
  });

  it('parks conversational findings in ADDITIONAL rather than guessing a prompt', () => {
    // "Foundation testing shows HTA positive with the CNS switched" names no single
    // prompt, so it must not be split across hta/art_cns on a guess.
    const { nrt } = mockExtractSessionNote(FULL);
    expect(nrt?.foundation?.additional).toBe('HTA positive with the CNS switched');
    expect(nrt?.foundation?.hta).toBeNull();
    expect(nrt?.body_scan?.additional_nrt).toBe('matrix at the liver and cell at the adrenal');
    expect(nrt?.body_scan?.scan_matrix).toBeNull();
  });

  it('leaves unstated findings null instead of inventing them', () => {
    const { nrt } = mockExtractSessionNote(PARTIAL);
    expect(nrt?.pulse0).toBe('84 and jumpy');
    expect(nrt?.foundation?.additional).toBe('the CNS switched');
    // Never discussed in this session — these must not be filled in.
    expect(nrt?.priority1).toBeNull();
    expect(nrt?.k27).toBeNull();
    // "no body scan today" — the whole pass is null, not an object of blanks.
    expect(nrt?.body_scan).toBeNull();
  });
});

describe('mockExtractSessionNote — lifestyle log', () => {
  it('splits a run-on lifestyle sentence into the right fields', () => {
    const { lifestyle } = mockExtractSessionNote(FULL);
    expect(lifestyle).toEqual({
      bm: 'every other day and sluggish',
      sleep: '5 to 6 hours waking around 3am',
      water: 'about 40oz a day',
      cycle: 'regular at 28 days',
      exercise: 'walking twice a week',
      diet: 'high sugar',
    });
  });

  it('does not mistake narrative mentions for a reported value', () => {
    // "trouble sleeping and low energy" is a symptom, not a sleep log entry — the
    // connector ("sleep IS …") is what makes it a value.
    const { lifestyle } = mockExtractSessionNote('She has trouble sleeping and low energy.');
    expect(lifestyle?.sleep).toBeNull();
  });

  it('nulls the fields a short session never covered', () => {
    const { lifestyle } = mockExtractSessionNote(PARTIAL);
    expect(lifestyle?.sleep).toBe('disrupted, about 4 hours a night');
    expect(lifestyle?.water).toBe('barely 30oz a day');
    expect(lifestyle?.diet).toBe('skipping meals under stress');
    expect(lifestyle?.bm).toBeNull();
    expect(lifestyle?.cycle).toBeNull();
    expect(lifestyle?.exercise).toBeNull();
  });
});

describe('mockExtractSessionNote — goals', () => {
  it('captures what the client said they want', () => {
    expect(mockExtractSessionNote(FULL).goals).toEqual(['get through the afternoon without crashing']);
    expect(mockExtractSessionNote(PARTIAL).goals).toEqual([]);
  });
});
