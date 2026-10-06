// Same-origin relay for ward roll PDFs (docs/research/sec-roll-source.md §5:
// the commission's server sends no CORS header, so the PWA cannot fetch the
// PDF itself; the verdict is relay-required).
//
//   GET /roll?url=<pdf url>
//
// The relay only fetches a URL that appears as a ward pdfUrl in
// config/constituency.json. Any other URL, a missing or repeated url
// parameter, or anything that is not a URL answers 403 without contacting
// any server, so the relay cannot be used as an open proxy. Non-GET methods
// answer 405. An upstream failure, redirect (the portal answers 302 for a
// ward that does not exist) or non-PDF body answers 502.
//
// The handler uses the standard Request/Response API, so it runs under Node
// 20+ (relay/server.mjs) or any fetch-handler host. It sends no CORS header:
// only pages on the relay's own origin can read its responses.

export const RELAY_PATH = '/roll';
export const MAX_PDF_BYTES = 20 * 1024 * 1024;
const PDF_MAGIC = '%PDF-';

function normalise(raw) {
  try {
    const url = new URL(raw);
    return url.protocol === 'https:' ? url.href : null;
  } catch {
    return null;
  }
}

/** Every ward pdfUrl in a constituency config, normalised. */
export function allowedRollUrls(config) {
  const allowed = new Set();
  const list = (value) => (Array.isArray(value) ? value : []);
  for (const district of list(config && config.districts)) {
    for (const samiti of list(district && district.samitis)) {
      for (const panchayat of list(samiti && samiti.panchayats)) {
        for (const ward of list(panchayat && panchayat.wards)) {
          const href = ward && typeof ward.pdfUrl === 'string' ? normalise(ward.pdfUrl) : null;
          if (href) allowed.add(href);
        }
      }
    }
  }
  return allowed;
}

function plain(status, message, headers = {}) {
  return new Response(`${message}\n`, {
    status,
    headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', ...headers },
  });
}

/**
 * @param {{allowedUrls: Set<string>, fetch?: typeof fetch, maxBytes?: number}} options
 * @returns {(request: Request) => Promise<Response>}
 */
export function createRollRelay({ allowedUrls, fetch = globalThis.fetch, maxBytes = MAX_PDF_BYTES }) {
  if (!(allowedUrls instanceof Set)) throw new TypeError('allowedUrls must be a Set');

  return async function relay(request) {
    const url = new URL(request.url);
    if (url.pathname !== RELAY_PATH) return plain(404, 'not found');
    if (request.method !== 'GET') return plain(405, 'method not allowed', { Allow: 'GET' });

    const targets = url.searchParams.getAll('url');
    const target = targets.length === 1 ? normalise(targets[0]) : null;
    if (!target || !allowedUrls.has(target)) return plain(403, 'url not in the constituency config');

    let upstream;
    try {
      upstream = await fetch(target, { redirect: 'manual', headers: { Accept: 'application/pdf' } });
    } catch {
      return plain(502, 'roll source unreachable');
    }
    if (upstream.status !== 200) return plain(502, `roll source answered ${upstream.status}`);
    const type = (upstream.headers.get('content-type') || '').toLowerCase();
    if (!type.startsWith('application/pdf')) return plain(502, 'roll source did not send a PDF');
    const declared = Number(upstream.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > maxBytes) return plain(502, 'roll PDF too large');

    let body;
    try {
      body = new Uint8Array(await upstream.arrayBuffer());
    } catch {
      return plain(502, 'roll source interrupted');
    }
    if (body.byteLength > maxBytes) return plain(502, 'roll PDF too large');
    if (String.fromCharCode(...body.subarray(0, PDF_MAGIC.length)) !== PDF_MAGIC) {
      return plain(502, 'roll source did not send a PDF');
    }
    return new Response(body, {
      status: 200,
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Length': String(body.byteLength),
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
      },
    });
  };
}
