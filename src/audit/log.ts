import { pool } from '../db/pool';
import { logError } from '../observability/logger';

// The one write path for the unified audit trail. Every significant mutation
// records here so the activity feed and per-entity history are complete.
//
// Best-effort and NEVER throws: an audit failure must not break the action it
// describes. It runs on the pool (its own connection) AFTER the action's own
// transaction has committed, so it can never poison the caller's transaction —
// the cost is a tiny window where a crash between commit and audit loses one
// row, which is acceptable for an activity log (the money/clinical audits —
// approvals, note_revisions, payment_reconciliation — remain the strong record).

export type AuditEntity =
  | 'checkout'
  | 'session'
  | 'conversation'
  | 'client'
  | 'task'
  | 'refill'
  | 'lead'
  | 'office_hours'
  | 'customer_map'
  | 'outlook';

export type Actor = 'nicole' | 'system';

export interface AuditEntry {
  entityType: AuditEntity;
  entityId: string;
  action: string;
  summary: string;
  actor?: Actor;
  metadata?: Record<string, unknown>;
}

export async function recordAudit(entry: AuditEntry): Promise<void> {
  try {
    await pool.query(
      `INSERT INTO audit_log (entity_type, entity_id, action, actor, summary, metadata)
            VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        entry.entityType,
        entry.entityId,
        entry.action,
        entry.actor ?? 'system',
        entry.summary,
        entry.metadata ? JSON.stringify(entry.metadata) : null,
      ],
    );
  } catch (err) {
    logError('audit', 'failed to write audit entry', err, {
      entity_type: entry.entityType,
      entity_id: entry.entityId,
      action: entry.action,
    });
  }
}

export interface AuditRow {
  id: string;
  entity_type: string;
  entity_id: string;
  action: string;
  actor: string;
  summary: string;
  metadata: Record<string, unknown> | null;
  created_at: string;
}

/** One entity's trail, newest first. */
export async function auditForEntity(entityType: string, entityId: string, limit = 100): Promise<AuditRow[]> {
  const r = await pool.query<AuditRow>(
    `SELECT id, entity_type, entity_id, action, actor, summary, metadata, created_at
       FROM audit_log
      WHERE entity_type = $1 AND entity_id = $2
   ORDER BY created_at DESC
      LIMIT $3`,
    [entityType, entityId, limit],
  );
  return r.rows;
}

/** The global activity feed, newest first. Optionally filter by entity type. */
export async function recentActivity(limit = 100, entityType?: string): Promise<AuditRow[]> {
  const r = await pool.query<AuditRow>(
    `SELECT id, entity_type, entity_id, action, actor, summary, metadata, created_at
       FROM audit_log
      WHERE ($2::text IS NULL OR entity_type = $2)
   ORDER BY created_at DESC
      LIMIT $1`,
    [limit, entityType ?? null],
  );
  return r.rows;
}
