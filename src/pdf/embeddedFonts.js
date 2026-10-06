// Read the raw embedded TrueType programs (FontFile2 streams) out of a PDF.
// pdf.js only hands out its own re-encoded copy of an embedded font, and the
// glyph matcher needs the original glyf/loca data, so this is a small PDF
// object reader instead: it scans the file for "N G obj" definitions rather
// than following the xref (the roll generator, iTextSharp 4.0.6, writes no
// object streams), parses values, and inflates FlateDecode streams with
// DecompressionStream (browser and Node >= 18). It also collects the codes
// each font shows on the text layer.

const WS = new Set([0x00, 0x09, 0x0a, 0x0c, 0x0d, 0x20]);
const DELIM = new Set([0x28, 0x29, 0x3c, 0x3e, 0x5b, 0x5d, 0x7b, 0x7d, 0x2f, 0x25]);
const latin1 = new TextDecoder("latin1");
const ESC = { 0x6e: 10, 0x72: 13, 0x74: 9, 0x62: 8, 0x66: 12 };

export class Ref {
  constructor(num, gen) { this.num = num; this.gen = gen; }
}

class Parser {
  constructor(bytes, pos) { this.b = bytes; this.p = pos; }
  skipWs() {
    const b = this.b;
    for (;;) {
      while (this.p < b.length && WS.has(b[this.p])) this.p++;
      if (b[this.p] !== 0x25) return; // comment
      while (this.p < b.length && b[this.p] !== 0x0a && b[this.p] !== 0x0d) this.p++;
    }
  }
  /** A literal string starting at "(", with escapes decoded (names with घ, च, आ arrive escaped). */
  literal() {
    const b = this.b, out = [];
    let depth = 1;
    this.p++;
    while (this.p < b.length) {
      const c = b[this.p];
      if (c === 0x5c) {
        const n = b[this.p + 1];
        if (n >= 0x30 && n <= 0x37) {
          let j = this.p + 1, v = 0;
          while (j < this.p + 4 && b[j] >= 0x30 && b[j] <= 0x37) v = v * 8 + (b[j++] - 0x30);
          out.push(v & 0xff); this.p = j; continue;
        }
        this.p += 2;
        if (n === 0x0d) { if (b[this.p] === 0x0a) this.p++; continue; }
        if (n === 0x0a) continue;
        out.push(ESC[n] ?? n);
        continue;
      }
      if (c === 0x28) depth++;
      else if (c === 0x29 && --depth === 0) { this.p++; break; }
      out.push(c);
      this.p++;
    }
    return Uint8Array.from(out);
  }
  word() {
    const s = this.p;
    while (this.p < this.b.length && !WS.has(this.b[this.p]) && !DELIM.has(this.b[this.p])) this.p++;
    return latin1.decode(this.b.subarray(s, this.p));
  }
  value() {
    this.skipWs();
    const b = this.b, c = b[this.p];
    if (c === 0x2f) { this.p++; return { name: this.word() }; }
    if (c === 0x3c && b[this.p + 1] === 0x3c) {
      this.p += 2;
      const d = new Map();
      for (;;) {
        this.skipWs();
        if (b[this.p] === 0x3e && b[this.p + 1] === 0x3e) { this.p += 2; return d; }
        const k = this.value();
        d.set(k.name, this.value());
      }
    }
    if (c === 0x3c) {
      const e = b.indexOf(0x3e, this.p);
      const hex = latin1.decode(b.subarray(this.p + 1, e)).replace(/\s+/g, "");
      this.p = e + 1;
      const out = new Uint8Array(Math.ceil(hex.length / 2));
      for (let i = 0; i < out.length; i++) out[i] = parseInt((hex.substr(i * 2, 2) + "0").slice(0, 2), 16);
      return { str: out };
    }
    if (c === 0x5b) {
      this.p++;
      const a = [];
      for (;;) {
        this.skipWs();
        if (b[this.p] === 0x5d) { this.p++; return a; }
        a.push(this.value());
      }
    }
    if (c === 0x28) return { str: this.literal() };
    const w = this.word();
    if (w === "true") return true;
    if (w === "false") return false;
    if (w === "null") return null;
    const n = Number(w);
    if (Number.isNaN(n)) throw new Error(`PDF: unexpected token "${w}" at ${this.p}`);
    // An integer followed by "G R" is an indirect reference.
    const save = this.p;
    const m = /^\s+(\d+)\s+R(?![^\s<>\[\]\/()%])/.exec(latin1.decode(b.subarray(this.p, this.p + 24)));
    if (Number.isInteger(n) && m) { this.p += m[0].length; return new Ref(n, Number(m[1])); }
    this.p = save;
    return n;
  }
}

