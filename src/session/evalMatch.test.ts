import { describe, it, expect } from 'vitest';
import { bestMatch, matchScore, matches, nameScore, similarity } from './evalMatch';

describe('gold matching', () => {
  it('binds a product to its BEST match, not the first one over the line', () => {
    // The bug this module exists for. "Beta Plus" and "Livatrit Plus" score
    // exactly 0.5 against each other on the shared word "Plus", so a
    // first-past-the-post match handed gold Beta Plus the Livatrit row, read
    // `decrease` off it, and reported a swapped clinical action that the
    // extraction never made — then gave gold Livatrit the leftover Beta row and
    // reported the mirror image, which made it look systematic.
    const extracted = ['Livatrit Plus', 'Beta Plus'];
    expect(similarity('Beta Plus', 'Livatrit Plus')).toBe(0.5);

    const i = bestMatch(extracted, (name) => nameScore(name, ['Beta Plus']));
    expect(extracted[i]).toBe('Beta Plus');
  });

  it('still matches a garbled name against its known variants', () => {
    // Transcription mangles these; the variants are what keep a real hit a hit.
    expect(nameScore('chase tree', ['Chaste Tree', 'cheese tree'])).toBeGreaterThan(0);
    expect(nameScore('litatric', ['Livatrit Plus', 'litatric'])).toBe(1);
  });

  it('does not match two genuinely different products', () => {
    expect(nameScore('Beta Plus', ['Bio B Complex'])).toBe(0);
    expect(nameScore('MSM', ['TMG'])).toBe(0);
  });

  it('counts a more complete answer as found, not as a miss and an invention', () => {
    const got = 'the thyroid is crashing, which is why the levothyroxine dose held';
    expect(matches(got, 'the thyroid is crashing')).toBe(true);
  });

  it('counts one finding written two ways as one finding', () => {
    // Real pairs from the pocket fixture, each of which scored as a miss AND a
    // fabrication — punishing a correct extraction twice for choosing the other
    // surface form.
    expect(matches('Afternoon energy crash around 3 PM', 'three PM crash')).toBe(true);
    expect(matches('Neck and upper body inflammation and pain', 'neck pain')).toBe(true);
    expect(matches('Leg itching at night', 'itching at night, mainly the legs')).toBe(true);
    expect(matches('Weight gain since menopause', 'weight gain')).toBe(true);
  });

  it('KNOWN LIMITATION: under-credits a derivational pair like diabetic/diabetes', () => {
    // "Pre-diabetes diagnosis" against gold "pre-diabetic" is one finding, and
    // this scores it as a miss and a fabrication. Unifying them needs a
    // derivational rule (-ic → -e) in a stemmer SHARED with the provenance
    // check, where over-stemming is how a reversed finding gets waved through as
    // supported. The eval reading a point low is the cheaper error, so it stays
    // — asserted, so that a future "fix" to the stemmer has to come past this.
    expect(matches('Pre-diabetes diagnosis', 'pre-diabetic')).toBe(false);
  });

  it('does not stretch to matching MEANING', () => {
    // "soreness in joints" and "joint pain flare for the past six weeks" are the
    // same complaint to a reader and share one word. A metric that calls this a
    // hit has stopped measuring recall and started flattering it — the gap is
    // real and belongs in the missed column until the extraction closes it.
    expect(matches('Joint pain flare for the past six weeks', 'soreness in joints')).toBe(false);
    expect(matches('high cholesterol', 'history of Lyme disease')).toBe(false);
  });

  it('does not let one long summary match every gold item at once', () => {
    const summary =
      'the session covered the thyroid, the gallbladder, the adrenals, sleep, ' +
      'the protein intake, the supplement changes and the follow-up plan in full';
    expect(matches(summary, 'the thyroid is crashing')).toBe(false);
  });

  it('scores nothing as a match when nothing matches', () => {
    expect(matchScore('neck pain', 'high cholesterol')).toBe(0);
    expect(bestMatch(['neck pain'], (g) => matchScore(g, 'high cholesterol'))).toBe(-1);
  });
});
