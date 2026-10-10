// Consent and numbers shared with the candidate's team (issue #44), run by
// `npm test`. Each "device" is its own in-memory IndexedDB with its own
// contact store, team join and sync engine; every request goes to the real
// functions/sync.js handler over an in-memory D1, so nothing leaves the machine.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';

import { createContactStore } from '../src/contacts/contactStore.js';
import { createContactSync, contactRecordId } from '../src/contacts/contactSync.js';
import { createSyncEngine } from '../src/sync/syncEngine.js';
import { createTeamAuth } from '../src/sync/teamAuth.js';
import { onRequest } from '../functions/sync.js';
import { CONTACTS_STORE, DB_NAME, OUTBOX_STORE } from '../src/storage/deviceDb.js';
import { createFakeIndexedDB } from './helpers/fakeIndexedDB.js';
import { createMemoryD1 } from './helpers/memoryD1.js';

const ORIGIN = 'https://canvass.takshavid.com';
const WARD = '17/125/6313/1';
const PHONE = '9876543210';

async function server() {
  const env = { SYNC_SECRET: 'test-sync-secret', SYNC_DB: await createMemoryD1({ migrations: ['migrations/0001_sync.sql'] }) };
  return { env, handle: (url, init = {}) => onRequest({ request: new Request(new URL(url, ORIGIN), init), env }) };
}

// state.offline makes every request throw like a phone in airplane mode.
function device(srv, { now } = {}) {
  const idb = createFakeIndexedDB();
  const state = { offline: false, requests: [] };
  const fetch = async (url, init = {}) => {
    state.requests.push(String(url));
    if (state.offline) throw new TypeError('Failed to fetch');
    return srv.handle(url, init);
  };
  const auth = createTeamAuth({ indexedDB: idb, crypto: webcrypto, fetch });
  const store = createContactStore({ indexedDB: idb, crypto: webcrypto, storage: null });
  const engine = createSyncEngine({
    indexedDB: idb, crypto: webcrypto, fetch, getAuth: auth.getAuth,
    window: null, document: null, navigator: { onLine: true },
    setInterval: () => 0, clearInterval: () => {},
  });
  const contacts = createContactSync({ contacts: store, engine, now, log: () => {} });
  contacts.listen();
  return { idb, state, auth, store, engine, contacts };
}

const stored = (idb, name) => idb.databases.get(DB_NAME)?.stores.get(name) ?? new Map();

function clock(start = Date.parse('2026-10-07T10:00:00.000Z')) {
  let t = start;
  return () => new Date((t += 1000)).toISOString();
}

test('a number saved in airplane mode reaches a teammate after reconnecting, and only that team', async () => {
  const srv = await server();
  const field = device(srv, { now: clock() });
  const teammate = device(srv);
  const rival = device(srv);
  await field.auth.joinTeam('candA', 'हमारी टीम');
  await teammate.auth.joinTeam('candA', 'हमारी टीम');
  await rival.auth.joinTeam('candB', 'दूसरी टीम');

  field.state.offline = true;
  await field.contacts.recordConsent(WARD, 12);
  await field.contacts.saveNumber(WARD, 12, '+91 98765 43210');
  assert.equal((await field.contacts.getContact(WARD, 12)).phone, PHONE);
  // Queued, encrypted with the device key: no number in clear in the outbox.
  const outbox = stored(field.idb, OUTBOX_STORE);
  assert.deepEqual([...outbox.keys()], [contactRecordId(WARD, 12)]);
  assert.ok(!Buffer.from(outbox.get(contactRecordId(WARD, 12)).ct).includes(Buffer.from(PHONE)));
  assert.equal((await field.engine.syncNow()).status, 'failed');
  assert.equal(stored(field.idb, OUTBOX_STORE).size, 1);

  field.state.offline = false;
  const result = await field.engine.syncNow();
  assert.equal(result.status, 'ok');
  assert.equal(result.pushed, 1);
  assert.equal(stored(field.idb, OUTBOX_STORE).size, 0);
  assert.ok(!JSON.stringify(srv.env.SYNC_DB.sqlite.query('SELECT * FROM records', [])).includes(PHONE));

  assert.equal((await teammate.engine.syncNow()).received, 1);
  const copy = await teammate.store.getContact(WARD, 12);
  assert.equal(copy.phone, PHONE);
  assert.equal(copy.consentAt, (await field.store.getContact(WARD, 12)).consentAt);

  assert.equal((await rival.engine.syncNow()).received, 0);
  assert.equal(await rival.store.getContact(WARD, 12), null);
  assert.equal(stored(rival.idb, CONTACTS_STORE).size, 0);
});

