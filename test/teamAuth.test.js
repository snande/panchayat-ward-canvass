// Team join on the device (issue #48), run by `npm test`. Each "device" is
// its own in-memory IndexedDB; join requests go straight to the real
// functions/sync.js handler over an in-memory D1, so nothing leaves the
// machine.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { readFileSync } from 'node:fs';

import {
  createTeamAuth, PBKDF2_ITERATIONS, TEAM_KEY_ID, TEAM_AUTH_ID, JOIN_URL,
} from '../src/sync/teamAuth.js';
import * as teamAuthModule from '../src/sync/teamAuth.js';
import { onRequest } from '../functions/sync.js';
import { DB_NAME, KEYS_STORE, META_STORE } from '../src/storage/deviceDb.js';
import { createFakeIndexedDB } from './helpers/fakeIndexedDB.js';
import { createMemoryD1 } from './helpers/memoryD1.js';

const ORIGIN = 'https://canvass.takshavid.com';
const PASS_A = 'हमारी टीम 2026';
const PASS_B = 'दूसरी टीम';
const encoder = new TextEncoder();

async function server() {
  const env = { SYNC_SECRET: 'test-sync-secret', SYNC_DB: await createMemoryD1({ migrations: ['migrations/0001_sync.sql'] }) };
  const requests = [];
  const fetch = async (url, init = {}) => {
    requests.push({ url: String(url), init });
    return onRequest({ request: new Request(new URL(url, ORIGIN), init), env });
  };
  return { env, fetch, call: fetch, requests };
}

function device(srv, crypto = webcrypto) {
  const idb = createFakeIndexedDB();
  return { idb, auth: createTeamAuth({ indexedDB: idb, crypto, fetch: srv.fetch }) };
}

const stored = (idb, store) => idb.databases.get(DB_NAME)?.stores.get(store) ?? new Map();

async function encrypt(key, text) {
  const iv = webcrypto.getRandomValues(new Uint8Array(12));
  const data = await webcrypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, encoder.encode(text));
  return { iv, data };
}

const decrypt = async (key, { iv, data }) =>
  new TextDecoder().decode(await webcrypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, data));

// An independent derivation; Node's base64url matches the server's encoder.
async function expectedVerifier(candidateId, passphrase) {
  const base = await webcrypto.subtle.importKey('raw', encoder.encode(passphrase), 'PBKDF2', false, ['deriveBits']);
  const bits = new Uint8Array(await webcrypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: encoder.encode(candidateId), iterations: PBKDF2_ITERATIONS, hash: 'SHA-256' }, base, 256,
  ));
  const digest = await webcrypto.subtle.digest('SHA-256', Buffer.concat([bits, Buffer.from('verify')]));
  return { bits, verifier: Buffer.from(digest).toString('base64url') };
}

test('exports joinTeam and getAuth, and uses at least 100000 PBKDF2 iterations', () => {
  assert.equal(typeof teamAuthModule.joinTeam, 'function');
  assert.equal(typeof teamAuthModule.getAuth, 'function');
  assert.ok(PBKDF2_ITERATIONS >= 100000);
  assert.equal(JOIN_URL, '/sync/join');
});

