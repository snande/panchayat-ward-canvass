// One-time copy of the sync store from Workers KV (the old SYNC_KV binding)
// into the D1 tables of migrations/0001_sync.sql (issue #184):
//
//   c/<candidateId>/verifier   -> verifiers (candidate_id, verifier)
//   c/<candidateId>/seq        -> counters  (candidate_id, seq)
//   c/<candidateId>/r/<seq>    -> records   (candidate_id, seq, id, updated_at, ciphertext, iv, device_id)
//   c/<candidateId>/m/<id>     -> marks     (candidate_id, id)
//
// The KV values are the ones the KV version of functions/sync.js wrote: the
// verifier as its base64url string, the counter as a decimal string, a record
// as JSON {id, updatedAt, ciphertext, iv, seq, deviceId, claimedAt} under its
// seq zero-padded to 12 digits, and a mark index entry as the mark's seq.
//
// Every statement can be re-run: verifiers, records and marks go in with
// INSERT OR IGNORE, so a second run adds nothing and a verifier already in D1
// (a team that joined after the cutover) is kept, and a counter only ever
// moves up, to the larger of its D1 value, the KV counter and the highest
// migrated record seq, so a new push never reuses a migrated slot. A KV record
// whose (candidate, seq) slot D1 already holds with a different record is not
// copied over it; it is reported as a collision instead.
//
//   node scripts/migrate-kv-to-d1.mjs export --namespace-id <id> > kv-dump.json
//   node scripts/migrate-kv-to-d1.mjs sql kv-dump.json [--d1-records d1-records.json] > kv-to-d1.sql
//
// `export` reads every c/ key through `npx wrangler kv key list/get --remote`
// and prints [{name, value}]. `sql` turns a dump into the statements, for
// `npx wrangler d1 execute <database> --remote --file=kv-to-d1.sql`; given the
// output of `wrangler d1 execute ... --json --command "SELECT candidate_id,
// seq, id, ciphertext FROM records"` it first lists the collisions on stderr
// and exits 1 if there are any. docs/operator-setup.md has the runbook.
// migrate(entries, db) runs the same statements through a D1 binding, which is
// how scripts/migrate-kv-to-d1.test.mjs checks them.

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

// The candidate id pattern functions/sync.js enforces.
const KEY_PATTERN = /^c\/([A-Za-z0-9_-]{1,64})\/(?:(verifier)|(seq)|r\/(\d{1,15})|m\/(.+))$/;

const isCount = (value) => Number.isSafeInteger(value) && value >= 0;

// Sorts a dump into per-table rows. Entries the KV store could not have
// written (other prefixes, unreadable values) are returned in `skipped` with
// the reason rather than guessed at.
export function parseEntries(entries) {
  const verifiers = [];
  const counters = new Map();
  const records = [];
  const marks = [];
  const skipped = [];
  for (const { name, value } of entries) {
    const match = typeof name === 'string' ? KEY_PATTERN.exec(name) : null;
    const skip = (reason) => skipped.push({ name, reason });
    if (!match) {
      skip('not a c/<candidate>/{verifier,seq,r/*,m/*} key');
      continue;
    }
    const [, candidateId, verifierPart, seqPart, recordSeq, markId] = match;
    if (typeof value !== 'string') {
      skip('value is not a string');
    } else if (verifierPart) {
      if (value === '') skip('empty verifier');
      else verifiers.push({ candidateId, verifier: value });
    } else if (seqPart) {
      const seq = Number(value);
      if (!/^\d+$/.test(value) || !isCount(seq)) skip('counter is not a non-negative integer');
      else counters.set(candidateId, seq);
    } else if (recordSeq !== undefined) {
      const seq = Number(recordSeq);
      let stored = null;
      try {
        stored = JSON.parse(value);
      } catch {
        // reported below
      }
      const fieldsOk = stored && typeof stored === 'object'
        && typeof stored.id === 'string'
        && (typeof stored.updatedAt === 'string' || typeof stored.updatedAt === 'number')
        && typeof stored.ciphertext === 'string'
        && typeof stored.iv === 'string'
        && typeof stored.deviceId === 'string';
      if (seq < 1) skip('record seq is not positive');
      else if (!fieldsOk) skip('record is not {id, updatedAt, ciphertext, iv, deviceId} JSON');
      else if (stored.seq !== undefined && stored.seq !== seq) skip(`record says seq ${stored.seq}, key says ${seq}`);
      else {
        const { id, updatedAt, ciphertext, iv, deviceId } = stored;
        records.push({ candidateId, seq, id, updatedAt, ciphertext, iv, deviceId });
      }
    } else {
      marks.push({ candidateId, id: markId });
    }
  }
  // Each candidate's counter covers its KV counter and its highest record.
  for (const { candidateId, seq } of records) {
    counters.set(candidateId, Math.max(counters.get(candidateId) ?? 0, seq));
  }
  const counterRows = [...counters].map(([candidateId, seq]) => ({ candidateId, seq }));
  return { verifiers, counters: counterRows, records, marks, skipped };
}

