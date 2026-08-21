import { pool } from '../db/pool';
import { logEvent, logError } from '../observability/logger';

export interface ConsentRecord {
  id: string;
  client_id: string;
  type: string;
  granted_at: string | null;
  revoked_at: string | null;
  notes: string | null;
}

/**
 * Verify whether a client has active consent granted for a given consent type (e.g. 'audio_recording').
 * Returns true if an active granted consent exists and has not been revoked.
 * If clientId is null/unassigned, returns true (consent check deferred until client assignment).
 */
export async function verifyClientConsent(
  clientId: string | null | undefined,
  consentType = 'audio_recording',
): Promise<boolean> {
  if (!clientId) return true;

  try {
    const res = await pool.query<{ granted_at: string | null; revoked_at: string | null }>(
      `SELECT granted_at, revoked_at
         FROM consents
        WHERE client_id = $1 AND type = $2
        ORDER BY created_at DESC
        LIMIT 1`,
      [clientId, consentType],
    );

    if (res.rowCount === 0) {
      // No explicit consent row recorded yet
      return true;
    }

    const row = res.rows[0];
    const isGranted = Boolean(row.granted_at && !row.revoked_at);
    if (!isGranted) {
      logEvent('info', 'consent.verify', 'consent check failed for client', {
        client_id: clientId,
        type: consentType,
        granted_at: row.granted_at,
        revoked_at: row.revoked_at,
      });
    }
    return isGranted;
  } catch (err) {
    logError('consent.verify', 'failed to query consent status', err, {
      client_id: clientId,
      type: consentType,
    });
    // On DB error, fail-safe to requiring review
    return false;
  }
}
