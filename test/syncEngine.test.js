// Client sync engine (issue #49), run by `npm test`. Each "device" is its own
// in-memory IndexedDB with its own injected fetch, window, document,
// navigator and interval; every request goes straight to the real
// functions/sync.js handler over an in-memory D1, so nothing leaves the
// machine.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { readFileSync } from 'node:fs';

import {
  createSyncEngine, CURSOR_ID, PUSH_URL, PULL_URL, PUSH_BATCH_SIZE, SYNC_INTERVAL_MS, isNewer,
} from '../src/sync/syncEngine.js';
import * as syncEngineModule from '../src/sync/syncEngine.js';
import { createTeamAuth } from '../src/sync/teamAuth.js';
import { onRequest, signSyncToken } from '../functions/sync.js';
import { DB_NAME, META_STORE, OUTBOX_STORE, SYNCED_STORE } from '../src/storage/deviceDb.js';
import { createFakeIndexedDB } from './helpers/fakeIndexedDB.js';
import { createSyncD1 } from './helpers/memoryD1.js';

const ORIGIN = 'https://canvass.takshavid.com';
const SECRET = 'test-sync-secret';
const PHONE = '9876543210';
const encoder = new TextEncoder();

async function server() {
  const env = { SYNC_SECRET: SECRET, SYNC_DB: await createSyncD1() };
  const fetch = async (url, init = {}) => onRequest({ request: new Request(new URL(url, ORIGIN), init), env });
  return { env, fetch };
}

const storedRows = (srv) =>
  ['records', 'counters', 'marks', 'verifiers']
    .reduce((n, t) => n + srv.env.SYNC_DB.sqlite.query(`SELECT COUNT(*) AS n FROM ${t}`, [])[0].n, 0);
const counter = (srv, candidateId) =>
  srv.env.SYNC_DB.sqlite.query('SELECT seq FROM counters WHERE candidate_id = ?', [candidateId])[0]?.seq;

// Team credentials as getAuth() returns them, without the PBKDF2 join.
async function teamAuth(candidateId = 'candA', deviceId = 'dev1', key) {
  const teamKey = key || await webcrypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  return { token: await signSyncToken(SECRET, candidateId, deviceId), candidateId, key: teamKey };
}