test('a revoked consent deletes the number on teammates\' devices too', async () => {
  const srv = await server();
  const field = device(srv, { now: clock() });
  const teammate = device(srv);
  await field.auth.joinTeam('candA', 'हमारी टीम');
  await teammate.auth.joinTeam('candA', 'हमारी टीम');

  await field.contacts.recordConsent(WARD, 3);
  await field.contacts.saveNumber(WARD, 3, PHONE);
  await field.engine.syncNow();
  await teammate.engine.syncNow();
  assert.equal((await teammate.store.getContact(WARD, 3)).phone, PHONE);

  await field.contacts.revokeConsent(WARD, '3');
  assert.equal(await field.store.getContact(WARD, 3), null);
  await field.engine.syncNow();
  assert.equal((await teammate.engine.syncNow()).received, 1);
  assert.equal(await teammate.store.getContact(WARD, 3), null);
  assert.equal(stored(teammate.idb, CONTACTS_STORE).size, 0);
});

test('the later change wins when two teammates edit the same voter', async () => {
  const srv = await server();
  const now = clock();
  const a = device(srv, { now });
  const b = device(srv, { now });
  await a.auth.joinTeam('candA', 'हमारी टीम');
  await b.auth.joinTeam('candA', 'हमारी टीम');

  await a.contacts.recordConsent(WARD, 5);
  await a.contacts.saveNumber(WARD, 5, '9000000001');
  await b.contacts.recordConsent(WARD, 5);
  await b.contacts.saveNumber(WARD, 5, '9000000002');
  await a.engine.syncNow();
  await b.engine.syncNow();
  await a.engine.syncNow();
  assert.equal((await a.store.getContact(WARD, 5)).phone, '9000000002');
  assert.equal((await b.store.getContact(WARD, 5)).phone, '9000000002');
});

test('applyRemote ignores other record types and malformed contact records', async () => {
  const calls = [];
  const fake = {
    revokeConsent: async (...args) => calls.push(['revoke', ...args]),
    putSyncedContact: async (...args) => calls.push(['put', ...args]),
  };
  const sync = createContactSync({ contacts: fake, engine: { enqueue: async () => {}, onRemoteRecords: () => {} } });
  const good = { id: contactRecordId(WARD, 1), updatedAt: 'x', data: { wardId: WARD, serial: 1, phone: PHONE, consentAt: '2026-10-07T10:00:00.000Z' } };
  const applied = await sync.applyRemote([
    { id: 'assignment:1', updatedAt: 1, data: { wardId: WARD, serial: 1 } },
    { ...good, id: contactRecordId(WARD, 2) },
    { ...good, data: { ...good.data, phone: '123' } },
    { ...good, data: { ...good.data, consentAt: null } },
    good,
    { id: contactRecordId(WARD, 4), updatedAt: 'x', data: { wardId: WARD, serial: 4, revoked: true } },
  ]);
  assert.equal(applied, 2);
  assert.deepEqual(calls, [
    ['put', WARD, 1, { wardId: WARD, serial: 1, phone: PHONE, consentAt: good.data.consentAt, revoked: false }],
    ['revoke', WARD, 4],
  ]);
});

test('a save is kept on the device when it cannot be queued for the team', async () => {
  const store = createContactStore({ indexedDB: createFakeIndexedDB(), crypto: webcrypto, storage: null });
  const logged = [];
  const sync = createContactSync({
    contacts: store,
    engine: { enqueue: async () => { throw new Error('outbox broken'); }, onRemoteRecords: () => {} },
    log: (...args) => logged.push(args),
  });
  await sync.recordConsent(WARD, 9);
  assert.equal((await sync.saveNumber(WARD, 9, PHONE)).phone, PHONE);
  assert.equal((await store.getContact(WARD, 9)).phone, PHONE);
  assert.equal(logged.length, 2);
});

test('putSyncedContact stores a teammate\'s consent and rejects a bad number', async () => {
  const store = createContactStore({ indexedDB: createFakeIndexedDB(), crypto: webcrypto, storage: null });
  const consentAt = '2026-10-06T09:00:00.000Z';
  await store.putSyncedContact(WARD, 2, { phone: null, consentAt });
  assert.deepEqual(await store.getContact(WARD, 2), { wardId: WARD, serial: 2, phone: null, consentAt });
  await store.putSyncedContact(WARD, 2, { phone: PHONE, consentAt });
  assert.equal((await store.getContact(WARD, 2)).phone, PHONE);
  await assert.rejects(store.putSyncedContact(WARD, 2, { phone: '12', consentAt }), TypeError);
  await assert.rejects(store.putSyncedContact(WARD, 2, { phone: PHONE }), TypeError);
  assert.equal((await store.getContact(WARD, 2)).phone, PHONE);
});
