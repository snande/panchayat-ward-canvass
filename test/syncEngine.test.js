// Client sync engine (issue #49), run by `npm test`. Each "device" is its own
// in-memory IndexedDB with its own injected fetch, window, document,
// navigator and interval; every request goes straight to the real
// functions/sync.js handler over an in-memory KV, so nothing leaves the
// machine.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { readFileSync } from 'node:fs';

import {
  createSyncEngine, CURSOR_ID, PUSH_URL, PULL_URL, SYNC_INTERVAL_MS, isNewer,
} from '../src/sync/syncEngine.js';
import * as syncEngineModule from '../src/sync/syncEngine.js';
import { createTeamAuth } from '../src/sync/teamAuth.js';
import { onRequest, signSyncToken } from '../functions/sync.js';
import { DB_NAME, META_STORE, OUTBOX_STORE, SYNCED_STORE } from '../src/storage/deviceDb.js';
import { createFakeIndexedDB } from './helpers/fakeIndexedDB.js';

const ORIGIN = 'https://canvass.takshavid.com';
const SECRET = 'test-sync-secret';
const PHONE = '9876543210';
const encoder = new TextEncoder();

function memoryKV() {
  const map = new Map();
  return {
    map,
    async get(key) {
      return map.has(key) ? map.get(key) : null;
    },
    async put(key, value) {
      map.set(key, String(value));
    },
    async list({ prefix = '' } = {}) {
      const names = [...map.keys()].filter((k) => k.startsWith(prefix)).sort();
      return { keys: names.map((name) => ({ name })), list_complete: true };
    },
  };
}

function server() {
  const env = { SYNC_SECRET: SECRET, SYNC_KV: memoryKV() };
  const fetch = async (url, init = {}) => onRequest({ request: new Request(new URL(url, ORIGIN), init), env });
  return { env, fetch };
}

// Team credentials as getAuth() returns them, without the PBKDF2 join.
async function teamAuth(candidateId = 'candA', deviceId = 'dev1', key) {
  const teamKey = key || await webcrypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  return { token: await signSyncToken(SECRET, candidateId, deviceId), candidateId, key: teamKey };
}

function device(srv, getAuth) {
  const idb = createFakeIndexedDB();
  const requests = [];
  const state = { offline: false, pushStatus: null, beforePushResponse: null };
  const fetch = async (url, init = {}) => {
    requests.push({ url: String(url), init });
    if (state.offline) throw new TypeError('Failed to fetch');
    if (String(url) === PUSH_URL) {
      if (state.pushStatus) return new Response('', { status: state.pushStatus });
      const response = await srv.fetch(url, init);
      if (state.beforePushResponse) await state.beforePushResponse();
      return response;
    }
    return srv.fetch(url, init);
  };
  const win = new EventTarget();
  const doc = Object.assign(new EventTarget(), { visibilityState: 'visible' });
  const nav = { onLine: true };
  const intervals = [];
  let authCalls = 0;
  const engine = createSyncEngine({
    indexedDB: idb,
    crypto: webcrypto,
    fetch,
    getAuth: async () => {
      authCalls += 1;
      return typeof getAuth === 'function' ? getAuth() : getAuth;
    },
    window: win,
    document: doc,
    navigator: nav,
    setInterval: (fn, ms) => {
      intervals.push({ fn, ms, cleared: false });
      return intervals.length;
    },
    clearInterval: (handle) => {
      intervals[handle - 1].cleared = true;
    },
  });
  const received = [];
  engine.onRemoteRecords((records) => received.push(...records));
  return {
    idb, engine, requests, state, win, doc, nav, intervals, received,
    get authCalls() {
      return authCalls;
    },
    tick: () => intervals.filter((i) => !i.cleared).forEach((i) => i.fn()),
  };
}

const stored = (idb, store) => idb.databases.get(DB_NAME)?.stores.get(store) ?? new Map();
const settle = () => new Promise((resolve) => setTimeout(resolve, 20));
const pushes = (dev) => dev.requests.filter((r) => r.url === PUSH_URL);
const fromB64 = (text) => Buffer.from(text.replace(/-/g, '+').replace(/_/g, '/'), 'base64');

