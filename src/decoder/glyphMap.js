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

async function loadMasterTable() {
  if (typeof process !== 'undefined' && process.versions && process.versions.node) {
    const nodeFs = 'node:fs/promises';
    const nodeUrl = 'node:url';
    const { readFile } = await import(/* @vite-ignore */ nodeFs);
    const { fileURLToPath } = await import(/* @vite-ignore */ nodeUrl);
    return JSON.parse(await readFile(fileURLToPath(TABLE_URL), 'utf8'));
  }
  const response = await fetch(TABLE_URL);
  if (!response.ok) throw new Error(`master glyph table: HTTP ${response.status}`);
  return response.json();
}

const defaultTable = await loadMasterTable();

// Python's round(): halves go to the even neighbour.
function roundHalfEven(v) {
  const r = Math.round(v);
  return Math.abs(v % 1) === 0.5 && r % 2 !== 0 ? r - 1 : r;
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
 * @param {Uint8Array|ArrayBuffer} fontProgramBytes raw embedded font program
 * @param {{glyphs: Record<string, object>}} [table] defaults to the committed table
 * @returns {{mapping: Map<number, object>, unmatched: number[]}}
 */
export function analyseSubsetGlyphs(fontProgramBytes, table = defaultTable) {
  const font = parseTrueType(fontProgramBytes);
  const mapping = new Map();
  const unmatched = [];
  for (let gid = 0; gid < font.numGlyphs; gid++) {
    const hash = outlineHash(font.contours(gid));
    const entry = hash === '' ? SPACE_ENTRY : table.glyphs[hash];
    if (entry) mapping.set(gid, entry);
    else unmatched.push(gid);
  }
  return { mapping, unmatched };
}

/**
 * Map each subset glyph ID to its entry (gid, name, kind, codepoints) in
 * master-glyph-table.json. Glyphs with no match are absent from the Map.
 * @param {Uint8Array|ArrayBuffer} fontProgramBytes raw embedded font program
 * @returns {Map<number, {gid: number|null, name: string, kind: string, codepoints: number[]}>}
 */
export function mapSubsetGlyphs(fontProgramBytes) {
  return analyseSubsetGlyphs(fontProgramBytes).mapping;
}
