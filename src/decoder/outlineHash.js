// Canonical outline string and hash, specified in CANONICAL_OUTLINE.md and
// matching tools/reference-decoder/glyphtable.py (canonical, contours_from_pen)
// exactly. The reference walks fontTools' pen protocol, so this module first
// rebuilds the same pen segments from the raw TrueType points.

import { sha256Hex } from "./sha256.js";

export const CANONICAL_UNITS_PER_EM = 2048;

/** Python's round(): halves round to the even neighbour. */
export function roundHalfEven(v) {
  const r = Math.round(v);
  return Math.abs(v % 1) === 0.5 ? 2 * Math.round(v / 2) : r;
}

/**
 * Segments of one contour as fontTools' TrueType pen emits them, with points
 * rounded to integers: [["M",[x,y]], ["L",[x,y]] | ["Q",[cx,cy,x,y]], ...].
 */
function contourSegments(points) {
  const pts = points.map((p) => [roundHalfEven(p.x), roundHalfEven(p.y)]);
  const on = points.map((p) => p.on);
  const out = [];
  if (!on.some(Boolean)) {
    // No on-curve point: synthetic start at the midpoint of the first two points.
    if (pts.length < 2) return [["M", pts[0]]];
    const mid = [Math.floor((pts[0][0] + pts[1][0]) / 2), Math.floor((pts[0][1] + pts[1][1]) / 2)];
    out.push(["M", mid]);
    pushQuadRun(out, [...pts.slice(1), pts[0], mid]);
    return out;
  }
  // Rotate so the contour ends on its first on-curve point, which is the moveTo.
  const first = on.indexOf(true) + 1;
  let c = [...pts.slice(first), ...pts.slice(0, first)];
  let f = [...on.slice(first), ...on.slice(0, first)];
  out.push(["M", c[c.length - 1]]);
  while (c.length) {
    const next = f.indexOf(true) + 1;
    if (next === 1) {
      // fontTools skips the final lineTo back to the start (closePath implies it).
      if (c.length > 1) out.push(["L", c[0]]);
    } else {
      pushQuadRun(out, c.slice(0, next));
    }
    c = c.slice(next);
    f = f.slice(next);
  }
  return out;
}

/** fontTools decomposeQuadraticSegment, with implied points truncated like Python int(). */
function pushQuadRun(out, run) {
  for (let i = 0; i < run.length - 2; i++) {
    const [x, y] = run[i], [nx, ny] = run[i + 1];
    out.push(["Q", [x, y, Math.trunc(0.5 * (x + nx)), Math.trunc(0.5 * (y + ny))]]);
  }
  const off = run[run.length - 2], end = run[run.length - 1];
  out.push(["Q", [off[0], off[1], end[0], end[1]]]);
}

const segEnd = (s) => (s[0] === "M" || s[0] === "L" ? s[1] : s[1].slice(2));
const fmtSeg = ([op, a]) => (op === "L" ? `L ${a[0]},${a[1]}` : `Q ${a[0]},${a[1]} ${a[2]},${a[3]}`);

/** Canonical string of one contour given its pen segments (CANONICAL_OUTLINE.md steps 2-4). */
function canonicalContour(c) {
  const start = c[0][1];
  const segs = c.slice(1);
  const last = segs.length ? segEnd(segs[segs.length - 1]) : start;
  if (last[0] !== start[0] || last[1] !== start[1]) segs.push(["L", start]);
  const ends = segs.map(segEnd);
  if (!ends.length) return `M ${start[0]},${start[1]}`;
  let k = 0;
  for (let i = 1; i < ends.length; i++) {
    if (ends[i][0] < ends[k][0] || (ends[i][0] === ends[k][0] && ends[i][1] < ends[k][1])) k = i;
  }
  const rot = [...segs.slice(k + 1), ...segs.slice(0, k + 1)];
  return [`M ${ends[k][0]},${ends[k][1]}`, ...rot.map(fmtSeg)].join("|");
}

/**
 * Scale raw contours to the canonical units-per-em. Both Arial Unicode MS and
 * its subsets use 2048, in which case the points are returned unchanged.
 */
export function normaliseScale(contours, unitsPerEm) {
  if (!unitsPerEm || unitsPerEm === CANONICAL_UNITS_PER_EM) return contours;
  const s = CANONICAL_UNITS_PER_EM / unitsPerEm;
  return contours.map((c) => c.map((p) => ({ x: p.x * s, y: p.y * s, on: p.on })));
}

/** Translate contours so the outline's minimum x and y (over all points) are 0. */
export function normaliseOffset(contours) {
  let mx = Infinity, my = Infinity;
  for (const c of contours) for (const p of c) { mx = Math.min(mx, p.x); my = Math.min(my, p.y); }
  if (!Number.isFinite(mx)) return contours;
  return contours.map((c) => c.map((p) => ({ x: p.x - mx, y: p.y - my, on: p.on })));
}

/** Pen segments of every contour (glyphtable.py contours_from_pen). */
export function penContours(contours) {
  return contours.map(contourSegments);
}

/** Canonical glyph string: contour strings sorted as plain strings and joined with ";". */
export function canonicalOutline(contours) {
  const strs = contours.map((c) => canonicalContour(contourSegments(c)));
  strs.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return strs.join(";");
}

/** SHA-256 hex of the canonical glyph string, or "" for a glyph with no contours. */
export function outlineHash(contours) {
  const s = canonicalOutline(contours);
  return s ? sha256Hex(s) : "";
}

/** Hash of the outline with its offset removed (for the fallback index). */
export function offsetFreeHash(contours) {
  return outlineHash(normaliseOffset(contours));
}

/**
 * Hash of the offset-free outline quantised to a coarse grid, for matching
 * outlines whose coordinates differ by rounding (the nearest-outline fallback).
 */
export const COARSE_GRID = 8;
export function coarseHash(contours) {
  const q = normaliseOffset(contours).map((c) =>
    c.map((p) => ({ x: Math.round(p.x / COARSE_GRID), y: Math.round(p.y / COARSE_GRID), on: p.on })),
  );
  return outlineHash(q);
}

