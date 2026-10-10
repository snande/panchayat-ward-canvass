// Same-origin roll relay (issue #16), run by `npm test`. The upstream SEC
// server is stubbed; nothing here leaves the machine.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';

import { allowedRollUrls, createRollRelay, isSecRollUrl, MAX_PDF_BYTES } from '../relay/rollRelay.mjs';
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
  return createRollRelay({ allowedUrls: allowedRollUrls(config), isAllowedUrl: isSecRollUrl, fetch: up.fetch });
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

test('a ward\'s supplementary roll URLs are allowed too; nothing else is', async () => {
  const SUPP = 'https://esuchiroll.rajasthan.gov.in/Publication_PDF_2026/PRI/Supplement/60/ALMAS-Ward%20No-001.pdf';
  const withSupp = { districts: [{ samitis: [{ panchayats: [{ wards: [
    { pdfUrl: WARD1, supplementPdfUrls: [SUPP, 'http://insecure.example/s.pdf', 7] }] }] }] }] };
  assert.deepEqual([...allowedRollUrls(withSupp)].sort(), [WARD1, SUPP].sort());
  const up = upstream();
  const relay = createRollRelay({ allowedUrls: allowedRollUrls(withSupp), fetch: up.fetch });
  assert.equal((await relay(new Request(rollUrl(SUPP)))).status, 200);
  assert.equal((await relay(new Request(rollUrl(SUPP), { method: 'POST', body: 'x' }))).status, 405);
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
    rollUrl(WARD1.replace('001', '0008')),
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

test('a chunked upstream with no Content-Length is cut off at the cap', async () => {
  let pulled = 0;
  const stream = new ReadableStream({
    pull(controller) {
      pulled += 1;
      controller.enqueue(new Uint8Array(1024).fill(0x41));
      if (pulled > 10_000) controller.close();
    },
  });
  const up = upstream(() => new Response(stream, { headers: { 'Content-Type': 'application/pdf' } }));
  const relay = createRollRelay({ allowedUrls: allowedRollUrls(config), fetch: up.fetch, maxBytes: 4096 });
  const res = await relay(new Request(rollUrl(WARD1)));
  assert.equal(res.status, 502);
  assert.ok(pulled < 20, `pulled ${pulled} chunks`);
});

test('a stalled upstream times out with 502 instead of hanging', async () => {
  const hang = (url, init) => new Promise((resolve, reject) => {
    init.signal.addEventListener('abort', () => reject(init.signal.reason));
  });
  const relay = createRollRelay({ allowedUrls: allowedRollUrls(config), fetch: hang, timeoutMs: 20 });
  const res = await relay(new Request(rollUrl(WARD1)));
  assert.equal(res.status, 502);

  // A source that sends headers, then stalls mid-body, is cut off too.
  const stall = async (url, init) => {
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('%PDF-1.4'));
        init.signal.addEventListener('abort', () => controller.error(init.signal.reason));
      },
    });
    return new Response(body, { headers: { 'Content-Type': 'application/pdf' } });
  };
  const slow = createRollRelay({ allowedUrls: allowedRollUrls(config), fetch: stall, timeoutMs: 20 });
  assert.equal((await slow(new Request(rollUrl(WARD1)))).status, 502);
});

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

// Statewide catalogue (issue #198): GET /roll?url=<u> relays any u the
// catalogue names (data/sec/catalogue/index.json's Final/ and Supplement/
// templates, .../<samiti id>/<NAME>-Ward%20No-<NNN>.pdf), not only the Badli
// wards of config/constituency.json.
const CATALOGUE = new URL('../data/sec/catalogue/', import.meta.url);
const SHARDS = readdirSync(CATALOGUE).filter((f) => f.endsWith('.json') && f !== 'index.json');
const shard = (file) => JSON.parse(readFileSync(new URL(file, CATALOGUE), 'utf8'));
const JALORE = shard('jalore.json').panchayats.find((p) => p.wards[0].pdfUrl.includes('/AADARSH%20SANKAD-'));
const STATE_WARD = JALORE.wards[0].pdfUrl;
const STATE_SUPP = JALORE.wards[1].supplementUrl;

