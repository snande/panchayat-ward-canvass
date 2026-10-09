// Encrypted call-assignment store (issue #51), run by `npm test`.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';

import * as assignmentModule from '../src/calls/assignmentStore.js';
import { createAssignmentStore } from '../src/calls/assignmentStore.js';
import { createContactStore } from '../src/contacts/contactStore.js';
import { createRollStore } from '../src/roll/rollStore.js';
import { DB_NAME, KEYS_STORE, ASSIGNMENTS_STORE } from '../src/storage/deviceDb.js';
import { DEVICE_KEY_ID } from '../src/crypto/deviceKey.js';
import { createFakeIndexedDB } from './helpers/fakeIndexedDB.js';

const WARD = '17/125/6313/1';
const ANIL = { workerId: 'worker-anil', workerName: 'अनिल कुमार' };
const SUNITA = { workerId: 'worker-sunita', workerName: 'सुनीता देवी' };

function newStore(idb = createFakeIndexedDB()) {
  return { idb, store: createAssignmentStore({ indexedDB: idb, crypto: webcrypto }) };
}

const assignments = (idb) => idb.databases.get(DB_NAME)?.stores.get(ASSIGNMENTS_STORE);
const bytesOf = (value) => Buffer.from(
  value instanceof ArrayBuffer ? new Uint8Array(value) : new Uint8Array(value.buffer, value.byteOffset, value.byteLength),
);

async function decryptRecord(idb, id) {
  const key = idb.databases.get(DB_NAME).stores.get(KEYS_STORE).get(DEVICE_KEY_ID);
  const record = assignments(idb).get(id);
  const plain = await webcrypto.subtle.decrypt(
    { name: 'AES-GCM', iv: record.iv, additionalData: new TextEncoder().encode(id) }, key, record.ct,
  );
  return JSON.parse(new TextDecoder().decode(plain));
}

test('the module exports the three async operations', () => {
  for (const name of ['assignVoter', 'unassignVoter', 'loadAssignments']) {
    assert.equal(typeof assignmentModule[name], 'function', name);
  }
});

test('the default exports work against the browser globals and return promises', async () => {
  const saved = globalThis.indexedDB;
  globalThis.indexedDB = createFakeIndexedDB();
  try {
    const assigned = assignmentModule.assignVoter(4, ANIL);
    assert.ok(assigned instanceof Promise);
    assert.deepEqual(await assigned, { serial: 4, ...ANIL });
    assert.deepEqual(await assignmentModule.loadAssignments(), { 4: ANIL });
    await assignmentModule.unassignVoter(4);
    assert.deepEqual(await assignmentModule.loadAssignments(), {});
  } finally {
    globalThis.indexedDB = saved;
  }
});

test('an assignment is returned by a fresh store on the same IndexedDB (app restart)', async () => {
  const { idb, store } = newStore();
  await store.assignVoter(12, ANIL);
  await store.assignVoter(13, SUNITA);
  const reopened = createAssignmentStore({ indexedDB: idb, crypto: webcrypto });
  assert.deepEqual(await reopened.loadAssignments(), { 12: ANIL, 13: SUNITA });
});

test('assigning a second worker replaces the first: one assignee and one record per voter', async () => {
  const { idb, store } = newStore();
  await store.assignVoter(7, ANIL);
  await store.assignVoter(8, ANIL);
  await store.assignVoter('7', SUNITA);
  assert.deepEqual(await store.loadAssignments(), { 7: SUNITA, 8: ANIL });
  assert.equal(assignments(idb).size, 2);
  const reopened = createAssignmentStore({ indexedDB: idb, crypto: webcrypto });
  assert.deepEqual(await reopened.loadAssignments(), { 7: SUNITA, 8: ANIL });
});

test('concurrent assignments of one voter still leave a single assignee', async () => {
  const { idb, store } = newStore();
  await Promise.all([store.assignVoter(5, ANIL), store.assignVoter(5, SUNITA), store.assignVoter(5, ANIL)]);
  assert.equal(assignments(idb).size, 1);
  assert.deepEqual(await store.loadAssignments(), { 5: ANIL });
});

