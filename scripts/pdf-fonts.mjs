// Node-only helpers for reading the embedded TrueType subset fonts of a roll
// PDF and finding which of their glyphs the text layer actually draws.
//
// The roll PDFs are classic PDF 1.4 files with simple (one-byte) TrueType
// fonts and no object streams, so node:zlib and a little tokenising is all
// that is needed. The subset's cmap is read here ONLY to turn the character
// codes in the content streams into glyph IDs ("which glyphs are used");
// the decoder in src/decoder never looks at it.

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
function textShows(content) {
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
  const ref = (dict, key) => {
    const m = new RegExp(`/${key}\\s+(\\d+)\\s+\\d+\\s+R`).exec(dict);
    return m ? Number(m[1]) : null;
  };

  const programs = new Map(); // font program obj -> { fontName, program, usedGlyphs }
  const programOfFont = new Map(); // font obj -> font program obj
  for (const [num, { dict }] of objects) {
    const descriptor = ref(dict, 'FontDescriptor');
    if (descriptor === null || !objects.has(descriptor)) continue;
    const file = ref(objects.get(descriptor).dict, 'FontFile2');
    const name = /\/FontName\s*\/([^\s/<>[\]]+)/.exec(objects.get(descriptor).dict);
    const stream = file === null ? null : objects.get(file)?.stream;
    if (!name || !stream) continue;
    programOfFont.set(num, file);
    if (!programs.has(file)) programs.set(file, { fontName: name[1], program: stream, usedGlyphs: new Set() });
  }

  // Content streams: Form XObjects carry their own /Font resources; pages
  // point at a content stream and carry the resources themselves.
  const units = [];
  for (const { dict, stream } of objects.values()) {
    if (stream && /\/Font\s*<</.test(dict)) units.push({ resources: dict, content: stream });
    else if (!stream && /\/Type\s*\/Page\b/.test(dict) && /\/Font\s*<</.test(dict)) {
      const contents = ref(dict, 'Contents');
      if (contents !== null && objects.get(contents)?.stream) units.push({ resources: dict, content: objects.get(contents).stream });
    }
  }
  for (const { resources, content } of units) {
    const fonts = /\/Font\s*<<([^>]*)>>/.exec(resources)?.[1] ?? '';
    const resourceFont = new Map();
    for (const m of fonts.matchAll(/\/([^\s/<>[\]]+)\s+(\d+)\s+\d+\s+R/g)) resourceFont.set(m[1], Number(m[2]));
    const glyphOf = new Map();
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
  return [...programs.entries()].sort((a, b) => a[0] - b[0]).map(([, font]) => font);
}
