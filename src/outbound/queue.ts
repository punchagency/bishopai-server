import { pool } from '../db/pool';
import { logEvent, logError } from '../observability/logger';
import { sendEmail } from '../integrations/outlook';
import { recordAudit } from '../audit/log';
import {
  normalizeQueueInput,
  type OutboundCategory,
  type OutboundList,
  type QueuedEmailInput,
} from './policy';

// The single place an automated client email can leave from.
//
// Every automated path now writes here and stops. `sendApproved` is the only
// automated caller of sendEmail() left in the codebase — enforced by a test —
// and it will not send anything a person has not approved.
//
// Two paths are deliberately exempt and do NOT come through here:
//   - the welcome to a brand-new enquiry, which is a reply to someone who just
//     made contact and is worth nothing an hour later;
//   - Nicole's own morning digest, which is not a client email at all.
// Both still land in email_send_log, so the history stays complete.

export interface QueueResult {
  queued: boolean;
  /** An identical live item already exists — the weekly assembly re-ran. */
  duplicate?: boolean;
  id?: string;
}

/**
 * Hold an email for approval. Never sends.
 *
 * Relies on the partial unique index over live rows (see migration 0030): a
 * re-assembly of the same due step conflicts and is dropped, while a rejected or
 * expired item leaves the index so the same nudge can legitimately be offered
 * again in a later cycle.
 */
export async function queueEmail(input: QueuedEmailInput, now: Date = new Date()): Promise<QueueResult> {
  const norm = normalizeQueueInput(input, now);
  try {
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO outbound_emails
         (list, category, lead_id, client_id, to_email, subject, body,
          send_after, expires_at, source_ref, dedupe_key)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       ON CONFLICT (dedupe_key) WHERE state IN ('pending','approved') DO NOTHING
       RETURNING id`,
      [
        norm.list,
        input.category,
        input.leadId ?? null,
        input.clientId ?? null,
        input.toEmail,
        input.subject,
        input.body,
        norm.sendAfter,
        norm.expiresAt,
        input.sourceRef,
        norm.dedupeKey,
      ],
    );
    if (rows.length === 0) return { queued: false, duplicate: true };
    logEvent('info', 'outbound.queue', 'email held for approval', {
      id: rows[0].id,
      list: norm.list,
      category: input.category,
      to: input.toEmail,
      source: input.sourceRef,
    });
    return { queued: true, id: rows[0].id };
  } catch (err) {
    logError('outbound.queue', 'failed to queue email', err, {
      to: input.toEmail,
      source: input.sourceRef,
    });
    return { queued: false };
  }
}

interface OutboundRow {
  id: string;
  list: OutboundList;
  category: OutboundCategory;
  lead_id: string | null;
  to_email: string;
  subject: string;
  body: string;
  source_ref: string;
  send_after: string;
  expires_at: string;
}

/**
 * Send everything approved and still in date. The ONLY automated send path.
 *
 * Runs daily rather than weekly on purpose: the batch is assembled weekly, but
 * an approval on Tuesday should go out on Tuesday instead of waiting for the
 * next assembly.
 */
export async function sendApproved(now: Date = new Date()): Promise<{ sent: number; failed: number }> {
  let sent = 0;
  let failed = 0;
  const { rows } = await pool.query<OutboundRow>(
    `SELECT id, list, category, lead_id, to_email, subject, body, source_ref, send_after, expires_at
       FROM outbound_emails
      WHERE state = 'approved' AND send_after <= $1 AND expires_at > $1
      ORDER BY send_after ASC
      LIMIT 200`,
    [now],
  );

  for (const row of rows) {
    let result: { ok: boolean; dryRun?: boolean; error?: string };
    try {
      result = await sendEmail({ to: row.to_email, subject: row.subject, body: row.body });
    } catch (err) {
      logError('outbound.send', 'sendEmail threw', err, { id: row.id });
      result = { ok: false, error: err instanceof Error ? err.message : 'send threw' };
    }

    // The send log is written for successes AND failures, exactly as the cadence
    // runner used to, so history does not change shape under the new gate.
    const [track, step] = trackStepFrom(row.source_ref);
    await pool
      .query(
        `INSERT INTO email_send_log (lead_id, track, step, to_email, subject, body, dry_run, ok, error)
              VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [row.lead_id, track, step, row.to_email, row.subject, row.body,
          result.dryRun ?? false, result.ok, result.error ?? null],
      )
      .catch((e) => logError('outbound.send_log', 'failed to write send log', e, { id: row.id }));

    if (!result.ok) {
      failed++;
      await pool.query(
        `UPDATE outbound_emails SET state = 'failed', error = $2 WHERE id = $1`,
        [row.id, result.error ?? 'send failed'],
      );
      continue;
    }

    sent++;
    await pool.query(
      `UPDATE outbound_emails SET state = 'sent', sent_at = now() WHERE id = $1`,
      [row.id],
    );
    if (row.lead_id) await recordLeadSend(row.lead_id, step, row.subject, row.body);
  }

  if (sent || failed) logEvent('info', 'outbound.send', 'approved emails dispatched', { sent, failed });
  return { sent, failed };
}

/** 'cadence:<track>:<step>' → [track, step]; anything else keeps its prefix as the track. */
function trackStepFrom(sourceRef: string): [string, string] {
  const parts = sourceRef.split(':');
  if (parts[0] === 'cadence' && parts.length >= 3) return [parts[1], parts.slice(2).join(':')];
  return [parts[0], parts.slice(1).join(':') || parts[0]];
}

/**
 * Record the send against the lead — the bookkeeping that used to sit inline in
 * the cadence runner. The step moves from `queued` to `sent` here rather than at
 * approval time, because until it actually goes out the client has heard nothing.
 */
