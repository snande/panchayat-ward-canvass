// Usage: node scripts/glyph-map-report.mjs <roll.pdf>
//
// Prints one line per embedded Arial Unicode MS subset font:
//   <fontName> matched=<n> unmatched=<m>
// counting the glyphs the text layer uses, and exits non-zero if any of them
// fails to map to the master glyph table.

import { readFileSync } from 'node:fs';

import { analyseSubsetGlyphs } from '../src/decoder/glyphMap.js';
import { embeddedFonts } from './pdf-fonts.mjs';

const pdfPath = process.argv[2];
if (!pdfPath) {
  console.error('usage: node scripts/glyph-map-report.mjs <roll.pdf>');
  process.exit(2);
}

let failed = false;
let reported = 0;
for (const { fontName, program, usedGlyphs } of embeddedFonts(readFileSync(pdfPath))) {
  if (!/ArialUnicode/i.test(fontName)) continue;
  const { mapping } = analyseSubsetGlyphs(program);
  const used = [...usedGlyphs];
  const matched = used.filter((gid) => mapping.has(gid)).length;
  const unmatched = used.length - matched;
  console.log(`${fontName} matched=${matched} unmatched=${unmatched}`);
  if (unmatched) failed = true;
  reported++;
}
if (!reported) {
  console.error('no embedded Arial Unicode MS subset font found');
  failed = true;
}
process.exit(failed ? 1 : 0);
