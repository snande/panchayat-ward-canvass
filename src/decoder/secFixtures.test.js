// decodeRoll against the reference decoder on five SEC wards, one per
// district (fixtures/sec/expected-fixtures.json). Each .expected.json is
// written offline by tools/reference-decoder/decode.py --expected; this test
// holds the JavaScript decoder to it line for line: every printed entry, in
// printed order, struck-off ones included with struck: true.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { test } from 'node:test';

import { decodeRoll } from './decodeRoll.js';

const root = new URL('../../', import.meta.url);
const read = (rel) => readFileSync(new URL(rel, root));
const fixtures = JSON.parse(read('fixtures/sec/expected-fixtures.json').toString('utf8'));

// The expected files' shape, in their key order.
const line = (e) => JSON.stringify({
  serial: e.serial, name: e.name, relative: e.relative, age: e.age, gender: e.gender, house: e.house, struck: e.struck,
});

test('the SEC fixture list names five wards, each from a different district directory', () => {
  assert.equal(fixtures.length, 5);
  assert.equal(new Set(fixtures.map((f) => dirname(f.pdf))).size, 5);
  for (const f of fixtures) assert.equal(dirname(f.expected), dirname(f.pdf));
});

for (const { pdf, expected } of fixtures) {
  test(`decodeRoll matches ${expected} line for line, struck-off entries included`, () => {
    const want = JSON.parse(read(expected).toString('utf8')).map(line);
    const got = decodeRoll(read(pdf)).map(line);
    assert.ok(want.length > 0);
    assert.ok(want.some((l) => JSON.parse(l).struck === true), 'the ward has struck-off entries');
    for (let i = 0; i < Math.max(got.length, want.length); i += 1) {
      assert.equal(got[i], want[i], `${pdf} line ${i + 1}`);
    }
    assert.equal(got.length, want.length);
  });
}
