-- Recordings come from Pocket now, not Bee.
--
-- `bee_id` was never a Bee fact so much as "the recorder's own id for this
-- recording, which we deduplicate on". Pocket has exactly the same concept
-- (`rec_abc123`), so the column keeps its job and loses the vendor name.
--
-- `source` names WHICH recorder produced the row. Existing rows are Bee by
-- definition — they predate this migration — so they are backfilled 'bee' and
-- only new rows take the 'pocket' default. Keeping the old ones distinguishable
-- matters because their ids live in a different namespace: nothing guarantees a
-- Bee conversation id and a Pocket recording id can't collide, and a transcript
-- silently overwritten by an unrelated recording is a clinical-data loss.
--
-- (Note the deliberate difference from `supplements.source`, which is
-- provenance — how a row entered the plan. Here it is the device.)
ALTER TABLE conversations RENAME COLUMN bee_id TO source_id;

ALTER TABLE conversations ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'pocket'
  CHECK (source IN ('bee', 'pocket'));

UPDATE conversations SET source = 'bee';

-- Uniqueness now has to hold per source, not globally, or the two id namespaces
-- above can collide. Drop the column-level unique that came with 0001 and
-- replace it with the composite.
ALTER TABLE conversations DROP CONSTRAINT IF EXISTS conversations_bee_id_key;
CREATE UNIQUE INDEX IF NOT EXISTS conversations_source_id_unique
  ON conversations(source, source_id);
