import { type SessionNote, SessionNoteSchema } from './extract';

// Shared templating (build plan §7): the same SessionNote renders into an
// internal Appointment Sheet and a client-facing Protocol. Pure and
// deterministic — the Drive *write* is Zapier's connector step (§5.4–5.5).

export interface RenderContext {
  clientName: string;
  appointmentDate: string;
}

/** Coerce stored/edited content_json into a SessionNote, tolerating partial edits. */
export function coerceSessionNote(raw: unknown): SessionNote {
  const parsed = SessionNoteSchema.safeParse(raw);
  if (parsed.success) return parsed.data;
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const arr = <T>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : []);
  return {
    concerns: arr<string>(r.concerns),
    assessments: arr<string>(r.assessments),
    protocol_changes: arr<SessionNote['protocol_changes'][number]>(r.protocol_changes),
    supplements: arr<SessionNote['supplements'][number]>(r.supplements),
    follow_ups: arr<string>(r.follow_ups),
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
    bullets(note.follow_ups),
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
    bullets(note.follow_ups),
    '',
  ].join('\n');
}
