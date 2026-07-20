-- Where the client actually gets the supplement — the "Here | Fullscript" column
-- of Nicole's Supplement Protocol.
--
-- Distinct from `source`, which is PROVENANCE: how the row got into our plan
-- (notes | fullscript | pb). Rendering provenance into that column printed the
-- word "notes" on a client-facing document. They are different facts and need
-- different fields.
--
-- Null means undecided, which is correct until Nicole says — never guessed.
ALTER TABLE supplements ADD COLUMN IF NOT EXISTS obtained_from text;
