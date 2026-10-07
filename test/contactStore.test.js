// Encrypted, consent-gated contact store (issue #41), run by `npm test`.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';

import * as contactModule from '../src/contacts/contactStore.js';
import { createContactStore, normalisePhone } from '../src/contacts/contactStore.js';
import { createRollStore, minimiseEntries } from '../src/roll/rollStore.js';
import {
  DB_NAME, DB_VERSION, KEYS_STORE, ROLLS_STORE, META_STORE, CONTACTS_STORE,
} from '../src/storage/deviceDb.js';
import { DEVICE_KEY_ID } from '../src/crypto/deviceKey.js';
import { createFakeIndexedDB } from './helpers/fakeIndexedDB.js';

const WARD = '17/125/6313/1';
const PHONE = '9876543210';

function fakeStorage() {
  const storage = { calls: 0, persist() { storage.calls += 1; return Promise.resolve(true); } };
  return storage;
}

function newStore({ idb = createFakeIndexedDB(), storage = fakeStorage() } = {}) {
  return { idb, storage, store: createContactStore({ indexedDB: idb, crypto: webcrypto, storage }) };
}

const contacts = (idb) => idb.databases.get(DB_NAME).stores.get(CONTACTS_STORE);
const bytesOf = (value) => Buffer.from(
  value instanceof ArrayBuffer ? new Uint8Array(value) : new Uint8Array(value.buffer, value.byteOffset, value.byteLength),
);

async function decryptRecord(idb, id) {
  const key = idb.databases.get(DB_NAME).stores.get(KEYS_STORE).get(DEVICE_KEY_ID);
  const record = contacts(idb).get(id);
  const plain = await webcrypto.subtle.decrypt(
    { name: 'AES-GCM', iv: record.iv, additionalData: new TextEncoder().encode(id) }, key, record.ct,
  );
  return JSON.parse(new TextDecoder().decode(plain));
}

test('the module exports the four async operations', () => {
  for (const name of ['recordConsent', 'saveNumber', 'getContact', 'revokeConsent']) {
    assert.equal(typeof contactModule[name], 'function', name);
  }
});

test('the default exports work against the browser globals and return promises', async () => {
  const saved = globalThis.indexedDB;
  globalThis.indexedDB = createFakeIndexedDB();
  try {
    const consent = contactModule.recordConsent(WARD, 1);
    assert.ok(consent instanceof Promise);
    await consent;
    assert.equal((await contactModule.saveNumber(WARD, 1, PHONE)).phone, PHONE);
    assert.equal((await contactModule.getContact(WARD, 1)).phone, PHONE);
    await contactModule.revokeConsent(WARD, 1);
    assert.equal(await contactModule.getContact(WARD, 1), null);
  } finally {
    globalThis.indexedDB = saved;
  }
});

test('saveNumber without consent rejects and writes nothing', async () => {
  const { idb, store, storage } = newStore();
  await assert.rejects(store.saveNumber(WARD, 7, PHONE), /no consent/);
  assert.equal(contacts(idb).size, 0);
  assert.equal(await store.getContact(WARD, 7), null);
  assert.equal(storage.calls, 0);
});

test('saveNumber accepts a 10-digit mobile number after stripping spaces, +91 or 0', async () => {
  for (const input of ['9876543210', '98765 43210', '+919876543210', '+91 98765 43210', '09876543210']) {
    const { store } = newStore();
    await store.recordConsent(WARD, 1);
    assert.equal((await store.saveNumber(WARD, 1, input)).phone, PHONE, input);
    assert.equal((await store.getContact(WARD, 1)).phone, PHONE, input);
  }
});

test('saveNumber rejects anything but a 10-digit mobile number and writes nothing', async () => {
  const invalid = [
    '987654321', '98765432101', '98765abcde', '+929876543210', '919876543210',
    '98765-43210', '', null, undefined, 9876543210, {}, '0+919876543210',
  ];
  for (const input of invalid) {
    const { idb, store, storage } = newStore();
    const consent = await store.recordConsent(WARD, 1);
    const before = contacts(idb).get(`${WARD}:1`);
    await assert.rejects(store.saveNumber(WARD, 1, input), TypeError, String(input));
    assert.equal(contacts(idb).get(`${WARD}:1`), before, String(input));
    assert.deepEqual(await store.getContact(WARD, 1), consent, String(input));
    assert.equal(storage.calls, 0);
    assert.equal(normalisePhone(input), null, String(input));
  }
});

