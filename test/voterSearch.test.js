import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';

import {
  buildSearchIndex,
  searchVoters,
  parseWardSerial,
  voterKey,
} from '../src/search/voterSearch.js';

const MODULE_PATH = fileURLToPath(new URL('../src/search/voterSearch.js', import.meta.url));

function entry(ward, serial, name, extra = {}) {
  return {
    ward,
    booth: 1,
    serial,
    name,
    relative: 'मोहन',
    age: 40,
    gender: 'M',
    house: String(serial),
    ...extra,
  };
}

const RAMESH = entry(1, 7, 'रमेश', { relative: 'सुरेश कुमार', house: '12-क', epic: 'RJX1234567' });
const ROLL = [
  RAMESH,
  entry(1, 8, 'सीता देवी', { gender: 'F', age: 33 }),
  entry(2, 3, 'रमेश चंद्र', { relative: 'राम सिंह', age: 61 }),
  entry(2, 145, 'कमला', { gender: 'F', age: 25, booth: 2 }),
  entry(3, 145, 'अभिषेक यादव', { age: 19, booth: 3 }),
  entry(3, 146, 'पूजा', { gender: 'F', age: 22, booth: 3, relative: 'रमेश' }),
];

const names = (results) => results.map((r) => r.entry.name);
const highlighted = (r) => r.ranges.map(({ start, end }) => String(r.entry[r.field]).slice(start, end));

test('builds an index and searches it without touching the entries', () => {
  const before = structuredClone(ROLL);
  const index = buildSearchIndex(ROLL);
  const res = searchVoters(index, 'ramesh');
  assert.ok(Array.isArray(res));
  assert.equal(res[0].entry, RAMESH);
  assert.deepEqual(ROLL, before);
  assert.deepEqual(searchVoters(buildSearchIndex([]), 'ramesh'), []);
  assert.deepEqual(searchVoters(null, 'ramesh'), []);
});

test('Latin and Devanagari queries, whole and partial, find रमेश', () => {
  const index = buildSearchIndex([RAMESH, entry(1, 9, 'कमला')]);
  for (const q of ['ramesh', 'Ramesh', 'रमेश', 'rame', 'रमे']) {
    const res = searchVoters(index, q);
    assert.deepEqual(names(res), ['रमेश'], q);
    assert.equal(res[0].field, 'name', q);
  }
});

test('common spelling variants map across scripts', () => {
  const cases = [
    ['singh', 'राम सिंह'],
    ['pooja', 'पूजा'],
    ['puja', 'पूजा'],
    ['laxmi', 'लक्ष्मी'],
    ['lakshmi', 'लक्ष्मी'],
    ['krishna', 'कृष्ण'],
    ['abhishek', 'अभिषेक'],
    ['kamla', 'कमला'],
    ['geeta', 'गीता'],
    ['shyam', 'श्याम'],
    ['sanjay', 'संजय'],
    ['zakir', 'ज़ाकिर'],
    ['amit', 'अमित'],
  ];
  for (const [q, name] of cases) {
    const res = searchVoters(buildSearchIndex([entry(1, 1, name)]), q);
    assert.equal(res.length, 1, `${q} -> ${name}`);
  }
});

test('Devanagari normalisation folds nukta, chandrabindu and vowel length', () => {
  const index = buildSearchIndex([entry(1, 1, 'ज़ाकिर'), entry(1, 2, 'चाँद'), entry(1, 3, 'सुनीता')]);
  assert.deepEqual(names(searchVoters(index, 'जाकिर')), ['ज़ाकिर']);
  assert.deepEqual(names(searchVoters(index, 'चांद')), ['चाँद']);
  assert.deepEqual(names(searchVoters(index, 'सुनिता')), ['सुनीता']);
  assert.deepEqual(names(searchVoters(index, 'सूनीता')), ['सुनीता']);
});

test('matches relative, house, serial and epic', () => {
  const index = buildSearchIndex([RAMESH, entry(1, 9, 'कमला', { house: '44' })]);
  const byRelative = searchVoters(index, 'suresh');
  assert.equal(byRelative[0].entry, RAMESH);
  assert.equal(byRelative[0].field, 'relative');
  assert.deepEqual(highlighted(byRelative[0]), ['सुरेश']);

  const byHouse = searchVoters(index, '12');
  assert.equal(byHouse[0].entry, RAMESH);
  assert.equal(byHouse[0].field, 'house');

  const bySerial = searchVoters(index, '9');
  assert.equal(bySerial[0].entry.serial, 9);
  assert.equal(bySerial[0].field, 'serial');

  const byEpic = searchVoters(index, 'rjx123');
  assert.equal(byEpic[0].entry, RAMESH);
  assert.equal(byEpic[0].field, 'epic');
  assert.deepEqual(byEpic[0].ranges, [{ start: 0, end: 6 }]);
});

