// Counts behind scripts/glyph-map-report.mjs for one embedded font.

import { mapSubsetGlyphsDetailed } from "../../src/decoder/glyphMap.js";
import { parseTrueType, pdfCodeToGlyph, componentGids } from "../../src/decoder/truetype.js";

/**
 * @param {{bytes: Uint8Array, usedCodes: Set<number>}} f an entry of embeddedTrueTypeFonts
 * @param {object} [table] master glyph table (defaults to the shipped one)
 */
export function glyphReport(f, table) {
  const r = mapSubsetGlyphsDetailed(f.bytes, table);
  const font = parseTrueType(f.bytes);
  const used = new Set(), undrawable = [], problems = [];
  for (const code of f.usedCodes) {
    const gid = pdfCodeToGlyph(font, code);
    if (gid > 0 && gid < font.numGlyphs) used.add(gid);
    else undrawable.push(code);
  }
  const drawableCodes = f.usedCodes.size - undrawable.length;
  if (used.size < drawableCodes) {
    problems.push(`${drawableCodes} distinct codes resolve to only ${used.size} glyphs`);
  }
  // Every subset glyph must be reachable: by some code (shown or not) or as
  // a component of a composite. A glyph that is neither means the
  // code-to-glyph resolution misses glyphs, and the counts would be short.
  const reachable = new Set();
  for (let code = 0; code < 256; code++) reachable.add(pdfCodeToGlyph(font, code));
  const components = new Set();
  for (let g = 0; g < font.numGlyphs; g++) for (const c of componentGids(font, g)) components.add(c);
  const componentOnly = [], notShown = [], stray = [];
  for (let g = 1; g < font.numGlyphs; g++) {
    if (used.has(g)) continue;
    if (reachable.has(g)) notShown.push(g);
    else if (components.has(g)) componentOnly.push(g);
    else stray.push(g);
  }
  if (stray.length) problems.push(`subset glyphs reachable by no code and no composite: ${stray.join(", ")}`);
  const matched = [...used].filter((g) => r.map.has(g));
  const unmatched = [...used].filter((g) => !r.map.has(g)).sort((a, b) => a - b);
  const via = {};
  for (const g of used) if (r.via.has(g)) via[r.via.get(g)] = (via[r.via.get(g)] || 0) + 1;
  return {
    matched, unmatched, undrawable, problems, componentOnly, notShown, via,
    unmatchedCount: unmatched.length + undrawable.length,
    numGlyphs: font.numGlyphs,
  };
}