// The statements, as {sql, params}, in an order where a failed run can simply
// be run again.
export function planMigration(entries) {
  const parsed = parseEntries(entries);
  const statements = [
    ...parsed.verifiers.map(({ candidateId, verifier }) => ({
      sql: 'INSERT OR IGNORE INTO verifiers (candidate_id, verifier) VALUES (?, ?)',
      params: [candidateId, verifier],
    })),
    ...parsed.records.map(({ candidateId, seq, id, updatedAt, ciphertext, iv, deviceId }) => ({
      sql: 'INSERT OR IGNORE INTO records (candidate_id, seq, id, updated_at, ciphertext, iv, device_id) VALUES (?, ?, ?, ?, ?, ?, ?)',
      params: [candidateId, seq, id, updatedAt, ciphertext, iv, deviceId],
    })),
    ...parsed.marks.map(({ candidateId, id }) => ({
      sql: 'INSERT OR IGNORE INTO marks (candidate_id, id) VALUES (?, ?)',
      params: [candidateId, id],
    })),
    ...parsed.counters.map(({ candidateId, seq }) => ({
      sql: 'INSERT INTO counters (candidate_id, seq) VALUES (?, ?) '
        + 'ON CONFLICT (candidate_id) DO UPDATE SET seq = MAX(counters.seq, excluded.seq)',
      params: [candidateId, seq],
    })),
  ];
  return { statements, parsed };
}

// KV records whose slot already holds a different record in D1. `existing`
// is rows of {candidate_id, seq, id, ciphertext}.
export function findCollisions(records, existing) {
  const held = new Map(existing.map((row) => [`${row.candidate_id}/${Number(row.seq)}`, row]));
  return records
    .filter(({ candidateId, seq, id, ciphertext }) => {
      const row = held.get(`${candidateId}/${seq}`);
      return row && (row.id !== id || row.ciphertext !== ciphertext);
    })
    .map(({ candidateId, seq, id }) => ({ candidateId, seq, id, d1Id: held.get(`${candidateId}/${seq}`).id }));
}

// Runs the migration against a D1 binding. Collisions are looked up before
// anything is written and left in place.
export async function migrate(entries, db) {
  const { statements, parsed } = planMigration(entries);
  const existing = (await db.prepare('SELECT candidate_id, seq, id, ciphertext FROM records').all()).results;
  const collisions = findCollisions(parsed.records, existing);
  if (statements.length > 0) {
    await db.batch(statements.map(({ sql, params }) => db.prepare(sql).bind(...params)));
  }
  return {
    verifiers: parsed.verifiers.length,
    counters: parsed.counters.length,
    records: parsed.records.length,
    marks: parsed.marks.length,
    skipped: parsed.skipped,
    collisions,
  };
}

