// Candidate-partitioned sync endpoints (issue #47), run by `npm test`. The
// SYNC_DB binding is test/helpers/memoryD1.js, an in-memory SQLite database
// with the D1 API and the schema from migrations/0001_sync.sql; nothing here
// leaves the machine.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { onRequest, signSyncToken, verifySyncToken, MAX_PULL_RECORDS } from '../functions/sync.js';
import { createMemoryD1 } from './helpers/memoryD1.js';
import { onRequest as catchAllOnRequest } from '../functions/sync/[[path]].js';

const ORIGIN = 'https://canvass.takshavid.com';
const SECRET = 'test-sync-secret';

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

const memoryD1 = () => createMemoryD1({ migrations: ['migrations/0001_sync.sql'] });
const setup = async () => ({ SYNC_SECRET: SECRET, SYNC_DB: await memoryD1() });
const query = (env, sql, ...params) => env.SYNC_DB.sqlite.query(sql, params);
const TABLES = ['records', 'counters', 'marks', 'verifiers'];
const rowCount = (env) => TABLES.reduce((n, table) => n + query(env, `SELECT COUNT(*) AS n FROM ${table}`)[0].n, 0);
const counter = (env, candidateId) => query(env, 'SELECT seq FROM counters WHERE candidate_id = ?', candidateId)[0]?.seq;
const storedVerifier = (env, candidateId) =>
  query(env, 'SELECT verifier FROM verifiers WHERE candidate_id = ?', candidateId)[0]?.verifier;
const markIds = (env, candidateId) =>
  query(env, 'SELECT id FROM marks WHERE candidate_id = ? ORDER BY id', candidateId).map((r) => r.id);

test('token round-trips and binds candidateId:deviceId', async () => {
  const token = await signSyncToken(SECRET, 'candA', 'dev1');
  assert.deepEqual(await verifySyncToken(SECRET, token), { candidateId: 'candA', deviceId: 'dev1' });
  assert.equal(await verifySyncToken('other-secret', token), null);
  assert.equal(await verifySyncToken(SECRET, token + 'x'), null);
  await assert.rejects(signSyncToken(SECRET, 'a/b', 'dev1'));
  await assert.rejects(signSyncToken(SECRET, 'a.b', 'dev1'));
});

test('missing or invalid bearer token gets a bare 401', async () => {
  const env = await setup();
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
  assert.equal(rowCount(env), 0);
});

test('push from candidate A is invisible to candidate B, even if the body names B', async () => {
  const env = await setup();
  const a = await signSyncToken(SECRET, 'candA', 'dev1');
  const b = await signSyncToken(SECRET, 'candB', 'dev1');

  const pushed = await call(env, '/sync/push?candidateId=candB', {
    method: 'POST',
    token: a,
    body: { candidateId: 'candB', records: [{ ...record('r1'), candidateId: 'candB' }, record('r2')] },
  });
  assert.equal(pushed.status, 200);
  assert.deepEqual(await pushed.json(), { accepted: 2, cursor: 2 });

  for (const table of TABLES) {
    for (const { candidate_id } of query(env, `SELECT candidate_id FROM ${table}`)) assert.equal(candidate_id, 'candA', table);
  }

  const res = await call(env, '/sync/pull?since=0&candidateId=candA', { token: b });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { records: [], cursor: 0, more: false });
});

test("device 2 pulls device 1's record for the same candidate, then nothing new", async () => {
  const env = await setup();
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
  const env = await setup();
  const token = await signSyncToken(SECRET, 'candA', 'dev1');
  const r = { ...record('r1'), phone: PHONE, name: 'रमेश' };
  await pushRecords(env, token, [r]);

  const stored = query(env, 'SELECT * FROM records WHERE candidate_id = ? AND seq = 1', 'candA');
  assert.equal(stored.length, 1);
  assert.deepEqual(stored[0], {
    candidate_id: 'candA',
    seq: 1,
    id: 'r1',
    updated_at: r.updatedAt,
    ciphertext: r.ciphertext,
    iv: r.iv,
    device_id: 'dev1',
  });
  for (const table of TABLES) {
    for (const row of query(env, `SELECT * FROM ${table}`)) {
      const text = JSON.stringify(row);
      assert.ok(!text.includes(PHONE), text);
      assert.ok(!text.includes('रमेश'), text);
    }
  }
  assert.equal(counter(env, 'candA'), 1);
});

