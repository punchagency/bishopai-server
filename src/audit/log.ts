import { getDatabase } from '../db/index.js';
import { logError } from '../observability/logger.js';

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
    await getDatabase().audit.log({
      id,
      event_type: `${entry.entityType}:${entry.action}`,
      payload: {
        entity_type: entry.entityType,
        entity_id: entry.entityId,
        action: entry.action,
        actor: entry.actor ?? 'system',
        summary: entry.summary,
        metadata: entry.metadata,
      },
      created_at: new Date().toISOString(),
    });
  } catch (err) {
    logError('audit', 'failed to write audit entry', err, {
      entity_type: entry.entityType,
      entity_id: entry.entityId,
      action: entry.action,
    });
  }
}

export async function auditForEntity(entityType: string, entityId: string, limit = 100): Promise<AuditRow[]> {
  const logs = await getDatabase().audit.listAll();
  const matched = logs
    .map((l) => (l.payload as unknown as AuditRow) || l)
    .filter((l) => l.entity_type === entityType && l.entity_id === entityId);
  matched.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
  return matched.slice(0, limit);
}

export async function recentActivity(limit = 100, entityType?: string): Promise<AuditRow[]> {
  const logs = await getDatabase().audit.listAll();
  const matched = logs
    .map((l) => (l.payload as unknown as AuditRow) || l)
    .filter((l) => !entityType || l.entity_type === entityType);
  matched.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
  return matched.slice(0, limit);
}
