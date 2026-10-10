// In-memory stand-in for a Cloudflare D1 binding, backed by a real SQLite
// database so constraints, types and transactions behave like D1's. It serves
// the calls the sync code makes: prepare(sql).bind(...values) then
// first()/all()/run()/raw(), batch([...statements]) and exec(sql), with
// D1-shaped results (all() resolves to { results, success, meta }, first() to
// a row or null, run() to { success, meta: { changes, last_row_id } }).
//
// SQLite comes from Node's built-in node:sqlite where it is available
// (unflagged from Node 22.13) and otherwise from the sql.js devDependency
// (WebAssembly), which is what CI's Node 20 uses.
//
//   const db = await createMemoryD1({ migrations: ['migrations/0001_sync.sql'] });
//
// Migration paths are relative to the repository root. `db.sqlite` exposes the
// underlying engine ({ exec, query }) so tests can inspect it directly.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const ROOT = new URL('../../', import.meta.url);

// The sql.js WebAssembly module, loaded once and shared by every database.
let sqlJs = null;

// Both engines reduce to exec(sql) for statements without parameters and
// query(sql, params) returning every row as a plain object.
async function openSqlite() {
  let DatabaseSync = null;
  try {
    ({ DatabaseSync } = await import('node:sqlite'));
  } catch {
    // node:sqlite is missing (Node 20) or behind --experimental-sqlite.
  }
  if (DatabaseSync) {
    const db = new DatabaseSync(':memory:');
    return {
      exec: (sql) => db.exec(sql),
      // node:sqlite rows have a null prototype; D1's are plain objects.
      query: (sql, params) => db.prepare(sql).all(...params).map((row) => ({ ...row })),
    };
  }
  const SQL = await (sqlJs ??= import('sql.js').then(({ default: initSqlJs }) => initSqlJs()));
  const db = new SQL.Database();
  return {
    exec: (sql) => db.exec(sql),
    query: (sql, params) => {
      const stmt = db.prepare(sql);
      try {
        stmt.bind(params);
        const rows = [];
        while (stmt.step()) rows.push(stmt.getAsObject());
        return rows;
      } finally {
        stmt.free();
      }
    },
  };
}

// D1 accepts null, numbers, strings, booleans (stored as 1/0) and
// ArrayBuffer/typed arrays (stored as blobs); undefined is a type error.
function toSqlValue(value, index) {
  if (value === undefined) throw new TypeError(`D1_TYPE_ERROR: Type 'undefined' not supported for value at index ${index}`);
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  return value;
}

function d1Error(err) {
  return new Error(`D1_ERROR: ${err.message}`, { cause: err });
}

export async function createMemoryD1({ migrations = [] } = {}) {
  const sqlite = await openSqlite();

  // Runs one statement and reports what D1 would: its rows plus the change
  // count and last rowid. total_changes() is diffed rather than read through
  // changes(), which still holds the previous write's count after a SELECT.
  function execute(sql, params) {
    const before = sqlite.query('SELECT total_changes() AS n', [])[0].n;
    const results = sqlite.query(sql, params);
    const [{ n: after, id }] = sqlite.query('SELECT total_changes() AS n, last_insert_rowid() AS id', []);
    const changes = after - before;
    return {
      success: true,
      results,
      meta: { changes, last_row_id: id, changed_db: changes > 0, duration: 0 },
    };
  }

  class PreparedStatement {
    constructor(sql, params = []) {
      this.sql = sql;
      this.params = params;
    }

    bind(...values) {
      return new PreparedStatement(this.sql, values.map(toSqlValue));
    }

    async all() {
      try {
        return execute(this.sql, this.params);
      } catch (err) {
        throw d1Error(err);
      }
    }

    async run() {
      return this.all();
    }

    async first(column) {
      const { results } = await this.all();
      const row = results[0];
      if (row === undefined) return null;
      if (column === undefined) return row;
      if (!(column in row)) throw new Error(`D1_COLUMN_NOTFOUND: Column not found (${column})`);
      return row[column];
    }

    async raw({ columnNames = false } = {}) {
      const { results } = await this.all();
      const rows = results.map((row) => Object.values(row));
      return columnNames && results.length ? [Object.keys(results[0]), ...rows] : rows;
    }
  }

  const db = {
    sqlite,

    prepare(sql) {
      return new PreparedStatement(sql);
    },

    // Like D1, a batch is one transaction: any failing statement rolls back
    // every write the batch made and the batch rejects with that error.
    async batch(statements) {
      sqlite.exec('BEGIN');
      try {
        const results = statements.map((stmt) => execute(stmt.sql, stmt.params));
        sqlite.exec('COMMIT');
        return results;
      } catch (err) {
        sqlite.exec('ROLLBACK');
        throw d1Error(err);
      }
    },

    async exec(sql) {
      try {
        sqlite.exec(sql);
      } catch (err) {
        throw d1Error(err);
      }
      return { count: sql.split(';').filter((part) => part.trim()).length, duration: 0 };
    },
  };

  for (const path of migrations) {
    sqlite.exec(readFileSync(fileURLToPath(new URL(path, ROOT)), 'utf8'));
  }
  return db;
}

// A fresh database with the sync store's schema, as functions/sync.js expects
// behind env.SYNC_DB.
export const createSyncD1 = () => createMemoryD1({ migrations: ['migrations/0001_sync.sql'] });
