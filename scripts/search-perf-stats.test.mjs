import assert from 'node:assert/strict';
import { test } from 'node:test';

import { parseWardSerial } from '../src/search/voterSearch.js';
import { QUERY_KINDS, WARDS, makeQueries, makeRoll, ms, percentile, renderReport } from './search-perf-stats.mjs';

const oneTo100 = Array.from({ length: 100 }, (_, i) => i + 1);

test('percentile is the nearest-rank value', () => {
  assert.equal(percentile(oneTo100, 95), 95);
  assert.equal(percentile(oneTo100, 50), 50);
  assert.equal(percentile(oneTo100, 100), 100);
  assert.equal(percentile(oneTo100, 0), 1);
  assert.equal(percentile([7], 95), 7);
  assert.equal(percentile([3, 1, 2], 50), 2);
  assert.ok(Number.isNaN(percentile([], 95)));
});

test('percentile does not reorder its input', () => {
  const samples = [5, 1, 4, 2, 3];
  percentile(samples, 95);
  assert.deepEqual(samples, [5, 1, 4, 2, 3]);
});

test('ms formats a duration to two decimals', () => {
  assert.equal(ms(12.345), '12.35 ms');
  assert.equal(ms(200), '200.00 ms');
});

test('the roll is 10,000 deterministic voters over several wards with Devanagari text', () => {
  const roll = makeRoll(136, 10000);
  assert.equal(roll.length, 10000);
  assert.deepEqual(makeRoll(136, 10000), roll);
  assert.notDeepEqual(makeRoll(137, 10000), roll);
  assert.equal(new Set(roll.map((e) => e.ward)).size, WARDS);
  assert.equal(new Set(roll.map((e) => `${e.ward}:${e.serial}`)).size, roll.length);
  const deva = /[ऀ-ॿ]/;
  assert.ok(roll.every((e) => deva.test(e.name) && deva.test(e.relative)));
  assert.ok(roll.some((e) => deva.test(e.house)) && roll.some((e) => /^\d+$/.test(e.house)));
});

test('the query mix is fixed, covers every kind and leaves 200 timed queries after warm-up', () => {
  const roll = makeRoll(136, 10000);
  const queries = makeQueries(roll, 136);
  assert.deepEqual(makeQueries(roll, 136), queries);
  assert.ok(queries.length - 10 >= 200);
  assert.deepEqual(queries.slice(0, QUERY_KINDS.length).map((q) => q.kind), QUERY_KINDS);
  for (const kind of QUERY_KINDS) assert.ok(queries.filter((q) => q.kind === kind).length >= 30, kind);
  assert.ok(queries.filter((q) => q.kind === 'ward/serial').every((q) => parseWardSerial(q.q)));
  assert.ok(queries.some((q) => q.kind === 'devanagari' && /[ऀ-ॿ]/.test(q.q)));
  assert.ok(queries.some((q) => q.kind === 'latin' && /^[a-z ]+$/.test(q.q)));
});

test('the report states roll size, throttling, query count and p95 in ms', () => {
  const md = renderReport({
    browser: 'HeadlessChrome/130', rollSize: 10000, wards: 6, seed: 136, throttle: 4, warmup: 10,
    queries: 206, p50: 1.5, p95: 12.25, max: 40, buildMs: 900, empty: 1, threshold: 200, pass: true,
    byKind: { latin: { count: 34, p95: 10 } },
  });
  assert.match(md, /\| roll size \| 10000 voters \|/);
  assert.match(md, /\| CPU throttling rate \| 4x \|/);
  assert.match(md, /\| timed queries \| 206 /);
  assert.match(md, /\| p95 \| 12\.25 ms \|/);
  assert.match(md, /Pass: p95 12\.25 ms/);
});