test('a fresh store on the same IndexedDB returns the same number and consent time (app restart)', async () => {
  const { idb, store } = newStore();
  const { consentAt } = await store.recordConsent(WARD, 12);
  await store.saveNumber(WARD, 12, '+91 98765 43210');
  const reopened = createContactStore({ indexedDB: idb, crypto: webcrypto, storage: null });
  assert.deepEqual(await reopened.getContact(WARD, 12), { wardId: WARD, serial: 12, phone: PHONE, consentAt });
});

test('a fresh module load against the same IndexedDB returns the same contact', async () => {
  const saved = globalThis.indexedDB;
  globalThis.indexedDB = createFakeIndexedDB();
  try {
    const first = await import('../src/contacts/contactStore.js?load=first');
    const { consentAt } = await first.recordConsent(WARD, 3);
    await first.saveNumber(WARD, 3, PHONE);
    const second = await import('../src/contacts/contactStore.js?load=second');
    assert.notEqual(first.getContact, second.getContact);
    const contact = await second.getContact(WARD, 3);
    assert.equal(contact.phone, PHONE);
    assert.equal(contact.consentAt, consentAt);
  } finally {
    globalThis.indexedDB = saved;
  }
});

test('recordConsent keeps the first consent time and any saved number', async () => {
  const { store } = newStore();
  const first = await store.recordConsent(WARD, 2);
  assert.equal(first.phone, null);
  assert.ok(!Number.isNaN(Date.parse(first.consentAt)));
  await store.saveNumber(WARD, 2, PHONE);
  const again = await store.recordConsent(WARD, 2);
  assert.equal(again.consentAt, first.consentAt);
  assert.equal(again.phone, PHONE);
});

test('each record is {wardId, serial, iv, ct} only; a consent-only record holds a null phone', async () => {
  const { idb, store } = newStore();
  const { consentAt } = await store.recordConsent(WARD, 4);
  const id = `${WARD}:4`;
  let record = contacts(idb).get(id);
  assert.deepEqual(Object.keys(record).sort(), ['ct', 'iv', 'serial', 'wardId']);
  assert.equal(record.wardId, WARD);
  assert.equal(record.serial, 4);
  assert.equal(record.iv.byteLength, 12);
  assert.deepEqual(await decryptRecord(idb, id), { phone: null, consentAt });

  await store.saveNumber(WARD, 4, PHONE);
  record = contacts(idb).get(id);
  assert.deepEqual(Object.keys(record).sort(), ['ct', 'iv', 'serial', 'wardId']);
  for (const field of ['name', 'relative', 'house', 'age', 'gender', 'epic', 'phone', 'consentAt']) {
    assert.ok(!(field in record), field);
  }
  assert.deepEqual(await decryptRecord(idb, id), { phone: PHONE, consentAt });
  // AES-GCM: 16-byte tag on top of the JSON plaintext.
  assert.equal(bytesOf(record.ct).byteLength, Buffer.from(JSON.stringify({ phone: PHONE, consentAt })).byteLength + 16);
  // The record is bound to its key: moved elsewhere it does not decrypt.
  contacts(idb).set(`${WARD}:5`, record);
  await assert.rejects(store.getContact(WARD, 5));
});

test('serialising every stored contact value finds neither the phone digits nor the consent time', async () => {
  const { idb, store } = newStore();
  const times = [];
  for (const [serial, phone] of [[1, '9876543210'], [2, '8123456789'], [3, null]]) {
    times.push((await store.recordConsent(WARD, serial)).consentAt);
    if (phone) await store.saveNumber(WARD, serial, phone);
  }
  let dump = '';
  for (const value of contacts(idb).values()) {
    dump += JSON.stringify(value, (k, v) => (ArrayBuffer.isView(v) || v instanceof ArrayBuffer
      ? bytesOf(v).toString('latin1') : v));
    dump += bytesOf(value.ct).toString('utf8') + bytesOf(value.iv).toString('utf8');
  }
  assert.equal(contacts(idb).size, 3);
  for (const secret of ['9876543210', '8123456789', ...times, 'consentAt', 'phone']) {
    assert.ok(!dump.includes(secret), secret);
  }
});

