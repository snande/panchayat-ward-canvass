// Node-only helpers for reading the embedded TrueType subset fonts of a roll
// PDF and finding which of their glyphs the text layer actually draws.
//
// The roll PDFs are classic PDF 1.4 files with simple (one-byte) TrueType
// fonts. This is a small purpose-built reader on node:zlib, not a general PDF
// parser: PDFs it cannot read (object streams, Type0/CID fonts) are rejected
// with an error or yield no used glyphs, which glyph-map-report treats as a
// failure rather than a pass. The subset's cmap is read here ONLY to turn the
// character codes in the content streams into glyph IDs ("which glyphs are
// used"); the decoder in src/decoder never looks at it.

import { inflateSync } from 'node:zlib';

/** Every `N G obj ... endobj`: Map<objNum, {dict: string, stream: Buffer|null}>. */
export function readObjects(pdf) {
  const text = pdf.toString('latin1');
  const objects = new Map();
  const header = /(\d+) (\d+) obj\b/g;
  let m;
  while ((m = header.exec(text))) {
    const bodyStart = header.lastIndex;
    const streamAt = text.indexOf('stream', bodyStart);
    const endAt = text.indexOf('endobj', bodyStart);
    if (streamAt !== -1 && (endAt === -1 || streamAt < endAt)) {
      const dict = text.slice(bodyStart, streamAt);
      if (/\/Type\s*\/ObjStm\b/.test(dict)) throw new Error('PDF uses object streams, which this reader does not support');
      let dataStart = streamAt + 'stream'.length;
      if (text[dataStart] === '\r') dataStart++;
      if (text[dataStart] === '\n') dataStart++;
      const direct = /\/Length\s+(\d+)(?!\s+\d+\s+R)/.exec(dict);
      const dataEnd = direct ? dataStart + Number(direct[1]) : text.indexOf('endstream', dataStart);
      let data = pdf.subarray(dataStart, dataEnd);
      if (/\/FlateDecode/.test(dict)) data = inflateSync(data);
      objects.set(Number(m[1]), { dict, stream: data });
      header.lastIndex = text.indexOf('endobj', dataEnd) + 'endobj'.length;
    } else {
      objects.set(Number(m[1]), { dict: text.slice(bodyStart, endAt), stream: null });
    }
  }
  return objects;
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

/** A dictionary value given inline or as an indirect reference, as dictionary text (or null). */
function dictValue(valueText, objects) {
  if (valueText === undefined) return null;
  const trimmed = valueText.trimStart();
  if (trimmed.startsWith('<<')) return balancedDict(trimmed);
  const ref = /^(\d+)\s+\d+\s+R\b/.exec(trimmed);
  return ref && objects.has(Number(ref[1])) ? balancedDict(objects.get(Number(ref[1])).dict) : null;
}

const refNumber = (valueText) => {
  const m = /^\s*(\d+)\s+\d+\s+R\b/.exec(valueText ?? '');
  return m ? Number(m[1]) : null;
};

/** name -> font object number from a dictionary's /Resources /Font. */
function fontResources(holderDict, objects) {
  const resources = dictValue(topLevelEntries(holderDict).get('Resources'), objects);
  const fonts = resources && dictValue(topLevelEntries(resources).get('Font'), objects);
  const map = new Map();
  if (!fonts) return map;
  for (const [name, rest] of topLevelEntries(fonts)) {
    const num = refNumber(rest);
    if (num !== null) map.set(name, num);
  }
  return map;
}

// --- cmap (used only to learn which glyphs a character code draws) --------------

/** code -> glyph ID from a subset's cmap (symbolic 3,0 with or without the 0xF000 offset, or 1,0). */
function codeToGlyph(font) {
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

// --- content streams ------------------------------------------------------------

function decodeLiteral(text, start) {
  const codes = [];
  let depth = 1;
  let i = start;
  while (i < text.length && depth > 0) {
    const ch = text[i++];
    if (ch === '\\') {
      const e = text[i++];
      if (/[0-7]/.test(e)) {
        let oct = e;
        while (oct.length < 3 && /[0-7]/.test(text[i] ?? '')) oct += text[i++];
        codes.push(parseInt(oct, 8) & 0xff);
      } else if (e === '\r' || e === '\n') {
        if (e === '\r' && text[i] === '\n') i++;
      } else {
        const esc = { n: 10, r: 13, t: 9, b: 8, f: 12 }[e];
        codes.push(esc ?? e.charCodeAt(0));
      }
    } else if (ch === '(') {
      depth++;
      codes.push(40);
    } else if (ch === ')') {
      depth--;
      if (depth > 0) codes.push(41);
    } else {
      codes.push(ch.charCodeAt(0));
    }
  }
  return { codes, next: i };
}

/** Text-showing operators of a content stream: [{ fontName, codes }]. */
export function textShows(content) {
  const shows = [];
  let font = null;
  let lastName = null;
  let pending = [];
  let i = 0;
  while (i < content.length) {
    const ch = content[i];
    if (/\s/.test(ch)) {
      i++;
    } else if (ch === '(') {
      const { codes, next } = decodeLiteral(content, i + 1);
      pending.push(...codes);
      i = next;
    } else if (ch === '<' && content[i + 1] === '<') {
      i += 2;
    } else if (ch === '<') {
      const close = content.indexOf('>', i);
      let hex = content.slice(i + 1, close).replace(/\s/g, '');
      if (hex.length % 2) hex += '0';
      for (let h = 0; h < hex.length; h += 2) pending.push(parseInt(hex.slice(h, h + 2), 16));
      i = close + 1;
    } else if (ch === '%') {
      while (i < content.length && content[i] !== '\n' && content[i] !== '\r') i++;
    } else if ('[]>{}'.includes(ch)) {
      i++;
    } else if (ch === '/') {
      let j = i + 1;
      while (j < content.length && !/[\s/()<>[\]{}%]/.test(content[j])) j++;
      lastName = content.slice(i + 1, j);
      i = j;
    } else {
      let j = i;
      while (j < content.length && !/[\s/()<>[\]{}%]/.test(content[j])) j++;
      const token = content.slice(i, j === i ? i + 1 : j);
      i = j === i ? i + 1 : j;
      if (token === 'Tf') font = lastName;
      else if (['Tj', 'TJ', "'", '"'].includes(token)) shows.push({ fontName: font, codes: pending });
      if (!/^[-+.\d]/.test(token)) pending = [];
    }
  }
  return shows;
}

/**
 * Embedded TrueType subset fonts of a classic PDF, with the glyph IDs the
 * text layer draws: [{ fontName, program, usedGlyphs: Set<number> }], in
 * order of the font program's object number.
 */
export function embeddedFonts(pdf) {
  const objects = readObjects(pdf);

  const programs = new Map(); // font program obj -> { fontName, program, usedGlyphs }
  const programOfFont = new Map(); // font obj -> font program obj
  for (const [num, { dict }] of objects) {
    const descriptor = refNumber(topLevelEntries(dict).get('FontDescriptor'));
    if (descriptor === null || !objects.has(descriptor)) continue;
    const descriptorDict = objects.get(descriptor).dict;
    const file = refNumber(topLevelEntries(descriptorDict).get('FontFile2'));
    const name = /\/FontName\s*\/([^\s/<>[\]]+)/.exec(descriptorDict);
    const stream = file === null ? null : objects.get(file)?.stream;
    if (!name || !stream) continue;
    programOfFont.set(num, file);
    if (!programs.has(file)) programs.set(file, { fontName: name[1], program: stream, usedGlyphs: new Set() });
  }

  // Content streams: Form XObjects carry their own /Resources; pages point
  // at one content stream (or an array of them) and carry the resources.
  const units = [];
  for (const { dict, stream } of objects.values()) {
    const entries = topLevelEntries(dict);
    if (stream && entries.has('Resources')) {
      units.push({ holder: dict, contents: [stream] });
    } else if (!stream && /^\s*\/Page\b/.test(entries.get('Type') ?? '')) {
      const raw = (entries.get('Contents') ?? '').trimStart();
      const refs = raw.startsWith('[') ? raw.slice(0, raw.indexOf(']')) : (/^\d+\s+\d+\s+R/.exec(raw)?.[0] ?? '');
      const streams = [...refs.matchAll(/(\d+)\s+\d+\s+R/g)]
        .map((m) => objects.get(Number(m[1]))?.stream)
        .filter(Boolean);
      units.push({ holder: dict, contents: streams });
    }
  }
  for (const { holder, contents } of units) {
    const resourceFont = fontResources(holder, objects);
    if (!resourceFont.size) continue;
    const glyphOf = new Map();
    for (const content of contents) {
      for (const { fontName, codes } of textShows(content.toString('latin1'))) {
        const program = programs.get(programOfFont.get(resourceFont.get(fontName)));
        if (!program) continue;
        if (!glyphOf.has(program)) glyphOf.set(program, codeToGlyph(program.program));
        for (const code of codes) {
          const gid = glyphOf.get(program)(code);
          if (gid !== undefined) program.usedGlyphs.add(gid);
        }
      }
    }
  }
  return [...programs.entries()].sort((a, b) => a[0] - b[0]).map(([, font]) => font);
}
