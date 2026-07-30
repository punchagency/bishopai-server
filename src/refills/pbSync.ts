import { getDatabase } from '../db/index.js';
import { logEvent, logError } from '../observability/logger';
import { isPbConfigured } from '../integrations/pb/config';
import { listProtocols } from '../integrations/pb/reads';

// WF4 — PB protocol sync. Pulls protocols from the PB REST API and upserts
// supplement rows so the nightly refill projection has fresh data to work from.
// Dry-run (no-op + log) until PB_CLIENT_ID/PB_CLIENT_SECRET are set — same
// pattern as every other integration gate in this codebase.
//
// The protocol schema carries `supplementRecommendations[]` (name + dosages), so
// real supplement seeding is possible — but confirm the LIST endpoint returns
// them (vs. only the single-protocol detail GET) and the opaque `supplement`
// object's name field against live data before wiring per-line upserts. For now
// we sync the protocol metadata by client.

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

  // For each protocol, find the matching client by the PB record id embedded in
  // the protocol's clientRecord (confirmed shape).
  const db = getDatabase();
  // One pass over the clients builds the pb_id → id map, replacing a lookup
  // query per protocol.
  const byPbId = new Map<string, string>();
  for (const c of await db.clients.listAll()) {
    if (c.pb_id) byPbId.set(String(c.pb_id), c.id);
  }

  let upserted = 0;
  for (const proto of protocols) {
    try {
      const pbClientId = proto.clientRecord?.id;
      if (!pbClientId) continue;
      const clientId = byPbId.get(String(pbClientId));
      if (!clientId) continue;

      // Keyed on the PB protocol id, in its own collection.
      //
      // The pg version inserted into `protocols` with a NULL appointment_id and
      // `ON CONFLICT DO NOTHING` — but the unique index on appointment_id is
      // partial (`WHERE appointment_id IS NOT NULL`), so nothing ever conflicted
      // and every nightly run appended another copy of every protocol. It also
      // put appointment-less rows in a collection whose every other reader keys
      // on the appointment. Both are fixed by giving these their own home with a
      // real key.
      await db.sessionNotes.savePbProtocol({
        id: String(proto.id),
        client_id: clientId,
        pb_client_id: String(pbClientId),
        content_json: proto as unknown as Record<string, unknown>,
        synced_at: new Date().toISOString(),
      });
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
