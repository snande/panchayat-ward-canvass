// Candidate-partitioned sync endpoints (issue #47), run by `npm test`. The
// SYNC_KV binding is an in-memory store with the Workers KV get/put/list
// shape; nothing here leaves the machine.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { onRequest, signSyncToken, verifySyncToken, MAX_PULL_RECORDS } from '../functions/sync.js';
import { onRequest as catchAllOnRequest } from '../functions/sync/[[path]].js';

const ORIGIN = 'https://canvass.takshavid.com';
const SECRET = 'test-sync-secret';

// In-memory stand-in for a Workers KV namespace: get/put/list with
// prefix, a small page size and an opaque list cursor.
function memoryKV({ pageSize = 3 } = {}) {
  const map = new Map();
  return {
    map,
    async get(key) {
      return map.has(key) ? map.get(key) : null;
    },
    async put(key, value) {
      map.set(key, String(value));
    },
    async list({ prefix = '', cursor, limit = pageSize } = {}) {
      const names = [...map.keys()].filter((k) => k.startsWith(prefix)).sort();
      const start = cursor ? Number(cursor) : 0;
      const slice = names.slice(start, start + limit);
      const next = start + slice.length;
      const complete = next >= names.length;
      return {
        keys: slice.map((name) => ({ name })),
        list_complete: complete,
        ...(complete ? {} : { cursor: String(next) }),
      };
    },
  };
}

function call(env, path, { method = 'GET', token, body, headers = {} } = {}) {
  const init = { method, headers: { ...headers } };
  if (token !== undefined) init.headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) {
    init.body = typeof body === 'string' ? body : JSON.stringify(body);
    init.headers['Content-Type'] = 'application/json';
  }
  return onRequest({ request: new Request(ORIGIN + path, init), env });
}

const pushRecords = (env, token, records) => call(env, '/sync/push', { method: 'POST', token, body: { records } });
const pullSince = (env, token, since) =>
  call(env, since === undefined ? '/sync/pull' : `/sync/pull?since=${since}`, { token });

// Stand-in for the client's AES-GCM output: the server only ever sees
// these base64 strings.
const PHONE = '9829012345';
const fakeCiphertext = (plain) => Buffer.from([...Buffer.from(plain)].map((b) => b ^ 0x5a)).toString('base64');
const record = (id, plain = `{"phone":"${PHONE}"}`) => ({
  id,
  updatedAt: 1760000000000,
  ciphertext: fakeCiphertext(plain),
  iv: 'AAECAwQFBgcICQoL',
});

const setup = () => ({ SYNC_SECRET: SECRET, SYNC_KV: memoryKV() });

test('token round-trips and binds candidateId:deviceId', async () => {
  const token = await signSyncToken(SECRET, 'candA', 'dev1');
  assert.deepEqual(await verifySyncToken(SECRET, token), { candidateId: 'candA', deviceId: 'dev1' });
  assert.equal(await verifySyncToken('other-secret', token), null);
  assert.equal(await verifySyncToken(SECRET, token + 'x'), null);
  await assert.rejects(signSyncToken(SECRET, 'a/b', 'dev1'));
  await assert.rejects(signSyncToken(SECRET, 'a.b', 'dev1'));
});

test('missing or invalid bearer token gets a bare 401', async () => {
  const env = setup();
  const good = await signSyncToken(SECRET, 'candA', 'dev1');
  const [payload, mac] = good.split('.');
  const forgedPayload = Buffer.from('candB.dev1').toString('base64url');
  const wrongSecret = await signSyncToken('not-the-secret', 'candA', 'dev1');

  const attempts = [
    () => call(env, '/sync/pull'),
    () => call(env, '/sync/pull', { headers: { Authorization: good } }),
    () => call(env, '/sync/pull', { headers: { Authorization: `Basic ${good}` } }),
    () => call(env, '/sync/pull', { token: '' }),
    () => call(env, '/sync/pull', { token: 'garbage' }),
    () => call(env, '/sync/pull', { token: payload }),
    () => call(env, '/sync/pull', { token: `${forgedPayload}.${mac}` }),
    () => call(env, '/sync/pull', { token: wrongSecret }),
    () => call(env, '/sync/push', { method: 'POST', body: { records: [record('r1')] } }),
    () => call(env, '/sync/push', { method: 'POST', token: wrongSecret, body: { records: [record('r1')] } }),
    () => call(env, '/sync/elsewhere', { token: 'garbage' }),
  ];
  for (const attempt of attempts) {
    const res = await attempt();
    assert.equal(res.status, 401);
    assert.equal(await res.text(), '');
  }
  // nothing was written by the rejected pushes
  assert.equal(env.SYNC_KV.map.size, 0);
});

test('push from candidate A is invisible to candidate B, even if the body names B', async () => {
  const env = setup();
  const a = await signSyncToken(SECRET, 'candA', 'dev1');
  const b = await signSyncToken(SECRET, 'candB', 'dev1');

  const pushed = await call(env, '/sync/push?candidateId=candB', {
    method: 'POST',
    token: a,
    body: { candidateId: 'candB', records: [{ ...record('r1'), candidateId: 'candB' }, record('r2')] },
  });
  assert.equal(pushed.status, 200);
  assert.deepEqual(await pushed.json(), { accepted: 2, cursor: 2 });

  for (const key of env.SYNC_KV.map.keys()) assert.ok(key.startsWith('c/candA/'), key);

  const res = await call(env, '/sync/pull?since=0&candidateId=candA', { token: b });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { records: [], cursor: 0, more: false });
});

