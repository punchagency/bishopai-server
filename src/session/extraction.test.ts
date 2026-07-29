import { describe, it, expect } from 'vitest';
import {
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
import { verifyEvidence } from './verifyEvidence';

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
});

describe('provider JSON schema', () => {
  const schemas = [
    ['narrative', NARRATIVE_JSON_SCHEMA],
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
