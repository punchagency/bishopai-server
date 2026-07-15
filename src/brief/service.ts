import { pool } from '../db/pool';
import { coerceSessionNote } from '../session/render';
import { followUpTexts } from '../session/followups';
import type { SessionNote } from '../session/extract';
import type { TaskRow } from '../tasks/service';

// The pre-session prep brief: everything Nicole would otherwise have to reconstruct
// from memory in the ninety seconds before a client walks in. Read-only — it invents
// nothing and writes nothing, it only assembles what previous sessions already said.

/** NRT + lifestyle fields, with the labels Nicole uses out loud. */
const NRT_LABELS: Record<string, string> = {
  pulse0: 'Pulse 0',
  priority1: 'Priority #1',
  k27: 'K-27',
  stressors: 'Stressors',
  foundation: 'Foundation',
  body_scan: 'Body scan',
};
const LIFESTYLE_LABELS: Record<string, string> = {
  bm: 'Bowel movements',
  sleep: 'Sleep',
  water: 'Water',
  cycle: 'Cycle',
  exercise: 'Exercise',
  diet: 'Diet',
};

export interface BriefSupplement {
  name: string;
  dose: string | null;
  qty: number | null;
  /** Projected run-out, from the refill projection. Null when it can't be projected. */
  due_date: string | null;
  /** True once the client was actually invited to reorder — an adherence signal. */
  ordered: boolean;
}

export interface Brief {
  client_id: string;
  client_name: string;
  appointment_id: string;
  starts_at: string;
  /** 1 = intake. Counts completed prior visits, so it reads "visit 4". */
  visit_number: number;
  last_session: {
    date: string;
    concerns: string[];
    assessments: string[];
    protocol_changes: string[];
    follow_ups: string[];
  } | null;
  /** Still-open commitments from any past session. Overdue ones sort first. */
  open_tasks: TaskRow[];
  supplements: BriefSupplement[];
  /**
   * What Nicole never got to last visit. This exists only because extraction refuses
   * to invent clinical values — an unstated field arrives null, so the gaps in the
   * record are trustworthy enough to hand back to her as a checklist.
   */
  not_covered_last_time: string[];
  /** Unpaid or failed checkout on a previous visit, if any. */
  outstanding_billing: { status: string; amount_cents: number; appointment_date: string } | null;
}