test('enqueue keeps the record in the outbox, encrypted with the device key', async () => {
  const srv = server();
  const dev = device(srv, await teamAuth());
  await dev.engine.enqueue({ id: 'c:1', updatedAt: 1000, data: { phone: PHONE } });
  const outbox = stored(dev.idb, OUTBOX_STORE);
  assert.deepEqual([...outbox.keys()], ['c:1']);
  const entry = outbox.get('c:1');
  assert.deepEqual(Object.keys(entry).sort(), ['ct', 'id', 'iv', 'updatedAt']);
  assert.equal(entry.iv.length, 12);
  assert.ok(!Buffer.from(entry.ct).includes(Buffer.from(PHONE)));
  assert.equal(dev.requests.length, 0);

  await assert.rejects(dev.engine.enqueue({ id: '', updatedAt: 1, data: {} }), TypeError);
  await assert.rejects(dev.engine.enqueue({ id: 'x', updatedAt: NaN, data: {} }), TypeError);
  await assert.rejects(dev.engine.enqueue({ id: 'x', updatedAt: 1, data: undefined }), TypeError);
  await assert.rejects(dev.engine.enqueue(null), TypeError);
});

test('syncNow pushes team-encrypted records with fresh 12-byte IVs and clears them after a 2xx', async () => {
  const srv = server();
  const auth = await teamAuth();
  const dev = device(srv, auth);
  for (let i = 0; i < 3; i += 1) await dev.engine.enqueue({ id: `c:${i}`, updatedAt: 1000 + i, data: { phone: PHONE } });

  const result = await dev.engine.syncNow();
  assert.equal(result.status, 'ok');
  assert.equal(result.pushed, 3);
  assert.equal(stored(dev.idb, OUTBOX_STORE).size, 0);

  const [push] = pushes(dev);
  assert.equal(push.init.method, 'POST');
  assert.equal(push.init.headers.Authorization, `Bearer ${auth.token}`);
  assert.equal(push.init.cache, 'no-store');
  assert.ok(!push.init.body.includes(PHONE));
  const { records } = JSON.parse(push.init.body);
  assert.equal(records.length, 3);
  const ivs = new Set();
  for (const record of records) {
    assert.deepEqual(Object.keys(record).sort(), ['ciphertext', 'id', 'iv', 'updatedAt']);
    const iv = fromB64(record.iv);
    assert.equal(iv.length, 12);
    ivs.add(record.iv);
    const plain = await webcrypto.subtle.decrypt(
      { name: 'AES-GCM', iv, additionalData: encoder.encode(JSON.stringify([record.id, record.updatedAt])) },
      auth.key,
      fromB64(record.ciphertext),
    );
    assert.deepEqual(JSON.parse(new TextDecoder().decode(plain)), { phone: PHONE });
  }
  assert.equal(ivs.size, 3);

  // The pull that followed used the stored cursor and moved it on; this
  // device's own records are not handed back to it as news.
  assert.ok(dev.requests.some((r) => r.url === `${PULL_URL}?since=0`));
  assert.equal(stored(dev.idb, META_STORE).get(CURSOR_ID).cursor, 3);
  assert.deepEqual(dev.received, []);
});

test('a failed or offline push keeps every outbox record until a later sync delivers it', async () => {
  const srv = server();
  const auth = await teamAuth('candA', 'dev1');
  const dev = device(srv, auth);
  const mate = device(srv, await teamAuth('candA', 'dev2', auth.key));
  await dev.engine.enqueue({ id: 'c:1', updatedAt: 1000, data: { phone: PHONE } });

  dev.state.pushStatus = 503;
  assert.equal((await dev.engine.syncNow()).status, 'failed');
  assert.equal(stored(dev.idb, OUTBOX_STORE).size, 1);
  // No pull after a failed push.
  assert.ok(!dev.requests.some((r) => r.url.startsWith(PULL_URL)));

  dev.state.pushStatus = null;
  dev.state.offline = true;
  assert.equal((await dev.engine.syncNow()).status, 'failed');
  assert.equal(stored(dev.idb, OUTBOX_STORE).size, 1);
  assert.equal(srv.env.SYNC_KV.map.size, 0);

  dev.state.offline = false;
  assert.equal((await dev.engine.syncNow()).status, 'ok');
  assert.equal(stored(dev.idb, OUTBOX_STORE).size, 0);
  await mate.engine.syncNow();
  assert.deepEqual(mate.received, [{ id: 'c:1', updatedAt: 1000, data: { phone: PHONE } }]);
});

