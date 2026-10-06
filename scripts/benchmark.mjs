// Usage: node scripts/benchmark.mjs
//
// Decodes fixtures/badli-ward1.pdf with src/decoder/decodeRoll.js, compares
// every entry field by field, by serial, against
// fixtures/badli-ward1-expected.json (297 entries; struck-off serials are not
// in it), writes reports/badli-ward1-benchmark.md and prints
//   {"total":297,"matched":<n>,"percent":<p>}
// on stdout. Exits non-zero when fewer than 295 entries match. The scoring
// rules (NFC comparison, mismatch pages) are in scripts/benchmark-compare.mjs.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { decodeRoll } from '../src/decoder/decodeRoll.js';
import { compareEntries, renderReport } from './benchmark-compare.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PDF = join(ROOT, 'fixtures/badli-ward1.pdf');
const EXPECTED = join(ROOT, 'fixtures/badli-ward1-expected.json');
const REPORT = join(ROOT, 'reports/badli-ward1-benchmark.md');
const PASS_MIN = 295;

const expected = JSON.parse(readFileSync(EXPECTED, 'utf8'));
let decoded;
try {
  decoded = decodeRoll(readFileSync(PDF));
} catch (err) {
  console.error(`benchmark: decoding ${PDF} failed: ${err.message}`);
  process.exit(1);
}

const result = compareEntries(decoded, expected);
mkdirSync(dirname(REPORT), { recursive: true });
writeFileSync(REPORT, renderReport(result, { fields: Object.keys(expected[0]) }));

console.log(JSON.stringify({ total: result.total, matched: result.matched.length, percent: result.percent }));
if (result.matched.length < PASS_MIN) {
  console.error(`benchmark: ${result.matched.length} of ${result.total} matched, below the ${PASS_MIN} required; see ${REPORT}`);
  process.exit(1);
}
