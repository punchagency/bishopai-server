import { Router, type RequestHandler } from 'express';
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { pool } from '../db/pool';
import { isPbConfigured } from '../integrations/pb/config';
import { verifyBookingToken } from '../reengagement/bookingToken';
import { ingestConversation } from '../conversations/ingest';
import { processConversation } from '../session/process';
import { logError, logEvent, logWarn } from '../observability/logger';
import { requireWebhookSecret, requirePbSignature } from './webhookAuth';
import { classifyPbEvent, appointmentStatusFor } from '../integrations/pb/events';
import { detectCheckout } from '../checkout/machine';
import { ingestLead } from '../reengagement/intake';
import { ingestSiteEvent, SITE_EVENT_TYPES } from '../reengagement/analytics';
import { runReengagementForLead } from '../reengagement/runner';
import { enrollCancelledAppointment } from '../reengagement/cancellations';

export const webhooksRouter = Router();

/** Escape a string for safe interpolation into HTML text/attribute context. */
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Minimal branded status page for the public booking flow (expired/unavailable/error). */
function bookingErrorHtml(title: string, message: string, color = '#f43f5e'): string {
  return `<!DOCTYPE html><html><head><title>${title}</title><meta name="viewport" content="width=device-width, initial-scale=1"><style>body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;background:#0f0f12;color:#e4e4e7;display:flex;align-items:center;justify-content:center;height:100vh;margin:0}.card{background:#18181b;border:1px solid #27272a;padding:2.5rem;border-radius:12px;text-align:center;max-width:400px;box-shadow:0 4px 20px rgba(0,0,0,0.3)}h1{color:${color};margin-top:0}p{color:#a1a1aa;line-height:1.5}</style></head><body><div class="card"><h1>${title}</h1><p>${message}</p></div></body></html>`;
}

// ---------------------------------------------------------------------------
// PB booking (via Zapier) — lands appointment data. Idempotent upsert so
// Zapier retries don't duplicate rows.
// ---------------------------------------------------------------------------
const bookingSchema = z.object({
  pb_appointment_id: z.string().min(1),
  pb_client_id: z.string().min(1),
  client_name: z.string().min(1),
  client_email: z.string().email().optional(), // stored so a cancellation can re-engage them
  starts_at: z.string().datetime(),
  ends_at: z.string().datetime(),
  status: z.string().default('confirmed'),
});

webhooksRouter.post('/pb/booking', requireWebhookSecret('PB_WEBHOOK_SECRET'), async (req, res) => {
  const parsed = bookingSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'invalid payload', details: parsed.error.flatten() });
  }
  const b = parsed.data;
  const db = await pool.connect();
  try {
    await db.query('BEGIN');

    const clientRes = await db.query<{ id: string }>(
      `INSERT INTO clients (name, pb_id, email)
            VALUES ($1, $2, $3)
       ON CONFLICT (pb_id) DO UPDATE
            SET name  = EXCLUDED.name,
                email = COALESCE(EXCLUDED.email, clients.email)
         RETURNING id`,
      [b.client_name, b.pb_client_id, b.client_email ?? null],
    );
    const clientId = clientRes.rows[0].id;

    const apptRes = await db.query<{ id: string }>(
      `INSERT INTO appointments (client_id, pb_id, starts_at, ends_at, status)
            VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (pb_id) DO UPDATE
            SET starts_at = EXCLUDED.starts_at,
                ends_at   = EXCLUDED.ends_at,
                status    = EXCLUDED.status,
                client_id = EXCLUDED.client_id
         RETURNING id`,
      [clientId, b.pb_appointment_id, b.starts_at, b.ends_at, b.status],
    );

    await db.query('COMMIT');
    res.status(200).json({ appointment_id: apptRes.rows[0].id, client_id: clientId });
  } catch (err) {
    await db.query('ROLLBACK');
    await logError('webhook.pb_booking', 'appointment upsert failed', err, {
      pb_appointment_id: b.pb_appointment_id,
    });
    res.status(500).json({ error: 'internal error' });
  } finally {
    db.release();
  }
});