test('no record is lost across a simulated day offline', async () => {
  const srv = server();
  const auth = await teamAuth('candA', 'dev1');
  const dev = device(srv, auth);
  const mate = device(srv, await teamAuth('candA', 'dev2', auth.key));
  dev.state.offline = true;
  const day = 24 * 60 * 60 * 1000;
  const start = Date.UTC(2026, 9, 7);
  const expected = new Map();
  // A save every 15 minutes for a day, a sync attempt every 30 minutes
  // (alternately no signal and a server error); every 10th save edits an
  // earlier record again.
  for (let t = 0, n = 0; t < day; t += 15 * 60 * 1000, n += 1) {
    const id = n % 10 === 9 ? `voter:${n - 5}` : `voter:${n}`;
    const record = { id, updatedAt: start + t, data: { phone: PHONE, n } };
    await dev.engine.enqueue(record);
    expected.set(id, record);
    if (n % 2 === 1) {
      dev.state.pushStatus = n % 4 === 1 ? null : 500;
      dev.state.offline = n % 4 === 1;
      assert.equal((await dev.engine.syncNow()).status, 'failed');
    }
  }
  assert.equal(stored(dev.idb, OUTBOX_STORE).size, expected.size);
  assert.equal(srv.env.SYNC_KV.map.size, 0);

  dev.state.offline = false;
  dev.state.pushStatus = null;
  assert.equal((await dev.engine.syncNow()).status, 'ok');
  assert.equal(stored(dev.idb, OUTBOX_STORE).size, 0);

  await mate.engine.syncNow();
  const got = new Map(mate.received.map((r) => [r.id, r]));
  assert.equal(got.size, expected.size);
  for (const [id, record] of expected) assert.deepEqual(got.get(id), record);
});

test('a record saved again while its push is in flight stays in the outbox', async () => {
  const srv = server();
  const dev = device(srv, await teamAuth());
  await dev.engine.enqueue({ id: 'c:1', updatedAt: 1, data: { v: 1 } });
  dev.state.beforePushResponse = async () => {
    dev.state.beforePushResponse = null;
    await dev.engine.enqueue({ id: 'c:1', updatedAt: 2, data: { v: 2 } });
  };
  await dev.engine.syncNow();
  assert.equal(stored(dev.idb, OUTBOX_STORE).get('c:1').updatedAt, 2);
  await dev.engine.syncNow();
  assert.equal(stored(dev.idb, OUTBOX_STORE).size, 0);
  assert.equal(pushes(dev).length, 2);
});

test('with no team credentials the engine sends no request', async () => {
  const srv = server();
  const dev = device(srv, null);
  await dev.engine.enqueue({ id: 'c:1', updatedAt: 1, data: { phone: PHONE } });
  assert.equal((await dev.engine.syncNow()).status, 'no-auth');
  dev.engine.start();
  dev.win.dispatchEvent(new Event('online'));
  dev.doc.dispatchEvent(new Event('visibilitychange'));
  dev.tick();
  await settle();
  assert.equal(dev.requests.length, 0);
  assert.equal(stored(dev.idb, OUTBOX_STORE).size, 1);
  dev.engine.stop();
});

