import { z } from 'zod';

// Structured session note (WF1 step 3): what the transcript parse produces,
// feeding both the Appointment Sheet and the Protocol.
// Nutrition Response Testing findings. These are muscle-testing results Nicole
// calls out during the session; they fill the ROF's NRT block and the Flow Sheet's
// FOUNDATION / BODY SCAN columns. Every field is nullable and stays null unless the
// transcript states it — a wrong clinical value is far worse than a blank one.

// --- Label echo --------------------------------------------------------------

// Models frequently echo the prompt name back into the value: asked for HTA they
// answer "HTA is negative", or worse just "LAYING 1 FOUNDATIONS". The value then
// renders as "HTA: HTA is negative" on the flow sheet, and a bare label echo is
// indistinguishable from a real finding. Strip the echo deterministically rather
// than only asking the prompt to stop — the prompt is guidance, this is a
// guarantee.
//
// But half these prompt names are ordinary English words. Stripping a bare
// leading "open" turned "Open on the left" into "on the left", and "cell" turned
// "Cell membranes weak" into "membranes weak" — quietly rewriting a clinical
// finding into a different one. So aliases come in two classes: names that can
// only be the label (strip on sight) and names that are also normal words (strip
// only when punctuation or a linking verb proves it was a label).
const CONNECTOR = String.raw`(?:\s+(?:is|was|are|were|shows?|reads?))`;
const DELIM = String.raw`\s*[:\-–]`;

interface Alias {
  text: string;
  /** True when the word is unambiguous enough to strip without a delimiter. */
  distinctive: boolean;
}

const A = (text: string): Alias => ({ text, distinctive: true });
/** Also an ordinary English word — needs a delimiter or linking verb. */
const W = (text: string): Alias => ({ text, distinctive: false });

