import { pool } from '../db/pool';

// WF1 consent capture (passive session recording was flagged as an open
// compliance risk with no process). This is the record + check surface: grant or
// revoke a typed consent per client, and a `hasConsent` gate the capture path
// can enforce (opt-in via REQUIRE_RECORDING_CONSENT so the offline demo is
// unaffected by default).

export const RECORDING_CONSENT = 'recording';

export interface ConsentRow {
  type: string;
  granted: boolean;
  granted_at: string | null;
  notes: string | null;
}

/** Grant or revoke a consent for a client (idempotent upsert per type). */
export async function recordConsent(
  clientId: string,
  type: string,
  granted: boolean,
  notes?: string | null,
): Promise<ConsentRow> {
  const r = await pool.query<{ type: string; granted_at: string | null; notes: string | null }>(
    `INSERT INTO consents (client_id, type, granted_at, notes)
          VALUES ($1, $2, CASE WHEN $3 THEN now() ELSE NULL END, $4)
     ON CONFLICT (client_id, type)
       DO UPDATE SET granted_at = CASE WHEN $3 THEN now() ELSE NULL END, notes = EXCLUDED.notes
       RETURNING type, granted_at, notes`,
    [clientId, type, granted, notes ?? null],
  );
  const row = r.rows[0];
  return { type: row.type, granted: row.granted_at != null, granted_at: row.granted_at, notes: row.notes };
}

export async function listConsents(clientId: string): Promise<ConsentRow[]> {
  const r = await pool.query<{ type: string; granted_at: string | null; notes: string | null }>(
    `SELECT type, granted_at, notes FROM consents WHERE client_id = $1 ORDER BY type`,
    [clientId],
  );
  return r.rows.map((row) => ({ type: row.type, granted: row.granted_at != null, granted_at: row.granted_at, notes: row.notes }));
}

/** True when the client has an active grant for `type`. */
export async function hasConsent(clientId: string, type = RECORDING_CONSENT): Promise<boolean> {
  const r = await pool.query<{ ok: boolean }>(
    `SELECT (granted_at IS NOT NULL) AS ok FROM consents WHERE client_id = $1 AND type = $2`,
    [clientId, type],
  );
  return r.rows[0]?.ok ?? false;
}

/** Whether the capture path must enforce recording consent (opt-in). */
export function recordingConsentRequired(): boolean {
  return process.env.REQUIRE_RECORDING_CONSENT === 'true';
}