function sqlLiteral(value) {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error(`cannot write ${value} as SQL`);
    return String(value);
  }
  return `'${String(value).replace(/'/g, "''")}'`;
}

// The same statements as a SQL file for `wrangler d1 execute --file`.
export function toSql(entries) {
  const { statements } = planMigration(entries);
  return statements
    .map(({ sql, params }) => {
      let i = 0;
      return `${sql.replace(/\?/g, () => sqlLiteral(params[i++]))};`;
    })
    .join('\n') + (statements.length > 0 ? '\n' : '');
}

// Accepts [{name, value}] (or {key, value}), or a {name: value} object.
export function normalizeDump(dump) {
  if (Array.isArray(dump)) return dump.map((entry) => ({ name: entry.name ?? entry.key, value: entry.value }));
  if (dump && typeof dump === 'object') return Object.entries(dump).map(([name, value]) => ({ name, value }));
  throw new Error('the KV dump must be a JSON array of {name, value} or an object of name -> value');
}

// Accepts plain rows or the [{results: [...]}] that `wrangler d1 execute --json` prints.
export function normalizeRows(json) {
  const list = Array.isArray(json) ? json : [json];
  return list.flatMap((item) => (item && Array.isArray(item.results) ? item.results : [item]));
}

// Reads every c/ key of the namespace. `run(args)` returns wrangler's stdout;
// tests pass a fake.
export function exportKv(namespaceId, run = wrangler) {
  const keys = JSON.parse(run(['kv', 'key', 'list', `--namespace-id=${namespaceId}`, '--prefix=c/', '--remote']));
  return keys.map(({ name }) => ({
    name,
    value: run(['kv', 'key', 'get', name, `--namespace-id=${namespaceId}`, '--remote']),
  }));
}

function wrangler(args) {
  return execFileSync('npx', ['wrangler', ...args], { encoding: 'utf8', maxBuffer: 1 << 28 });
}

const USAGE = [
  'usage: migrate-kv-to-d1.mjs export --namespace-id <id> > kv-dump.json',
  '       migrate-kv-to-d1.mjs sql <kv-dump.json> [--d1-records <d1-records.json>] > kv-to-d1.sql',
].join('\n');

export function main(argv, { out = process.stdout, err = process.stderr, run = wrangler } = {}) {
  const [command, ...rest] = argv;
  if (command === 'export' && rest.length === 2 && rest[0] === '--namespace-id' && rest[1]) {
    const entries = exportKv(rest[1], run);
    out.write(`${JSON.stringify(entries, null, 2)}\n`);
    err.write(`Exported ${entries.length} keys.\n`);
    return 0;
  }
  if (command === 'sql' && (rest.length === 1 || (rest.length === 3 && rest[1] === '--d1-records'))) {
    const entries = normalizeDump(JSON.parse(readFileSync(rest[0], 'utf8')));
    const { parsed } = planMigration(entries);
    for (const { name, reason } of parsed.skipped) err.write(`skipped ${name}: ${reason}\n`);
    if (rest.length === 3) {
      const existing = normalizeRows(JSON.parse(readFileSync(rest[2], 'utf8')));
      const collisions = findCollisions(parsed.records, existing);
      for (const { candidateId, seq, id, d1Id } of collisions) {
        err.write(`collision: ${candidateId} seq ${seq} is ${d1Id} in D1, ${id} in KV\n`);
      }
      if (collisions.length > 0) {
        err.write(`${collisions.length} KV records would not be copied; no SQL written.\n`);
        return 1;
      }
    }
    out.write(toSql(entries));
    err.write(
      `${parsed.verifiers.length} verifiers, ${parsed.counters.length} counters, ${parsed.records.length} records, `
        + `${parsed.marks.length} marks, ${parsed.skipped.length} skipped.\n`,
    );
    return 0;
  }
  err.write(`${USAGE}\n`);
  return 2;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main(process.argv.slice(2));
}
