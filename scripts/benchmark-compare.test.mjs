import assert from 'node:assert/strict';
import { test } from 'node:test';

import { compareEntries, renderReport, sampleMatched } from './benchmark-compare.mjs';

const want = (serial, extra = {}) => ({
  serial, name: 'राम', relation: 'पिता', relative: 'श्याम', age: 40, gender: 'पुरूष', house: '1', epic: `UPY${serial}`, ...extra,
});
const got = (serial, page, extra = {}) => ({ ...want(serial), page, struck: false, ...extra });

test('an entry matches only when every expected field is equal', () => {
  const r = compareEntries([got(1, 3), got(2, 3, { age: 41 })], [want(1), want(2)]);
  assert.equal(r.matched.length, 1);
  assert.deepEqual(r.mismatches, [{ serial: 2, page: 3, field: 'age', decoded: 41, expected: 40 }]);
  assert.equal(r.percent, 50);
});

test('a key the decoder leaves undefined is a mismatch, even against an expected null', () => {
  const decoded = got(319, 15);
  delete decoded.epic;
  const r = compareEntries([decoded], [want(319, { epic: null })]);
  assert.equal(r.matched.length, 0);
  assert.deepEqual(r.mismatches, [{ serial: 319, page: 15, field: 'epic', decoded: undefined, expected: null }]);
});

test('a decoded null matches an expected null', () => {
  const r = compareEntries([got(319, 15, { epic: null })], [want(319, { epic: null })]);
  assert.equal(r.matched.length, 1);
});

test('strings compare under NFC: precomposed and decomposed ड़ are the same name', () => {
  const r = compareEntries([got(51, 5, { name: 'जांगिड़' })], [want(51, { name: 'जांगिड़' })]);
  assert.equal(r.matched.length, 1);
  const different = compareEntries([got(51, 5, { name: 'जांगिड' })], [want(51, { name: 'जांगिड़' })]);
  assert.equal(different.matched.length, 0);
});

test('a missing entry is reported with the page of the nearest decoded serial before it', () => {
  const r = compareEntries([got(1, 3), got(2, 3), got(4, 4)], [want(1), want(2), want(3), want(4)]);
  assert.deepEqual(r.mismatches, [{ serial: 3, page: 3, field: '(entry not decoded)', decoded: undefined, expected: 'राम' }]);
});

test('an expected entry the decoder struck off is a mismatch on its own page', () => {
  const r = compareEntries([got(1, 3), got(2, 4, { struck: true })], [want(1), want(2)]);
  assert.deepEqual(r.mismatches, [{ serial: 2, page: 4, field: 'struck', decoded: true, expected: false }]);
  assert.equal(r.struck, 1);
});

test('a decoded live entry the expected file lacks is a mismatch', () => {
  const r = compareEntries([got(1, 3), got(9, 3)], [want(1)]);
  assert.equal(r.matched.length, 1);
  assert.deepEqual(r.mismatches.map((x) => [x.serial, x.page, x.field]), [[9, 3, '(entry not expected)']]);
});

test('the sample covers every page and has at least the minimum size', () => {
  const matched = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12].map((s) => ({ got: got(s, s < 11 ? 3 : 4), want: want(s) }));
  const sample = sampleMatched(matched, 10);
  assert.equal(sample.length, 10);
  assert.deepEqual([...new Set(sample.map((m) => m.got.page))], [3, 4]);
});

test('the report has the score line, a mismatch row per field with its page, and the side-by-side table', () => {
  const decoded = [got(1, 3), got(2, 3, { name: 'सीता' }), ...Array.from({ length: 10 }, (_, i) => got(i + 3, 4))];
  const expected = [want(1), want(2), ...Array.from({ length: 10 }, (_, i) => want(i + 3))];
  const report = renderReport(compareEntries(decoded, expected), { fields: Object.keys(want(1)) });
  assert.match(report, /\*\*Score: 11 of 12 entries match exactly \(91\.67%\)\.\*\*/);
  assert.match(report, /\| 2 \| 3 \| name \| "सीता" \| "राम" \|/);
  assert.match(report, /\| serial \| PDF page \| decoded name \| expected name \|/);
  assert.equal((report.match(/^\| \d+ \| [34] \| राम \| राम \|/gm) ?? []).length, 10);
});

test('a clean run says so instead of printing an empty mismatch table', () => {
  const report = renderReport(compareEntries([got(1, 3)], [want(1)]), { fields: Object.keys(want(1)) });
  assert.match(report, /None: all expected entries match/);
  assert.doesNotMatch(report, /\| serial \| page \| field \|/);
});
