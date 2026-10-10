// Same-origin relay for ward roll PDFs (docs/research/sec-roll-source.md §5:
// the commission's server sends no CORS header, so the PWA cannot fetch the
// PDF itself; the verdict is relay-required).
//
//   GET /roll?url=<pdf url>
//
// The relay fetches a url parameter u only when u is an SEC ward roll PDF:
// either u has the shape of one of the catalogue's two roll PDF templates
// (pdfUrlTemplates.final and pdfUrlTemplates.supplement in
// data/sec/catalogue/index.json; see isSecRollUrl):
//
//   https://esuchiroll.rajasthan.gov.in/Publication_PDF_2026/PRI/Final/<samiti id>/<NAME>-Ward%20No-<NNN>.pdf
//   https://esuchiroll.rajasthan.gov.in/Publication_PDF_2026/PRI/Supplement/<samiti id>/<NAME>-Ward%20No-<NNN>.pdf
//
// (samiti id digits, NAME the percent-encoded upper-case panchayat name the
// catalogue builds the URL from, NNN three digits), or u is a ward pdfUrl or
// supplementPdfUrls entry in config/constituency.json (allowedRollUrls).
// Every other u (another host, http, a query or fragment, another path, '..'
// or an encoded slash), a missing or repeated url parameter, or anything
// that is not a URL answers 403 without contacting any server, so the relay
// cannot be used as an open proxy. Non-GET methods answer 405. An upstream failure, redirect (the portal answers 302 for a
// ward that does not exist), non-PDF body or an upstream that stalls past
// the timeout answers 502.
//
// The handler uses the standard Request/Response API, so it runs under Node
// 20+ (relay/server.mjs) or any fetch-handler host. It sends no CORS header:
// only pages on the relay's own origin can read its responses.

export const RELAY_PATH = '/roll';
export const MAX_PDF_BYTES = 20 * 1024 * 1024;
export const UPSTREAM_TIMEOUT_MS = 30_000;
const PDF_MAGIC = '%PDF-';

function normalise(raw) {
  try {
    const url = new URL(raw);
    return url.protocol === 'https:' ? url.href : null;
  } catch {
    return null;
  }
}

const SEC_ROLL_HOST = 'esuchiroll.rajasthan.gov.in';
// The Final/ and Supplement/ roll paths as the pdfUrlTemplates of
// data/sec/catalogue/index.json build them: /<samiti id>/<NAME>-Ward%20No-<NNN>.pdf
// with a digit samiti id, NAME the percent-encoded upper-case panchayat name
// (captured) and NNN a three-digit ward.
const SEC_ROLL_PATH =
  /^\/Publication_PDF_2026\/PRI\/(?:Final|Supplement)\/[0-9]+\/((?:[A-Z0-9._~-]|%[0-9A-F]{2})+)-Ward%20No-[0-9]{3}\.pdf$/;

/** A panchayat NAME encoded as the catalogue builder does (Python quote(name, safe="")). */
function quoteName(name) {
  return encodeURIComponent(name).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

/**
 * True when u has the exact shape of an SEC ward roll PDF in the catalogue:
 * https, host esuchiroll.rajasthan.gov.in, no port, credentials, query or
 * fragment, and a Final/ or Supplement/ path whose NAME segment is the
 * canonical encoding of an upper-case printable-ASCII name with no slash,
 * followed by -Ward%20No-<NNN>.pdf.
 * u must already be in canonical form (new URL(u).href === u), so a '..'
 * segment or other text the parser would rewrite is refused, not resolved.
 */
export function isSecRollUrl(u) {
  if (typeof u !== 'string' || u.includes('?') || u.includes('#')) return false;
  let url;
  try {
    url = new URL(u);
  } catch {
    return false;
  }
  if (url.href !== u || url.protocol !== 'https:' || url.hostname !== SEC_ROLL_HOST) return false;
  if (url.port !== '' || url.username !== '' || url.password !== '') return false;
  const match = SEC_ROLL_PATH.exec(url.pathname);
  if (!match) return false;
  let name;
  try {
    name = decodeURIComponent(match[1]);
  } catch {
    return false;
  }
  if (!/^[\x20-\x7e]+$/.test(name) || /[a-z/\\]/.test(name)) return false;
  return quoteName(name) === match[1];
}

/** Every ward pdfUrl and supplementPdfUrls entry in a constituency config, normalised. */
export function allowedRollUrls(config) {
  const allowed = new Set();
  const list = (value) => (Array.isArray(value) ? value : []);
  for (const district of list(config && config.districts)) {
    for (const samiti of list(district && district.samitis)) {
      for (const panchayat of list(samiti && samiti.panchayats)) {
        for (const ward of list(panchayat && panchayat.wards)) {
          const urls = ward ? [ward.pdfUrl, ...list(ward.supplementPdfUrls)] : [];
          for (const raw of urls) {
            const href = typeof raw === 'string' ? normalise(raw) : null;
            if (href) allowed.add(href);
          }
        }
      }
    }
  }
  return allowed;
}

/** Body bytes of a response, or null once more than maxBytes have arrived. */
async function readCapped(response, maxBytes) {
  if (!response.body) return new Uint8Array(0);
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.byteLength;
  }
  return out;
}

