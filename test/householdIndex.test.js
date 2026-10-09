import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { buildHouseholdIndex, findHousehold, normaliseHouse } from '../src/households/householdIndex.js';
import { STORED_FIELDS, minimiseEntries } from '../src/roll/rollStore.js';

const MODULE_PATH = fileURLToPath(new URL('../src/households/householdIndex.js', import.meta.url));

function entry(serial, house, name = `मतदाता ${serial}`) {
  return { serial, name, relative: 'मोहन', age: 30, gender: 'पुरूष', house };
}

const serials = (household) => household.members.map((e) => e.serial);

test('normaliseHouse treats digit script, padding, case and separator spacing as the same house', () => {
  assert.equal(normaliseHouse('१२/३'), '12/3');
  assert.equal(normaliseHouse('  12/3 \t'), '12/3');
  assert.equal(normaliseHouse('12A'), normaliseHouse('12a'));
  assert.equal(normaliseHouse('12 / 3'), '12/3');
  assert.equal(normaliseHouse('12 - 3'), '12-3');
  assert.equal(normaliseHouse(' १२ / ३A '), '12/3a');
  assert.equal(normaliseHouse(null), '');
  assert.equal(normaliseHouse(undefined), '');
  assert.equal(normaliseHouse(12), '12');
});

test('normaliseHouse keeps houses that differ in any other character separate', () => {
  assert.notEqual(normaliseHouse('12/3'), normaliseHouse('12/4'));
  assert.notEqual(normaliseHouse('12A'), normaliseHouse('12B'));
  assert.notEqual(normaliseHouse('12 A'), normaliseHouse('12A'));
  assert.notEqual(normaliseHouse('12/3'), normaliseHouse('12-3'));
  assert.notEqual(normaliseHouse('12/3'), normaliseHouse('123'));
});

test('buildHouseholdIndex groups by normalised house with members in ascending serial order', () => {
  const entries = [
    entry(9, '12/3'),
    entry(2, '१२/३'),
    entry(5, ' 12 / 3 '),
    entry(4, '7A'),
    entry(1, '7a'),
    entry(3, '7B'),
  ];
  const before = entries.map((e) => e.serial);
  const index = buildHouseholdIndex(entries, 'ward-1');

  assert.ok(index instanceof Map);
  assert.deepEqual([...index.keys()].sort(), ['12/3', '7a', '7b']);
  assert.deepEqual(serials(index.get('12/3')), [2, 5, 9]);
  assert.deepEqual(serials(index.get('7a')), [1, 4]);
  assert.deepEqual(serials(index.get('7b')), [3]);
  assert.equal(index.get('12/3').ward, 'ward-1');
  assert.equal(index.get('12/3').key, '12/3');
  assert.equal(index.get('12/3').members[0], entries[1]);
  assert.deepEqual(entries.map((e) => e.serial), before, 'input array is not reordered');
});

test('buildHouseholdIndex accepts the entries rollStore keeps (STORED_FIELDS via minimiseEntries)', () => {
  // Decoder-shaped entries, including a struck-off one and fields rollStore drops.
  const decoded = [
    { serial: 8, page: 3, name: 'सीता', relation: 'पति', relative: 'राम', age: 40, gender: 'स्त्री', house: '१२/३', epic: 'UPY1', deleted: false },
    { serial: 4, page: 3, name: 'राम', relation: 'पिता', relative: 'श्याम', age: 45, gender: 'पुरूष', house: '12 / 3', epic: 'UPY2', deleted: false },
    { serial: 6, page: 3, name: 'गीता', relation: 'पिता', relative: 'राम', age: 20, gender: 'स्त्री', house: '12/3', epic: 'UPY3', deleted: true },
    { serial: 2, page: 2, name: 'मोहन', relation: 'पिता', relative: 'सोहन', age: 50, gender: 'पुरूष', house: null, epic: 'UPY4', deleted: false },
  ];
  const stored = minimiseEntries(decoded);
  for (const e of stored) assert.deepEqual(Object.keys(e).sort(), [...STORED_FIELDS].sort());

  const index = buildHouseholdIndex(stored, 'ward-3');
  assert.equal(index.size, 1);
  const household = findHousehold(index, '12/3');
  assert.deepEqual(serials(household), [4, 8]);
  assert.equal(household.ward, 'ward-3');
});

test('entries with an empty or missing house are excluded and never merged', () => {
  const entries = [entry(1, ''), entry(2, '   '), entry(3, undefined), entry(4, null), entry(5, '4')];
  delete entries[2].house;
  const index = buildHouseholdIndex(entries, 'w');
  assert.equal(index.size, 1);
  assert.deepEqual(serials(index.get('4')), [5]);
  for (const household of index.values()) {
    for (const member of household.members) assert.ok(member.serial === 5);
  }
  assert.equal(findHousehold(index, ''), null);
  assert.equal(findHousehold(index, '   '), null);
});

test('findHousehold returns the matching household for any equivalent spelling, else null', () => {
  const index = buildHouseholdIndex([entry(1, '12/3'), entry(2, '12/3A'), entry(3, '5')], 'w');
  assert.equal(findHousehold(index, '१२ / ३'), index.get('12/3'));
  assert.deepEqual(serials(findHousehold(index, ' 12/3a ')), [2]);
  assert.equal(findHousehold(index, '12/4'), null);
  assert.equal(findHousehold(index, '99'), null);
  assert.equal(findHousehold(index, null), null);
  assert.equal(findHousehold(index, undefined), null);
  assert.equal(findHousehold(null, '5'), null);
});

test('buildHouseholdIndex rejects a non-array', () => {
  assert.throws(() => buildHouseholdIndex(null, 'w'), TypeError);
});

test('module is in-memory only: no network or storage access', () => {
  const src = readFileSync(MODULE_PATH, 'utf8');
  for (const banned of ['fetch(', 'XMLHttpRequest', 'WebSocket', 'indexedDB', 'localStorage', 'sessionStorage']) {
    assert.ok(!src.includes(banned), `module must not use ${banned}`);
  }
});
