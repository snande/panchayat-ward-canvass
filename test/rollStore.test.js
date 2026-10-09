// Encrypted on-device roll store (issue #16), run by `npm test`.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { webcrypto } from 'node:crypto';

import {
  createRollStore, minimiseEntries, wardKeyFor, STORED_FIELDS, RECORD_VERSION, RollRecordVersionError,
  DB_NAME, KEYS_STORE, ROLLS_STORE,
} from '../src/roll/rollStore.js';
import { decodeRoll } from '../src/decoder/decodeRoll.js';
import { createFakeIndexedDB } from './helpers/fakeIndexedDB.js';

const fixture = (rel) => readFileSync(new URL('../fixtures/' + rel, import.meta.url));
const WARD = 'ward-key-1';

const sample = [
  { serial: 2, page: 3, name: 'नन्दकिशोर', relation: 'पिता', relative: 'सत्यनारायण', age: 38,
    gender: 'पुरूष', house: '1', epic: 'UPY0171215', struck: false },
  { serial: 1, page: 3, name: 'किशनादेवी', relation: 'पति', relative: 'सत्यनारायण', age: 57,
    gender: 'स्त्री', house: '1', epic: 'UPY0171199', struck: false },
  { serial: 3, page: 3, name: 'हटाया गया', relative: 'कोई', age: 40, gender: 'पुरूष', house: '2',
    epic: 'UPY0000000', struck: true },
];

function newStore(idb = createFakeIndexedDB()) {
  return { idb, store: createRollStore({ indexedDB: idb, crypto: webcrypto }) };
}

const raw = (idb, storeName) => idb.databases.get(DB_NAME).stores.get(storeName);
const bytesOf = (value) => Buffer.from(value instanceof ArrayBuffer ? new Uint8Array(value) : value);

test('wardKeyFor joins the selection ids', () => {
  assert.equal(wardKeyFor({ district: '17', samiti: '125', panchayat: '6313', ward: '1', pdfUrl: 'x' }),
    '17/125/6313/1');
});

test('minimiseEntries keeps the seven fields of every entry, struck-off ones included', () => {
  const out = minimiseEntries(sample);
  assert.deepEqual(out.map((e) => [e.serial, e.struck]), [[2, false], [1, false], [3, true]]);
  for (const entry of out) assert.deepEqual(Object.keys(entry), [...STORED_FIELDS]);
  assert.deepEqual(STORED_FIELDS, ['serial', 'name', 'relative', 'age', 'gender', 'house', 'struck']);
  for (const entry of out) assert.ok(!('epic' in entry) && !('page' in entry) && !('relation' in entry));
  // Only a literal true marks an entry struck off.
  assert.equal(minimiseEntries([{ serial: 4, struck: 'yes' }])[0].struck, false);
  assert.throws(() => minimiseEntries(null), TypeError);
});

test('round trip: what was stored decrypts to the minimised entries', async () => {
  const { store } = newStore();
  const stored = await store.encryptAndStore(WARD, sample);
  assert.deepEqual(stored, minimiseEntries(sample));
  assert.deepEqual(await store.loadStored(WARD), stored);
  assert.equal(await store.lastWardKey(), WARD);
  assert.equal(await store.loadStored('other-ward'), null);
});

test('a new store instance on the same device reads the copy (app reopened)', async () => {
  const { idb, store } = newStore();
  await store.encryptAndStore(WARD, sample);
  const reopened = createRollStore({ indexedDB: idb, crypto: webcrypto });
  assert.equal(await reopened.lastWardKey(), WARD);
  assert.deepEqual(await reopened.loadStored(WARD), minimiseEntries(sample));
});

test('the device key is a non-extractable AES-GCM CryptoKey', async () => {
  const { idb, store } = newStore();
  await store.encryptAndStore(WARD, sample);
  const keys = [...raw(idb, KEYS_STORE).values()];
  assert.equal(keys.length, 1);
  const [key] = keys;
  assert.equal(Object.prototype.toString.call(key), '[object CryptoKey]');
  assert.equal(key.type, 'secret');
  assert.equal(key.algorithm.name, 'AES-GCM');
  assert.equal(key.algorithm.length, 256);
  assert.equal(key.extractable, false);
  await assert.rejects(webcrypto.subtle.exportKey('raw', key));
});

test('concurrent first writes share one device key', async () => {
  const { idb, store } = newStore();
  await Promise.all([store.encryptAndStore('a', sample), store.encryptAndStore('b', sample)]);
  assert.equal(raw(idb, KEYS_STORE).size, 1);
  assert.deepEqual(await store.loadStored('a'), await store.loadStored('b'));
});

