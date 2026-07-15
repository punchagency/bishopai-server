import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import PizZip from 'pizzip';
import Docxtemplater from 'docxtemplater';
import type { RofData } from './types';

// Fill Nicole's Report of Findings template (docx) via docxtemplater. Binary
// fidelity: her branded boilerplate (NRT program copy, diet list, payment plan)
// is untouched — we only substitute the {tags} inserted by scripts/prep-rof-template.mjs.
// Fill-once at intake; one ROF per client.

const TEMPLATE = join(__dirname, '../../../assets/templates/rof.docx');

/** Render the filled ROF as a .docx buffer. */
export function fillRof(data: RofData): Buffer {
  const zip = new PizZip(readFileSync(TEMPLATE));
  const doc = new Docxtemplater(zip, {
    paragraphLoop: true,
    linebreaks: true,
    // Missing values render empty rather than throwing, so a sparse session
    // (e.g. findings not yet captured) still produces a usable draft.
    nullGetter: () => '',
  });

  doc.render({
    name: data.name,
    date: data.date,
    symptoms: data.symptoms,
    goals: data.goals,
    pulse0: data.pulse0,
    priority1: data.priority1,
    k27: data.k27,
    stressors: data.stressors,
    protocol: data.protocol ?? [],
  });

  return doc.getZip().generate({ type: 'nodebuffer', compression: 'DEFLATE' });
}
