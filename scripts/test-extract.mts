#!/usr/bin/env node
/**
 * Quick smoke-test: run extractSessionNote against a local transcript file.
 * Usage:  tsx scripts/test-extract.mts <path-to-transcript>
 *
 * Requires ANTHROPIC_API_KEY (or GOOGLE_API_KEY) to be set in .env
 */
import 'dotenv/config';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { extractSessionNote } from '../src/session/extract.js';

const filePath = process.argv[2];
if (!filePath) {
  console.error('Usage: tsx scripts/test-extract.mts <path-to-transcript>');
  process.exit(1);
}

const transcript = readFileSync(resolve(filePath), 'utf8');
console.log(`\n📄 Transcript loaded (${transcript.length} chars)\n`);
console.log('⏳ Sending to Claude for extraction...\n');

try {
  const note = await extractSessionNote(transcript);

  console.log('✅ Extraction complete!\n');
  console.log('═'.repeat(60));

  if (note.concerns.length) {
    console.log('\n🩺 CLIENT CONCERNS:');
    note.concerns.forEach(c => console.log(`   • ${c}`));
  }

  if (note.assessments.length) {
    console.log('\n📋 ASSESSMENTS:');
    note.assessments.forEach(a => console.log(`   • ${a}`));
  }

  if (note.nrt) {
    const nrt = note.nrt;
    const filled = Object.entries(nrt).filter(([, v]) => v);
    if (filled.length) {
      console.log('\n🔬 NRT FINDINGS:');
      filled.forEach(([k, v]) => console.log(`   ${k}: ${v}`));
    }
  }

  if (note.lifestyle) {
    const ls = note.lifestyle;
    const filled = Object.entries(ls).filter(([, v]) => v);
    if (filled.length) {
      console.log('\n🌿 LIFESTYLE LOG:');
      filled.forEach(([k, v]) => console.log(`   ${k}: ${v}`));
    }
  }

  if (note.supplements.length) {
    console.log('\n💊 SUPPLEMENTS:');
    note.supplements.forEach(s => {
      const dose = s.dose ? ` — ${s.dose}` : '';
      const qty  = s.quantity ? ` (qty: ${s.quantity})` : '';
      console.log(`   [${s.change.toUpperCase()}] ${s.name}${dose}${qty}`);
    });
  }

  if (note.protocol_changes.length) {
    console.log('\n🔄 PROTOCOL CHANGES:');
    note.protocol_changes.forEach(p => console.log(`   [${p.type.toUpperCase()}] ${p.description}`));
  }

  if (note.follow_ups.length) {
    console.log('\n📌 FOLLOW-UPS:');
    note.follow_ups.forEach(f => {
      if (typeof f === 'string') { console.log(`   • ${f}`); return; }
      const due = f.due_in_days ? ` (in ${f.due_in_days} days)` : '';
      console.log(`   • ${f.text}${due}`);
    });
  }

  console.log('\n' + '═'.repeat(60));
  console.log('\n📦 Raw JSON:\n');
  console.log(JSON.stringify(note, null, 2));
} catch (err) {
  console.error('❌ Extraction failed:', err);
  process.exit(1);
}