test('updatedAt comes back as pushed, whether a number or a string', async () => {
  const env = await setup();
  const token = await signSyncToken(SECRET, 'candA', 'dev1');
  const pushed = [
    { ...record('r1'), updatedAt: 1760000000000 },
    { ...record('r2'), updatedAt: '1760000000000' },
    { ...record('r3'), updatedAt: '2025-10-09T10:00:00.000Z' },
    { ...record('r4'), updatedAt: 1.5 },
  ];
  await pushRecords(env, token, pushed);
  const pulled = await (await pullSince(env, token, 0)).json();
  assert.deepEqual(pulled.records, pushed);
});

test('two pushes in flight together for one team get disjoint seq ranges and both land', async () => {
  const env = await setup();
  const dev1 = await signSyncToken(SECRET, 'candA', 'dev1');
  const dev2 = await signSyncToken(SECRET, 'candA', 'dev2');
  const a = Array.from({ length: 150 }, (_, i) => record(`a${i}`, `a${i}`));
  const b = Array.from({ length: 7 }, (_, i) => record(`b${i}`, `b${i}`));

  const [resA, resB] = await Promise.all([pushRecords(env, dev1, a), pushRecords(env, dev2, b)]);
  assert.equal(resA.status, 200);
  assert.equal(resB.status, 200);
  const cursors = [(await resA.json()).cursor, (await resB.json()).cursor].sort((x, y) => x - y);
  assert.ok(cursors[1] === a.length + b.length, cursors.join());
  assert.equal(counter(env, 'candA'), a.length + b.length);

  const seqsOf = (device) =>
    query(env, 'SELECT seq FROM records WHERE candidate_id = ? AND device_id = ? ORDER BY seq', 'candA', device).map((r) => r.seq);
  const seqA = seqsOf('dev1');
  const seqB = seqsOf('dev2');
  assert.equal(seqA.length, a.length);
  assert.equal(seqB.length, b.length);
  assert.ok(seqA.every((s) => !seqB.includes(s)));
  // Each push's range is contiguous.
  assert.equal(seqA.at(-1) - seqA[0], a.length - 1);
  assert.equal(seqB.at(-1) - seqB[0], b.length - 1);

  const pulled = await (await pullSince(env, dev1, 0)).json();
  assert.deepEqual(pulled.records.map((r) => r.id).sort(), [...a, ...b].map((r) => r.id).sort());
  assert.equal(pulled.cursor, a.length + b.length);
});

test('a push that fails part way stores none of its records and leaves the counter alone', async () => {
  const env = await setup();
  const token = await signSyncToken(SECRET, 'candA', 'dev1');
  await pushRecords(env, token, [record('r1')]);
  // A row squatting on the seq the next push would claim makes its insert fail.
  query(env, "INSERT INTO records VALUES ('candA', 3, 'x', 1, 'c', 'i', 'devX')");
  await assert.rejects(pushRecords(env, token, [record('r2'), record('r3')]));
  assert.equal(counter(env, 'candA'), 1);
  assert.deepEqual(query(env, 'SELECT id FROM records ORDER BY seq').map((r) => r.id), ['r1', 'x']);
});

