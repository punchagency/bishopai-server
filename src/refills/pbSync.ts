import { pool } from '../db/pool';
import { logEvent, logError } from '../observability/logger';
import { isPbConfigured } from '../integrations/pb/config';
import { listProtocols } from '../integrations/pb/reads';

// WF4 — PB protocol sync. Pulls protocols from the PB REST API and upserts
// supplement rows so the nightly refill projection has fresh data to work from.
// Dry-run (no-op + log) until PB_CLIENT_ID/PB_CLIENT_SECRET are set — same
// pattern as every other integration gate in this codebase.
//
// PbProtocol doesn't expose supplement line-items in the list endpoint (the
// beta API is still expanding); for now we sync the protocol metadata and
// record the supplement names from the protocol name field as a best-effort
// seed. The full supplement detail will be wired once the beta confirms the
// shape of nested supplement data.

export interface SyncResult {
  dryRun?: boolean;
  protocols: number;
  upserted: number;
}

export async function syncProtocolsFromPb(): Promise<SyncResult> {
  if (!isPbConfigured()) {
    logEvent('info', 'pb.sync', '[dry-run] PB not configured — skipping protocol sync', {});
    return { dryRun: true, protocols: 0, upserted: 0 };
  }

  let protocols;
  try {
    const res = await listProtocols();
    protocols = res.items;
  } catch (err) {
    logError('pb.sync', 'failed to fetch protocols from PB', err);
    return { protocols: 0, upserted: 0 };
  }

  if (protocols.length === 0) return { protocols: 0, upserted: 0 };

  // For each protocol, find the matching client by pb_id embedded in the
  // protocol's clientRecord (shape TBD from live data — tolerant lookup).
  let upserted = 0;
  for (const proto of protocols) {
    try {
      const pbClientId = (proto as unknown as Record<string, unknown>).clientRecord
        ? ((proto as unknown as Record<string, unknown>).clientRecord as Record<string, unknown>)?.id
        : null;

      if (!pbClientId) continue;

      const clientRes = await pool.query<{ id: string }>(
        `SELECT id FROM clients WHERE pb_id = $1`,
        [String(pbClientId)],
      );
      if (clientRes.rowCount === 0) continue;
      const clientId = clientRes.rows[0].id;

      // Upsert the protocol row (by PB id) so the dashboard can reference it.
      await pool.query(
        `INSERT INTO protocols (client_id, content_json, status)
         VALUES ($1, $2, 'draft')
         ON CONFLICT DO NOTHING`,
        [clientId, JSON.stringify(proto)],
      );
      upserted++;
    } catch (err) {
      logError('pb.sync', 'protocol upsert failed', err, { protocol_id: proto.id });
    }
  }

  logEvent('info', 'pb.sync', 'PB protocol sync complete', {
    protocols: protocols.length,
    upserted,
  });
  return { protocols: protocols.length, upserted };
}
