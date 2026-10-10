// Seen-voting marks (issue #78), run by `npm test`. Each "device" is its own
// in-memory IndexedDB with its own mark store, team join and sync engine;
// every request goes to the real functions/sync.js handler over an in-memory
// KV, so nothing leaves the machine.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';

import * as seenVoting from '../src/tally/seenVotingStore.js';
import { createSeenVotingStore, markRecordId } from '../src/tally/seenVotingStore.js';
import { createSyncEngine } from '../src/sync/syncEngine.js';
import { createTeamAuth } from '../src/sync/teamAuth.js';
import { onRequest } from '../functions/sync.js';
import { DB_NAME, KEYS_STORE, MARKS_STORE, OUTBOX_STORE } from '../src/storage/deviceDb.js';
import { DEVICE_KEY_ID } from '../src/crypto/deviceKey.js';
import { createFakeIndexedDB } from './helpers/fakeIndexedDB.js';
import { createSyncD1 } from './helpers/memoryD1.js';

const ORIGIN = 'https://canvass.takshavid.com';
const WARD = '17/125/6313/1';

async function server() {
  const env = { SYNC_SECRET: 'test-sync-secret', SYNC_DB: await createSyncD1() };
  const handle = (url, init = {}) => onRequest({ request: new Request(new URL(url, ORIGIN), init), env });
  // The team's stored mark entries (not the index), for one candidate.
  const markEntries = (candidateId) =>
    env.SYNC_DB.sqlite.query(
      "SELECT id, updated_at AS updatedAt, ciphertext, iv, seq, device_id AS deviceId FROM records WHERE candidate_id = ? AND id LIKE 'mark:%' ORDER BY seq",
      [candidateId],
    );
  return { env, handle, markEntries };
}

function clock(start = Date.parse('2026-10-07T10:00:00.000Z')) {
  let t = start;
  return () => new Date((t += 1000)).toISOString();
}

// state.offline makes every request throw like a phone in airplane mode.
// Passing an existing idb is the same device after a reload.
function device(srv, { idb = createFakeIndexedDB(), now = clock(), offline = false } = {}) {
  const state = { offline, requests: 0 };
  const fetch = async (url, init = {}) => {
    state.requests += 1;
    if (state.offline) throw new TypeError('Failed to fetch');
    return srv.handle(url, init);
  };
  const auth = createTeamAuth({ indexedDB: idb, crypto: webcrypto, fetch });
  const engine = createSyncEngine({
    indexedDB: idb, crypto: webcrypto, fetch, getAuth: auth.getAuth,
    window: null, document: null, navigator: { onLine: true },
    setInterval: () => 0, clearInterval: () => {},
  });
  const marks = createSeenVotingStore({ indexedDB: idb, crypto: webcrypto, engine, now, log: () => {} });
  marks.listen();
  return { idb, state, auth, engine, marks };
}

const stored = (idb, name) => idb.databases.get(DB_NAME)?.stores.get(name) ?? new Map();

test('the module exports markSeen, listMarks and teamCount', () => {
  for (const name of ['markSeen', 'listMarks', 'teamCount']) assert.equal(typeof seenVoting[name], 'function', name);
});

test('marks survive a reload while offline, and a second mark of a voter is not stored', async () => {
  const srv = await server();
  const phone = device(srv, { offline: true });
  const first = await phone.marks.markSeen(WARD, 42, 'worker-1');
  const again = await phone.marks.markSeen(WARD, '42', 'worker-2');
  const other = await phone.marks.markSeen(WARD, 7, 'worker-1');
  assert.deepEqual(again, first);
  assert.equal(stored(phone.idb, MARKS_STORE).size, 2);
  assert.equal(stored(phone.idb, OUTBOX_STORE).size, 2);

  const reloaded = device(srv, { idb: phone.idb, offline: true });
  assert.equal(await reloaded.marks.teamCount(), 2);
  assert.deepEqual(await reloaded.marks.listMarks(), [other, first]);
  assert.equal(phone.state.requests + reloaded.state.requests, 0);
});

