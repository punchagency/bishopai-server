-- A recording assigned to a client who had no booking at all.
--
-- Distinct from 'manual': manual means Nicole picked an EXISTING appointment
-- the correlator wasn't confident about, whereas walk_in means no appointment
-- existed and one was created from the recording itself. Worth telling apart
-- when auditing how a session ended up on a client's file.
ALTER TABLE conversations DROP CONSTRAINT IF EXISTS conversations_correlation_status_check;
ALTER TABLE conversations ADD CONSTRAINT conversations_correlation_status_check
  CHECK (correlation_status IN ('unmatched', 'matched', 'manual', 'walk_in'));
