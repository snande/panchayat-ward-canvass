// Read the raw embedded TrueType programs (FontFile2 streams) out of a PDF,
// and the codes each font shows on the text layer. pdf.js only hands out its
// own re-encoded copy of an embedded font, and the glyph matcher needs the
// original glyf/loca data, so this is a small PDF object reader instead: it
// locates objects through the classic xref table (falling back to a scan
// that skips stream bodies when there is none; the roll generator,
// iTextSharp 4.0.6, writes neither xref streams nor object streams), parses
// values, and inflates FlateDecode streams with DecompressionStream
// (browser and Node >= 18).

const WS = new Set([0x00, 0x09, 0x0a, 0x0c, 0x0d, 0x20]);
const DELIM = new Set([0x28, 0x29, 0x3c, 0x3e, 0x5b, 0x5d, 0x7b, 0x7d, 0x2f, 0x25]);
const latin1 = new TextDecoder("latin1");
const ESC = { 0x6e: 10, 0x72: 13, 0x74: 9, 0x62: 8, 0x66: 12 };
const OBJ_HEADER = /^\s*(\d+)\s+(\d+)\s+obj\b/;

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
        if (this.p >= b.length) throw new Error("PDF: unterminated dictionary");
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
        if (this.p >= b.length) throw new Error("PDF: unterminated array");
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
    if (w === "" || Number.isNaN(n)) throw new Error(`PDF: unexpected token "${w}" at ${this.p}`);
    // An integer followed by "G R" is an indirect reference.
    const m = /^\s+(\d+)\s+R(?![^\s<>\[\]\/()%])/.exec(latin1.decode(b.subarray(this.p, this.p + 24)));
    if (Number.isInteger(n) && m) { this.p += m[0].length; return new Ref(n, Number(m[1])); }
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
    this.cache = new Map();
    this.offsets = new Map();
    try {
      this.readXref();
      this.located = "xref";
    } catch {
      this.offsets = new Map();
      this.scanObjects();
      this.located = "scan";
    }
  }

  /** Object offsets from the classic xref table(s), newest section first. */
  readXref() {
    const tail = latin1.decode(this.b.subarray(Math.max(0, this.b.length - 1024)));
    const m = /startxref\s+(\d+)\s*%%EOF\s*$/.exec(tail) || /startxref\s+(\d+)/.exec(tail);
    if (!m) throw new Error("no startxref");
    const seen = new Set();
    for (let off = Number(m[1]); off !== undefined; ) {
      if (seen.has(off)) break;
      seen.add(off);
      const p = new Parser(this.b, off);
      p.skipWs();
      if (p.word() !== "xref") throw new Error("not a classic xref table");
      for (;;) {
        p.skipWs();
        const w = p.word();
        if (w === "trailer") break;
        p.skipWs();
        const start = Number(w), count = Number(p.word());
        if (!w || !Number.isInteger(start) || !Number.isInteger(count)) throw new Error("bad xref subsection");
        for (let i = 0; i < count; i++) {
          p.skipWs(); const o = Number(p.word());
          p.skipWs(); p.word();
          p.skipWs(); const kind = p.word();
          if (kind === "n" && !this.offsets.has(start + i)) this.offsets.set(start + i, o);
        }
      }
      const trailer = p.value();
      const prev = trailer instanceof Map ? trailer.get("Prev") : undefined;
      off = typeof prev === "number" ? prev : undefined;
    }
    for (const [num, o] of this.offsets) {
      const h = OBJ_HEADER.exec(latin1.decode(this.b.subarray(o, o + 32)));
      if (!h || Number(h[1]) !== num) throw new Error(`xref entry for object ${num} does not point at it`);
    }
  }

  /**
   * Without a usable xref: walk the file object by object, stepping over each
   * object's value and stream body so that "N G obj" text inside streams or
   * strings is never mistaken for a definition. Later definitions win.
   */
  scanObjects() {
    const text = latin1.decode(this.b);
    const re = /(?:^|[\s>\]])(\d+)\s+(\d+)\s+obj\b/g;
    let m;
    while ((m = re.exec(text))) {
      const num = Number(m[1]);
      this.offsets.set(num, m.index + m[0].indexOf(m[1]));
      try {
        const p = new Parser(this.b, m.index + m[0].length);
        const v = p.value();
        p.skipWs();
        if (v instanceof Map && text.startsWith("stream", p.p)) {
          const len = v.get("Length");
          const body = p.p + 6;
          const end = typeof len === "number" ? body + len : text.indexOf("endstream", body);
          re.lastIndex = Math.max(re.lastIndex, end < 0 ? text.length : end);
        } else {
          re.lastIndex = Math.max(re.lastIndex, p.p);
        }
      } catch {
        // Unparseable object: keep scanning after its header.
      }
    }
  }

  /** The object with number `num` (a Map for dictionaries; streams have .dict and .raw). */
  get(num) {
    if (this.cache.has(num)) return this.cache.get(num);
    const off = this.offsets.get(num);
    if (off === undefined) return null;
    const h = OBJ_HEADER.exec(latin1.decode(this.b.subarray(off, off + 32)));
    if (!h) return null;
    const p = new Parser(this.b, off + h[0].length);
    let v = p.value();
    p.skipWs();
    if (v instanceof Map && latin1.decode(this.b.subarray(p.p, p.p + 6)) === "stream") {
      let s = p.p + 6;
      if (this.b[s] === 0x0d) s++;
      if (this.b[s] === 0x0a) s++;
      const len = this.resolve(v.get("Length"));
      v = { num, dict: v, raw: this.b.subarray(s, s + len) };
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
      const name = this.resolve(x).name;
      if (name === "FlateDecode") data = await inflate(data);
      else throw new Error(`PDF: unsupported filter ${name}`);
    }
    return data;
  }
  objectNumbers() { return [...this.offsets.keys()].sort((a, b) => a - b); }
}

