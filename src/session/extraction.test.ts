import { describe, it, expect } from 'vitest';
import {
  ASSESSMENTS_JSON_SCHEMA,
  AssessmentsStageSchema,
  NARRATIVE_JSON_SCHEMA,
  NRT_JSON_SCHEMA,
  NarrativeStageSchema,
  NrtStageSchema,
  PROTOCOL_JSON_SCHEMA,
  ProtocolStageSchema,
  SessionNoteSchema,
  mapChange,
  mapProtocolType,
} from './schema';
import { matchCatalog, nameSimilarity, normalizeSupplementName } from './supplementName';
import { STAGE_FIELDS } from './extract';
import { summarize, verifyEvidence, wordingFidelity } from './verifyEvidence';

describe('supplement action mapping', () => {
  it('maps the words the practitioner actually uses', () => {
    for (const [said, want] of [
      ['add', 'start'], ['adding', 'start'], ['introduce', 'start'],
      ['take out', 'stop'], ['hold', 'stop'], ['discontinue', 'stop'],
      ['upping', 'increase'], ['double', 'increase'],
      ['lower', 'decrease'], ['reduce', 'decrease'],
      ['keep', 'continue'], ['refill', 'continue'],
    ] as const) {
      expect(mapChange(said).value, said).toBe(want);
    }
  });

  it('maps the spoken phrasings, not just the written ones', () => {
    // Every phrase here was said in a real session and used to fall through to
    // the `continue` placeholder — which reads as "already on it" for a start
    // and keeps the old dose for a decrease.
    for (const [said, want] of [
      ['putting in', 'start'], ['put in', 'start'], ['swapping to a different B vitamin', 'start'],
      ['taking out', 'stop'], ['cut out', 'stop'], ['leave out', 'stop'],
      ['came down', 'decrease'], ['cut back', 'decrease'], ['went down', 'decrease'],
      ['back down to one', 'decrease'], ['taper', 'decrease'],
      ['went up', 'increase'], ['bumping', 'increase'],
      ['stay on', 'continue'],
    ] as const) {
      const m = mapChange(said);
      expect(m.value, said).toBe(want);
      expect(m.unresolved, said).toBe(false);
    }
  });

  it('refuses a NEGATED verb instead of inverting the clinical action', () => {
    // The old substring match read "don't increase yet" as `increase` and
    // "we're not going to add that" as `start` — the exact opposite of what was
    // said, applied to a client's plan.
    for (const said of [
      "don't increase yet",
      'we are not going to add that',
      'no longer taking it',
      'hold off on the increase',
      'rather than stop, we watch it',
    ]) {
      const m = mapChange(said);
      expect(m.unresolved, said).toBe(true);
      expect(m.raw, said).toBe(said);
    }
  });

  it('does not fire on a verb embedded in another word', () => {
    // Word boundaries: "readdress" must not read as "add".
    expect(mapChange('readdress at the next visit').unresolved).toBe(true);
  });

  it('marks an unrecognised value as unresolved rather than a silent continue', () => {
    // `continue` is the most COMMON legitimate value, so an unknown value
    // defaulting to it was invisible — a mangled "stop" left a discontinued
    // supplement on the plan and WF4 kept projecting refills for it.
    const m = mapChange('PRN');
    expect(m.value).toBe('continue'); // safe placeholder: changes nothing
    expect(m.unresolved).toBe(true); // ...but never passes as a real reading
    expect(m.raw).toBe('PRN');
  });

  it('records the raw string on the parsed supplement', () => {
    const note = SessionNoteSchema.parse({ supplements: [{ name: 'Beta Plus', change: 'hold' }] });
    expect(note.supplements[0]).toMatchObject({
      change: 'stop',
      change_raw: 'hold',
      change_unresolved: false,
    });
  });

  it('does not clear an existing flag when a stored note is re-parsed', () => {
    // The review UI PATCHes partial notes constantly; a round-trip must not
    // quietly erase the "this was guessed" marker.
    const stored = { supplements: [{ name: 'X', change: 'stop', change_raw: 'hold' }] };
    expect(SessionNoteSchema.parse(stored).supplements[0].change_raw).toBe('hold');
  });

  it('maps protocol-change types on the same rules', () => {
    expect(mapProtocolType('take out').value).toBe('remove');
    expect(mapProtocolType('dose change').value).toBe('adjust');
    expect(mapProtocolType("we're not going to add it").unresolved).toBe(true);
  });
});

