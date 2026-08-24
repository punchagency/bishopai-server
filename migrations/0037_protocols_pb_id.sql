-- Give a Practice Better protocol a real identity, and collapse the duplicates
-- created while it had none.
--
-- refills/pbSync.ts inserted with `ON CONFLICT DO NOTHING` under a comment that
-- said "upsert by PB id". Nothing made that true. The only unique index on this
-- table is on appointment_id, that insert leaves appointment_id NULL, and in
-- Postgres every NULL is distinct in a unique index — so no constraint was ever
-- violated, DO NOTHING never fired, and every sync run appended a fresh copy.
-- Production reached 17 copies of each protocol, 1,420 rows over 110 clients,
-- growing on every run since 2026-08-07.
--
-- The PB id lives in content_json->>'id'. Promote it to a column so it can carry
-- a unique index and a genuine upsert.
ALTER TABLE protocols ADD COLUMN IF NOT EXISTS pb_id text;

-- Collapse duplicates FIRST, keyed off content_json->>'id' rather than the new
-- column.
--
-- Order is deliberate. Deduping via pb_id would make this step depend on the
-- backfill having succeeded, and the backfill cannot succeed once the unique
-- index exists — so a re-run, or a partially applied migration, would leave the
-- duplicates in place and report success. Reading the id straight from the JSON
-- makes each step independent and the whole file safe to run twice.
--
-- Scoped hard to unlinked drafts. Anything carrying an appointment_id belongs to
-- a real session, and anything approved is a document Nicole has signed off —
-- neither is a sync artifact and neither may be deleted by a cleanup.
DELETE FROM protocols p
 WHERE p.appointment_id IS NULL
   AND p.status = 'draft'
   AND nullif(p.content_json->>'id', '') IS NOT NULL
   AND p.id <> (
     SELECT q.id
       FROM protocols q
      WHERE q.content_json->>'id' = p.content_json->>'id'
        AND q.appointment_id IS NULL
        AND q.status = 'draft'
      ORDER BY q.created_at DESC, q.id DESC
      LIMIT 1
   );

-- Backfill ONLY the rows pbSync created. A protocol built from a session note
-- (session/process.ts) is keyed by its appointment and its content_json is the
-- note, not a PB record — giving those a pb_id would be inventing an identity
-- they do not have.
UPDATE protocols
   SET pb_id = content_json->>'id'
 WHERE appointment_id IS NULL
   AND pb_id IS NULL
   AND nullif(content_json->>'id', '') IS NOT NULL;

-- Partial, because every session-note protocol has a NULL pb_id and they must
-- not collide with each other.
CREATE UNIQUE INDEX IF NOT EXISTS protocols_pb_id_key
  ON protocols (pb_id) WHERE pb_id IS NOT NULL;
