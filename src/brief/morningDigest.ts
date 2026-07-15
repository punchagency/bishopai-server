import { pool } from '../db/pool';
import { sendEmail } from '../integrations/outlook';
import { logEvent } from '../observability/logger';
import { buildBrief, renderBriefText, type Brief } from './service';

// One email to Nicole each morning: every client she's seeing today, each with
// their prep brief. This goes to HER, never to a client — it is a summary of her
// own records, so no PHI leaves the practice.

export interface DigestResult {
  appointments: number;
  sent: boolean;
  skipped?: 'no-appointments' | 'no-recipient';
}

/** Today's non-cancelled appointments, in the order she'll see them. */
async function todaysAppointments(now: Date): Promise<string[]> {
  const day = now.toISOString().slice(0, 10);
  const r = await pool.query<{ id: string }>(
    `SELECT id FROM appointments
      WHERE starts_at >= $1::date
        AND starts_at <  $1::date + interval '1 day'
        AND status <> 'cancelled'
        AND client_id IS NOT NULL
      ORDER BY starts_at ASC`,
    [day],
  );
  return r.rows.map((x) => x.id);
}

export async function runMorningDigest(now: Date = new Date()): Promise<DigestResult> {
  const ids = await todaysAppointments(now);
  if (ids.length === 0) {
    logEvent('info', 'brief.digest', 'no appointments today; nothing to send', {});
    return { appointments: 0, sent: false, skipped: 'no-appointments' };
  }

  // Her own address. Without it there is nobody to send to — we do not fall back
  // to guessing a recipient.
  const to = process.env.PRACTITIONER_EMAIL?.trim();
  if (!to) {
    logEvent('warn', 'brief.digest', 'PRACTITIONER_EMAIL not set; digest not sent', {
      appointments: ids.length,
    });
    return { appointments: ids.length, sent: false, skipped: 'no-recipient' };
  }

  const briefs: Brief[] = [];
  for (const id of ids) {
    const b = await buildBrief(id);
    if (b) briefs.push(b);
  }

  const day = now.toISOString().slice(0, 10);
  const body = [
    `Your day — ${day}`,
    `${briefs.length} client${briefs.length === 1 ? '' : 's'}.`,
    '',
    briefs.map(renderBriefText).join('\n\n---\n\n'),
    '',
    'Drafts, not records — everything here comes from your own approved notes.',
  ].join('\n');

  await sendEmail({ to, subject: `Your day — ${day} (${briefs.length} clients)`, body });
  logEvent('info', 'brief.digest', 'morning digest sent', { appointments: briefs.length, to });
  return { appointments: briefs.length, sent: true };
}
