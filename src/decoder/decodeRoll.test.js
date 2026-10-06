import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { deflateRawSync, deflateSync } from 'node:zlib';

import { decodeRoll, readLiteral, reorder } from './decodeRoll.js';
import { inflate } from './inflate.js';

const cps = (s) => [...s].map((c) => c.codePointAt(0));
const str = (a) => String.fromCodePoint(...a);
const fixture = (name) => new URL(`../../fixtures/${name}`, import.meta.url);

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

test('decodeRoll decodes the Badli ward 1 roll to the expected entries', () => {
  const entries = decodeRoll(readFileSync(fixture('badli-ward1.pdf')));
  const expected = JSON.parse(readFileSync(fixture('badli-ward1-expected.json'), 'utf8'));
  const norm = (v) => (typeof v === 'string' ? v.normalize('NFC') : v);

  assert.equal(entries.length, 326);
  assert.deepEqual(entries.map((e) => e.serial), Array.from({ length: 326 }, (_, i) => i + 1));
  assert.equal(entries.filter((e) => e.deleted).length, 29);
  assert.deepEqual(
    { serial: entries[0].serial, page: entries[0].page, name: entries[0].name },
    { serial: 1, page: 3, name: 'किशनादेवी' },
  );

  const live = new Map(entries.filter((e) => !e.deleted).map((e) => [e.serial, e]));
  const matched = expected.filter((want) => {
    const got = live.get(want.serial);
    return got && Object.keys(want).every((k) => norm(got[k]) === norm(want[k]));
  }).length;
  assert.ok(matched >= 295, `matched ${matched} of ${expected.length}`);

  for (const e of entries) {
    assert.equal(e.name, e.name.normalize('NFC'), `serial ${e.serial} name is NFC`);
    assert.ok(!JSON.stringify(e).includes('�'), `serial ${e.serial} has an unmapped glyph`);
    assert.equal(e.extra, undefined, `serial ${e.serial} has unplaced text`);
    assert.ok(Number.isInteger(e.page) && e.page >= 3);
  }
  assert.equal(entries.find((e) => e.serial === 319).epic, null);
});

test('the decoding path uses no OCR, Kruti Dev table or network call', () => {
  for (const file of ['decodeRoll.js', 'pdfReader.js', 'inflate.js', 'subsetCmap.js']) {
    const code = readFileSync(new URL(`./${file}`, import.meta.url), 'utf8')
      .split('\n').filter((line) => !/^\s*(\/\/|\/?\*)/.test(line)).join('\n');
    assert.doesNotMatch(code, /\bfetch\s*\(|XMLHttpRequest|WebSocket|\bimport\s*\(|tesseract|kruti/i, file);
  }
});
