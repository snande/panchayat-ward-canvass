// Small, browser-safe reader for the classic (PDF 1.4, no object streams)
// roll PDFs: indexes the objects once, parses a dictionary or inflates a
// stream only when asked, and walks the page tree in page order so a caller
// can process one page at a time without holding every page in memory.
// Not a general PDF parser: object streams are rejected, and so (for the
// decoder) are stream filters other than FlateDecode.
//
// scripts/pdf-fonts.mjs builds its Node tooling on the same index, literal
// tokenizer and dictionary helpers, so there is one PDF object reader.

import { inflate } from './inflate.js';

/** Bytes as a one-char-per-byte string (true Latin-1, not windows-1252). */
export function latin1(bytes, start = 0, end = bytes.length) {
  let s = '';
  for (let i = start; i < end; i += 0x8000) {
    s += String.fromCharCode.apply(null, bytes.subarray(i, Math.min(end, i + 0x8000)));
  }
  return s;
}

// --- literal strings ------------------------------------------------------------

const ESC = { n: 10, r: 13, t: 9, b: 8, f: 12, '(': 40, ')': 41, '\\': 92 };

/**
 * Parse a PDF literal string starting at the '(' at data[i]: octal escapes,
 * \n \r \t \b \f \( \) \\, a backslash-newline continuation and balanced
 * unescaped parentheses. Port of read_literal in
 * tools/reference-decoder/decode.py. Names with घ, च or आ are drawn with the
 * backslash and parenthesis byte codes, which arrive escaped.
 * @param {string} data content stream as a Latin-1 string
 * @param {number} i index of the opening parenthesis
 * @returns {{bytes: number[], next: number}} the string's bytes and the index after ')'
 */
export function readLiteral(data, i) {
  const out = [];
  let depth = 1;
  i += 1;
  while (i < data.length && depth) {
    const b = data.charCodeAt(i);
    if (b === 0x5c) {
      const nb = data.charCodeAt(i + 1);
      if (nb >= 0x30 && nb <= 0x37) {
        let j = i + 1;
        let v = 0;
        while (j < data.length && j < i + 4 && data.charCodeAt(j) >= 0x30 && data.charCodeAt(j) <= 0x37) {
          v = v * 8 + (data.charCodeAt(j) - 0x30);
          j++;
        }
        out.push(v & 0xff);
        i = j;
        continue;
      }
      if (nb === 10 || nb === 13) { i += 2; continue; }
      if (Number.isNaN(nb)) { i += 1; continue; }
      out.push(ESC[data[i + 1]] ?? nb);
      i += 2;
      continue;
    }
    if (b === 0x28) depth++;
    else if (b === 0x29) {
      depth--;
      if (depth === 0) return { bytes: out, next: i + 1 };
    }
    out.push(b);
    i++;
  }
  return { bytes: out, next: i };
}

// --- dictionary parsing with balanced delimiters -----------------------------

// Skip a literal string starting at text[i] === '('; returns the index after it.
function skipLiteral(text, i) {
  let depth = 0;
  for (; i < text.length; i++) {
    if (text[i] === '\\') i++;
    else if (text[i] === '(') depth++;
    else if (text[i] === ')' && --depth === 0) return i + 1;
  }
  return text.length;
}

/** The first `<< ... >>` in text, nested dictionaries included; null if none. */
export function balancedDict(text) {
  const open = text.indexOf('<<');
  if (open < 0) return null;
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if (text[i] === '(') i = skipLiteral(text, i) - 1;
    else if (text.startsWith('<<', i)) { depth++; i++; }
    else if (text.startsWith('>>', i)) { depth--; i++; if (depth === 0) return text.slice(open, i + 1); }
  }
  return null;
}

/** Top-level entries of a dictionary: Map<name, text following the name>. */
export function topLevelEntries(dict) {
  const entries = new Map();
  const body = balancedDict(dict) ?? '';
  let depth = 0;
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (ch === '(') i = skipLiteral(body, i) - 1;
    else if (body.startsWith('<<', i)) { depth++; i++; }
    else if (body.startsWith('>>', i)) { depth--; i++; }
    else if (ch === '/' && depth === 1) {
      let j = i + 1;
      while (j < body.length && !/[\s/()<>[\]{}%]/.test(body[j])) j++;
      const name = body.slice(i + 1, j);
      if (!entries.has(name)) entries.set(name, body.slice(j));
      i = j - 1;
    }
  }
  return entries;
}

