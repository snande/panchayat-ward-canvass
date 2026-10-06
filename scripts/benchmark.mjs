// Usage: node scripts/benchmark.mjs
//
// Decodes fixtures/badli-ward1.pdf with src/decoder/decodeRoll.js, compares
// every entry field by field, by serial, against
// fixtures/badli-ward1-expected.json (297 entries; struck-off serials are not
// in it), writes reports/badli-ward1-benchmark.md and prints
//   {"total":297,"matched":<n>,"percent":<p>}
// on stdout. Exits non-zero when fewer than 295 entries match.
//
// Strings are compared after NFC normalisation on both sides: the decoder
// returns NFC, and the expected file spells ड़ with the precomposed U+095C,
// which NFC decomposes (U+0958-U+095F are composition exclusions). The two
// spellings are canonically equivalent; nothing else is relaxed.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { decodeRoll } from '../src/decoder/decodeRoll.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PDF = join(ROOT, 'fixtures/badli-ward1.pdf');
const EXPECTED = join(ROOT, 'fixtures/badli-ward1-expected.json');
const REPORT = join(ROOT, 'reports/badli-ward1-benchmark.md');
const PASS_MIN = 295;
const SAMPLE_MIN = 10;

const norm = (v) => (typeof v === 'string' ? v.normalize('NFC') : v);
const cell = (v) => (v === undefined ? '(missing)' : JSON.stringify(v)).replace(/\|/g, '\\|');

const expected = JSON.parse(readFileSync(EXPECTED, 'utf8'));
let decoded;
try {
  decoded = decodeRoll(readFileSync(PDF));
} catch (err) {
  console.error(`benchmark: decoding ${PDF} failed: ${err.message}`);
  process.exit(1);
}
const live = new Map(decoded.filter((e) => !e.deleted).map((e) => [e.serial, e]));

const matched = [];
const mismatches = []; // { serial, page, field, decoded, expected }
for (const want of expected) {
  const got = live.get(want.serial);
  if (!got) {
    mismatches.push({ serial: want.serial, page: undefined, field: '(entry)', decoded: undefined, expected: want.name });
    continue;
  }
  const bad = Object.keys(want).filter((k) => norm(got[k]) !== norm(want[k]));
  if (!bad.length) matched.push({ got, want });
  for (const field of bad) mismatches.push({ serial: want.serial, page: got.page, field, decoded: got[field], expected: want[field] });
}
const expectedSerials = new Set(expected.map((e) => e.serial));
for (const got of live.values()) {
  if (!expectedSerials.has(got.serial)) {
    mismatches.push({ serial: got.serial, page: got.page, field: '(unexpected entry)', decoded: got.name, expected: undefined });
  }
}

const total = expected.length;
const percent = Math.round((matched.length / total) * 10000) / 100;

// Side-by-side sample for the demo: the first matched entry on every page,
// topped up with the following ones until there are at least SAMPLE_MIN.
const sample = [];
const pages = new Set();
for (const m of matched) if (!pages.has(m.got.page)) { pages.add(m.got.page); sample.push(m); }
for (const m of matched) {
  if (sample.length >= SAMPLE_MIN) break;
  if (!sample.includes(m)) sample.push(m);
}
sample.sort((a, b) => a.got.serial - b.got.serial);

const lines = [
  '# Badli ward 1 decoder benchmark',
  '',
  'Input: `fixtures/badli-ward1.pdf`. Ground truth: `fixtures/badli-ward1-expected.json`.',
  'Decoder: `src/decoder/decodeRoll.js` (glyph outlines matched to `src/decoder/master-glyph-table.json`;',
  'no OCR, no Kruti Dev table, no network). Regenerate with `node scripts/benchmark.mjs`.',
  '',
  `**Score: ${matched.length} of ${total} entries match exactly (${percent}%).**`,
  '',
  `An entry matches when every field (${Object.keys(expected[0]).join(', ')}) is equal;`,
  'strings are compared NFC-normalised on both sides. The decoder also found',
  `${decoded.filter((e) => e.deleted).length} struck-off serials, which the expected file leaves out.`,
  '',
  '## Mismatched entries',
  '',
];
if (mismatches.length) {
  lines.push('| serial | page | field | decoded | expected |', '|---:|---:|---|---|---|');
  for (const x of mismatches) lines.push(`| ${x.serial} | ${x.page ?? '-'} | ${x.field} | ${cell(x.decoded)} | ${cell(x.expected)} |`);
} else {
  lines.push('None: every expected entry matched.', '', '| serial | page | field | decoded | expected |', '|---:|---:|---|---|---|');
}
lines.push(
  '',
  '## Side-by-side sample of matched entries',
  '',
  'Page is the PDF page number, for comparison with the rendered roll.',
  '',
  '| serial | PDF page | decoded name | expected name | decoded relative | expected relative |',
  '|---:|---:|---|---|---|---|',
);
for (const { got, want } of sample) {
  lines.push(`| ${got.serial} | ${got.page} | ${got.name} | ${want.name} | ${got.relative} | ${want.relative} |`);
}
lines.push('');

mkdirSync(dirname(REPORT), { recursive: true });
writeFileSync(REPORT, lines.join('\n'));

console.log(JSON.stringify({ total, matched: matched.length, percent }));
if (matched.length < PASS_MIN) {
  console.error(`benchmark: ${matched.length} of ${total} matched, below the ${PASS_MIN} required; see ${REPORT}`);
  process.exit(1);
}
