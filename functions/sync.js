// Cloudflare Pages Function serving the candidate-partitioned sync API on the
// shell's own origin:
//
//   POST /sync/join            body {candidateId, verifier} -> {token, candidateId, deviceId}
//   POST /sync/push            body {records: [{id, updatedAt, ciphertext, iv}]}
//   GET  /sync/pull?since=N    -> {records: [...], cursor, more}
//
// Push and pull carry `Authorization: Bearer <token>`, where the token is
// base64url("<candidateId>.<deviceId>") + "." + base64url(HMAC-SHA-256 over
// "<candidateId>:<deviceId>" keyed with env.SYNC_SECRET). A missing or bad
// token gets a bare 401.
//
// Join is how a device gets its token (src/sync/teamAuth.js). The device
// sends the candidate code and a passphrase verifier, base64url of
// SHA-256(PBKDF2 bits || 'verify'); the passphrase itself and the team key
// never reach the server. The first join for a candidate records its
// verifier at c/<candidateId>/verifier and that device becomes the team's
// first member; every later join must present the same verifier or gets a
// bare 401. KV has no compare-and-set, so two first joins racing for a new
// candidate can both succeed and the later verifier wins; the first member
// then rejoins with the passphrase that stuck.
//
// Isolation between candidates is enforced here, from the verified token
// only: records live under c/<candidateId>/r/<seq> with a per-candidate
// counter at c/<candidateId>/seq, and nothing in the request body or query
// can name a candidate. Payloads are opaque: the server stores `ciphertext`
// and `iv` as given and never decodes them.
//
// Storage goes through the KV binding env.SYNC_KV (get/put/list), so tests
// back it with an in-memory store of the same shape.
//
// Pages file routing maps this file to /sync only; functions/sync/[[path]].js
// re-exports onRequest so /sync/push and /sync/pull reach it, and
// _routes.json routes /sync/* to functions.

const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const SEQ_DIGITS = 12;
export const MAX_PUSH_RECORDS = 500;
export const MAX_PULL_RECORDS = 1000;
// How long a hole in the sequence may stay unfilled before pull steps over
// it (see pull).
export const GAP_GRACE_MS = 5 * 60 * 1000;

const encoder = new TextEncoder();

// src/sync/teamAuth.js carries its own copy of this encoder: this file is
// bundled into the Pages Function and src/ is served to the device and
// precached by sw.js, so neither side imports the other. test/teamAuth.test.js
// pins that the two produce the same verifier encoding.
function base64urlEncode(bytes) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64urlDecode(text) {
  if (!/^[A-Za-z0-9_-]*$/.test(text)) return null;
  const padded = text.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (text.length % 4)) % 4);
  try {
    return Uint8Array.from(atob(padded), (ch) => ch.charCodeAt(0));
  } catch {
    return null;
  }
}

function hmacKey(secret, usage) {
  return crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, [usage]);
}

// Mints a token for (candidateId, deviceId); POST /sync/join issues it to a
// device that presents the team's passphrase verifier.
export async function signSyncToken(secret, candidateId, deviceId) {
  if (!ID_PATTERN.test(candidateId) || !ID_PATTERN.test(deviceId)) {
    throw new Error('candidateId and deviceId must match ' + ID_PATTERN);
  }
  const key = await hmacKey(secret, 'sign');
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(`${candidateId}:${deviceId}`)));
  return `${base64urlEncode(encoder.encode(`${candidateId}.${deviceId}`))}.${base64urlEncode(mac)}`;
}