const MAX_FORM_DEPTH = 16;

/**
 * Character codes the text layer shows with each font, keyed by font object
 * number. Walks every page's content streams and follows Do into form
 * XObjects (the roll draws each page as one form). The current font is
 * graphics state: q saves it, Q restores it, and a form starts with the font
 * current at its Do. A form without /Resources uses the resources of the
 * stream that draws it.
 * @returns {Promise<Map<number, Set<number>>>}
 */
export async function textLayerCodes(pdf) {
  const used = new Map();
  const inherited = (page, key) => {
    for (let n = page, i = 0; n instanceof Map && i < 32; n = pdf.resolve(n.get("Parent")), i++) {
      if (n.has(key)) return n.get(key);
    }
    return undefined;
  };
  for (const num of pdf.objectNumbers()) {
    const o = pdf.get(num);
    if (!(o instanceof Map) || o.get("Type")?.name !== "Page") continue;
    const c = pdf.resolve(o.get("Contents"));
    const streams = (Array.isArray(c) ? c.map((r) => pdf.resolve(r)) : c ? [c] : []).filter((s) => s?.dict);
    const parts = [];
    for (const s of streams) parts.push(await pdf.streamData(s));
    // Content streams of one page are one sequence; join with whitespace.
    await scanContent(pdf, joinBytes(parts), pdf.resolve(inherited(o, "Resources")), null, used, []);
  }
  return used;
}

function joinBytes(parts) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length + 1, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; out[o++] = 0x0a; }
  return out;
}

/**
 * Scan one content stream. `resources` is the resource dictionary in force,
 * `font` the font object number current at entry, `stack` the form object
 * numbers being drawn (cycle guard). Codes are added to `used`.
 */
export async function scanContent(pdf, bytes, resources, font, used, stack = []) {
  const res = pdf.resolve(resources);
  const sub = (key) => {
    const d = res instanceof Map ? pdf.resolve(res.get(key)) : null;
    return d instanceof Map ? d : new Map();
  };
  const fonts = sub("Font"), xobjects = sub("XObject");
  const p = new Parser(bytes, 0);
  const saved = [];
  let operands = [];
  const show = (str) => {
    if (font == null || !str?.str) return;
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
    else if (w === "Tf") {
      const ref = fonts.get(operands[operands.length - 2]?.name);
      font = ref instanceof Ref ? ref.num : null;
    } else if (w === "Tj" || w === "'" || w === '"') show(operands[operands.length - 1]);
    else if (w === "TJ") for (const x of operands[operands.length - 1] || []) show(x);
    else if (w === "Do") {
      const ref = xobjects.get(operands[operands.length - 1]?.name);
      const form = ref instanceof Ref ? pdf.get(ref.num) : null;
      if (form?.dict && form.dict.get("Subtype")?.name === "Form" && !stack.includes(ref.num) && stack.length < MAX_FORM_DEPTH) {
        const formRes = form.dict.has("Resources") ? form.dict.get("Resources") : res;
        await scanContent(pdf, await pdf.streamData(form), formRes, font, used, [...stack, ref.num]);
      }
    } else if (w === "BI") {
      // Skip inline image data up to its EI.
      const e = latin1.decode(bytes.subarray(p.p)).search(/\sEI(?=\s|$)/);
      p.p = e < 0 ? bytes.length : p.p + e + 3;
    }
    operands = [];
  }
}

/**
 * Every embedded TrueType font program whose BaseFont matches `pattern`.
 * Throws for a matching Type0 (CID) font: its strings are multi-byte codes,
 * which this reader does not decode.
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
    const subtype = o.get("Subtype")?.name;
    if (subtype === "Type0") throw new Error(`${baseFont} (object ${num}) is a Type0/CID font; only simple TrueType fonts are supported`);
    if (subtype !== "TrueType") continue;
    const desc = pdf.resolve(o.get("FontDescriptor"));
    const ff = desc instanceof Map ? pdf.resolve(desc.get("FontFile2")) : null;
    if (!ff || !ff.dict) continue;
    out.push({ objNum: num, baseFont, bytes: await pdf.streamData(ff), usedCodes: used.get(num) ?? new Set() });
  }
  return out;
}