test('an entry without epic is searchable on its other fields and never throws', () => {
  const noEpic = entry(1, 5, 'कमला', { relative: 'रमेश' });
  const index = buildSearchIndex([noEpic, { ...noEpic, serial: 6, epic: null }, { ...noEpic, serial: 7, epic: '' }]);
  assert.equal(searchVoters(index, 'kamla').length, 3);
  assert.equal(searchVoters(index, 'ramesh')[0].field, 'relative');
  assert.deepEqual(searchVoters(index, 'RJX'), []);
  assert.doesNotThrow(() => buildSearchIndex([null, {}, { name: null }, noEpic]));
  assert.doesNotThrow(() => searchVoters(buildSearchIndex([{}, { name: 'राम' }]), 'ram'));
});

test('ranges point into the original Devanagari text', () => {
  const index = buildSearchIndex([RAMESH]);
  assert.deepEqual(searchVoters(index, 'ramesh')[0].ranges, [{ start: 0, end: 4 }]);
  assert.deepEqual(searchVoters(index, 'रमेश')[0].ranges, [{ start: 0, end: 4 }]);
  assert.deepEqual(highlighted(searchVoters(index, 'rame')[0]), ['रमे']);

  const two = buildSearchIndex([entry(1, 1, 'रमेश चंद्र')]);
  assert.deepEqual(highlighted(searchVoters(two, 'chandra')[0]), ['चंद्र']);

  // A highlight never starts on a lone vowel sign.
  assert.deepEqual(highlighted(searchVoters(index, 'esh')[0]), ['मेश']);

  // Every occurrence is returned.
  const repeat = buildSearchIndex([entry(1, 1, 'राम राम')]);
  assert.deepEqual(searchVoters(repeat, 'ram')[0].ranges, [
    { start: 0, end: 3 },
    { start: 4, end: 7 },
  ]);
});

test('parseWardSerial', () => {
  assert.deepEqual(parseWardSerial('3/145'), { ward: 3, serial: 145 });
  assert.deepEqual(parseWardSerial(' 3 / 145 '), { ward: 3, serial: 145 });
  assert.deepEqual(parseWardSerial('३/१४५'), { ward: 3, serial: 145 });
  for (const bad of ['3/', 'abc', '145', '/145', '3/145/2', '', null, undefined]) {
    assert.equal(parseWardSerial(bad), null, String(bad));
  }
});

test('a ward/serial query puts the matching entry first as an exact jump', () => {
  const index = buildSearchIndex(ROLL);
  const res = searchVoters(index, '3/145');
  assert.equal(res[0].entry.name, 'अभिषेक यादव');
  assert.equal(res[0].jump, true);
  assert.equal(res[0].exact, true);
  assert.equal(res[0].field, 'serial');
  assert.deepEqual(res[0].ranges, [{ start: 0, end: 3 }]);
  assert.equal(res.filter((r) => r.entry === res[0].entry).length, 1);

  assert.equal(searchVoters(index, ' 3 / 145 ', { sort: 'age' })[0].entry.name, 'अभिषेक यादव');
  assert.equal(searchVoters(buildSearchIndex([{ ...ROLL[4], ward: '03', serial: '145' }]), '3/145')[0].jump, true);
  assert.ok(searchVoters(index, '9/999').every((r) => !r.jump));
});

test('voterKey normalises ward and serial', () => {
  assert.equal(voterKey({ ward: 3, serial: 145 }), '3:145');
  assert.equal(voterKey({ ward: '03', serial: ' 145 ' }), '3:145');
});

test('filters: ward, booth, gender and age', () => {
  const index = buildSearchIndex(ROLL);
  const all = (filters) => names(searchVoters(index, '', { filters, sort: 'serial' }));
  assert.deepEqual(all({ ward: 2 }), ['रमेश चंद्र', 'कमला']);
  assert.deepEqual(all({ ward: '2' }), ['रमेश चंद्र', 'कमला']);
  assert.deepEqual(all({ ward: [1, 3] }).length, 4);
  assert.deepEqual(all({ booth: 3 }), ['अभिषेक यादव', 'पूजा']);
  assert.deepEqual(all({ gender: 'f' }), ['सीता देवी', 'कमला', 'पूजा']);
  assert.deepEqual(all({ ageMin: 30, ageMax: 45 }), ['रमेश', 'सीता देवी']);
  assert.deepEqual(all({ ageMin: 60 }), ['रमेश चंद्र']);
  assert.deepEqual(all({ ageMax: 20 }), ['अभिषेक यादव']);
  assert.deepEqual(names(searchVoters(index, 'ramesh', { filters: { ward: 2 } })), ['रमेश चंद्र']);
});

