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
// verifier in `verifiers` with INSERT OR IGNORE and that device becomes the
// team's first member; every later join must present the same verifier or
// gets a bare 401. Two first joins racing for a new candidate cannot both
// win: the primary key keeps whichever verifier landed first, and the other
// join is checked against it.
//
// Isolation between candidates is enforced here, from the verified token
// only: every row is keyed on the token's candidate_id, records by
// (candidate_id, seq) with a per-candidate counter in `counters`, and
// nothing in the request body or query can name a candidate. Payloads are
// opaque: the server stores `ciphertext` and `iv` as given and never decodes
// them.
//
// Seen-voting marks (src/tally/seenVotingStore.js) are records whose id is
// `mark:<wardId>:<serial>`. Marks are a grow-only set keyed on the voter, so
// the server keeps one entry per team and mark id: the first push of a mark
// is appended like any record and indexed in `marks`, and a later push of
// the same id (a teammate marking the same voter, or a retry after a dropped
// response) is acknowledged without being stored again. Two pushes of the
// same new mark at the same instant can both be appended (the index write is
// INSERT OR IGNORE, so neither fails), and devices then still hold one mark
// each (they merge by id).
//
// Storage goes through the D1 binding env.SYNC_DB, with the tables created by
// migrations/0001_sync.sql; tests back it with test/helpers/memoryD1.js.
//
// Pages file routing maps this file to /sync only; functions/sync/[[path]].js
// re-exports onRequest so /sync/push and /sync/pull reach it, and
// _routes.json routes /sync/* to functions.

const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
export const MAX_PUSH_RECORDS = 500;
export const MAX_PULL_RECORDS = 1000;
// Records per INSERT in a push. Each statement binds its records as one JSON
// string, which keeps a full push to a handful of statements and well under
// D1's per-value size limit.
const INSERT_CHUNK = 100;

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
  // With no team yet for this candidate, this device founds it; otherwise
  // the insert is ignored and the stored verifier is left as it was.
  const founded = await db
    .prepare('INSERT OR IGNORE INTO verifiers (candidate_id, verifier) VALUES (?, ?)')
    .bind(candidateId, base64urlEncode(verifier))
    .run();
  if (founded.meta.changes === 0) {
    const stored = await db.prepare('SELECT verifier FROM verifiers WHERE candidate_id = ?').bind(candidateId).first('verifier');
    const expected = typeof stored === 'string' ? base64urlDecode(stored) : null;
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

async function storedCursor(db, candidateId) {
  const seq = await db.prepare('SELECT seq FROM counters WHERE candidate_id = ?').bind(candidateId).first('seq');
  return seq === null ? 0 : seq;
}

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
  // A mark the team already has, or one repeated in this batch, is
  // acknowledged but not stored again.
  const markIds = [...new Set(records.map((r) => r.id).filter(isMarkId))];
  const known = new Set();
  if (markIds.length > 0) {
    const { results } = await db
      .prepare('SELECT id FROM marks WHERE candidate_id = ? AND id IN (SELECT value FROM json_each(?))')
      .bind(candidateId, JSON.stringify(markIds))
      .all();
    for (const { id } of results) known.add(id);
  }
  const fresh = [];
  const freshMarks = [];
  for (const record of records) {
    if (isMarkId(record.id)) {
      if (known.has(record.id)) continue;
      known.add(record.id);
      freshMarks.push(record.id);
    }
    fresh.push(record);
  }
  if (fresh.length === 0) return json(200, { accepted: records.length, cursor: await storedCursor(db, candidateId) });

  // One batch is one transaction: the counter moves by the whole push and the
  // records fill exactly the range it claimed, or nothing is written. An
  // overlapping push from the same team is serialised behind it and claims
  // the range after, so no two pushes share a seq and pull never sees a hole.
  // Each record's seq is read back from the counter inside the transaction:
  // the k-th fresh record (from 0) of n gets new counter - n + k + 1.
  const statements = [
    db.prepare('INSERT OR IGNORE INTO counters (candidate_id, seq) VALUES (?, 0)').bind(candidateId),
    db.prepare('UPDATE counters SET seq = seq + ? WHERE candidate_id = ? RETURNING seq').bind(fresh.length, candidateId),
  ];
  for (let start = 0; start < fresh.length; start += INSERT_CHUNK) {
    // Only the known fields are kept; the payload stays opaque ciphertext.
    const chunk = fresh.slice(start, start + INSERT_CHUNK).map(({ id, updatedAt, ciphertext, iv }) => ({ id, updatedAt, ciphertext, iv }));
    statements.push(
      db
        .prepare(
          `INSERT INTO records (candidate_id, seq, id, updated_at, ciphertext, iv, device_id)
           SELECT c.candidate_id, c.seq - ? + r.key + 1,
                  json_extract(r.value, '$.id'), json_extract(r.value, '$.updatedAt'),
                  json_extract(r.value, '$.ciphertext'), json_extract(r.value, '$.iv'), ?
           FROM counters c, json_each(?) r
           WHERE c.candidate_id = ?`,
        )
        .bind(fresh.length - start, deviceId, JSON.stringify(chunk), candidateId),
    );
  }
  if (freshMarks.length > 0) {
    statements.push(
      db
        .prepare('INSERT OR IGNORE INTO marks (candidate_id, id) SELECT ?, value FROM json_each(?)')
        .bind(candidateId, JSON.stringify(freshMarks)),
    );
  }
  const results = await db.batch(statements);
  const end = results[1].results[0].seq;
  return json(200, { accepted: records.length, cursor: end });
}

// Returns records with seq > since, in seq order, and the cursor to ask from
// next time. A push writes its whole seq range in one transaction, so the
// seqs a pull sees have no holes still waiting to be filled. One row past the
// cap is read only to tell the client there is more.
async function pull(url, db, { candidateId }) {
  const sinceParam = url.searchParams.get('since');
  let since = 0;
  if (sinceParam !== null && sinceParam !== '') {
    since = /^\d+$/.test(sinceParam) ? Number(sinceParam) : NaN;
    if (!Number.isSafeInteger(since)) return json(400, { error: 'since must be a non-negative integer' });
  }

  // LIMIT is MAX_PULL_RECORDS + 1.
  const { results } = await db
    .prepare('SELECT seq, id, updated_at, ciphertext, iv FROM records WHERE candidate_id=? AND seq>? ORDER BY seq LIMIT 1001')
    .bind(candidateId, since)
    .all();
  const more = results.length > MAX_PULL_RECORDS;
  const rows = more ? results.slice(0, MAX_PULL_RECORDS) : results;
  const records = rows.map(({ id, updated_at: updatedAt, ciphertext, iv }) => ({ id, updatedAt, ciphertext, iv }));
  const cursor = rows.length > 0 ? rows[rows.length - 1].seq : since;
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
  if (!auth) return bare(401, { 'WWW-Authenticate': 'Bearer' });

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