test('syncNow runs at start, on online, when the page becomes visible and every 30 s while online', async () => {
  const srv = server();
  const dev = device(srv, null);
  dev.engine.start();
  await settle();
  assert.equal(dev.authCalls, 1, 'at start');
  dev.engine.start();
  await settle();
  assert.equal(dev.authCalls, 1, 'start twice is one engine');
  assert.equal(dev.intervals.length, 1);
  assert.equal(dev.intervals[0].ms, SYNC_INTERVAL_MS);
  assert.equal(SYNC_INTERVAL_MS, 30000);

  dev.win.dispatchEvent(new Event('online'));
  await settle();
  assert.equal(dev.authCalls, 2, 'on online');

  dev.doc.visibilityState = 'hidden';
  dev.doc.dispatchEvent(new Event('visibilitychange'));
  await settle();
  assert.equal(dev.authCalls, 2, 'not when hidden');
  dev.doc.visibilityState = 'visible';
  dev.doc.dispatchEvent(new Event('visibilitychange'));
  await settle();
  assert.equal(dev.authCalls, 3, 'when visible');

  dev.tick();
  await settle();
  assert.equal(dev.authCalls, 4, 'interval while online');
  dev.nav.onLine = false;
  dev.tick();
  await settle();
  assert.equal(dev.authCalls, 4, 'interval skipped while offline');

  dev.engine.stop();
  assert.equal(dev.intervals[0].cleared, true);
  dev.nav.onLine = true;
  dev.win.dispatchEvent(new Event('online'));
  dev.doc.dispatchEvent(new Event('visibilitychange'));
  await settle();
  assert.equal(dev.authCalls, 4, 'nothing after stop');
});

test('pulled records merge by id keeping the higher updatedAt; pulling twice gives one record', async () => {
  const srv = server();
  const auth = await teamAuth('candA', 'dev1');
  const writer = device(srv, auth);
  const reader = device(srv, await teamAuth('candA', 'dev2', auth.key));

  await writer.engine.enqueue({ id: 'v:1', updatedAt: '2026-10-07T10:00:00Z', data: { phone: '1' } });
  await writer.engine.syncNow();
  await writer.engine.enqueue({ id: 'v:1', updatedAt: '2026-10-07T11:00:00Z', data: { phone: '2' } });
  await writer.engine.syncNow();
  await reader.engine.syncNow();
  assert.deepEqual(reader.received, [{ id: 'v:1', updatedAt: '2026-10-07T11:00:00Z', data: { phone: '2' } }]);

  // Pull everything again from the start: nothing new, one local record.
  stored(reader.idb, META_STORE).delete(CURSOR_ID);
  const again = await reader.engine.syncNow();
  assert.equal(again.received, 0);
  assert.equal(reader.received.length, 1);
  assert.deepEqual([...stored(reader.idb, SYNCED_STORE).entries()], [['v:1', { updatedAt: '2026-10-07T11:00:00Z' }]]);

  // An older edit arriving late loses; a newer one wins.
  const late = device(srv, await teamAuth('candA', 'dev3', auth.key));
  await late.engine.enqueue({ id: 'v:1', updatedAt: '2026-10-07T09:00:00Z', data: { phone: 'old' } });
  await late.engine.syncNow();
  await reader.engine.syncNow();
  assert.equal(reader.received.length, 1);
  await late.engine.enqueue({ id: 'v:1', updatedAt: '2026-10-07T12:00:00Z', data: { phone: '3' } });
  await late.engine.syncNow();
  await reader.engine.syncNow();
  assert.deepEqual(reader.received.map((r) => r.data.phone), ['2', '3']);
  assert.equal(stored(reader.idb, SYNCED_STORE).size, 1);
});