test('unassignVoter removes only that voter; unassigning an unassigned voter is a no-op', async () => {
  const { idb, store } = newStore();
  await store.assignVoter(1, ANIL);
  await store.assignVoter(2, SUNITA);
  await store.unassignVoter(1);
  assert.deepEqual(await store.loadAssignments(), { 2: SUNITA });
  assert.equal(assignments(idb).size, 1);
  await store.unassignVoter(99);
  assert.deepEqual(await store.loadAssignments(), { 2: SUNITA });
});

test('each record is {v, iv, ct} under an opaque id, and decrypts to serial, workerId and workerName only', async () => {
  const { idb, store } = newStore();
  await store.assignVoter(42, ANIL);
  let [[id, record]] = [...assignments(idb).entries()];
  // The id is random, not derived from the voter: re-assigning gets a new one.
  assert.match(id, /^[0-9a-f]{32}$/);
  await store.assignVoter(42, ANIL);
  assert.notEqual([...assignments(idb).keys()][0], id);
  await store.unassignVoter(42);
  await store.assignVoter(42, ANIL);
  [[id, record]] = [...assignments(idb).entries()];
  assert.deepEqual(Object.keys(record).sort(), ['ct', 'iv', 'v']);
  assert.equal(record.iv.byteLength, 12);
  assert.deepEqual(await decryptRecord(idb, id), { serial: 42, ...ANIL });
  // AES-GCM: 16-byte tag on top of the JSON plaintext.
  assert.equal(bytesOf(record.ct).byteLength,
    Buffer.from(JSON.stringify({ serial: 42, ...ANIL })).byteLength + 16);
  // The record is bound to its id: moved elsewhere it does not decrypt.
  assignments(idb).delete(id);
  assignments(idb).set('0'.repeat(32), record);
  await assert.rejects(store.loadAssignments());
});

test('serialising every stored record finds neither worker names, worker ids nor serials', async () => {
  const { idb, store } = newStore();
  await store.assignVoter(731, ANIL);
  await store.assignVoter(8642, SUNITA);
  let dump = '';
  // The record ids are random hex, checked separately; only the values are scanned.
  for (const value of assignments(idb).values()) {
    dump += JSON.stringify(value, (k, v) => (ArrayBuffer.isView(v) || v instanceof ArrayBuffer
      ? bytesOf(v).toString('latin1') : v));
    dump += bytesOf(value.ct).toString('utf8') + bytesOf(value.iv).toString('utf8');
  }
  assert.equal(assignments(idb).size, 2);
  for (const secret of ['731', '8642', ANIL.workerName, SUNITA.workerName, ANIL.workerId, SUNITA.workerId,
    'अनिल', 'serial', 'workerName', 'workerId']) {
    assert.ok(!dump.includes(secret), secret);
  }
});

test('only serial, workerId and workerName are stored, never a phone or other field', async () => {
  const { idb, store } = newStore();
  await store.assignVoter(3, { ...ANIL, phone: '9876543210', name: 'किशनादेवी' });
  const [id] = assignments(idb).keys();
  const plain = await decryptRecord(idb, id);
  assert.deepEqual(Object.keys(plain).sort(), ['serial', 'workerId', 'workerName']);
  assert.deepEqual(await store.loadAssignments(), { 3: ANIL });
});

test('invalid serials and assignees reject and write nothing', async () => {
  const { idb, store } = newStore();
  for (const bad of ['', -1, 1.5, NaN, null, 'x', '1:2']) {
    await assert.rejects(store.assignVoter(bad, ANIL), TypeError, String(bad));
    await assert.rejects(store.unassignVoter(bad), TypeError, String(bad));
  }
  for (const bad of [undefined, null, {}, { workerId: '', workerName: 'x' }, { workerId: 'w' }, { workerId: 5, workerName: 'x' }]) {
    await assert.rejects(store.assignVoter(1, bad), TypeError, JSON.stringify(bad));
  }
  assert.equal(assignments(idb)?.size ?? 0, 0);
});