function plain(status, message, headers = {}) {
  return new Response(`${message}\n`, {
    status,
    headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', ...headers },
  });
}

/**
 * @param {{allowedUrls: Set<string>, isAllowedUrl?: (u: string) => boolean,
 *   fetch?: typeof fetch, maxBytes?: number, timeoutMs?: number}} options
 * A url parameter u is relayed when its normalised href is in allowedUrls or
 * isAllowedUrl (for example isSecRollUrl) accepts u as sent.
 * timeoutMs bounds the whole upstream exchange (headers and body); a stalled
 * source answers 502 instead of holding the request open.
 * @returns {(request: Request) => Promise<Response>}
 */
export function createRollRelay({
  allowedUrls, isAllowedUrl = () => false, fetch = globalThis.fetch, maxBytes = MAX_PDF_BYTES,
  timeoutMs = UPSTREAM_TIMEOUT_MS,
}) {
  if (!(allowedUrls instanceof Set)) throw new TypeError('allowedUrls must be a Set');
  if (typeof isAllowedUrl !== 'function') throw new TypeError('isAllowedUrl must be a function');

  return async function relay(request) {
    const url = new URL(request.url);
    if (url.pathname !== RELAY_PATH) return plain(404, 'not found');
    if (request.method !== 'GET') return plain(405, 'method not allowed', { Allow: 'GET' });

    const targets = url.searchParams.getAll('url');
    const target = targets.length === 1 ? normalise(targets[0]) : null;
    // The predicate sees u as sent, so a u the parser would rewrite (a '..'
    // segment, a raw space) is refused, not resolved.
    if (!target || !(allowedUrls.has(target) || isAllowedUrl(targets[0]))) {
      return plain(403, 'url is not an SEC roll PDF');
    }

    // One timer covers headers and body: aborting the signal also errors a
    // body read that is in progress. (AbortSignal.timeout's timer is unref'd,
    // so it would not keep a hung request's process alive to fire.)
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(new Error('roll source timed out')), timeoutMs);
    try {
      return await fromUpstream(target, abort.signal);
    } finally {
      clearTimeout(timer);
    }
  };

  async function fromUpstream(target, signal) {
    let upstream;
    try {
      upstream = await fetch(target, {
        redirect: 'manual',
        headers: { Accept: 'application/pdf' },
        signal,
      });
    } catch {
      return plain(502, 'roll source unreachable');
    }
    if (upstream.status !== 200) return plain(502, `roll source answered ${upstream.status}`);
    const type = (upstream.headers.get('content-type') || '').toLowerCase();
    if (!type.startsWith('application/pdf')) return plain(502, 'roll source did not send a PDF');
    const declared = Number(upstream.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > maxBytes) return plain(502, 'roll PDF too large');

    // Read with a running byte count so a chunked response with no
    // Content-Length cannot make the relay buffer more than maxBytes.
    let body;
    try {
      body = await readCapped(upstream, maxBytes);
    } catch {
      return plain(502, 'roll source interrupted');
    }
    if (body === null) return plain(502, 'roll PDF too large');
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
  }
}
