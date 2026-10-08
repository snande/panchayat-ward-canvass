// The team's SMS number as an encrypted, synced team record (issue #103),
// run by `npm test`.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { webcrypto } from 'node:crypto';

import { createFakeIndexedDB } from './helpers/fakeIndexedDB.js';
import { TEAM_STORE } from '../src/storage/deviceDb.js';
import {
  TEAM_SMS_RECORD_ID, createTeamSmsNumber, normaliseSmsNumber,
} from '../src/team/teamSmsNumber.js';

const read = (rel) => readFileSync(new URL('../' + rel, import.meta.url), 'utf8');

function fakeEngine() {
  const queued = [];
  const callbacks = new Set();
  return {
    queued,
    enqueue: async (record) => { queued.push(record); },
    onRemoteRecords: (cb) => {
      callbacks.add(cb);
      return () => callbacks.delete(cb);
    },
    deliver: async (records) => {
      for (const cb of callbacks) await cb(records);
    },
  };
}

function clock(start = '2026-10-08T09:00:00.000Z') {
  let t = Date.parse(start);
  return () => new Date((t += 1000)).toISOString();
}

function store(overrides = {}) {
  const idb = createFakeIndexedDB();
  const engine = fakeEngine();
  const logged = [];
  const team = createTeamSmsNumber({
    indexedDB: idb, crypto: webcrypto, engine, now: clock(), log: (...args) => logged.push(args), ...overrides,
  });
  return { idb, engine, team, logged };
}