describe('supplement name identity', () => {
  it('collapses punctuation and pack size, never two different products', () => {
    expect(normalizeSupplementName('Bio-C Plus')).toBe('bio c plus');
    expect(normalizeSupplementName('Bio C Plus 60ct')).toBe('bio c plus');
    expect(normalizeSupplementName('BioC plus.')).toBe('bioc plus');
    expect(normalizeSupplementName('Beta Plus')).not.toBe(normalizeSupplementName('Beta TCP'));
  });

  it('drops the bottle count but never the dosage strength', () => {
    // "Vitamin D 5000iu" and "Vitamin D 1000iu" are different prescriptions;
    // collapsing them would merge two products into one row on the plan.
    expect(normalizeSupplementName('Vitamin D 5000iu 120 caps')).toBe('vitamin d 5000iu');
    expect(normalizeSupplementName('Vitamin D 5000iu')).not.toBe(
      normalizeSupplementName('Vitamin D 1000iu'),
    );
  });

  it('never returns an empty key just because every word is a noise word', () => {
    // An empty key collides every such product into one identity.
    expect(normalizeSupplementName('The Formula')).not.toBe('');
    expect(normalizeSupplementName('A')).toBe('a');
  });

  it('suggests a catalog match but only applies an exact one', () => {
    const catalog = ['Bio-C Plus', 'Beta Plus', 'Cyto-Zyme PT/HPT'];
    // Same product, different punctuation → an identity, safe to apply.
    expect(matchCatalog('bio c plus', catalog)).toEqual({ name: 'Bio-C Plus', score: 1 });
    expect(matchCatalog('Cyto Zyme PT HPT', catalog)).toEqual({ name: 'Cyto-Zyme PT/HPT', score: 1 });
    // Partial overlap → a suggestion for Nicole to confirm, not an identity.
    const partial = matchCatalog('Bio C Plus Complex', catalog);
    expect(partial?.name).toBe('Bio-C Plus');
    expect(partial?.score).toBeLessThan(1);
    // Nothing close enough is left alone rather than forced to the nearest entry.
    expect(matchCatalog('Magnesium Glycinate', catalog)).toBeNull();
    // A corrupted word is NOT silently matched — a wrong product Nicole clicks
    // through is worse than an unrecognised one she has to name herself.
    expect(matchCatalog('Beta Pluss', catalog)).toBeNull();
  });

  it('scores similarity symmetrically', () => {
    expect(nameSimilarity('Bio C Plus', 'Bio-C Plus')).toBe(1);
    expect(nameSimilarity('Beta Plus', 'Cyto-Zyme')).toBe(0);
  });
});

