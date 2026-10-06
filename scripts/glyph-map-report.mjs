// Usage: node scripts/glyph-map-report.mjs <roll.pdf>
//
// Prints one line per embedded Arial Unicode MS subset font:
//   <fontName> matched=<n> unmatched=<m>
// counting the glyphs the text layer uses, and exits non-zero if any of them
// fails to map to the master glyph table, if a font's text layer uses no
// glyphs (the extractor did not understand the PDF) or if the PDF or a font
// cannot be read.

import { readFileSync } from 'node:fs';

import { analyseSubsetGlyphs } from '../src/decoder/glyphMap.js';
import { embeddedFonts } from './pdf-fonts.mjs';

const pdfPath = process.argv[2];
if (!pdfPath) {
  console.error('usage: node scripts/glyph-map-report.mjs <roll.pdf>');
  process.exit(2);
}

function fail(message) {
  console.error(`glyph-map-report: ${pdfPath}: ${message}`);
  process.exit(1);
}

let fonts;
try {
  fonts = embeddedFonts(readFileSync(pdfPath));
} catch (err) {
  fail(`cannot read the PDF's embedded fonts (${err.message})`);
}

let failed = false;
let reported = 0;
for (const { fontName, program, usedGlyphs } of fonts) {
  if (!/ArialUnicode/i.test(fontName)) continue;
  let mapping;
  try {
    ({ mapping } = analyseSubsetGlyphs(program));
  } catch (err) {
    fail(`${fontName}: ${err.message}`);
  }
  const used = [...usedGlyphs];
  const matched = used.filter((gid) => mapping.has(gid)).length;
  const unmatched = used.length - matched;
  console.log(`${fontName} matched=${matched} unmatched=${unmatched}`);
  if (unmatched) failed = true;
  if (!used.length) {
    console.error(`glyph-map-report: ${pdfPath}: ${fontName}: no glyphs found on the text layer`);
    failed = true;
  }
  reported++;
}
if (!reported) {
  console.error(`glyph-map-report: ${pdfPath}: no embedded Arial Unicode MS subset font found`);
  failed = true;
}
process.exit(failed ? 1 : 0);
