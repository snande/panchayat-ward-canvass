// Maps the glyphs of an embedded Arial Unicode MS subset font to the master
// font's glyph identity by outline matching.
//
// Each subset glyph's outline is reduced to the canonical outline string
// defined in CANONICAL_OUTLINE.md, hashed with SHA-256 and looked up in the
// committed master-glyph-table.json. The subset's cmap and ToUnicode are
// never consulted: in these PDFs they do not describe real Devanagari.
//
// Port of canonical()/glyph_hash() in tools/reference-decoder/glyphtable.py;
// do not change the normalisation or the committed hashes stop matching.
// No OCR, no Kruti Dev mapping and no network call beyond loading the
// table's own static file; runs in the browser and in Node.
//
// The table is loaded lazily, never at import time: a browser caller awaits
// loadMasterTable() (and can catch and report its failure) before calling
// mapSubsetGlyphs, or passes the table in explicitly. In Node (Node 20.16+
// or 22.3+, see package.json engines) a call with no table reads the
// committed file synchronously.

import { parseTrueType } from './trueTypeGlyphs.js';
import { sha256Hex } from './sha256.js';

const TABLE_URL = new URL('./master-glyph-table.json', import.meta.url);

/** Entry for a glyph with an empty outline: the space is not in the table. */
export const SPACE_ENTRY = Object.freeze({
  gid: null,
  name: 'space',
  kind: 'base',
  codepoints: Object.freeze([0x20]),
});

let loadedTable = null;

const inNode = () => typeof globalThis.document === 'undefined'
  && typeof globalThis.process !== 'undefined'
  && Boolean(globalThis.process.versions && globalThis.process.versions.node);

/**
 * Load (once) the committed master glyph table. Rejects with an Error
 * "decoder table could not be loaded" if the file cannot be read or parsed;
 * a failure is not cached, so a later call retries.
 * @param {URL} [url] defaults to the committed table next to this module
 * @returns {Promise<{glyphs: Record<string, object>}>}
 */
export async function loadMasterTable(url = TABLE_URL) {
  if (loadedTable && url === TABLE_URL) return loadedTable;
  try {
    let table;
    if (inNode()) {
      const nodeFs = 'node:fs/promises';
      const nodeUrl = 'node:url';
      const { readFile } = await import(/* @vite-ignore */ nodeFs);
      const { fileURLToPath } = await import(/* @vite-ignore */ nodeUrl);
      table = JSON.parse(await readFile(fileURLToPath(url), 'utf8'));
    } else {
      const response = await fetch(url);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      table = await response.json();
    }
    if (!table || typeof table.glyphs !== 'object') throw new Error('no glyphs object');
    if (url === TABLE_URL) loadedTable = table;
    return table;
  } catch (cause) {
    throw new Error(`decoder table could not be loaded: ${cause.message}`, { cause });
  }
}

// Table for a call that passed none: the one loadMasterTable() cached, or in
// Node (scripts, tests) a synchronous read of the committed file.
function defaultTable() {
  if (loadedTable) return loadedTable;
  const nodeProcess = globalThis.process;
  if (inNode() && typeof nodeProcess.getBuiltinModule === 'function') {
    const fs = nodeProcess.getBuiltinModule('node:fs');
    const url = nodeProcess.getBuiltinModule('node:url');
    loadedTable = JSON.parse(fs.readFileSync(url.fileURLToPath(TABLE_URL), 'utf8'));
    return loadedTable;
  }
  throw new Error('master glyph table not loaded: await loadMasterTable() first, or pass the table');
}

// Python's round(): halves go to the even neighbour. Never returns -0.
export function roundHalfEven(v) {
  const floor = Math.floor(v);
  const diff = v - floor;
  const r = diff < 0.5 ? floor : diff > 0.5 ? floor + 1 : floor % 2 === 0 ? floor : floor + 1;
  return r + 0;
}

// Python's floor division by two, and int() truncation of a float midpoint.
const floorMid = (a, b) => Math.floor((a + b) / 2);
const truncMid = (a, b) => Math.trunc((a + b) / 2);

// A run of off-curve points ending in an on-curve point, as quadratic
// segments split at the implied on-curve midpoints (decomposeQuadraticSegment).
function quadraticRun(points) {
  const segs = [];
  for (let i = 0; i < points.length - 1; i++) {
    const off = points[i];
    const next = points[i + 1];
    const on = i < points.length - 2
      ? [truncMid(off[0], next[0]), truncMid(off[1], next[1])]
      : next;
    segs.push({ op: 'Q', c: off, p: on });
  }
  return segs;
}