test('a pulled record that does not decrypt with the team key is discarded', async () => {
  const srv = server();
  const auth = await teamAuth('candA', 'dev1');
  const reader = device(srv, await teamAuth('candA', 'dev2', auth.key));
  const stranger = await webcrypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);

  async function seal(key, id, updatedAt, data, aadUpdatedAt = updatedAt) {
    const iv = webcrypto.getRandomValues(new Uint8Array(12));
    const ct = await webcrypto.subtle.encrypt(
      { name: 'AES-GCM', iv, additionalData: encoder.encode(JSON.stringify([id, aadUpdatedAt])) },
      key,
      encoder.encode(JSON.stringify(data)),
    );
    const b64 = (bytes) => Buffer.from(bytes).toString('base64url');
    return { id, updatedAt, ciphertext: b64(new Uint8Array(ct)), iv: b64(iv) };
  }
  const records = [
    await seal(stranger, 'v:foreign', 1, { phone: PHONE }),
    // Re-labelled by the server to win a merge: the timestamp is bound in.
    await seal(auth.key, 'v:moved', 99, { phone: PHONE }, 1),
    { id: 'v:garbage', updatedAt: 1, ciphertext: 'AAAA', iv: 'AAAAAAAAAAAAAAAA' },
    await seal(auth.key, 'v:good', 1, { phone: PHONE }),
  ];
  const response = await srv.fetch(PUSH_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${auth.token}` },
    body: JSON.stringify({ records }),
  });
  assert.equal(response.status, 200);

  const result = await reader.engine.syncNow();
  assert.equal(result.status, 'ok');
  assert.deepEqual(reader.received, [{ id: 'v:good', updatedAt: 1, data: { phone: PHONE } }]);
  assert.deepEqual([...stored(reader.idb, SYNCED_STORE).keys()], ['v:good']);
  // The cursor moved past the discarded records, so they are not retried.
  assert.equal(stored(reader.idb, META_STORE).get(CURSOR_ID).cursor, 4);
});

test('L3: a record enqueued offline on device 1 reaches device 2 after reconnect and one pull cycle', async () => {
  const srv = server();
  const passphrase = 'हमारी टीम 2026';
  const join = async () => {
    const idb = createFakeIndexedDB();
    const auth = createTeamAuth({ indexedDB: idb, crypto: webcrypto, fetch: srv.fetch });
    await auth.joinTeam('candA', passphrase);
    return auth;
  };
  const [auth1, auth2] = [await join(), await join()];
  const dev1 = device(srv, () => auth1.getAuth());
  const dev2 = device(srv, () => auth2.getAuth());
  dev1.engine.start();
  dev2.engine.start();

  // Device 1 has no signal: the save waits in its outbox.
  dev1.nav.onLine = false;
  dev1.state.offline = true;
  const record = { id: 'voter:42', updatedAt: Date.now(), data: { phone: PHONE, consentAt: 1 } };
  await dev1.engine.enqueue(record);
  dev1.tick();
  await settle();
  assert.equal(stored(dev1.idb, OUTBOX_STORE).size, 1);

  // Signal returns: the online event pushes straight away.
  dev1.nav.onLine = true;
  dev1.state.offline = false;
  dev1.win.dispatchEvent(new Event('online'));
  await dev1.engine.syncNow();
  assert.equal(stored(dev1.idb, OUTBOX_STORE).size, 0);

  // Device 2's next 30 s tick pulls it.
  assert.deepEqual(dev2.received, []);
  dev2.tick();
  await dev2.engine.syncNow();
  assert.deepEqual(dev2.received, [record]);
  dev1.engine.stop();
  dev2.engine.stop();
});

test('isNewer orders numbers, ISO strings and a mix of both', () => {
  assert.equal(isNewer(2, 1), true);
  assert.equal(isNewer(1, 1), false);
  assert.equal(isNewer('2026-10-07T11:00:00Z', '2026-10-07T10:00:00Z'), true);
  assert.equal(isNewer(Date.parse('2026-10-07T11:00:00Z'), '2026-10-07T10:00:00Z'), true);
  assert.equal(isNewer('2026-10-07T09:00:00Z', Date.parse('2026-10-07T10:00:00Z')), false);
});

test('the module exports enqueue, syncNow and onRemoteRecords', () => {
  for (const name of ['enqueue', 'syncNow', 'onRemoteRecords', 'startSync']) {
    assert.equal(typeof syncEngineModule[name], 'function', name);
  }
});

test('the service worker precaches the sync engine and leaves /sync/* to the network', () => {
  const sw = readFileSync(new URL('../sw.js', import.meta.url), 'utf8');
  assert.ok(sw.includes('"src/sync/syncEngine.js"'));
  assert.match(sw, /url\.pathname\.indexOf\("\/sync\/"\) === 0\)\s*\{\s*return;/);
});
