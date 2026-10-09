import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { deflateRawSync, deflateSync } from 'node:zlib';

import { addPageEntries, decodeRoll, pageLines, parseEntries, readLiteral, reorder } from './decodeRoll.js';
import { inflate } from './inflate.js';

const cps = (s) => [...s].map((c) => c.codePointAt(0));
const str = (a) => String.fromCodePoint(...a);
const fixture = (name) => new URL(`../../fixtures/${name}`, import.meta.url);

// --- reorder ------------------------------------------------------------------

test('reorder moves the i-matra after the consonant it is drawn before', () => {
  assert.equal(str(reorder(cps('िक'))), 'कि');
});

test('reorder moves the i-matra after a whole virama cluster', () => {
  assert.equal(str(reorder(cps('िस्थ'))), 'स्थि');
});

test('reorder keeps marks drawn with the i-matra after it', () => {
  assert.equal(str(reorder(cps('िंस'))), 'सिं');
});

test('reorder puts a reph fused into the i-matra glyph before the cluster', () => {
  // the shape of serials 103 and 320: र्मि drawn as (i-matra + reph), म
  assert.equal(str(reorder(cps('िर्म'))), 'र्मि');
});

test('reorder moves a standalone reph before the syllable it follows', () => {
  assert.equal(str(reorder(cps('कमर्'))), 'कर्म');
  assert.equal(str(reorder(cps('धमार्'))), 'धर्मा');
});

test('reorder leaves text with neither i-matra nor reph alone', () => {
  assert.equal(str(reorder(cps('सत्यनारायण'))), 'सत्यनारायण');
});

// --- literal strings and streams -------------------------------------------------

test('readLiteral decodes escaped parentheses, backslash and octal bytes', () => {
  const data = '(a\\(b\\)c\\\\d\\101\\7) Tj';
  const { bytes, next } = readLiteral(data, 0);
  assert.deepEqual(bytes, [...'a(b)c\\dA'].map((c) => c.charCodeAt(0)).concat(7));
  assert.equal(data.slice(next), ' Tj');
});

test('readLiteral keeps balanced unescaped parentheses', () => {
  const { bytes } = readLiteral('(x(y)z)', 0);
  assert.equal(String.fromCharCode(...bytes), 'x(y)z');
});

test('inflate matches node:zlib on zlib and raw deflate streams', () => {
  const data = Buffer.from(Array.from({ length: 70000 }, (_, i) => (i * 7919) % 251 ^ (i % 13 === 0 ? i & 0xff : 0)));
  for (const level of [0, 1, 6, 9]) {
    assert.deepEqual(Buffer.from(inflate(deflateSync(data, { level }))), data);
    assert.deepEqual(Buffer.from(inflate(deflateRawSync(data, { level }))), data);
  }
  assert.deepEqual(inflate(deflateSync(Buffer.alloc(0))), new Uint8Array(0));
});

// --- pageLines: joining text pieces into lines -------------------------------------

// /H is a Hindi subset whose byte codes stand for these glyph expansions;
// /S is the serial font, read as Latin-1 text.
const HINDI = new Map([
  ['a', [0x915]], // क
  ['b', [0x92e]], // म
  ['c', [0x930, 0x94d]], // reph र्
  ['d', [0x93e]], // ा
  ['e', [0x902]], // ं
  ['(', [0x918]], // घ, drawn with the '(' byte
  [')', [0x91a]], // च, drawn with the ')' byte
].map(([ch, seq]) => [ch.charCodeAt(0), seq]));
const FONTS = new Map([['H', { role: 'hindi', codes: HINDI }], ['S', { role: 'serial', codes: null }]]);
const lines = (body) => pageLines(`BT 1 0 0 1 10 100 Tm /H 10 Tf ${body} ET`, FONTS)
  .map(({ x, y, text }) => ({ x, y, text }));

test('pageLines: a piece starting with a combining mark continues the line, however far away', () => {
  assert.deepEqual(lines('(a) Tj 30 0 Td (d) Tj'), [{ x: 10, y: 100, text: 'का' }]);
});

test('pageLines: a reph piece continues the line and is reordered before its syllable', () => {
  assert.deepEqual(lines('(ab) Tj 30 0 Td (c) Tj'), [{ x: 10, y: 100, text: 'कर्म' }]);
});

test('pageLines: a piece placed within two units of the previous move continues the line', () => {
  assert.deepEqual(lines('(a) Tj 1.5 0 Td (b) Tj'), [{ x: 10, y: 100, text: 'कम' }]);
  assert.deepEqual(lines('(a) Tj 5 0 Td (b) Tj'), [{ x: 10, y: 100, text: 'क' }, { x: 15, y: 100, text: 'म' }]);
});

