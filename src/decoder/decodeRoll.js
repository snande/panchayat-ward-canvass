// Decodes a Rajasthan SEC panchayat roll PDF (iTextSharp text layer drawn in
// embedded Arial Unicode MS subsets) into voter records with Unicode Hindi.
//
// Port of tools/reference-decoder/decode.py, which is the specification
// (page_lines, reorder, parse_entries); keep the two in step. Pipeline:
//   1. read the text runs of each page's form XObject in content order, with
//      a real PDF literal-string tokenizer (names with घ, च or आ arrive as
//      escaped backslash and parenthesis bytes);
//   2. map each byte code to its subset glyph and the glyph, by outline, to
//      its master-glyph-table.json entry (glyphMap.js);
//   3. take the entry's `codepoints` as the glyph's Unicode sequence (the
//      table already carries the master font's cmap and GSUB reversed);
//   4. reorder visual Devanagari order to logical order (`reorder`);
//   5. segment the lines into entries by label rows (`parseEntries`).
// No OCR, no Kruti Dev table and no network call: the only table is the
// committed master glyph table, passed in or loaded by glyphMap.js.
// Pages are decoded one at a time; only the small entry records are kept.

import { analyseSubsetGlyphs } from './glyphMap.js';
import { openPdf, readLiteral } from './pdfReader.js';
import { codeToGlyph } from './subsetCmap.js';

export { readLiteral };

const VIRAMA = 0x94d;
const I_MATRA = 0x93f;
const RA = 0x930;
const NUKTA = 0x93c;
const REPLACEMENT = 0xfffd;

const isCons = (c) => (c >= 0x915 && c <= 0x939) || (c >= 0x958 && c <= 0x95f);
const isVsign = (c) => (c >= 0x93e && c <= 0x94c) || c === 0x962 || c === 0x963;
const isMark = (c) => c === 0x901 || c === 0x902 || c === 0x903;
const isCombining = (c) => isVsign(c) || isMark(c) || c === VIRAMA || c === NUKTA;

/**
 * Visual to logical order. The i-matra (U+093F) is drawn before its
 * consonant cluster: move it, with any marks drawn with it and a reph fused
 * into its glyph, after the cluster (the reph goes before the cluster). A
 * standalone reph (ra, virama) is drawn after the syllable it logically
 * precedes: move it to the start of that syllable's consonant cluster.
 * @param {number[]} cps code points in drawing order
 * @returns {number[]} code points in logical order
 */
export function reorder(cps) {
  const out = [];
  const n = cps.length;
  let i = 0;
  while (i < n) {
    const c = cps[i];
    if (c === I_MATRA) {
      let j = i + 1;
      let reph = [];
      if (j + 1 < n && cps[j] === RA && cps[j + 1] === VIRAMA) { reph = [RA, VIRAMA]; j += 2; } // reph fused into the i-matra glyph
      const marks = [];
      while (j < n && isMark(cps[j])) marks.push(cps[j++]);
      const cluster = [];
      while (j < n && (isCons(cps[j]) || cps[j] === VIRAMA || cps[j] === NUKTA)) {
        cluster.push(cps[j++]);
        if (cps[j - 1] === VIRAMA || cps[j - 1] === NUKTA) continue;
        if (j < n && (cps[j] === VIRAMA || cps[j] === NUKTA)) continue;
        break;
      }
      out.push(...reph, ...cluster, I_MATRA, ...marks);
      i = j;
      continue;
    }
    if (c === RA && i + 1 < n && cps[i + 1] === VIRAMA && out.length) {
      let k = out.length;
      while (k > 0 && (isVsign(out[k - 1]) || isMark(out[k - 1]))) k--;
      while (k > 0 && (isCons(out[k - 1]) || out[k - 1] === NUKTA)) {
        k--;
        if (k > 0 && out[k - 1] === VIRAMA) k--;
        else break;
      }
      out.splice(k, 0, RA, VIRAMA);
      i += 2;
      continue;
    }
    out.push(c);
    i++;
  }
  return out;
}

// The reference's TOK regex, alternative for alternative: Tf, Td, Tm, '(' and BT.
// PDF whitespace is spelt out because JS \s also matches U+00A0.
const WS = '[ \\t\\n\\r\\f\\v]';
const TOK = new RegExp(
  `/(\\w+)${WS}+[\\d.]+${WS}+Tf`
  + `|([-\\d.]+)${WS}+([-\\d.]+)${WS}+Td`
  + `|([-\\d.]+)${WS}+([-\\d.]+)${WS}+([-\\d.]+)${WS}+([-\\d.]+)${WS}+([-\\d.]+)${WS}+([-\\d.]+)${WS}+Tm`
  + '|(\\()|(BT)',
  'g',
);
const TJ_AFTER = new RegExp(`^${WS}*Tj`);

function fontRole(baseFont) {
  if (baseFont.includes('TimesNewRoman')) return 'serial';
  return baseFont.endsWith('+Arial') ? 'latin' : 'hindi';
}

