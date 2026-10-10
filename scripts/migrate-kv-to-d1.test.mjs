// scripts/migrate-kv-to-d1.mjs (issue #184), run by `npm test`. The KV
// contents are what the KV version of functions/sync.js wrote; D1 is
// test/helpers/memoryD1.js with migrations/0001_sync.sql, and the migrated
// store is then driven through the real onRequest.

import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { exportKv, findCollisions, main, migrate, normalizeRows, parseEntries, toSql } from './migrate-kv-to-d1.mjs';
import { onRequest, signSyncToken } from '../functions/sync.js';
import { createSyncD1 } from '../test/helpers/memoryD1.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SECRET = 'test-sync-secret';
const ORIGIN = 'https://canvass.example';
const VERIFIER_A = 'A'.repeat(43);
const VERIFIER_B = 'B'.repeat(43);

// The KV layout: records under a 12-digit zero-padded seq.
const recordKey = (cand, seq) => `c/${cand}/r/${String(seq).padStart(12, '0')}`;
const stored = (seq, id, extra = {}) => ({
  id,
  updatedAt: 1760000000000 + seq,
  ciphertext: `ct${seq}`,
  iv: `iv${seq}`,
  seq,
  deviceId: 'dev1',
  claimedAt: 1760000000000,
  ...extra,
});
const kvRecord = (cand, seq, id, extra) => ({ name: recordKey(cand, seq), value: JSON.stringify(stored(seq, id, extra)) });

const KV = [
  { name: 'c/candA/verifier', value: VERIFIER_A },
  { name: 'c/candA/seq', value: '3' },
  kvRecord('candA', 1, 'contact:1'),
  kvRecord('candA', 2, 'mark:w1:7', { updatedAt: '2026-10-01T08:00:00Z' }),
  kvRecord('candA', 3, 'mark:w1:9'),
  { name: 'c/candA/m/mark:w1:7', value: '2' },
  { name: 'c/candA/m/mark:w1:9', value: '3' },
  { name: 'c/candB/verifier', value: VERIFIER_B },
  // A counter behind its highest record (the KV store had no atomic counter).
  { name: 'c/candB/seq', value: '1' },
  kvRecord('candB', 1, 'contact:x'),
  kvRecord('candB', 5, 'contact:y', { deviceId: 'dev2' }),
];

const query = (db, sql, ...params) => db.sqlite.query(sql, params);
function snapshot(db) {
  return {
    verifiers: query(db, 'SELECT * FROM verifiers ORDER BY candidate_id'),
    counters: query(db, 'SELECT * FROM counters ORDER BY candidate_id'),
    records: query(db, 'SELECT * FROM records ORDER BY candidate_id, seq'),
    marks: query(db, 'SELECT * FROM marks ORDER BY candidate_id, id'),
  };
}

async function call(db, path, { method = 'GET', token, body } = {}) {
  const headers = { Authorization: `Bearer ${token}` };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await onRequest({
    request: new Request(ORIGIN + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }),
    env: { SYNC_SECRET: SECRET, SYNC_DB: db },
  });
  assert.equal(res.status, 200, `${method} ${path}`);
  return res.json();
}

test('each KV key lands in its table with the same seq and fields', async () => {
  const db = await createSyncD1();
  const report = await migrate(KV, db);
  assert.deepEqual(report.skipped, []);
  assert.deepEqual(report.collisions, []);
  const state = snapshot(db);
  assert.deepEqual(state.verifiers, [
    { candidate_id: 'candA', verifier: VERIFIER_A },
    { candidate_id: 'candB', verifier: VERIFIER_B },
  ]);
  assert.deepEqual(state.records, [
    { candidate_id: 'candA', seq: 1, id: 'contact:1', updated_at: 1760000000001, ciphertext: 'ct1', iv: 'iv1', device_id: 'dev1' },
    { candidate_id: 'candA', seq: 2, id: 'mark:w1:7', updated_at: '2026-10-01T08:00:00Z', ciphertext: 'ct2', iv: 'iv2', device_id: 'dev1' },
    { candidate_id: 'candA', seq: 3, id: 'mark:w1:9', updated_at: 1760000000003, ciphertext: 'ct3', iv: 'iv3', device_id: 'dev1' },
    { candidate_id: 'candB', seq: 1, id: 'contact:x', updated_at: 1760000000001, ciphertext: 'ct1', iv: 'iv1', device_id: 'dev1' },
    { candidate_id: 'candB', seq: 5, id: 'contact:y', updated_at: 1760000000005, ciphertext: 'ct5', iv: 'iv5', device_id: 'dev2' },
  ]);
  assert.deepEqual(state.marks, [
    { candidate_id: 'candA', id: 'mark:w1:7' },
    { candidate_id: 'candA', id: 'mark:w1:9' },
  ]);
  assert.deepEqual(state.counters, [
    { candidate_id: 'candA', seq: 3 },
    { candidate_id: 'candB', seq: 5 },
  ]);
});

test('running the migration twice leaves D1 as one run did', async () => {
  const db = await createSyncD1();
  await migrate(KV, db);
  const once = snapshot(db);
  const second = await migrate(KV, db);
  assert.deepEqual(second.collisions, []);
  assert.deepEqual(snapshot(db), once);

  // The SQL file the operator applies with wrangler behaves the same.
  const viaSql = await createSyncD1();
  await viaSql.exec(toSql(KV));
  await viaSql.exec(toSql(KV));
  assert.deepEqual(snapshot(viaSql), once);
});

