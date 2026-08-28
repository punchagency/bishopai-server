import type { Job } from '../types';
import { pool } from '../../db/pool';
import { logEvent, logError } from '../../observability/logger';
import { correlateConversation, listOverlapCandidates } from '../../correlation/correlate';
import { assessMultiSessionRisk } from '../../correlation/multiSession';
import { enqueueExtraction } from '../../session/queue';

// Periodic catch-all for unmatched conversations that now have a matching
// appointment.
//
// `recorrelateOverlappingConversations` is called from pbSync whenever a PB
// appointment is upserted, which handles the common race (recording arrives
// before the appointment syncs). This job covers the cases pbSync cannot:
//
//   - Appointments inserted directly into Postgres (manual entry, migrations,
//     data imports) that never passed through syncSessionsFromPb.
//   - Recordings that arrived while the server was down and pbSync never ran.
//   - Any re-correlation that failed silently under the old fire-and-forget path.
//
// Runs every 15 minutes. The window is 7 days so a recording from earlier in
// the week is still recoverable if its appointment was entered late.
//
// Note: processConversation is idempotent — calling it on a conversation that
// is already done or in-flight is a no-op (the claim UPDATE returns 0 rows).

const SWEEP_DAYS = Number(process.env.CORRELATION_SWEEP_DAYS ?? 7);