// Every byte the fake IndexedDB holds for the team store, as text.
async function rawTeamStore(idb) {
  const db = await new Promise((resolve, reject) => {
    const req = idb.open('ward-canvass');
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  const tx = db.transaction(TEAM_STORE, 'readonly');
  const values = await new Promise((resolve, reject) => {
    const req = tx.objectStore(TEAM_STORE).getAll();
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return values.map((v) => `${JSON.stringify(v)} ${Buffer.from(v.ct).toString('latin1')}`).join('\n');
}

test('normaliseSmsNumber keeps international numbers and gives Indian mobiles +91', () => {
  assert.equal(normaliseSmsNumber('+91 98765 43210'), '+919876543210');
  assert.equal(normaliseSmsNumber('+91-98765-43210'), '+919876543210');
  assert.equal(normaliseSmsNumber('9876543210'), '+919876543210');
  assert.equal(normaliseSmsNumber('09876543210'), '+919876543210');
  assert.equal(normaliseSmsNumber('0091 9876543210'), '+919876543210');
  assert.equal(normaliseSmsNumber('919876543210'), '+919876543210');
  assert.equal(normaliseSmsNumber('91 98765 43210'), '+919876543210');
  assert.equal(normaliseSmsNumber('6123456789'), '+916123456789');
  assert.equal(normaliseSmsNumber('+९१ ९८७६५ ४३२१०'), '+919876543210');
  assert.equal(normaliseSmsNumber('+447700900123'), '+447700900123');
  // Ten digits outside the Indian mobile range are not given +91.
  for (const bad of ['1234567890', '0123456789', '5876543210', '01234567890', '911234567890']) {
    assert.equal(normaliseSmsNumber(bad), null, bad);
  }
  for (const bad of ['', '   ', '12345', 'abc', '+91 98765 4321x', '+0123456789', '+1234567890123456', null, undefined, 9876543210]) {
    assert.equal(normaliseSmsNumber(bad), null, String(bad));
  }
});

test('with no number saved the phone has none', async () => {
  const { team } = store();
  assert.equal(await team.getTeamSmsNumber(), '');
});

test('a saved number is read back, kept encrypted and queued for the team', async () => {
  const { idb, engine, team } = store();
  assert.equal(await team.setTeamSmsNumber('+91 98765 43210'), '+919876543210');
  assert.equal(await team.getTeamSmsNumber(), '+919876543210');

  const raw = await rawTeamStore(idb);
  assert.ok(raw.length > 0);
  assert.doesNotMatch(raw, /9876543210|98765/);

  assert.equal(engine.queued.length, 1);
  const [record] = engine.queued;
  assert.equal(record.id, TEAM_SMS_RECORD_ID);
  assert.deepEqual(record.data, { smsNumber: '+919876543210' });
  assert.ok(Number.isFinite(Date.parse(record.updatedAt)));
});

test('a stored number that cannot be decrypted reads as none, and a new save replaces it', async () => {
  const { idb, team, logged } = store();
  await team.setTeamSmsNumber('+919876543210');
  // Corrupt the ciphertext, as a lost or rotated device key would leave it.
  const db = await new Promise((resolve, reject) => {
    const req = idb.open('ward-canvass');
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  const tx = db.transaction(TEAM_STORE, 'readwrite');
  const done = new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  tx.objectStore(TEAM_STORE).put({ v: 1, iv: new Uint8Array(12), ct: new Uint8Array(32) }, 'smsNumber');
  await done;

  assert.equal(await team.getTeamSmsNumber(), '');
  assert.equal(logged.length, 1);

  assert.equal(await team.setTeamSmsNumber('+919811111111'), '+919811111111');
  assert.equal(await team.getTeamSmsNumber(), '+919811111111');
});

test('a value that is not a phone number is refused and the stored one stays', async () => {
  const { engine, team } = store();
  await team.setTeamSmsNumber('9876543210');
  await assert.rejects(team.setTeamSmsNumber('not a number'), TypeError);
  assert.equal(await team.getTeamSmsNumber(), '+919876543210');
  assert.equal(engine.queued.length, 1);
});

test('a save that cannot be queued is still kept on the phone', async () => {
  const engine = { enqueue: async () => { throw new Error('outbox closed'); }, onRemoteRecords: () => () => {} };
  const { team, logged } = store({ engine });
  assert.equal(await team.setTeamSmsNumber('9876543210'), '+919876543210');
  assert.equal(await team.getTeamSmsNumber(), '+919876543210');
  assert.equal(logged.length, 1);
});

test('a number pulled from the team is applied when it is newer, and listeners hear of it', async () => {
  const { engine, team } = store();
  team.listen();
  const heard = [];
  team.onChange((n) => heard.push(n));

  await engine.deliver([
    { id: 'contact:w:1', updatedAt: '2026-10-08T10:00:00.000Z', data: { smsNumber: '+919000000000' } },
    { id: TEAM_SMS_RECORD_ID, updatedAt: '2026-10-08T10:00:00.000Z', data: { smsNumber: '+919811111111' } },
  ]);
  assert.equal(await team.getTeamSmsNumber(), '+919811111111');
  assert.deepEqual(heard, ['+919811111111']);

  // Older, malformed or not a number: ignored.
  assert.equal(await team.applyRemote([
    { id: TEAM_SMS_RECORD_ID, updatedAt: '2026-10-08T09:00:00.000Z', data: { smsNumber: '+919822222222' } },
    { id: TEAM_SMS_RECORD_ID, updatedAt: '2026-10-08T11:00:00.000Z', data: { smsNumber: 'call me' } },
    { id: TEAM_SMS_RECORD_ID, updatedAt: '2026-10-08T11:00:00.000Z' },
  ]), 0);
  assert.equal(await team.getTeamSmsNumber(), '+919811111111');

  // A later save anywhere wins.
  assert.equal(await team.applyRemote([
    { id: TEAM_SMS_RECORD_ID, updatedAt: '2026-10-08T12:00:00.000Z', data: { smsNumber: '+919833333333' } },
  ]), 1);
  assert.equal(await team.getTeamSmsNumber(), '+919833333333');
  assert.deepEqual(heard, ['+919811111111', '+919833333333']);
});

test('a local save newer than a pulled record is kept', async () => {
  const { team } = store({ now: () => '2026-10-08T12:00:00.000Z' });
  await team.setTeamSmsNumber('+919844444444');
  assert.equal(await team.applyRemote([
    { id: TEAM_SMS_RECORD_ID, updatedAt: '2026-10-08T11:00:00.000Z', data: { smsNumber: '+919855555555' } },
  ]), 0);
  assert.equal(await team.getTeamSmsNumber(), '+919844444444');
});

test('the team SMS number is not in the public config, and the module is precached', () => {
  const config = JSON.parse(read('config/constituency.json'));
  assert.equal(Object.prototype.hasOwnProperty.call(config, 'teamSmsNumber'), false);
  assert.doesNotMatch(read('js/picker.js'), /config\.teamSmsNumber/);
  assert.ok(read('sw.js').includes('"src/team/teamSmsNumber.js"'));
});