test('pull reads in sequence order and caps one response at MAX_PULL_RECORDS', async () => {
  const env = await setup();
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

test('pull reports no more when exactly MAX_PULL_RECORDS are waiting', async () => {
  const env = await setup();
  const token = await signSyncToken(SECRET, 'candA', 'dev1');
  for (let i = 0; i < MAX_PULL_RECORDS; i += 500) {
    await pushRecords(env, token, Array.from({ length: 500 }, (_, k) => record(`r${i + k + 1}`)));
  }
  const page = await (await pullSince(env, token, 0)).json();
  assert.equal(page.records.length, MAX_PULL_RECORDS);
  assert.equal(page.more, false);
  assert.equal(page.cursor, MAX_PULL_RECORDS);
});

test('bad input, wrong methods, unknown paths and missing config', async () => {
  const env = await setup();
  const token = await signSyncToken(SECRET, 'candA', 'dev1');

  assert.equal((await call(env, '/sync/push', { method: 'POST', token, body: 'not json' })).status, 400);
  assert.equal((await call(env, '/sync/push', { method: 'POST', token, body: {} })).status, 400);
  assert.equal((await pushRecords(env, token, [{ id: 'r1', updatedAt: 1, ciphertext: { x: 1 }, iv: 'a' }])).status, 400);
  assert.equal((await pushRecords(env, token, [{ id: 'r1', updatedAt: 1, iv: 'a' }])).status, 400);
  assert.equal((await pushRecords(env, token, Array.from({ length: 501 }, (_, i) => record(`r${i}`)))).status, 400);
  assert.equal(rowCount(env), 0);

  for (const since of ['-1', 'abc', '1.5', '%20', '0x10', '1e3', '0b1', '99999999999999999999']) {
    assert.equal((await pullSince(env, token, since)).status, 400, since);
  }
  assert.equal((await call(env, '/sync/pull?since=', { token })).status, 200);

  assert.equal((await call(env, '/sync/push', { token })).status, 405);
  assert.equal((await call(env, '/sync/pull', { method: 'POST', token, body: {} })).status, 405);
  assert.equal((await call(env, '/sync/other', { token })).status, 404);

  assert.equal((await call({ SYNC_DB: await memoryD1() }, '/sync/pull', { token })).status, 503);
  assert.equal((await call({ SYNC_SECRET: SECRET }, '/sync/pull', { token })).status, 503);
});

test('/sync/* is routed to the function', async () => {
  const routes = JSON.parse(readFileSync(new URL('../_routes.json', import.meta.url), 'utf8'));
  assert.ok(routes.include.includes('/sync/*'));
  assert.ok(routes.include.includes('/roll'));
  assert.equal(catchAllOnRequest, onRequest);
});

// POST /sync/join (issue #48). The verifier is opaque to the server: any 32
// bytes, base64url. src/sync/teamAuth.js derives the real one.
const verifierOf = (fill) => Buffer.alloc(32, fill).toString('base64url');
const join = (env, body) => call(env, '/sync/join', { method: 'POST', body });

test('the first join for a candidate records its verifier and issues a working token', async () => {
  const env = await setup();
  const res = await join(env, { candidateId: 'candA', verifier: verifierOf(1) });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('Cache-Control'), 'no-store');
  const body = await res.json();
  assert.equal(body.candidateId, 'candA');
  assert.equal(storedVerifier(env, 'candA'), verifierOf(1));
  assert.deepEqual(await verifySyncToken(SECRET, body.token), { candidateId: 'candA', deviceId: body.deviceId });

  assert.equal((await pushRecords(env, body.token, [record('r1')])).status, 200);
  const pulled = await (await pullSince(env, body.token)).json();
  assert.deepEqual(pulled.records.map((r) => r.id), ['r1']);
});

test('a later join needs the same verifier; anything else is a 401 and changes nothing', async () => {
  const env = await setup();
  const first = await (await join(env, { candidateId: 'candA', verifier: verifierOf(1) })).json();

  const again = await join(env, { candidateId: 'candA', verifier: verifierOf(1) });
  assert.equal(again.status, 200);
  const second = await again.json();
  assert.notEqual(second.deviceId, first.deviceId, 'each device gets its own deviceId');
  assert.equal((await pushRecords(env, second.token, [record('r1')])).status, 200);

  // A wrong passphrase, and candB's passphrase presented as candA.
  await join(env, { candidateId: 'candB', verifier: verifierOf(2) });
  for (const verifier of [verifierOf(3), verifierOf(2)]) {
    const res = await join(env, { candidateId: 'candA', verifier });
    assert.equal(res.status, 401);
    assert.equal(await res.text(), '');
  }
  assert.equal(storedVerifier(env, 'candA'), verifierOf(1));
  assert.equal(storedVerifier(env, 'candB'), verifierOf(2));
  assert.equal(query(env, 'SELECT COUNT(*) AS n FROM verifiers')[0].n, 2);
});

test('two first joins racing with different verifiers: one founds the team, the other is a 401', async () => {
  const env = await setup();
  const results = await Promise.all([
    join(env, { candidateId: 'candA', verifier: verifierOf(1) }),
    join(env, { candidateId: 'candA', verifier: verifierOf(2) }),
  ]);
  const statuses = results.map((res) => res.status);
  assert.deepEqual([...statuses].sort(), [200, 401]);
  const winner = statuses.indexOf(200) === 0 ? verifierOf(1) : verifierOf(2);
  assert.equal(storedVerifier(env, 'candA'), winner);
});

test('join rejects malformed bodies and other methods, and needs config', async () => {
  const env = await setup();
  for (const body of [
    'not json', {}, { candidateId: 'candA' }, { verifier: verifierOf(1) },
    { candidateId: 'a/b', verifier: verifierOf(1) },
    { candidateId: 'candA', verifier: 'short' },
    { candidateId: 'candA', verifier: Buffer.alloc(33).toString('base64url') },
    { candidateId: 'candA', verifier: verifierOf(1) + '+' },
  ]) {
    assert.equal((await join(env, body)).status, 400, JSON.stringify(body));
  }
  assert.equal(rowCount(env), 0);
  assert.equal((await call(env, '/sync/join')).status, 405);
  assert.equal((await call({ SYNC_DB: await memoryD1() }, '/sync/join', { method: 'POST', body: {} })).status, 503);
});

// Seen-voting marks (issue #78): one entry per team and mark id.
const markRecord = (id, updatedAt = 1760000000000) => ({ ...record(id, '{"workerId":"w1"}'), updatedAt });

test('a mark pushed twice, in one batch or across batches, is stored once', async () => {
  const env = await setup();
  const dev1 = await signSyncToken(SECRET, 'candA', 'dev1');
  const dev2 = await signSyncToken(SECRET, 'candA', 'dev2');
  const markId = 'mark:17/125/6313/1:42';

  const first = await pushRecords(env, dev1, [markRecord(markId), markRecord(markId, 1760000000001)]);
  assert.deepEqual(await first.json(), { accepted: 2, cursor: 1 });
  // A teammate's mark of the same voter, then a retry of the first push.
  const second = await pushRecords(env, dev2, [markRecord(markId, 1760000000005)]);
  assert.equal(second.status, 200);
  assert.deepEqual(await second.json(), { accepted: 1, cursor: 1 });
  assert.deepEqual(await (await pushRecords(env, dev1, [markRecord(markId)])).json(), { accepted: 1, cursor: 1 });

  assert.equal(counter(env, 'candA'), 1);
  assert.deepEqual(markIds(env, 'candA'), [markId]);
  assert.equal(query(env, 'SELECT COUNT(*) AS n FROM records')[0].n, 1);
  const pulled = await (await pullSince(env, dev2, 0)).json();
  assert.deepEqual(pulled.records.map((r) => [r.id, r.updatedAt]), [[markId, 1760000000000]]);
});

test('a mark is de-duplicated within its own team only', async () => {
  const env = await setup();
  const a = await signSyncToken(SECRET, 'candA', 'dev1');
  const b = await signSyncToken(SECRET, 'candB', 'dev1');
  const markId = 'mark:17/125/6313/1:42';

  await pushRecords(env, a, [markRecord(markId)]);
  const res = await pushRecords(env, b, [markRecord(markId)]);
  assert.deepEqual(await res.json(), { accepted: 1, cursor: 1 });
  assert.deepEqual(markIds(env, 'candB'), [markId]);

  for (const [token, candidateId] of [[a, 'candA'], [b, 'candB']]) {
    const pulled = await (await pullSince(env, token, 0)).json();
    assert.equal(pulled.records.length, 1, candidateId);
  }
});

test('records other than marks keep every push', async () => {
  const env = await setup();
  const token = await signSyncToken(SECRET, 'candA', 'dev1');
  await pushRecords(env, token, [record('contact:w:1'), record('contact:w:1')]);
  await pushRecords(env, token, [record('contact:w:1')]);
  assert.equal(counter(env, 'candA'), 3);
  assert.deepEqual(markIds(env, 'candA'), []);
});