test('every ward URL in every catalogue shard is an SEC roll URL', () => {
  const index = JSON.parse(readFileSync(new URL('index.json', CATALOGUE), 'utf8'));
  // The templates isSecRollUrl encodes: .../Final/ and .../Supplement/<samiti id>/<NAME>-Ward%20No-<NNN>.pdf.
  const SUFFIX = '{samiti_id}/{PANCHAYAT_NAME}-Ward%20No-{NNN}.pdf';
  assert.equal(index.pdfUrlTemplates.final,
    `https://esuchiroll.rajasthan.gov.in/Publication_PDF_2026/PRI/Final/${SUFFIX}`);
  assert.equal(index.pdfUrlTemplates.supplement,
    `https://esuchiroll.rajasthan.gov.in/Publication_PDF_2026/PRI/Supplement/${SUFFIX}`);
  assert.ok(SHARDS.length > 30);
  let count = 0;
  for (const file of SHARDS) {
    for (const p of shard(file).panchayats) {
      for (const w of p.wards) {
        for (const u of [w.pdfUrl, w.supplementUrl]) {
          if (u === null || u === undefined) continue;
          assert.ok(isSecRollUrl(u), `${file}: ${u}`);
          count += 1;
        }
      }
    }
  }
  assert.ok(count > 100_000, String(count));
  for (const w of config.districts[0].samitis[0].panchayats[0].wards) assert.ok(isSecRollUrl(w.pdfUrl), w.pdfUrl);
});