test('a verifier and a counter already in D1 are kept, and counters only move up', async () => {
  const db = await createSyncD1();
  query(db, 'INSERT INTO verifiers (candidate_id, verifier) VALUES (?, ?)', 'candA', 'C'.repeat(43));
  query(db, 'INSERT INTO counters (candidate_id, seq) VALUES (?, ?)', 'candB', 9);
  await migrate(KV, db);
  await migrate(KV, db);
  assert.equal(query(db, "SELECT verifier FROM verifiers WHERE candidate_id = 'candA'")[0].verifier, 'C'.repeat(43));
  assert.equal(query(db, "SELECT seq FROM counters WHERE candidate_id = 'candB'")[0].seq, 9);
  assert.equal(query(db, "SELECT seq FROM counters WHERE candidate_id = 'candA'")[0].seq, 3);
});

test('after migration a pull returns the KV records and a push gets a fresh slot', async () => {
  const db = await createSyncD1();
  await migrate(KV, db);
  const token = await signSyncToken(SECRET, 'candB', 'dev9');
  const before = await call(db, '/sync/pull?since=0', { token });
  assert.deepEqual(before.records.map((r) => r.id), ['contact:x', 'contact:y']);
  assert.equal(before.cursor, 5);
  const pushed = await call(db, '/sync/push', {
    method: 'POST',
    token,
    body: { records: [{ id: 'contact:z', updatedAt: 1, ciphertext: 'ctz', iv: 'ivz' }] },
  });
  assert.equal(pushed.cursor, 6);
  assert.equal(query(db, "SELECT COUNT(*) AS n FROM records WHERE candidate_id = 'candB'")[0].n, 3);

  // A migrated mark is acknowledged without being stored again.
  const tokenA = await signSyncToken(SECRET, 'candA', 'dev9');
  const again = await call(db, '/sync/push', {
    method: 'POST',
    token: tokenA,
    body: { records: [{ id: 'mark:w1:7', updatedAt: 2, ciphertext: 'ctm', iv: 'ivm' }] },
  });
  assert.equal(again.cursor, 3);
});

test('a slot D1 already holds with another record is reported, not overwritten', async () => {
  const db = await createSyncD1();
  query(
    db,
    'INSERT INTO records (candidate_id, seq, id, updated_at, ciphertext, iv, device_id) VALUES (?, ?, ?, ?, ?, ?, ?)',
    'candB', 1, 'contact:new', 1, 'ctnew', 'ivnew', 'devD1',
  );
  const report = await migrate(KV, db);
  assert.deepEqual(report.collisions, [{ candidateId: 'candB', seq: 1, id: 'contact:x', d1Id: 'contact:new' }]);
  assert.equal(query(db, "SELECT id FROM records WHERE candidate_id = 'candB' AND seq = 1")[0].id, 'contact:new');
  assert.deepEqual(
    findCollisions(parseEntries(KV).records, normalizeRows([{ results: snapshot(db).records }])),
    [{ candidateId: 'candB', seq: 1, id: 'contact:x', d1Id: 'contact:new' }],
  );
});

test('keys and values the KV store could not have written are skipped with a reason', () => {
  const { skipped, records, verifiers, counters } = parseEntries([
    { name: 'other/key', value: 'x' },
    { name: 'c/bad.id/verifier', value: VERIFIER_A },
    { name: 'c/candA/seq', value: 'three' },
    { name: recordKey('candA', 4), value: 'not json' },
    { name: recordKey('candA', 5), value: JSON.stringify(stored(6, 'contact:5')) },
    { name: recordKey('candA', 7), value: JSON.stringify({ id: 'x', updatedAt: 1, ciphertext: 'c', iv: 'i' }) },
  ]);
  assert.equal(skipped.length, 6);
  assert.deepEqual([records, verifiers, counters], [[], [], []]);
});

test('toSql quotes strings, so a quote in a value cannot break the statement', async () => {
  const db = await createSyncD1();
  await db.exec(toSql([{ name: 'c/candA/m/mark:it\'s', value: '1' }]));
  assert.deepEqual(snapshot(db).marks, [{ candidate_id: 'candA', id: "mark:it's" }]);
});

test('export lists the c/ keys and reads each value through wrangler', () => {
  const calls = [];
  const run = (args) => {
    calls.push(args.join(' '));
    if (args[1] === 'key' && args[2] === 'list') return JSON.stringify([{ name: 'c/candA/seq' }, { name: 'c/candA/verifier' }]);
    return args[3] === 'c/candA/seq' ? '3' : VERIFIER_A;
  };
  assert.deepEqual(exportKv('ns1', run), [
    { name: 'c/candA/seq', value: '3' },
    { name: 'c/candA/verifier', value: VERIFIER_A },
  ]);
  assert.equal(calls[0], 'kv key list --namespace-id=ns1 --prefix=c/ --remote');
  assert.equal(calls[1], 'kv key get c/candA/seq --namespace-id=ns1 --remote');
});

test('the CLI refuses bad arguments', () => {
  let err = '';
  const code = main(['sql'], { out: { write() {} }, err: { write: (text) => { err += text; } } });
  assert.equal(code, 2);
  assert.match(err, /usage: migrate-kv-to-d1\.mjs/);
});

test('no file under functions/ or src/ references SYNC_KV', () => {
  const files = (dir) => readdirSync(join(ROOT, dir), { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? files(`${dir}/${entry.name}`) : [`${dir}/${entry.name}`]);
  const offenders = [...files('functions'), ...files('src')]
    .filter((file) => readFileSync(join(ROOT, file), 'utf8').includes('SYNC_KV'));
  assert.deepEqual(offenders, []);
});
