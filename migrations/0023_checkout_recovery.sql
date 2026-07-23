-- WF2 checkout crash-recovery + double-charge hardening (see
-- CODE-REVIEW-FINDINGS-CHECKOUT.md M1, M4, M5).

-- CHARGE_REVIEW: a charge whose outcome is UNKNOWN — the process died mid-flight
-- (M1), or the provider returned an ambiguous error after possibly capturing
-- (M3). Money MAY have moved, so it's never auto-retried; a human verifies in
-- QuickBooks. Distinct from CHARGE_FAILED (definitely no money moved, retryable).
ALTER TABLE checkout DROP CONSTRAINT IF EXISTS checkout_status_check;
ALTER TABLE checkout ADD CONSTRAINT checkout_status_check
  CHECK (status IN (
    'DETECTED', 'SUMMARY_READY', 'AWAITING_APPROVAL', 'CHARGING',
    'CHARGED', 'DOCS_UPDATED', 'PB_MARKED', 'CLOSED',
    'CHARGE_FAILED', 'CHARGE_REVIEW'
  ));

-- Per-attempt charge idempotency (M4): a retry after a decline must be a NEW
-- charge (new key), not a replay of the decline. The key becomes
-- `checkout:{id}:charge:{charge_attempts}`.
ALTER TABLE checkout ADD COLUMN IF NOT EXISTS charge_attempts integer NOT NULL DEFAULT 0;

-- One checkout per appointment (M5). Detection was keyed on pb_appointment_id,
-- so an appointment with a NULL pb_id could spawn two checkouts → two charges for
-- one session. appointment_id is the real unit and is never null for a real
-- appointment. (No dedup step: detection has always been idempotent for the
-- non-null-pb case, which is every real appointment to date.)
CREATE UNIQUE INDEX IF NOT EXISTS checkout_appointment_unique
  ON checkout(appointment_id)
  WHERE appointment_id IS NOT NULL;