test('revokeConsent deletes the record; getContact is null and saveNumber rejects afterwards', async () => {
  const { idb, store } = newStore();
  await store.recordConsent(WARD, 9);
  await store.saveNumber(WARD, 9, PHONE);
  await store.recordConsent(WARD, 10);
  await store.revokeConsent(WARD, 9);
  assert.equal(await store.getContact(WARD, 9), null);
  assert.ok(!contacts(idb).has(`${WARD}:9`));
  assert.ok(contacts(idb).has(`${WARD}:10`));
  await assert.rejects(store.saveNumber(WARD, 9, PHONE), /no consent/);
  assert.ok(!contacts(idb).has(`${WARD}:9`));
  // Revoking a voter without consent is a no-op.
  await store.revokeConsent(WARD, 99);
});

test('navigator.storage.persist() is called once, on the first successful save', async () => {
  const { store, storage } = newStore();
  await store.recordConsent(WARD, 1);
  assert.equal(storage.calls, 0);
  await assert.rejects(store.saveNumber(WARD, 1, '123'));
  await assert.rejects(store.saveNumber(WARD, 2, PHONE));
  assert.equal(storage.calls, 0);
  await store.saveNumber(WARD, 1, PHONE);
  assert.equal(storage.calls, 1);
  await store.recordConsent(WARD, 2);
  await store.saveNumber(WARD, 2, '8123456789');
  assert.equal(storage.calls, 1);
});

test('a missing or failing storage.persist does not break saving', async () => {
  for (const storage of [null, {}, { persist: () => Promise.reject(new Error('denied')) },
    { persist: () => { throw new Error('boom'); } }]) {
    const { store } = newStore({ storage });
    await store.recordConsent(WARD, 1);
    assert.equal((await store.saveNumber(WARD, 1, PHONE)).phone, PHONE);
  }
});

test('every operation succeeds with fetch undefined (works offline)', async () => {
  const savedFetch = globalThis.fetch;
  delete globalThis.fetch;
  try {
    assert.equal(typeof globalThis.fetch, 'undefined');
    const { store, storage } = newStore();
    assert.equal((await store.recordConsent(WARD, 1)).phone, null);
    assert.equal((await store.saveNumber(WARD, 1, PHONE)).phone, PHONE);
    assert.equal((await store.getContact(WARD, 1)).phone, PHONE);
    await store.revokeConsent(WARD, 1);
    assert.equal(await store.getContact(WARD, 1), null);
    assert.equal(storage.calls, 1);
  } finally {
    globalThis.fetch = savedFetch;
  }
});

test('voter keys never collide: ":" is rejected in wardId and serial 5 equals "5"', async () => {
  const { store } = newStore();
  await assert.rejects(store.recordConsent('a:1', 2), TypeError);
  await assert.rejects(store.recordConsent(WARD, '1:2'), TypeError);
  for (const bad of ['', -1, 1.5, NaN, null, 'x']) {
    await assert.rejects(store.recordConsent(WARD, bad), TypeError, String(bad));
  }
  await assert.rejects(store.recordConsent('', 1), TypeError);
  await store.recordConsent(WARD, 5);
  await store.saveNumber(WARD, '5', PHONE);
  assert.deepEqual(await store.getContact(WARD, '5'), await store.getContact(WARD, 5));
  assert.equal((await store.getContact(WARD, '5')).serial, 5);
});