// One contour as { start, segs }, following how fontTools draws a glyf
// contour: it starts at the first on-curve point, and the closing line back
// to it is left implicit.
function drawContour(contour) {
  const pts = contour.map((p) => ({ x: roundHalfEven(p.x), y: roundHalfEven(p.y), on: p.on }));
  const firstOn = pts.findIndex((p) => p.on);
  if (firstOn < 0) {
    // No on-curve point: synthetic start at the midpoint of the first two off-curve points.
    const mid = [floorMid(pts[0].x, pts[1].x), floorMid(pts[0].y, pts[1].y)];
    const seq = [...pts.slice(1), pts[0]].map((p) => [p.x, p.y]);
    seq.push(mid);
    return { start: mid, segs: quadraticRun(seq) };
  }
  let rest = [...pts.slice(firstOn + 1), ...pts.slice(0, firstOn + 1)];
  const start = [rest[rest.length - 1].x, rest[rest.length - 1].y];
  const segs = [];
  while (rest.length) {
    const n = rest.findIndex((p) => p.on) + 1;
    if (n === 1) {
      if (rest.length > 1) segs.push({ op: 'L', p: [rest[0].x, rest[0].y] });
    } else {
      segs.push(...quadraticRun(rest.slice(0, n).map((p) => [p.x, p.y])));
    }
    rest = rest.slice(n);
  }
  return { start, segs };
}

const compare = (a, b) => (a[0] - b[0]) || (a[1] - b[1]);

function contourString({ start, segs }) {
  const last = segs.length ? segs[segs.length - 1].p : start;
  if (compare(last, start) !== 0) segs.push({ op: 'L', p: start });
  if (!segs.length) return `M ${start[0]},${start[1]}`;
  let k = 0;
  for (let i = 1; i < segs.length; i++) if (compare(segs[i].p, segs[k].p) < 0) k = i;
  const rotated = [...segs.slice(k + 1), ...segs.slice(0, k + 1)];
  const parts = [`M ${segs[k].p[0]},${segs[k].p[1]}`];
  for (const s of rotated) {
    parts.push(s.op === 'L'
      ? `L ${s.p[0]},${s.p[1]}`
      : `Q ${s.c[0]},${s.c[1]} ${s.p[0]},${s.p[1]}`);
  }
  return parts.join('|');
}

/**
 * Canonical outline string of a glyph (CANONICAL_OUTLINE.md); '' when empty.
 * @param {Array<Array<{x:number,y:number,on:boolean}>>} contours
 */
export function canonicalOutline(contours) {
  return contours.map((c) => contourString(drawContour(c))).sort().join(';');
}

/** Lowercase hex SHA-256 of the canonical outline; '' for an empty glyph. */
export function outlineHash(contours) {
  const s = canonicalOutline(contours);
  return s ? sha256Hex(s) : '';
}

/**
 * Match every glyph of a subset font program against the master glyph table.
 * A glyph whose outline cannot be read (truncated or malformed glyf data) is
 * reported as unmatched rather than aborting the whole font.
 * @param {Uint8Array|ArrayBuffer} fontProgramBytes raw embedded font program
 * @param {{glyphs: Record<string, object>}} [table] defaults to the committed table
 * @returns {{mapping: Map<number, object>, unmatched: number[], contours: (gid: number) => object[]}}
 * @throws {Error} "embedded font is not a readable TrueType subset" for a CFF or truncated program
 */
export function analyseSubsetGlyphs(fontProgramBytes, table) {
  let font;
  try {
    font = parseTrueType(fontProgramBytes);
  } catch (cause) {
    throw new Error(`embedded font is not a readable TrueType subset: ${cause.message}`, { cause });
  }
  const glyphs = (table ?? defaultTable()).glyphs;
  const mapping = new Map();
  const unmatched = [];
  for (let gid = 0; gid < font.numGlyphs; gid++) {
    let entry;
    try {
      const hash = outlineHash(font.contours(gid));
      entry = hash === '' ? SPACE_ENTRY : Object.hasOwn(glyphs, hash) ? glyphs[hash] : undefined;
    } catch {
      entry = undefined;
    }
    if (entry) mapping.set(gid, entry);
    else unmatched.push(gid);
  }
  return { mapping, unmatched, contours: font.contours };
}

/**
 * Map each subset glyph ID to its entry (gid, name, kind, codepoints) in
 * master-glyph-table.json. Glyphs with no match are absent from the Map.
 * @param {Uint8Array|ArrayBuffer} fontProgramBytes raw embedded font program
 * @param {{glyphs: Record<string, object>}} [table] defaults to the committed table
 * @returns {Map<number, {gid: number|null, name: string, kind: string, codepoints: number[]}>}
 */
export function mapSubsetGlyphs(fontProgramBytes, table) {
  return analyseSubsetGlyphs(fontProgramBytes, table).mapping;
}
