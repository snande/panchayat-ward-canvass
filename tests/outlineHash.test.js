import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  roundHalfEven, canonicalOutline, outlineHash, outlineShape, normaliseScale, shapeGeometry, shapeDistance,
} from "../src/decoder/outlineHash.js";
import { parseTrueType } from "../src/decoder/truetype.js";
import { embeddedTrueTypeFonts } from "../src/pdf/embeddedFonts.js";
import table from "../src/decoder/master-glyph-table.json" with { type: "json" };

const on = (x, y) => ({ x, y, on: true });
const off = (x, y) => ({ x, y, on: false });

test("roundHalfEven matches Python round() on halves", () => {
  const cases = [[0.5, 0], [-0.5, 0], [1.5, 2], [-1.5, -2], [2.5, 2], [-2.5, -2], [3.5, 4], [-3.5, -4], [0.4, 0], [-0.6, -1], [7, 7]];
  for (const [v, want] of cases) assert.equal(roundHalfEven(v) + 0, want, `round(${v})`);
});

test("canonicalOutline closes, rotates to the smallest point and writes L segments", () => {
  assert.equal(canonicalOutline([[on(10, 0), on(0, 0), on(0, 10), on(10, 10)]]), "M 0,0|L 0,10|L 10,10|L 10,0|L 0,0");
});

test("implied on-curve points are truncated toward zero, like Python int()", () => {
  // Two off-curve points between A and D: the implied midpoint (-4.5, 10) becomes -4.
  const c = [on(0, 0), off(-3, 10), off(-6, 10), on(-10, 0)];
  assert.equal(canonicalOutline([c]), "M -10,0|L 0,0|Q -3,10 -4,10|Q -6,10 -10,0");
});

test("contours are sorted as strings, so contour order does not matter", () => {
  const a = [on(0, 0), on(0, 5), on(5, 5)], b = [on(100, 100), on(100, 105), on(105, 105)];
  assert.equal(outlineHash([a, b]), outlineHash([b, a]));
  assert.equal(outlineHash([]), "");
});

test("scale and offset normalisation", () => {
  const c = [[on(10, 20), off(30, 60), on(50, 20)]];
  const doubled = c.map((k) => k.map((p) => ({ ...p, x: p.x * 2, y: p.y * 2 })));
  assert.equal(outlineHash(normaliseScale(doubled, 4096)), outlineHash(c));
  const moved = c.map((k) => k.map((p) => ({ ...p, x: p.x + 37, y: p.y - 11 })));
  assert.notEqual(outlineHash(moved), outlineHash(c));
  assert.equal(outlineShape(moved), outlineShape(c));
  const nudged = [[on(10, 20), off(33, 60), on(50, 20)]];
  assert.equal(shapeDistance(shapeGeometry(outlineShape(nudged)), shapeGeometry(outlineShape(c))), 3);
  assert.equal(shapeDistance(shapeGeometry(outlineShape(c)), shapeGeometry("M 0,0|L 1,1")), Infinity);
});

test("subset glyph hashes from the fixture are keys of master-glyph-table.json", async () => {
  const fonts = await embeddedTrueTypeFonts(await readFile(new URL("../fixtures/badli-ward1.pdf", import.meta.url)));
  const f = fonts.find((x) => x.objNum === 89);
  const font = parseTrueType(f.bytes);
  // Subset glyph 5 is आ (uni0906), glyph 1 is ग (uni0917): their canonical
  // outlines hash to the entries the Python reference wrote.
  for (const [gid, name] of [[5, "uni0906"], [1, "uni0917"], [20, "uni0925"]]) {
    const e = table.glyphs[outlineHash(font.glyphContours(gid))];
    assert.ok(e, `glyph ${gid} hash is in the table`);
    assert.equal(e.name, name);
  }
});