/**
 * byte code -> Unicode code points for one embedded Arial Unicode MS subset.
 * Codes whose glyph is not in the master table map to null.
 */
function subsetCodeMap(program, table) {
  const { mapping } = analyseSubsetGlyphs(program, table);
  const glyphOf = codeToGlyph(program);
  const codes = new Map();
  for (let code = 0; code < 256; code++) {
    const gid = glyphOf(code);
    if (gid === undefined) continue;
    const entry = mapping.get(gid);
    codes.set(code, entry && entry.codepoints.length ? entry.codepoints : null);
  }
  return codes;
}

/**
 * Assemble the text lines of one page. A positioning move starts a new line
 * unless the next piece continues the same row: it starts with a combining
 * mark or a reph, it is placed within two units of the previous move, or the
 * previous piece was marks only.
 * @param {string} content the page's content stream (Latin-1 string)
 * @param {Map<string, {role: string, codes: Map<number, number[]|null>|null}>} fonts
 *   by resource name; `codes` is null for fonts whose bytes are Latin-1 text
 * @returns {{x: number, y: number, text: string, fonts: Set<string>}[]}
 */
export function pageLines(content, fonts) {
  const lines = [];
  let cur = null;
  let curFont = null;
  let pos = [0, 0];
  let pending = null;
  const flush = () => {
    if (cur && cur.cps.length) {
      cur.text = String.fromCodePoint(...reorder(cur.cps)).trim();
      delete cur.cps;
      if (cur.text) lines.push(cur);
    }
    cur = null;
  };
  const fresh = (x, y) => ({ x, y, cps: [], fonts: new Set(), xend: x, marksOnly: false });
  TOK.lastIndex = 0;
  let m;
  while ((m = TOK.exec(content))) {
    if (m[1] !== undefined) { curFont = m[1]; continue; }
    if (m[11] !== undefined) { pos = [0, 0]; pending = pos; continue; }
    if (m[2] !== undefined) { pos = [pos[0] + Number(m[2]), pos[1] + Number(m[3])]; pending = pos; continue; }
    if (m[4] !== undefined) { pos = [Number(m[8]), Number(m[9])]; pending = pos; continue; }
    const { bytes, next } = readLiteral(content, m.index);
    TOK.lastIndex = next;
    if (!TJ_AFTER.test(content.slice(next, next + 6))) continue;
    const font = fonts.get(curFont);
    let piece = [];
    if (font && font.codes) {
      for (const b of bytes) {
        const seq = font.codes.get(b);
        if (seq) piece.push(...seq);
        else piece.push(REPLACEMENT);
      }
    } else {
      piece = bytes.slice();
    }
    if (pending !== null) {
      const sameRow = cur !== null && Math.abs(pending[1] - cur.y) < 1.5;
      const startsCombining = piece.length > 0 && (isCombining(piece[0]) || (piece[0] === RA && piece[1] === VIRAMA));
      const near = cur !== null && Math.abs(pending[0] - cur.xend) < 2.0;
      if (!(sameRow && (startsCombining || near || cur.marksOnly))) {
        flush();
        cur = fresh(pending[0], pending[1]);
      }
      cur.xend = pending[0];
      pending = null;
    }
    if (cur === null) cur = fresh(0, 0);
    cur.marksOnly = piece.every(isCombining) || (piece.length === 2 && piece[0] === RA && piece[1] === VIRAMA);
    cur.fonts.add(font ? font.role : curFont);
    for (const c of piece) cur.cps.push(c);
  }
  flush();
  return lines;
}

const EPIC = /^(?:UPY\d+|RJ\/\d+\/\d+\/\d+|[A-Z]{3}\d{6,7})$/;
const LABEL_NAME = /^नाम\s*:?$/;
const LABEL_REL = /^(?:पति|पिता|माता|पत्नी|अन्य)\s+का\s+नाम\s*:?$/;
const LABEL_HOUSE = /^मकान\s+संख्या\s*:?$/;
const LABEL_AGE = /^आयु\s*:?$/;
const LABEL_SEX = /^लिं?ग\s*:?$/;
const GENDERS = new Set(['स्त्री', 'पुरूष', 'पुरुष', 'अन्य']);
const DIGITS = /^\d+$/;
// The letter printed in the serial font beside a struck-off serial: O in
// Badli's roll; E (death), S (shifted) or R (repetition) per the roll's legend.
const STRIKE_MARK = /^[OESR]$/;

/**
 * Entries start at a 'नाम:' label and end at the bold serial. Every value
 * sits on the row (same y) of its label: name on the नाम row, relative on
 * the 'X का नाम' row, house on the मकान संख्या row, age and gender on the
 * आयु row; the EPIC is a row of its own. An "O" in the serial font on the
 * serial's row marks a struck-off entry. A page with no 'नाम:' label (the
 * cover and summary pages) yields no entries.
 * @param {{x: number, y: number, text: string, fonts: Set<string>}[]} lines
 * @returns {object[]} raw entries {serial, struck, name, rel, relation, ...} plus _serialY
 */
