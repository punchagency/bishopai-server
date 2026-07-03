import { Router } from 'express';
import { z } from 'zod';
import { pool } from '../db/pool';
import { ingestConversation } from '../conversations/ingest';
import { processConversation } from '../session/process';
import { logError, logEvent } from '../observability/logger';
import { requireWebhookSecret, requirePbSignature } from './webhookAuth';
import { classifyPbEvent, appointmentStatusFor } from '../integrations/pb/events';
import { detectCheckout } from '../checkout/machine';

export const webhooksRouter = Router();

// ---------------------------------------------------------------------------
// PB booking (via Zapier) — lands appointment data. Idempotent upsert so
// Zapier retries don't duplicate rows.
// ---------------------------------------------------------------------------
const bookingSchema = z.object({
  pb_appointment_id: z.string().min(1),
  pb_client_id: z.string().min(1),
  client_name: z.string().min(1),
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
      `INSERT INTO clients (name, pb_id)
            VALUES ($1, $2)
       ON CONFLICT (pb_id) DO UPDATE SET name = EXCLUDED.name
         RETURNING id`,
      [b.client_name, b.pb_client_id],
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
// matching appointment (by pb_id). TODO: session-complete also drives WF2
// checkout (blocked on QB Payments); cancelled feeds the WF3 cancelled cadence.
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
