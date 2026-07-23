-- One conversation per appointment, enforced.
--
-- Nothing stopped two Bee recordings (a split recording, or a manual mismatch)
-- from pointing at the same appointment. Extraction upserts on appointment_id,
-- so the second recording's note silently REPLACED the first's — last-writer-
-- wins on clinical content, with no trace. The invariant the pipeline already
-- assumes ("one conversation ⇄ one appointment") now lives in the schema.
--
-- Existing duplicates: keep the earliest recording on the appointment and send
-- later ones back to unmatched for a human to place — never guess which one is
-- the real session.
UPDATE conversations c
   SET appointment_id = NULL,
       client_id = NULL,
       correlation_status = 'unmatched',
       extraction_status = 'pending'
 WHERE appointment_id IS NOT NULL
   AND EXISTS (
         SELECT 1 FROM conversations earlier
          WHERE earlier.appointment_id = c.appointment_id
            AND earlier.id <> c.id
            AND (earlier.created_at < c.created_at
                 OR (earlier.created_at = c.created_at AND earlier.id < c.id))
       );

CREATE UNIQUE INDEX IF NOT EXISTS conversations_appointment_unique
  ON conversations(appointment_id)
  WHERE appointment_id IS NOT NULL;
