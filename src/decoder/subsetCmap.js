// One-byte character code -> subset glyph ID for the simple TrueType fonts
// the roll PDFs embed. The subset's cmap is used ONLY for this step (which
// glyph a code in the content stream draws); the glyph's Unicode always
// comes from the master glyph table's `codepoints`, never from the cmap or
// the ToUnicode map. Pure function over Uint8Array, browser and Node.

/**
 * @param {Uint8Array} font raw TrueType font program
 * @returns {(code: number) => number|undefined} glyph ID for a character code
 *   (symbolic 3,0 with or without the 0xF000 offset, then 1,0, then 3,1)
 */
export function codeToGlyph(font) {
  const view = new DataView(font.buffer, font.byteOffset, font.byteLength);
  const tables = new Map();
  for (let i = 0; i < view.getUint16(4); i++) {
    const rec = 12 + i * 16;
    tables.set(String.fromCharCode(...font.subarray(rec, rec + 4)), view.getUint32(rec + 8));
  }
  const maps = new Map(); // "platform,encoding" -> Map<code, gid>
  const cmap = tables.get('cmap');
  if (cmap === undefined) return () => undefined;
  for (let k = 0; k < view.getUint16(cmap + 2); k++) {
    const platform = view.getUint16(cmap + 4 + k * 8);
    const encoding = view.getUint16(cmap + 6 + k * 8);
    const sub = cmap + view.getUint32(cmap + 8 + k * 8);
    const codes = new Map();
    const format = view.getUint16(sub);
    if (format === 0) {
      for (let c = 0; c < 256; c++) codes.set(c, font[sub + 6 + c]);
    } else if (format === 4) {
      const segCount = view.getUint16(sub + 6) / 2;
      const ends = sub + 14;
      const starts = ends + segCount * 2 + 2;
      const deltas = starts + segCount * 2;
      const ranges = deltas + segCount * 2;
      for (let s = 0; s < segCount; s++) {
        const end = view.getUint16(ends + s * 2);
        const start = view.getUint16(starts + s * 2);
        const delta = view.getInt16(deltas + s * 2);
        const rangeOffset = view.getUint16(ranges + s * 2);
        for (let c = start; c <= end && c !== 0xffff; c++) {
          let gid;
          if (rangeOffset === 0) {
            gid = (c + delta) & 0xffff;
          } else {
            gid = view.getUint16(ranges + s * 2 + rangeOffset + (c - start) * 2);
            if (gid) gid = (gid + delta) & 0xffff;
          }
          codes.set(c, gid);
        }
      }
    }
    maps.set(`${platform},${encoding}`, codes);
  }
  return (code) => {
    for (const [key, offset] of [['3,0', 0], ['3,0', 0xf000], ['1,0', 0], ['3,1', 0]]) {
      const gid = maps.get(key)?.get(code + offset);
      if (gid) return gid;
    }
    return undefined;
  };
}
