// Same-origin roll relay (issue #16), run by `npm test`. The upstream SEC
// server is stubbed; nothing here leaves the machine.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';

import { allowedRollUrls, createRollRelay, MAX_PDF_BYTES } from '../relay/rollRelay.mjs';
import { createAppServer, publicFile } from '../relay/server.mjs';

const read = (rel) => readFileSync(new URL('../' + rel, import.meta.url));
const config = JSON.parse(read('config/constituency.json').toString('utf8'));
const PDF = read('fixtures/badli-ward1.pdf');
const WARD1 = 'https://esuchiroll.rajasthan.gov.in/Publication_PDF_2026/PRI/Final/125/BADLI-Ward%20No-001.pdf';
const ORIGIN = 'https://canvass.takshavid.com';

const rollUrl = (target) => `${ORIGIN}/roll?url=${encodeURIComponent(target)}`;

function upstream(respond = () => new Response(PDF, { headers: { 'Content-Type': 'application/pdf' } })) {
  const calls = [];
  return {
    calls,
    fetch: async (url, init) => {
      calls.push({ url, init });
      return respond(url, init);
    },
  };
}

function relayWith(up) {
  return createRollRelay({ allowedUrls: allowedRollUrls(config), fetch: up.fetch });
}

test('the allowlist is exactly the ward pdfUrls of the config', () => {
  const allowed = allowedRollUrls(config);
  const wards = config.districts[0].samitis[0].panchayats[0].wards.map((w) => w.pdfUrl);
  assert.deepEqual([...allowed].sort(), [...wards].sort());
  assert.ok(allowed.has(WARD1));
  assert.equal(allowedRollUrls(null).size, 0);
  assert.equal(allowedRollUrls({ districts: [{ samitis: [{ panchayats: [{ wards: [
    { pdfUrl: 'http://insecure.example/x.pdf' }, { pdfUrl: 'not a url' }] }] }] }] }).size, 0);
});

test('a configured ward URL is relayed as a PDF', async () => {
  const up = upstream();
  const res = await relayWith(up)(new Request(rollUrl(WARD1)));
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'application/pdf');
  assert.equal(res.headers.get('access-control-allow-origin'), null);
  assert.equal(res.headers.get('cache-control'), 'no-store');
  assert.deepEqual(Buffer.from(await res.arrayBuffer()), PDF);
  assert.deepEqual(up.calls.map((c) => c.url), [WARD1]);
  assert.equal(up.calls[0].init.redirect, 'manual');
});

test('any URL outside the config answers 403 and contacts no server', async () => {
  const up = upstream();
  const relay = relayWith(up);
  const forbidden = [
    rollUrl('https://example.com/x.pdf'),
    `${ORIGIN}/roll?url=https://example.com/x.pdf`,
    rollUrl(WARD1.replace('001', '008')),
    rollUrl(WARD1.replace('https:', 'http:')),
    rollUrl(WARD1 + '?x=1'),
    rollUrl(WARD1 + '#frag'),
    rollUrl(WARD1.replace('esuchiroll.rajasthan.gov.in', 'esuchiroll.rajasthan.gov.in.evil.example')),
    rollUrl('file:///etc/passwd'),
    rollUrl('http://127.0.0.1/'),
    rollUrl('not a url'),
    `${ORIGIN}/roll`,
    `${ORIGIN}/roll?url=`,
    `${ORIGIN}/roll?url=${encodeURIComponent(WARD1)}&url=${encodeURIComponent('https://example.com/x.pdf')}`,
  ];
  for (const url of forbidden) {
    const res = await relay(new Request(url));
    assert.equal(res.status, 403, url);
  }
  assert.equal(up.calls.length, 0);
});

test('only GET is relayed', async () => {
  const up = upstream();
  const relay = relayWith(up);
  for (const method of ['POST', 'PUT', 'DELETE', 'HEAD']) {
    const res = await relay(new Request(rollUrl(WARD1), { method }));
    assert.equal(res.status, 405, method);
    assert.equal(res.headers.get('allow'), 'GET');
  }
  assert.equal((await relay(new Request(`${ORIGIN}/other?url=${encodeURIComponent(WARD1)}`))).status, 404);
  assert.equal(up.calls.length, 0);
});

for (const [name, respond] of [
  ['an unreachable source', () => { throw new TypeError('fetch failed'); }],
  ['a 302 for a missing ward', () => new Response(null, { status: 302, headers: { Location: '/err' } })],
  ['a 404', () => new Response('x', { status: 404, headers: { 'Content-Type': 'application/pdf' } })],
  ['an HTML body', () => new Response('<html>', { headers: { 'Content-Type': 'text/html' } })],
  ['a PDF type with a non-PDF body', () => new Response('<html>', { headers: { 'Content-Type': 'application/pdf' } })],
  ['an oversized PDF', () => new Response(PDF, {
    headers: { 'Content-Type': 'application/pdf', 'Content-Length': String(MAX_PDF_BYTES + 1) } })],
]) {
  test(`${name} upstream answers 502`, async () => {
    const res = await relayWith(upstream(respond))(new Request(rollUrl(WARD1)));
    assert.equal(res.status, 502);
  });
}

test('static files: only the shell is public, no traversal, no fixtures', () => {
  assert.equal(publicFile('/'), 'index.html');
  assert.equal(publicFile('/js/picker.js'), 'js/picker.js');
  assert.equal(publicFile('/src/strings.hi.json'), 'src/strings.hi.json');
  assert.equal(publicFile('/fonts/noto-sans-devanagari-subset.woff2'), 'fonts/noto-sans-devanagari-subset.woff2');
  for (const p of ['/fixtures/badli-ward1.pdf', '/fixtures/badli-ward1-expected.json', '/package.json',
    '/../package.json', '/js/../fixtures/badli-ward1.pdf', '/js/%2e%2e/package.json', '/.git/config',
    '/src/.hidden.js', '/relay/server.mjs', '/js//app.js', '/js/%E0%A4', '/CNAME']) {
    assert.equal(publicFile(p), null, p);
  }
});

function get(port, path) {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: '127.0.0.1', port, path, method: 'GET' }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    req.end();
  });
}

test('the server: /roll guard answers 403 like the issue curl, and serves the shell', async (t) => {
  const up = upstream();
  const server = await createAppServer({ relay: relayWith(up) });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const { port } = server.address();

  assert.equal((await get(port, '/roll?url=https://example.com/x.pdf')).status, 403);
  const ok = await get(port, `/roll?url=${encodeURIComponent(WARD1)}`);
  assert.equal(ok.status, 200);
  assert.equal(ok.headers['content-type'], 'application/pdf');
  assert.deepEqual(ok.body, PDF);

  const index = await get(port, '/');
  assert.equal(index.status, 200);
  assert.match(index.headers['content-type'], /^text\/html/);
  assert.match(index.body.toString('utf8'), /id="roll"/);
  assert.equal((await get(port, '/js/app.js')).headers['content-type'], 'text/javascript; charset=utf-8');
  assert.equal((await get(port, '/fixtures/badli-ward1.pdf')).status, 404);
  assert.equal((await get(port, '/../package.json')).status, 404);
  assert.equal(up.calls.length, 1);
});

test('the default server builds its allowlist from config/constituency.json', async (t) => {
  const server = await createAppServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const res = await get(server.address().port, '/roll?url=https://example.com/x.pdf');
  assert.equal(res.status, 403);
});
