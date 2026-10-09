// decodeRoll against the reference decoder on five SEC ward rolls, one per
// district directory under fixtures/sec/. Each <roll>.expected.json is the
// reference decoder's output for that PDF (tools/reference-decoder/
// expected.py): every printed entry, struck-off ones included, in serial
// order, with the fields the app stores. The match is line for line.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { decodeRoll } from '../src/decoder/decodeRoll.js';
import { STORED_FIELDS } from '../src/roll/rollStore.js';

const ROLLS = [
  'bharatpur/ARAUDA-ward-001',
  'bhilwara/ALMAS-ward-001-supp-2',
  'bikaner/BHOLASAR-ward-001-supp-2',
  'jodhpur/ASHAPURA-ward-005-supp-2',
  'udaipur/AMARPURA-ward-001-supp-2',
];
const fixture = (name) => new URL(`../fixtures/sec/${name}`, import.meta.url);

// The fixture row of a decoded entry; a field the roll does not print is null.
const row = (entry) => Object.fromEntries(STORED_FIELDS.map((k) => [k, entry[k] ?? null]));

test('the five rolls come from five different district directories', () => {
  assert.equal(new Set(ROLLS.map((r) => r.split('/')[0])).size, 5);
});

for (const roll of ROLLS) {
  test(`decodeRoll matches the reference decoder line for line: ${roll}`, () => {
    const expected = JSON.parse(readFileSync(fixture(`${roll}.expected.json`), 'utf8'));
    const entries = decodeRoll(readFileSync(fixture(`${roll}.pdf`)));

    assert.ok(expected.some((e) => e.struck === true), 'the fixture has a struck-off entry');
    for (const e of entries) assert.equal(typeof e.struck, 'boolean', `serial ${e.serial} struck is a boolean`);
    assert.deepEqual(entries.map((e) => e.serial), expected.map((e) => e.serial), 'same serials in the same order');
    for (let i = 0; i < expected.length; i += 1) {
      assert.deepEqual(row(entries[i]), expected[i], `line ${i + 1} (serial ${expected[i].serial})`);
    }
  });
}

test('a supplement strikes off further entries: Ashapura ward 5 Final vs Final with Supp-2', () => {
  const struck = (name) => decodeRoll(readFileSync(fixture(`${name}.pdf`))).filter((e) => e.struck).map((e) => e.serial);
  const final = struck('jodhpur/ASHAPURA-ward-005');
  const supp = struck('jodhpur/ASHAPURA-ward-005-supp-2');
  assert.ok(final.every((s) => supp.includes(s)), 'every entry struck off in the Final roll stays struck off');
  assert.ok(supp.length > final.length);
});
