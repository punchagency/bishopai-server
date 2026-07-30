import { getDatabase } from '../db/index.js';
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

/**
 * Was anything recorded for this field? Foundation and Body scan are whole
 * multi-prompt testing passes, so a pass counts as covered when ANY of its
 * prompts was called — the brief stays at the practitioner's granularity
 * ("Foundation") rather than listing twenty bare prompts every morning.
 */
function stated(v: unknown): boolean {
  if (typeof v === 'string') return v.trim().length > 0;
  if (v && typeof v === 'object') return Object.values(v).some(stated);
  return false;
}

export function gaps(note: SessionNote): string[] {
  const out: string[] = [];
  const nrt = (note.nrt ?? {}) as Record<string, unknown>;
  const ls = (note.lifestyle ?? {}) as Record<string, unknown>;
  for (const [key, label] of Object.entries(NRT_LABELS)) {
    if (!stated(nrt[key])) out.push(label);
  }
  for (const [key, label] of Object.entries(LIFESTYLE_LABELS)) {
    if (!stated(ls[key])) out.push(label);
  }
  return out;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Accepts a local appointment uuid OR a Practice Better session id. The Schedule
 * view lists PB-sourced sessions under their PB id, so requiring a uuid here would
 * mean no brief for exactly the appointments Nicole actually books in PB.
 */
/** Checkout states that still owe money — everything from CHARGED on does not. */
const SETTLED = new Set(['CHARGED', 'DOCS_UPDATED', 'PB_MARKED', 'CLOSED']);

export async function buildBrief(appointmentId: string): Promise<Brief | null> {
  const db = getDatabase();

  const a = UUID_RE.test(appointmentId)
    ? await db.appointments.findById(appointmentId)
    : await db.appointments.findByPbId(appointmentId);
  if (!a || !a.client_id) return null;
  const clientId = a.client_id;

  // Prior visits — the most recent *approved* sheet is the one worth briefing
  // from. A draft hasn't been reviewed, so its contents aren't yet Nicole's word.
  // The sheet carries a denormalized starts_at, so this is one indexed query
  // rather than the appointment join it replaces.
  const [prior, priorVisits, tasks, supplements, checkouts] = await Promise.all([
    db.sessionNotes.findPriorApproved('sheet', clientId, {
      excludeAppointmentId: a.id,
      before: a.starts_at,
    }),
    db.appointments.listByClient(clientId),
    db.tasks.listByClient(clientId),
    db.refills.listSupplementsByClient(clientId),
    db.checkouts.listByClient(clientId),
  ]);

  const openTasks: TaskRow[] = tasks
    .filter((t) => t.status === 'open')
    .map((t) => ({
      id: t.id,
      client_id: t.client_id,
      // Denormalized at write time, so the brief no longer loads every client
      // just to build a name map.
      client_name: t.client_name ?? null,
      appointment_id: t.appointment_id ?? null,
      title: t.title,
      due_date: t.due_date ?? null,
      status: t.status,
      source: t.source,
      created_at: t.created_at,
      completed_at: t.completed_at ?? null,
    }))
    // `ORDER BY due_date ASC NULLS LAST, created_at ASC`. Sorted here rather than
    // by query because a task with no due date is a legitimate, common value
    // (0015) and Firestore drops documents missing an ordered field entirely.
    .sort((x, y) => {
      if (x.due_date !== y.due_date) {
        if (!x.due_date) return 1;
        if (!y.due_date) return -1;
        return x.due_date.localeCompare(y.due_date);
      }
      return x.created_at.localeCompare(y.created_at);
    });

  // The refill for each supplement, and whether an invitation was actually sent.
  const refills = await Promise.all(
    supplements.map((s) => db.refills.findRefillBySupplement(s.id)),
  );
  const orderedRefillIds = new Set(
    (await db.refills.listOrdersForRefills(refills.filter(Boolean).map((r) => r!.id)))
      .map((o) => o.refill_id)
      .filter((id): id is string => !!id),
  );

  const briefSupplements: BriefSupplement[] = supplements
    .map((s, i) => ({
      name: s.name,
      dose: s.dose,
      qty: s.qty,
      due_date: refills[i]?.due_date ?? null,
      // True once the client was actually invited to reorder — an adherence signal.
      ordered: !!refills[i] && orderedRefillIds.has(refills[i]!.id),
    }))
    .sort((x, y) => {
      if (x.due_date !== y.due_date) {
        if (!x.due_date) return 1;
        if (!y.due_date) return -1;
        return x.due_date.localeCompare(y.due_date);
      }
      return x.name.localeCompare(y.name);
    });

  // The amount lives in the frozen summary_snapshot, not a column. "Outstanding"
  // means money was never captured: once a charge succeeds the row moves through
  // CHARGED → DOCS_UPDATED → PB_MARKED → CLOSED, and none of those owe anything.
  const priorById = new Map(priorVisits.map((v) => [v.id, v]));
  const outstanding = checkouts
    .filter((k) => !SETTLED.has(k.status))
    .map((k) => ({ checkout: k, appointment: k.appointment_id ? priorById.get(k.appointment_id) : null }))
    .filter((x) => !!x.appointment && x.appointment.starts_at < a.starts_at)
    .sort((x, y) => y.appointment!.starts_at.localeCompare(x.appointment!.starts_at))[0];

  const priorNote = prior ? coerceSessionNote(prior.content_json) : null;

  return {
    client_id: clientId,
    client_name: a.client_name ?? 'Unknown client',
    appointment_id: a.id,
    starts_at: a.starts_at,
    visit_number:
      priorVisits.filter((v) => v.starts_at < a.starts_at && v.status !== 'cancelled').length + 1,
    last_session:
      prior && priorNote
        ? {
            date: new Date(prior.starts_at ?? a.starts_at).toISOString().slice(0, 10),
            concerns: priorNote.concerns,
            assessments: priorNote.assessments,
            protocol_changes: priorNote.protocol_changes.map((c) => c.description),
            follow_ups: followUpTexts(priorNote.follow_ups),
          }
        : null,
    open_tasks: openTasks,
    supplements: briefSupplements,
    not_covered_last_time: priorNote ? gaps(priorNote) : [],
    outstanding_billing: outstanding
      ? {
          status: outstanding.checkout.status,
          amount_cents: Number(
            (outstanding.checkout.summary_snapshot as Record<string, unknown> | null)?.total_cents ?? 0,
          ),
          appointment_date: outstanding.appointment!.starts_at.slice(0, 10),
        }
      : null,
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
