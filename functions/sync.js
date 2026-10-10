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
// verifier with INSERT OR IGNORE and that device becomes the team's first
// member; every later join must present the stored verifier or gets a bare
// 401. Two first joins racing for a new candidate cannot both win: the
// second insert is ignored and that join is checked against the first.
// After JOIN_MAX_FAILURES wrong verifiers for one candidate, its joins answer
// 429 for JOIN_LOCKOUT_MS, which bounds online guessing of the passphrase.
// The lock only stops joins, so a guesser can delay a new teammate's join but
// never a joined device's sync.
//
// Isolation between candidates is enforced here, from the verified token
// only: every row carries the candidate_id taken from the token and every
// query filters on it, and nothing in the request body or query can name a
// candidate. Payloads are opaque: the server stores `ciphertext` and `iv` as
// given and never decodes them. A token has no expiry (the client cannot
// rejoin on its own), so a lost device is withdrawn by listing it in
// revoked_devices, after which its push and pull get the same 401 as a bad
// token.
//
// Seen-voting marks (src/tally/seenVotingStore.js) are records whose id is
// `mark:<wardId>:<serial>`. Marks are a grow-only set keyed on the voter, so
// the server keeps one entry per team and mark id: the first push of a mark
// is appended like any record and noted in the marks table, and a later push
// of the same id (a teammate marking the same voter, or a retry after a
// dropped response) is acknowledged without being stored again.
//
// Storage is the D1 binding env.SYNC_DB with the tables in
// migrations/0001_sync.sql and migrations/0002_sync_guards.sql; tests back it
// with test/helpers/memoryD1.js. A push runs as one batch, which D1 executes
// as a single transaction, so the seqs it claims and the records it writes
// commit together: concurrent pushes for a candidate get disjoint seq ranges
// and pull never meets a hole. The statement count per push is fixed
// (records travel as one JSON parameter) to stay inside D1's per-invocation
// query and bound-parameter limits.
//
// Pages file routing maps this file to /sync only; functions/sync/[[path]].js
// re-exports onRequest so /sync/push and /sync/pull reach it, and
// _routes.json routes /sync/* to functions.

const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
export const MAX_PUSH_RECORDS = 500;
export const MAX_PULL_RECORDS = 1000;
// Wrong verifiers one candidate's joins may see before they are locked, and
// for how long (see join).
export const JOIN_MAX_FAILURES = 10;
export const JOIN_LOCKOUT_MS = 15 * 60 * 1000;

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

const MARK_ID_PREFIX = 'mark:';
const isMarkId = (id) => id.startsWith(MARK_ID_PREFIX);

// Constant-time for equal lengths; verifiers always are 32 bytes.
function sameBytes(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a[i] ^ b[i];
  return diff === 0;
}

// Counts one wrong verifier for candidate ?1. The ?2-th failure locks joins
// until ?3 and restarts the count, so each lockout admits ?2 more guesses.
const COUNT_JOIN_FAILURE = `
  INSERT INTO join_failures (candidate_id, failures, locked_until) VALUES (?1, 1, 0)
  ON CONFLICT (candidate_id) DO UPDATE SET
    failures = CASE WHEN failures + 1 >= ?2 THEN 0 ELSE failures + 1 END,
    locked_until = CASE WHEN failures + 1 >= ?2 THEN ?3 ELSE locked_until END`;

