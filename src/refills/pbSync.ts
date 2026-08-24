import { pool } from '../db/pool';
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
  let upserted = 0;
  for (const proto of protocols) {
    try {
      const pbClientId = proto.clientRecord?.id;
      if (!pbClientId) continue;
      // No PB id means no identity to upsert on, and inserting with a NULL
      // pb_id would slip straight past the unique index and start accumulating
      // duplicates again — the exact bug this row is here to prevent. Skip it
      // and say so rather than storing something that cannot be reconciled.
      if (!proto.id) {
        logEvent('warn', 'pb.sync', 'protocol has no PB id — skipped', {
          pb_client_id: String(pbClientId),
        });
        continue;
      }

      const clientRes = await pool.query<{ id: string }>(
        `SELECT id FROM clients WHERE pb_id = $1`,
        [String(pbClientId)],
      );
      if (clientRes.rowCount === 0) continue;
      const clientId = clientRes.rows[0].id;

      // Upsert by PB id — which now actually happens.
      //
      // This used to be `ON CONFLICT DO NOTHING` with no conflict target, under
      // this same comment. It never once did nothing: the only unique index on
      // the table is on appointment_id, this insert leaves appointment_id NULL,
      // and every NULL is distinct in a unique index, so no constraint was ever
      // violated and each sync appended another copy. Production accumulated 17
      // copies of every protocol before anyone looked.
      //
      // Naming the conflict target is what makes it an upsert. The DO UPDATE
      // refreshes content so a protocol edited in PB is not frozen at whatever
      // it looked like the first time we saw it.
      //
      // The status guard matters: a draft that Nicole has since approved is a
      // document she signed off, and a background sync must not rewrite its
      // contents underneath her.
      await pool.query(
        `INSERT INTO protocols (client_id, pb_id, content_json, status)
         VALUES ($1, $2, $3, 'draft')
         ON CONFLICT (pb_id) WHERE pb_id IS NOT NULL
         DO UPDATE SET content_json = EXCLUDED.content_json,
                       updated_at = now()
               WHERE protocols.status = 'draft'`,
        [clientId, String(proto.id), JSON.stringify(proto)],
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
