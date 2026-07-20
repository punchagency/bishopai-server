-- An amendment to an approved note is audited through the same approvals trail
-- as the original sign-off, so the status vocabulary has to admit it.
-- Additive only: every existing value stays legal, so the checkout approvals
-- that share this table are unaffected.
ALTER TABLE approvals DROP CONSTRAINT IF EXISTS approvals_status_check;
ALTER TABLE approvals ADD CONSTRAINT approvals_status_check
  CHECK (status IN ('pending', 'approved', 'rejected', 'skipped', 'amended'));