test('filters: tag, visit, hasNumber and notCalled use caller lookups keyed by ward:serial', () => {
  const index = buildSearchIndex(ROLL);
  const all = (filters) => names(searchVoters(index, '', { filters, sort: 'serial' }));

  const tags = new Map([['1:7', ['supporter']], ['3:146', ['undecided']], ['2:3', []]]);
  assert.deepEqual(all({ tag: tags }), ['रमेश', 'पूजा']);
  assert.deepEqual(all({ tag: { lookup: tags, value: 'supporter' } }), ['रमेश']);

  assert.deepEqual(all({ visit: { '2:145': 'visited' } }), ['कमला']);
  assert.deepEqual(all({ visit: { lookup: { '2:145': 'visited', '1:8': 'absent' }, value: 'absent' } }), ['सीता देवी']);

  const seen = [];
  assert.deepEqual(all({ hasNumber: (key) => (seen.push(key), key === '3:145') }), ['अभिषेक यादव']);
  assert.ok(seen.includes('1:7'));

  assert.deepEqual(all({ notCalled: new Set(['1:7', '1:8', '2:3', '2:145']) }), ['अभिषेक यादव', 'पूजा']);

  // The ward/serial jump obeys the filters too.
  assert.ok(searchVoters(index, '3/145', { filters: { notCalled: new Set(['3:145']) } }).every((r) => !r.jump));
});

test('sort: relevance by default, then serial, name and age', () => {
  const index = buildSearchIndex(ROLL);
  // Exact name, exact relative, then name prefix.
  assert.deepEqual(names(searchVoters(index, 'ramesh')), ['रमेश', 'पूजा', 'रमेश चंद्र']);
  const tiers = searchVoters(index, 'ramesh').map((r) => [r.tier, r.field]);
  assert.deepEqual(tiers, [[0, 'name'], [0, 'relative'], [1, 'name']]);
  // Name before other fields at the same tier.
  const sameTier = buildSearchIndex([entry(1, 1, 'मोहन', { relative: 'रमेश' }), entry(1, 2, 'रमेश', { relative: 'मोहन' })]);
  assert.deepEqual(searchVoters(sameTier, 'ramesh').map((r) => r.field), ['name', 'relative']);
  // Substring after prefix.
  const sub = buildSearchIndex([entry(1, 1, 'सीताराम'), entry(1, 2, 'रामलाल')]);
  assert.deepEqual(names(searchVoters(sub, 'ram')), ['रामलाल', 'सीताराम']);

  assert.deepEqual(names(searchVoters(index, 'ramesh', { sort: 'serial' })), ['रमेश', 'रमेश चंद्र', 'पूजा']);
  assert.deepEqual(names(searchVoters(index, 'ramesh', { sort: 'name' })), ['पूजा', 'रमेश', 'रमेश चंद्र']);
  assert.deepEqual(names(searchVoters(index, 'ramesh', { sort: 'age' })), ['पूजा', 'रमेश', 'रमेश चंद्र']);
  assert.deepEqual(
    searchVoters(index, '', { sort: 'age' }).map((r) => r.entry.age),
    [19, 22, 25, 33, 40, 61],
  );
});

test('limit caps the results', () => {
  const index = buildSearchIndex(ROLL);
  assert.equal(searchVoters(index, '', { limit: 2 }).length, 2);
  assert.equal(searchVoters(index, '').length, ROLL.length);
});

test('module is pure: no network, DOM or storage access, only imports hindiSearch', () => {
  const src = readFileSync(MODULE_PATH, 'utf8');
  for (const banned of ['fetch(', 'XMLHttpRequest', 'WebSocket', 'document.', 'window.', 'navigator.', 'localStorage', 'sessionStorage', 'indexedDB']) {
    assert.ok(!src.includes(banned), banned);
  }
  const imports = [...src.matchAll(/^import .* from '([^']+)';$/gm)].map((m) => m[1]);
  assert.deepEqual(imports, ['./hindiSearch.js']);
});

test('10,000 entries: build once, each query is synchronous and fast', () => {
  const syllables = ['र', 'म', 'स', 'ता', 'क', 'ला', 'दे', 'वी', 'मो', 'हन', 'सु', 'रे', 'श', 'पू', 'जा'];
  const entries = [];
  for (let i = 0; i < 10000; i += 1) {
    const pick = (k) => syllables[(i * 7 + k * 13) % syllables.length];
    entries.push(
      entry(1 + (i % 20), i + 1, pick(1) + pick(2) + pick(3), {
        relative: pick(4) + pick(5),
        age: 18 + (i % 70),
        gender: i % 2 ? 'M' : 'F',
        ...(i % 3 === 0 ? { epic: `ABC${String(i).padStart(7, '0')}` } : {}),
      }),
    );
  }
  entries.push(entry(21, 1, 'रमेश'));

  const t0 = performance.now();
  const index = buildSearchIndex(entries);
  const buildMs = performance.now() - t0;
  assert.ok(buildMs < 5000, `build took ${buildMs}ms`);

  for (const q of ['r', 'ra', 'ram', 'ramesh', 'रमे', 'sita devi', '145', 'abc000', '7/145']) {
    const start = performance.now();
    const res = searchVoters(index, q, { filters: { ageMin: 20 } });
    const ms = performance.now() - start;
    assert.ok(Array.isArray(res), q);
    assert.ok(ms < 250, `${q} took ${ms}ms`);
  }
  assert.equal(searchVoters(index, 'ramesh')[0].entry.name, 'रमेश');
});
