#!/usr/bin/env node
/**
 * Detach recordings that the multi-session safety gate says must not sit in a
 * single client's chart, and clear the draft documents built from them.
 *
 * Uses the SAME functions the ingest path and the sweep use — this is not a
 * bespoke remediation, it is the production gate applied to rows that predate
 * it. Refuses to touch anything a human has approved.
 *
 * Usage: tsx scripts/hold-multisession-recordings.mts [--apply] [conversation-id ...]
 * Without --apply it reports what it would do and changes nothing.
 */
import 'dotenv/config';
import { pool } from '../src/db/pool.js';
import { listOverlapCandidates } from '../src/correlation/correlate.js';
import { assessMultiSessionRisk } from '../src/correlation/multiSession.js';

const args = process.argv.slice(2);
const apply = args.includes('--apply');
const ids = args.filter((a) => !a.startsWith('--'));

const db = await pool.connect();
try {
  const { rows } = await db.query<{
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
      WHERE c.correlation_status IN ('matched', 'manual')
        AND c.transcript IS NOT NULL
        ${ids.length ? 'AND c.id = ANY($1::uuid[])' : ''}
      ORDER BY c.starts_at DESC`,
    ids.length ? [ids] : [],
  );

  for (const conv of rows) {
    const candidates = await listOverlapCandidates(db, conv.starts_at, conv.ends_at);
    const risk = assessMultiSessionRisk({
      transcript: conv.transcript,
      candidates,
      matchedClientName: conv.client_name,
    });
    if (!risk.hold) {
      console.log(`ok    ${conv.id.slice(0, 8)}  ${conv.client_name}`);
      continue;
    }

    const blocked = await db.query(
      `SELECT 1 FROM appointment_sheets WHERE appointment_id = $1 AND status <> 'draft'
        UNION ALL
       SELECT 1 FROM protocols WHERE appointment_id = $1 AND status <> 'draft'`,
      [conv.appointment_id],
    );
    if ((blocked.rowCount ?? 0) > 0) {
      console.log(`SKIP  ${conv.id.slice(0, 8)}  ${conv.client_name} — has an approved document, leaving alone`);
      continue;
    }

    console.log(`HOLD  ${conv.id.slice(0, 8)}  was filed under ${conv.client_name}`);
    for (const r of risk.reasons) console.log(`        - ${r}`);
    if (!apply) continue;

    await db.query('BEGIN');
    try {
      const s = await db.query(`DELETE FROM appointment_sheets WHERE appointment_id = $1 AND status = 'draft'`, [conv.appointment_id]);
      const p = await db.query(`DELETE FROM protocols WHERE appointment_id = $1 AND status = 'draft'`, [conv.appointment_id]);
      await db.query(
        `UPDATE conversations
            SET correlation_status = 'needs_review',
                correlation_hold_reason = $2,
                appointment_id = NULL,
                client_id = NULL,
                correlation_overlap_seconds = NULL,
                -- Back to pending so the segments get extracted once a human has
                -- split the recording and said whose each part is.
                extraction_status = 'pending',
                extraction_error = NULL,
                extraction_leased_at = NULL,
                updated_at = now()
          WHERE id = $1`,
        [conv.id, risk.reasons.join('; ')],
      );
      await db.query('COMMIT');
      console.log(`        applied — deleted ${s.rowCount} draft sheet(s), ${p.rowCount} draft protocol(s)`);
    } catch (err) {
      await db.query('ROLLBACK');
      throw err;
    }
  }
} finally {
  db.release();
  await pool.end();
}