test('the stored record is AES-GCM ciphertext: no names, no EPIC, fresh IV per write', async () => {
  const { idb, store } = newStore();
  await store.encryptAndStore(WARD, sample);
  const first = raw(idb, ROLLS_STORE).get(WARD);
  assert.deepEqual(Object.keys(first).sort(), ['data', 'iv', 'v']);
  assert.equal(first.v, RECORD_VERSION);
  assert.equal(RECORD_VERSION, 2);
  assert.equal(first.iv.byteLength, 12);
  const dump = bytesOf(first.data).toString('utf8') + JSON.stringify(first);
  for (const secret of ['किशनादेवी', 'सत्यनारायण', 'UPY0171199', 'UPY0000000', 'serial', '"name"', 'struck']) {
    assert.ok(!dump.includes(secret), secret);
  }
  // 16-byte GCM tag on top of the JSON plaintext.
  const plain = Buffer.from(JSON.stringify(minimiseEntries(sample)));
  assert.equal(bytesOf(first.data).byteLength, plain.byteLength + 16);

  await store.encryptAndStore(WARD, sample);
  const second = raw(idb, ROLLS_STORE).get(WARD);
  assert.notDeepEqual(bytesOf(second.iv), bytesOf(first.iv));
});

test('ciphertext is bound to its ward: a copy moved to another key does not decrypt', async () => {
  const { idb, store } = newStore();
  await store.encryptAndStore(WARD, sample);
  raw(idb, ROLLS_STORE).set('moved', raw(idb, ROLLS_STORE).get(WARD));
  await assert.rejects(store.loadStored('moved'));
});

test('nothing but the key, the encrypted rolls and the last-ward pointer is stored', async () => {
  const { idb, store } = newStore();
  await store.encryptAndStore(WARD, sample);
  const stores = idb.databases.get(DB_NAME).stores;
  assert.deepEqual([...stores.keys()].sort(), ['assignments', 'contacts', 'keys', 'marks', 'meta', 'outbox', 'rolls', 'smsTally', 'synced', 'team', 'turnout']);
  assert.equal(stores.get('contacts').size, 0);
  assert.equal(stores.get('assignments').size, 0);
  assert.equal(stores.get('outbox').size, 0);
  assert.equal(stores.get('synced').size, 0);
  assert.equal(stores.get('marks').size, 0);
  assert.equal(stores.get('turnout').size, 0);
  assert.deepEqual([...stores.get('meta').entries()], [['last-ward', WARD]]);
});

test('the decoded Badli ward 1 roll is stored as exactly the seven fields, struck-off entries included', async () => {
  const decoded = decodeRoll(fixture('badli-ward1.pdf'));
  const { idb, store } = newStore();
  const stored = await store.encryptAndStore(WARD, decoded);
  // Every printed serial, 1 to 326, is stored; the 29 struck off carry
  // struck: true and the 297 live ones are the benchmark's expected roll.
  const expected = JSON.parse(fixture('badli-ward1-expected.json').toString('utf8'));
  const allSerials = JSON.parse(fixture('badli-ward1-all-serials.json').toString('utf8'));
  assert.deepEqual(stored.map((e) => e.serial), allSerials.map((e) => e.serial));
  assert.deepEqual(stored.filter((e) => e.struck).map((e) => e.serial), allSerials.filter((e) => e.deleted).map((e) => e.serial));
  assert.deepEqual(stored.filter((e) => !e.struck).map((e) => e.serial), expected.map((e) => e.serial));
  for (const entry of stored) assert.deepEqual(Object.keys(entry), [...STORED_FIELDS]);
  const record = raw(idb, ROLLS_STORE).get(WARD);
  // Far smaller than the 257 KB PDF: the PDF itself is never stored.
  assert.ok(bytesOf(record.data).byteLength < 100_000);
  assert.ok(!bytesOf(record.data).includes(Buffer.from('%PDF-')));
  assert.deepEqual(await store.loadStored(WARD), stored);
});

test('missing IndexedDB or WebCrypto rejects instead of throwing synchronously', async () => {
  await assert.rejects(createRollStore({ indexedDB: null, crypto: webcrypto }).lastWardKey());
  const noCrypto = createRollStore({ indexedDB: createFakeIndexedDB(), crypto: null });
  await assert.rejects(noCrypto.encryptAndStore(WARD, sample));
});

test('a stored record of the old version reads as not stored, so the roll is decoded again', async () => {
  const { idb, store } = newStore();
  await store.encryptAndStore(WARD, sample);
  const record = raw(idb, ROLLS_STORE).get(WARD);
  raw(idb, ROLLS_STORE).set(WARD, { ...record, v: 1 });
  assert.equal(await store.loadStored(WARD), null);
});

test('a stored record of an unknown version is an explicit error, not a misread', async () => {
  const { idb, store } = newStore();
  await store.encryptAndStore(WARD, sample);
  const record = raw(idb, ROLLS_STORE).get(WARD);
  for (const v of [3, 0, undefined, '2']) {
    raw(idb, ROLLS_STORE).set(WARD, { ...record, v });
    await assert.rejects(store.loadStored(WARD), (err) => err instanceof RollRecordVersionError && err.version === v);
  }
  raw(idb, ROLLS_STORE).set(WARD, record);
  assert.deepEqual(await store.loadStored(WARD), minimiseEntries(sample));
});
