// Minimal TrueType (glyf) outline reader.
//
// Reads only what the decoder needs from an embedded subset font program:
// the number of glyphs and each glyph's contours as raw on/off-curve points,
// with composite glyphs flattened to their component contours. It never
// reads cmap or any other character-mapping table. Pure functions over a
// Uint8Array, so it runs unchanged in the browser and in Node.

const FLAG_ON_CURVE = 0x01;
const FLAG_X_SHORT = 0x02;
const FLAG_Y_SHORT = 0x04;
const FLAG_REPEAT = 0x08;
const FLAG_X_SAME = 0x10;
const FLAG_Y_SAME = 0x20;

const ARG_1_AND_2_ARE_WORDS = 0x0001;
const ARGS_ARE_XY_VALUES = 0x0002;
const WE_HAVE_A_SCALE = 0x0008;
const MORE_COMPONENTS = 0x0020;
const WE_HAVE_AN_X_AND_Y_SCALE = 0x0040;
const WE_HAVE_A_TWO_BY_TWO = 0x0080;

const MAX_COMPOSITE_DEPTH = 8;

/**
 * @param {Uint8Array|ArrayBuffer} fontProgramBytes raw sfnt font program
 * @returns {{numGlyphs: number, unitsPerEm: number, contours: (gid: number) => Array<Array<{x:number,y:number,on:boolean}>>}}
 */
export function parseTrueType(fontProgramBytes) {
  const bytes = fontProgramBytes instanceof Uint8Array
    ? fontProgramBytes
    : new Uint8Array(fontProgramBytes);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  const sfnt = view.getUint32(0);
  if (sfnt !== 0x00010000 && sfnt !== 0x74727565) {
    throw new Error('not a TrueType font program (glyf outlines required)');
  }
  const tables = {};
  const numTables = view.getUint16(4);
  for (let i = 0; i < numTables; i++) {
    const rec = 12 + i * 16;
    const tag = String.fromCharCode(bytes[rec], bytes[rec + 1], bytes[rec + 2], bytes[rec + 3]);
    tables[tag] = { offset: view.getUint32(rec + 8), length: view.getUint32(rec + 12) };
  }
  for (const tag of ['head', 'maxp', 'loca', 'glyf']) {
    if (!tables[tag]) throw new Error(`font program has no ${tag} table`);
  }

  const unitsPerEm = view.getUint16(tables.head.offset + 18);
  const longLoca = view.getInt16(tables.head.offset + 50) !== 0;
  const numGlyphs = view.getUint16(tables.maxp.offset + 4);
  const glyfBase = tables.glyf.offset;

  function glyphRange(gid) {
    const loca = tables.loca.offset;
    const start = longLoca ? view.getUint32(loca + gid * 4) : view.getUint16(loca + gid * 2) * 2;
    const end = longLoca ? view.getUint32(loca + gid * 4 + 4) : view.getUint16(loca + gid * 2 + 2) * 2;
    return [start, end];
  }

  function simpleContours(pos, numberOfContours) {
    const endPts = [];
    for (let i = 0; i < numberOfContours; i++) endPts.push(view.getUint16(pos + i * 2));
    pos += numberOfContours * 2;
    pos += 2 + view.getUint16(pos); // instructions
    const numPoints = endPts[endPts.length - 1] + 1;

    const flags = [];
    while (flags.length < numPoints) {
      const flag = view.getUint8(pos++);
      flags.push(flag);
      if (flag & FLAG_REPEAT) {
        for (let n = view.getUint8(pos++); n > 0; n--) flags.push(flag);
      }
    }
    const readCoords = (shortBit, sameBit) => {
      const out = [];
      let v = 0;
      for (let i = 0; i < numPoints; i++) {
        const flag = flags[i];
        if (flag & shortBit) {
          const d = view.getUint8(pos++);
          v += flag & sameBit ? d : -d;
        } else if (!(flag & sameBit)) {
          v += view.getInt16(pos);
          pos += 2;
        }
        out.push(v);
      }
      return out;
    };
    const xs = readCoords(FLAG_X_SHORT, FLAG_X_SAME);
    const ys = readCoords(FLAG_Y_SHORT, FLAG_Y_SAME);

    const contours = [];
    let first = 0;
    for (const last of endPts) {
      const contour = [];
      for (let i = first; i <= last; i++) {
        contour.push({ x: xs[i], y: ys[i], on: (flags[i] & FLAG_ON_CURVE) !== 0 });
      }
      contours.push(contour);
      first = last + 1;
    }
    return contours;
  }

  function glyphContours(gid, depth = 0) {
    if (!Number.isInteger(gid) || gid < 0 || gid >= numGlyphs) throw new RangeError(`glyph ${gid} out of range`);
    if (depth > MAX_COMPOSITE_DEPTH) throw new Error('composite glyph nesting too deep');
    const [start, end] = glyphRange(gid);
    if (end <= start) return [];
    let pos = glyfBase + start;
    const numberOfContours = view.getInt16(pos);
    pos += 10;
    if (numberOfContours >= 0) return simpleContours(pos, numberOfContours);

    const result = [];
    let flags;
    do {
      flags = view.getUint16(pos);
      const componentGid = view.getUint16(pos + 2);
      pos += 4;
      let arg1;
      let arg2;
      if (flags & ARG_1_AND_2_ARE_WORDS) {
        if (flags & ARGS_ARE_XY_VALUES) {
          arg1 = view.getInt16(pos);
          arg2 = view.getInt16(pos + 2);
        } else {
          arg1 = view.getUint16(pos);
          arg2 = view.getUint16(pos + 2);
        }
        pos += 4;
      } else {
        if (flags & ARGS_ARE_XY_VALUES) {
          arg1 = view.getInt8(pos);
          arg2 = view.getInt8(pos + 1);
        } else {
          arg1 = view.getUint8(pos);
          arg2 = view.getUint8(pos + 1);
        }
        pos += 2;
      }
      let xx = 1;
      let yx = 0;
      let xy = 0;
      let yy = 1;
      const f2dot14 = (p) => view.getInt16(p) / 16384;
      if (flags & WE_HAVE_A_SCALE) {
        xx = yy = f2dot14(pos);
        pos += 2;
      } else if (flags & WE_HAVE_AN_X_AND_Y_SCALE) {
        xx = f2dot14(pos);
        yy = f2dot14(pos + 2);
        pos += 4;
      } else if (flags & WE_HAVE_A_TWO_BY_TWO) {
        xx = f2dot14(pos);
        yx = f2dot14(pos + 2);
        xy = f2dot14(pos + 4);
        yy = f2dot14(pos + 6);
        pos += 8;
      }

      const component = glyphContours(componentGid, depth + 1).map((contour) => contour.map((p) => ({
        x: xx * p.x + xy * p.y,
        y: yx * p.x + yy * p.y,
        on: p.on,
      })));
      let dx = 0;
      let dy = 0;
      if (flags & ARGS_ARE_XY_VALUES) {
        dx = arg1;
        dy = arg2;
      } else {
        // Point matching: align component point arg2 with point arg1 gathered so far.
        const parent = result.flat()[arg1];
        const child = component.flat()[arg2];
        if (!parent || !child) throw new Error('composite point matching out of range');
        dx = parent.x - child.x;
        dy = parent.y - child.y;
      }
      for (const contour of component) {
        result.push(contour.map((p) => ({ x: p.x + dx, y: p.y + dy, on: p.on })));
      }
    } while (flags & MORE_COMPONENTS);
    return result;
  }

  return { numGlyphs, unitsPerEm, contours: (gid) => glyphContours(gid) };
}