// ---------------------------------------------------------------------------
// PB native webhook (no Zapier) — Practice Better POSTs here directly when a
// session changes (e.g. marked complete/cancelled). Signature-verified via
// PB-Signature. Exact event-type names are confirmed once we have beta access
// (GET /webhooks/subscription/event/types); `classifyPbEvent` maps tolerantly
// until then. On a completed/cancelled event we reflect the status onto the
// matching appointment (by pb_id). Session-complete drives WF2 checkout;
// cancelled enrolls the client into the WF3 cancelled cadence (both off-path).
// ---------------------------------------------------------------------------
webhooksRouter.post('/pb/session', requirePbSignature('PB_SIGNING_SECRET'), async (req, res) => {
  const ev = classifyPbEvent(req.body);
  logEvent('info', 'webhook.pb_session', 'PB webhook received', {
    eventType: ev.eventType,
    kind: ev.kind,
    objectId: ev.objectId,
  });
  try {
    const status = appointmentStatusFor(ev.kind);
    if (status && ev.objectId) {
      const r = await pool.query<{ id: string }>(
        `UPDATE appointments SET status = $2 WHERE pb_id = $1 RETURNING id`,
        [ev.objectId, status],
      );
      if (r.rowCount) {
        logEvent('info', 'webhook.pb_session', `appointment marked ${status}`, { pb_id: ev.objectId });
        // Session complete → kick off WF2 checkout (off the request path).
        if (ev.kind === 'session_completed') {
          const apptId = r.rows[0].id;
          void detectCheckout(apptId).catch((e) =>
            logError('checkout.detect', 'auto-detect failed', e, { appointment_id: apptId }),
          );
        }
        // Cancelled → enroll the client in the WF3 cancelled cadence (7d/14d),
        // off the request path. No-op when we have no email on file for them.
        if (ev.kind === 'session_cancelled' && ev.objectId) {
          const pbId = ev.objectId;
          void enrollCancelledAppointment(pbId).catch((e) =>
            logError('reengagement.cancelled', 'enroll failed', e, { pb_appointment_id: pbId }),
          );
        }
      }
    }
    // Acknowledge; PB retries on non-2xx (see GET /webhooks/delivery).
    res.status(200).json({ received: true, kind: ev.kind });
  } catch (err) {
    await logError('webhook.pb_session', 'handling failed', err, { objectId: ev.objectId });
    res.status(500).json({ error: 'internal error' });
  }
});

// ---------------------------------------------------------------------------
// Bee conversation ingest — insert the conversation and correlate it to an
// appointment. This is the real ingress: the Electron app's Bee courier on
// Nicole's machine runs the `bee` CLI and POSTs each new conversation here.
// (Needs a shared-secret/signature check before go-live — open auth gap.)
// ---------------------------------------------------------------------------
const conversationSchema = z.object({
  bee_id: z.string().min(1),
  starts_at: z.string().datetime(),
  ends_at: z.string().datetime(),
  transcript: z.string().optional(),
});

webhooksRouter.post('/bee/conversation', requireWebhookSecret('BEE_WEBHOOK_SECRET'), async (req, res) => {
  const parsed = conversationSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'invalid payload', details: parsed.error.flatten() });
  }
  try {
    const { conversationId, correlation } = await ingestConversation(parsed.data);
    // Extraction runs off the request path so the webhook returns immediately.
    if (correlation.status === 'matched') {
      void processConversation(conversationId).catch((err) =>
        logError('session.process', 'processing failed', err, { conversation_id: conversationId }),
      );
    }
    res.status(200).json({ conversation_id: conversationId, correlation });
  } catch (err) {
    await logError('webhook.bee_conversation', 'ingest failed', err, { bee_id: parsed.data.bee_id });
    res.status(500).json({ error: 'internal error' });
  }
});

