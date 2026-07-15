import { pool } from '../db/pool';
import { logEvent, logError } from '../observability/logger';
import { isPbConfigured } from '../integrations/pb/config';
import { listSessions, getClientRecord } from '../integrations/pb/reads';
import { clientRecordName } from '../integrations/pb/types';
import type { PbSession } from '../integrations/pb/types';
import { detectCheckout } from '../checkout/machine';
import { enrollCancelledAppointment } from '../reengagement/cancellations';

// PB sessions poll — the localhost-safe substitute for PB's session/booking
// webhooks (`/webhooks/pb/session`, `/webhooks/pb/booking`), which PB can only
// deliver to a publicly reachable URL. Until the backend is deployed publicly,
// this is the only way session state (new bookings, cancellations, completions)
// reaches the local `clients`/`appointments` tables — Schedule's own PB fetch
// is live/read-only and never writes back.
//
// Upsert shape mirrors `POST /webhooks/pb/booking` exactly, so whichever path
// lands a row first, the other is a no-op update. Side effects (checkout
// detection, cancelled-cadence enrollment) are re-derived here the same way
// the `/webhooks/pb/session` handler does, gated on the status actually
// having changed so a re-poll never re-fires them.
//
// "Completed" has no dedicated PB session field (only `cancelled` does), so we
// treat "confirmed session whose end time has passed" as completed — a time
// heuristic, not a confirmed PB signal. `detectCheckout` is idempotent on
// pb_appointment_id, so firing it speculatively every tick is safe.
//
// A session's embedded clientRecord carries only id/name, not email — so a
// client first seen through this poller (never booked through our own widget)
// has no email until something fetches it. We only pay for that extra PB call
// (GET /consultant/records/:id) right when a cancellation would otherwise
// silently skip re-engagement for lack of one — see backfillClientEmail.

const WINDOW_DAYS_BACK = 1; // catch same-day completions
const WINDOW_DAYS_FWD = 30;
const PAGE_SIZE = 100;
const MAX_PAGES = 5;

function statusFor(s: PbSession, now: Date): 'cancelled' | 'completed' | 'confirmed' {
  if (s.cancelled || (s.confirmationStatus && /cancel|declin|no.?show/i.test(s.confirmationStatus))) {
    return 'cancelled';
  }
  const end = s.endDate ?? (s.sessionDate ? addMinutes(s.sessionDate, s.duration ?? 60) : undefined);
  if (end && new Date(end) < now) return 'completed';
  return 'confirmed';
}

function addMinutes(iso: string, minutes: number): string {
  return new Date(new Date(iso).getTime() + minutes * 60_000).toISOString();
}

/**
 * Best-effort email backfill. The session/protocol embeds only carry
 * `id`/`name` — not email — so a client synced purely from this poller has no
 * email until something fetches the full record. Only worth the extra PB call
 * right when we'd otherwise silently skip re-engagement for lack of one.
 */
async function backfillClientEmail(clientId: string, pbClientId: string): Promise<void> {
  try {
    const record = await getClientRecord(pbClientId);
    const email = record.profile?.emailAddress?.trim();
    if (!email) return;
    await pool.query(`UPDATE clients SET email = $2 WHERE id = $1 AND email IS NULL`, [clientId, email]);
  } catch (err) {
    logError('pb.sessionsSync', 'client email backfill failed', err, { pb_client_id: pbClientId });
  }
}

async function fetchSessionsPaged(gte: Date, lte: Date): Promise<PbSession[]> {
  const all: PbSession[] = [];
  let beforeId: string | undefined;
  for (let page = 0; page < MAX_PAGES; page++) {
    const res = await listSessions({
      date_gte: gte.toISOString(),
      date_lte: lte.toISOString(),
      limit: String(PAGE_SIZE),
      ...(beforeId ? { before_id: beforeId } : {}),
    });
    const batch = res.items ?? [];
    all.push(...batch);
    if (batch.length < PAGE_SIZE) break;
    beforeId = batch[batch.length - 1]?.id;
    if (!beforeId) break;
  }
  return all;
}

