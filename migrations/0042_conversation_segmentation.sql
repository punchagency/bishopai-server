-- Pre-stage the split for a multi-client recording.
--
-- When the ingest safety gate parks a recording as 'needs_review' — it holds
-- more than one client's consultation — nothing happens until Nicole opens it,
-- finds a buried "Split" button, and then waits 20-60s while the segmenter reads
-- an hour of transcript from scratch. The recording sits inert for days, and the
-- LLM re-runs every time the modal is reopened.
--
-- These columns let the segmenter run once, automatically, off the request path,
-- the moment the hold is set. The proposed cut and the client for each segment
-- are stored in `proposed_segments`, so the review row can say "2 sessions
-- detected — confirm" and the splitter opens pre-filled and instant. The final
-- "file these" click stays Nicole's — that is the irreversible step.
--
-- Modelled on the extraction queue (0026): the conversations row IS the queue —
-- a status, an attempt counter, a backoff clock, a lease, an error column — and
-- session/segmentationQueue.ts is the drain.

ALTER TABLE conversations
  ADD COLUMN segmentation_status text
    CHECK (segmentation_status IN ('pending', 'processing', 'done', 'failed')),
  ADD COLUMN proposed_segments jsonb,
  ADD COLUMN segmentation_attempts int NOT NULL DEFAULT 0,
  ADD COLUMN segmentation_next_attempt_at timestamptz,
  ADD COLUMN segmentation_leased_at timestamptz,
  ADD COLUMN segmentation_error text;

-- Queue the recordings that are already held. `needs_review` with no appointment
-- and a transcript is exactly the shape the ingest gate produces for a
-- multi-client recording; the drain picks these up on its next pass.
UPDATE conversations
   SET segmentation_status = 'pending', updated_at = now()
 WHERE correlation_status = 'needs_review'
   AND appointment_id IS NULL
   AND transcript IS NOT NULL;
