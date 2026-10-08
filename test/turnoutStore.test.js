// Encrypted on-device official turnout figure (issue #87), run by `npm test`.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';

import {
  createTurnoutStore, parseTurnoutCount, saveOfficialTurnout, loadOfficialTurnout, TURNOUT_STORE,
} from '../src/tally/turnoutStore.js';
import { createRollStore } from '../src/roll/rollStore.js';
import { DB_NAME, KEYS_STORE } from '../src/storage/deviceDb.js';
import { DEVICE_KEY_ID } from '../src/crypto/deviceKey.js';
import { createFakeIndexedDB } from './helpers/fakeIndexedDB.js';

const WARD = 'badli-1';

function newStore(idb = createFakeIndexedDB()) {
  return { idb, store: createTurnoutStore({ indexedDB: idb, crypto: webcrypto }) };
}

const raw = (idb, storeName) => idb.databases.get(DB_NAME).stores.get(storeName);

// Runs fn with fetch replaced by one that fails the test if it is ever called.
async function withoutNetwork(fn) {
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    throw new TypeError('Failed to fetch');
  };
  try {
    return await fn();
  } finally {
    globalThis.fetch = original;
    assert.equal(calls, 0, 'no network call is made');
  }
}

test('the module exports the intended API', () => {
  assert.equal(typeof saveOfficialTurnout, 'function');
  assert.equal(typeof loadOfficialTurnout, 'function');
});

test('load is null before any save, then returns the last saved figure per ward', async () => {
  const { store } = newStore();
  assert.equal(await store.loadOfficialTurnout(WARD), null);
  assert.equal(await store.saveOfficialTurnout(WARD, 412), 412);
  assert.equal(await store.loadOfficialTurnout(WARD), 412);
  await store.saveOfficialTurnout(WARD, '0');
  assert.equal(await store.loadOfficialTurnout(WARD), 0);
  await store.saveOfficialTurnout('badli-2', '97');
  assert.equal(await store.loadOfficialTurnout('badli-2'), 97);
  assert.equal(await store.loadOfficialTurnout(WARD), 0);
  assert.equal(await store.loadOfficialTurnout('badli-3'), null);
});

test('Devanagari digits are stored as the same integer as their ASCII form', async () => {
  assert.equal(parseTurnoutCount('४१२'), 412);
  assert.equal(parseTurnoutCount('०१२३४५६७८९'), 123456789);
  assert.equal(parseTurnoutCount(' 4१2 '), 412);
  const { store } = newStore();
  assert.equal(await store.saveOfficialTurnout(WARD, '४१२'), 412);
  assert.equal(await store.loadOfficialTurnout(WARD), 412);
  assert.equal(typeof await store.loadOfficialTurnout(WARD), 'number');
});

test('values that are not a non-negative whole number are rejected and leave the stored value unchanged', async () => {
  const { idb, store } = newStore();
  await store.saveOfficialTurnout(WARD, 412);
  const before = raw(idb, TURNOUT_STORE).get(WARD);
  const rejected = [
    -1, '-3', 1.5, '1.5', '४.५', NaN, Infinity, '', '   ', 'abc', '41a', 'चार सौ', '1e3', '0x10',
    null, undefined, {}, [], true, 2 ** 53,
  ];
  for (const value of rejected) {
    await assert.rejects(store.saveOfficialTurnout(WARD, value), TypeError, `rejects ${String(value)}`);
    assert.throws(() => parseTurnoutCount(value), TypeError);
  }
  assert.equal(raw(idb, TURNOUT_STORE).get(WARD), before);
  assert.equal(await store.loadOfficialTurnout(WARD), 412);
  await assert.rejects(store.saveOfficialTurnout('', 5), TypeError);
});

test('the record is AES-GCM encrypted with the device key and holds no plaintext figure', async () => {
  const { idb, store } = newStore();
  await store.saveOfficialTurnout(WARD, '४१२');
  const record = raw(idb, TURNOUT_STORE).get(WARD);
  assert.deepEqual(Object.keys(record).sort(), ['ct', 'iv', 'v']);
  for (const value of Object.values(record)) {
    assert.notEqual(value, 412);
    assert.notEqual(value, '412');
  }
  const bytes = Buffer.from(record.ct);
  assert.equal(bytes.includes('412'), false);
  assert.equal(bytes.includes('४१२'), false);
  assert.equal(record.iv.length, 12);

  const key = raw(idb, KEYS_STORE).get(DEVICE_KEY_ID);
  assert.equal(key.extractable, false);
  const plain = await webcrypto.subtle.decrypt(
    { name: 'AES-GCM', iv: record.iv, additionalData: new TextEncoder().encode(`turnout:${WARD}`) },
    key,
    record.ct,
  );
  assert.deepEqual(JSON.parse(new TextDecoder().decode(plain)), { count: 412 });
});

test('the turnout store and the roll store share one device key', async () => {
  const idb = createFakeIndexedDB();
  const rolls = createRollStore({ indexedDB: idb, crypto: webcrypto });
  await rolls.encryptAndStore(WARD, [{ serial: 1, name: 'क', relative: 'ख', age: 30, gender: 'पुरूष', house: '1' }]);
  const { store } = newStore(idb);
  await store.saveOfficialTurnout(WARD, 412);
  assert.equal(raw(idb, KEYS_STORE).size, 1);
  assert.equal(await store.loadOfficialTurnout(WARD), 412);
  assert.equal((await rolls.loadStored(WARD)).length, 1);
});

test('a fresh IV is used for each write', async () => {
  const { idb, store } = newStore();
  await store.saveOfficialTurnout(WARD, 412);
  const first = raw(idb, TURNOUT_STORE).get(WARD);
  await store.saveOfficialTurnout(WARD, 412);
  const second = raw(idb, TURNOUT_STORE).get(WARD);
  assert.notDeepEqual(Buffer.from(first.iv), Buffer.from(second.iv));
});

test('the figure survives a reload of the store with no network access', async () => {
  const idb = createFakeIndexedDB();
  await withoutNetwork(async () => {
    await createTurnoutStore({ indexedDB: idb, crypto: webcrypto }).saveOfficialTurnout(WARD, '४१२');
    const reopened = createTurnoutStore({ indexedDB: idb, crypto: webcrypto });
    assert.equal(await reopened.loadOfficialTurnout(WARD), 412);
  });
});

test('another installation cannot read the figure', async () => {
  const { idb, store } = newStore();
  await store.saveOfficialTurnout(WARD, 412);

  const other = newStore();
  assert.equal(await other.store.loadOfficialTurnout(WARD), null);

  // Even a copy of the raw record is unreadable there: its device key differs.
  await other.store.saveOfficialTurnout('badli-9', 1);
  raw(other.idb, TURNOUT_STORE).set(WARD, raw(idb, TURNOUT_STORE).get(WARD));
  await assert.rejects(other.store.loadOfficialTurnout(WARD));
  assert.equal(await store.loadOfficialTurnout(WARD), 412);
});

test('without IndexedDB the store rejects rather than pretending to save', async () => {
  const store = createTurnoutStore({ indexedDB: null, crypto: webcrypto });
  await assert.rejects(store.saveOfficialTurnout(WARD, 1));
  await assert.rejects(store.loadOfficialTurnout(WARD));
});