// ---------------------------------------------------------------------------
// Lead intake (WF3) — a new inquiry from the website contact/booking form, or
// an Outlook inbox message forwarded here. Lands a `leads` row (idempotent by
// email) and fires the automated first response off the request path, so a new
// lead is greeted "within minutes" rather than on the next hourly cadence tick.
// Nicole is never the first touchpoint. Shared-secret guarded like the others.
// ---------------------------------------------------------------------------
// In-memory rate limiting store
const rateLimitStore = new Map<string, { count: number; resetAt: number }>();

function rateLimiter(limit: number, windowMs: number): RequestHandler {
  return (req, res, next) => {
    const ip = req.ip || req.socket.remoteAddress || 'unknown';
    const now = Date.now();
    const entry = rateLimitStore.get(ip);

    if (!entry || now > entry.resetAt) {
      rateLimitStore.set(ip, { count: 1, resetAt: now + windowMs });
      return next();
    }

    if (entry.count >= limit) {
      logWarn('webhook.rate_limit', 'rejected: rate limit exceeded', { ip, path: req.originalUrl });
      return res.status(429).json({ error: 'Too many requests. Please try again later.' });
    }

    entry.count++;
    next();
  };
}

function restrictToAllowedOrigin(): RequestHandler {
  const allowed = process.env.ALLOWED_ORIGINS
    ? process.env.ALLOWED_ORIGINS.split(',').map((o) => o.trim().toLowerCase())
    : [];

  return (req, res, next) => {
    // If ALLOWED_ORIGINS is empty or unset, skip checks (dev/testing mode)
    if (allowed.length === 0) {
      return next();
    }

    const origin = (req.get('origin') || '').toLowerCase();
    const referer = (req.get('referer') || '').toLowerCase();

    const isOriginAllowed = origin && allowed.some((a) => origin.includes(a));
    const isRefererAllowed = referer && allowed.some((a) => referer.includes(a));

    if (!isOriginAllowed && !isRefererAllowed) {
      logWarn('webhook.origin', 'rejected: unauthorized origin/referer', {
        origin,
        referer,
        path: req.originalUrl,
      });
      return res.status(403).json({ error: 'forbidden' });
    }
    next();
  };
}

// Site-behavior analytics ingest (WF3): page views / form opens / submits from
// the website into lead_activity, attributed to a lead by lead_id or email when known.
const analyticsSchema = z.object({
  email: z.string().email().max(200).optional(),
  lead_id: z.string().uuid().optional(),
  type: z.enum(SITE_EVENT_TYPES),
  path: z.string().max(500).optional(),
  detail: z.string().max(2000).optional(),
  occurred_at: z.string().max(100).optional(),
});

webhooksRouter.post('/analytics', restrictToAllowedOrigin(), rateLimiter(100, 15 * 60_000), async (req, res) => {
  const parsed = analyticsSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'invalid payload', details: parsed.error.flatten() });
  }
  const d = parsed.data;
  try {
    const { activityId, leadId } = await ingestSiteEvent({
      email: d.email ?? null,
      leadId: d.lead_id ?? null,
      type: d.type,
      path: d.path ?? null,
      detail: d.detail ?? null,
      occurredAt: d.occurred_at ?? null,
    });
    res.status(200).json({ activity_id: activityId, lead_id: leadId });
  } catch (err) {
    await logError('webhook.analytics', 'analytics ingest failed', err);
    res.status(500).json({ error: 'internal error' });
  }
});

const leadSchema = z.object({
  email: z.string().email().max(200),
  name: z.string().max(200).optional(),
  source: z.string().max(50).optional(), // 'website' | 'outlook' | ...
  path: z.string().max(500).optional(), // e.g. '/book-a-consult'
  message: z.string().max(2000).optional(),
});

