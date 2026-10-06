import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { mapSubsetGlyphs, mapSubsetGlyphsDetailed, NEAREST_TOLERANCE } from "../src/decoder/glyphMap.js";
import { parseTrueType, pdfCodeToGlyph, glyphContours } from "../src/decoder/truetype.js";
import { embeddedTrueTypeFonts } from "../src/pdf/embeddedFonts.js";
import table from "../src/decoder/master-glyph-table.json" with { type: "json" };
import { buildTrueType } from "./helpers/fontBuilder.js";

const fonts = await embeddedTrueTypeFonts(await readFile(new URL("../fixtures/badli-ward1.pdf", import.meta.url)));
const subset89 = fonts.find((f) => f.objNum === 89).bytes;
const byGid = new Map(Object.values(table.glyphs).map((e) => [e.gid, e]));

/** Flattened outlines of every glyph of the fixture subset, with a transform applied. */
function rebuilt(bytes, { scale = 1, dx = 0, dy = 0, unitsPerEm = 2048, edit } = {}) {
  const font = parseTrueType(bytes);
  const glyphs = [];
  for (let g = 0; g < font.numGlyphs; g++) {
    let contours = font.glyphContours(g).map((c) => c.map((p) => ({ x: p.x * scale + dx, y: p.y * scale + dy, on: p.on })));
    if (edit) contours = edit(g, contours);
    glyphs.push({ contours, advance: 569 * scale });
  }
  return buildTrueType({ glyphs, unitsPerEm });
}

test("mapSubsetGlyphs returns a Map of subset glyph id to master glyph id", () => {
  const m = mapSubsetGlyphs(subset89);
  assert.ok(m instanceof Map);
  // Pairs from badli-ward1.pdf, font object 89 (AAAAAB+ArialUnicodeMS).
  assert.equal(m.get(1), 1401); // ग uni0917
  assert.equal(m.get(3), 1411); // ड uni0921
  assert.equal(m.get(5), 1384); // आ uni0906
  assert.equal(m.get(20), 1415); // थ uni0925
  assert.equal(m.get(0), 0);
});

test("the mapped glyphs spell the roll's own words", () => {
  // The header "आयोग" is drawn with codes ) # * + in this font.
  const font = parseTrueType(subset89), m = mapSubsetGlyphs(subset89);
  const text = [...")#*+"].map((ch) => String.fromCodePoint(...byGid.get(m.get(pdfCodeToGlyph(font, ch.charCodeAt(0)))).codepoints)).join("");
  assert.equal(text, "आयोग");
});

test("matching never reads the subset's cmap or post table", () => {
  const scrubbed = Uint8Array.from(subset89);
  const font = parseTrueType(scrubbed);
  for (const tag of ["cmap", "post", "name", "OS/2"]) {
    const t = font.tables[tag];
    if (t) scrubbed.fill(0, t.offset, t.offset + t.length);
  }
  assert.deepEqual(mapSubsetGlyphs(scrubbed), mapSubsetGlyphs(subset89));
  // A font with no cmap table at all maps the same way.
  assert.deepEqual(mapSubsetGlyphs(rebuilt(subset89)), mapSubsetGlyphs(subset89));
});

test("units-per-em scale is normalised away", () => {
  const scaled = rebuilt(subset89, { scale: 2, unitsPerEm: 4096 });
  const r = mapSubsetGlyphsDetailed(scaled);
  assert.deepEqual(r.map, mapSubsetGlyphs(subset89));
  assert.equal(r.via.get(5), "hash");
});

test("offset is normalised away against the shipped table", () => {
  const moved = rebuilt(subset89, { dx: 37, dy: -11 });
  const r = mapSubsetGlyphsDetailed(moved);
  const want = mapSubsetGlyphs(subset89);
  for (const g of [1, 3, 5, 20]) {
    assert.equal(r.map.get(g), want.get(g), `glyph ${g}`);
    assert.equal(r.via.get(g), "offset");
  }
});

test("nearest-outline fallback accepts small differences and rejects large ones", () => {
  // Nudge the largest-x point of glyph 5 (आ) by d units.
  const nudge = (d) => (g, contours) => {
    if (g !== 5) return contours;
    let best = null;
    for (const c of contours) for (const p of c) if (!best || p.x > best.x) best = p;
    return contours.map((c) => c.map((p) => (p === best ? { ...p, x: p.x + d } : p)));
  };
  const near = mapSubsetGlyphsDetailed(rebuilt(subset89, { edit: nudge(3) }));
  assert.equal(near.map.get(5), 1384);
  assert.equal(near.via.get(5), "nearest");
  const far = mapSubsetGlyphsDetailed(rebuilt(subset89, { edit: nudge(NEAREST_TOLERANCE + 30) }));
  assert.ok(far.unmatched.includes(5));
  assert.equal(far.map.has(5), false);
});

test("nearest-outline fallback refuses a tie between different master glyphs", () => {
  const shape = "M 0,0|L 0,100|L 100,100|L 100,0|L 0,0";
  const synthetic = {
    meta: {},
    glyphs: { a: { gid: 10 }, b: { gid: 11 } },
    index: { shapes: { a: shape.replace("L 100,100", "L 102,100"), b: shape.replace("L 100,100", "L 98,100") } },
  };
  const square = { contours: [[{ x: 0, y: 0, on: true }, { x: 0, y: 100, on: true }, { x: 100, y: 100, on: true }, { x: 100, y: 0, on: true }]] };
  const r = mapSubsetGlyphsDetailed(buildTrueType({ glyphs: [{ contours: [] }, square] }), synthetic);
  assert.ok(r.unmatched.includes(1));
  const one = { ...synthetic, index: { shapes: { a: synthetic.index.shapes.a } } };
  const r1 = mapSubsetGlyphsDetailed(buildTrueType({ glyphs: [{ contours: [] }, square] }), one);
  assert.equal(r1.map.get(1), 10);
  assert.equal(r1.via.get(1), "nearest");
});

test("an empty glyph is the space only when its advance is the space's", () => {
  const bytes = buildTrueType({ glyphs: [{ contours: [] }, { contours: [], advance: 569 }, { contours: [], advance: 0 }] });
  const r = mapSubsetGlyphsDetailed(bytes);
  assert.equal(r.map.get(1), table.meta.spaceGid);
  assert.equal(r.via.get(1), "space");
  assert.ok(r.unmatched.includes(2), "a zero-width empty glyph is not the space");
  const noMeta = mapSubsetGlyphsDetailed(bytes, { glyphs: table.glyphs });
  assert.ok(noMeta.unmatched.includes(1), "no space record, no space match");
});

test("a point-matched component with missing points is unmatched, not guessed", () => {
  const square = { contours: [[{ x: 0, y: 0, on: true }, { x: 0, y: 9, on: true }, { x: 9, y: 9, on: true }]] };
  const bytes = buildTrueType({ glyphs: [{ contours: [] }, square, { components: [{ glyph: 1, dx: 0, dy: 0 }, { glyph: 1, match: [40, 0] }] }] });
  const font = parseTrueType(bytes);
  assert.throws(() => glyphContours(font, 2), /do not exist/);
  const r = mapSubsetGlyphsDetailed(bytes);
  assert.ok(r.unmatched.includes(2));
});