function escape(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function stripEcho(value: string | null, aliases: Alias[]): string | null {
  if (!value) return null;
  const out = value.trim();
  for (const alias of aliases) {
    const name = escape(alias.text);
    // Distinctive: "HTA", "HTA is negative", "HTA: negative" all strip.
    // Ambiguous: only "OPEN:" / "OPEN is ..." strip; a bare "Open ..." does not.
    // The whole-value case (`$`) stays for both — a value that is ONLY the label
    // carries no finding at all, and must read as a blank rather than a result.
    const pattern = alias.distinctive
      ? `^${name}(?:${CONNECTOR})?(?:${DELIM})?\\s*`
      : `^${name}(?:(?:${CONNECTOR})?(?:${DELIM})\\s*|${CONNECTOR}\\s+|\\s*$)`;
    const next = out.replace(new RegExp(pattern, 'i'), '').trim();
    // Stop at the first alias that matched: applying the rest can strip twice
    // ("HTA POST RUN: post run 62" losing both).
    if (next !== out) return next.length ? next : null;
  }
  return out.length ? out : null;
}

function stripEchoes<T extends Record<string, string | null>>(
  obj: T,
  labels: Record<keyof T, Alias[]>,
): T {
  const out = { ...obj };
  for (const key of Object.keys(out) as (keyof T)[]) {
    (out as Record<string, string | null>)[key as string] = stripEcho(out[key], labels[key] ?? []);
  }
  return out;
}

const FOUNDATION_LABELS = {
  laying1: [A('laying 1 foundations'), A('laying 1')],
  standing: [A('standing foundations'), W('standing')],
  hta: [A('hta')],
  hta_post_run: [A('hta post run'), A('post run')],
  laying2: [A('laying 2 foundations'), A('laying 2')],
  art_open: [A('art open'), W('open')],
  art_switch: [A('art switch'), W('switch')],
  art_cns: [A('art cns'), A('cns')],
  art_dental: [A('art dental'), W('dental')],
  art_hormonal: [A('art hormonal'), W('hormonal')],
  additional: [W('additional')],
};

const BODY_SCAN_LABELS = {
  art_ectoderm: [A('art ectoderm'), A('ectoderm')],
  art_priority: [A('art priority'), W('priority')],
  art_matrix: [A('art matrix'), W('matrix')],
  art_cell: [A('art cell'), W('cell')],
  additional_art: [A('additional art')],
  scan_priority: [A('body scan priority'), A('scan priority'), W('priority')],
  scan_matrix: [A('body scan matrix'), A('scan matrix'), W('matrix')],
  scan_cell: [A('body scan cell'), A('scan cell'), W('cell')],
  additional_nrt: [A('additional nrt')],
};

const LIFESTYLE_LABELS = {
  bm: [A('bowel movements'), A('bowel movement'), A('bm')],
  sleep: [W('sleep')],
  water: [A('water intake'), W('water')],
  cycle: [A('menstrual cycle'), W('cycle')],
  exercise: [W('exercise')],
  diet: [W('diet')],
};

/**
 * A field that stays null unless the transcript states it.
 *
 * Coercion happens in a `preprocess` rather than a trailing `transform` so the
 * schema's OUTPUT stays a plain nullable string. That matters because the
 * provider JSON Schema is generated from this schema: a transform is an opaque
 * function to the generator and renders as `{}` ("any value"), which tells the
 * model nothing about the field it is meant to fill.
 */
const stated = (): z.ZodType<string | null, unknown> =>
  z.preprocess(
    (v) => (typeof v === 'string' ? v.trim() || null : (v ?? null)),
    z.string().nullable(),
  ) as unknown as z.ZodType<string | null, unknown>;

const num = (): z.ZodType<number | null, unknown> =>
  z.preprocess((v) => v ?? null, z.number().nullable()) as unknown as z.ZodType<number | null, unknown>;

// --- Lenient enums -----------------------------------------------------------

/**
 * The model routinely answers *off-script* for these: asked for a supplement
 * `change` of start/stop/… it says "add", "hold", "as needed". A raw z.enum
 * THROWS on any such value — discarding the whole extracted session over one
 * mislabelled action word — so we map synonyms instead.
 *
 * Two things this must NOT do, both of which it used to:
 *
 * 1. Match on substring. `s.includes('increase')` fires on "don't increase yet"
 *    and `includes('add')` on "we're not going to add that", inverting the
 *    clinical action. Match on word boundaries and refuse outright when the verb
 *    is negated.
 * 2. Resolve an unknown value silently. The old fallback was 'continue' — which
 *    is also the most COMMON legitimate value, so a mangled "stop" became an
 *    invisible "continue", syncClientSupplements kept a discontinued supplement
 *    on the client's plan, and WF4 went on projecting refills for it. Now an
 *    unmapped value still yields a safe default, but records the raw string so
 *    review can flag it instead of trusting it.
 */
const NEGATION = /\b(?:not|never|dont|doesnt|didnt|wont|no longer|instead of|rather than|hold off)\b/;

export interface EnumMapping<T extends string> {
  value: T;
  /** The model's original string, when it wasn't already an exact enum member. */
  raw: string | null;
  /** True when nothing matched and `value` is only a placeholder. */
  unresolved: boolean;
}

function mapEnum<T extends string>(
  input: unknown,
  allowed: readonly T[],
  fallback: T,
  synonyms: Record<string, T>,
  compiled: [RegExp, T][],
): EnumMapping<T> {
  if (typeof input !== 'string') return { value: fallback, raw: null, unresolved: true };
  const s = input.trim().toLowerCase();
  if ((allowed as readonly string[]).includes(s)) return { value: s as T, raw: null, unresolved: false };

  // "we're not going to add that" states no action at all. Mapping it to `add`
  // is worse than admitting we don't know.
  const negated = NEGATION.test(s.replace(/['’]/g, ''));
  if (!negated) {
    for (const [re, target] of compiled) {
      if (re.test(s)) return { value: target, raw: input, unresolved: false };
    }
  }
  void synonyms;
  return { value: fallback, raw: input, unresolved: true };
}

/** Compile synonyms to word-boundary regexes ONCE, longest key first so
 *  "take out" wins over a stray "take". */
function compile<T extends string>(synonyms: Record<string, T>): [RegExp, T][] {
  return Object.keys(synonyms)
    .sort((a, b) => b.length - a.length)
    .map((key) => [new RegExp(`\\b${escape(key)}\\b`), synonyms[key]] as [RegExp, T]);
}

const CHANGE_VALUES = ['start', 'stop', 'increase', 'decrease', 'continue'] as const;
export type SupplementChange = (typeof CHANGE_VALUES)[number];
const CHANGE_SYNONYMS: Record<string, SupplementChange> = {
  add: 'start', added: 'start', adding: 'start', new: 'start', introduce: 'start', begin: 'start', started: 'start',
  stop: 'stop', remove: 'stop', 'take out': 'stop', 'taking out': 'stop', discontinue: 'stop',
  hold: 'stop', off: 'stop', drop: 'stop', pause: 'stop',
  increase: 'increase', increased: 'increase', upping: 'increase', 'up the': 'increase', raise: 'increase',
  more: 'increase', higher: 'increase', double: 'increase', doubling: 'increase',
  decrease: 'decrease', decreased: 'decrease', lower: 'decrease', reduce: 'decrease', less: 'decrease',
  keep: 'continue', keeping: 'continue', maintain: 'continue', refill: 'continue', same: 'continue',
  unchanged: 'continue', 'as needed': 'continue',
};
const CHANGE_COMPILED = compile(CHANGE_SYNONYMS);

const PROTOCOL_TYPE_VALUES = ['add', 'remove', 'adjust', 'continue'] as const;
export type ProtocolChangeType = (typeof PROTOCOL_TYPE_VALUES)[number];
const PROTOCOL_SYNONYMS: Record<string, ProtocolChangeType> = {
  add: 'add', start: 'add', new: 'add', introduce: 'add', begin: 'add',
  remove: 'remove', stop: 'remove', 'take out': 'remove', discontinue: 'remove', drop: 'remove',
  hold: 'remove', off: 'remove',
  adjust: 'adjust', change: 'adjust', increase: 'adjust', decrease: 'adjust', upping: 'adjust',
  lower: 'adjust', dose: 'adjust',
  keep: 'continue', continue: 'continue', maintain: 'continue', refill: 'continue', same: 'continue',
};
const PROTOCOL_COMPILED = compile(PROTOCOL_SYNONYMS);

export function mapChange(input: unknown): EnumMapping<SupplementChange> {
  // An unresolved change defaults to 'continue' because it is the only action
  // that changes nothing: it neither starts a supplement the practitioner never
  // prescribed nor removes one they still want. The `raw`/`unresolved` flags are
  // what stop it from passing as a real reading.
  return mapEnum(input, CHANGE_VALUES, 'continue', CHANGE_SYNONYMS, CHANGE_COMPILED);
}

export function mapProtocolType(input: unknown): EnumMapping<ProtocolChangeType> {
  return mapEnum(input, PROTOCOL_TYPE_VALUES, 'continue', PROTOCOL_SYNONYMS, PROTOCOL_COMPILED);
}

// --- Findings ----------------------------------------------------------------

// The FOUNDATION column (D) of the Flow Sheet is not free text — it is a fixed
// list of muscle-testing prompts Nicole works down in order. Modelling each prompt
// as its own field is what lets the review UI show her "HTA: 68" against a blank
// "HTA POST RUN", instead of one blob she has to read for what's missing.
// Legacy notes stored a single string here; it lands in `additional`.
//
// Each findings group is defined ONCE as a plain object (`*Object`) and wrapped
// separately with the coercion the stored data needs (`*Schema`). The plain
// object is what the provider JSON Schema is generated from: a trailing
// `.transform()` is an opaque function to the generator and renders as `{}`
// ("any value"), which tells the model nothing about the field it has to fill.
// Both forms share the same field list, so there is nothing to keep in sync.
export const FoundationObject = z.object({
  laying1: stated(),
  standing: stated(),
  hta: stated(),
  hta_post_run: stated(),
  laying2: stated(),
  art_open: stated(),
  art_switch: stated(),
  art_cns: stated(),
  art_dental: stated(),
  art_hormonal: stated(),
  additional: stated(),
});

export const FoundationSchema = z
  .preprocess((v) => (typeof v === 'string' ? { additional: v } : v), FoundationObject)
  .transform((v) => (v ? stripEchoes(v, FOUNDATION_LABELS) : v));

// The BODY SCAN column (E): two testing passes — ART with polarity, then NRT
// without — each with its own PRIORITY / MATRIX / CELL readings.
export const BodyScanObject = z.object({
  art_ectoderm: stated(),
  art_priority: stated(),
  art_matrix: stated(),
  art_cell: stated(),
  additional_art: stated(),
  scan_priority: stated(),
  scan_matrix: stated(),
  scan_cell: stated(),
  additional_nrt: stated(),
});

export const BodyScanSchema = z
  .preprocess((v) => (typeof v === 'string' ? { additional_nrt: v } : v), BodyScanObject)
  .transform((v) => (v ? stripEchoes(v, BODY_SCAN_LABELS) : v));

export const NrtFindingsSchema = z.object({
  pulse0: stated(),
  priority1: stated(),
  k27: stated(),
  // Some models return stressors as an array — join it into a string.
  stressors: z.preprocess(
    (v) => (Array.isArray(v) ? v.join(', ') : (v ?? null)),
    z.string().nullable(),
  ),
  foundation: FoundationSchema.nullish().transform((v) => v ?? null),
  body_scan: BodyScanSchema.nullish().transform((v) => v ?? null),
});

/** Wire twin of NrtFindingsSchema — same fields, no transforms. */
export const NrtFindingsObject = z.object({
  pulse0: stated(),
  priority1: stated(),
  k27: stated(),
  stressors: stated(),
  foundation: FoundationObject.nullable(),
  body_scan: BodyScanObject.nullable(),
});

export type FoundationFindings = z.infer<typeof FoundationSchema>;
export type BodyScanFindings = z.infer<typeof BodyScanSchema>;

// The Flow Sheet's lifestyle log (column B), as reported by the client in-session.
export const LifestyleObject = z.object({
  bm: stated(),
  sleep: stated(),
  water: stated(),
  cycle: stated(),
  exercise: stated(),
  diet: stated(),
});

export const LifestyleSchema = LifestyleObject.transform((v) => stripEchoes(v, LIFESTYLE_LABELS));

// The Supplement Protocol grid's time-of-day columns (D–J). Keys match
// ScheduleSlot in integrations/docs/types.ts.
export const ScheduleSchema = z.object({
  uponWaking: stated(),
  breakfast: stated(),
  midMorning: stated(),
  lunch: stated(),
  midAfternoon: stated(),
  dinner: stated(),
  beforeBed: stated(),
});

export const FollowUpSchema = z.object({
  text: z.string().default(''),
  // Only when a timeframe was actually said. "Recheck in 4 weeks" → 28. "Keep an
  // eye on her sleep" → null, and the task simply has no due date. Never guessed.
  due_in_days: z.number().int().nullish().transform((v) => v ?? null),
});

export const ProtocolChangeSchema = z.preprocess(
  (v) => {
    if (!v || typeof v !== 'object') return v;
    const o = v as Record<string, unknown>;
    const m = mapProtocolType(o.type);
    return {
      ...o,
      type: m.value,
      // Preserve a flag already stored on the note: re-parsing a saved note must
      // not quietly clear the "this was guessed" marker.
      type_raw: o.type_raw ?? m.raw,
      type_unresolved: o.type_unresolved ?? m.unresolved,
    };
  },
  z.object({
    description: z.string().nullish().transform((v) => v ?? ''),
    type: z.enum(PROTOCOL_TYPE_VALUES),
    type_raw: stated().optional(),
    type_unresolved: z.boolean().optional(),
  }),
);

export const SupplementSchema = z.preprocess(
  (v) => {
    if (!v || typeof v !== 'object') return v;
    const o = v as Record<string, unknown>;
    const m = mapChange(o.change);
    return {
      ...o,
      change: m.value,
      change_raw: o.change_raw ?? m.raw,
      change_unresolved: o.change_unresolved ?? m.unresolved,
    };
  },
  z.object({
    name: z.string().default(''),
    dose: stated(),
    quantity: num(),
    change: z.enum(CHANGE_VALUES),
    /** Set when `change` did not arrive as a clean enum value. Review shows the
     *  mapping ("model said *hold* → stop") instead of presenting it as fact. */
    change_raw: stated().optional(),
    /** Nothing matched at all — `change` is a placeholder, not a reading. */
    change_unresolved: z.boolean().optional(),
    // Dosing slots on the Supplement Protocol's Daily Schedule grid. A slot is
    // filled only when the timing was actually spoken; an absent slot means
    // "not taken then", not "unknown". Models routinely return an explicit
    // `schedule: null` when no timing was said, so tolerate null as well as an
    // omitted key — every other nested field is nullish, and rejecting null
    // here fails the whole extraction over a field that was correctly blank.
    schedule: ScheduleSchema.nullish(),
    // "Here | Fullscript" on the protocol grid — where the client gets it.
    // Rarely spoken aloud, so usually filled in by Nicole during review.
    obtained_from: stated().optional(),
    // The ROF's "Function" column — what this supplement is FOR, in terms the
    // client reads ("supports adrenal recovery"). It is practitioner knowledge
    // rather than something said in session, so it stays null unless she
    // writes it; the ROF simply leaves that cell blank.
    func: stated().optional(),
    // Structured dose. The model already read "two caps twice a day"; having it
    // emit the numbers once beats WF4 regex-parsing them back out of the string
    // downstream and defaulting to 1 when the regex misses. `dose` stays the
    // verbatim source of truth — the ROF and Protocol print the spoken words.
    units_per_dose: num().optional(),
    unit: stated().optional(),
    doses_per_day: num().optional(),
    /** Catalog product this was matched to, when it wasn't an exact hit. Shown
     *  in review as a suggestion to confirm — never applied silently. */
    name_matched_to: stated().optional(),
  }),
);

// --- Provenance --------------------------------------------------------------

/**
 * Where a finding came from. An array rather than a keyed object because every
 * provider handles arrays identically, while `additionalProperties` maps are
 * uneven across structured-output implementations.
 *
 * This is what makes review fast — Nicole confirms against the practitioner's
 * own words instead of recalling the session — and it is also the only
 * mechanical hallucination check available: a quote that does not appear in the
 * transcript is a fabricated finding, detectable without a human.
 */
/**
 * How a piece of evidence was checked. Verbatim prose is the weakest form of
 * citation a model can give — it has to reproduce the words from memory, and it
 * routinely paraphrases instead, so a failed text match conflates "invented the
 * finding" with "invented only the wording". A turn NUMBER cannot be
 * paraphrased: it either addresses the turn that supports the claim or it does
 * not, and the server can tell which without a human.
 *
 *  - `span`        cited a turn, and quoted it word for word — the strong case
 *  - `span_near`   cited a turn that is clearly about this, but the quote is a
 *                  paraphrase of it. The model had the turn in front of it and
 *                  still reworded, so the wording is its own rather than the
 *                  practitioner's. The finding stands; the phrasing wants eyes,
 *                  because this is the shape a reversed meaning arrives in
 *                  ("not high" against a turn that says "high ... not on
 *                  anything"), and no lexical check resolves that scope
 *  - `exact`       no usable citation, but the quote is verbatim in the transcript
 *  - `near`        no usable citation, and the quote only approximately matches
 *  - `unsupported` nothing backs this finding
 *  - `misattributed` cited a REAL turn that does not say this — the model
 *                  pointed somewhere specific and was wrong, which is a stronger
 *                  fabrication signal than a quote that merely failed to match
 *  - `bad_span`    cited a turn number that does not exist
 */
export const VERIFICATION_VALUES = [
  'span', 'span_near', 'exact', 'near', 'unsupported', 'misattributed', 'bad_span',
] as const;
export type VerificationStatus = (typeof VERIFICATION_VALUES)[number];

export const EvidenceSchema = z.object({
  /** Dotted field path: "nrt.hta", "concerns.0", "supplements.1". */
  path: z.string(),
  quote: z.string(),
  at_seconds: num(),
  /** Global turn number this finding was read from — the `#n` in the rendered
   *  transcript. Null when the model gave no citation. */
  turn: num().optional(),
  /** Set by the server, not the model: the quote was not found in the
   *  transcript. The finding is kept and flagged, never silently dropped. */
  unverified: z.boolean().optional(),
  /** Server-computed: how the check above was satisfied, or how it failed. */
  verification: z.enum(VERIFICATION_VALUES).optional(),
  /** Server-resolved: the cited turn's ACTUAL words. Review shows this rather
   *  than the model's rendering of them, so what Nicole confirms against is the
   *  transcript itself. */
  turn_text: stated().optional(),
  /** What the model originally cited, when the server had to repoint `turn`.
   *  Keeps citation drift measurable rather than letting a corrected pointer
   *  look like one that was right the first time. */
  turn_cited: num().optional(),
});
export type Evidence = z.infer<typeof EvidenceSchema>;

/**
 * Evidence as a list, tolerating the object-map shape models routinely return
 * instead ({"nrt.hta": {quote, at_seconds}}). Rejecting that shape failed the
 * whole stage — every concern, finding and dose discarded because the
 * bookkeeping field came back in the other reasonable format. Coerce it.
 */
export const EvidenceListSchema = z.preprocess((v) => {
  if (Array.isArray(v)) return v;
  if (v && typeof v === 'object') {
    return Object.entries(v as Record<string, unknown>).map(([path, e]) =>
      e && typeof e === 'object' ? { path, ...(e as object) } : { path, quote: String(e ?? '') },
    );
  }
  return [];
}, z.array(EvidenceSchema));

/** Server-computed extraction metadata. Never produced by the model. */
export const ExtractionMetaSchema = z.object({
  prompt_version: z.string().optional(),
  provider: z.string().optional(),
  model: z.string().optional(),
  /** Stages that failed; their fields are absent, not empty. */
  partial: z.array(z.string()).optional(),
  /** Field paths where chunks disagreed — surfaced for Nicole to resolve. */
  conflicts: z.array(
    z.object({
      path: z.string(),
      chosen: z.string().nullish().transform((v) => v ?? null),
      candidates: z.array(z.string()).default([]),
    }),
  ).optional(),
  /**
   * Parts of the session that produced no usable extraction.
   *
   * `from`/`to` are seconds, and are null for a recorder that emits no
   * timestamps — which is the one actually in use, so a gap rendered from time
   * alone reads as "–, –, –" and tells Nicole nothing about what is missing.
   * `from_turn`/`to_turn` always exist: turns are numbered by us, not by the
   * recorder. `stage` says which pass lost the range, since a missing NRT grid
   * and a missing narrative are very different problems.
   */
  gaps: z
    .array(
      z.object({
        from: num(),
        to: num(),
        from_turn: num().optional(),
        to_turn: num().optional(),
        stage: z.string().optional(),
      }),
    )
    .optional(),
  /** Share of transcript words that got a speaker role. */
  attribution_coverage: num().optional(),
  chunks: num().optional(),
});
export type ExtractionMeta = z.infer<typeof ExtractionMetaSchema>;

export const SessionNoteSchema = z.object({
  concerns: z.array(z.string()).default([]),
  goals: z.array(z.string()).nullish().transform((v) => v ?? []),
  assessments: z.array(z.string()).default([]),
  protocol_changes: z.array(ProtocolChangeSchema).default([]),
  supplements: z.array(SupplementSchema).default([]),
  follow_ups: z.array(z.union([z.string(), FollowUpSchema])).default([]),
  // Optional so notes extracted before these fields existed still parse.
  nrt: NrtFindingsSchema.optional(),
  lifestyle: LifestyleSchema.optional(),
  evidence: EvidenceListSchema.optional(),
  extraction: ExtractionMetaSchema.optional(),
});

export type SessionNote = z.infer<typeof SessionNoteSchema>;

/** Evidence indexed by field path, for the review UI. */
export function evidenceMap(note: Pick<SessionNote, 'evidence'>): Map<string, Evidence> {
  return new Map((note.evidence ?? []).map((e) => [e.path, e]));
}

// --- Per-stage wire schemas --------------------------------------------------

// The extraction runs as three focused calls rather than one that does
// narrative summarisation and dictated-checklist transcription at the same time.
// Each stage validates against its own slice of the note, so a failure in one
// leaves the other two intact instead of discarding the session.
export const NarrativeStageSchema = z.object({
  concerns: z.array(z.string()).default([]),
  goals: z.array(z.string()).nullish().transform((v) => v ?? []),
  assessments: z.array(z.string()).default([]),
  follow_ups: z.array(z.union([z.string(), FollowUpSchema])).default([]),
  lifestyle: LifestyleSchema.optional(),
  evidence: EvidenceListSchema.optional(),
});

export const ProtocolStageSchema = z.object({
  supplements: z.array(SupplementSchema).default([]),
  protocol_changes: z.array(ProtocolChangeSchema).default([]),
  evidence: EvidenceListSchema.optional(),
});

export const NrtStageSchema = z.object({
  nrt: NrtFindingsSchema.optional(),
  evidence: EvidenceListSchema.optional(),
});

// Wire twins: the shape the MODEL must produce, built from the same field
// definitions as the validating schemas above, with the coercion left off so the
// generator can see through them. `schema.wire.test.ts` asserts the two stay
// key-for-key identical, so this can't silently drift the way the old
// hand-written JSON mirror did.
const EvidenceWire = z.object({
  path: z.string(),
  quote: z.string(),
  at_seconds: num(),
  turn: num(),
});

const SupplementWire = z.object({
  name: z.string(),
  dose: stated(),
  quantity: num(),
  change: z.enum(CHANGE_VALUES),
  schedule: z.object({
    uponWaking: stated(),
    breakfast: stated(),
    midMorning: stated(),
    lunch: stated(),
    midAfternoon: stated(),
    dinner: stated(),
    beforeBed: stated(),
  }).nullable(),
  obtained_from: stated(),
  func: stated(),
  units_per_dose: num(),
  unit: stated(),
  doses_per_day: num(),
});

const NarrativeWire = z.object({
  concerns: z.array(z.string()),
  goals: z.array(z.string()),
  assessments: z.array(z.string()),
  follow_ups: z.array(z.object({ text: z.string(), due_in_days: num() })),
  lifestyle: LifestyleObject,
  evidence: z.array(EvidenceWire),
});

const ProtocolWire = z.object({
  supplements: z.array(SupplementWire),
  protocol_changes: z.array(
    z.object({ description: z.string(), type: z.enum(PROTOCOL_TYPE_VALUES) }),
  ),
  evidence: z.array(EvidenceWire),
});

const NrtWire = z.object({
  nrt: NrtFindingsObject,
  evidence: z.array(EvidenceWire),
});

export const STAGE_WIRE = {
  narrative: NarrativeWire,
  protocol: ProtocolWire,
  nrt: NrtWire,
} as const;

// --- JSON Schema for providers that take one ---------------------------------

/**
 * Derived from the zod schema, never hand-written.
 *
 * The previous hand-kept mirror had already drifted — `supplements.obtained_from`
 * existed in zod and was missing from the JSON copy — and every field added since
 * would have doubled that maintenance. `io: 'output'` gives the shape the model
 * should PRODUCE (post-coercion), which is exactly what the schema is for.
 */
function toWireSchema(schema: z.ZodTypeAny): Record<string, unknown> {
  return z.toJSONSchema(schema, {
    io: 'output',
    unrepresentable: 'any',
    // Inline everything: providers vary in $ref/$defs support, and these schemas
    // are small enough that duplication costs less than a broken request.
    reused: 'inline',
  }) as Record<string, unknown>;
}

/** Fields the server computes; the model must never be asked to emit them. */
const SERVER_ONLY = new Set([
  'extraction',
  'change_raw',
  'change_unresolved',
  'type_raw',
  'type_unresolved',
  'unverified',
  'verification',
  'turn_text',
  'turn_cited',
  'name_matched_to',
]);

/**
 * Normalise a generated JSON Schema into the conservative subset every provider
 * accepts: `anyOf: [T, null]` collapsed to `nullable`, no `$schema`/`default`,
 * every property required (models fill required nulls far more reliably than
 * they volunteer optional keys — and a null IS the answer here).
 */
function adaptForProviders(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(adaptForProviders);
  if (!node || typeof node !== 'object') return node;
  let n = { ...(node as Record<string, unknown>) };

  // Collapse `anyOf: [T, null]` to a nullable T FIRST, merging T's own keys up.
  // Must happen before the cleanup below, or the merge re-introduces exactly the
  // keys ($schema, additionalProperties) we just removed.
  for (const key of ['anyOf', 'oneOf'] as const) {
    const variants = n[key];
    if (!Array.isArray(variants)) continue;
    const nonNull = variants.filter(
      (v) => !(v && typeof v === 'object' && (v as { type?: string }).type === 'null'),
    );
    if (nonNull.length === variants.length) continue;
    delete n[key];
    if (nonNull.length === 1) n = { ...(nonNull[0] as Record<string, unknown>), ...n };
    else n[key] = nonNull;
    n.nullable = true;
  }

  delete n.$schema;
  delete n.default;
  delete n.additionalProperties;

  if (n.properties && typeof n.properties === 'object') {
    const props: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(n.properties as Record<string, unknown>)) {
      if (SERVER_ONLY.has(key)) continue;
      props[key] = adaptForProviders(value);
    }
    n.properties = props;
    // Every property required. Models fill a required field with an explicit
    // null far more reliably than they volunteer an optional key — and here null
    // IS the answer, so "omitted" and "not stated" must not be the same shape.
    n.required = Object.keys(props);
  }
  if (n.items) n.items = adaptForProviders(n.items);
  for (const key of ['anyOf', 'oneOf'] as const) {
    if (Array.isArray(n[key])) n[key] = (n[key] as unknown[]).map(adaptForProviders);
  }
  return n;
}

export function jsonSchemaFor(schema: z.ZodTypeAny): unknown {
  return adaptForProviders(toWireSchema(schema));
}

export const NARRATIVE_JSON_SCHEMA = jsonSchemaFor(STAGE_WIRE.narrative);
export const PROTOCOL_JSON_SCHEMA = jsonSchemaFor(STAGE_WIRE.protocol);
export const NRT_JSON_SCHEMA = jsonSchemaFor(STAGE_WIRE.nrt);