test("device 2 pulls device 1's record for the same candidate, then nothing new", async () => {
  const env = setup();
  const dev1 = await signSyncToken(SECRET, 'candA', 'dev1');
  const dev2 = await signSyncToken(SECRET, 'candA', 'dev2');

  const r1 = record('r1');
  assert.equal((await pushRecords(env, dev1, [r1])).status, 200);

  const first = await (await pullSince(env, dev2, 0)).json();
  assert.deepEqual(first, { records: [r1], cursor: 1, more: false });

  const again = await (await pullSince(env, dev2, first.cursor)).json();
  assert.deepEqual(again, { records: [], cursor: 1, more: false });

  const r2 = record('r2', '{"note":"second"}');
  await pushRecords(env, dev2, [r2]);
  const fromDev1 = await (await pullSince(env, dev1, first.cursor)).json();
  assert.deepEqual(fromDev1, { records: [r2], cursor: 2, more: false });

  // no `since` means from the start
  const all = await (await pullSince(env, dev1)).json();
  assert.deepEqual(all.records.map((r) => r.id), ['r1', 'r2']);
});

test('stored records keep the ciphertext opaque and hold no plaintext phone number', async () => {
  const env = setup();
  const token = await signSyncToken(SECRET, 'candA', 'dev1');
  const r = { ...record('r1'), phone: PHONE, name: 'रमेश' };
  await pushRecords(env, token, [r]);

  const stored = env.SYNC_KV.map.get('c/candA/r/000000000001');
  assert.ok(stored);
  const parsed = JSON.parse(stored);
  assert.equal(parsed.ciphertext, r.ciphertext);
  assert.equal(parsed.iv, r.iv);
  assert.deepEqual(Object.keys(parsed).sort(), ['ciphertext', 'deviceId', 'id', 'iv', 'seq', 'updatedAt']);
  for (const value of env.SYNC_KV.map.values()) {
    assert.ok(!value.includes(PHONE), value);
    assert.ok(!value.includes('रमेश'), value);
  }
  assert.equal(env.SYNC_KV.map.get('c/candA/seq'), '1');
});

test('pull pages through KV in sequence order and caps one response', async () => {
  const env = setup();
  const token = await signSyncToken(SECRET, 'candA', 'dev1');
  const total = MAX_PULL_RECORDS + 5;
  const batch = Array.from({ length: total }, (_, i) => record(`r${i + 1}`, `x${i}`));
  for (let i = 0; i < batch.length; i += 500) {
    assert.equal((await pushRecords(env, token, batch.slice(i, i + 500))).status, 200);
  }
  const page1 = await (await pullSince(env, token, 0)).json();
  assert.equal(page1.records.length, MAX_PULL_RECORDS);
  assert.equal(page1.more, true);
  assert.equal(page1.cursor, MAX_PULL_RECORDS);
  assert.equal(page1.records[0].id, 'r1');
  assert.equal(page1.records.at(-1).id, `r${MAX_PULL_RECORDS}`);

  const page2 = await (await pullSince(env, token, page1.cursor)).json();
  assert.deepEqual(page2.records.map((r) => r.id), ['r1001', 'r1002', 'r1003', 'r1004', 'r1005']);
  assert.equal(page2.cursor, total);
  assert.equal(page2.more, false);
});

test('bad input, wrong methods, unknown paths and missing config', async () => {
  const env = setup();
  const token = await signSyncToken(SECRET, 'candA', 'dev1');

  assert.equal((await call(env, '/sync/push', { method: 'POST', token, body: 'not json' })).status, 400);
  assert.equal((await call(env, '/sync/push', { method: 'POST', token, body: {} })).status, 400);
  assert.equal((await pushRecords(env, token, [{ id: 'r1', updatedAt: 1, ciphertext: { x: 1 }, iv: 'a' }])).status, 400);
  assert.equal((await pushRecords(env, token, [{ id: 'r1', updatedAt: 1, iv: 'a' }])).status, 400);
  assert.equal((await pushRecords(env, token, Array.from({ length: 501 }, (_, i) => record(`r${i}`)))).status, 400);
  assert.equal(env.SYNC_KV.map.size, 0);

  assert.equal((await pullSince(env, token, -1)).status, 400);
  assert.equal((await pullSince(env, token, 'abc')).status, 400);
  assert.equal((await pullSince(env, token, '1.5')).status, 400);

  assert.equal((await call(env, '/sync/push', { token })).status, 405);
  assert.equal((await call(env, '/sync/pull', { method: 'POST', token, body: {} })).status, 405);
  assert.equal((await call(env, '/sync/other', { token })).status, 404);

  assert.equal((await call({ SYNC_KV: memoryKV() }, '/sync/pull', { token })).status, 503);
  assert.equal((await call({ SYNC_SECRET: SECRET }, '/sync/pull', { token })).status, 503);
});

test('/sync/* is routed to the function', async () => {
  const routes = JSON.parse(readFileSync(new URL('../_routes.json', import.meta.url), 'utf8'));
  assert.ok(routes.include.includes('/sync/*'));
  assert.ok(routes.include.includes('/roll'));
  assert.equal(catchAllOnRequest, onRequest);
});