// Returns {candidateId, deviceId} for a genuine token, otherwise null.
export async function verifySyncToken(secret, token) {
  if (typeof token !== 'string' || token.length > 512) return null;
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const payload = base64urlDecode(parts[0]);
  const mac = base64urlDecode(parts[1]);
  if (!payload || !mac || mac.length !== 32) return null;
  const ids = String.fromCharCode(...payload).split('.');
  if (ids.length !== 2) return null;
  const [candidateId, deviceId] = ids;
  if (!ID_PATTERN.test(candidateId) || !ID_PATTERN.test(deviceId)) return null;
  const key = await hmacKey(secret, 'verify');
  // subtle.verify compares in constant time.
  const ok = await crypto.subtle.verify('HMAC', key, mac, encoder.encode(`${candidateId}:${deviceId}`));
  return ok ? { candidateId, deviceId } : null;
}

const VERIFIER_BYTES = 32;
const DEVICE_ID_BYTES = 12;

const NO_STORE = { 'Cache-Control': 'no-store' };

function json(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...NO_STORE },
  });
}

function bare(status, extra = {}) {
  return new Response(null, { status, headers: { ...NO_STORE, ...extra } });
}

const recordPrefix = (candidateId) => `c/${candidateId}/r/`;
const recordKey = (candidateId, seq) => recordPrefix(candidateId) + String(seq).padStart(SEQ_DIGITS, '0');
const counterKey = (candidateId) => `c/${candidateId}/seq`;
const verifierKey = (candidateId) => `c/${candidateId}/verifier`;

// Constant-time for equal lengths; verifiers always are 32 bytes.
function sameBytes(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a[i] ^ b[i];
  return diff === 0;
}

async function join(request, kv, secret) {
  let body;
  try {
    body = await request.json();
  } catch {
    return json(400, { error: 'body must be JSON' });
  }
  const candidateId = body && body.candidateId;
  const verifier = body && typeof body.verifier === 'string' ? base64urlDecode(body.verifier) : null;
  if (typeof candidateId !== 'string' || !ID_PATTERN.test(candidateId) || !verifier || verifier.length !== VERIFIER_BYTES) {
    return json(400, { error: `candidateId must match ${ID_PATTERN} and verifier must be ${VERIFIER_BYTES} base64url bytes` });
  }
  const stored = await kv.get(verifierKey(candidateId));
  if (stored === null || stored === undefined) {
    // No team yet for this candidate: this device founds it.
    await kv.put(verifierKey(candidateId), base64urlEncode(verifier));
  } else {
    const expected = base64urlDecode(stored);
    if (!expected || !sameBytes(expected, verifier)) return bare(401);
  }
  const deviceId = base64urlEncode(crypto.getRandomValues(new Uint8Array(DEVICE_ID_BYTES)));
  const token = await signSyncToken(secret, candidateId, deviceId);
  return json(200, { token, candidateId, deviceId });
}

function validRecord(record) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) return false;
  const { id, updatedAt, ciphertext, iv } = record;
  if (typeof id !== 'string' || id.length === 0 || id.length > 200) return false;
  if (!(typeof updatedAt === 'string' || (typeof updatedAt === 'number' && Number.isFinite(updatedAt)))) return false;
  if (typeof ciphertext !== 'string' || ciphertext.length === 0) return false;
  if (typeof iv !== 'string' || iv.length === 0) return false;
  return true;
}

async function push(request, kv, { candidateId, deviceId }) {
  let body;
  try {
    body = await request.json();
  } catch {
    return json(400, { error: 'body must be JSON' });
  }
  const records = body && body.records;
  if (!Array.isArray(records) || records.length > MAX_PUSH_RECORDS || !records.every(validRecord)) {
    return json(400, { error: `records must be an array of at most ${MAX_PUSH_RECORDS} {id, updatedAt, ciphertext, iv}` });
  }
  const last = Number((await kv.get(counterKey(candidateId))) || 0);
  if (records.length === 0) return json(200, { accepted: 0, cursor: last });
  // KV has no atomic increment. The seq range is claimed before the records
  // are written, so an overlapping push from the same team lands on later
  // slots and may write them before this push finishes; pull never reads
  // past a slot that is still empty, so no record is skipped. Two pushes
  // that read the counter at the same instant can still claim the same
  // slots and overwrite each other, but never across candidates.
  const end = last + records.length;
  const claimedAt = Date.now();
  await kv.put(counterKey(candidateId), String(end));
  let seq = last;
  for (const { id, updatedAt, ciphertext, iv } of records) {
    seq += 1;
    // Only the known fields are kept; the payload stays opaque ciphertext.
    const stored = { id, updatedAt, ciphertext, iv, seq, deviceId, claimedAt };
    await kv.put(recordKey(candidateId, seq), JSON.stringify(stored));
  }
  return json(200, { accepted: records.length, cursor: end });
}

