// SMS tally codec (issue #84): round trip, 160-character limit, serials only,
// and rejection of bad checksums, unknown prefixes and other teams' tallies.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { encodeTallySms, decodeTallySms } from '../src/tally/smsCodec.js';

const TEAM = 'cand-17';
const SHAPE = /^PT1 [A-Za-z0-9_-]+ [A-Za-z0-9_-]+ [0-9a-z]+(\.[0-9a-z]+)* [0-9a-f]{4}$/;
// GSM 03.38 default alphabet, basic table only.
const GSM7 = /^[@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !"#¤%&'()*+,\-./0-9:;<=>?¡A-ZÄÖÑÜ§¿a-zäöñüà]*$/;

function decodeAll(messages, team = TEAM) {
  const seen = new Set();
  for (const m of messages) {
    const r = decodeTallySms(m, team);
    assert.equal(r.ok, true, `${m}: ${r.reason}`);
    for (const s of r.serials) seen.add(s);
  }
  return [...seen].sort((a, b) => a - b);
}

test('round trip returns the same serial set, sorted and de-duplicated', () => {
  for (const serials of [[1], [5, 3, 3, 900, 42], Array.from({ length: 1200 }, (_, i) => 1200 - i)]) {
    const messages = encodeTallySms({ teamTag: TEAM, workerId: 'w7', serials });
    assert.ok(messages.length >= 1);
    assert.deepEqual(decodeAll(messages), [...new Set(serials)].sort((a, b) => a - b));
  }
});

test('each message is at most 160 GSM-7 characters with the PT1 shape', () => {
  const serials = Array.from({ length: 800 }, (_, i) => i * 37 + 1);
  const messages = encodeTallySms({ teamTag: TEAM, workerId: 'worker_12', serials });
  assert.ok(messages.length > 1);
  for (const m of messages) {
    assert.ok(m.length <= 160, `${m.length}`);
    assert.match(m, SHAPE);
    assert.match(m, GSM7);
    assert.ok(m.startsWith(`PT1 ${TEAM} worker_12 `));
  }
});

test('every message decodes on its own and the parts do not overlap', () => {
  const serials = Array.from({ length: 300 }, (_, i) => i + 1);
  const messages = encodeTallySms({ teamTag: TEAM, workerId: 'w1', serials });
  let total = 0;
  for (const m of messages) {
    const r = decodeTallySms(m, TEAM);
    assert.equal(r.ok, true);
    assert.equal(r.workerId, 'w1');
    total += r.serials.length;
  }
  assert.equal(total, serials.length);
});

test('serials are base36 and nothing but serials is carried', () => {
  const [m] = encodeTallySms({ teamTag: TEAM, workerId: 'w1', serials: [35, 36, 1295] });
  assert.equal(m.split(' ')[3], 'z.10.zz');
  assert.equal(m.split(' ').length, 5);
  assert.throws(() => encodeTallySms({ teamTag: TEAM, workerId: 'w1', serials: ['9876543210'] }));
  assert.throws(() => encodeTallySms({ teamTag: TEAM, workerId: 'w1', serials: [0] }));
  assert.throws(() => encodeTallySms({ teamTag: TEAM, workerId: 'सुनीता', serials: [1] }));
  assert.throws(() => encodeTallySms({ teamTag: 'a b', workerId: 'w1', serials: [1] }));
});

test('no serials give no messages', () => {
  assert.deepEqual(encodeTallySms({ teamTag: TEAM, workerId: 'w1', serials: [] }), []);
});

test('surrounding whitespace and line breaks from SMS apps are tolerated', () => {
  const [m] = encodeTallySms({ teamTag: TEAM, workerId: 'w2', serials: [4, 8, 15] });
  const wrapped = `\r\n  ${m.replaceAll(' ', ' \r\n')}\n\n `;
  assert.deepEqual(decodeTallySms(wrapped, TEAM), { ok: true, workerId: 'w2', serials: [4, 8, 15] });
});

test('a bad checksum is rejected', () => {
  const [m] = encodeTallySms({ teamTag: TEAM, workerId: 'w2', serials: [4, 8, 15] });
  const sum = m.slice(-4);
  const bad = m.slice(0, -4) + (sum[0] === '0' ? '1' : '0') + sum.slice(1);
  assert.deepEqual(decodeTallySms(bad, TEAM), { ok: false, reason: 'checksum' });
  const tampered = m.replace(' 4.8.f ', ' 4.8.g ');
  assert.notEqual(tampered, m);
  assert.equal(decodeTallySms(tampered, TEAM).ok, false);
});

test('an unknown prefix or a malformed message is rejected', () => {
  const [m] = encodeTallySms({ teamTag: TEAM, workerId: 'w2', serials: [4] });
  assert.deepEqual(decodeTallySms(m.replace('PT1', 'PT2'), TEAM), { ok: false, reason: 'prefix' });
  assert.deepEqual(decodeTallySms('hello there', TEAM), { ok: false, reason: 'prefix' });
  assert.equal(decodeTallySms('', TEAM).ok, false);
  assert.equal(decodeTallySms('PT1 cand-17 w2', TEAM).ok, false);
});

test("another candidate's teamTag is rejected", () => {
  const [m] = encodeTallySms({ teamTag: 'cand-99', workerId: 'w2', serials: [4] });
  assert.deepEqual(decodeTallySms(m, TEAM), { ok: false, reason: 'team' });
  assert.equal(decodeTallySms(m, 'cand-99').ok, true);
});