webhooksRouter.post('/lead', restrictToAllowedOrigin(), rateLimiter(5, 15 * 60_000), async (req, res) => {
  const parsed = leadSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'invalid payload', details: parsed.error.flatten() });
  }
  const d = parsed.data;
  try {
    const { leadId, created } = await ingestLead({
      email: d.email,
      name: d.name ?? null,
      source: d.source ?? 'website',
      path: d.path ?? null,
      detail: d.message ?? null,
      activityType: d.source === 'outlook' ? 'inquiry' : 'form_submit',
    });
    // Automated first response, off the request path so intake returns fast.
    void runReengagementForLead(leadId).catch((err) =>
      logError('lead.intake', 'first response failed', err, { lead_id: leadId }),
    );
    res.status(200).json({ lead_id: leadId, created });
  } catch (err) {
    await logError('webhook.lead', 'lead intake failed', err, { email: d.email });
    res.status(500).json({ error: 'internal error' });
  }
});

// ---------------------------------------------------------------------------
// Public booking confirmation (WF3/4 click-to-book)
// ---------------------------------------------------------------------------
webhooksRouter.get('/appointments/book', async (req, res) => {
  const { leadId, slot, token } = req.query;
  if (typeof leadId !== 'string' || typeof slot !== 'string') {
    return res.status(400).send('<h1>Invalid Link</h1><p>Missing leadId or slot parameter.</p>');
  }

  // Verify the signed token (tamper-proof + time-bounded). Fails open in dev when
  // BOOKING_LINK_SECRET is unset.
  if (!verifyBookingToken(leadId, slot, typeof token === 'string' ? token : undefined)) {
    return res.status(400).send(
      bookingErrorHtml('Invalid Link', 'This booking link is invalid or has expired.'),
    );
  }

  // Validate `slot` is a real future timestamp BEFORE it's echoed anywhere —
  // guards against a garbage/hostile value reflected into the page.
  const date = new Date(slot);
  if (Number.isNaN(date.getTime()) || date.getTime() < Date.now()) {
    return res.status(400).send(
      bookingErrorHtml('Invalid Link', 'This booking link is invalid or has expired.'),
    );
  }

  try {
    // 1. Verify lead exists and is active
    const leadRes = await pool.query(
      `SELECT * FROM leads WHERE id = $1 AND status NOT IN ('closed', 'booked')`,
      [leadId]
    );
    if (leadRes.rowCount === 0) {
      return res.status(400).send(
        bookingErrorHtml('Link Expired', 'This booking link has expired, or the appointment has already been scheduled.'),
      );
    }

    // Format the date for display in Nicole's configured timezone.
    const { loadOfficeHours } = await import('./appointments');
    const oh = await loadOfficeHours();
    const dateFormatted = new Intl.DateTimeFormat('en-GB', {
      weekday: 'long',
      year: 'numeric',
      month: 'long',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      hour12: true,
      timeZone: oh.timezone,
    }).format(date);

    // Render a clean, premium booking confirmation page
    res.send(`
      <!DOCTYPE html>
      <html>
        <head>
          <title>Confirm Your Appointment</title>
          <meta name="viewport" content="width=device-width, initial-scale=1">
          <style>
            body {
              font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
              background: #0f0f12;
              color: #e4e4e7;
              display: flex;
              align-items: center;
              justify-content: center;
              min-height: 100vh;
              margin: 0;
            }
            .card {
              background: #18181b;
              border: 1px solid #27272a;
              padding: 2.5rem;
              border-radius: 16px;
              max-width: 450px;
              width: 90%;
              box-shadow: 0 10px 30px rgba(0,0,0,0.5);
              text-align: center;
            }
            .icon {
              font-size: 3rem;
              margin-bottom: 1.5rem;
              color: #a855f7;
            }
            h1 {
              font-size: 1.75rem;
              font-weight: 700;
              margin-top: 0;
              margin-bottom: 0.5rem;
              color: #ffffff;
            }
            .sub {
              color: #a1a1aa;
              margin-bottom: 2rem;
              font-size: 0.95rem;
            }
            .slot-box {
              background: #27272a;
              border: 1px solid #3f3f46;
              padding: 1.25rem;
              border-radius: 8px;
              margin-bottom: 2rem;
              font-weight: 600;
              font-size: 1.1rem;
              color: #f4f4f5;
            }
            .btn {
              background: linear-gradient(135deg, #a855f7 0%, #7c3aed 100%);
              color: white;
              border: none;
              padding: 1rem 2rem;
              font-size: 1rem;
              font-weight: 600;
              border-radius: 8px;
              cursor: pointer;
              width: 100%;
              transition: opacity 0.2s;
              box-shadow: 0 4px 12px rgba(124, 58, 237, 0.3);
            }
            .btn:hover {
              opacity: 0.95;
            }
            .btn:disabled {
              background: #3f3f46;
              color: #71717a;
              cursor: not-allowed;
              box-shadow: none;
            }
          </style>
        </head>
        <body>
          <div class="card">
            <div class="icon">📅</div>
            <h1>Confirm Appointment</h1>
            <p class="sub">Please confirm you'd like to book your session for:</p>
            <div class="slot-box">${dateFormatted}</div>
            <form action="/webhooks/appointments/book" method="POST">
              <input type="hidden" name="leadId" value="${escapeHtml(leadId)}" />
              <input type="hidden" name="slot" value="${escapeHtml(slot)}" />
              <input type="hidden" name="token" value="${escapeHtml(typeof token === 'string' ? token : '')}" />
              <button type="submit" class="btn" id="confirm-btn">Confirm Booking</button>
            </form>
          </div>
        </body>
      </html>
    `);
  } catch (err) {
    logError('webhook.appointments.book_get', 'failed to show book page', err);
    res.status(500).send('<h1>Server Error</h1>');
  }
});