export function parseEntries(lines) {
  const sameRow = (a, b) => Math.abs(a.y - b.y) < 2.0;
  const finish = (block, serial) => {
    const e = { serial, struck: false };
    const labels = new Map();
    for (const ln of block) {
      const t = ln.text;
      if (LABEL_NAME.test(t)) labels.set('name', ln);
      else if (LABEL_REL.test(t)) { labels.set('rel', ln); e.relation = t.split(/\s+/)[0]; }
      else if (LABEL_HOUSE.test(t)) labels.set('house', ln);
      else if (LABEL_AGE.test(t)) labels.set('age', ln);
    }
    const labelLines = new Set(labels.values());
    for (const ln of block) {
      const t = ln.text;
      if (labelLines.has(ln) || t === 'Photo is' || t === 'Available' || LABEL_SEX.test(t)) continue;
      if (EPIC.test(t)) { e.epic = t; continue; }
      let placed = false;
      for (const [key, lab] of labels) {
        if (!(sameRow(ln, lab) && ln.x > lab.x + 1)) continue;
        if (key === 'age') {
          if (DIGITS.test(t)) e.age = Number(t);
          else if (GENDERS.has(t)) e.gender = t;
          else (e.extra ??= []).push(t);
        } else if (key === 'house') {
          e.house = t;
        } else {
          e[key] = key in e ? `${e[key]} ${t}` : t;
        }
        placed = true;
        break;
      }
      if (!placed) (e.extra ??= []).push(t);
    }
    return e;
  };
  const entries = [];
  let block = [];
  for (const ln of lines) {
    const t = ln.text;
    if (LABEL_NAME.test(t)) { block = [ln]; continue; }
    if (ln.fonts.has('serial') && DIGITS.test(t) && block.length) {
      const e = finish(block, Number(t));
      e._serialY = ln.y;
      entries.push(e);
      block = [];
      continue;
    }
    if (ln.fonts.has('serial') && STRIKE_MARK.test(t) && entries.length
        && Math.abs((entries[entries.length - 1]._serialY ?? 1e9) - ln.y) < 2.0) {
      entries[entries.length - 1].struck = true;
      continue;
    }
    if (block.length) block.push(ln);
  }
  return entries;
}

const nfc = (v) => (typeof v === 'string' ? v.normalize('NFC') : v);

/**
 * Add one page's parsed entries to the roll, keyed by serial. The
 * supplement's deletion list repeats entries already in the original list:
 * the first record (and its page) is kept, and a repeat that is struck off
 * marks the kept record struck.
 * @param {Map<number, object>} bySerial the roll so far; updated in place
 * @param {object[]} rawEntries parseEntries output for the page
 * @param {number} page 1-based PDF page number
 */
export function addPageEntries(bySerial, rawEntries, page) {
  for (const raw of rawEntries) {
    const prev = bySerial.get(raw.serial);
    if (prev) { prev.struck = prev.struck || raw.struck; continue; }
    const entry = {
      serial: raw.serial,
      page,
      name: nfc(raw.name),
      relation: nfc(raw.relation),
      relative: nfc(raw.rel),
      age: raw.age,
      gender: nfc(raw.gender),
      house: nfc(raw.house),
      epic: raw.epic === undefined ? null : nfc(raw.epic),
      struck: raw.struck,
    };
    if (raw.extra) entry.extra = raw.extra.map(nfc);
    bySerial.set(raw.serial, entry);
  }
}

/**
 * Decode a roll PDF into its voter entries, one per serial, in roll order.
 * Each entry: {serial, page, name, relation, relative, age, gender, house,
 * epic, struck} (the fields of fixtures/badli-ward1-expected.json plus page
 * and struck) with every string NFC-normalised Unicode; `epic` is null
 * where the roll prints none (supplement entries); `struck` marks
 * struck-off serials; `extra` lists any text the parser could not place.
 * @param {Uint8Array|ArrayBuffer} pdfBytes the roll PDF
 * @param {{table?: {glyphs: Record<string, object>}}} [options] master glyph
 *   table; in the browser await glyphMap.loadMasterTable() first or pass it
 * @returns {object[]}
 */
export function decodeRoll(pdfBytes, { table } = {}) {
  const pdf = openPdf(pdfBytes);
  const codeMaps = new Map(); // font program object -> byte code map (shared across pages)
  const bySerial = new Map();
  for (const page of pdf.pages()) {
    const fonts = new Map();
    for (const [name, { baseFont, programNum }] of page.fonts) {
      let codes = null;
      if (baseFont.includes('ArialUnicodeMS') && programNum !== null) {
        if (!codeMaps.has(programNum)) {
          const program = pdf.stream(programNum);
          codeMaps.set(programNum, program ? subsetCodeMap(program, table) : new Map());
        }
        codes = codeMaps.get(programNum);
      }
      fonts.set(name, { role: fontRole(baseFont), codes });
    }
    addPageEntries(bySerial, parseEntries(pageLines(page.content, fonts)), page.index + 1);
  }
  return [...bySerial.values()].sort((a, b) => a.serial - b.serial);
}
