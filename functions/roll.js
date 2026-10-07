// Cloudflare Pages Function serving GET /roll?url=... on the shell's own
// origin. It mounts the Engineer's relay (relay/rollRelay.mjs) unchanged:
// the handler is written against the standard Request/Response API, so the
// same code that relay/server.mjs runs under Node runs here.
//
// The allowlist is the ward pdfUrl set of config/constituency.json, read
// through the Pages static-asset binding (env.ASSETS) on the first request
// and cached for the lifetime of the isolate, so a catalogue update deploys
// with the site and needs no separate step.
//
// Only this path is routed to a function (_routes.json); every other URL is
// a static file, so the shell's offline precache and install flow are
// unaffected.

import { allowedRollUrls, createRollRelay } from '../relay/rollRelay.mjs';

let relayPromise = null;

async function buildRelay(request, env) {
  const configUrl = new URL('/config/constituency.json', request.url);
  const response = await env.ASSETS.fetch(new Request(configUrl, { method: 'GET' }));
  if (!response.ok) throw new Error(`constituency config unavailable: HTTP ${response.status}`);
  const config = await response.json();
  return createRollRelay({ allowedUrls: allowedRollUrls(config) });
}

// Marks every answer from this function so a live smoke test can tell the
// relay apart from a static host's 404 or HTML fallback.
function marked(response) {
  const out = new Response(response.body, response);
  out.headers.set('X-Roll-Relay', '1');
  return out;
}

export async function onRequest({ request, env }) {
  if (!relayPromise) {
    relayPromise = buildRelay(request, env).catch((err) => {
      relayPromise = null;
      throw err;
    });
  }
  let relay;
  try {
    relay = await relayPromise;
  } catch {
    return marked(new Response('relay not ready\n', {
      status: 503,
      headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' },
    }));
  }
  return marked(await relay(request));
}
