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
// Two consistency checks guard the counts themselves: every glyph of the
// subset other than .notdef must be reachable by some code or be a component
// of a composite, and distinct shown codes must not collapse onto fewer
// glyphs. Either failing means the code-to-glyph resolution is wrong.

import { readFile } from "node:fs/promises";
import { embeddedTrueTypeFonts } from "../src/pdf/embeddedFonts.js";
import { glyphReport } from "./lib/glyphReport.mjs";

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
  const r = glyphReport(f);
  console.log(`${f.baseFont}@${f.objNum} matched=${r.matched.length} unmatched=${r.unmatchedCount}`);
  if (r.unmatched.length) console.log(`  unmatched subset glyph ids: ${r.unmatched.join(", ")}`);
  if (r.undrawable.length) console.log(`  codes with no glyph: ${r.undrawable.map((c) => "0x" + c.toString(16)).join(", ")}`);
  for (const problem of r.problems) console.log(`  ${problem}`);
  if (r.unmatchedCount || r.problems.length) failed = true;
  if (verbose) {
    console.log(`  codes shown=${f.usedCodes.size} glyphs in subset=${r.numGlyphs} matched via: ${JSON.stringify(r.via)}`);
    if (r.componentOnly.length) console.log(`  component-only glyphs (not drawn by the text): ${r.componentOnly.join(", ")}`);
    if (r.notShown.length) console.log(`  glyphs with a code the text never shows: ${r.notShown.join(", ")}`);
  }
}
process.exit(failed ? 1 : 0);
