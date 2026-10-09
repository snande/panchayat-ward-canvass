// Five SEC ward rolls, one per district under fixtures/sec/, decoded by
// decodeRoll and compared line for line (serial order, name, relative, age,
// gender, house, struck) with the reference decoder's output
// (tools/reference-decoder/decode.py, converted by expected.py). Struck-off
// entries are part of the roll and must come back with struck: true.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';

import { decodeRoll } from '../src/decoder/decodeRoll.js';

const fixture = (rel) => new URL('../fixtures/sec/' + rel, import.meta.url);
const table = JSON.parse(readFileSync(new URL('../src/decoder/master-glyph-table.json', import.meta.url), 'utf8'));

// One roll per district; ARAUDA ward 3 prints struck-off entries.
const ROLLS = [
  'bharatpur/ARAUDA-ward-003',
  'bhilwara/ALMAS-ward-002-supp-2',
  'bikaner/BHOLASAR-ward-001-supp-2',
  'jodhpur/ASHAPURA-ward-003',
  'udaipur/AMARPURA-ward-002-supp-2',
];
const FIELDS = ['serial', 'name', 'relative', 'age', 'gender', 'house', 'struck'];
const project = (e) => Object.fromEntries(FIELDS.map((k) => [k, e[k] ?? null]));

const decoded = new Map();
const decode = (roll) => {
  if (!decoded.has(roll)) decoded.set(roll, decodeRoll(readFileSync(fixture(`${roll}.pdf`)), { table }));
  return decoded.get(roll);
};

test('the five rolls come from five different districts', () => {
  assert.equal(new Set(ROLLS.map((r) => r.split('/')[0])).size, 5);
});

for (const roll of ROLLS) {
  test(`${roll}: every printed serial is returned in order with a boolean struck flag`, () => {
    const entries = decode(roll);
    assert.ok(entries.length > 100, `${entries.length} entries`);
    assert.deepEqual(entries.map((e) => e.serial), Array.from({ length: entries.length }, (_, i) => i + 1));
    for (const e of entries) assert.equal(typeof e.struck, 'boolean', `serial ${e.serial}`);
  });

  // A missing expected file fails: the comparison is the acceptance check.
  const expectedFile = fixture(`${roll}-expected.json`);
  test(`${roll}: decodeRoll matches the reference decoder line for line`, () => {
    assert.ok(existsSync(expectedFile),
      `fixtures/sec/${roll}-expected.json is missing: generate it with tools/reference-decoder/decode.py, then expected.py, and commit it`);
    const expected = JSON.parse(readFileSync(expectedFile, 'utf8'));
    const got = decode(roll).map(project);
    assert.equal(got.length, expected.length, 'entry count');
    for (let i = 0; i < expected.length; i += 1) {
      assert.deepEqual(got[i], project(expected[i]), `line ${i + 1}`);
    }
  });
}

test('struck-off entries are kept: ARAUDA ward 3 has struck and live entries', () => {
  const entries = decode('bharatpur/ARAUDA-ward-003');
  const struck = entries.filter((e) => e.struck);
  assert.ok(struck.length > 0);
  assert.ok(entries.some((e) => !e.struck));
});