async function inflate(data) {
  const ds = new DecompressionStream("deflate");
  const stream = new Blob([data]).stream().pipeThrough(ds);
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

export class PdfFile {
  constructor(bytes) {
    this.b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    this.offsets = new Map();
    this.cache = new Map();
    const text = latin1.decode(this.b);
    const re = /(?:^|[\s>\]])(\d+)\s+(\d+)\s+obj\b/g;
    let m;
    // Later definitions (incremental updates) win.
    while ((m = re.exec(text))) this.offsets.set(Number(m[1]), m.index + m[0].length);
  }
  /** The object with number `num` (a Map for dictionaries; streams have .dict and .raw). */
  get(num) {
    if (this.cache.has(num)) return this.cache.get(num);
    const off = this.offsets.get(num);
    if (off === undefined) return null;
    const p = new Parser(this.b, off);
    let v = p.value();
    p.skipWs();
    if (v instanceof Map && latin1.decode(this.b.subarray(p.p, p.p + 6)) === "stream") {
      let s = p.p + 6;
      if (this.b[s] === 0x0d) s++;
      if (this.b[s] === 0x0a) s++;
      const len = this.resolve(v.get("Length"));
      v = { dict: v, raw: this.b.subarray(s, s + len) };
    }
    this.cache.set(num, v);
    return v;
  }
  resolve(v) { return v instanceof Ref ? this.get(v.num) : v; }
  /** Decoded stream data (FlateDecode or unfiltered). */
  async streamData(stream) {
    const f = this.resolve(stream.dict.get("Filter"));
    const filters = f == null ? [] : Array.isArray(f) ? f : [f];
    let data = stream.raw;
    for (const x of filters) {
      if (x.name === "FlateDecode") data = await inflate(data);
      else throw new Error(`PDF: unsupported filter ${x.name}`);
    }
    return data;
  }
  objectNumbers() { return [...this.offsets.keys()].sort((a, b) => a - b); }
}

/**
 * Character codes the text layer shows with each font, keyed by font object
 * number. Scans every page content stream and every form XObject (the roll
 * draws each page as one form) for Tf, Tj, TJ, ' and ", with q/Q saving
 * and restoring the current font.
 * @returns {Promise<Map<number, Set<number>>>}
 */
export async function textLayerCodes(pdf) {
  const used = new Map();
  const fontRefs = (resources) => {
    const fonts = pdf.resolve(pdf.resolve(resources)?.get?.("Font"));
    const out = new Map();
    if (fonts instanceof Map) for (const [k, v] of fonts) if (v instanceof Ref) out.set(k, v.num);
    return out;
  };
  const inherited = (page, key) => {
    for (let n = page, i = 0; n instanceof Map && i < 32; n = pdf.resolve(n.get("Parent")), i++) {
      if (n.has(key)) return n.get(key);
    }
    return undefined;
  };
  for (const num of pdf.objectNumbers()) {
    const o = pdf.get(num);
    let streams = [], fonts;
    if (o instanceof Map && o.get("Type")?.name === "Page") {
      fonts = fontRefs(inherited(o, "Resources"));
      const c = pdf.resolve(o.get("Contents"));
      streams = Array.isArray(c) ? c.map((r) => pdf.resolve(r)) : c ? [c] : [];
    } else if (o?.dict && o.dict.get("Subtype")?.name === "Form") {
      fonts = fontRefs(o.dict.get("Resources"));
      streams = [o];
    } else continue;
    if (!fonts.size) continue;
    const data = [];
    for (const s of streams) if (s?.dict) data.push(await pdf.streamData(s));
    for (const d of data) scanContent(d, fonts, used);
  }
  return used;
}

function scanContent(bytes, fonts, used) {
  const p = new Parser(bytes, 0);
  let operands = [], font = null;
  const saved = []; // the text font is graphics state: q saves it, Q restores it
  const show = (str) => {
    if (font == null || !(str?.str)) return;
    if (!used.has(font)) used.set(font, new Set());
    const set = used.get(font);
    for (const b of str.str) set.add(b);
  };
  for (;;) {
    p.skipWs();
    if (p.p >= bytes.length) break;
    const c = bytes[p.p];
    if (c === 0x2f || c === 0x3c || c === 0x5b || c === 0x28) { operands.push(p.value()); continue; }
    const w = p.word();
    if (!w) { p.p++; continue; }
    const n = Number(w);
    if (!Number.isNaN(n)) { operands.push(n); continue; }
    if (w === "q") saved.push(font);
    else if (w === "Q") font = saved.length ? saved.pop() : font;
    else if (w === "Tf") font = fonts.get(operands[operands.length - 2]?.name) ?? null;
    else if (w === "Tj" || w === "'" || w === "\"") show(operands[operands.length - 1]);
    else if (w === "TJ") for (const x of operands[operands.length - 1] || []) show(x);
    else if (w === "BI") {
      // Skip inline image data up to its EI.
      const e = latin1.decode(bytes.subarray(p.p)).search(/\sEI(?=\s|$)/);
      p.p = e < 0 ? bytes.length : p.p + e + 3;
    }
    operands = [];
  }
}

/**
 * Every embedded TrueType font program whose BaseFont matches `pattern`.
 * @returns {Promise<Array<{objNum:number, baseFont:string, bytes:Uint8Array, usedCodes:Set<number>}>>}
 *   one entry per font dictionary, in object-number order; usedCodes are the
 *   single-byte codes the text layer shows with it
 */
export async function embeddedTrueTypeFonts(pdfBytes, pattern = /ArialUnicodeMS/) {
  const pdf = new PdfFile(pdfBytes);
  const used = await textLayerCodes(pdf);
  const out = [];
  for (const num of pdf.objectNumbers()) {
    const o = pdf.get(num);
    if (!(o instanceof Map) || o.get("Type")?.name !== "Font") continue;
    const baseFont = o.get("BaseFont")?.name ?? "";
    if (!pattern.test(baseFont)) continue;
    const desc = pdf.resolve(o.get("FontDescriptor"));
    const ff = desc instanceof Map ? pdf.resolve(desc.get("FontFile2")) : null;
    if (!ff || !ff.dict) continue;
    out.push({ objNum: num, baseFont, bytes: await pdf.streamData(ff), usedCodes: used.get(num) ?? new Set() });
  }
  return out;
}
