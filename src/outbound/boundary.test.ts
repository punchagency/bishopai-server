import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

// The invariant the approval gate rests on.
//
// Every guarantee here — that Nicole sees an email before a client does — reduces
// to one fact: automated code does not call sendEmail(). That is not something a
// type can express and not something a reviewer reliably notices, because the
// natural way to add a new notification is to import the mailer and use it. This
// test is what makes that mistake loud.
//
// The allowlist is deliberately short, and each entry is a decision someone made
// on purpose rather than a file that happened to need mailing.

const SRC = join(__dirname, '..');

/** Why each of these is allowed to send without passing through the queue. */
const ALLOWED = new Map([
  [
    'integrations/outlook/index.ts',
    'the transport itself — everything below ends up here',
  ],
  [
    'outbound/queue.ts',
    'the gate: sendApproved() is the only automated path, and it sends nothing unapproved',
  ],
  [
    'reengagement/runner.ts',
    'only Nicole pressing send on one lead — the cadence itself queues every step, welcome included',
  ],
  [
    'session/publishTemplates.ts',
    'protocol documents, mailed downstream of Nicole approving that exact note in review',
  ],
  [
    'brief/morningDigest.ts',
    'Nicole’s own daily digest — not a client email at all',
  ],
]);

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      sourceFiles(full, out);
      continue;
    }
    if (entry.endsWith('.ts') && !entry.endsWith('.test.ts')) out.push(full);
  }
  return out;
}

describe('outbound send boundary', () => {
  it('lets only the allowlisted files send email directly', () => {
    const offenders: string[] = [];
    for (const file of sourceFiles(SRC)) {
      const rel = relative(SRC, file).split('\\').join('/');
      if (ALLOWED.has(rel)) continue;
      const text = readFileSync(file, 'utf8');
      // The import is the thing that matters: a file that cannot reach the
      // mailer cannot bypass the queue, whatever it does internally.
      if (/from '[^']*integrations\/outlook'/.test(text) && /\bsendEmail\b/.test(text)) {
        offenders.push(rel);
      }
    }
    expect(
      offenders,
      `these send email without going through the approval queue:\n  ${offenders.join('\n  ')}\n` +
        'Automated client email must call queueEmail() from src/outbound/queue.ts. ' +
        'If this send genuinely should bypass review, add it to ALLOWED with the reason.',
    ).toEqual([]);
  });

  it('keeps the cadence runner off the automated send path', () => {
    // runner.ts stays allowlisted for the one manual path (Nicole pressing send
    // on a single lead), but the AUTOMATED pass must not reach the mailer. If
    // processLead ever calls sendEmail again, the queue is no longer the only
    // way an unattended email reaches a client — which is the whole guarantee.
    const src = readFileSync(join(SRC, 'reengagement/runner.ts'), 'utf8');
    const processLead = src.slice(
      src.indexOf('async function processLead'),
      src.indexOf('export async function runReengagement'),
    );
    expect(processLead.length).toBeGreaterThan(200); // the slice actually found it
    expect(processLead).not.toMatch(/\bsendEmail\b/);
    expect(processLead).toMatch(/\bqueueEmail\b/);
  });

  it('states a reason for every exemption', () => {
    // An allowlist without reasons becomes a list nobody dares to shorten.
    for (const [file, reason] of ALLOWED) {
      expect(reason.length, `${file} needs a reason`).toBeGreaterThan(20);
    }
  });
});