describe('evidence verification', () => {
  const transcript = 'Speaker 1 0:02\nSo the gallbladder is showing some stress today.\n';

  it('passes a verbatim quote', () => {
    const [e] = verifyEvidence(
      [{ path: 'assessments.0', quote: 'the gallbladder is showing some stress', at_seconds: 2 }],
      transcript,
    );
    expect(e.unverified).toBe(false);
  });

  it('tolerates punctuation and casing drift', () => {
    const [e] = verifyEvidence(
      [{ path: 'assessments.0', quote: 'The gallbladder is showing some stress!', at_seconds: 2 }],
      transcript,
    );
    expect(e.unverified).toBe(false);
  });

  it('flags a quote that is nowhere in the transcript', () => {
    // This is the mechanical hallucination check — a finding the model would not
    // point at is a finding it invented.
    const [e] = verifyEvidence(
      [{ path: 'nrt.hta', quote: 'HTA is coming in at sixty eight', at_seconds: 400 }],
      transcript,
    );
    expect(e.unverified).toBe(true);
  });

  it('flags rather than drops — a real finding must still reach review', () => {
    const out = verifyEvidence(
      [{ path: 'nrt.hta', quote: 'totally invented', at_seconds: null }],
      transcript,
    );
    expect(out).toHaveLength(1);
  });

  it('passes a paraphrase whose content words are all present', () => {
    // Near-matching exists for this case: same finding, looser wording.
    const [e] = verifyEvidence(
      [{ path: 'assessments.0', quote: 'gallbladder stress', at_seconds: 2 }],
      transcript,
    );
    expect(e.unverified).toBe(false);
  });

  it('flags a quote that inverts the finding it cites', () => {
    // The dangerous near-match: every content word is in the transcript, but the
    // negation is not, so the quote asserts the opposite of what was said. Word
    // overlap alone waves this through — which is why negators are required
    // verbatim rather than counted toward the ratio.
    const [e] = verifyEvidence(
      [{ path: 'assessments.0', quote: 'the gallbladder is not showing stress', at_seconds: 2 }],
      transcript,
    );
    expect(e.unverified).toBe(true);
  });

  it('does not let a wide window manufacture a match from scattered words', () => {
    // Every content word below appears in this transcript, but spread across
    // unrelated sentences — never as the claim the quote makes.
    const scattered =
      'Speaker 1 0:02\nThe gallbladder is fine.\nSpeaker 2 0:20\nSleep has been good.\n' +
      'Speaker 1 0:40\nWe talked about stress at work last month.\n';
    const [e] = verifyEvidence(
      [{ path: 'assessments.0', quote: 'the gallbladder is showing stress', at_seconds: 2 }],
      scattered,
    );
    expect(e.unverified).toBe(true);
  });
});

describe('wording fidelity', () => {
  const turn =
    "PRACTITIONER: so the gallbladder is showing stress, and the stressor is showing to be food.";

  it('scores a trimmed span of the practitioner\'s speech as theirs', () => {
    expect(wordingFidelity('the gallbladder is showing stress', turn)).toBe(1);
  });

  it('scores chart-note prose low even though the turn genuinely backs it', () => {
    // The failure this measures: every provenance signal reads green — real
    // turn, quote copied out of it — and the sentence Nicole reads is the
    // model's, in language the practitioner never used.
    expect(wordingFidelity('cholestatic pattern noted on assessment', turn)).toBeLessThan(0.5);
  });

  it('does not punish a faithful item for dropping filler words', () => {
    expect(wordingFidelity('gallbladder showing stress', turn)).toBe(1);
  });
});

