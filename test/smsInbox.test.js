// Coordinator's SMS inbox (issue #85), run by `npm test`: pasted tally SMS
// merge into one encrypted set of serials, so no serial is counted twice.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';

import * as inboxModule from '../src/tally/smsInbox.js';
import { createSmsInbox, SMS_TALLY_STORE } from '../src/tally/smsInbox.js';
import { encodeTallySms } from '../src/tally/smsCodec.js';
import { DB_NAME, KEYS_STORE } from '../src/storage/deviceDb.js';
import { DEVICE_KEY_ID } from '../src/crypto/deviceKey.js';
import { createFakeIndexedDB } from './helpers/fakeIndexedDB.js';

const TEAM = 'cand-17';
const sms = (workerId, serials, teamTag = TEAM) => encodeTallySms({ teamTag, workerId, serials })[0];

function newInbox(idb = createFakeIndexedDB()) {
  const logged = [];
  const inbox = createSmsInbox({ indexedDB: idb, crypto: webcrypto, log: (...args) => logged.push(args) });
  return { idb, inbox, logged };
}

const raw = (idb) => idb.databases.get(DB_NAME)?.stores.get(SMS_TALLY_STORE);
const snapshot = (idb) => {
  const record = raw(idb)?.get(TEAM);
  return record ? Buffer.from(record.ct).toString('hex') + Buffer.from(record.iv).toString('hex') : null;
};

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

test('the module exports applyTallySms and its onSerialsAdded hook', () => {
  assert.equal(typeof inboxModule.applyTallySms, 'function');
  assert.equal(typeof inboxModule.onSerialsAdded, 'function');
  assert.equal(inboxModule.applyTallySms.onSerialsAdded, inboxModule.onSerialsAdded);
  const { inbox } = newInbox();
  assert.equal(inbox.applyTallySms.onSerialsAdded, inbox.onSerialsAdded);
});

test('a message decodes into its worker and new serials', async () => {
  const { inbox } = newInbox();
  const result = await inbox.applyTallySms(sms('w3', [42, 7, 300]), { teamTag: TEAM });
  assert.deepEqual(result, { ok: true, workerId: 'w3', newSerials: [7, 42, 300], duplicateSerials: [] });
  assert.deepEqual(await inbox.loadAppliedSerials(TEAM), [7, 42, 300]);
});

test('the same SMS applied twice adds nothing the second time and the set does not grow', async () => {
  const { inbox } = newInbox();
  const text = sms('w3', [1, 2, 3]);
  await inbox.applyTallySms(text, { teamTag: TEAM });
  const again = await inbox.applyTallySms(`\n  ${text}  \n`, { teamTag: TEAM });
  assert.deepEqual(again, { ok: true, workerId: 'w3', newSerials: [], duplicateSerials: [1, 2, 3] });
  assert.deepEqual(await inbox.loadAppliedSerials(TEAM), [1, 2, 3]);
});

test('two different SMS sharing serials add each shared serial exactly once', async () => {
  const { inbox } = newInbox();
  const first = await inbox.applyTallySms(sms('w3', [5, 6, 7]), { teamTag: TEAM });
  const second = await inbox.applyTallySms(sms('w9', [6, 7, 8, 9]), { teamTag: TEAM });
  assert.deepEqual(first.newSerials, [5, 6, 7]);
  assert.deepEqual(second, { ok: true, workerId: 'w9', newSerials: [8, 9], duplicateSerials: [6, 7] });
  assert.deepEqual(await inbox.loadAppliedSerials(TEAM), [5, 6, 7, 8, 9]);
});

test('resends, split parts and overlaps never push the count past the distinct serials', async () => {
  const { inbox } = newInbox();
  const big = Array.from({ length: 120 }, (_, i) => i * 3 + 1);
  const parts = encodeTallySms({ teamTag: TEAM, workerId: 'w1', serials: big });
  assert.ok(parts.length > 1, 'the tally is split across messages');
  const overlap = encodeTallySms({ teamTag: TEAM, workerId: 'w2', serials: big.slice(50, 70).concat([2, 4]) });
  const pasted = [...parts, ...overlap, ...parts.slice().reverse(), parts[0]];
  let newTotal = 0;
  for (const text of pasted) newTotal += (await inbox.applyTallySms(text, { teamTag: TEAM })).newSerials.length;
  const distinct = new Set([...big, 2, 4]).size;
  assert.equal(newTotal, distinct);
  assert.equal((await inbox.loadAppliedSerials(TEAM)).length, distinct);
});

test('pastes made at the same moment are merged one after another, losing none', async () => {
  const { inbox } = newInbox();
  const results = await Promise.all([
    inbox.applyTallySms(sms('w1', [1, 2]), { teamTag: TEAM }),
    inbox.applyTallySms(sms('w2', [2, 3]), { teamTag: TEAM }),
    inbox.applyTallySms(sms('w1', [1, 2]), { teamTag: TEAM }),
  ]);
  assert.deepEqual(results.map((r) => r.newSerials), [[1, 2], [3], []]);
  assert.deepEqual(await inbox.loadAppliedSerials(TEAM), [1, 2, 3]);
});

