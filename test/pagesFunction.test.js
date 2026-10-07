// The Cloudflare Pages Function that serves /roll on the shell's origin.
// No network: env.ASSETS and the upstream fetch are stubbed.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { allowedRollUrls } from '../relay/rollRelay.mjs';

const read = (rel) => readFileSync(new URL('../' + rel, import.meta.url), 'utf8');
const config = read('config/constituency.json');
const ORIGIN = 'https://canvass.takshavid.com';
const WARD_URL = [...allowedRollUrls(JSON.parse(config))][0];
const PDF = new TextEncoder().encode('%PDF-1.4\nbody bytes\n');

function assetsServing(body, status = 200) {
  const calls = [];
  return {
    calls,
    fetch: async (request) => {
      calls.push(request.url);
      return new Response(body, { status });
    },
  };
}

const rollRequest = (target, init) =>
  new Request(`${ORIGIN}/roll?url=${encodeURIComponent(target)}`, init);

test('_routes.json sends only /roll to the function', () => {
  const routes = JSON.parse(read('_routes.json'));
  assert.deepEqual(routes.include, ['/roll']);
});

test('a url outside the constituency config answers 403 marked as the relay', async () => {
  const { onRequest } = await import('../functions/roll.js?forbidden');
  const res = await onRequest({ request: rollRequest('https://example.com/x.pdf'), env: { ASSETS: assetsServing(config) } });
  assert.equal(res.status, 403);
  assert.equal(res.headers.get('x-roll-relay'), '1');
});

test('a catalogue ward url is relayed with status, type and body intact', async () => {
  const { onRequest } = await import('../functions/roll.js?success');
  const realFetch = globalThis.fetch;
  const upstream = [];
  globalThis.fetch = async (url) => {
    upstream.push(String(url));
    return new Response(PDF, { headers: { 'Content-Type': 'application/pdf' } });
  };
  try {
    const res = await onRequest({ request: rollRequest(WARD_URL), env: { ASSETS: assetsServing(config) } });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'application/pdf');
    assert.equal(res.headers.get('x-roll-relay'), '1');
    assert.deepEqual(new Uint8Array(await res.arrayBuffer()), PDF);
    assert.deepEqual(upstream, [new URL(WARD_URL).href]);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('a non-GET request answers 405', async () => {
  const { onRequest } = await import('../functions/roll.js?method');
  const res = await onRequest({ request: rollRequest(WARD_URL, { method: 'POST' }), env: { ASSETS: assetsServing(config) } });
  assert.equal(res.status, 405);
  assert.equal(res.headers.get('x-roll-relay'), '1');
});

test('the config is read once and reused after a successful load', async () => {
  const { onRequest } = await import('../functions/roll.js?cache');
  const assets = assetsServing(config);
  for (let i = 0; i < 3; i += 1) {
    const res = await onRequest({ request: rollRequest('https://example.com/x.pdf'), env: { ASSETS: assets } });
    assert.equal(res.status, 403);
  }
  assert.equal(assets.calls.length, 1);
});

test('an unavailable config answers a marked 503 and retries on the next request', async () => {
  const { onRequest } = await import('../functions/roll.js?down');
  const down = await onRequest({ request: rollRequest('x'), env: { ASSETS: assetsServing('', 500) } });
  assert.equal(down.status, 503);
  assert.equal(down.headers.get('x-roll-relay'), '1');
  const up = await onRequest({ request: rollRequest('x'), env: { ASSETS: assetsServing(config) } });
  assert.equal(up.status, 403);
});
