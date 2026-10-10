// D1 sync schema (issue #179, part of #178): migrations/0001_sync.sql creates
// records, counters, marks and verifiers with the keys the sync store relies
// on, and test/helpers/memoryD1.js serves the D1 prepare/bind/first/all/run/
// batch API over it from an in-memory SQLite database. Run by `npm test`.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryD1 } from './helpers/memoryD1.js';

const MIGRATION = 'migrations/0001_sync.sql';

const open = () => createMemoryD1({ migrations: [MIGRATION] });

const INSERT_RECORD =
  'INSERT INTO records (candidate_id, seq, id, updated_at, ciphertext, iv, device_id) VALUES (?, ?, ?, ?, ?, ?, ?)';

function record(overrides = {}) {
  return {
    candidate_id: 'cand-1',
    seq: 1,
    id: 'contact:w1:42',
    updated_at: 1760000000000,
    ciphertext: 'q83vEjRWeJA',
    iv: 'AAECAwQFBgcICQoL',
    device_id: 'dev_A',
    ...overrides,
  };
}

const insertRecord = (db, r) =>
  db.prepare(INSERT_RECORD).bind(r.candidate_id, r.seq, r.id, r.updated_at, r.ciphertext, r.iv, r.device_id);

async function columns(db, table) {
  const { results } = await db.prepare(`SELECT name, pk FROM pragma_table_info('${table}') ORDER BY cid`).all();
  return {
    names: results.map((c) => c.name),
    pk: results.filter((c) => c.pk > 0).sort((a, b) => a.pk - b.pk).map((c) => c.name),
  };
}

test('the migration creates records, counters, marks and verifiers with the specified keys', async () => {
  const db = await open();
  const { results } = await db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all();
  assert.deepEqual(results.map((t) => t.name), ['counters', 'marks', 'records', 'verifiers']);

  assert.deepEqual(await columns(db, 'records'), {
    names: ['candidate_id', 'seq', 'id', 'updated_at', 'ciphertext', 'iv', 'device_id'],
    pk: ['candidate_id', 'seq'],
  });
  assert.deepEqual(await columns(db, 'counters'), { names: ['candidate_id', 'seq'], pk: ['candidate_id'] });
  assert.deepEqual(await columns(db, 'marks'), { names: ['candidate_id', 'id'], pk: ['candidate_id', 'id'] });
  assert.deepEqual(await columns(db, 'verifiers'), { names: ['candidate_id', 'verifier'], pk: ['candidate_id'] });
});

test('the migration can be applied twice', async () => {
  await assert.doesNotReject(createMemoryD1({ migrations: [MIGRATION, MIGRATION] }));
});

test('an inserted records row comes back unchanged, whether updated_at is a number or a string', async () => {
  const db = await open();
  const numeric = record();
  const textual = record({ seq: 2, id: 'contact:w1:43', updated_at: '2026-10-10T05:00:00.000Z' });
  const run = await insertRecord(db, numeric).run();
  assert.equal(run.success, true);
  assert.equal(run.meta.changes, 1);
  await insertRecord(db, textual).run();

  const select = db.prepare('SELECT * FROM records WHERE candidate_id = ? AND seq = ?');
  assert.deepEqual(await select.bind('cand-1', 1).first(), numeric);
  assert.deepEqual(await select.bind('cand-1', 2).first(), textual);
  assert.equal(await select.bind('cand-1', 2).first('updated_at'), '2026-10-10T05:00:00.000Z');

  const all = await db.prepare('SELECT * FROM records ORDER BY seq').all();
  assert.equal(all.success, true);
  assert.deepEqual(all.results, [numeric, textual]);
});

test('first() resolves to null and all() to empty results when nothing matches', async () => {
  const db = await open();
  const select = db.prepare('SELECT * FROM records WHERE candidate_id = ?').bind('nobody');
  assert.equal(await select.first(), null);
  assert.deepEqual((await select.all()).results, []);
});

test('bind rejects undefined like D1', async () => {
  const db = await open();
  assert.throws(() => db.prepare('SELECT ?').bind(undefined), /D1_TYPE_ERROR/);
});

test('a second records row with an existing (candidate_id, seq) is rejected and the first is kept', async () => {
  const db = await open();
  const original = record();
  await insertRecord(db, original).run();
  await assert.rejects(insertRecord(db, record({ id: 'contact:w1:99', device_id: 'dev_B' })).run(), /UNIQUE constraint failed/);
  // The same seq under another candidate is a different key.
  await insertRecord(db, record({ candidate_id: 'cand-2' })).run();

  const { results } = await db.prepare('SELECT * FROM records WHERE candidate_id = ?').bind('cand-1').all();
  assert.deepEqual(results, [original]);
});

test('counters, marks and verifiers reject duplicate keys', async () => {
  const db = await open();
  const cases = [
    ['INSERT INTO counters (candidate_id, seq) VALUES (?, ?)', ['cand-1', 1], ['cand-1', 2]],
    ['INSERT INTO marks (candidate_id, id) VALUES (?, ?)', ['cand-1', 'mark:w1:7'], ['cand-1', 'mark:w1:7']],
    ['INSERT INTO verifiers (candidate_id, verifier) VALUES (?, ?)', ['cand-1', 'v1'], ['cand-1', 'v2']],
  ];
  for (const [sql, first, second] of cases) {
    await db.prepare(sql).bind(...first).run();
    await assert.rejects(db.prepare(sql).bind(...second).run(), /UNIQUE constraint failed/, sql);
  }
  // A mark id is unique per candidate, not globally.
  await db.prepare('INSERT INTO marks (candidate_id, id) VALUES (?, ?)').bind('cand-2', 'mark:w1:7').run();
});

test('batch returns one D1 result per statement and commits them together', async () => {
  const db = await open();
  const results = await db.batch([
    db.prepare('INSERT INTO counters (candidate_id, seq) VALUES (?, ?)').bind('cand-1', 1),
    insertRecord(db, record()),
    db.prepare('SELECT seq FROM counters WHERE candidate_id = ?').bind('cand-1'),
  ]);
  assert.equal(results.length, 3);
  assert.equal(results[0].meta.changes, 1);
  assert.equal(results[1].meta.changes, 1);
  assert.deepEqual(results[2].results, [{ seq: 1 }]);
  assert.equal(results[2].meta.changes, 0);
  assert.deepEqual(await db.prepare('SELECT * FROM records').first(), record());
});

test('batch is atomic: when one statement fails, none of its writes persist', async () => {
  const db = await open();
  await insertRecord(db, record()).run();
  await assert.rejects(
    db.batch([
      db.prepare('INSERT INTO counters (candidate_id, seq) VALUES (?, ?)').bind('cand-1', 2),
      insertRecord(db, record({ seq: 2, id: 'contact:w1:50' })),
      insertRecord(db, record({ id: 'contact:w1:51' })), // seq 1 is taken
    ]),
    /UNIQUE constraint failed/,
  );
  assert.equal(await db.prepare('SELECT * FROM counters').first(), null);
  const { results } = await db.prepare('SELECT seq FROM records').all();
  assert.deepEqual(results, [{ seq: 1 }]);

  // The database is usable again after the rollback.
  await db.batch([db.prepare('INSERT INTO counters (candidate_id, seq) VALUES (?, ?)').bind('cand-1', 2)]);
  assert.equal(await db.prepare('SELECT seq FROM counters').first('seq'), 2);
});