test('a stored mark is encrypted with the device key and holds only ward, serial, worker and time', async () => {
  const srv = await server();
  const phone = device(srv, { offline: true });
  const mark = await phone.marks.markSeen(WARD, 42, 'worker-1');
  assert.deepEqual(Object.keys(mark).sort(), ['markedAt', 'serial', 'wardId', 'workerId']);

  const raw = stored(phone.idb, MARKS_STORE).get(`${WARD}:42`);
  assert.deepEqual(Object.keys(raw).sort(), ['ct', 'iv', 'serial', 'wardId']);
  assert.ok(!Buffer.from(raw.ct).toString('latin1').includes('worker-1'));

  const key = stored(phone.idb, KEYS_STORE).get(DEVICE_KEY_ID);
  const plain = await webcrypto.subtle.decrypt(
    { name: 'AES-GCM', iv: raw.iv, additionalData: new TextEncoder().encode(`${WARD}:42`) }, key, raw.ct,
  );
  assert.deepEqual(JSON.parse(new TextDecoder().decode(plain)), { workerId: 'worker-1', markedAt: mark.markedAt });

  // The outbox copy of the mark is sealed with the same device key.
  const queued = stored(phone.idb, OUTBOX_STORE).get(markRecordId(WARD, 42));
  assert.ok(!Buffer.from(queued.ct).toString('latin1').includes('worker-1'));
});

test('marks made offline are pushed once connectivity returns', async () => {
  const srv = await server();
  const phone = device(srv);
  await phone.auth.joinTeam('candA', 'हमारी टीम');
  phone.state.offline = true;
  await phone.marks.markSeen(WARD, 42, 'worker-1');
  assert.equal((await phone.engine.syncNow()).status, 'failed');
  assert.equal(srv.markEntries('candA').length, 0);

  phone.state.offline = false;
  const result = await phone.engine.syncNow();
  assert.equal(result.status, 'ok');
  assert.equal(result.pushed, 1);
  assert.equal(srv.markEntries('candA').length, 1);
  assert.equal(stored(phone.idb, OUTBOX_STORE).size, 0);
});

// Two devices, already sharing one marked voter, each mark voter 42 offline
// and then sync in the given order. Returns the server's entries and each
// device's teamCount() before and after.
async function concurrentMarks(order) {
  const srv = await server();
  const a = device(srv);
  const b = device(srv);
  await a.auth.joinTeam('candA', 'हमारी टीम');
  await b.auth.joinTeam('candA', 'हमारी टीम');
  await a.marks.markSeen(WARD, 1, 'worker-a');
  await a.engine.syncNow();
  await b.engine.syncNow();
  const before = [await a.marks.teamCount(), await b.marks.teamCount()];

  a.state.offline = true;
  b.state.offline = true;
  await a.marks.markSeen(WARD, 42, 'worker-a');
  await b.marks.markSeen(WARD, 42, 'worker-b');
  a.state.offline = false;
  b.state.offline = false;

  const devices = { a, b };
  for (const name of order) assert.equal((await devices[name].engine.syncNow()).status, 'ok');
  // Both pull after both pushed.
  for (const name of order) await devices[name].engine.syncNow();

  return {
    srv,
    a,
    b,
    before,
    after: [await a.marks.teamCount(), await b.marks.teamCount()],
  };
}

test('two devices marking the same voter offline converge to one server entry and +1', async () => {
  const { srv, before, after } = await concurrentMarks(['a', 'b']);
  assert.deepEqual(before, [1, 1]);
  assert.deepEqual(after, [2, 2]);
  const voter42 = srv.markEntries('candA').filter((r) => r.id === markRecordId(WARD, 42));
  assert.equal(voter42.length, 1);
  assert.equal(srv.markEntries('candA').length, 2);
});

test('the order of the two pushes does not change the team count', async () => {
  const ab = await concurrentMarks(['a', 'b']);
  const ba = await concurrentMarks(['b', 'a']);
  assert.deepEqual(ab.after, ba.after);
  assert.equal(ab.srv.markEntries('candA').length, ba.srv.markEntries('candA').length);
});

