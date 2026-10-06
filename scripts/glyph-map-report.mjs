#!/usr/bin/env node
// Per-font glyph matching report for a roll PDF:
//   node scripts/glyph-map-report.mjs fixtures/badli-ward1.pdf [--verbose]
// prints one line per embedded Arial Unicode MS subset font,
//   <fontName> matched=<n> unmatched=<m>
// over the glyphs the text layer draws with that font, and exits 1 if any is
// unmatched. The font name is the BaseFont plus "@<object number>", because
// the roll reuses one subset tag for different subsets on different pages.
//
// Which glyph a shown code draws comes from the subset's cmap, exactly as a
// PDF viewer resolves it; the glyph's identity comes only from
// mapSubsetGlyphs, which matches outlines and never reads the cmap.
// Glyphs that are only components of composite glyphs are not drawn by the
// text and are not counted (the composites are matched as flattened outlines).

import { readFile } from "node:fs/promises";
import { embeddedTrueTypeFonts } from "../src/pdf/embeddedFonts.js";
import { mapSubsetGlyphsDetailed } from "../src/decoder/glyphMap.js";
import { parseTrueType, pdfCodeToGlyph } from "../src/decoder/truetype.js";

const path = process.argv[2];
const verbose = process.argv.includes("--verbose");
if (!path) {
  console.error("usage: node scripts/glyph-map-report.mjs <roll.pdf> [--verbose]");
  process.exit(2);
}

const fonts = await embeddedTrueTypeFonts(await readFile(path));
if (!fonts.length) {
  console.error(`${path}: no embedded Arial Unicode MS subset font found`);
  process.exit(1);
}
let failed = false;
for (const f of fonts) {
  const r = mapSubsetGlyphsDetailed(f.bytes);
  const font = parseTrueType(f.bytes);
  const used = new Set();
  const undrawable = [];
  for (const code of f.usedCodes) {
    const gid = pdfCodeToGlyph(font, code);
    if (gid > 0) used.add(gid);
    else undrawable.push(code);
  }
  const matched = [...used].filter((g) => r.map.has(g));
  const unmatched = [...used].filter((g) => !r.map.has(g)).sort((a, b) => a - b);
  const bad = unmatched.length + undrawable.length;
  console.log(`${f.baseFont}@${f.objNum} matched=${matched.length} unmatched=${bad}`);
  if (bad) {
    failed = true;
    if (unmatched.length) console.log(`  unmatched subset glyph ids: ${unmatched.join(", ")}`);
    if (undrawable.length) console.log(`  codes with no glyph: ${undrawable.map((c) => "0x" + c.toString(16)).join(", ")}`);
  }
  if (verbose) {
    const counts = {};
    for (const g of used) if (r.via.has(g)) counts[r.via.get(g)] = (counts[r.via.get(g)] || 0) + 1;
    console.log(`  codes shown=${f.usedCodes.size} glyphs in subset=${font.numGlyphs} matched via: ${JSON.stringify(counts)}`);
    if (r.unmatched.length) console.log(`  subset glyphs without a match (not drawn by the text): ${r.unmatched.join(", ")}`);
  }
}
process.exit(failed ? 1 : 0);
