// Synchronous DEFLATE decoder (RFC 1950 zlib wrapper and RFC 1951 raw
// deflate) for FlateDecode PDF streams. Pure JS over Uint8Array, so the
// roll decoder runs the same way in the browser and in Node without
// node:zlib or the asynchronous DecompressionStream.

const LENGTH_BASE = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31,
  35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258];
const LENGTH_EXTRA = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2,
  3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];
const DIST_BASE = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193,
  257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577];
const DIST_EXTRA = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6,
  7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13];
const CLEN_ORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];

// Canonical Huffman table: counts[len] and symbols sorted by code.
function buildTree(lengths) {
  const counts = new Uint16Array(16);
  for (const len of lengths) counts[len]++;
  counts[0] = 0;
  const offsets = new Uint16Array(16);
  for (let len = 1; len < 16; len++) offsets[len] = offsets[len - 1] + counts[len - 1];
  const symbols = new Uint16Array(lengths.length);
  for (let s = 0; s < lengths.length; s++) if (lengths[s]) symbols[offsets[lengths[s]]++] = s;
  return { counts, symbols };
}

let fixedTrees = null;
function fixed() {
  if (fixedTrees) return fixedTrees;
  const lit = new Uint8Array(288);
  lit.fill(8, 0, 144); lit.fill(9, 144, 256); lit.fill(7, 256, 280); lit.fill(8, 280, 288);
  fixedTrees = { lit: buildTree(lit), dist: buildTree(new Uint8Array(30).fill(5)) };
  return fixedTrees;
}

/**
 * Inflate a zlib (FlateDecode) or raw deflate byte stream.
 * @param {Uint8Array} input
 * @returns {Uint8Array}
 * @throws {Error} on a malformed stream
 */
export function inflate(input) {
  const src = input instanceof Uint8Array ? input : new Uint8Array(input);
  let pos = 0;
  // zlib header: CM 8, header checksum; anything else is read as raw deflate.
  if (src.length >= 2 && (src[0] & 0x0f) === 8 && ((src[0] << 8) | src[1]) % 31 === 0) {
    pos = 2;
    if (src[1] & 0x20) pos += 4; // preset dictionary id (never used by PDF writers)
  }
  let bitBuf = 0;
  let bitCnt = 0;
  let out = new Uint8Array(Math.max(1024, src.length * 4));
  let outLen = 0;

  const ensure = (n) => {
    if (outLen + n <= out.length) return;
    let size = out.length * 2;
    while (size < outLen + n) size *= 2;
    const grown = new Uint8Array(size);
    grown.set(out.subarray(0, outLen));
    out = grown;
  };
  const bits = (n) => {
    while (bitCnt < n) {
      if (pos >= src.length) throw new Error('inflate: unexpected end of data');
      bitBuf |= src[pos++] << bitCnt;
      bitCnt += 8;
    }
    const v = bitBuf & ((1 << n) - 1);
    bitBuf >>>= n;
    bitCnt -= n;
    return v;
  };
  const decodeSym = ({ counts, symbols }) => {
    let code = 0;
    let first = 0;
    let index = 0;
    for (let len = 1; len < 16; len++) {
      code |= bits(1);
      const count = counts[len];
      if (code - first < count) return symbols[index + code - first];
      index += count;
      first = (first + count) << 1;
      code <<= 1;
    }
    throw new Error('inflate: invalid Huffman code');
  };

  let last = 0;
  while (!last) {
    last = bits(1);
    const type = bits(2);
    if (type === 0) {
      bitBuf = 0; bitCnt = 0; // stored block: align to the byte boundary
      if (pos + 4 > src.length) throw new Error('inflate: unexpected end of data');
      const len = src[pos] | (src[pos + 1] << 8);
      pos += 4;
      if (pos + len > src.length) throw new Error('inflate: unexpected end of data');
      ensure(len);
      out.set(src.subarray(pos, pos + len), outLen);
      outLen += len;
      pos += len;
      continue;
    }
    let lit;
    let dist;
    if (type === 1) {
      ({ lit, dist } = fixed());
    } else if (type === 2) {
      const hlit = bits(5) + 257;
      const hdist = bits(5) + 1;
      const hclen = bits(4) + 4;
      const clen = new Uint8Array(19);
      for (let i = 0; i < hclen; i++) clen[CLEN_ORDER[i]] = bits(3);
      const clTree = buildTree(clen);
      const lengths = new Uint8Array(hlit + hdist);
      for (let i = 0; i < hlit + hdist;) {
        const sym = decodeSym(clTree);
        if (sym < 16) { lengths[i++] = sym; continue; }
        let repeat;
        let value = 0;
        if (sym === 16) {
          if (!i) throw new Error('inflate: repeat with no previous length');
          value = lengths[i - 1];
          repeat = 3 + bits(2);
        } else if (sym === 17) {
          repeat = 3 + bits(3);
        } else {
          repeat = 11 + bits(7);
        }
        if (i + repeat > hlit + hdist) throw new Error('inflate: too many code lengths');
        while (repeat--) lengths[i++] = value;
      }
      lit = buildTree(lengths.subarray(0, hlit));
      dist = buildTree(lengths.subarray(hlit));
    } else {
      throw new Error('inflate: invalid block type');
    }
    for (;;) {
      const sym = decodeSym(lit);
      if (sym < 256) {
        ensure(1);
        out[outLen++] = sym;
      } else if (sym === 256) {
        break;
      } else {
        const li = sym - 257;
        if (li >= 29) throw new Error('inflate: invalid length symbol');
        const length = LENGTH_BASE[li] + bits(LENGTH_EXTRA[li]);
        const di = decodeSym(dist);
        if (di >= 30) throw new Error('inflate: invalid distance symbol');
        const distance = DIST_BASE[di] + bits(DIST_EXTRA[di]);
        if (distance > outLen) throw new Error('inflate: distance too far back');
        ensure(length);
        for (let k = 0; k < length; k++, outLen++) out[outLen] = out[outLen - distance];
      }
    }
  }
  return out.slice(0, outLen);
}