test('every operation succeeds with fetch undefined (works offline)', async () => {
  const savedFetch = globalThis.fetch;
  delete globalThis.fetch;
  try {
    assert.equal(typeof globalThis.fetch, 'undefined');
    const { store } = newStore();
    await store.assignVoter(1, ANIL);
    assert.deepEqual(await store.loadAssignments(), { 1: ANIL });
    await store.unassignVoter(1);
    assert.deepEqual(await store.loadAssignments(), {});
  } finally {
    globalThis.fetch = savedFetch;
  }
});

test('no module in src/calls/ calls fetch or stores a phone number', () => {
  const dir = new URL('../src/calls/', import.meta.url);
  const files = readdirSync(dir).filter((f) => f.endsWith('.js'));
  assert.ok(files.includes('assignmentStore.js') && files.includes('callList.js'));
  for (const file of files) {
    const code = readFileSync(new URL(file, dir), 'utf8').replace(/\/\/.*$/gm, '');
    assert.ok(!/\bfetch\b/.test(code), file);
    assert.ok(!/XMLHttpRequest|WebSocket|sendBeacon/.test(code), file);
  }
  const store = readFileSync(new URL('assignmentStore.js', dir), 'utf8').replace(/\/\/.*$/gm, '');
  assert.ok(!/phone/i.test(store));
});

test('the assignment, contact and roll stores share one device key', async () => {
  const idb = createFakeIndexedDB();
  const { store } = newStore(idb);
  await store.assignVoter(1, ANIL);
  await createContactStore({ indexedDB: idb, crypto: webcrypto, storage: null }).recordConsent(WARD, 1);
  const rolls = createRollStore({ indexedDB: idb, crypto: webcrypto });
  await rolls.encryptAndStore(WARD, [{ serial: 1, name: 'x' }]);
  assert.equal(idb.databases.get(DB_NAME).stores.get(KEYS_STORE).size, 1);
  assert.deepEqual(await rolls.loadStored(WARD), [{ serial: 1, name: 'x', relative: '', age: null, gender: '', house: '', struck: false }]);
  assert.deepEqual(await store.loadAssignments(), { 1: ANIL });
});

test('upgrading a v2 database keeps its contacts and adds the assignments store', async () => {
  const idb = createFakeIndexedDB();
  await new Promise((resolve, reject) => {
    const req = idb.open(DB_NAME, 2);
    req.onupgradeneeded = () => {
      for (const name of ['keys', 'rolls', 'meta', 'contacts']) req.result.createObjectStore(name);
    };
    req.onsuccess = resolve;
    req.onerror = () => reject(req.error);
  });
  const contactsStore = createContactStore({ indexedDB: idb, crypto: webcrypto, storage: null });
  // The contact store opens at the current version, which upgrades the v2 database.
  await contactsStore.recordConsent(WARD, 1);
  await contactsStore.saveNumber(WARD, 1, '9876543210');
  const { store } = newStore(idb);
  await store.assignVoter(1, ANIL);
  assert.equal((await contactsStore.getContact(WARD, 1)).phone, '9876543210');
  assert.deepEqual(await store.loadAssignments(), { 1: ANIL });
});

test('missing IndexedDB or WebCrypto rejects instead of throwing synchronously', async () => {
  await assert.rejects(createAssignmentStore({ indexedDB: null, crypto: webcrypto }).loadAssignments());
  const noCrypto = createAssignmentStore({ indexedDB: createFakeIndexedDB(), crypto: null });
  await assert.rejects(noCrypto.assignVoter(1, ANIL));
});

test('the service worker precaches src/calls and every module it imports (offline)', () => {
  const read = (rel) => readFileSync(new URL('../' + rel, import.meta.url), 'utf8');
  const sw = read('sw.js');
  const pending = ['src/calls/assignmentStore.js', 'src/calls/callList.js'];
  const seen = new Set();
  while (pending.length) {
    const rel = pending.pop();
    if (seen.has(rel)) continue;
    seen.add(rel);
    assert.ok(sw.includes(`"${rel}"`), rel);
    for (const [, spec] of read(rel).matchAll(/from '(\.[^']+)'/g)) {
      pending.push(new URL(spec, 'file:///' + rel).pathname.slice(1));
    }
  }
});
