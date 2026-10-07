// Worker roster for the call list (issue #70), run by `npm test`.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';

import * as rosterModule from '../src/calls/workerRoster.js';
import { createWorkerRoster, ROSTER_ID } from '../src/calls/workerRoster.js';
import { DB_NAME, META_STORE } from '../src/storage/deviceDb.js';
import { createFakeIndexedDB } from './helpers/fakeIndexedDB.js';

const newRoster = (idb = createFakeIndexedDB()) => createWorkerRoster({ indexedDB: idb, crypto: webcrypto });

test('an empty roster lists no workers', async () => {
  assert.deepEqual(await newRoster().listWorkers(), []);
});

test('added workers are listed in order and survive an app restart', async () => {
  const idb = createFakeIndexedDB();
  const roster = newRoster(idb);
  const ramesh = await roster.addWorker('  रमेश ');
  const sita = await roster.addWorker('सीता');
  assert.equal(ramesh.workerName, 'रमेश');
  assert.match(ramesh.workerId, /^worker-[0-9a-f]{16}$/);
  assert.notEqual(ramesh.workerId, sita.workerId);
  assert.deepEqual(await roster.listWorkers(), [ramesh, sita]);
  assert.deepEqual(await newRoster(idb).listWorkers(), [ramesh, sita]);
});

test('adding a name already on the roster returns that worker', async () => {
  const roster = newRoster();
  const [a, b] = await Promise.all([roster.addWorker('रमेश'), roster.addWorker('रमेश ')]);
  assert.deepEqual(a, b);
  assert.equal((await roster.listWorkers()).length, 1);
});

test('an empty name is rejected and nothing is stored', async () => {
  const roster = newRoster();
  await assert.rejects(roster.addWorker('   '), TypeError);
  await assert.rejects(roster.addWorker(null), TypeError);
  assert.deepEqual(await roster.listWorkers(), []);
});

test('the roster is stored encrypted: no worker name in clear', async () => {
  const idb = createFakeIndexedDB();
  await newRoster(idb).addWorker('रमेश');
  const record = idb.databases.get(DB_NAME).stores.get(META_STORE).get(ROSTER_ID);
  assert.deepEqual(Object.keys(record).sort(), ['ct', 'iv', 'v']);
  assert.ok(!JSON.stringify(record).includes('रमेश'));
});

test('the default exports work against the browser globals', async () => {
  const saved = globalThis.indexedDB;
  globalThis.indexedDB = createFakeIndexedDB();
  try {
    const worker = await rosterModule.addWorker('सीता');
    assert.deepEqual(await rosterModule.listWorkers(), [worker]);
  } finally {
    globalThis.indexedDB = saved;
  }
});