test('the same passphrase on two devices yields working tokens and one team key', async () => {
  const srv = await server();
  const first = device(srv);
  const second = device(srv);
  assert.equal(await first.auth.getAuth(), null);

  const a = await first.auth.joinTeam('candA', PASS_A);
  assert.equal(a.candidateId, 'candA');
  assert.equal(a.key.extractable, false);
  assert.equal(a.key.algorithm.name, 'AES-GCM');
  assert.equal(a.key.algorithm.length, 256);
  assert.deepEqual(a.key.usages.sort(), ['decrypt', 'encrypt']);
  // The first join recorded exactly the verifier of the PBKDF2 bits, so the
  // client's base64url copy and the server's encoder agree.
  const { bits, verifier } = await expectedVerifier('candA', PASS_A);
  assert.equal(srv.env.SYNC_DB.sqlite.query('SELECT verifier FROM verifiers WHERE candidate_id = ?', ['candA'])[0]?.verifier, verifier);
  assert.deepEqual(JSON.parse(srv.requests[0].init.body), { candidateId: 'candA', verifier });
  assert.equal(srv.requests[0].url, '/sync/join');
  assert.equal(srv.requests[0].init.method, 'POST');

  const b = await second.auth.joinTeam(' candA ', PASS_A);
  assert.equal(b.candidateId, 'candA');
  assert.notEqual(b.token, a.token);

  // Both tokens work against the sync API.
  const sealed = await encrypt(a.key, '9829012345');
  const push = await srv.call('/sync/push', {
    method: 'POST',
    headers: { Authorization: `Bearer ${a.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ records: [{ id: 'r1', updatedAt: 1, ciphertext: Buffer.from(sealed.data).toString('base64'), iv: Buffer.from(sealed.iv).toString('base64') }] }),
  });
  assert.equal(push.status, 200);
  const pulled = await (await srv.call('/sync/pull', { headers: { Authorization: `Bearer ${b.token}` } })).json();
  assert.equal(pulled.records.length, 1);

  // The second device decrypts what the first encrypted, and the key is the
  // PBKDF2 bits themselves.
  const record = pulled.records[0];
  const roundTrip = { iv: Buffer.from(record.iv, 'base64'), data: Buffer.from(record.ciphertext, 'base64') };
  assert.equal(await decrypt(b.key, roundTrip), '9829012345');
  const reference = await webcrypto.subtle.importKey('raw', bits, 'AES-GCM', false, ['decrypt']);
  assert.equal(await decrypt(reference, sealed), '9829012345');

  // getAuth returns what was stored, on each device.
  for (const [dev, joined] of [[first, a], [second, b]]) {
    const auth = await dev.auth.getAuth();
    assert.deepEqual(Object.keys(auth).sort(), ['candidateId', 'key', 'token']);
    assert.equal(auth.token, joined.token);
    assert.equal(auth.candidateId, 'candA');
    assert.equal(auth.key.extractable, false);
    assert.equal(await decrypt(auth.key, sealed), '9829012345');
  }
});

test('a wrong passphrase or another candidate\'s passphrase is a 401 and stores nothing', async () => {
  const srv = await server();
  await device(srv).auth.joinTeam('candA', PASS_A);
  await device(srv).auth.joinTeam('candB', PASS_B);

  for (const passphrase of ['गलत पासवर्ड', PASS_B]) {
    const dev = device(srv);
    await assert.rejects(dev.auth.joinTeam('candA', passphrase), { name: 'TeamJoinError', code: 'unauthorized' });
    assert.equal(await dev.auth.getAuth(), null);
    assert.equal(stored(dev.idb, KEYS_STORE).size, 0);
    assert.equal(stored(dev.idb, META_STORE).size, 0);
  }
  assert.equal(srv.env.SYNC_DB.sqlite.query('SELECT verifier FROM verifiers WHERE candidate_id = ?', ['candA'])[0]?.verifier, (await expectedVerifier('candA', PASS_A)).verifier);

  // The two teams' keys differ: candB cannot read candA's records.
  const a = await device(srv).auth.joinTeam('candA', PASS_A);
  const b = await device(srv).auth.joinTeam('candB', PASS_B);
  await assert.rejects(decrypt(b.key, await encrypt(a.key, '9829012345')));
});

test('no plaintext passphrase is persisted; only the token, candidate code and key', async () => {
  const srv = await server();
  const dev = device(srv);
  await dev.auth.joinTeam('candA', PASS_A);
  const keys = stored(dev.idb, KEYS_STORE);
  const meta = stored(dev.idb, META_STORE);
  assert.deepEqual([...keys.keys()], [TEAM_KEY_ID]);
  assert.deepEqual([...meta.keys()], [TEAM_AUTH_ID]);
  assert.equal(Object.prototype.toString.call(keys.get(TEAM_KEY_ID)), '[object CryptoKey]');
  const dump = JSON.stringify([...meta.values()]);
  assert.ok(!dump.includes(PASS_A));
  assert.ok(!dump.includes('टीम'));
  assert.deepEqual(Object.keys(meta.get(TEAM_AUTH_ID)).sort(), ['candidateId', 'deviceId', 'token', 'v']);
  // The server never saw the passphrase either.
  assert.ok(!srv.requests.some((r) => String(r.init.body).includes(PASS_A)));
});

test('PBKDF2 runs with salt = candidateId and the configured iterations', async () => {
  const srv = await server();
  const params = [];
  const subtle = new Proxy(webcrypto.subtle, {
    get(target, name) {
      const value = target[name];
      if (typeof value !== 'function') return value;
      if (name === 'deriveBits') {
        return (algorithm, ...rest) => {
          params.push(algorithm);
          return target.deriveBits(algorithm, ...rest);
        };
      }
      return value.bind(target);
    },
  });
  const crypto = { subtle, getRandomValues: (a) => webcrypto.getRandomValues(a) };
  await device(srv, crypto).auth.joinTeam('candA', PASS_A);
  assert.equal(params.length, 1);
  assert.equal(params[0].name, 'PBKDF2');
  assert.equal(params[0].hash, 'SHA-256');
  assert.ok(params[0].iterations >= 100000);
  assert.equal(new TextDecoder().decode(params[0].salt), 'candA');
});

test('bad input and network failures reject without storing anything', async () => {
  const srv = await server();
  const dev = device(srv);
  for (const id of ['', 'a/b', 'उम्मीदवार', null]) {
    await assert.rejects(dev.auth.joinTeam(id, PASS_A), { code: 'invalid-code' });
  }
  for (const pass of ['', '   ', null]) {
    await assert.rejects(dev.auth.joinTeam('candA', pass), { code: 'invalid' });
  }
  assert.equal(srv.requests.length, 0);

  const offline = createTeamAuth({
    indexedDB: dev.idb, crypto: webcrypto, fetch: async () => { throw new TypeError('Failed to fetch'); },
  });
  await assert.rejects(offline.joinTeam('candA', PASS_A), { code: 'failed' });
  const broken = createTeamAuth({
    indexedDB: dev.idb, crypto: webcrypto, fetch: async () => new Response('', { status: 503 }),
  });
  await assert.rejects(broken.joinTeam('candA', PASS_A), { code: 'failed' });
  assert.equal(await dev.auth.getAuth(), null);
});

test('the service worker precaches team auth, the join screen and their imports', () => {
  const sw = readFileSync(new URL('../sw.js', import.meta.url), 'utf8');
  for (const file of ['src/sync/teamAuth.js', 'src/ui/teamJoinScreen.js', 'src/storage/deviceDb.js']) {
    assert.ok(sw.includes(`"${file}"`), file);
  }
});
