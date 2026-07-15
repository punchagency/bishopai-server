// One-time prep: turn Nicole's bare ROF template into a docxtemplater template by
// inserting {tags} at the fill points. Reads the pristine original and writes the
// tagged template to assets/templates/rof.docx. Re-runnable (idempotent-ish:
// always regenerates from the pristine source), so if she revises her ROF we
// re-drop the original and re-run this.
//
//   node scripts/prep-rof-template.mjs <pristine-original.docx>
//
// Fill points (verified against the sample's document.xml):
//   inline labels: Name/Date, Symptoms, Goals, Pulse 0, Priority #1, K-27, Stressor(s)
//   protocol table: header row + empty styled rows -> first data row becomes a
//                   {#protocol} ... {/protocol} loop over {supplement}/{dosage}/{function}
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import PizZip from 'pizzip';

const here = dirname(fileURLToPath(import.meta.url));
const src = process.argv[2] || join(here, '../../sample docs/Leeza Woodbury ROF.docx');
const outPath = join(here, '../assets/templates/rof.docx');

const zip = new PizZip(readFileSync(src));
let xml = zip.file('word/document.xml').asText();

// --- Inline label fills: append the tag inside the label's own <w:t> run. ---
const t = (s) => `<w:t xml:space="preserve">${s}</w:t>`;
const inline = [
  // Name + Date share one run (Name is split as "Nam"+"e: ").
  [
    `${t('e: ')}<w:tab/><w:tab/><w:tab/><w:tab/>${t('Date: ')}`,
    `${t('e: {name}')}<w:tab/><w:tab/><w:tab/><w:tab/>${t('Date: {date}')}`,
  ],
  [t('Symptoms: '), t('Symptoms: {symptoms}')],
  [t('Goals: '), t('Goals: {goals}')],
  [t('Pulse 0: '), t('Pulse 0: {pulse0}')],
  [t('Priority #1: '), t('Priority #1: {priority1}')],
  [t('K-27:'), t('K-27: {k27}')],
  [t('Stressors(s):'), t('Stressors(s): {stressors}')],
];
for (const [from, to] of inline) {
  const n = xml.split(from).length - 1;
  if (n !== 1) throw new Error(`anchor not unique (found ${n}x): ${from}`);
  xml = xml.replace(from, to);
}

// --- Protocol table: make the first data row a docxtemplater row-loop. ---
// Locate the table that holds the "Supplement:" header.
const supIdx = xml.indexOf(t('Supplement:'));
const tblStart = xml.lastIndexOf('<w:tbl>', supIdx);
const tblEnd = xml.indexOf('</w:tbl>', supIdx) + '</w:tbl>'.length;
let tbl = xml.slice(tblStart, tblEnd);

const rows = tbl.match(/<w:tr\b[\s\S]*?<\/w:tr>/g);
if (!rows || rows.length < 2) throw new Error('protocol table: expected header + data rows');
const dataRow = rows[1];
const cells = dataRow.match(/<w:tc>[\s\S]*?<\/w:tc>/g);
if (!cells || cells.length !== 3) throw new Error(`protocol data row: expected 3 cells, got ${cells?.length}`);

const tags = ['{#protocol}{supplement}', '{dosage}', '{function}{/protocol}'];
const run = (txt) =>
  `<w:r><w:rPr><w:rFonts w:ascii="Roboto" w:cs="Roboto" w:eastAsia="Roboto" w:hAnsi="Roboto"/></w:rPr>` +
  `<w:t xml:space="preserve">${txt}</w:t></w:r>`;
const newCells = cells.map((cell, i) => {
  // Insert the tag run just before the cell paragraph's closing </w:p>.
  const at = cell.lastIndexOf('</w:p>');
  return cell.slice(0, at) + run(tags[i]) + cell.slice(at);
});
let newDataRow = dataRow;
cells.forEach((cell, i) => {
  newDataRow = newDataRow.replace(cell, newCells[i]);
});
tbl = tbl.replace(dataRow, newDataRow);
xml = xml.slice(0, tblStart) + tbl + xml.slice(tblEnd);

zip.file('word/document.xml', xml);
writeFileSync(outPath, zip.generate({ type: 'nodebuffer', compression: 'DEFLATE' }));
console.log('wrote tagged template ->', outPath);
