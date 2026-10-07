// Minimal in-memory IndexedDB used by the roll, contact and assignment store
// tests. It implements only what src/roll/rollStore.js,
// src/contacts/contactStore.js and src/calls/assignmentStore.js rely on: open
// with upgradeneeded, object stores with out-of-line keys,
// get/getAll/getAllKeys/put/add/delete, and transactions that complete once their requests are
// done. Values are structured-cloned on write and on read like the real thing
// (CryptoKey objects are kept by reference).
//
// `databases` exposes the raw stored records so tests can inspect exactly
// what would sit on the device.

function clone(value) {
  if (Object.prototype.toString.call(value) === '[object CryptoKey]') return value;
  return structuredClone(value);
}

class FakeRequest {
  constructor() {
    this.result = undefined;
    this.error = null;
    this.onsuccess = null;
    this.onerror = null;
  }
}

class FakeTransaction {
  constructor(record, names, mode) {
    this.record = record;
    this.names = new Set(Array.isArray(names) ? names : [names]);
    this.mode = mode;
    this.pending = 0;
    this.finished = false;
    this.error = null;
    this.oncomplete = null;
    this.onerror = null;
    this.onabort = null;
    this.scheduleFinish();
  }

  objectStore(name) {
    if (!this.names.has(name) || !this.record.stores.has(name)) {
      throw new Error(`NotFoundError: ${name}`);
    }
    const data = this.record.stores.get(name);
    const run = (fn) => this.run(fn);
    const writable = () => {
      if (this.mode !== 'readwrite') throw new Error('ReadOnlyError');
    };
    return {
      get: (key) => run(() => (data.has(key) ? clone(data.get(key)) : undefined)),
      getAll: () => run(() => [...data.values()].map(clone)),
      getAllKeys: () => run(() => [...data.keys()]),
      put: (value, key) => {
        writable();
        return run(() => {
          data.set(key, clone(value));
          return key;
        });
      },
      add: (value, key) => {
        writable();
        return run(() => {
          if (data.has(key)) throw new Error('ConstraintError');
          data.set(key, clone(value));
          return key;
        });
      },
      delete: (key) => {
        writable();
        return run(() => {
          data.delete(key);
          return undefined;
        });
      },
    };
  }

  run(fn) {
    if (this.finished) throw new Error('TransactionInactiveError');
    const req = new FakeRequest();
    this.pending += 1;
    queueMicrotask(() => {
      try {
        req.result = fn();
        if (req.onsuccess) req.onsuccess({ target: req });
      } catch (err) {
        req.error = err;
        this.error = err;
        if (req.onerror) req.onerror({ target: req });
        if (this.onerror) this.onerror({ target: this });
      }
      this.pending -= 1;
      this.scheduleFinish();
    });
    return req;
  }

  // Completes in a later task once no request is pending, so callers that
  // chain another request from a success callback keep the transaction open.
  scheduleFinish() {
    setTimeout(() => {
      if (this.finished || this.pending > 0) return;
      this.finished = true;
      if (!this.error && this.oncomplete) this.oncomplete({ target: this });
    }, 0);
  }
}

export function createFakeIndexedDB() {
  const databases = new Map(); // name -> { version, stores: Map<name, Map> }
  let opens = 0;

  function open(name, version = 1) {
    opens += 1;
    const req = new FakeRequest();
    req.onupgradeneeded = null;
    req.onblocked = null;
    setTimeout(() => {
      let record = databases.get(name);
      if (!record) {
        record = { version: 0, stores: new Map() };
        databases.set(name, record);
      }
      const db = {
        objectStoreNames: { contains: (n) => record.stores.has(n) },
        createObjectStore: (n) => {
          record.stores.set(n, new Map());
          return {};
        },
        transaction: (names, mode = 'readonly') => new FakeTransaction(record, names, mode),
        close() {},
      };
      req.result = db;
      if (version > record.version) {
        const oldVersion = record.version;
        record.version = version;
        if (req.onupgradeneeded) req.onupgradeneeded({ target: req, oldVersion, newVersion: version });
      }
      if (req.onsuccess) req.onsuccess({ target: req });
    }, 0);
    return req;
  }

  return {
    open,
    databases,
    get opens() {
      return opens;
    },
  };
}
