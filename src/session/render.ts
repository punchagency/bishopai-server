import { type SessionNote, SessionNoteSchema } from './extract';
import { followUpTexts } from './followups';

// Shared templating (build plan §7): the same SessionNote renders into an
// internal Appointment Sheet and a client-facing Protocol. Pure and
// deterministic — the Drive *write* is Zapier's connector step (§5.4–5.5).

export interface BillingBlock {
  status: string; // paid | dry-run | failed
  amount_cents: number;
  currency: string;
  qb_txn_id?: string | null;
  qb_invoice_id?: string | null;
  paid_at?: string | null;
  note?: string | null;
}

export interface RenderContext {
  clientName: string;
  appointmentDate: string;
  /** Checkout outcome, stamped onto the internal sheet after WF2 charge. */
  billing?: BillingBlock | null;
}

function renderBilling(b: BillingBlock): string {
  const amount = new Intl.NumberFormat('en-US', { style: 'currency', currency: b.currency || 'USD' }).format(
    b.amount_cents / 100,
  );
  const lines = [
    `- **Status:** ${b.status}`,
    `- **Amount:** ${amount}`,
    b.qb_txn_id ? `- **Payment ref:** ${b.qb_txn_id}` : null,
    b.qb_invoice_id ? `- **Invoice:** ${b.qb_invoice_id}` : null,
    b.paid_at ? `- **Recorded:** ${b.paid_at.slice(0, 10)}` : null,
    b.note ? `- **Note:** ${b.note}` : null,
  ].filter(Boolean);
  return lines.join('\n');
}

/** Coerce stored/edited content_json into a SessionNote, tolerating partial edits. */
export function coerceSessionNote(raw: unknown): SessionNote {
  const parsed = SessionNoteSchema.safeParse(raw);
  if (parsed.success) return parsed.data;
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const arr = <T>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : []);
  return {
    concerns: arr<string>(r.concerns),
    goals: arr<string>(r.goals),
    assessments: arr<string>(r.assessments),
    protocol_changes: arr<SessionNote['protocol_changes'][number]>(r.protocol_changes),
    supplements: arr<SessionNote['supplements'][number]>(r.supplements),
    follow_ups: arr<SessionNote['follow_ups'][number]>(r.follow_ups),
  };
}

function bullets(items: string[]): string {
  return items.length ? items.map((i) => `- ${i}`).join('\n') : '_None noted._';
}

/** Internal clinical record — includes concerns + assessments. */
export function renderAppointmentSheet(note: SessionNote, ctx: RenderContext): string {
  const changes = note.protocol_changes.length
    ? note.protocol_changes.map((c) => `- **[${c.type}]** ${c.description}`).join('\n')
    : '_None noted._';

  const supplements = note.supplements.length
    ? [
        '| Supplement | Dose | Qty | Change |',
        '|---|---|---|---|',
        ...note.supplements.map(
          (s) => `| ${s.name} | ${s.dose ?? '—'} | ${s.quantity ?? '—'} | ${s.change} |`,
        ),
      ].join('\n')
    : '_None noted._';

  return [
    `# Appointment Sheet — ${ctx.clientName}`,
    `**Date:** ${ctx.appointmentDate}`,
    '',
    '## Concerns',
    bullets(note.concerns),
    '',
    '## Assessments',
    bullets(note.assessments),
    '',
    '## Protocol Changes',
    changes,
    '',
    '## Supplements',
    supplements,
    '',
    '## Follow-ups',
    bullets(followUpTexts(note.follow_ups)),
    '',
    '## Billing',
    ctx.billing ? renderBilling(ctx.billing) : '_Not checked out._',
    '',
  ].join('\n');
}

/** Client-facing plan — supplements + plan changes + next steps (no internal assessments). */
export function renderProtocol(note: SessionNote, ctx: RenderContext): string {
  const supplements = note.supplements.length
    ? note.supplements
        .map((s) => {
          const dose = s.dose ? ` — ${s.dose}` : '';
          const qty = s.quantity != null ? ` (qty ${s.quantity})` : '';
          return `- **${s.name}**${dose}${qty} — _${s.change}_`;
        })
        .join('\n')
    : '_No supplement changes._';

  const changes = note.protocol_changes.length
    ? note.protocol_changes.map((c) => `- ${c.description}`).join('\n')
    : '_No changes._';

  return [
    `# Your Protocol — ${ctx.clientName}`,
    `**Date:** ${ctx.appointmentDate}`,
    '',
    'Here is your updated plan from our session.',
    '',
    '## Supplements',
    supplements,
    '',
    '## Plan Changes',
    changes,
    '',
    '## Next Steps',
    bullets(followUpTexts(note.follow_ups)),
    '',
  ].join('\n');
}
