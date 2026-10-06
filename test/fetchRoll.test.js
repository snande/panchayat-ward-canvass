// Roll download transport (issue #16), run by `npm test`.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  fetchRoll, rollRequestUrl, RollFetchError, ROLL_TRANSPORT, TRANSPORTS, RELAY_PATH,
} from '../src/roll/fetchRoll.js';

const read = (rel) => readFileSync(new URL('../' + rel, import.meta.url));
const WARD1 = 'https://esuchiroll.rajasthan.gov.in/Publication_PDF_2026/PRI/Final/125/BADLI-Ward%20No-001.pdf';
const SELECTION = { district: '17', samiti: '125', panchayat: '6313', ward: '1', pdfUrl: WARD1 };
const PDF = read('fixtures/badli-ward1.pdf');

function pdfResponse(bytes = PDF, init = {}) {
  return new Response(bytes, { status: 200, headers: { 'Content-Type': 'application/pdf' }, ...init });
}

function recorder(respond) {
  const calls = [];
  const fetch = async (url, init) => {
    calls.push({ url, init });
    return respond(url, init);
  };
  return { calls, fetch };
}

test('the transport is the verdict line of the research doc', () => {
  const lines = read('docs/research/sec-roll-source.md').toString('utf8').split('\n')
    .map((l) => l.trim()).filter(Boolean);
  const verdict = lines[lines.length - 1];
  assert.ok(TRANSPORTS.includes(verdict), `verdict line ${verdict}`);
  assert.equal(ROLL_TRANSPORT, verdict);
});

test('relay-required requests the same-origin relay with the encoded SEC URL', async () => {
  const { calls, fetch } = recorder(() => pdfResponse());
  const buffer = await fetchRoll(SELECTION, { fetch, transport: 'relay-required' });
  assert.ok(buffer instanceof ArrayBuffer);
  assert.equal(buffer.byteLength, PDF.byteLength);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, `${RELAY_PATH}?url=${encodeURIComponent(WARD1)}`);
  assert.ok(calls[0].url.startsWith('/roll?url=https%3A%2F%2Fesuchiroll.'));
  assert.equal(new URL(calls[0].url, 'https://canvass.example').searchParams.get('url'), WARD1);
  assert.equal(calls[0].init.credentials, 'same-origin');
});

test('direct-fetch requests the SEC URL itself', async () => {
  const { calls, fetch } = recorder(() => pdfResponse());
  await fetchRoll(SELECTION, { fetch, transport: 'direct-fetch' });
  assert.equal(calls[0].url, WARD1);
});

test('the default transport is the pinned verdict', async () => {
  const { calls, fetch } = recorder(() => pdfResponse());
  await fetchRoll(SELECTION, { fetch });
  assert.equal(calls[0].url, rollRequestUrl(WARD1, ROLL_TRANSPORT));
  assert.throws(() => rollRequestUrl(WARD1, 'upload'), /unknown roll transport/);
});

for (const [name, respond, status] of [
  ['a 403 from the relay', () => new Response('no', { status: 403 }), 403],
  ['a 502 from the relay', () => new Response('no', { status: 502 }), 502],
  ['an offline 503 from the service worker', () => new Response('', { status: 503 }), 503],
  ['a network error', () => { throw new TypeError('Failed to fetch'); }, null],
  ['an HTML page instead of a PDF', () => pdfResponse(Buffer.from('<html></html>')), null],
  ['an empty body', () => pdfResponse(new Uint8Array(0)), null],
]) {
  test(`${name} rejects with RollFetchError`, async () => {
    const { fetch } = recorder(respond);
    await assert.rejects(fetchRoll(SELECTION, { fetch }), (err) => {
      assert.ok(err instanceof RollFetchError);
      assert.equal(err.status, status);
      return true;
    });
  });
}

test('no selection or a selection without a URL never touches the network', async () => {
  const { calls, fetch } = recorder(() => pdfResponse());
  for (const sel of [null, undefined, {}, { pdfUrl: '' }, { pdfUrl: 5 }]) {
    await assert.rejects(fetchRoll(sel, { fetch }), RollFetchError);
  }
  assert.equal(calls.length, 0);
});
