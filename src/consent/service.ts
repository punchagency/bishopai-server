import { getDatabase } from '../db/index.js';
import { consentDocId } from '../db/ids.js';

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
const toRow = (c: { type: string; granted_at: string | null; notes?: string | null }): ConsentRow => ({
  type: c.type,
  // The timestamp IS the grant — a revoked consent keeps its row with a null
  // granted_at, so the record distinguishes "withdrawn" from "never asked".
  granted: c.granted_at != null,
  granted_at: c.granted_at,
  notes: c.notes ?? null,
});

export async function recordConsent(
  clientId: string,
  type: string,
  granted: boolean,
  notes?: string | null,
): Promise<ConsentRow> {
  const db = getDatabase();
  const id = consentDocId(clientId, type);
  const now = new Date().toISOString();
  // The document id carries `0012_consent_unique`, so this upsert needs no
  // ON CONFLICT clause and cannot race into two rows for one consent.
  const existing = await db.consents.findByClientAndType(clientId, type);
  const saved = await db.consents.save({
    id,
    client_id: clientId,
    type,
    granted_at: granted ? now : null,
    notes: notes ?? null,
    created_at: existing?.created_at ?? now,
  });
  return toRow(saved);
}

export async function listConsents(clientId: string): Promise<ConsentRow[]> {
  return (await getDatabase().consents.listByClient(clientId)).map(toRow);
}

/** True when the client has an active grant for `type`. */
export async function hasConsent(clientId: string, type = RECORDING_CONSENT): Promise<boolean> {
  const c = await getDatabase().consents.findByClientAndType(clientId, type);
  return c?.granted_at != null;
}

/** Whether the capture path must enforce recording consent (opt-in). */
export function recordingConsentRequired(): boolean {
  return process.env.REQUIRE_RECORDING_CONSENT === 'true';
}
