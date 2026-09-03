/**
 * Re-render the booking block on queued emails — presentation only.
 *
 * An outbound_emails row stores its body already-injected, so a change to the
 * block only reaches new mail. Everything already sitting in the approval queue
 * keeps the markup it was queued with: the dark-theme palette whose heading
 * measured 1.2:1 on white, the Outlook-invisible gradient button, and labels
 * from the h11 formatter that printed noon as "0:00 pm".
 *
 * What this rewrites: the block's markup and each button's LABEL, re-derived
 * from the slot already present in the link.
 *
 * What it deliberately does NOT touch: the hrefs. Each carries an HMAC bound to
 * (leadId, slot, exp) and signed with BOOKING_LINK_SECRET, plus the public base
 * URL of the server that queued it. Rebuilding them anywhere that lacks the
 * secret — a laptop, say — yields unsigned links pointing at localhost, which is
 * far worse than the cosmetic bug being fixed. Carrying them through verbatim
 * makes this safe to run from anywhere.
 *
 * Refreshing the slots THEMSELVES (a week-old block offers times that may since
 * have been booked) is a different job: it needs the secret and the real base
 * URL, so it belongs on the server, not here.
 *
 * Only pending rows. Approved and sent mail is left alone — rewriting something
 * Nicole already approved would make it a different email than the one she said
 * yes to.
 *
 *   npx tsx scripts/refresh-slot-blocks.mts --dry-run
 *   npx tsx scripts/refresh-slot-blocks.mts
 */
import { pool } from '../src/db/pool';
import { renderSlotBlock, stripSlotBlock, SLOT_BLOCK_MARKER } from '../src/reengagement/runner';
import { loadOfficeHours } from '../src/routes/appointments';

const dryRun = process.argv.includes('--dry-run');

/** Every <a href="…">…</a> in the block, in order. */
const LINK = /<a\s[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;

/** The slot instant a booking link points at, or null if it carries none. */
function slotOf(href: string): string | null {
  const m = /[?&]slot=([^&"]+)/.exec(href);
  if (!m) return null;
  const iso = decodeURIComponent(m[1]);
  return Number.isFinite(Date.parse(iso)) ? iso : null;
}

/** The label the fixed formatter gives this instant. Mirrors formatSlotLabel. */
function labelFor(iso: string, tz: string): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: tz,
    weekday: 'long',
    hour: 'numeric',
    minute: '2-digit',
    hourCycle: 'h12',
  }).format(new Date(iso));
}

async function main(): Promise<void> {
  const oh = await loadOfficeHours();
  console.log(`Timezone: ${oh.timezone}`);

  const { rows } = await pool.query<{ id: string; to_email: string; body: string; send_after: string }>(
    `SELECT id, to_email, body, send_after
       FROM outbound_emails
      WHERE state = 'pending'
        AND (body LIKE '%${SLOT_BLOCK_MARKER}%' OR body LIKE '%Some available times%')
      ORDER BY send_after ASC`,
  );
  console.log(`${rows.length} pending row(s) carry a booking block.\n`);

  let changed = 0;
  let skipped = 0;

  for (const row of rows) {
    const idx = row.body.length - stripSlotBlock(row.body).length;
    const block = row.body.slice(row.body.length - idx);

    const links: { href: string; label: string }[] = [];
    let m: RegExpExecArray | null;
    LINK.lastIndex = 0;
    while ((m = LINK.exec(block)) !== null) {
      const href = m[1];
      const iso = slotOf(href);
      // Keep the original text when there is no slot to re-derive from, so an
      // unrecognised link is carried through rather than mislabelled.
      const fallback = m[2].replace(/<[^>]*>/g, '').replace(/📅\s*/g, '').replace(/Confirm &amp; Book\s*/i, '').trim();
      links.push({ href, label: iso ? labelFor(iso, oh.timezone) : fallback });
    }

    if (links.length === 0) {
      console.log(`  skip ${row.id} → ${row.to_email} (no booking links found)`);
      skipped++;
      continue;
    }

    const next = `${stripSlotBlock(row.body)}\n${renderSlotBlock(links)}`;
    if (next === row.body) continue;

    changed++;
    const relabelled = links.map((l) => l.label).join(', ');
    console.log(`  ${dryRun ? 'would update' : 'updated'} ${row.id} → ${row.to_email}`);
    console.log(`      ${links.length} button(s): ${relabelled}`);

    if (!dryRun) {
      await pool.query(`UPDATE outbound_emails SET body = $2 WHERE id = $1`, [row.id, next]);
    }
  }

  console.log(
    `\n${dryRun ? 'Dry run — nothing written.' : 'Done.'} ${changed} row(s) ${dryRun ? 'would change' : 'updated'}` +
      (skipped ? `, ${skipped} skipped.` : '.'),
  );
  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
