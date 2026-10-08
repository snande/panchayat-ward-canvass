// Coordinator's SMS inbox (issue #85): pasted tally SMS merged by set union
// into the encrypted team tally, run by `npm test`.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { readFileSync } from 'node:fs';

import * as inboxModule from '../src/tally/smsInbox.js';
import { createSmsInbox, SMS_SERIALS_ID } from '../src/tally/smsInbox.js';
import { encodeTallySms } from '../src/tally/smsCodec.js';
import { DB_NAME, META_STORE } from '../src/storage/deviceDb.js';
import { createFakeIndexedDB } from './helpers/fakeIndexedDB.js';

const TEAM = 'cand-17';
const newInbox = (idb = createFakeIndexedDB()) => createSmsInbox({ indexedDB: idb, crypto: webcrypto, log: () => {} });
const sms = (serials, { teamTag = TEAM, workerId = 'w3' } = {}) => {
  const parts = encodeTallySms({ teamTag, workerId, serials });
  assert.equal(parts.length, 1);
  return parts[0];
};
const storedRecord = (idb) => idb.databases.get(DB_NAME)?.stores.get(META_STORE)?.get(SMS_SERIALS_ID);

test('a new SMS adds all its serials and reports the worker', async () => {
  const inbox = newInbox();
  const result = await inbox.applyTallySms(sms([42, 7, 300]), { teamTag: TEAM });
  assert.deepEqual(result, { ok: true, workerId: 'w3', newSerials: [7, 42, 300], duplicateSerials: [] });
  assert.deepEqual(await inbox.listAppliedSerials(), [7, 42, 300]);
});

test('the example evidence form (whitespace and line breaks) is accepted', async () => {
  const inbox = newInbox();
  const message = sms(['1a', '2f', '3c'].map((t) => parseInt(t, 36)));
  assert.match(message, new RegExp(`^PT1 ${TEAM} w3 1a\\.2f\\.3c [0-9a-f]{4}$`));
  const text = `\n ${message.replace(/ /g, '  \n')}\n`;
  const result = await inbox.applyTallySms(text, { teamTag: TEAM });
  assert.equal(result.ok, true);
  assert.equal(result.newSerials.length, 3);
});

test('applying the same SMS twice adds nothing the second time', async () => {
  const idb = createFakeIndexedDB();
  const inbox = newInbox(idb);
  const text = sms([1, 2, 3]);
  await inbox.applyTallySms(text, { teamTag: TEAM });
  const before = storedRecord(idb);
  const again = await inbox.applyTallySms(text, { teamTag: TEAM });
  assert.deepEqual(again, { ok: true, workerId: 'w3', newSerials: [], duplicateSerials: [1, 2, 3] });
  assert.deepEqual(await inbox.listAppliedSerials(), [1, 2, 3]);
  // Nothing new: the stored record is not even rewritten.
  assert.deepEqual(storedRecord(idb), before);
});

test('two overlapping SMS add each shared serial exactly once', async () => {
  const inbox = newInbox();
  const a = await inbox.applyTallySms(sms([1, 2, 3, 4], { workerId: 'w1' }), { teamTag: TEAM });
  const b = await inbox.applyTallySms(sms([3, 4, 5, 6], { workerId: 'w2' }), { teamTag: TEAM });
  assert.deepEqual(a.newSerials, [1, 2, 3, 4]);
  assert.deepEqual(b, { ok: true, workerId: 'w2', newSerials: [5, 6], duplicateSerials: [3, 4] });
  assert.deepEqual(await inbox.listAppliedSerials(), [1, 2, 3, 4, 5, 6]);
});

test('concurrent overlapping SMS never double count', async () => {
  const inbox = newInbox();
  const results = await Promise.all([
    inbox.applyTallySms(sms([1, 2, 3]), { teamTag: TEAM }),
    inbox.applyTallySms(sms([2, 3, 4]), { teamTag: TEAM }),
    inbox.applyTallySms(sms([1, 2, 3]), { teamTag: TEAM }),
  ]);
  const added = results.flatMap((r) => r.newSerials).sort((x, y) => x - y);
  assert.deepEqual(added, [1, 2, 3, 4]);
  assert.deepEqual(await inbox.listAppliedSerials(), [1, 2, 3, 4]);
});

test('a split tally applied in any order and resent counts each serial once', async () => {
  const serials = Array.from({ length: 120 }, (_, i) => 1000 + i * 7);
  const parts = encodeTallySms({ teamTag: TEAM, workerId: 'w9', serials });
  assert.ok(parts.length > 1);
  const inbox = newInbox();
  for (const part of [...parts].reverse().concat(parts)) await inbox.applyTallySms(part, { teamTag: TEAM });
  assert.deepEqual(await inbox.listAppliedSerials(), serials);
});