async function recordLeadSend(leadId: string, step: string, subject: string, body: string): Promise<void> {
  await pool
    .query(
      `INSERT INTO messages (lead_id, channel, body, sent_at, status)
            VALUES ($1, 'email', $2, now(), 'sent')`,
      [leadId, `${subject}\n\n${body}`],
    )
    .catch((e) => logError('outbound.messages', 'failed to record message', e, { lead_id: leadId }));

  await pool
    .query(
      `UPDATE leads
          SET sequence_state = jsonb_set(
                jsonb_set(
                  coalesce(sequence_state, '{}'::jsonb),
                  '{sent}',
                  coalesce(sequence_state->'sent', '[]'::jsonb) || to_jsonb($2::text)
                ),
                '{queued}',
                coalesce(
                  (SELECT jsonb_agg(q) FROM jsonb_array_elements_text(coalesce(sequence_state->'queued', '[]'::jsonb)) q
                    WHERE q <> $2),
                  '[]'::jsonb
                )
              ),
              last_touch = now(),
              status = CASE
                WHEN status = 'new' THEN 'contacted'
                WHEN status IN ('cancelled','maintenance','first_appointment') THEN status
                ELSE 'nurturing'
              END
        WHERE id = $1`,
      [leadId, step],
    )
    .catch((e) => logError('outbound.lead_state', 'failed to advance lead', e, { lead_id: leadId }));
}

/**
 * Drop what was never approved in time.
 *
 * The step stays consumed — it is already recorded in `sequence_state.queued` —
 * so the cadence moves on to the next step rather than re-offering this one
 * every week until someone finally clicks.
 */
export async function expireStale(now: Date = new Date()): Promise<number> {
  const { rowCount } = await pool.query(
    `UPDATE outbound_emails
        SET state = 'expired'
      WHERE state IN ('pending', 'approved') AND expires_at <= $1`,
    [now],
  );
  if (rowCount) logEvent('info', 'outbound.expire', 'unapproved emails expired', { count: rowCount });
  return rowCount ?? 0;
}

// --- Review API --------------------------------------------------------------

export async function listPending(list?: OutboundList): Promise<unknown[]> {
  const { rows } = await pool.query(
    `SELECT o.id, o.list, o.category, o.lead_id, o.client_id, o.to_email, o.subject, o.body,
            o.send_after, o.expires_at, o.source_ref, o.created_at,
            l.status AS lead_status
       FROM outbound_emails o
       LEFT JOIN leads l ON l.id = o.lead_id
      WHERE o.state = 'pending' ${list ? 'AND o.list = $1' : ''}
      ORDER BY o.send_after ASC, o.created_at ASC`,
    list ? [list] : [],
  );
  return rows;
}

/** Counts for the dashboard alert: how much is waiting, and how long it has waited. */
export async function pendingSummary(): Promise<{
  total: number;
  byList: Record<string, number>;
  byCategory: Record<string, number>;
  oldestSendAfter: string | null;
}> {
  const { rows } = await pool.query<{ list: string; category: string; n: string; oldest: string }>(
    `SELECT list, category, count(*)::text AS n, min(send_after)::text AS oldest
       FROM outbound_emails WHERE state = 'pending'
      GROUP BY list, category`,
  );
  const byList: Record<string, number> = {};
  const byCategory: Record<string, number> = {};
  let total = 0;
  let oldest: string | null = null;
  for (const r of rows) {
    const n = Number(r.n);
    total += n;
    byList[r.list] = (byList[r.list] ?? 0) + n;
    byCategory[r.category] = (byCategory[r.category] ?? 0) + n;
    if (r.oldest && (!oldest || r.oldest < oldest)) oldest = r.oldest;
  }
  return { total, byList, byCategory, oldestSendAfter: oldest };
}

export async function approve(ids: string[], by: string): Promise<number> {
  if (!ids.length) return 0;
  const { rowCount } = await pool.query(
    `UPDATE outbound_emails
        SET state = 'approved', approved_by = $2, approved_at = now()
      WHERE id = ANY($1::uuid[]) AND state = 'pending'`,
    [ids, by],
  );
  await recordAudit({
    entityType: 'outbound_email',
    entityId: ids.join(','),
    action: 'approved',
    summary: `Approved ${rowCount ?? 0} email(s) for sending`,
    actor: 'nicole',
    metadata: { count: rowCount ?? 0, approved_by: by, ids },
  }).catch(() => {});
  logEvent('info', 'outbound.approve', 'emails approved for sending', { count: rowCount ?? 0, by });
  return rowCount ?? 0;
}

export async function reject(ids: string[], by: string, reason?: string): Promise<number> {
  if (!ids.length) return 0;
  const { rowCount } = await pool.query(
    `UPDATE outbound_emails
        SET state = 'rejected', rejected_reason = $3, approved_by = $2, approved_at = now()
      WHERE id = ANY($1::uuid[]) AND state = 'pending'`,
    [ids, by, reason ?? null],
  );
  await recordAudit({
    entityType: 'outbound_email',
    entityId: ids.join(','),
    action: 'rejected',
    summary: `Rejected ${rowCount ?? 0} email(s)${reason ? `: ${reason}` : ''}`,
    actor: 'nicole',
    metadata: { count: rowCount ?? 0, reason: reason ?? null, rejected_by: by, ids },
  }).catch(() => {});
  return rowCount ?? 0;
}

/** Edit before approving. Leaves the item pending — editing is not approving. */
export async function updatePending(id: string, subject: string, body: string): Promise<boolean> {
  const { rowCount } = await pool.query(
    `UPDATE outbound_emails SET subject = $2, body = $3 WHERE id = $1 AND state = 'pending'`,
    [id, subject, body],
  );
  return (rowCount ?? 0) > 0;
}