describe('provider JSON schema', () => {
  const schemas = [
    ['narrative', NARRATIVE_JSON_SCHEMA],
    ['assessments', ASSESSMENTS_JSON_SCHEMA],
    ['protocol', PROTOCOL_JSON_SCHEMA],
    ['nrt', NRT_JSON_SCHEMA],
  ] as const;

  it('describes every field — no bare {} the model has to guess at', () => {
    for (const [name, schema] of schemas) {
      expect(JSON.stringify(schema), name).not.toContain('":{}');
    }
  });

  it('uses the conservative subset providers accept', () => {
    for (const [name, schema] of schemas) {
      const json = JSON.stringify(schema);
      expect(json, name).not.toContain('$schema');
      expect(json, name).not.toContain('$ref');
      expect(json, name).not.toContain('additionalProperties');
      // anyOf-with-null is collapsed to `nullable`.
      expect(json, name).not.toContain('"type":"null"');
    }
  });

  it('never asks the model for a server-computed field', () => {
    // change_raw / unverified / extraction are OUR bookkeeping; a model that
    // filled them would be inventing its own provenance.
    const json = JSON.stringify(schemas.map(([, s]) => s));
    for (const field of ['change_raw', 'change_unresolved', 'type_raw', 'unverified', 'extraction']) {
      expect(json, field).not.toContain(`"${field}"`);
    }
  });

  it('stays key-for-key aligned with the schema that validates the result', () => {
    // The hand-written JSON mirror this replaced had already drifted
    // (supplements.obtained_from existed in zod and not in the JSON copy). This
    // is the guard that it cannot happen again.
    const wireKeys = (schema: unknown): string[] =>
      Object.keys((schema as { properties: Record<string, unknown> }).properties).sort();

    expect(wireKeys(NARRATIVE_JSON_SCHEMA)).toEqual(
      Object.keys(NarrativeStageSchema.shape).sort(),
    );
    expect(wireKeys(ASSESSMENTS_JSON_SCHEMA)).toEqual(
      Object.keys(AssessmentsStageSchema.shape).sort(),
    );
    expect(wireKeys(PROTOCOL_JSON_SCHEMA)).toEqual(
      Object.keys(ProtocolStageSchema.shape).sort(),
    );
    expect(wireKeys(NRT_JSON_SCHEMA)).toEqual(Object.keys(NrtStageSchema.shape).sort());
  });

  it('requires every property, so "not stated" arrives as an explicit null', () => {
    const nrt = NRT_JSON_SCHEMA as {
      properties: { nrt: { properties: Record<string, unknown>; required: string[] } };
    };
    expect(nrt.properties.nrt.required).toEqual(Object.keys(nrt.properties.nrt.properties));
  });
});