export const correlationSweepJob: Job = {
  name: 'wf1.correlation_sweep',
  schedule: process.env.CRON_CORRELATION_SWEEP ?? '*/15 * * * *',
  async run() {
    // Find all unmatched conversations within the sweep window that have a
    // transcript (no point re-correlating a recording we can't extract from).
    const { rows } = await pool.query<{
      id: string;
      starts_at: string;
      ends_at: string;
      transcript: string | null;
    }>(
      `SELECT id, starts_at, ends_at, transcript
         FROM conversations
        WHERE correlation_status = 'unmatched'
          AND transcript IS NOT NULL
          AND starts_at >= now() - ($1 || ' days')::interval
          -- Skip split children (their client was chosen by a human) AND split
          -- parents (already superseded by their children; re-matching one would
          -- duplicate the consultation under the wrong client).
          AND parent_conversation_id IS NULL
          AND NOT EXISTS (
                SELECT 1 FROM conversations child
                 WHERE child.parent_conversation_id = conversations.id
              )
        ORDER BY starts_at DESC
        LIMIT 50`,
      [String(SWEEP_DAYS)],
    );


    let matched = 0;
    let failed = 0;
    let held = 0;

    const db = await pool.connect();
    try {
      for (const conv of rows) {
        try {
          const res = await correlateConversation(db, conv.starts_at, conv.ends_at);

          // The sweep gets the same veto the ingest path does. Without it this
          // job is a second, slower door to the identical bug: it re-runs the
          // matcher on a backlog of unmatched recordings, and a recording that
          // holds three consultations is exactly the kind that sits unmatched
          // (its neighbours are ambiguous) until a late calendar sync leaves one
          // candidate standing and the matcher files the lot under that client.
          //
          // The gate runs BEFORE the matcher's verdict is acted on, and runs
          // whether or not that verdict was 'matched'. Gating only would-be
          // matches inverts the priority: a recording holding two clients is
          // ambiguous almost by definition — two appointments overlap it and
          // neither wins — so the matcher returns 'unmatched' and the recording
          // that most needs a human sits in the queue labelled only 'unmatched',
          // with nothing saying why. Measured on the six unmatched recordings in
          // production on 2026-08-24, the matcher returned 'unmatched' for every
          // one, so a gate placed after that check never executed at all.
          const candidates = await listOverlapCandidates(db, conv.starts_at, conv.ends_at);
          const matchedAppointmentId = res.status === 'matched' ? res.appointmentId : null;
          const risk = assessMultiSessionRisk({
            transcript: conv.transcript,
            candidates,
            matchedClientName: matchedAppointmentId
              ? candidates.find((c) => c.appointmentId === matchedAppointmentId)?.clientName ?? null
              : null,
          });
          if (risk.hold) {
            await db.query(
              `UPDATE conversations
                  SET correlation_status = 'needs_review',
                      correlation_hold_reason = $2,
                      updated_at = now()
                WHERE id = $1 AND correlation_status = 'unmatched'`,
              [conv.id, risk.reasons.join('; ')],
            );
            held++;
            logEvent('warn', 'correlation.sweep', 'sweep declined to match — held for review', {
              conversation_id: conv.id,
              // Null when the matcher had no verdict to veto. That is the
              // common case for a multi-client recording, not an odd one:
              // 'ambiguous' is what two overlapping appointments produce.
              would_have_matched: matchedAppointmentId,
              matcher_status: res.status === 'matched' ? 'matched' : res.reason,
              reasons: risk.reasons,
            });
            continue;
          }

          // Not held, and the matcher found nothing to file it under: leave it
          // in the unmatched queue for the next sweep.
          if (res.status !== 'matched') continue;

          const updated = await db.query<{ id: string }>(
            `UPDATE conversations
                SET appointment_id = $2,
                    client_id = $3,
                    correlation_status = 'matched',
                    correlation_overlap_seconds = $4,
                    updated_at = now()
              WHERE id = $1
                AND correlation_status = 'unmatched'
              RETURNING id`,
            [conv.id, res.appointmentId, res.clientId, res.overlapSeconds],
          );

          if ((updated.rowCount ?? 0) > 0) {
            matched++;
            logEvent('info', 'correlation.sweep', 'sweep re-matched conversation', {
              conversation_id: conv.id,
              appointment_id: res.appointmentId,
              overlap_seconds: res.overlapSeconds,
            });
            // Queued rather than run inline. The sweep matches conversations
            // in a loop, and extracting each one where it is found means the
            // sweep's runtime is however long N sessions take to read — with
            // every one of them holding the sweep open against a provider that
            // may be rate-limiting. The queue drains them one at a time on its
            // own, and does it having first checked the day's allowance.
            enqueueExtraction(conv.id);
          }
        } catch (err) {
          failed++;
          logError('correlation.sweep', 'sweep failed for conversation', err, {
            conversation_id: conv.id,
          });
        }
      }

      // --- Audit pass over rows that are ALREADY matched ----------------------
      //
      // The half of this job that the 2026-08-20 incident actually needed.
      //
      // Everything above only ever looks at `unmatched` rows, on the assumption
      // that a match, once made, stays right. It does not. A match is made
      // against the calendar as it stood at that instant, and the calendar
      // arrives late: Practice Better synced Steve Broderick's 19:00 appointment
      // two minutes AFTER his recording had already been filed under the only
      // client then visible in that window. Nothing re-examined it, because the
      // row said `matched` and the sweep only reads `unmatched`.
      //
      // So: re-run the safety gate over recent auto-matches. A match that no
      // longer looks safe is DEMOTED, never reassigned — the gate knows that a
      // recording is suspect, not whose it is.
      const audited = await db.query<{
        id: string;
        starts_at: string;
        ends_at: string;
        transcript: string | null;
        appointment_id: string | null;
        client_name: string | null;
      }>(
        `SELECT c.id, c.starts_at, c.ends_at, c.transcript, c.appointment_id,
                (SELECT name FROM clients WHERE id = c.client_id) AS client_name
           FROM conversations c
          WHERE c.correlation_status = 'matched'
            AND c.transcript IS NOT NULL
            AND c.starts_at >= now() - ($1 || ' days')::interval
            AND c.parent_conversation_id IS NULL
          ORDER BY c.starts_at DESC
          LIMIT 50`,
        [String(SWEEP_DAYS)],
      );

      for (const conv of audited.rows) {
        try {
          const candidates = await listOverlapCandidates(db, conv.starts_at, conv.ends_at);
          const risk = assessMultiSessionRisk({
            transcript: conv.transcript,
            candidates,
            matchedClientName: conv.client_name,
          });
          if (!risk.hold) continue;

          // Only an untouched auto-match is demoted, and only while every note
          // built from it is still an unapproved draft. Once Nicole has approved
          // a document she has read it and taken responsibility for it; pulling
          // the recording out from under an approved note would leave a
          // published document with no source, which is worse than the thing
          // being guarded against.
          await db.query('BEGIN');
          let demotedRows = 0;
          try {
            const demoted = await db.query<{ id: string }>(
              `UPDATE conversations c
                  SET correlation_status = 'needs_review',
                      correlation_hold_reason = $2,
                      appointment_id = NULL,
                      client_id = NULL,
                      correlation_overlap_seconds = NULL,
                      -- Back to pending: once a human splits the recording and
                      -- says whose each part is, the segments must extract. A
                      -- row left 'done' would stay silent forever.
                      extraction_status = 'pending',
                      extraction_error = NULL,
                      extraction_leased_at = NULL,
                      updated_at = now()
                WHERE c.id = $1
                  AND c.correlation_status = 'matched'
                  AND NOT EXISTS (
                        SELECT 1 FROM appointment_sheets s
                         WHERE s.appointment_id = c.appointment_id AND s.status <> 'draft')
                  AND NOT EXISTS (
                        SELECT 1 FROM protocols pr
                         WHERE pr.appointment_id = c.appointment_id AND pr.status <> 'draft')
                RETURNING c.id`,
              [conv.id, risk.reasons.join('; ')],
            );
            demotedRows = demoted.rowCount ?? 0;

            // Withdraw what was built FROM the recording, not just the link to
            // it. Detaching alone was not enough: the draft note stayed in the
            // chart and in Nicole's review queue, still holding the other
            // client's symptoms and quotes, now with no recording behind it to
            // explain where they came from. These are machine output with no
            // human edits (a revision would have made this a no-op above), and
            // re-extraction rebuilds them once the split is done.
            if (demotedRows > 0 && conv.appointment_id) {
              await db.query(`DELETE FROM appointment_sheets WHERE appointment_id = $1 AND status = 'draft'`, [conv.appointment_id]);
              await db.query(`DELETE FROM protocols WHERE appointment_id = $1 AND status = 'draft'`, [conv.appointment_id]);
            }
            await db.query('COMMIT');
          } catch (err) {
            await db.query('ROLLBACK');
            throw err;
          }

          if (demotedRows > 0) {
            held++;
            logEvent('warn', 'correlation.sweep', 'existing match demoted — may span more than one client', {
              conversation_id: conv.id,
              was_filed_under: conv.client_name,
              reasons: risk.reasons,
            });
          } else {
            logEvent('info', 'correlation.sweep', 'match looks unsafe but its note is approved — left alone', {
              conversation_id: conv.id,
              filed_under: conv.client_name,
              reasons: risk.reasons,
            });
          }
        } catch (err) {
          failed++;
          logError('correlation.sweep', 'audit failed for conversation', err, {
            conversation_id: conv.id,
          });
        }
      }
    } finally {
      db.release();
    }

    if (matched > 0 || failed > 0 || held > 0) {
      logEvent(failed > 0 || held > 0 ? 'warn' : 'info', 'correlation.sweep', 'sweep complete', {
        scanned: rows.length,
        matched,
        held,
        failed,
        window_days: SWEEP_DAYS,
      });
    }
  },
};
