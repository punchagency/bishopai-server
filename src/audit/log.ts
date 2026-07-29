import { getDatabase } from '../db/index.js';
import { logError } from '../observability/logger.js';
import type { AuditLog } from '../db/interfaces/types.js';

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

export async function recordAudit(entry: AuditEntry): Promise<void> {
  try {
    const id = `audit_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
    const logItem: AuditLog = {
      id,
      entity_type: entry.entityType,
      entity_id: entry.entityId,
      action: entry.action,
      actor: entry.actor ?? 'system',
      summary: entry.summary,
      metadata: entry.metadata ?? null,
      created_at: new Date().toISOString(),
    };
    await getDatabase().audit.log(logItem);
  } catch (err) {
    logError('audit', 'failed to write audit entry', err, {
      entity_type: entry.entityType,
      entity_id: entry.entityId,
      action: entry.action,
    });
  }
}

export async function auditForEntity(entityType: string, entityId: string, limit = 100): Promise<AuditRow[]> {
  const logs = await getDatabase().audit.listForEntity(entityType, entityId, limit);
  return logs as unknown as AuditRow[];
}

export async function recentActivity(limit = 100, entityType?: string): Promise<AuditRow[]> {
  const logs = await getDatabase().audit.listRecent(limit, entityType);
  return logs as unknown as AuditRow[];
}
