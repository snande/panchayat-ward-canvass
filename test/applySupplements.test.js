// Supplementary SEC rolls merged onto the ward roll (issue #127), run by
// `npm test`: the ALMAS ward 1 supplement (the SEC's "Final With Supp-2"
// column), decoded by the same decoder, merged onto the ALMAS ward 1 roll.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { applySupplements, isSupplementDeletion, SUPPLEMENT_KINDS } from '../src/roll/applySupplements.js';
import { decodeRoll } from '../src/decoder/decodeRoll.js';

const read = (rel) => readFileSync(new URL('../' + rel, import.meta.url));
const BASE = 'fixtures/sec/bhilwara/ALMAS-ward-001.pdf';
const SUPP = 'fixtures/sec/bhilwara/ALMAS-ward-001-supp-2.pdf';
// The reference decoder's entries for the supplement (tools/reference-decoder).
const printed = JSON.parse(read('fixtures/sec/bhilwara/ALMAS-ward-001-supp-2.expected.json').toString('utf8'));

const line = (e) => JSON.stringify({
  serial: e.serial, name: e.name, relative: e.relative, age: e.age, gender: e.gender, house: e.house, struck: e.struck,
});

test('the ALMAS ward 1 supplement merges onto the roll as the entries the supplement prints', () => {
  const base = decodeRoll(read(BASE));
  const supplement = decodeRoll(read(SUPP));
  const merged = applySupplements(base, [supplement]);

  // Every merged entry is the line the supplement prints, struck-off ones included.
  assert.equal(merged.length, printed.length);
  merged.forEach((e, i) => assert.equal(line(e), line(printed[i]), `line ${i + 1}`));

  // What the supplement changed: serials the roll lacks are additions, and
  // entries it strikes off that the roll listed live are deletions.
  const inBase = new Map(base.map((e) => [e.serial, e]));
  const additions = printed.filter((e) => !e.struck && (!inBase.has(e.serial) || inBase.get(e.serial).struck))
    .map((e) => e.serial);
  const deletions = printed.filter((e) => e.struck && !(inBase.get(e.serial) || {}).struck).map((e) => e.serial);
  assert.deepEqual(merged.filter((e) => e.supplement === 'addition').map((e) => e.serial), additions);
  assert.deepEqual(merged.filter(isSupplementDeletion).map((e) => e.serial), deletions);
  // This supplement strikes off serial 258 and adds no one.
  assert.deepEqual(deletions, [258]);
  assert.deepEqual(additions, []);
  const deleted = merged.find((e) => e.serial === 258);
  assert.equal(deleted.struck, true);
  assert.equal(deleted.name, inBase.get(258).name);

  // Entries the roll already printed struck off stay untagged, and the inputs are untouched.
  for (const e of merged.filter((m) => inBase.get(m.serial).struck)) assert.equal(e.supplement, undefined);
  assert.equal(inBase.get(258).struck, false);
  assert.ok(base.every((e) => !('supplement' in e)));
  // Merging the same supplement again changes nothing.
  assert.deepEqual(applySupplements(merged, [supplement]), merged);
});

test('a serial the roll lacks is an addition, or a deletion when printed struck off', () => {
  const base = [{ serial: 1, name: 'क', struck: false }, { serial: 2, name: 'ख', struck: true }];
  const merged = applySupplements(base, [[
    { serial: 1, name: 'क', struck: false },
    { serial: 2, name: 'ख', struck: true },
    { serial: 3, name: 'ग', struck: false },
    { serial: 4, name: 'घ', struck: true },
  ]]);
  assert.deepEqual(merged.map((e) => [e.serial, e.struck, e.supplement]), [
    [1, false, undefined], [2, true, undefined], [3, false, 'addition'], [4, true, 'deletion'],
  ]);
  assert.deepEqual(SUPPLEMENT_KINDS, ['addition', 'deletion']);
});

test('a serial the roll struck off but the supplement prints live is reinstated as an addition', () => {
  const base = [{ serial: 1, name: 'क', age: 40, struck: true }, { serial: 2, name: 'ख', struck: false }];
  const merged = applySupplements(base, [[
    { serial: 1, name: 'क (reprint)', age: 41, struck: false },
    { serial: 2, name: 'ख', struck: false },
  ]]);
  // The merged roll shows what the supplement prints: serial 1 is on the roll again.
  assert.deepEqual(merged.map((e) => [e.serial, e.struck, e.supplement]), [[1, false, 'addition'], [2, false, undefined]]);
  // The roll's own record is kept; only the struck-off state changes.
  assert.equal(merged[0].name, 'क');
  assert.equal(merged[0].age, 40);
});

test('supplements apply in publication order: a later one can strike off an earlier addition', () => {
  const base = [{ serial: 1, name: 'क', struck: false }];
  const supp1 = [{ serial: 1, name: 'क', struck: false }, { serial: 2, name: 'ख', struck: false }];
  const supp2 = [{ serial: 1, name: 'क', struck: true }, { serial: 2, name: 'ख', struck: true }];
  const merged = applySupplements(base, [supp1, supp2]);
  assert.deepEqual(merged.map((e) => [e.serial, e.struck, e.supplement]), [[1, true, 'deletion'], [2, true, 'deletion']]);
  // No supplement leaves the roll as it was.
  assert.deepEqual(applySupplements(base, []), base);
  assert.deepEqual(applySupplements(base), base);
  assert.throws(() => applySupplements(null, []), TypeError);
});
