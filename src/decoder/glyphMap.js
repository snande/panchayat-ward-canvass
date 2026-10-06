// Map the glyphs of an embedded Arial Unicode MS subset to master-font glyph
// ids by outline matching. Only the subset's glyf/loca outlines (and, for a
// glyph with no outline, its advance width) are read; its cmap, post names
// and the PDF's ToUnicode map are never consulted, because in the roll PDFs
// they do not identify the real Devanagari glyphs.

import masterTable from "./master-glyph-table.json" with { type: "json" };
import { parseTrueType, advanceWidth } from "./truetype.js";
import {
  CANONICAL_UNITS_PER_EM, normaliseScale, outlineHash, outlineShape, shapeGeometry, shapeDistance,
} from "./outlineHash.js";

export const MASTER_NOTDEF_GID = 0;

/**
 * Largest coordinate difference (font units at 2048 per em) the
 * nearest-outline fallback accepts between a subset glyph and a master glyph
 * of the same structure.
 */
export const NEAREST_TOLERANCE = 8;

// Per-table lookups derived from table.index.shapes, built on first use.
const derived = new WeakMap();
function lookups(table) {
  let d = derived.get(table);
  if (d) return d;
  const byShape = new Map(), bySkeleton = new Map();
  for (const [hash, shape] of Object.entries(table.index?.shapes || {})) {
    if (!table.glyphs[hash]) continue;
    if (!byShape.has(shape)) byShape.set(shape, hash);
    const geom = shapeGeometry(shape);
    if (!bySkeleton.has(geom.skeleton)) bySkeleton.set(geom.skeleton, []);
    bySkeleton.get(geom.skeleton).push({ hash, geom });
  }
  d = { byShape, bySkeleton };
  derived.set(table, d);
  return d;
}

/** Master entry whose shape is within NEAREST_TOLERANCE of `shape`, if exactly one gid is nearest. */
function nearest(table, shape) {
  const geom = shapeGeometry(shape);
  let best = Infinity, hits = [];
  for (const cand of lookups(table).bySkeleton.get(geom.skeleton) || []) {
    const d = shapeDistance(geom, cand.geom);
    if (d > NEAREST_TOLERANCE || d > best) continue;
    if (d < best) { best = d; hits = []; }
    hits.push(cand.hash);
  }
  const gids = new Set(hits.map((h) => table.glyphs[h].gid));
  return gids.size === 1 ? hits[0] : undefined;
}

/**
 * Match every glyph of a subset font program.
 * @param {Uint8Array|ArrayBuffer} fontProgramBytes raw FontFile2 stream data
 * @param {object} [table] master glyph table (defaults to the shipped one)
 * @returns {{map: Map<number, number>, matched: number[], unmatched: number[], via: Map<number, string>}}
 *   `via` records how each glyph matched: "hash" (exact canonical outline),
 *   "offset" (same outline at another offset), "nearest" (same structure,
 *   coordinates within NEAREST_TOLERANCE), "space" or "notdef".
 */
export function mapSubsetGlyphsDetailed(fontProgramBytes, table = masterTable) {
  const font = parseTrueType(fontProgramBytes);
  const glyphs = table.glyphs;
  const { byShape } = lookups(table);
  const scale = CANONICAL_UNITS_PER_EM / (font.unitsPerEm || CANONICAL_UNITS_PER_EM);
  const map = new Map(), via = new Map(), matched = [], unmatched = [];

  for (let gid = 0; gid < font.numGlyphs; gid++) {
    let masterGid, how;
    if (gid === 0) {
      // .notdef stays .notdef; it is never drawn by real text.
      masterGid = MASTER_NOTDEF_GID; how = "notdef";
    } else {
      let contours = null;
      try {
        contours = normaliseScale(font.glyphContours(gid), font.unitsPerEm);
      } catch {
        // A glyph whose outline cannot be read is left unmatched, never guessed.
      }
      const h = contours && outlineHash(contours);
      if (contours === null) {
        // unmatched
      } else if (h === "") {
        // No contours: not in the table. It is the space only if its advance
        // is the master space's advance.
        const adv = advanceWidth(font, gid);
        const want = table.meta?.spaceAdvance;
        if (table.meta?.spaceGid !== undefined && want !== undefined && adv !== null && Math.abs(adv * scale - want) <= 1) {
          masterGid = table.meta.spaceGid; how = "space";
        }
      } else if (glyphs[h]) {
        masterGid = glyphs[h].gid; how = "hash";
      } else {
        const shape = outlineShape(contours);
        const byOffset = byShape.get(shape);
        if (byOffset) {
          masterGid = glyphs[byOffset].gid; how = "offset";
        } else {
          const near = nearest(table, shape);
          if (near) { masterGid = glyphs[near].gid; how = "nearest"; }
        }
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
