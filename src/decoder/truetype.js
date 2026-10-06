// Minimal TrueType reader: the table directory, head, maxp, loca, glyf and
// (optionally) hhea/hmtx and cmap. It returns each glyph's contours as raw
// points with their on-curve flags, composites flattened, in the order the
// font stores them. The canonical outline hash (see CANONICAL_OUTLINE.md)
// depends on exact point order and on-curve flags, so the points are read
// directly rather than through a path API that would already have inserted
// implied midpoints.

const ARG_1_AND_2_ARE_WORDS = 0x0001;
const ARGS_ARE_XY_VALUES = 0x0002;
const WE_HAVE_A_SCALE = 0x0008;
const MORE_COMPONENTS = 0x0020;
const WE_HAVE_AN_X_AND_Y_SCALE = 0x0040;
const WE_HAVE_A_TWO_BY_TWO = 0x0080;

const MAX_COMPONENT_DEPTH = 8;

/** Parse an sfnt (TrueType) font program from a Uint8Array or ArrayBuffer. */
export function parseTrueType(bytes) {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const numTables = dv.getUint16(4);
  const tables = {};
  for (let i = 0; i < numTables; i++) {
    const rec = 12 + i * 16;
    const tag = String.fromCharCode(u8[rec], u8[rec + 1], u8[rec + 2], u8[rec + 3]);
    tables[tag] = { offset: dv.getUint32(rec + 8), length: dv.getUint32(rec + 12) };
  }
  for (const tag of ["head", "maxp", "loca", "glyf"]) {
    if (!tables[tag]) throw new Error(`TrueType font has no ${tag} table`);
  }
  const head = tables.head.offset;
  const unitsPerEm = dv.getUint16(head + 18);
  const longLoca = dv.getInt16(head + 50) === 1;
  const numGlyphs = dv.getUint16(tables.maxp.offset + 4);

  const loca = tables.loca.offset;
  const glyphOffset = (gid) => (longLoca ? dv.getUint32(loca + gid * 4) : dv.getUint16(loca + gid * 2) * 2);

  const font = { bytes: u8, view: dv, tables, unitsPerEm, numGlyphs, glyphOffset };
  font.glyphContours = (gid) => glyphContours(font, gid);
  return font;
}

/**
 * Contours of glyph `gid` as arrays of {x, y, on}. Coordinates are in font
 * units; components of a composite glyph are transformed (floats when a
 * component is scaled) and appended in component order. Throws on a
 * point-matched component whose point indices do not exist, rather than
 * guessing an offset that would yield a wrong outline.
 */
export function glyphContours(font, gid, depth = 0) {
  if (depth > MAX_COMPONENT_DEPTH) throw new Error(`glyph ${gid}: components nested too deeply`);
  if (gid < 0 || gid >= font.numGlyphs) throw new Error(`glyph ${gid}: no such glyph`);
  const start = font.glyphOffset(gid);
  const end = font.glyphOffset(gid + 1);
  if (end <= start) return [];
  const dv = font.view;
  let p = font.tables.glyf.offset + start;
  const numberOfContours = dv.getInt16(p);
  p += 10;
  if (numberOfContours >= 0) return simpleGlyph(font, p, numberOfContours);

  const contours = [];
  for (const c of readComponents(dv, p)) {
    const { xx, xy, yx, yy } = c;
    const childContours = glyphContours(font, c.glyph, depth + 1);
    let dx = 0, dy = 0;
    if (c.xyValues) {
      dx = c.a1; dy = c.a2;
    } else {
      // Point matching: align child point a2 with the parent's point a1 so far.
      const parentPts = contours.flat();
      const childPts = childContours.flat().map((q) => ({ x: xx * q.x + yx * q.y, y: xy * q.x + yy * q.y }));
      if (!parentPts[c.a1] || !childPts[c.a2]) {
        throw new Error(`glyph ${gid}: component ${c.glyph} matches points ${c.a1}/${c.a2}, which do not exist`);
      }
      dx = parentPts[c.a1].x - childPts[c.a2].x;
      dy = parentPts[c.a1].y - childPts[c.a2].y;
    }
    for (const cc of childContours) {
      contours.push(cc.map((q) => ({ x: xx * q.x + yx * q.y + dx, y: xy * q.x + yy * q.y + dy, on: q.on })));
    }
  }
  return contours;
}

/** Component records of a composite glyph whose header ends at `p`. */
function readComponents(dv, p) {
  const out = [];
  let flags;
  do {
    flags = dv.getUint16(p);
    const glyph = dv.getUint16(p + 2);
    const xyValues = (flags & ARGS_ARE_XY_VALUES) !== 0;
    p += 4;
    let a1, a2;
    if (flags & ARG_1_AND_2_ARE_WORDS) {
      a1 = xyValues ? dv.getInt16(p) : dv.getUint16(p);
      a2 = xyValues ? dv.getInt16(p + 2) : dv.getUint16(p + 2);
      p += 4;
    } else {
      a1 = xyValues ? dv.getInt8(p) : dv.getUint8(p);
      a2 = xyValues ? dv.getInt8(p + 1) : dv.getUint8(p + 1);
      p += 2;
    }
    // 2x2 as fontTools stores it: x' = xx*x + yx*y + dx, y' = xy*x + yy*y + dy.
    let xx = 1, xy = 0, yx = 0, yy = 1;
    const f2dot14 = (o) => dv.getInt16(o) / 16384;
    if (flags & WE_HAVE_A_SCALE) {
      xx = yy = f2dot14(p); p += 2;
    } else if (flags & WE_HAVE_AN_X_AND_Y_SCALE) {
      xx = f2dot14(p); yy = f2dot14(p + 2); p += 4;
    } else if (flags & WE_HAVE_A_TWO_BY_TWO) {
      xx = f2dot14(p); xy = f2dot14(p + 2); yx = f2dot14(p + 4); yy = f2dot14(p + 6); p += 8;
    }
    out.push({ glyph, xyValues, a1, a2, xx, xy, yx, yy });
  } while (flags & MORE_COMPONENTS);
  return out;
}