/** Object number of an indirect reference at the start of valueText, or null. */
export function refNumber(valueText) {
  const m = /^\s*(\d+)\s+\d+\s+R\b/.exec(valueText ?? '');
  return m ? Number(m[1]) : null;
}

/** The leading name of valueText (`/Form` -> "Form"), or null. */
function nameValue(valueText) {
  const m = /^\s*\/([^\s/()<>[\]{}%]+)/.exec(valueText ?? '');
  return m ? m[1] : null;
}

// --- objects and streams ---------------------------------------------------------

/**
 * Index every `N G obj ... endobj` of a classic PDF without decoding any
 * stream. The Latin-1 copy of the file used for scanning is local to this
 * call and released when it returns: the dictionary strings kept in the index
 * are fresh copies from the bytes, not slices that would pin the copy.
 * @param {Uint8Array} bytes
 * @returns {{objects: Map<number, {dict: string, dataStart: number, dataEnd: number}>, rootNum: number|null}}
 *   dataStart is -1 for an object without a stream
 * @throws {Error} if the PDF uses object streams
 */
export function indexObjects(bytes) {
  const text = latin1(bytes);
  const objects = new Map();
  const header = /(\d+)\s+(\d+)\s+obj\b/g;
  let m;
  while ((m = header.exec(text))) {
    const bodyStart = header.lastIndex;
    const streamAt = text.indexOf('stream', bodyStart);
    const endAt = text.indexOf('endobj', bodyStart);
    if (streamAt !== -1 && (endAt === -1 || streamAt < endAt)) {
      const dict = latin1(bytes, bodyStart, streamAt);
      if (/\/Type\s*\/ObjStm\b/.test(dict)) throw new Error('PDF uses object streams, which this reader does not support');
      let dataStart = streamAt + 'stream'.length;
      if (text[dataStart] === '\r') dataStart++;
      if (text[dataStart] === '\n') dataStart++;
      const direct = /\/Length\s+(\d+)(?!\s+\d+\s+R)/.exec(dict);
      let dataEnd = direct ? dataStart + Number(direct[1]) : -1;
      if (dataEnd < 0 || dataEnd > text.length || text.indexOf('endstream', dataEnd) === -1) {
        // indirect or wrong /Length: the data runs to the end-of-line before endstream
        dataEnd = text.indexOf('endstream', dataStart);
        if (dataEnd === -1) dataEnd = text.length;
        while (dataEnd > dataStart && (text[dataEnd - 1] === '\n' || text[dataEnd - 1] === '\r')) dataEnd--;
      }
      objects.set(Number(m[1]), { dict, dataStart, dataEnd });
      const after = text.indexOf('endobj', dataEnd);
      header.lastIndex = after === -1 ? text.length : after + 'endobj'.length;
    } else {
      objects.set(Number(m[1]), { dict: latin1(bytes, bodyStart, endAt === -1 ? text.length : endAt), dataStart: -1, dataEnd: -1 });
    }
  }
  let rootNum = null;
  const trailers = [...text.matchAll(/trailer\s*<<[\s\S]*?\/Root\s+(\d+)\s+\d+\s+R/g)];
  if (trailers.length) rootNum = Number(trailers[trailers.length - 1][1]);
  if (rootNum === null || !objects.has(rootNum)) {
    rootNum = null;
    for (const [num, obj] of objects) if (/\/Type\s*\/Catalog\b/.test(obj.dict)) rootNum = num;
  }
  return { objects, rootNum };
}

/**
 * Decoded data of an indexed stream object.
 * @param {Uint8Array} bytes the whole PDF
 * @param {{dict: string, dataStart: number, dataEnd: number}} obj an indexObjects entry
 * @param {{strict?: boolean}} [options] strict (default): throw on a filter
 *   other than FlateDecode; otherwise return such data undecoded
 * @returns {Uint8Array|null} null for an object without a stream
 */
export function streamData(bytes, obj, { strict = true } = {}) {
  if (!obj || obj.dataStart < 0) return null;
  const raw = bytes.subarray(obj.dataStart, obj.dataEnd);
  const filter = (topLevelEntries(obj.dict).get('Filter') ?? '').trimStart();
  const list = filter.startsWith('[') ? filter.slice(0, filter.indexOf(']')) : (/^\/\w+/.exec(filter)?.[0] ?? '');
  const used = [...list.matchAll(/\/(\w+)/g)].map((f) => f[1]);
  if (!used.length) return raw;
  if (used.length === 1 && (used[0] === 'FlateDecode' || used[0] === 'Fl')) return inflate(raw);
  if (!strict) return raw;
  throw new Error(`unsupported stream filter ${used.join(',')}`);
}