test('re-pushing an already-synced mark (a retry after a dropped response) does not change the count', async () => {
  const srv = await server();
  const a = device(srv);
  const b = device(srv);
  await a.auth.joinTeam('candA', 'हमारी टीम');
  await b.auth.joinTeam('candA', 'हमारी टीम');

  // The push reaches the server but its response is lost, so the mark stays
  // in the outbox and is pushed again on the next sync.
  let dropped = false;
  const realHandle = srv.handle;
  srv.handle = async (url, init) => {
    const response = await realHandle(url, init);
    if (!dropped && String(url).includes('/sync/push')) {
      dropped = true;
      throw new TypeError('Failed to fetch');
    }
    return response;
  };
  await a.marks.markSeen(WARD, 42, 'worker-a');
  await a.engine.syncNow();
  assert.equal(stored(a.idb, OUTBOX_STORE).size, 1);
  assert.equal(srv.markEntries('candA').length, 1);

  assert.equal((await a.engine.syncNow()).status, 'ok');
  assert.equal(stored(a.idb, OUTBOX_STORE).size, 0);
  assert.equal(srv.markEntries('candA').length, 1);

  await b.engine.syncNow();
  assert.equal(await a.marks.teamCount(), 1);
  assert.equal(await b.marks.teamCount(), 1);
});

test("one team never reads or counts another team's marks", async () => {
  const srv = await server();
  const ours = device(srv);
  const teammate = device(srv);
  const rival = device(srv);
  await ours.auth.joinTeam('candA', 'हमारी टीम');
  await teammate.auth.joinTeam('candA', 'हमारी टीम');
  await rival.auth.joinTeam('candB', 'दूसरी टीम');

  await ours.marks.markSeen(WARD, 42, 'worker-a');
  await rival.marks.markSeen(WARD, 42, 'worker-r');
  await rival.marks.markSeen(WARD, 43, 'worker-r');
  for (const d of [ours, rival, teammate, ours, rival]) await d.engine.syncNow();

  assert.equal(await ours.marks.teamCount(), 1);
  assert.equal(await teammate.marks.teamCount(), 1);
  assert.equal(await rival.marks.teamCount(), 2);
  // The rival's mark of the same voter made its own entry under its own team.
  assert.equal(srv.markEntries('candA').length, 1);
  assert.equal(srv.markEntries('candB').length, 2);
  assert.equal(srv.env.SYNC_DB.sqlite.query('SELECT 1 FROM marks WHERE candidate_id = ? AND id = ?', ['candB', markRecordId(WARD, 42)]).length, 1);
  assert.deepEqual((await teammate.marks.listMarks()).map((m) => m.workerId), ['worker-a']);
});

test('pulled records that are not well-formed marks are ignored', async () => {
  const srv = await server();
  const phone = device(srv, { offline: true });
  const added = await phone.marks.applyRemote([
    { id: 'contact:w:1', updatedAt: 1, data: { wardId: 'w', serial: 1 } },
    { id: markRecordId(WARD, 2), updatedAt: 1, data: { wardId: WARD, serial: 3, workerId: 'w', markedAt: 'x' } },
    { id: markRecordId(WARD, 2), updatedAt: 1, data: { wardId: WARD, serial: 2, markedAt: 'x' } },
    { id: markRecordId(WARD, 2), updatedAt: 1, data: { wardId: WARD, serial: 2, workerId: 'w', markedAt: 't' } },
    { id: markRecordId(WARD, 2), updatedAt: 2, data: { wardId: WARD, serial: 2, workerId: 'v', markedAt: 'u' } },
  ]);
  assert.equal(added, 1);
  assert.deepEqual(await phone.marks.listMarks(), [{ wardId: WARD, serial: 2, workerId: 'w', markedAt: 't' }]);
});

test('markSeen rejects a bad voter reference or worker, storing nothing', async () => {
  const phone = device(await server(), { offline: true });
  for (const [wardId, serial, workerId] of [
    ['', 1, 'w'], ['a:b', 1, 'w'], [WARD, -1, 'w'], [WARD, 1.5, 'w'], [WARD, 'x', 'w'], [WARD, 1, ''], [WARD, 1, 7],
  ]) {
    await assert.rejects(phone.marks.markSeen(wardId, serial, workerId), TypeError);
  }
  assert.equal(stored(phone.idb, MARKS_STORE).size, 0);
});
