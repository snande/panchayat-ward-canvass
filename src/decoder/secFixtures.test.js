// decodeRoll against the reference decoder on five SEC ward rolls, one per
// district directory under fixtures/sec/ (issue #126). Each PDF's expected
// entries are written by tools/reference-decoder/decode.py --expected from
// fixtures/sec/expected-fixtures.json: one line per serial, in serial order,
// with serial, name, relative, age, gender, house and the struck flag. CI
// regenerates them before `npm test`, so a missing file only skips locally.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { decodeRoll } from './decodeRoll.js';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const FIXTURES = JSON.parse(readFileSync(join(ROOT, 'fixtures/sec/expected-fixtures.json'), 'utf8'));
const FIELDS = ['serial', 'name', 'relative', 'age', 'gender', 'house', 'struck'];

/** One JSON line per entry, the fields in FIELDS order; a field the roll lacks is null. */
const asLines = (entries) => entries.map((e) => JSON.stringify(Object.fromEntries(FIELDS.map((k) => [k, e[k] ?? null]))));

test('the expected fixtures are five ward PDFs, each from a different district directory', () => {
  assert.equal(FIXTURES.length, 5);
  const districts = FIXTURES.map(({ pdf }) => pdf.split('/').at(-2));
  assert.equal(new Set(districts).size, 5, districts.join(', '));
  for (const { pdf, expected } of FIXTURES) {
    assert.match(pdf, /^fixtures\/sec\/[a-z]+\/[^/]+\.pdf$/);
    assert.match(expected, /^fixtures\/sec\/[a-z]+\/[^/]+\.expected\.json$/);
    assert.ok(existsSync(join(ROOT, pdf)), pdf);
  }
});

for (const { pdf, expected } of FIXTURES) {
  test(`decodeRoll matches the reference decoder line for line: ${pdf}`, (t) => {
    const path = join(ROOT, expected);
    if (!existsSync(path)) {
      t.skip(`${expected} not generated; run tools/reference-decoder/decode.py --expected`);
      return;
    }
    const decoded = decodeRoll(readFileSync(join(ROOT, pdf)));
    for (const e of decoded) assert.equal(typeof e.struck, 'boolean', `serial ${e.serial}`);
    assert.deepEqual(asLines(decoded), asLines(JSON.parse(readFileSync(path, 'utf8'))));
  });
}

test('struck-off entries are kept and flagged in the SEC rolls, not dropped', () => {
  let struck = 0;
  for (const { pdf } of FIXTURES) {
    const decoded = decodeRoll(readFileSync(join(ROOT, pdf)));
    // every printed serial is returned, in order, struck-off ones included
    assert.deepEqual(decoded.map((e) => e.serial), Array.from({ length: decoded.length }, (_, i) => i + 1), pdf);
    struck += decoded.filter((e) => e.struck).length;
  }
  assert.ok(struck > 0, 'no struck-off entry decoded across the five rolls');
});
