// Cloudflare Pages Function serving GET /roll?url=... on the shell's own
// origin. It mounts the Engineer's relay (relay/rollRelay.mjs) unchanged:
// the handler is written against the standard Request/Response API, so the
// same code that relay/server.mjs runs under Node runs here.
//
// GET /roll?url=<u> relays u when it has the shape of the statewide
// catalogue's Final/ or Supplement/ roll PDF template,
// .../PRI/Final/<samiti id>/<NAME>-Ward%20No-<NNN>.pdf (pdfUrlTemplates in
// data/sec/catalogue/index.json; isSecRollUrl), so any ward the picker offers
// can download, or when u is a ward URL of config/constituency.json, read
// through the Pages static-asset binding (env.ASSETS) on the first request
// and cached for the lifetime of the isolate, so a config update deploys
// with the site and needs no separate step.
//
// Only this path is routed to a function (_routes.json); every other URL is
// a static file, so the shell's offline precache and install flow are
// unaffected.

import { allowedRollUrls, createRollRelay, isSecRollUrl } from '../relay/rollRelay.mjs';

let relayPromise = null;

async function buildRelay(request, env) {
  const configUrl = new URL('/config/constituency.json', request.url);
  const response = await env.ASSETS.fetch(new Request(configUrl, { method: 'GET' }));
  if (!response.ok) throw new Error(`constituency config unavailable: HTTP ${response.status}`);
  const config = await response.json();
  return createRollRelay({ allowedUrls: allowedRollUrls(config), isAllowedUrl: isSecRollUrl });
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
    return new Response('relay not ready\n', {
      status: 503,
      headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' },
    });
  }
  return relay(request);
}
