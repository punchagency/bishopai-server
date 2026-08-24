#!/usr/bin/env node
/**
 * Re-run extraction for one conversation, by client name or conversation id.
 * Usage: tsx scripts/reextract.mts "Jodi Hess"
 *
 * Resets the row to `pending` so processConversation's claim can take it, then
 * processes it inline. Refuses to touch a sheet that is no longer a draft.
 */
import 'dotenv/config';
import { pool } from '../src/db/pool.js';
import { processConversation } from '../src/session/process.js';

const arg = process.argv[2];
if (!arg) {
  console.error('usage: tsx scripts/reextract.mts "<client name>" | <conversation-id>');
  process.exit(1);
}

const isUuid = /^[0-9a-f-]{36}$/i.test(arg);
const { rows } = await pool.query<{
  id: string;
  name: string | null;
  sheet_status: string | null;
}>(
  `SELECT c.id, cl.name,
          (SELECT s.status FROM appointment_sheets s WHERE s.appointment_id = c.appointment_id) AS sheet_status
     FROM conversations c
     LEFT JOIN clients cl ON cl.id = c.client_id
    WHERE ${isUuid ? 'c.id = $1' : 'cl.name ILIKE $1'}`,
  [isUuid ? arg : `%${arg}%`],
);

if (rows.length !== 1) {
  console.error(`matched ${rows.length} conversations; be more specific`);
  console.error(rows.map((r) => `  ${r.id}  ${r.name}`).join('\n'));
  process.exit(1);
}

const [row] = rows;
if (row.sheet_status && row.sheet_status !== 'draft') {
  console.error(`sheet is "${row.sheet_status}", not a draft — refusing to overwrite`);
  process.exit(1);
}

console.log(`re-extracting ${row.name} (${row.id})...`);
await pool.query(
  `UPDATE conversations
      SET extraction_status = 'pending', extraction_leased_at = NULL, extraction_error = NULL
    WHERE id = $1`,
  [row.id],
);
await processConversation(row.id);

const after = await pool.query(
  `SELECT c.extraction_status, c.extraction_error,
          jsonb_array_length(COALESCE(s.content_json->'evidence','[]'::jsonb)) AS evidence,
          s.content_json->'extraction'->'partial' AS partial,
          s.content_json->'extraction'->>'attribution_coverage' AS attribution,
          jsonb_array_length(COALESCE(s.content_json->'concerns','[]'::jsonb)) AS concerns,
          jsonb_array_length(COALESCE(s.content_json->'assessments','[]'::jsonb)) AS assessments,
          jsonb_array_length(COALESCE(s.content_json->'follow_ups','[]'::jsonb)) AS follow_ups
     FROM conversations c
     LEFT JOIN appointment_sheets s ON s.appointment_id = c.appointment_id
    WHERE c.id = $1`,
  [row.id],
);
console.log(after.rows[0]);
await pool.end();
