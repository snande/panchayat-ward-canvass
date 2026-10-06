import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';

import { buildIndex, search, normalize } from '../src/search/hindiSearch.js';

const MODULE_PATH = fileURLToPath(new URL('../src/search/hindiSearch.js', import.meta.url));

let nextId = 0;
function voter(serial, name) {
  nextId += 1;
  return { id: `v${nextId}`, serial, name, relativeName: 'मोहन', houseNo: String(serial) };
}

const names = (results) => results.map((v) => v.name);

test('exports buildIndex and search; search returns the original voter objects', () => {
  assert.equal(typeof buildIndex, 'function');
  assert.equal(typeof search, 'function');
  const v = { id: 'a', serial: 12, name: 'रामलाल', relativeName: 'मोहन', houseNo: '4' };
  const idx = buildIndex([v]);
  const res = search(idx, 'राम');
  assert.ok(Array.isArray(res));
  assert.equal(res.length, 1);
  assert.equal(res[0], v);
  assert.deepEqual(res[0], { id: 'a', serial: 12, name: 'रामलाल', relativeName: 'मोहन', houseNo: '4' });
});

test('substring matching returns every voter containing the query and no others', () => {
  const voters = [
    voter(1, 'राम'),
    voter(2, 'रामलाल'),
    voter(3, 'सीताराम'),
    voter(4, 'श्रीराम मीणा'),
    voter(5, 'मोहन लाल'),
    voter(6, 'सीता देवी'),
    voter(7, 'रमेश'),
    voter(8, 'कमला'),
  ];
  const res = search(buildIndex(voters), 'राम');
  assert.deepEqual(new Set(names(res)), new Set(['राम', 'रामलाल', 'सीताराम', 'श्रीराम मीणा']));
  for (const v of res) assert.ok(normalize(v.name).includes('राम'));
});

test('exact full-name match ranks first among 20+ substring matches', () => {
  const voters = [];
  const others = ['रामलाल', 'सीताराम', 'श्रीराम मीणा', 'राम प्रसाद', 'रामेश्वर'];
  for (let i = 0; i < 25; i += 1) voters.push(voter(i + 1, others[i % others.length]));
  const exact = voter(999, 'राम प्रसाद शर्मा');
  voters.push(exact);
  voters.push(voter(1000, 'राम प्रसाद शर्मा जी'));
  const res = search(buildIndex(voters), 'राम प्रसाद शर्मा');
  assert.equal(res[0], exact);

  const simple = [];
  for (let i = 0; i < 25; i += 1) simple.push(voter(i + 1, others[i % others.length]));
  const exactRam = voter(500, 'राम');
  simple.push(exactRam);
  const res2 = search(buildIndex(simple), 'राम');
  assert.equal(res2.length, 26);
  assert.equal(res2[0], exactRam);
});

test('ranking: exact, name prefix, word prefix, other substring; ties by ascending serial', () => {
  const voters = [
    voter(9, 'सीताराम'), // substring
    voter(3, 'श्रीराम मीणा'), // substring
    voter(8, 'मोहन रामलाल'), // word prefix
    voter(2, 'कमला रामदेव'), // word prefix
    voter(7, 'रामलाल'), // name prefix
    voter(1, 'राम प्रसाद'), // name prefix
    voter(5, 'राम'), // exact
    voter(4, 'मोहन'), // no match
  ];
  const res = search(buildIndex(voters), 'राम');
  assert.deepEqual(res.map((v) => v.serial), [5, 1, 7, 2, 8, 3, 9]);
});

test('normalisation applies identically to names and queries', () => {
  // chandrabindu U+0901 -> anusvara U+0902
  assert.equal(names(search(buildIndex([voter(1, 'रांम')]), 'राँम'))[0], 'रांम');
  assert.equal(names(search(buildIndex([voter(1, 'राँम')]), 'रांम'))[0], 'राँम');

  // nukta: decomposed (ज + U+093C) and precomposed (U+095B) both match plain
  const plain = buildIndex([voter(1, 'जाकिर')]);
  assert.equal(search(plain, 'ज़ाकिर').length, 1);
  assert.equal(search(plain, 'ज़ाकिर').length, 1);
  assert.equal(search(buildIndex([voter(1, 'ज़ाकिर')]), 'जाकिर').length, 1);

  // ZWJ / ZWNJ removed
  assert.equal(search(buildIndex([voter(1, 'श्‍रीराम')]), 'श्रीराम').length, 1);
  assert.equal(search(buildIndex([voter(1, 'श्रीराम')]), 'श्‌रीराम').length, 1);

  // whitespace trimmed and collapsed
  assert.equal(search(buildIndex([voter(1, '  श्रीराम    मीणा ')]), ' श्रीराम  मीणा  ').length, 1);
  assert.equal(normalize('  श्रीराम \t  मीणा \n'), 'श्रीराम मीणा');

  // NFC: decomposed input equals composed
  assert.equal(normalize('क़'), normalize('क़'));
  assert.equal(normalize('क'), 'क'.normalize('NFC'));
});

test('empty or whitespace-only query returns an empty array', () => {
  const idx = buildIndex([voter(1, 'राम'), voter(2, 'रामलाल')]);
  assert.deepEqual(search(idx, ''), []);
  assert.deepEqual(search(idx, '   '), []);
  assert.deepEqual(search(idx, '\t\n '), []);
  assert.deepEqual(search(idx, '‍'), []);
});

test('options.limit caps results; default is 50', () => {
  const voters = [];
  for (let i = 1; i <= 120; i += 1) voters.push(voter(i, `रामलाल ${i}`));
  const idx = buildIndex(voters);
  assert.equal(search(idx, 'राम').length, 50);
  assert.equal(search(idx, 'राम', {}).length, 50);
  assert.equal(search(idx, 'राम', { limit: 10 }).length, 10);
  assert.deepEqual(search(idx, 'राम', { limit: 3 }).map((v) => v.serial), [1, 2, 3]);
  assert.equal(search(idx, 'राम', { limit: 200 }).length, 120);
});

test('search over 2000 voters for a 2-character query: median of 20 runs under 100 ms', () => {
  const syllables = ['रा', 'म', 'सी', 'ता', 'मो', 'हन', 'ला', 'ल', 'श्री', 'मी', 'णा', 'दे', 'वी', 'कम', 'प्र', 'सा', 'द'];
  const voters = [];
  for (let i = 0; i < 2000; i += 1) {
    const w1 = syllables[i % syllables.length] + syllables[(i * 7) % syllables.length] + syllables[(i * 3) % syllables.length];
    const w2 = syllables[(i * 5) % syllables.length] + syllables[(i * 11) % syllables.length];
    voters.push(voter(i + 1, `${w1} ${w2}`));
  }
  const idx = buildIndex(voters);
  const query = 'रा';
  assert.equal([...query].length, 2);
  assert.ok(search(idx, query).length > 0);

  const times = [];
  for (let r = 0; r < 20; r += 1) {
    const t0 = performance.now();
    search(idx, query);
    times.push(performance.now() - t0);
  }
  times.sort((a, b) => a - b);
  const median = (times[9] + times[10]) / 2;
  assert.ok(median < 100, `median ${median.toFixed(2)} ms`);
});

test('module source has no network or storage references', () => {
  const src = readFileSync(MODULE_PATH, 'utf8');
  for (const token of ['fetch', 'XMLHttpRequest', 'localStorage', 'indexedDB']) {
    assert.ok(!src.includes(token), `module must not reference ${token}`);
  }
  assert.ok(!/\bimport\b/.test(src), 'module must be dependency-free');
});
