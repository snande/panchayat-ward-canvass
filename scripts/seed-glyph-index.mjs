#!/usr/bin/env node
// Add fallback shapes to src/decoder/master-glyph-table.json without the font:
//   node scripts/seed-glyph-index.mjs fixtures/badli-ward1.pdf [more.pdf ...]
//
// The offset and nearest-outline fallbacks of mapSubsetGlyphs compare a
// subset glyph's offset-free shape (outlineHash.js outlineShape) with
// index.shapes. scripts/build-glyph-table.mjs writes a shape for every entry
// when it is run on Arial Unicode MS. Because the font is not committed, this
// script fills index.shapes from roll PDFs instead. A subset glyph whose
// outline hash is an entry of the table *is* that master outline, since
// subsetting copies outlines unchanged, so its shape is the master's shape.
// It also records the space glyph (meta.spaceGid, meta.spaceAdvance), which
// has no outline and so is not in the table.
//
// The glyph entries are left byte-identical.

import { readFile } from "node:fs/promises";
import { embeddedTrueTypeFonts } from "../src/pdf/embeddedFonts.js";
import { parseTrueType } from "../src/decoder/truetype.js";
import { normaliseScale, outlineHash, outlineShape } from "../src/decoder/outlineHash.js";
import { writeTable } from "./lib/writeTable.mjs";

// Arial Unicode MS stores glyphs 0-9 in the standard Macintosh order
// (.notdef, .null, nonmarkingreturn, space, exclam, quotedbl, ...); the
// table's entries for glyphs 4-9 are exclam through ampersand, so the space
// is glyph 3. Its advance is 569 units at 2048 per em, as in Arial, and the
// empty subset glyph the roll draws for its word spaces has that advance.
const SPACE_GID = 3;
const SPACE_ADVANCE = 569;

const TABLE = "src/decoder/master-glyph-table.json";
const pdfs = process.argv.slice(2);
if (!pdfs.length) {
  console.error("usage: node scripts/seed-glyph-index.mjs <roll.pdf> [...]");
  process.exit(2);
}

const table = JSON.parse(await readFile(TABLE, "utf8"));
table.meta.spaceGid ??= SPACE_GID;
table.meta.spaceAdvance ??= SPACE_ADVANCE;
table.index ??= {};
const shapes = (table.index.shapes ??= {});
const before = Object.keys(shapes).length;

for (const path of pdfs) {
  for (const f of await embeddedTrueTypeFonts(await readFile(path))) {
    const font = parseTrueType(f.bytes);
    for (let gid = 1; gid < font.numGlyphs; gid++) {
      let contours;
      try { contours = normaliseScale(font.glyphContours(gid), font.unitsPerEm); } catch { continue; }
      const h = outlineHash(contours);
      if (h && table.glyphs[h] && !(h in shapes)) shapes[h] = outlineShape(contours);
    }
  }
}

// Keep the index in table order so rebuilds diff cleanly.
const ordered = {};
for (const h of Object.keys(table.glyphs)) if (h in shapes) ordered[h] = shapes[h];
const n = Object.keys(ordered).length, total = Object.keys(table.glyphs).length;
table.index = {
  coverage: n === total
    ? "every entry"
    : `${n} of ${total} entries, seeded from roll PDFs by scripts/seed-glyph-index.mjs; a rebuild from the font covers every entry`,
  shapes: ordered,
};
await writeTable(TABLE, table);
console.log(`index.shapes: ${before} -> ${n} of ${total} entries`);