function parseStored(name, text) {
  try {
    const value = JSON.parse(text);
    if (value && typeof value === 'object') return value;
  } catch {
    // fall through
  }
  console.warn(`sync: skipping unreadable record ${name}`);
  return null;
}

// Returns records with seq > since, in seq order, and the cursor to ask from
// next time. The cursor only moves through a contiguous run of seqs: a hole
// usually means an earlier push has claimed the slot and not written it yet
// (or KV has not propagated it here yet), so pull stops there rather than
// let the client's cursor pass a record it has not seen. A hole is stepped
// over only when the record after it was claimed more than GAP_GRACE_MS ago:
// claims are ordered, so the push that owned the hole began even earlier and
// has died rather than stalled, and waiting longer would wedge the team.
async function pull(url, kv, { candidateId }, now = Date.now()) {
  const sinceParam = url.searchParams.get('since');
  let since = 0;
  if (sinceParam !== null && sinceParam !== '') {
    since = /^\d+$/.test(sinceParam) ? Number(sinceParam) : NaN;
    if (!Number.isSafeInteger(since)) return json(400, { error: 'since must be a non-negative integer' });
  }

  const prefix = recordPrefix(candidateId);
  const records = [];
  let cursor = since;
  let more = false;
  let listCursor;
  scan: do {
    const page = await kv.list({ prefix, cursor: listCursor });
    for (const { name } of page.keys) {
      const seq = Number(name.slice(prefix.length));
      if (!Number.isSafeInteger(seq) || seq <= cursor) continue;
      if (records.length === MAX_PULL_RECORDS) {
        more = true;
        break scan;
      }
      const text = await kv.get(name);
      if (text === null) break scan;
      const stored = parseStored(name, text);
      if (seq !== cursor + 1) {
        const claimedAt = stored && Number(stored.claimedAt);
        const stale = !stored || !Number.isFinite(claimedAt) || now - claimedAt > GAP_GRACE_MS;
        if (!stale) break scan;
      }
      // An unreadable record will never become readable: step over it so it
      // cannot wedge the team's sync.
      if (stored) {
        const { id, updatedAt, ciphertext, iv } = stored;
        records.push({ id, updatedAt, ciphertext, iv });
      }
      cursor = seq;
    }
    listCursor = page.list_complete ? undefined : page.cursor;
  } while (listCursor);
  return json(200, { records, cursor, more });
}

export async function onRequest({ request, env }) {
  const secret = env && env.SYNC_SECRET;
  const kv = env && env.SYNC_KV;
  if (!secret || !kv) return bare(503);

  const url = new URL(request.url);
  if (url.pathname === '/sync/join') {
    if (request.method !== 'POST') return bare(405, { Allow: 'POST' });
    return join(request, kv, secret);
  }

  const header = request.headers.get('Authorization') || '';
  const match = /^Bearer ([^\s]+)$/.exec(header);
  const auth = match ? await verifySyncToken(secret, match[1]) : null;
  if (!auth) return bare(401, { 'WWW-Authenticate': 'Bearer' });

  if (url.pathname === '/sync/push') {
    if (request.method !== 'POST') return bare(405, { Allow: 'POST' });
    return push(request, kv, auth);
  }
  if (url.pathname === '/sync/pull') {
    if (request.method !== 'GET') return bare(405, { Allow: 'GET' });
    return pull(url, kv, auth);
  }
  return bare(404);
}