test('pageLines: the piece after a marks-only piece continues the line', () => {
  assert.deepEqual(lines('(a) Tj 30 0 Td (e) Tj 30 0 Td (b) Tj'), [{ x: 10, y: 100, text: 'कंम' }]);
  assert.deepEqual(lines('(a) Tj 30 0 Td (b) Tj 30 0 Td (a) Tj').map((l) => l.text), ['क', 'म', 'क']);
});

test('pageLines: a move to another row starts a new line even for a combining mark', () => {
  assert.deepEqual(lines('(a) Tj 0 -20 Td (d) Tj').map((l) => [l.y, l.text]), [[100, 'क'], [80, 'ा']]);
});

test('pageLines: escaped parenthesis bytes map to their glyphs, unknown codes to U+FFFD', () => {
  assert.deepEqual(lines('(\\(\\)z) Tj').map((l) => l.text), ['घच�']);
});

test('pageLines: literals not shown with Tj are skipped and fonts are recorded per line', () => {
  const out = pageLines('BT 1 0 0 1 10 100 Tm /H 10 Tf (b) Tz (a) Tj 0 -20 Td /S 10 Tf (12) Tj ET', FONTS);
  assert.deepEqual(out.map((l) => [l.text, [...l.fonts]]), [['क', ['hindi']], ['12', ['serial']]]);
});

// --- parseEntries and addPageEntries --------------------------------------------

const line = (x, y, text, font = 'hindi') => ({ x, y, text, fonts: new Set([font]) });
const entryLines = (serial, y) => [
  line(50, y, 'नाम:'), line(90, y, 'राम'), line(130, y, 'कुमार'),
  line(50, y - 10, 'पिता का नाम:'), line(110, y - 10, 'श्याम'),
  line(50, y - 20, 'मकान संख्या:'), line(120, y - 20, '05'),
  line(50, y - 30, 'आयु:'), line(80, y - 30, '40'), line(100, y - 30, 'लिंग:'), line(130, y - 30, 'पुरूष'),
  line(200, y + 10, 'UPY1234567', 'latin'),
  line(20, y, String(serial), 'serial'),
];

test('parseEntries places every value by the row of its label', () => {
  const [e] = parseEntries(entryLines(7, 500));
  assert.deepEqual(
    { serial: e.serial, name: e.name, relation: e.relation, rel: e.rel, house: e.house, age: e.age, gender: e.gender, epic: e.epic, deleted: e.deleted, extra: e.extra },
    { serial: 7, name: 'राम कुमार', relation: 'पिता', rel: 'श्याम', house: '05', age: 40, gender: 'पुरूष', epic: 'UPY1234567', deleted: false, extra: undefined },
  );
});

test('parseEntries: an "O" in the serial font marks only the entry whose serial is on its row', () => {
  const struck = parseEntries([...entryLines(7, 500), line(10, 500.5, 'O', 'serial'), ...entryLines(8, 400)]);
  assert.deepEqual(struck.map((e) => [e.serial, e.deleted]), [[7, true], [8, false]]);

  const offRow = parseEntries([...entryLines(7, 500), line(10, 450, 'O', 'serial')]);
  assert.deepEqual(offRow.map((e) => [e.serial, e.deleted]), [[7, false]]);

  const hindiO = parseEntries([...entryLines(7, 500), line(10, 500, 'O', 'latin')]);
  assert.deepEqual(hindiO.map((e) => [e.serial, e.deleted]), [[7, false]]);
});

test('parseEntries: the E, S and R legend marks strike off the serial just right of them, drawn before or after it', () => {
  for (const mark of ['E', 'S', 'R']) {
    // main list: the mark is drawn after the serial
    const after = parseEntries([...entryLines(7, 500), line(10, 500, mark, 'serial')]);
    assert.deepEqual(after.map((e) => [e.serial, e.deleted]), [[7, true]], mark);
    // a supplement's deletion list: the mark is drawn before the serial, inside the open entry
    const lines = entryLines(7, 500);
    lines.splice(lines.length - 1, 0, line(10, 500, mark, 'serial'));
    const before = parseEntries(lines);
    assert.deepEqual(before.map((e) => [e.serial, e.deleted, e.extra]), [[7, true, undefined]], mark);
  }
});