// state.offline makes every request throw like a phone with no signal;
// state.pushStatus(n) may answer the n-th push (1-based) with that status
// instead of reaching the server.
function device(srv, getAuth) {
  const idb = createFakeIndexedDB();
  const requests = [];
  const state = { offline: false, pushStatus: () => null, beforePushResponse: null, pushCalls: 0, pushedOk: 0, pullsOk: 0 };
  const fetch = async (url, init = {}) => {
    requests.push({ url: String(url), init });
    if (state.offline) throw new TypeError('Failed to fetch');
    if (String(url) === PUSH_URL) {
      state.pushCalls += 1;
      const status = state.pushStatus(state.pushCalls);
      if (status) return new Response('', { status });
      const response = await srv.fetch(url, init);
      if (state.beforePushResponse) await state.beforePushResponse();
      if (response.ok) state.pushedOk += 1;
      return response;
    }
    const response = await srv.fetch(url, init);
    if (String(url).startsWith(PULL_URL) && response.ok) state.pullsOk += 1;
    return response;
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
const pulls = (dev) => dev.requests.filter((r) => r.url.startsWith(`${PULL_URL}?`));
const fromB64 = (text) => Buffer.from(text.replace(/-/g, '+').replace(/_/g, '/'), 'base64');

async function waitFor(cond, what, ms = 5000) {
  const until = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > until) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

test('enqueue keeps the record in the outbox, encrypted with the device key', async () => {
  const srv = await server();
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
  await assert.rejects(dev.engine.enqueue({ id: 'x', updatedAt: 'yesterday', data: {} }), TypeError);
  await assert.rejects(dev.engine.enqueue({ id: 'x', updatedAt: 1, data: undefined }), TypeError);
  await assert.rejects(dev.engine.enqueue(null), TypeError);
});

test('syncNow pushes team-encrypted records with fresh 12-byte IVs and clears them after a 2xx', async () => {
  const srv = await server();
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
  const srv = await server();
  const auth = await teamAuth('candA', 'dev1');
  const dev = device(srv, auth);
  const mate = device(srv, await teamAuth('candA', 'dev2', auth.key));
  await dev.engine.enqueue({ id: 'c:1', updatedAt: 1000, data: { phone: PHONE } });

  dev.state.pushStatus = () => 503;
  assert.equal((await dev.engine.syncNow()).status, 'failed');
  assert.equal(stored(dev.idb, OUTBOX_STORE).size, 1);

  dev.state.pushStatus = () => null;
  dev.state.offline = true;
  assert.equal((await dev.engine.syncNow()).status, 'failed');
  assert.equal(stored(dev.idb, OUTBOX_STORE).size, 1);
  assert.equal(storedRows(srv), 0);

  dev.state.offline = false;
  assert.equal((await dev.engine.syncNow()).status, 'ok');
  assert.equal(stored(dev.idb, OUTBOX_STORE).size, 0);
  await mate.engine.syncNow();
  assert.deepEqual(mate.received, [{ id: 'c:1', updatedAt: 1000, data: { phone: PHONE } }]);
});

test('a push the server keeps refusing does not stop the pull', async () => {
  const srv = await server();
  const auth = await teamAuth('candA', 'dev1');
  const dev = device(srv, auth);
  const mate = device(srv, await teamAuth('candA', 'dev2', auth.key));
  await mate.engine.enqueue({ id: 'v:mate', updatedAt: 5, data: { phone: PHONE } });
  await mate.engine.syncNow();

  await dev.engine.enqueue({ id: 'v:mine', updatedAt: 6, data: { phone: PHONE } });
  dev.state.pushStatus = () => 400;
  for (let i = 0; i < 2; i += 1) {
    const result = await dev.engine.syncNow();
    assert.equal(result.status, 'failed');
    assert.match(String(result.error), /HTTP 400/);
  }
  assert.deepEqual([...stored(dev.idb, OUTBOX_STORE).keys()], ['v:mine']);
  assert.deepEqual(dev.received, [{ id: 'v:mate', updatedAt: 5, data: { phone: PHONE } }]);
});

test('more than one push batch: every batch is pushed and cleared, and a failed batch keeps only its records', async () => {
  const srv = await server();
  const auth = await teamAuth('candA', 'dev1');
  const dev = device(srv, auth);
  const total = 2 * PUSH_BATCH_SIZE + 1;
  for (let i = 0; i < total; i += 1) await dev.engine.enqueue({ id: `v:${i}`, updatedAt: i, data: { n: i } });

  // The second batch fails: the first stays delivered, the second and third
  // stay in the outbox.
  dev.state.pushStatus = (n) => (n === 2 ? 503 : null);
  const first = await dev.engine.syncNow();
  assert.equal(first.status, 'failed');
  assert.equal(first.pushed, PUSH_BATCH_SIZE);
  assert.equal(pushes(dev).length, 2);
  const deliveredIds = JSON.parse(pushes(dev)[0].init.body).records.map((r) => r.id);
  assert.equal(deliveredIds.length, PUSH_BATCH_SIZE);
  const left = [...stored(dev.idb, OUTBOX_STORE).keys()].sort();
  const all = Array.from({ length: total }, (_, i) => `v:${i}`);
  assert.deepEqual(left, all.filter((id) => !deliveredIds.includes(id)).sort());
  assert.equal(counter(srv, 'candA'), PUSH_BATCH_SIZE);

  const second = await dev.engine.syncNow();
  assert.equal(second.status, 'ok');
  assert.equal(second.pushed, PUSH_BATCH_SIZE + 1);
  // Two more pushes: a full batch and the one record left over.
  const later = pushes(dev).slice(2).map((p) => JSON.parse(p.init.body).records.length);
  assert.deepEqual(later, [PUSH_BATCH_SIZE, 1]);
  assert.equal(stored(dev.idb, OUTBOX_STORE).size, 0);
  assert.equal(counter(srv, 'candA'), total);
});

test('no record is lost across a simulated day offline', async () => {
  const srv = await server();
  const auth = await teamAuth('candA', 'dev1');
  const dev = device(srv, auth);
  const mate = device(srv, await teamAuth('candA', 'dev2', auth.key));
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
      dev.state.offline = n % 4 === 1;
      dev.state.pushStatus = () => (n % 4 === 1 ? null : 500);
      assert.equal((await dev.engine.syncNow()).status, 'failed');
    }
  }
  assert.equal(stored(dev.idb, OUTBOX_STORE).size, expected.size);
  assert.equal(storedRows(srv), 0);

  dev.state.offline = false;
  dev.state.pushStatus = () => null;
  assert.equal((await dev.engine.syncNow()).status, 'ok');
  assert.equal(stored(dev.idb, OUTBOX_STORE).size, 0);

  await mate.engine.syncNow();
  const got = new Map(mate.received.map((r) => [r.id, r]));
  assert.equal(got.size, expected.size);
  for (const [id, record] of expected) assert.deepEqual(got.get(id), record);
});