test('upgrading a v1 database keeps its roll and its device key, which the contact store reuses', async () => {
  const idb = createFakeIndexedDB();
  // Seed the database exactly as the v1 roll store left it.
  const roll = minimiseEntries([{ serial: 1, name: 'किशनादेवी', relative: 'सत्यनारायण', age: 57, gender: 'स्त्री', house: '1' }]);
  const key = await webcrypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  const iv = webcrypto.getRandomValues(new Uint8Array(12));
  const data = await webcrypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: new TextEncoder().encode(WARD) }, key,
    new TextEncoder().encode(JSON.stringify(roll)),
  );
  await new Promise((resolve, reject) => {
    const req = idb.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      for (const name of [KEYS_STORE, ROLLS_STORE, META_STORE]) req.result.createObjectStore(name);
    };
    req.onsuccess = () => {
      const tx = req.result.transaction([KEYS_STORE, ROLLS_STORE, META_STORE], 'readwrite');
      tx.objectStore(KEYS_STORE).put(key, 'roll-key');
      tx.objectStore(ROLLS_STORE).put({ v: 1, iv, data }, WARD);
      tx.objectStore(META_STORE).put(WARD, 'last-ward');
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    };
  });
  assert.equal(idb.databases.get(DB_NAME).version, 1);

  const rolls = createRollStore({ indexedDB: idb, crypto: webcrypto });
  assert.deepEqual(await rolls.loadStored(WARD), roll);
  assert.equal(await rolls.lastWardKey(), WARD);
  const record = idb.databases.get(DB_NAME);
  assert.equal(record.version, DB_VERSION);
  assert.ok(DB_VERSION >= 2);
  assert.ok(record.stores.has(CONTACTS_STORE));

  const { store } = newStore({ idb });
  await store.recordConsent(WARD, 1);
  await store.saveNumber(WARD, 1, PHONE);
  assert.equal(record.stores.get(KEYS_STORE).size, 1);
  assert.equal(record.stores.get(KEYS_STORE).get(DEVICE_KEY_ID), key);
  assert.equal((await decryptRecord(idb, `${WARD}:1`)).phone, PHONE);
  assert.deepEqual(await rolls.loadStored(WARD), roll);
});

test('the roll store and the contact store share one device key on a new device', async () => {
  const idb = createFakeIndexedDB();
  const { store } = newStore({ idb });
  await store.recordConsent(WARD, 1);
  const rolls = createRollStore({ indexedDB: idb, crypto: webcrypto });
  await rolls.encryptAndStore(WARD, [{ serial: 1, name: 'x' }]);
  assert.equal(idb.databases.get(DB_NAME).stores.get(KEYS_STORE).size, 1);
});

test('missing IndexedDB or WebCrypto rejects instead of throwing synchronously', async () => {
  await assert.rejects(createContactStore({ indexedDB: null, crypto: webcrypto }).getContact(WARD, 1));
  const noCrypto = createContactStore({ indexedDB: createFakeIndexedDB(), crypto: null });
  await assert.rejects(noCrypto.recordConsent(WARD, 1));
});

test('the service worker precaches the stores and every module they import (offline)', async () => {
  const { readFileSync } = await import('node:fs');
  const read = (rel) => readFileSync(new URL('../' + rel, import.meta.url), 'utf8');
  const sw = read('sw.js');
  const pending = ['src/roll/rollStore.js', 'src/contacts/contactStore.js'];
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
  assert.ok(seen.has('src/storage/deviceDb.js') && seen.has('src/crypto/deviceKey.js'));
});

test('listConsented returns the ward\'s consented voters in serial order, numbers decrypted', async () => {
  const { store } = newStore();
  await store.recordConsent(WARD, 9);
  await store.saveNumber(WARD, 9, PHONE);
  await store.recordConsent(WARD, 2);
  await store.recordConsent('17/125/6313/2', 1);
  await store.saveNumber('17/125/6313/2', 1, '9123456780');
  const listed = await store.listConsented(WARD);
  assert.deepEqual(listed.map(({ serial, phone }) => ({ serial, phone })), [
    { serial: 2, phone: null },
    { serial: 9, phone: PHONE },
  ]);
  for (const contact of listed) {
    assert.equal(contact.wardId, WARD);
    assert.equal(typeof contact.consentAt, 'string');
  }
  await store.revokeConsent(WARD, 9);
  assert.deepEqual((await store.listConsented(WARD)).map((c) => c.serial), [2]);
  assert.deepEqual(await store.listConsented('17/125/6313/9'), []);
  await assert.rejects(store.listConsented(''), TypeError);
});