test('parseEntries: a mark on a row shared by three entries strikes off only the serial right of it', () => {
  const at = (serial, x) => entryLines(serial, 500).map((ln) => ({ ...ln, x: ln.x + x }));
  // the deletion list's row "E 81  E 186  220": marks drawn before their serials
  const lines = [...at(81, 0), ...at(186, 170), ...at(220, 340)];
  const serialAt = (serial) => lines.findIndex((ln) => ln.text === String(serial));
  lines.splice(serialAt(81), 0, line(10, 500, 'E', 'serial'));
  lines.splice(serialAt(186), 0, line(180, 500, 'E', 'serial'));
  assert.deepEqual(parseEntries(lines).map((e) => [e.serial, e.deleted]), [[81, true], [186, true], [220, false]]);
  // a mark too far left of any serial strikes off nothing
  const far = parseEntries([...entryLines(7, 500), line(0, 500, 'E', 'serial')]);
  assert.deepEqual(far.map((e) => [e.serial, e.deleted]), [[7, false]]);
});

test('parseEntries: a "#" (modified entry) strikes off nothing and is not unplaced text', () => {
  const lines = entryLines(7, 500);
  lines.splice(lines.length - 1, 0, line(10, 500, '#', 'serial'));
  assert.deepEqual(parseEntries(lines).map((e) => [e.serial, e.deleted, e.extra]), [[7, false, undefined]]);
});

test('parseEntries: a page without a नाम label yields no entries', () => {
  assert.deepEqual(parseEntries([line(20, 500, '12', 'serial'), line(50, 500, 'कुल मतदाता')]), []);
});

test('addPageEntries: a supplement repeat keeps the first page and ORs the struck flag', () => {
  const bySerial = new Map();
  addPageEntries(bySerial, parseEntries(entryLines(9, 500)), 3);
  assert.equal(bySerial.get(9).struck, false);
  addPageEntries(bySerial, parseEntries([...entryLines(9, 300), line(10, 300, 'O', 'serial')]), 16);
  assert.equal(bySerial.size, 1);
  assert.deepEqual({ page: bySerial.get(9).page, struck: bySerial.get(9).struck }, { page: 3, struck: true });

  // a later repeat that is not struck off does not un-strike the entry
  addPageEntries(bySerial, parseEntries(entryLines(9, 300)), 17);
  assert.equal(bySerial.get(9).struck, true);
});

test('addPageEntries renames rel to relative, NFC-normalises strings and sets a missing EPIC to null', () => {
  const bySerial = new Map();
  addPageEntries(bySerial, [{ serial: 3, deleted: false, name: 'जांगिड़', rel: 'राम', relation: 'पिता', age: 1, gender: 'स्त्री', house: '1' }], 15);
  assert.deepEqual(bySerial.get(3), {
    serial: 3, page: 15, name: 'जांगिड़', relation: 'पिता', relative: 'राम', age: 1, gender: 'स्त्री', house: '1', epic: null, struck: false,
  });
});

// --- the committed roll ------------------------------------------------------------

test('decodeRoll decodes the Badli ward 1 roll to the expected entries', () => {
  const entries = decodeRoll(readFileSync(fixture('badli-ward1.pdf')));
  const expected = JSON.parse(readFileSync(fixture('badli-ward1-expected.json'), 'utf8'));
  const allSerials = JSON.parse(readFileSync(fixture('badli-ward1-all-serials.json'), 'utf8'));
  const norm = (v) => (typeof v === 'string' ? v.normalize('NFC') : v);

  // every printed entry, struck-off ones included, in roll order
  assert.deepEqual(entries.map((e) => e.serial), Array.from({ length: 326 }, (_, i) => i + 1));
  for (const e of entries) assert.equal(typeof e.struck, 'boolean', `serial ${e.serial}`);
  assert.deepEqual(
    entries.filter((e) => e.struck).map((e) => e.serial),
    allSerials.filter((e) => e.deleted).map((e) => e.serial),
  );
  assert.deepEqual(
    { serial: entries[0].serial, page: entries[0].page, name: entries[0].name },
    { serial: 1, page: 3, name: 'किशनादेवी' },
  );

  // every field of the expected file is present, under the same name
  for (const key of Object.keys(expected[0])) assert.ok(Object.hasOwn(entries[0], key), key);

  const live = new Map(entries.filter((e) => !e.struck).map((e) => [e.serial, e]));
  const matched = expected.filter((want) => {
    const got = live.get(want.serial);
    return got && Object.keys(want).every((k) => norm(got[k]) === norm(want[k]));
  }).length;
  assert.ok(matched >= 295, `matched ${matched} of ${expected.length}`);

  for (const e of entries) {
    assert.equal(e.name, e.name.normalize('NFC'), `serial ${e.serial} name is NFC`);
    assert.ok(!JSON.stringify(e).includes('�'), `serial ${e.serial} has an unmapped glyph`);
    assert.equal(e.extra, undefined, `serial ${e.serial} has unplaced text`);
  }
  // struck-off entries keep the page of the original list, not the supplement's repeat
  assert.equal(entries.find((e) => e.serial === 9).page, 3);
  assert.ok(entries.filter((e) => e.struck).every((e) => e.page < 15));
  // the supplement adds serials 319 to 326, without EPIC numbers
  const supplement = entries.filter((e) => e.serial >= 319);
  assert.deepEqual([...new Set(supplement.map((e) => e.page))], [15]);
  assert.ok(supplement.every((e) => e.epic === null && !e.struck));
});