async function join(request, db, secret) {
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
  // With no team yet for this candidate the insert founds it; otherwise it
  // is ignored and the stored verifier is what this join must match. A
  // locked candidate always has a verifier, so the insert never founds one.
  const now = Date.now();
  const [guard, , read] = await db.batch([
    db.prepare('SELECT locked_until FROM join_failures WHERE candidate_id = ?').bind(candidateId),
    db.prepare('INSERT OR IGNORE INTO verifiers (candidate_id, verifier) VALUES (?, ?)').bind(candidateId, base64urlEncode(verifier)),
    db.prepare('SELECT verifier FROM verifiers WHERE candidate_id = ?').bind(candidateId),
  ]);
  const failures = guard.results[0];
  if (failures && failures.locked_until > now) {
    return bare(429, { 'Retry-After': String(Math.ceil((failures.locked_until - now) / 1000)) });
  }
  const stored = read.results[0] && read.results[0].verifier;
  const expected = typeof stored === 'string' ? base64urlDecode(stored) : null;
  if (!expected || !sameBytes(expected, verifier)) {
    await db.prepare(COUNT_JOIN_FAILURE).bind(candidateId, JOIN_MAX_FAILURES, now + JOIN_LOCKOUT_MS).run();
    return bare(401);
  }
  if (failures) await db.prepare('DELETE FROM join_failures WHERE candidate_id = ?').bind(candidateId).run();
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

// Appends the batch's records after the candidate's counter, numbered in
// push order. A mark the team already has is skipped; the NOT EXISTS reads
// the marks table before this push's own marks are added to it.
const INSERT_RECORDS = `
  INSERT INTO records (candidate_id, seq, id, updated_at, ciphertext, iv, device_id)
  SELECT ?1, c.seq + ROW_NUMBER() OVER (ORDER BY r.key),
         json_extract(r.value, '$.id'), json_extract(r.value, '$.updatedAt'),
         json_extract(r.value, '$.ciphertext'), json_extract(r.value, '$.iv'), ?2
  FROM json_each(?3) AS r, counters AS c
  WHERE c.candidate_id = ?1
    AND NOT EXISTS (
      SELECT 1 FROM marks AS m WHERE m.candidate_id = ?1 AND m.id = json_extract(r.value, '$.id')
    )`;

// Moves the counter past the seqs INSERT_RECORDS just took.
const CLAIM_SEQS = `
  UPDATE counters
  SET seq = seq + (SELECT count(*) FROM records AS r WHERE r.candidate_id = ?1 AND r.seq > counters.seq)
  WHERE candidate_id = ?1
  RETURNING seq`;

async function push(request, db, { candidateId, deviceId }) {
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
  if (records.length === 0) {
    const last = await db.prepare('SELECT seq FROM counters WHERE candidate_id = ?').bind(candidateId).first('seq');
    return json(200, { accepted: 0, cursor: last || 0 });
  }
  // A mark repeated in this batch is acknowledged but not stored again; one
  // the team already has is skipped by INSERT_RECORDS. Only the known fields
  // are kept; the payload stays opaque ciphertext.
  const fresh = [];
  const marks = new Set();
  for (const { id, updatedAt, ciphertext, iv } of records) {
    if (isMarkId(id)) {
      if (marks.has(id)) continue;
      marks.add(id);
    }
    fresh.push({ id, updatedAt, ciphertext, iv });
  }
  // One batch is one transaction: the records, their marks and the counter
  // commit together or not at all.
  const results = await db.batch([
    db.prepare('INSERT OR IGNORE INTO counters (candidate_id, seq) VALUES (?1, 0)').bind(candidateId),
    db.prepare(INSERT_RECORDS).bind(candidateId, deviceId, JSON.stringify(fresh)),
    db.prepare('INSERT OR IGNORE INTO marks (candidate_id, id) SELECT ?1, value FROM json_each(?2)')
      .bind(candidateId, JSON.stringify([...marks])),
    db.prepare(CLAIM_SEQS).bind(candidateId),
  ]);
  const cursor = results[3].results[0].seq;
  return json(200, { accepted: records.length, cursor });
}

// Returns records with seq > since, in seq order, and the cursor to ask from
// next time. A push's seqs are claimed and written in one transaction, so
// the sequence has no holes for the cursor to pass.
async function pull(url, db, { candidateId }) {
  const sinceParam = url.searchParams.get('since');
  let since = 0;
  if (sinceParam !== null && sinceParam !== '') {
    since = /^\d+$/.test(sinceParam) ? Number(sinceParam) : NaN;
    if (!Number.isSafeInteger(since)) return json(400, { error: 'since must be a non-negative integer' });
  }

  // One row past the cap (MAX_PULL_RECORDS + 1) says whether there is more
  // to come.
  const { results } = await db
    .prepare('SELECT seq, id, updated_at, ciphertext, iv FROM records WHERE candidate_id = ? AND seq > ? ORDER BY seq LIMIT 1001')
    .bind(candidateId, since)
    .all();
  const more = results.length > MAX_PULL_RECORDS;
  const rows = more ? results.slice(0, MAX_PULL_RECORDS) : results;
  const records = rows.map(({ id, updated_at: updatedAt, ciphertext, iv }) => ({ id, updatedAt, ciphertext, iv }));
  const cursor = rows.length ? rows[rows.length - 1].seq : since;
  return json(200, { records, cursor, more });
}

export async function onRequest({ request, env }) {
  const secret = env && env.SYNC_SECRET;
  const db = env && env.SYNC_DB;
  if (!secret || !db) return bare(503);

  const url = new URL(request.url);
  if (url.pathname === '/sync/join') {
    if (request.method !== 'POST') return bare(405, { Allow: 'POST' });
    return join(request, db, secret);
  }

  const header = request.headers.get('Authorization') || '';
  const match = /^Bearer ([^\s]+)$/.exec(header);
  const auth = match ? await verifySyncToken(secret, match[1]) : null;
  const revoked = auth && await db
    .prepare('SELECT 1 AS revoked FROM revoked_devices WHERE candidate_id = ? AND device_id = ?')
    .bind(auth.candidateId, auth.deviceId)
    .first('revoked');
  if (!auth || revoked) return bare(401, { 'WWW-Authenticate': 'Bearer' });

  if (url.pathname === '/sync/push') {
    if (request.method !== 'POST') return bare(405, { Allow: 'POST' });
    return push(request, db, auth);
  }
  if (url.pathname === '/sync/pull') {
    if (request.method !== 'GET') return bare(405, { Allow: 'GET' });
    return pull(url, db, auth);
  }
  return bare(404);
}