function gaps(note: SessionNote): string[] {
  const out: string[] = [];
  const nrt = (note.nrt ?? {}) as Record<string, string | null | undefined>;
  const ls = (note.lifestyle ?? {}) as Record<string, string | null | undefined>;
  for (const [key, label] of Object.entries(NRT_LABELS)) {
    if (!nrt[key]?.trim()) out.push(label);
  }
  for (const [key, label] of Object.entries(LIFESTYLE_LABELS)) {
    if (!ls[key]?.trim()) out.push(label);
  }
  return out;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Accepts a local appointment uuid OR a Practice Better session id. The Schedule
 * view lists PB-sourced sessions under their PB id, so requiring a uuid here would
 * mean no brief for exactly the appointments Nicole actually books in PB.
 */
export async function buildBrief(appointmentId: string): Promise<Brief | null> {
  const byUuid = UUID_RE.test(appointmentId);
  const appt = await pool.query<{
    id: string;
    client_id: string | null;
    client_name: string | null;
    starts_at: string;
  }>(
    `SELECT a.id, a.client_id, c.name AS client_name, a.starts_at
       FROM appointments a
       LEFT JOIN clients c ON c.id = a.client_id
      WHERE ${byUuid ? 'a.id = $1' : 'a.pb_id = $1'}`,
    [appointmentId],
  );
  const a = appt.rows[0];
  if (!a || !a.client_id) return null;

  // Prior visits — the most recent *approved* sheet is the one worth briefing from.
  // A draft hasn't been reviewed, so its contents aren't yet Nicole's word.
  const prior = await pool.query<{ starts_at: string; content_json: unknown }>(
    `SELECT a.starts_at, s.content_json
       FROM appointment_sheets s
       JOIN appointments a ON a.id = s.appointment_id
      WHERE s.client_id = $1 AND s.status = 'approved' AND a.starts_at < $2
      ORDER BY a.starts_at DESC
      LIMIT 1`,
    [a.client_id, a.starts_at],
  );

  const visits = await pool.query<{ n: number }>(
    `SELECT count(*)::int n FROM appointments
      WHERE client_id = $1 AND starts_at < $2 AND status <> 'cancelled'`,
    [a.client_id, a.starts_at],
  );

  const tasks = await pool.query<TaskRow>(
    `SELECT t.id, t.client_id, c.name AS client_name, t.appointment_id, t.title,
            t.due_date::text AS due_date, t.status, t.source, t.created_at, t.completed_at
       FROM tasks t
       LEFT JOIN clients c ON c.id = t.client_id
      WHERE t.client_id = $1 AND t.status = 'open'
      ORDER BY t.due_date ASC NULLS LAST, t.created_at ASC`,
    [a.client_id],
  );

  const supps = await pool.query<BriefSupplement>(
    `SELECT s.name, s.dose, s.qty,
            r.due_date::text AS due_date,
            EXISTS (SELECT 1 FROM refill_orders o WHERE o.refill_id = r.id) AS ordered
       FROM supplements s
       LEFT JOIN refills r ON r.supplement_id = s.id
      WHERE s.client_id = $1
      ORDER BY r.due_date ASC NULLS LAST, s.name ASC`,
    [a.client_id],
  );

  // The amount lives in the frozen summary_snapshot, not a column. "Outstanding"
  // means money was never captured: once a charge succeeds the row moves through
  // CHARGED → DOCS_UPDATED → PB_MARKED → CLOSED, and none of those owe anything.
  const billing = await pool.query<{ status: string; amount_cents: number; appointment_date: string }>(
    `SELECT k.status,
            COALESCE((k.summary_snapshot ->> 'total_cents')::int, 0) AS amount_cents,
            a.starts_at::date::text AS appointment_date
       FROM checkout k
       JOIN appointments a ON a.id = k.appointment_id
      WHERE a.client_id = $1
        AND k.status NOT IN ('CHARGED', 'DOCS_UPDATED', 'PB_MARKED', 'CLOSED')
        AND a.starts_at < $2
      ORDER BY a.starts_at DESC
      LIMIT 1`,
    [a.client_id, a.starts_at],
  );

  const p = prior.rows[0];
  const priorNote = p ? coerceSessionNote(p.content_json) : null;

  return {
    client_id: a.client_id,
    client_name: a.client_name ?? 'Unknown client',
    appointment_id: a.id,
    starts_at: a.starts_at,
    visit_number: visits.rows[0].n + 1,
    last_session:
      p && priorNote
        ? {
            date: new Date(p.starts_at).toISOString().slice(0, 10),
            concerns: priorNote.concerns,
            assessments: priorNote.assessments,
            protocol_changes: priorNote.protocol_changes.map((c) => c.description),
            follow_ups: followUpTexts(priorNote.follow_ups),
          }
        : null,
    open_tasks: tasks.rows,
    supplements: supps.rows,
    not_covered_last_time: priorNote ? gaps(priorNote) : [],
    outstanding_billing: billing.rows[0] ?? null,
  };
}

/** Plain-text rendering, used by the morning digest email. */
export function renderBriefText(b: Brief): string {
  const time = new Date(b.starts_at).toISOString().slice(11, 16);
  const lines: string[] = [`${b.client_name} — ${time} (visit ${b.visit_number})`];

  const overdue = b.open_tasks.filter((t) => t.due_date && t.due_date < new Date().toISOString().slice(0, 10));
  if (b.open_tasks.length) {
    lines.push('', 'Open follow-ups:');
    for (const t of b.open_tasks) {
      const due = t.due_date ? ` (due ${t.due_date}${overdue.includes(t) ? ', OVERDUE' : ''})` : '';
      lines.push(`  - ${t.title}${due}`);
    }
  }

  if (b.last_session) {
    lines.push('', `Last session (${b.last_session.date}):`);
    if (b.last_session.concerns.length) lines.push(`  Concerns: ${b.last_session.concerns.join('; ')}`);
    if (b.last_session.assessments.length) lines.push(`  Assessment: ${b.last_session.assessments.join('; ')}`);
    if (b.last_session.protocol_changes.length)
      lines.push(`  Protocol: ${b.last_session.protocol_changes.join('; ')}`);
  }

  if (b.supplements.length) {
    lines.push('', 'Current plan:');
    for (const s of b.supplements) {
      const dose = s.dose ? ` ${s.dose}` : '';
      const due = s.due_date ? ` — runs out ${s.due_date}${s.ordered ? '' : ', not yet reordered'}` : '';
      lines.push(`  - ${s.name}${dose}${due}`);
    }
  }

  if (b.not_covered_last_time.length) {
    lines.push('', `Not covered last time: ${b.not_covered_last_time.join(', ')}`);
  }

  if (b.outstanding_billing) {
    lines.push(
      '',
      `Billing: ${b.outstanding_billing.status} from ${b.outstanding_billing.appointment_date} ` +
        `($${(b.outstanding_billing.amount_cents / 100).toFixed(2)})`,
    );
  }

  return lines.join('\n');
}
