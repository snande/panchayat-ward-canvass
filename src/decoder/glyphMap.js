// Map the glyphs of an embedded Arial Unicode MS subset to master-font glyph
// ids by outline matching. Only the subset's glyf/loca outlines are read; its
// cmap, post names and the PDF's ToUnicode map are never consulted, because
// in the roll PDFs they do not identify the real Devanagari glyphs.

import masterTable from "./master-glyph-table.json" with { type: "json" };
import { parseTrueType } from "./truetype.js";
import { normaliseScale, outlineHash, offsetFreeHash, coarseHash } from "./outlineHash.js";

// Glyphs without contours are not in the table (CANONICAL_OUTLINE.md). In
// Arial Unicode MS the space is glyph 3 (.notdef, .null, nonmarkingreturn,
// space; the table's first entry, exclam, is glyph 4).
export const MASTER_NOTDEF_GID = 0;
export const MASTER_SPACE_GID = 3;

/**
 * Match every glyph of a subset font program.
 * @param {Uint8Array|ArrayBuffer} fontProgramBytes raw FontFile2 stream data
 * @param {object} [table] master glyph table (defaults to the shipped one)
 * @returns {{map: Map<number, number>, matched: number[], unmatched: number[], via: Map<number, string>}}
 *   `via` records how each glyph matched: "hash", "offset", "coarse", "empty" or "notdef".
 */
export function mapSubsetGlyphsDetailed(fontProgramBytes, table = masterTable) {
  const font = parseTrueType(fontProgramBytes);
  const glyphs = table.glyphs;
  const index = table.index || {};
  const spaceGid = table.meta?.spaceGid ?? MASTER_SPACE_GID;
  const map = new Map(), via = new Map(), matched = [], unmatched = [];

  for (let gid = 0; gid < font.numGlyphs; gid++) {
    const contours = normaliseScale(font.glyphContours(gid), font.unitsPerEm);
    let masterGid, how;
    const h = outlineHash(contours);
    if (gid === 0) {
      // .notdef stays .notdef; it is never drawn by real text.
      masterGid = MASTER_NOTDEF_GID; how = "notdef";
    } else if (h === "") {
      masterGid = spaceGid; how = "empty";
    } else if (glyphs[h]) {
      masterGid = glyphs[h].gid; how = "hash";
    } else {
      // Fallbacks, available when the table was built with its index: the
      // same outline at another offset, then a unique coarse-grid match.
      const byOffset = index.offset?.[offsetFreeHash(contours)];
      const byCoarse = index.coarse?.[coarseHash(contours)];
      if (byOffset && glyphs[byOffset]) {
        masterGid = glyphs[byOffset].gid; how = "offset";
      } else if (byCoarse && byCoarse.length === 1 && glyphs[byCoarse[0]]) {
        masterGid = glyphs[byCoarse[0]].gid; how = "coarse";
      }
    }
    if (masterGid === undefined) {
      unmatched.push(gid);
    } else {
      map.set(gid, masterGid);
      via.set(gid, how);
      if (gid !== 0) matched.push(gid);
    }
  }
  return { map, matched, unmatched, via };
}

/**
 * @param {Uint8Array|ArrayBuffer} fontProgramBytes raw embedded subset font program
 * @returns {Map<number, number>} subset glyph id -> master-font glyph id
 */
export function mapSubsetGlyphs(fontProgramBytes, table = masterTable) {
  return mapSubsetGlyphsDetailed(fontProgramBytes, table).map;
}