/** Glyph ids a composite glyph references directly ([] for a simple or empty glyph). */
export function componentGids(font, gid) {
  const start = font.glyphOffset(gid);
  if (font.glyphOffset(gid + 1) <= start) return [];
  const p = font.tables.glyf.offset + start;
  if (font.view.getInt16(p) >= 0) return [];
  return readComponents(font.view, p + 10).map((c) => c.glyph);
}

/** Advance width of a glyph from hmtx, or null when the font has no hhea/hmtx. */
export function advanceWidth(font, gid) {
  const { hhea, hmtx } = font.tables;
  if (!hhea || !hmtx) return null;
  const n = font.view.getUint16(hhea.offset + 34);
  if (!n) return null;
  return font.view.getUint16(hmtx.offset + Math.min(gid, n - 1) * 4);
}

function simpleGlyph(font, p, numberOfContours) {
  const dv = font.view;
  const endPts = [];
  for (let i = 0; i < numberOfContours; i++) endPts.push(dv.getUint16(p + i * 2));
  p += numberOfContours * 2;
  const numPoints = numberOfContours ? endPts[numberOfContours - 1] + 1 : 0;
  const instructionLength = dv.getUint16(p);
  p += 2 + instructionLength;

  const flags = new Uint8Array(numPoints);
  for (let i = 0; i < numPoints; ) {
    const f = dv.getUint8(p++);
    flags[i++] = f;
    if (f & 0x08) {
      let repeat = dv.getUint8(p++);
      while (repeat-- > 0 && i < numPoints) flags[i++] = f;
    }
  }
  const xs = new Array(numPoints), ys = new Array(numPoints);
  let v = 0;
  for (let i = 0; i < numPoints; i++) {
    const f = flags[i];
    if (f & 0x02) { const d = dv.getUint8(p++); v += f & 0x10 ? d : -d; }
    else if (!(f & 0x10)) { v += dv.getInt16(p); p += 2; }
    xs[i] = v;
  }
  v = 0;
  for (let i = 0; i < numPoints; i++) {
    const f = flags[i];
    if (f & 0x04) { const d = dv.getUint8(p++); v += f & 0x20 ? d : -d; }
    else if (!(f & 0x20)) { v += dv.getInt16(p); p += 2; }
    ys[i] = v;
  }
  const contours = [];
  let s = 0;
  for (const e of endPts) {
    const c = [];
    for (let i = s; i <= e; i++) c.push({ x: xs[i], y: ys[i], on: (flags[i] & 1) === 1 });
    if (c.length) contours.push(c);
    s = e + 1;
  }
  return contours;
}

/**
 * Glyph id a simple TrueType font in a PDF draws for a single-byte code, by
 * the PDF rule for symbolic fonts: the (3,0) subtable at 0xF000 + code (or
 * code), else the (1,0) subtable at code. This only says which glyph the text
 * layer draws; it is never used to identify a glyph (see glyphMap.js).
 */
export function pdfCodeToGlyph(font, code) {
  const subs = cmapSubtables(font);
  const ms = subs.get("3/0");
  if (ms) {
    const g = ms(0xf000 + code) || ms(code);
    if (g) return g;
  }
  const mac = subs.get("1/0");
  return mac ? mac(code) : 0;
}

function cmapSubtables(font) {
  if (font._cmaps) return font._cmaps;
  const out = new Map();
  font._cmaps = out;
  const t = font.tables.cmap;
  if (!t) return out;
  const dv = font.view;
  const n = dv.getUint16(t.offset + 2);
  for (let i = 0; i < n; i++) {
    const rec = t.offset + 4 + i * 8;
    const key = `${dv.getUint16(rec)}/${dv.getUint16(rec + 2)}`;
    const sub = t.offset + dv.getUint32(rec + 4);
    const fn = cmapReader(dv, sub);
    if (fn && !out.has(key)) out.set(key, fn);
  }
  return out;
}

function cmapReader(dv, o) {
  const format = dv.getUint16(o);
  if (format === 0) return (c) => (c < 256 ? dv.getUint8(o + 6 + c) : 0);
  if (format === 6) {
    const first = dv.getUint16(o + 6), count = dv.getUint16(o + 8);
    return (c) => (c >= first && c < first + count ? dv.getUint16(o + 10 + (c - first) * 2) : 0);
  }
  if (format === 4) {
    const segX2 = dv.getUint16(o + 6);
    const ends = o + 14, starts = ends + segX2 + 2, deltas = starts + segX2, ranges = deltas + segX2;
    return (c) => {
      for (let i = 0; i < segX2; i += 2) {
        if (c > dv.getUint16(ends + i)) continue;
        const start = dv.getUint16(starts + i);
        if (c < start) return 0;
        const delta = dv.getInt16(deltas + i), ro = dv.getUint16(ranges + i);
        if (!ro) return (c + delta) & 0xffff;
        const g = dv.getUint16(ranges + i + ro + (c - start) * 2);
        return g ? (g + delta) & 0xffff : 0;
      }
      return 0;
    };
  }
  if (format === 12) {
    const groups = dv.getUint32(o + 12);
    return (c) => {
      for (let i = 0; i < groups; i++) {
        const g = o + 16 + i * 12, s = dv.getUint32(g), e = dv.getUint32(g + 4);
        if (c >= s && c <= e) return dv.getUint32(g + 8) + (c - s);
      }
      return 0;
    };
  }
  return null;
}