test('a bad checksum, a malformed message or another team is rejected and leaves storage unchanged', async () => {
  const { idb, inbox } = newInbox();
  await inbox.applyTallySms(sms('w3', [10, 11]), { teamTag: TEAM });
  const before = snapshot(idb);

  const good = sms('w3', [12, 13]);
  const tampered = good.replace(/ [0-9a-f]{4}$/, (sum) => ` ${sum.slice(1, 4)}${sum[1] === '0' ? '1' : '0'}`);
  const swapped = good.replace(' c.d ', ' c.e ');
  const cases = [
    [tampered, 'checksum'],
    [swapped, 'checksum'],
    [sms('w3', [12, 13], 'cand-99'), 'team'],
    ['hello there', 'prefix'],
    ['PT1 cand-17 w3', 'format'],
  ];
  for (const [text, reason] of cases) {
    const result = await inbox.applyTallySms(text, { teamTag: TEAM });
    assert.equal(result.ok, false, text);
    assert.equal(result.reason, reason, text);
    assert.deepEqual(result.newSerials, []);
    assert.deepEqual(result.duplicateSerials, []);
    assert.equal(snapshot(idb), before, text);
  }
  assert.deepEqual(await inbox.loadAppliedSerials(TEAM), [10, 11]);
});

test('a rejected message on an empty device stores nothing at all', async () => {
  const { idb, inbox } = newInbox();
  const result = await inbox.applyTallySms(sms('w3', [1], 'cand-99'), { teamTag: TEAM });
  assert.equal(result.ok, false);
  assert.equal(raw(idb)?.size ?? 0, 0);
});

test('the serial set is AES-GCM encrypted with the device key and holds no plaintext serials', async () => {
  const { idb, inbox } = newInbox();
  await inbox.applyTallySms(sms('w3', [4242, 777]), { teamTag: TEAM });
  const store = raw(idb);
  assert.deepEqual([...store.keys()], [TEAM]);
  const record = store.get(TEAM);
  assert.deepEqual(Object.keys(record).sort(), ['ct', 'iv', 'v']);
  const bytes = Buffer.from(record.ct);
  for (const needle of ['4242', '777', (4242).toString(36), 'serials']) assert.equal(bytes.includes(needle), false, needle);
  assert.equal(record.iv.length, 12);

  const key = idb.databases.get(DB_NAME).stores.get(KEYS_STORE).get(DEVICE_KEY_ID);
  assert.equal(key.extractable, false);
  const plain = await webcrypto.subtle.decrypt(
    { name: 'AES-GCM', iv: record.iv, additionalData: new TextEncoder().encode(`sms-tally:${TEAM}`) },
    key,
    record.ct,
  );
  assert.deepEqual(JSON.parse(new TextDecoder().decode(plain)), { serials: [777, 4242] });
});

test('a repeated SMS does not rewrite the stored record', async () => {
  const { idb, inbox } = newInbox();
  const text = sms('w3', [1, 2]);
  await inbox.applyTallySms(text, { teamTag: TEAM });
  const before = snapshot(idb);
  await inbox.applyTallySms(text, { teamTag: TEAM });
  assert.equal(snapshot(idb), before);
});

test('onSerialsAdded gets each batch of new serials after it is stored, and can unsubscribe', async () => {
  const { idb, inbox, logged } = newInbox();
  const batches = [];
  const storedAtCall = [];
  const stop = inbox.onSerialsAdded((serials) => {
    batches.push(serials);
    storedAtCall.push(snapshot(idb));
  });
  inbox.onSerialsAdded(() => { throw new Error('subscriber bug'); });
  await inbox.applyTallySms(sms('w3', [3, 1]), { teamTag: TEAM });
  await inbox.applyTallySms(sms('w3', [3, 1]), { teamTag: TEAM });
  await inbox.applyTallySms(sms('w3', [9], 'cand-99'), { teamTag: TEAM });
  await inbox.applyTallySms(sms('w4', [1, 5]), { teamTag: TEAM });
  stop();
  await inbox.applyTallySms(sms('w4', [6]), { teamTag: TEAM });
  assert.deepEqual(batches, [[1, 3], [5]]);
  assert.ok(storedAtCall.every(Boolean), 'the batch is stored before subscribers hear of it');
  assert.notEqual(storedAtCall[0], storedAtCall[1]);
  assert.equal(logged.length, 3, 'each call of a throwing subscriber is logged, not fatal');
  assert.throws(() => inbox.onSerialsAdded('nope'), TypeError);
});

test('the set survives a reload with no network access', async () => {
  const idb = createFakeIndexedDB();
  await withoutNetwork(async () => {
    await newInbox(idb).inbox.applyTallySms(sms('w3', [1, 2]), { teamTag: TEAM });
    const reopened = newInbox(idb).inbox;
    const again = await reopened.applyTallySms(sms('w5', [2, 3]), { teamTag: TEAM });
    assert.deepEqual(again.newSerials, [3]);
    assert.deepEqual(await reopened.loadAppliedSerials(TEAM), [1, 2, 3]);
  });
});

test('a teamTag is required, and without IndexedDB nothing pretends to be saved', async () => {
  const { inbox } = newInbox();
  await assert.rejects(inbox.applyTallySms(sms('w3', [1]), {}), TypeError);
  await assert.rejects(inbox.applyTallySms(sms('w3', [1])), TypeError);
  const offline = createSmsInbox({ indexedDB: null, crypto: webcrypto });
  await assert.rejects(offline.applyTallySms(sms('w3', [1]), { teamTag: TEAM }));
  // A failed apply does not block the next one.
  const ok = await inbox.applyTallySms(sms('w3', [1]), { teamTag: TEAM });
  assert.deepEqual(ok.newSerials, [1]);
});