export interface SessionsSyncResult {
  dryRun?: boolean;
  fetched: number;
  upserted: number;
  checkoutsDetected: number;
  cancellationsEnrolled: number;
}

export async function syncSessionsFromPb(now: Date = new Date()): Promise<SessionsSyncResult> {
  if (!isPbConfigured()) {
    logEvent('info', 'pb.sessionsSync', '[dry-run] PB not configured — skipping sessions poll', {});
    return { dryRun: true, fetched: 0, upserted: 0, checkoutsDetected: 0, cancellationsEnrolled: 0 };
  }

  const gte = new Date(now.getTime() - WINDOW_DAYS_BACK * 86_400_000);
  const lte = new Date(now.getTime() + WINDOW_DAYS_FWD * 86_400_000);

  let items: PbSession[];
  try {
    items = await fetchSessionsPaged(gte, lte);
  } catch (err) {
    logError('pb.sessionsSync', 'failed to fetch sessions from PB', err);
    return { fetched: 0, upserted: 0, checkoutsDetected: 0, cancellationsEnrolled: 0 };
  }

  let upserted = 0;
  let checkoutsDetected = 0;
  let cancellationsEnrolled = 0;

  for (const s of items) {
    const pbClientId = s.clientRecord?.id;
    if (!s.id || !s.sessionDate || !pbClientId) continue;
    const status = statusFor(s, now);

    try {
      const prev = await pool.query<{ status: string }>(
        `SELECT status FROM appointments WHERE pb_id = $1`,
        [s.id],
      );
      const prevStatus = prev.rows[0]?.status;

      const clientRes = await pool.query<{ id: string; email: string | null }>(
        `INSERT INTO clients (name, pb_id)
              VALUES ($1, $2)
         ON CONFLICT (pb_id) DO UPDATE SET name = EXCLUDED.name
           RETURNING id, email`,
        [clientRecordName(s.clientRecord) ?? 'Unknown client', String(pbClientId)],
      );
      const clientId = clientRes.rows[0].id;
      const clientEmail = clientRes.rows[0].email;

      const endsAt = s.endDate ?? addMinutes(s.sessionDate, s.duration ?? 60);
      const apptRes = await pool.query<{ id: string }>(
        `INSERT INTO appointments (client_id, pb_id, starts_at, ends_at, status)
              VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (pb_id) DO UPDATE
              SET starts_at = EXCLUDED.starts_at,
                  ends_at   = EXCLUDED.ends_at,
                  status    = EXCLUDED.status,
                  client_id = EXCLUDED.client_id
           RETURNING id`,
        [clientId, s.id, s.sessionDate, endsAt, status],
      );
      upserted++;
      const appointmentId = apptRes.rows[0].id;

      if (status !== prevStatus) {
        if (status === 'completed') {
          checkoutsDetected++;
          void detectCheckout(appointmentId).catch((e) =>
            logError('checkout.detect', 'auto-detect failed', e, { appointment_id: appointmentId }),
          );
        } else if (status === 'cancelled') {
          cancellationsEnrolled++;
          if (!clientEmail) {
            await backfillClientEmail(clientId, String(pbClientId));
          }
          void enrollCancelledAppointment(s.id).catch((e) =>
            logError('reengagement.cancelled', 'enroll failed', e, { pb_appointment_id: s.id }),
          );
        }
      }
    } catch (err) {
      logError('pb.sessionsSync', 'session upsert failed', err, { session_id: s.id });
    }
  }

  logEvent('info', 'pb.sessionsSync', 'PB sessions poll complete', {
    fetched: items.length,
    upserted,
    checkoutsDetected,
    cancellationsEnrolled,
  });
  return { fetched: items.length, upserted, checkoutsDetected, cancellationsEnrolled };
}