// --- no OCR, Kruti Dev table or network call -------------------------------------

// Source with comments removed, aware of strings, template literals and regex
// literals, so a comment cannot hide code and a string cannot hide a comment.
function stripComments(src) {
  let out = '';
  let i = 0;
  let prev = '';
  while (i < src.length) {
    const ch = src[i];
    if (ch === '/' && src[i + 1] === '/') {
      while (i < src.length && src[i] !== '\n') i++;
    } else if (ch === '/' && src[i + 1] === '*') {
      const end = src.indexOf('*/', i + 2);
      i = end === -1 ? src.length : end + 2;
      out += ' ';
    } else if (ch === '"' || ch === "'" || ch === '`') {
      let j = i + 1;
      while (j < src.length && src[j] !== ch) j += src[j] === '\\' ? 2 : 1;
      out += src.slice(i, j + 1);
      i = j + 1;
      prev = ch;
    } else if (ch === '/' && (prev === '' || /[(,=:[!&|?{};+\-*%<>~^]/.test(prev))) {
      let j = i + 1;
      let inClass = false;
      while (j < src.length && src[j] !== '\n') {
        if (src[j] === '\\') { j += 2; continue; }
        if (src[j] === '[') inClass = true;
        else if (src[j] === ']') inClass = false;
        else if (src[j] === '/' && !inClass) break;
        j++;
      }
      out += src.slice(i, j + 1);
      i = j + 1;
      prev = '/';
    } else {
      out += ch;
      if (!/\s/.test(ch)) prev = ch;
      i++;
    }
  }
  return out;
}

const decoderCode = (file) => stripComments(readFileSync(new URL(`./${file}`, import.meta.url), 'utf8'));

test('stripComments drops comments but keeps code next to them', () => {
  assert.equal(stripComments('a(); /* x */ fetch(u); // y\nb("//", /\\/\\//)').replace(/\s+/g, ' '), 'a(); fetch(u); b("//", /\\/\\//)');
});

test('the decoding path uses no OCR, Kruti Dev table or network call', () => {
  const forbidden = /tesseract|\bocr\b|kruti|XMLHttpRequest|WebSocket|EventSource|sendBeacon|\bimport\s*\(/i;
  for (const file of ['decodeRoll.js', 'pdfReader.js', 'inflate.js', 'subsetCmap.js', 'trueTypeGlyphs.js', 'sha256.js']) {
    const code = decoderCode(file);
    assert.doesNotMatch(code, forbidden, file);
    assert.doesNotMatch(code, /\bfetch\s*\(/, file);
  }
  // glyphMap.js: outline matching only. Its one fetch is loadMasterTable's
  // read of the committed table next to the module (the app's own static
  // file); decodeRoll never calls it.
  const glyphMap = decoderCode('glyphMap.js');
  assert.doesNotMatch(glyphMap, /tesseract|\bocr\b|kruti|XMLHttpRequest|WebSocket|EventSource|sendBeacon/i);
  assert.equal(glyphMap.match(/\bfetch\s*\(/g).length, 1);
  assert.match(glyphMap, /const TABLE_URL = new URL\('\.\/master-glyph-table\.json', import\.meta\.url\);/);
  assert.match(glyphMap, /export async function loadMasterTable\(url = TABLE_URL\)[\s\S]*?await fetch\(url\)/);
  assert.doesNotMatch(decoderCode('decodeRoll.js'), /loadMasterTable/);
});

test('decodeRoll makes no network call at run time', () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = () => { throw new Error('network call from the decoder'); };
  try {
    assert.equal(decodeRoll(readFileSync(fixture('badli-ward1.pdf'))).length, 326);
  } finally {
    globalThis.fetch = realFetch;
  }
});
