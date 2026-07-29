// Supplement identity.
//
// The extraction prompt deliberately preserves whatever the practitioner said,
// garbled phonetics and all — a supplement we can't name is still a supplement
// Nicole needs to see. But the plan tables key on that string: syncClientSupplements
// matches on `lower(name)`, and so do previewSupplementMerge and the amendment
// rollback. So "Bio-C Plus", "Bio C Plus" and "BioC plus 60ct" become THREE rows
// on one client's plan, and WF4 dutifully projects three refills for a product
// they take once.
//
// Split the two jobs: `name` stays exactly as spoken (it's what prints on the
// client's Supplement Protocol), and `name_key` is the identity everything joins
// on. Normalizing is deliberately conservative — it collapses punctuation and
// packaging noise, never two genuinely different products.

/**
 * Packaging suffixes that describe the BOTTLE, not the product.
 *
 * Deliberately excludes strength units (mg, mcg, iu, g, ml, oz): "Vitamin D
 * 5000iu" and "Vitamin D 1000iu" are different products, and collapsing them
 * would merge two prescriptions into one row on the client's plan. Count words
 * are the only safe thing to drop.
 */
const PACK_SUFFIX =
  /\s*[-–(]?\s*\b\d+\s*(?:ct|count|caps?|capsules?|tabs?|tablets?|softgels?|servings?)\b\.?\s*\)?\s*$/i;

/** Noise words that vary between how a product is spoken and how it's written. */
const NOISE_WORDS = new Set(['the', 'a', 'brand', 'formula']);

/**
 * Canonical identity for a supplement name. Lowercase, punctuation-stripped,
 * whitespace-collapsed, with trailing pack sizes removed.
 *
 *   "Bio-C Plus"        → "bio c plus"
 *   "Bio C Plus 60ct"   → "bio c plus"
 *   "BioC plus."        → "bioc plus"
 *
 * Note "BioC" does NOT collapse to "bio c": joining/splitting words changes what
 * was actually said, and a wrong merge silently rewrites a client's plan. The
 * fuzzy catalog match in extraction (which a human confirms) is the right place
 * to bridge that gap — not a silent key collision here.
 */
export function normalizeSupplementName(name: string | null | undefined): string {
  if (!name) return '';
  let s = name.normalize('NFKD').toLowerCase();
  // Strip pack size repeatedly: "Vitamin D 5000iu 120 caps" has two.
  let prev: string;
  do {
    prev = s;
    s = s.replace(PACK_SUFFIX, '');
  } while (s !== prev);
  s = s
    .replace(/['’`]/g, '') // don't split possessives into a stray token
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
  const words = s.split(' ').filter(Boolean);
  const meaningful = words.filter((w) => !NOISE_WORDS.has(w));
  // Never let noise-word stripping empty the key: "The Formula" would normalize
  // to "" and every such product would collide into one identity — or, where the
  // caller falls back to a per-row placeholder, split into one row per mention.
  return (meaningful.length ? meaningful : words).join(' ');
}

/**
 * Token-set similarity in [0,1], for matching a spoken name against the
 * practice's known products. Used to SUGGEST a match for Nicole to confirm —
 * never to rewrite a name automatically.
 */
export function nameSimilarity(a: string, b: string): number {
  const ta = new Set(normalizeSupplementName(a).split(' ').filter(Boolean));
  const tb = new Set(normalizeSupplementName(b).split(' ').filter(Boolean));
  if (ta.size === 0 || tb.size === 0) return 0;
  let shared = 0;
  for (const t of ta) if (tb.has(t)) shared++;
  return shared / Math.max(ta.size, tb.size);
}

export interface CatalogMatch {
  /** The catalog product the spoken name most likely refers to. */
  name: string;
  score: number;
}

/**
 * Best catalog match for a spoken supplement name, or null when nothing is close
 * enough to be worth showing. The threshold is high on purpose: a wrong
 * suggestion that Nicole clicks through is worse than no suggestion at all.
 */
export function matchCatalog(
  spoken: string,
  catalog: readonly string[],
  threshold = 0.6,
): CatalogMatch | null {
  const key = normalizeSupplementName(spoken);
  if (!key) return null;
  let best: CatalogMatch | null = null;
  for (const candidate of catalog) {
    // An exact key hit is the same product under different punctuation — that's
    // not a suggestion, it's an identity, and the caller can apply it silently.
    if (normalizeSupplementName(candidate) === key) return { name: candidate, score: 1 };
    const score = nameSimilarity(spoken, candidate);
    if (score >= threshold && (!best || score > best.score)) best = { name: candidate, score };
  }
  return best;
}
