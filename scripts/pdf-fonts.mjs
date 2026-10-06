// Node-only helpers for reading the embedded TrueType subset fonts of a roll
// PDF and finding which of their glyphs the text layer actually draws.
//
// The roll PDFs are classic PDF 1.4 files with simple (one-byte) TrueType
// fonts. This is built on the decoder's own small reader
// (src/decoder/pdfReader.js: object index, stream decoding, literal-string
// tokenizer, dictionary helpers), not a general PDF parser: PDFs it cannot
// read (object streams, Type0/CID fonts) are rejected with an error or yield
// no used glyphs, which glyph-map-report treats as a failure rather than a
// pass. The subset's cmap is read here ONLY to turn the character codes in
// the content streams into glyph IDs ("which glyphs are used", via
// src/decoder/subsetCmap.js); Unicode never comes from it.

import {
  balancedDict, indexObjects, readLiteral, refNumber, streamData, topLevelEntries,
} from '../src/decoder/pdfReader.js';
import { codeToGlyph } from '../src/decoder/subsetCmap.js';

export { balancedDict, topLevelEntries };

/**
 * Every `N G obj ... endobj`: Map<objNum, {dict: string, stream: Buffer|null}>.
 * FlateDecode streams are inflated; streams with other filters are returned
 * undecoded.
 */
export function readObjects(pdf) {
  const objects = new Map();
  for (const [num, entry] of indexObjects(pdf).objects) {
    const data = streamData(pdf, entry, { strict: false });
    objects.set(num, { dict: entry.dict, stream: data && Buffer.from(data.buffer, data.byteOffset, data.byteLength) });
  }
  return objects;
}

/** A dictionary value given inline or as an indirect reference, as dictionary text (or null). */
function dictValue(valueText, objects) {
  if (valueText === undefined) return null;
  const trimmed = valueText.trimStart();
  if (trimmed.startsWith('<<')) return balancedDict(trimmed);
  const ref = /^(\d+)\s+\d+\s+R\b/.exec(trimmed);
  return ref && objects.has(Number(ref[1])) ? balancedDict(objects.get(Number(ref[1])).dict) : null;
}

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

// --- content streams ------------------------------------------------------------

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
      const { bytes, next } = readLiteral(content, i);
      pending.push(...bytes);
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