describe('span-based evidence', () => {
  // Turn #0 practitioner, #1 client, #2 practitioner.
  const transcript = [
    'SPEAKER_00: So the gallbladder is showing some stress today.',
    'SPEAKER_01: I do have high cholesterol. But I am not on anything for it.',
    'SPEAKER_00: We are going to add a B vitamin to pair with that.',
  ].join('\n');

  const ev = (e: Record<string, unknown>) =>
    verifyEvidence([{ path: 'assessments.0', at_seconds: null, ...e } as never], transcript)[0];

  it('verifies a quote copied out of the turn it cites', () => {
    const e = ev({ quote: 'the gallbladder is showing some stress', turn: 0 });
    expect(e.verification).toBe('span');
    expect(e.unverified).toBe(false);
  });

  it('resolves the cited turn back to its real words for review', () => {
    // The point of a citation: Nicole reads the transcript, not the model's
    // rendering of it.
    const e = ev({ quote: 'the gallbladder is showing some stress', turn: 0 });
    expect(e.turn_text).toContain('So the gallbladder is showing some stress today.');
  });

  it('flags a citation pointing at a turn that does not say this', () => {
    // The strongest fabrication signal available: the model pointed somewhere
    // specific and was wrong.
    const e = ev({ quote: 'the thyroid was removed last year', turn: 0 });
    expect(e.verification).toBe('misattributed');
    expect(e.unverified).toBe(true);
  });

  it('flags a citation to a turn number that does not exist', () => {
    const e = ev({ quote: 'HTA is coming in at sixty eight', turn: 99 });
    expect(e.verification).toBe('bad_span');
    expect(e.unverified).toBe(true);
  });

  it('corrects a wrong turn number when the quote is verbatim elsewhere', () => {
    // The finding is real and the words are real — only the pointer was wrong,
    // so repoint it rather than discarding the evidence.
    const e = ev({ quote: 'We are going to add a B vitamin', turn: 0 });
    expect(e.verification).toBe('exact');
    expect(e.turn).toBe(2);
    expect(e.unverified).toBe(false);
  });

  it('separates a reworded citation from a copied one', () => {
    // "not high" against a turn that says "high cholesterol ... not on anything":
    // the negation belongs to a different clause, and no lexical check resolves
    // that scope. It stays supported but marked as the model's wording, which is
    // what sends Nicole to the turn text where the reversal is obvious.
    const e = ev({ quote: 'my cholesterol is not high', turn: 1 });
    expect(e.verification).toBe('span_near');
    expect(e.turn_text).toContain('I do have high cholesterol');
  });

  it('tolerates an off-by-one citation, and records the drift', () => {
    // Real failure from Patricia's session: the model cited #160 for findings
    // plainly stated in #161, having cited #161 correctly four other times.
    // Not verbatim anywhere, so the exact-match repoint cannot rescue it — this
    // reaches the drift path specifically.
    const e = ev({ quote: 'gallbladder stress', turn: 1 });
    expect(e.verification).toBe('span_near');
    expect(e.turn).toBe(0);
    expect(e.turn_cited).toBe(1);
    expect(e.unverified).toBe(false);
  });

  it('does not let that tolerance rescue an invented finding', () => {
    // The boundary that makes the tolerance safe: a finding stated nowhere in
    // the session must stay flagged even with drift allowed.
    const e = ev({ quote: 'the thyroid was removed last year', turn: 1 });
    expect(e.verification).toBe('misattributed');
    expect(e.unverified).toBe(true);
  });

  it('reads through a disfluency the speaker left in', () => {
    // Real case: Nicole said "the thyroid is, like, crashing". The quote is a
    // faithful copy and still not a substring, and that alone was enough to
    // report a true clinical finding as fabricated.
    const spoken = 'SPEAKER_00: To no surprise, the thyroid is, like, crashing.';
    const [e] = verifyEvidence(
      [{ path: 'assessments.0', quote: 'the thyroid is crashing', turn: 0, at_seconds: null } as never],
      spoken,
    );
    expect(e.verification).toBe('span');
    expect(e.unverified).toBe(false);
  });

  it('does not strip a meaningful "like" along with the filler', () => {
    const spoken = 'SPEAKER_00: Yeah, I like garlic.';
    const [e] = verifyEvidence(
      [{ path: 'concerns.0', quote: 'I like garlic', turn: 0, at_seconds: null } as never],
      spoken,
    );
    expect(e.verification).toBe('span');
  });

  it('still verifies notes extracted before citations existed', () => {
    // No `turn` at all — the stored-note path must keep working.
    const e = ev({ quote: 'the gallbladder is showing some stress' });
    expect(e.verification).toBe('exact');
    expect(e.unverified).toBe(false);
  });

  it('counts anchored findings so citation health is observable', () => {
    const out = verifyEvidence(
      [
        { path: 'a', quote: 'the gallbladder is showing some stress', turn: 0, at_seconds: null },
        { path: 'b', quote: 'invented entirely', turn: 0, at_seconds: null },
      ] as never,
      transcript,
    );
    const s = summarize(out);
    expect(s.spans).toBe(1);
    expect(s.unverified).toBe(1);
    expect(s.byStatus.misattributed).toBe(1);
  });
});

describe('stage subsetting', () => {
  it('assigns every extracted field to exactly one stage', () => {
    // Subsetting decides which fields are "absent because nobody looked" rather
    // than "absent because nothing was said". A field missing from this map
    // would be scored as a total recall failure whenever its stage is skipped,
    // and the eval would report a measurement that never happened.
    const owned = Object.values(STAGE_FIELDS).flat();
    const fields = Object.keys(SessionNoteSchema.shape).filter(
      (f) => f !== 'evidence' && f !== 'extraction',
    );
    for (const f of fields) {
      expect(owned.filter((o) => o === f), `${f} must be owned by exactly one stage`).toHaveLength(1);
    }
    for (const o of owned) expect(fields, `${o} is not a note field`).toContain(o);
  });

  it('keeps "skipped" apart from "partial" on the note', () => {
    // partial means a stage tried and failed, which makes every number derived
    // from the note a floor. skipped means nobody asked it to run, which says
    // nothing about quality. Merging them would report a deliberate two-stage
    // measurement as a broken four-stage extraction.
    const note = SessionNoteSchema.parse({
      concerns: [],
      extraction: { skipped: ['protocol', 'nrt'], partial: ['narrative'] },
    });
    expect(note.extraction?.skipped).toEqual(['protocol', 'nrt']);
    expect(note.extraction?.partial).toEqual(['narrative']);
  });
});