test('a bad checksum is rejected and stored state is unchanged', async () => {
  const idb = createFakeIndexedDB();
  const inbox = newInbox(idb);
  await inbox.applyTallySms(sms([1, 2]), { teamTag: TEAM });
  const before = storedRecord(idb);
  const good = sms([2, 3]);
  const tampered = good.slice(0, -4) + (good.endsWith('0000') ? '1111' : '0000');
  assert.deepEqual(await inbox.applyTallySms(tampered, { teamTag: TEAM }), { ok: false, reason: 'checksum' });
  assert.deepEqual(storedRecord(idb), before);
  assert.deepEqual(await inbox.listAppliedSerials(), [1, 2]);
});

test("another team's SMS is rejected and nothing is stored", async () => {
  const idb = createFakeIndexedDB();
  const inbox = newInbox(idb);
  const result = await inbox.applyTallySms(sms([1, 2], { teamTag: 'cand-99' }), { teamTag: TEAM });
  assert.deepEqual(result, { ok: false, reason: 'team' });
  assert.equal(storedRecord(idb), undefined);
  assert.deepEqual(await inbox.listAppliedSerials(), []);
});

test('a malformed message is rejected', async () => {
  const inbox = newInbox();
  assert.equal((await inbox.applyTallySms('hello', { teamTag: TEAM })).ok, false);
  assert.equal((await inbox.applyTallySms('', { teamTag: TEAM })).ok, false);
  assert.deepEqual(await inbox.listAppliedSerials(), []);
});

test('the serial set is stored encrypted and survives an app restart', async () => {
  const idb = createFakeIndexedDB();
  await newInbox(idb).applyTallySms(sms([123456, 7]), { teamTag: TEAM });
  const record = storedRecord(idb);
  assert.deepEqual(Object.keys(record).sort(), ['ct', 'iv', 'v']);
  const raw = JSON.stringify(record) + Buffer.from(record.ct).toString('latin1');
  assert.ok(!raw.includes('123456'));
  assert.deepEqual(await newInbox(idb).listAppliedSerials(), [7, 123456]);
});

test('onSerialsAdded gets each batch of new serials, only when there are some', async () => {
  const inbox = newInbox();
  const batches = [];
  const off = inbox.onSerialsAdded((serials) => batches.push(serials));
  assert.equal(inbox.applyTallySms.onSerialsAdded, inbox.onSerialsAdded);
  inbox.onSerialsAdded(() => { throw new Error('a broken subscriber'); });
  await inbox.applyTallySms(sms([1, 2]), { teamTag: TEAM });
  await inbox.applyTallySms(sms([1, 2]), { teamTag: TEAM });
  await inbox.applyTallySms(sms([2, 3]), { teamTag: TEAM });
  await inbox.applyTallySms(sms([9], { teamTag: 'cand-99' }), { teamTag: TEAM });
  assert.deepEqual(batches, [[1, 2], [3]]);
  off();
  await inbox.applyTallySms(sms([4]), { teamTag: TEAM });
  assert.deepEqual(batches, [[1, 2], [3]]);
});

test('works with no network', async () => {
  const savedFetch = globalThis.fetch;
  globalThis.fetch = undefined;
  try {
    const inbox = newInbox();
    assert.equal((await inbox.applyTallySms(sms([5]), { teamTag: TEAM })).ok, true);
  } finally {
    globalThis.fetch = savedFetch;
  }
  const code = readFileSync(new URL('../src/tally/smsInbox.js', import.meta.url), 'utf8').replace(/\/\/.*$/gm, '');
  assert.ok(!/\bfetch\b|XMLHttpRequest|WebSocket|sendBeacon|localStorage/.test(code));
});

test('the default exports work against the browser globals', async () => {
  const saved = globalThis.indexedDB;
  globalThis.indexedDB = createFakeIndexedDB();
  try {
    const batches = [];
    const off = inboxModule.onSerialsAdded((s) => batches.push(s));
    assert.equal(inboxModule.applyTallySms.onSerialsAdded, inboxModule.onSerialsAdded);
    const result = await inboxModule.applyTallySms(sms([8, 9]), { teamTag: TEAM });
    off();
    assert.deepEqual(result.newSerials, [8, 9]);
    assert.deepEqual(batches, [[8, 9]]);
    assert.deepEqual(await inboxModule.listAppliedSerials(), [8, 9]);
  } finally {
    globalThis.indexedDB = saved;
  }
});

test('the service worker precaches the inbox, the screen and every module they import', () => {
  const read = (rel) => readFileSync(new URL('../' + rel, import.meta.url), 'utf8');
  const sw = read('sw.js');
  const pending = ['src/tally/smsInbox.js', 'src/ui/smsEntryScreen.js'];
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