test('a non-Badli ward and supplement roll from the catalogue are relayed', async () => {
  assert.ok(!allowedRollUrls(config).has(STATE_WARD));
  assert.match(STATE_SUPP, /\/PRI\/Supplement\//);
  for (const u of [STATE_WARD, STATE_SUPP]) {
    const up = upstream();
    const res = await relayWith(up)(new Request(rollUrl(u)));
    assert.equal(res.status, 200, u);
    assert.equal(res.headers.get('content-type'), 'application/pdf');
    assert.deepEqual(Buffer.from(await res.arrayBuffer()), PDF);
    assert.deepEqual(up.calls.map((c) => c.url), [u]);
  }
});

test('every Badli ward in config/constituency.json still relays', async () => {
  for (const w of config.districts[0].samitis[0].panchayats[0].wards) {
    const up = upstream();
    assert.equal((await relayWith(up)(new Request(rollUrl(w.pdfUrl)))).status, 200, w.pdfUrl);
    // The config set alone, without the template predicate, still admits them.
    const configOnly = createRollRelay({ allowedUrls: allowedRollUrls(config), fetch: up.fetch });
    assert.equal((await configOnly(new Request(rollUrl(w.pdfUrl)))).status, 200, w.pdfUrl);
  }
});

test('every u outside the SEC roll templates answers 403 "not an SEC roll PDF" and contacts no server', async () => {
  const up = upstream();
  const relay = relayWith(up);
  const base = 'https://esuchiroll.rajasthan.gov.in/Publication_PDF_2026/PRI';
  const forbidden = [
    STATE_WARD.replace('esuchiroll.rajasthan.gov.in', 'evil.example'),
    STATE_WARD.replace('esuchiroll.rajasthan.gov.in', 'esuchiroll.rajasthan.gov.in.evil.example'),
    STATE_WARD.replace('esuchiroll.rajasthan.gov.in', 'x.esuchiroll.rajasthan.gov.in'),
    STATE_WARD.replace('https:', 'http:'),
    STATE_WARD.replace('esuchiroll.rajasthan.gov.in', 'esuchiroll.rajasthan.gov.in:8443'),
    STATE_WARD.replace('https://', 'https://user:pw@'),
    STATE_WARD + '?',
    STATE_WARD + '?x=1',
    STATE_WARD + '#',
    STATE_WARD + '#frag',
    `${base}/Final2/325/AADARSH%20SANKAD-Ward%20No-001.pdf`,
    `${base}/final/325/AADARSH%20SANKAD-Ward%20No-001.pdf`,
    `${base}/Supplements/325/AADARSH%20SANKAD-Ward%20No-001.pdf`,
    `${base}/Final/325/sub/AADARSH%20SANKAD-Ward%20No-001.pdf`,
    `${base}/Final/AADARSH%20SANKAD-Ward%20No-001.pdf`,
    'https://esuchiroll.rajasthan.gov.in/Publication_PDF_2025/PRI/Final/325/AADARSH%20SANKAD-Ward%20No-001.pdf',
    'https://esuchiroll.rajasthan.gov.in/ErrorPage.aspx',
    `${base}/Final/32a/AADARSH%20SANKAD-Ward%20No-001.pdf`,
    `${base}/Final/325/AADARSH%20SANKAD-Ward%20No-01.pdf`,
    `${base}/Final/325/AADARSH%20SANKAD-Ward%20No-0001.pdf`,
    `${base}/Final/325/AADARSH%20SANKAD-Ward%20No-001.PDF`,
    `${base}/Final/325/AADARSH%20SANKAD-Ward%20No-001`,
    `${base}/Final/325/Aadarsh%20Sankad-Ward%20No-001.pdf`,
    `${base}/Final/325/AADARSH SANKAD-Ward%20No-001.pdf`,
    `${base}/Final/325/AADARSH+SANKAD-Ward%20No-001.pdf`,
    `${base}/Final/325/AADARSH%2fSANKAD-Ward%20No-001.pdf`,
    `${base}/Final/325/AADARSH%2FSANKAD-Ward%20No-001.pdf`,
    `${base}/Final/325/AADARSH%5CSANKAD-Ward%20No-001.pdf`,
    `${base}/Final/325/..%2F..%2FX-Ward%20No-001.pdf`,
    `${base}/Final/325/%2E%2E-Ward%20No-001.pdf`,
    `${base}/Final/325/../325/BADLI-Ward%20No-001.pdf`,
    `${base}/Supplement/325/../325/BADLI-Ward%20No-001.pdf`,
    `${base}/Final/325/%2e%2e/BADLI-Ward%20No-001.pdf`,
    `${base}/Final/195/DEOLI%20%28auwa%29-Ward%20No-001.pdf`,
    `${base}/Final/195/DEOLI%20(AUWA)-Ward%20No-001.pdf`,
    `${base}/Final/195/DEOLI%20%2cAUWA-Ward%20No-001.pdf`,
    `${base}/Final/195/X%00Y-Ward%20No-001.pdf`,
    `${base}/Final/195/X%E0%A4-Ward%20No-001.pdf`,
    `${base}/Final/125/-Ward%20No-001.pdf`,
  ];
  for (const u of forbidden) {
    assert.equal(isSecRollUrl(u), false, u);
    const res = await relay(new Request(rollUrl(u)));
    assert.equal(res.status, 403, u);
    const body = await res.text();
    assert.match(body, /not an SEC roll PDF/, u);
    assert.doesNotMatch(body, /constituency config/);
  }
  const twice = `${ORIGIN}/roll?url=${encodeURIComponent(STATE_WARD)}&url=${encodeURIComponent(STATE_SUPP)}`;
  assert.equal((await relay(new Request(twice))).status, 403);
  assert.equal(isSecRollUrl(null), false);
  assert.equal(isSecRollUrl(42), false);
  assert.equal(up.calls.length, 0);
  assert.throws(() => createRollRelay({ allowedUrls: new Set(), isAllowedUrl: 'yes' }), TypeError);
});

test('the default server relays a statewide catalogue ward', async (t) => {
  const up = upstream();
  const server = await createAppServer({ fetch: up.fetch });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const { port } = server.address();
  const ok = await get(port, `/roll?url=${encodeURIComponent(STATE_WARD)}`);
  assert.equal(ok.status, 200);
  assert.deepEqual(ok.body, PDF);
  const denied = await get(port, '/roll?url=https://example.com/x.pdf');
  assert.equal(denied.status, 403);
  assert.equal(denied.body.toString('utf8'), 'url is not an SEC roll PDF\n');
  assert.deepEqual(up.calls.map((c) => c.url), [STATE_WARD]);
});

test('the Pages Function relays a statewide catalogue ward and the config wards', async (t) => {
  const up = upstream();
  const realFetch = globalThis.fetch;
  globalThis.fetch = up.fetch; // the function's relay takes its upstream fetch from the global
  t.after(() => { globalThis.fetch = realFetch; });
  const { onRequest } = await import('../functions/roll.js');
  const env = {
    ASSETS: {
      fetch: async (req) => {
        assert.equal(new URL(req.url).pathname, '/config/constituency.json');
        return new Response(read('config/constituency.json'), { headers: { 'Content-Type': 'application/json' } });
      },
    },
  };
  for (const u of [STATE_WARD, STATE_SUPP, WARD1]) {
    const res = await onRequest({ request: new Request(rollUrl(u)), env });
    assert.equal(res.status, 200, u);
  }
  const denied = await onRequest({ request: new Request(rollUrl('https://example.com/x.pdf')), env });
  assert.equal(denied.status, 403);
  assert.deepEqual(up.calls.map((c) => c.url), [STATE_WARD, STATE_SUPP, WARD1]);
});