// --- the document ------------------------------------------------------------

/**
 * Open a classic PDF.
 * @param {Uint8Array|ArrayBuffer} pdfBytes
 * @returns {{pageCount: number, pages: () => Generator<{index: number, content: string, fonts: Map}>, stream: (num: number) => Uint8Array|null}}
 */
export function openPdf(pdfBytes) {
  const bytes = pdfBytes instanceof Uint8Array ? pdfBytes : new Uint8Array(pdfBytes);
  if (latin1(bytes, 0, Math.min(5, bytes.length)) !== '%PDF-') throw new Error('not a PDF file');
  const { objects: index, rootNum } = indexObjects(bytes);
  if (rootNum === null) throw new Error('PDF has no document catalog');

  /** Dictionary text of an object (or of an inline value), or null. */
  const dict = (valueText) => {
    if (valueText === undefined || valueText === null) return null;
    const trimmed = valueText.trimStart();
    if (trimmed.startsWith('<<')) return balancedDict(trimmed);
    const num = refNumber(trimmed);
    return num !== null && index.has(num) ? balancedDict(index.get(num).dict) : null;
  };
  const objectDict = (num) => (index.has(num) ? balancedDict(index.get(num).dict) : null);
  const stream = (num) => streamData(bytes, index.get(num));

  // Page tree, in order.
  const pageNums = [];
  const seen = new Set();
  const walk = (num, inherited) => {
    if (num === null || seen.has(num)) return;
    seen.add(num);
    const d = objectDict(num);
    if (!d) return;
    const entries = topLevelEntries(d);
    const resources = entries.has('Resources') ? entries.get('Resources') : inherited;
    if (nameValue(entries.get('Type')) === 'Pages' || entries.has('Kids')) {
      const kids = entries.get('Kids') ?? '';
      const list = kids.slice(0, kids.indexOf(']') + 1);
      for (const k of list.matchAll(/(\d+)\s+\d+\s+R/g)) walk(Number(k[1]), resources);
    } else {
      pageNums.push({ num, resources });
    }
  };
  walk(refNumber(topLevelEntries(objectDict(rootNum) ?? '').get('Pages')), undefined);

  /** name -> { baseFont, programNum } of a resources dictionary. */
  const fontsOf = (resourcesValue) => {
    const fonts = new Map();
    const resources = dict(resourcesValue);
    const fontDict = resources && dict(topLevelEntries(resources).get('Font'));
    if (!fontDict) return fonts;
    for (const [name, rest] of topLevelEntries(fontDict)) {
      const fd = dict(rest);
      if (!fd) continue;
      const fe = topLevelEntries(fd);
      const baseFont = nameValue(fe.get('BaseFont')) ?? '';
      let programNum = null;
      const descriptor = dict(fe.get('FontDescriptor'));
      if (descriptor) programNum = refNumber(topLevelEntries(descriptor).get('FontFile2'));
      fonts.set(name, { baseFont, programNum });
    }
    return fonts;
  };

  /**
   * The page's text unit: its first Form XObject (where these rolls draw all
   * their text), or else the page's own content streams.
   * @returns {{content: string, fonts: Map<string, {baseFont: string, programNum: number|null}>}}
   */
  const pageText = (page) => {
    const resources = dict(page.resources);
    const xobjects = resources && dict(topLevelEntries(resources).get('XObject'));
    if (xobjects) {
      for (const [, rest] of topLevelEntries(xobjects)) {
        const num = refNumber(rest);
        const d = num === null ? null : objectDict(num);
        if (d && nameValue(topLevelEntries(d).get('Subtype')) === 'Form') {
          return { content: latin1(stream(num)), fonts: fontsOf(topLevelEntries(d).get('Resources')) };
        }
      }
    }
    const contents = (topLevelEntries(objectDict(page.num)).get('Contents') ?? '').trimStart();
    const refs = contents.startsWith('[') ? contents.slice(0, contents.indexOf(']')) : (/^\d+\s+\d+\s+R/.exec(contents)?.[0] ?? '');
    const parts = [...refs.matchAll(/(\d+)\s+\d+\s+R/g)].map((r) => stream(Number(r[1]))).filter(Boolean);
    return { content: parts.map((p) => latin1(p)).join('\n'), fonts: fontsOf(page.resources) };
  };

  return {
    pageCount: pageNums.length,
    /** Yields { index, content, fonts } for each page, decoding one page at a time. */
    * pages() {
      for (let i = 0; i < pageNums.length; i++) yield { index: i, ...pageText(pageNums[i]) };
    },
    stream,
  };
}
