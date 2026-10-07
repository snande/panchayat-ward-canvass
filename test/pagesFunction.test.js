// The Cloudflare Pages Function that serves /roll on the shell's origin.
// No network: env.ASSETS and the upstream fetch are stubbed.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (rel) => readFileSync(new URL('../' + rel, import.meta.url), 'utf8');
const ORIGIN = 'https://canvass.takshavid.com';

function assetsServing(body, status = 200) {
  return { fetch: async () => new Response(body, { status }) };
}

test('_routes.json sends /roll to the function', () => {
  const routes = JSON.parse(read('_routes.json'));
  assert.ok(routes.include.includes('/roll'));
});

test('a url outside the constituency config answers 403 marked as the relay', async () => {
  const { onRequest } = await import('../functions/roll.js?ok');
  const env = { ASSETS: assetsServing(read('config/constituency.json')) };
  const res = await onRequest({
    request: new Request(`${ORIGIN}/roll?url=${encodeURIComponent('https://example.com/x.pdf')}`),
    env,
  });
  assert.equal(res.status, 403);
  assert.equal(res.headers.get('x-roll-relay'), '1');
});

test('an unavailable config answers a marked 503 and retries on the next request', async () => {
  const { onRequest } = await import('../functions/roll.js?down');
  const request = () => new Request(`${ORIGIN}/roll?url=x`);
  const down = await onRequest({ request: request(), env: { ASSETS: assetsServing('', 500) } });
  assert.equal(down.status, 503);
  assert.equal(down.headers.get('x-roll-relay'), '1');
  const up = await onRequest({ request: request(), env: { ASSETS: assetsServing(read('config/constituency.json')) } });
  assert.equal(up.status, 403);
});