webhooksRouter.post('/appointments/book', async (req, res) => {
  const { leadId, slot, token } = req.body;
  if (typeof leadId !== 'string' || typeof slot !== 'string') {
    return res.status(400).send('<h1>Invalid Request</h1>');
  }

  // Re-verify the signed token on the write path (a confirmation page could be
  // replayed with a tampered slot). Fails open in dev when the secret is unset.
  if (!verifyBookingToken(leadId, slot, typeof token === 'string' ? token : undefined)) {
    return res.status(400).send(
      bookingErrorHtml('Invalid Link', 'This booking link is invalid or has expired.'),
    );
  }

  try {
    // 1. Lead must exist and be active.
    const leadRes = await pool.query<{ id: string; email: string; status: string }>(
      `SELECT id, email, status FROM leads WHERE id = $1`,
      [leadId],
    );
    const lead = leadRes.rows[0];
    if (!lead || lead.status === 'closed' || lead.status === 'booked') {
      return res.status(400).send(
        bookingErrorHtml('Link Expired', 'This link has expired or the appointment has already been scheduled.'),
      );
    }

    // 2. Re-validate the slot server-side: a real future time, inside office
    //    hours, not overlapping a booked session. Guards a hand-edited/stale
    //    `slot` and a slot taken since the email went out.
    const { loadOfficeHours, fetchUpcoming, isSlotOfferable } = await import('./appointments');
    const oh = await loadOfficeHours();
    const booked = await fetchUpcoming(oh);
    if (!isSlotOfferable(slot, booked, oh)) {
      return res.status(409).send(
        bookingErrorHtml('Time No Longer Available', 'That time was just taken or is no longer offered. Please reply to the email to find another time.'),
      );
    }

    // 3. Optimistically CLAIM the booking with an atomic conditional update — no
    //    DB lock is held across the PB API call. A concurrent submit for the same
    //    lead loses the race here (rowCount 0).
    const claim = await pool.query(
      `UPDATE leads SET status = 'booked' WHERE id = $1 AND status NOT IN ('closed','booked') RETURNING id`,
      [leadId],
    );
    if (claim.rowCount === 0) {
      return res.status(409).send(
        bookingErrorHtml('Already Booked', 'This appointment has already been scheduled.'),
      );
    }
    const previousStatus = lead.status;

    const pbConfigured = isPbConfigured();
    try {
      const { listServices, createSession, createClientRecord } = await import('../integrations/pb/reads');

      // 4. Resolve or create the client. Persist to the local DB immediately
      //    after creating so a later failure + retry won't duplicate the record.
      //    When PB isn't configured (offline/pre-beta) we synthesize a dry-run id
      //    and skip the PB write — the flow still records + confirms locally.
      let clientPbId: string | null = null;
      let clientName = 'Lead Inquiry';
      const localClient = await pool.query<{ pb_id: string | null; name: string }>(
        `SELECT pb_id, name FROM clients WHERE email = $1 LIMIT 1`,
        [lead.email],
      );
      if ((localClient.rowCount ?? 0) > 0 && localClient.rows[0].pb_id) {
        clientPbId = localClient.rows[0].pb_id;
        clientName = localClient.rows[0].name;
      } else {
        const actRes = await pool.query<{ detail: string }>(
          `SELECT detail FROM lead_activity WHERE lead_id = $1 AND type = 'form_submit' ORDER BY occurred_at DESC LIMIT 1`,
          [lead.id],
        );
        let firstName = 'Lead';
        let lastName = 'Inquiry';
        if ((actRes.rowCount ?? 0) > 0 && actRes.rows[0].detail) {
          const nameMatch = /name:\s*([^—\n]+)/i.exec(actRes.rows[0].detail);
          if (nameMatch && nameMatch[1]) {
            const parts = nameMatch[1].trim().split(/\s+/);
            if (parts.length > 0) firstName = parts[0];
            if (parts.length > 1) lastName = parts.slice(1).join(' ');
            clientName = nameMatch[1].trim();
          }
        }
        clientPbId = pbConfigured
          ? (await createClientRecord({ profile: { firstName, lastName, emailAddress: lead.email } })).id
          : `dry-client-${randomUUID()}`;
        await pool.query(
          `INSERT INTO clients (name, pb_id, email) VALUES ($1, $2, $3)
             ON CONFLICT (pb_id) DO UPDATE SET email = EXCLUDED.email, name = EXCLUDED.name`,
          [clientName, clientPbId, lead.email],
        );
      }

      // 5–6. Book the session. When PB is configured, resolve the service and
      // create the session (ignoreConflict:false → PB is the double-book
      // authority). Otherwise synthesize a dry-run session id.
      let sessionId: string;
      if (pbConfigured) {
        let serviceId = oh.service_id;
        let serviceType = oh.service_type || 'virtual';
        if (!serviceId) {
          const svcs = await listServices();
          const match = svcs.items.find((s) => s.duration === oh.session_duration_min) ?? svcs.items[0];
          if (!match) throw new Error('No services found in Practice Better to book against.');
          serviceId = match.id;
          if (match.serviceTypes && match.serviceTypes.length > 0) serviceType = match.serviceTypes[0];
        }
        const session = await createSession({
          clientRecordId: clientPbId,
          sessionDate: slot,
          serviceType,
          serviceId,
          duration: oh.session_duration_min,
          markConfirmed: true,
          notify: true,
          ignoreConflict: false,
        });
        sessionId = session.id;
      } else {
        sessionId = `dry-session-${randomUUID()}`;
        logEvent('info', 'webhook.appointments.book', '[dry-run] PB not configured — booking recorded locally only', {
          lead_id: leadId,
        });
      }

      // 7. Record locally in ONE short, all-local transaction.
      const endsAt = new Date(new Date(slot).getTime() + oh.session_duration_min * 60_000).toISOString();
      const db = await pool.connect();
      try {
        await db.query('BEGIN');
        const lc = await db.query<{ id: string }>(
          `INSERT INTO clients (name, pb_id, email) VALUES ($1, $2, $3)
             ON CONFLICT (pb_id) DO UPDATE SET name = EXCLUDED.name, email = EXCLUDED.email
             RETURNING id`,
          [clientName, clientPbId, lead.email],
        );
        await db.query(
          `INSERT INTO appointments (client_id, pb_id, starts_at, ends_at, status)
             VALUES ($1, $2, $3, $4, 'confirmed')
             ON CONFLICT (pb_id) DO UPDATE SET starts_at = EXCLUDED.starts_at, ends_at = EXCLUDED.ends_at, status = EXCLUDED.status`,
          [lc.rows[0].id, sessionId, slot, endsAt],
        );
        await db.query(
          `INSERT INTO lead_activity (lead_id, type, detail) VALUES ($1, 'booked', $2)`,
          [leadId, `Booked session for ${new Date(slot).toLocaleString()}`],
        );
        await db.query('COMMIT');
      } catch (e) {
        await db.query('ROLLBACK');
        throw e;
      } finally {
        db.release();
      }

      logEvent('info', 'webhook.appointments.book', 'booked session', { lead_id: leadId, pb_session_id: sessionId, dry_run: !pbConfigured });
    } catch (bookErr) {
      // We claimed the lead before the PB call; on failure, revert the claim so
      // the client can retry — but only if we still own it ('booked').
      await pool
        .query(`UPDATE leads SET status = $2 WHERE id = $1 AND status = 'booked'`, [leadId, previousStatus])
        .catch((e) => logError('webhook.appointments.book_post', 'failed to revert lead claim', e, { lead_id: leadId }));
      throw bookErr;
    }

    // Show a beautiful, high-fidelity Booking Confirmed page!
    res.send(`
      <!DOCTYPE html>
      <html>
        <head>
          <title>Booking Confirmed!</title>
          <meta name="viewport" content="width=device-width, initial-scale=1">
          <style>
            body {
              font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
              background: #0f0f12;
              color: #e4e4e7;
              display: flex;
              align-items: center;
              justify-content: center;
              min-height: 100vh;
              margin: 0;
            }
            .card {
              background: #18181b;
              border: 1px solid #27272a;
              padding: 2.5rem;
              border-radius: 16px;
              max-width: 450px;
              width: 90%;
              box-shadow: 0 10px 30px rgba(0,0,0,0.5);
              text-align: center;
            }
            .icon {
              font-size: 3rem;
              margin-bottom: 1.5rem;
              color: #22c55e;
            }
            h1 {
              font-size: 1.75rem;
              font-weight: 700;
              margin-top: 0;
              margin-bottom: 0.5rem;
              color: #ffffff;
            }
            .sub {
              color: #a1a1aa;
              margin-bottom: 2rem;
              font-size: 0.95rem;
              line-height: 1.5;
            }
          </style>
        </head>
        <body>
          <div class="card">
            <div class="icon">✓</div>
            <h1>Booking Confirmed!</h1>
            <p class="sub">Your appointment has been scheduled and confirmed in our calendar. You will receive an email shortly.</p>
          </div>
        </body>
      </html>
    `);
  } catch (err) {
    logError('webhook.appointments.book_post', 'failed to book appointment', err);
    const message = err instanceof Error ? err.message : String(err);
    const status = (err as { status?: number })?.status;
    const isConflict = status === 409 || /conflict|overlap|already|not available|taken/i.test(message);
    const msg = isConflict
      ? 'This time slot is no longer available. Please reply to the email to find another time.'
      : 'An unexpected error occurred while booking. Please try again or contact support.';
    res.status(500).send(bookingErrorHtml('Booking Failed', msg, '#ef4444'));
  }
});

