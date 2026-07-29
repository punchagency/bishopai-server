-- Extraction crash-recovery + supplement identity.
--
-- Two independent data-loss bugs in the transcript → SessionNote path.
--
-- 1. `processing` was a terminal state. processConversation claims a row by
--    setting extraction_status='processing', and only ever re-claims rows in
--    ('pending','failed'). A crash, deploy, or hung LLM call between the claim
--    and the write stranded the row there forever, and nothing swept it — the
--    appointment simply never got a sheet, silently. `failed` was barely better:
--    it was only retried if a human happened to re-match the conversation.
--
-- 2. The client's supplement plan keys on `lower(name)`, while extraction is
--    deliberately told to preserve garbled product names verbatim. So "Bio-C
--    Plus", "Bio C Plus" and "BioC plus 60ct" became three rows on one plan, and
--    WF4 projected three refills for a product taken once.

-- --- 1. Extraction retry state ---------------------------------------------

ALTER TABLE conversations DROP CONSTRAINT IF EXISTS conversations_extraction_status_check;
ALTER TABLE conversations ADD CONSTRAINT conversations_extraction_status_check
  CHECK (extraction_status IN ('pending', 'processing', 'done', 'failed', 'needs_review'));

ALTER TABLE conversations
  ADD COLUMN IF NOT EXISTS extraction_attempts integer NOT NULL DEFAULT 0,
  -- When the row became eligible again. NULL means "now".
  ADD COLUMN IF NOT EXISTS extraction_next_attempt_at timestamptz,
  -- Set at claim time; the reclaim sweep uses it to find rows whose owner died.
  ADD COLUMN IF NOT EXISTS extraction_leased_at timestamptz,
  ADD COLUMN IF NOT EXISTS extraction_error text,
  -- Raw model output on failure. Without it, truncation, a schema violation and
  -- a refusal are indistinguishable after the fact — the whole session is lost
  -- and nobody can say why.
  ADD COLUMN IF NOT EXISTS extraction_raw text;

-- Drives both sweeps: due-retry (status + next_attempt_at) and stuck-lease.
CREATE INDEX IF NOT EXISTS conversations_extraction_due_idx
  ON conversations(extraction_status, extraction_next_attempt_at)
  WHERE extraction_status IN ('pending', 'failed', 'processing');

-- --- 2. Supplement identity -------------------------------------------------

-- Normalized identity, kept alongside the verbatim spoken `name` (which is what
-- prints on the client's Supplement Protocol and must not be rewritten).
ALTER TABLE supplements ADD COLUMN IF NOT EXISTS name_key text;

-- Structured dose, captured at extraction time instead of regex-recovered from
-- the free-text `dose` by the refill projection (which silently defaults to 1
-- unit/day whenever its patterns miss). `dose` remains the verbatim source of
-- truth for the documents; these only feed the run-out math.
ALTER TABLE supplements
  ADD COLUMN IF NOT EXISTS units_per_dose numeric,
  ADD COLUMN IF NOT EXISTS doses_per_day numeric;

-- Backfill with the same rules as normalizeSupplementName(): lowercase, strip
-- punctuation, collapse whitespace, drop a trailing pack size.
UPDATE supplements
   SET name_key = trim(regexp_replace(
         regexp_replace(
           regexp_replace(lower(name), '[-–(]?\s*\d+\s*(ct|count|caps?|capsules?|tabs?|tablets?|softgels?|servings?|oz|ml|g|mg|mcg|iu)\.?\s*\)?\s*$', '', 'g'),
           '[^a-z0-9]+', ' ', 'g'),
         '\s+', ' ', 'g'))
 WHERE name_key IS NULL;

-- Collapse duplicates the normalization reveals: keep the newest row per
-- (client, name_key) and delete the rest. "Newest" is start_date first (the
-- freshest prescription wins), then created_at.
WITH ranked AS (
  SELECT id,
         row_number() OVER (
           PARTITION BY client_id, name_key
           ORDER BY start_date DESC NULLS LAST, created_at DESC
         ) AS rn
    FROM supplements
   WHERE name_key IS NOT NULL AND name_key <> ''
)
DELETE FROM supplements s USING ranked r
 WHERE s.id = r.id AND r.rn > 1;

-- A blank key means the row has no usable name; leave it addressable by id only.
UPDATE supplements SET name_key = lower(name) WHERE name_key IS NULL OR name_key = '';

ALTER TABLE supplements ALTER COLUMN name_key SET NOT NULL;

-- One current row per product per client — the invariant the code always assumed
-- and never enforced.
CREATE UNIQUE INDEX IF NOT EXISTS supplements_client_name_key_unique
  ON supplements(client_id, name_key);
