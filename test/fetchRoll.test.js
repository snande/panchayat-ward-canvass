// Roll download transport (issue #16), run by `npm test`.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  fetchRoll, fetchSupplements, supplementUrls, rollRequestUrl, RollFetchError, ROLL_TRANSPORT, TRANSPORTS, RELAY_PATH,
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

// --- supplementary rolls (issue #127) ----------------------------------------------

const SUPP = 'https://esuchiroll.rajasthan.gov.in/Publication_PDF_2026/PRI/Supplement/125/BADLI-Ward%20No-001.pdf';

test('each supplementary roll is a same-origin GET to the relay, the same as the roll', async () => {
  const { calls, fetch } = recorder(() => pdfResponse());
  const results = await fetchSupplements({ ...SELECTION, supplementPdfUrls: [SUPP, `${SUPP}?n=3`] }, { fetch });
  assert.deepEqual(calls.map((c) => c.url), [
    `${RELAY_PATH}?url=${encodeURIComponent(SUPP)}`,
    `${RELAY_PATH}?url=${encodeURIComponent(`${SUPP}?n=3`)}`,
  ]);
  for (const c of calls) {
    assert.equal(c.init.method, undefined, 'a GET: no method, no body');
    assert.equal(c.init.body, undefined);
    assert.equal(c.init.credentials, 'same-origin');
  }
  assert.deepEqual(results.map((r) => [r.url, r.ok, r.buffer.byteLength]), [[SUPP, true, PDF.byteLength], [`${SUPP}?n=3`, true, PDF.byteLength]]);
});

test('a supplementary roll that fails is reported, not thrown, and the others still download', async () => {
  const { calls, fetch } = recorder((url) => (url.includes('n%3D2') ? new Response('no', { status: 502 }) : pdfResponse()));
  const results = await fetchSupplements({ ...SELECTION, supplementPdfUrls: [`${SUPP}?n=2`, SUPP] }, { fetch });
  assert.equal(calls.length, 2);
  assert.equal(results[0].ok, false);
  assert.ok(results[0].error instanceof RollFetchError);
  assert.equal(results[0].error.status, 502);
  assert.equal(results[1].ok, true);
});

test('a selection without supplementary rolls sends no request', async () => {
  const { calls, fetch } = recorder(() => pdfResponse());
  for (const sel of [SELECTION, null, { ...SELECTION, supplementPdfUrls: 'x' }, { ...SELECTION, supplementPdfUrls: ['', 5] }]) {
    assert.deepEqual(await fetchSupplements(sel, { fetch }), []);
  }
  assert.deepEqual(supplementUrls({ supplementPdfUrls: [SUPP, null] }), [SUPP]);
  assert.equal(calls.length, 0);
});
