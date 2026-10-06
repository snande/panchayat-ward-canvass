import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { embeddedTrueTypeFonts } from "../src/pdf/embeddedFonts.js";
import { parseTrueType, pdfCodeToGlyph } from "../src/decoder/truetype.js";
import { glyphReport } from "../scripts/lib/glyphReport.mjs";
import { buildTrueType } from "./helpers/fontBuilder.js";

const tri = (x) => ({ contours: [[{ x, y: 0, on: true }, { x, y: 50, on: true }, { x: x + 50, y: 50, on: true }]] });

test("every Arial Unicode MS subset in the benchmark roll maps with 0 unmatched", async () => {
  const fonts = await embeddedTrueTypeFonts(await readFile(new URL("../fixtures/badli-ward1.pdf", import.meta.url)));
  assert.equal(fonts.length, 4);
  for (const f of fonts) {
    const r = glyphReport(f);
    assert.equal(r.unmatchedCount, 0, `${f.baseFont}@${f.objNum}`);
    assert.deepEqual(r.problems, [], `${f.baseFont}@${f.objNum}`);
    assert.equal(r.matched.length, f.usedCodes.size);
  }
  // Glyphs 2 and 4 of the AAAAAB subsets are only components of composites.
  assert.deepEqual(glyphReport(fonts[0]).componentOnly, [2, 4]);
});

test("a Mac (1,0)-only font resolves codes", () => {
  const bytes = buildTrueType({ glyphs: [{ contours: [] }, tri(0), tri(100)], cmap: { platform: 1, encoding: 0, map: { 65: 1, 66: 2 } } });
  const font = parseTrueType(bytes);
  assert.equal(pdfCodeToGlyph(font, 65), 1);
  assert.equal(pdfCodeToGlyph(font, 66), 2);
  assert.equal(pdfCodeToGlyph(font, 67), 0);
});

test("a symbolic (3,0) font resolves codes at 0xF000 + code or at the code", () => {
  const bytes = buildTrueType({ glyphs: [{ contours: [] }, tri(0)], cmap: { platform: 3, encoding: 0, map: { 0x41: 1 } } });
  assert.equal(pdfCodeToGlyph(parseTrueType(bytes), 0x41), 1);
});

test("the report flags glyphs the code-to-glyph resolution cannot reach", () => {
  // Glyph 2 has no code and is no component: a broken cmap lookup looks like this.
  const bytes = buildTrueType({ glyphs: [{ contours: [] }, tri(0), tri(100)], cmap: { platform: 1, encoding: 0, map: { 65: 1 } } });
  const r = glyphReport({ bytes, usedCodes: new Set([65]) });
  assert.match(r.problems.join("\n"), /reachable by no code and no composite: 2/);
});

test("the report flags distinct codes collapsing onto fewer glyphs", () => {
  const bytes = buildTrueType({ glyphs: [{ contours: [] }, tri(0)], cmap: { platform: 1, encoding: 0, map: { 65: 1, 66: 1 } } });
  const r = glyphReport({ bytes, usedCodes: new Set([65, 66]) });
  assert.match(r.problems.join("\n"), /2 distinct codes resolve to only 1 glyphs/);
});

test("codes without a glyph count as unmatched", () => {
  const bytes = buildTrueType({ glyphs: [{ contours: [] }, tri(0)], cmap: { platform: 1, encoding: 0, map: { 65: 1 } } });
  const r = glyphReport({ bytes, usedCodes: new Set([65, 90]) });
  assert.deepEqual(r.undrawable, [90]);
  assert.ok(r.unmatchedCount >= 1);
});