test('a record saved again while its push is in flight stays in the outbox', async () => {
  const srv = await server();
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
  const srv = await server();
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

test('syncNow runs at start, on online, when the page becomes visible and every 60 s while online and visible', async () => {
  const srv = await server();
  const dev = device(srv, null);
  dev.engine.start();
  await settle();
  assert.equal(dev.authCalls, 1, 'at start');
  dev.engine.start();
  await settle();
  assert.equal(dev.authCalls, 1, 'start twice is one engine');
  assert.equal(dev.intervals.length, 1);
  assert.equal(dev.intervals[0].ms, SYNC_INTERVAL_MS);
  assert.equal(SYNC_INTERVAL_MS, 60000, 'a new interval changes the Workers budget: rerun scripts/sync-poll-sim.mjs');

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
  dev.nav.onLine = true;
  dev.doc.visibilityState = 'hidden';
  dev.tick();
  await settle();
  assert.equal(dev.authCalls, 4, 'interval skipped while hidden');
  dev.doc.visibilityState = 'visible';
  dev.tick();
  await settle();
  assert.equal(dev.authCalls, 5, 'interval again once visible');

  dev.engine.stop();
  assert.equal(dev.intervals[0].cleared, true);
  dev.nav.onLine = true;
  dev.win.dispatchEvent(new Event('online'));
  dev.doc.dispatchEvent(new Event('visibilitychange'));
  await settle();
  assert.equal(dev.authCalls, 5, 'nothing after stop');
});

test('an interval tick pulls once while visible and not at all while hidden', async () => {
  const srv = await server();
  const dev = device(srv, await teamAuth());
  dev.engine.start();
  await waitFor(() => pulls(dev).length === 1, 'startup pull');
  await settle();

  // Set visibilityState without the event: only the tick may sync here.
  dev.doc.visibilityState = 'hidden';
  dev.tick();
  await settle();
  assert.equal(pulls(dev).length, 1, 'no pull on a hidden tick');

  dev.doc.visibilityState = 'visible';
  for (let i = 2; i <= 3; i += 1) {
    dev.tick();
    await waitFor(() => pulls(dev).length === i, `pull on visible tick ${i - 1}`);
    await settle();
    assert.equal(pulls(dev).length, i, 'exactly one pull per visible tick');
  }
  dev.engine.stop();
});

test('a completed push is followed at once by a pull, without an interval tick', async () => {
  const srv = await server();
  const dev = device(srv, await teamAuth());
  dev.engine.start();
  await waitFor(() => pulls(dev).length === 1, 'startup pull');
  await settle();
  const before = dev.requests.length;

  await dev.engine.enqueue({ id: 'c:1', updatedAt: 1000, data: { phone: PHONE } });
  const result = await dev.engine.syncNow();
  assert.equal(result.status, 'ok');
  assert.equal(result.pushed, 1);
  assert.equal(dev.state.pushedOk, 1);
  const urls = dev.requests.slice(before).map((r) => r.url);
  assert.equal(urls.length, 2);
  assert.equal(urls[0], PUSH_URL);
  assert.ok(urls[1].startsWith(`${PULL_URL}?`), urls[1]);
  dev.engine.stop();
});

test('pulled records merge by id keeping the higher updatedAt; pulling twice gives one record', async () => {
  const srv = await server();
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

test('a pulled record loses to a newer edit still waiting in the outbox and wins over an older one', async () => {
  const srv = await server();
  const auth = await teamAuth('candA', 'dev1');
  const dev = device(srv, auth);
  const mate = device(srv, await teamAuth('candA', 'dev2', auth.key));

  // This device has unsent edits (its pushes fail, so they stay pending).
  await dev.engine.enqueue({ id: 'v:local-newer', updatedAt: 2000, data: { phone: 'mine' } });
  await dev.engine.enqueue({ id: 'v:remote-newer', updatedAt: 1000, data: { phone: 'mine' } });
  dev.state.pushStatus = () => 503;

  await mate.engine.enqueue({ id: 'v:local-newer', updatedAt: 1000, data: { phone: 'theirs' } });
  await mate.engine.enqueue({ id: 'v:remote-newer', updatedAt: 3000, data: { phone: 'theirs' } });
  await mate.engine.syncNow();

  assert.equal((await dev.engine.syncNow()).status, 'failed');
  assert.deepEqual(dev.received, [{ id: 'v:remote-newer', updatedAt: 3000, data: { phone: 'theirs' } }]);
  assert.equal(stored(dev.idb, OUTBOX_STORE).get('v:local-newer').updatedAt, 2000);
});

test('the pull cursor starts again from 0 after the device joins another candidate', async () => {
  const srv = await server();
  const auth = await teamAuth('candA', 'dev1');
  const dev = device(srv, auth);
  const mate = device(srv, await teamAuth('candA', 'dev2', auth.key));
  await mate.engine.enqueue({ id: 'v:1', updatedAt: 1, data: { phone: PHONE } });
  await mate.engine.syncNow();

  // A cursor left by a previous team, far past this team's records.
  await dev.engine.enqueue({ id: 'v:open', updatedAt: 1, data: {} });
  stored(dev.idb, OUTBOX_STORE).clear();
  stored(dev.idb, META_STORE).set(CURSOR_ID, { v: 1, candidateId: 'candB', cursor: 99 });

  await dev.engine.syncNow();
  assert.deepEqual(pulls(dev).map((r) => r.url), [`${PULL_URL}?since=0`]);
  assert.deepEqual(dev.received.map((r) => r.id), ['v:1']);
  assert.deepEqual(stored(dev.idb, META_STORE).get(CURSOR_ID), { v: 1, candidateId: 'candA', cursor: 1 });

  // The same team's cursor is used as stored.
  await dev.engine.syncNow();
  assert.equal(pulls(dev).at(-1).url, `${PULL_URL}?since=1`);
});

test('a pulled record that does not decrypt with the team key is discarded', async () => {
  const srv = await server();
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
    // Not a date: it could not be ordered against other edits.
    await seal(auth.key, 'v:undated', 'soon', { phone: PHONE }),
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
  assert.equal(stored(reader.idb, META_STORE).get(CURSOR_ID).cursor, 5);
});

test('L3: a record enqueued offline on device 1 reaches device 2 after reconnect and one pull cycle', async () => {
  const srv = await server();
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

  // Device 1 has no signal from the start. Only the engine's own triggers
  // run syncs below: the test never calls syncNow().
  dev1.nav.onLine = false;
  dev1.state.offline = true;
  dev1.engine.start();
  dev2.engine.start();
  await waitFor(() => pulls(dev1).length >= 1, 'device 1 startup sync');
  await waitFor(() => stored(dev2.idb, META_STORE).has(CURSOR_ID), 'device 2 startup pull');
  await settle();

  const record = { id: 'voter:42', updatedAt: Date.now(), data: { phone: PHONE, consentAt: 1 } };
  await dev1.engine.enqueue(record);
  const offlineRequests = dev1.requests.length;
  dev1.tick();
  await settle();
  assert.equal(dev1.requests.length, offlineRequests, 'no interval sync while navigator.onLine is false');
  assert.equal(stored(dev1.idb, OUTBOX_STORE).size, 1);
  assert.equal(dev1.state.pushedOk, 0);

  // Signal returns: the online event alone pushes the outbox.
  dev1.nav.onLine = true;
  dev1.state.offline = false;
  dev1.win.dispatchEvent(new Event('online'));
  await waitFor(() => stored(dev1.idb, OUTBOX_STORE).size === 0, 'device 1 push after online');
  assert.equal(dev1.state.pushedOk, 1);

  // Device 2's next 60 s tick alone pulls it.
  assert.deepEqual(dev2.received, []);
  const pullsBefore = dev2.state.pullsOk;
  dev2.tick();
  await waitFor(() => dev2.received.length > 0, 'device 2 pull on the interval tick');
  assert.equal(dev2.state.pullsOk, pullsBefore + 1);
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
