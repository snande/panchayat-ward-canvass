// The app's one IndexedDB database on the device, shared by the roll store,
// the contact store, the call-assignment store and the seen-voting mark store. Every object store is created here so that both
// stores agree on the schema and the version. The team credentials
// (src/sync/teamAuth.js) live in the keys and meta stores; the sync engine
// (src/sync/syncEngine.js) keeps its outbox, its merge index and its pull
// cursor (in meta) here too.

export const DB_NAME = 'ward-canvass';
// v1: keys, rolls, meta. v2: adds contacts. v3: adds assignments.
// v4: adds outbox and synced. v5: adds marks.
export const DB_VERSION = 5;
export const KEYS_STORE = 'keys';
export const ROLLS_STORE = 'rolls';
export const META_STORE = 'meta';
export const CONTACTS_STORE = 'contacts';
export const ASSIGNMENTS_STORE = 'assignments';
export const OUTBOX_STORE = 'outbox';
export const SYNCED_STORE = 'synced';
export const MARKS_STORE = 'marks';
const ALL_STORES = Object.freeze([
  KEYS_STORE, ROLLS_STORE, META_STORE, CONTACTS_STORE, ASSIGNMENTS_STORE, OUTBOX_STORE, SYNCED_STORE, MARKS_STORE,
]);

export function request(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export function complete(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error('transaction aborted'));
  });
}

function openDb(idb) {
  return new Promise((resolve, reject) => {
    const req = idb.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      // Creates only the stores an older (or new) database lacks; the existing
      // key and stored rolls are kept as they are.
      for (const name of ALL_STORES) {
        if (!db.objectStoreNames.contains(name)) db.createObjectStore(name);
      }
    };
    req.onsuccess = () => {
      const db = req.result;
      // Let a newer version open in another tab instead of being blocked.
      db.onversionchange = () => db.close();
      resolve(db);
    };
    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(new Error('device database is blocked by another tab'));
  });
}

/**
 * @param {IDBFactory | null | undefined} idb
 * @returns {() => Promise<IDBDatabase>} memoised opener; retries after a failed open
 */
export function createDbOpener(idb) {
  let dbPromise = null;
  return function db() {
    if (!idb) return Promise.reject(new Error('IndexedDB is not available'));
    if (!dbPromise) {
      dbPromise = openDb(idb).catch((err) => {
        dbPromise = null;
        throw err;
      });
    }
    return dbPromise;
  };
}

/** Read one value from an object store in its own readonly transaction. */
export async function readValue(db, storeName, key) {
  const tx = (await db()).transaction(storeName, 'readonly');
  const done = complete(tx);
  const value = await request(tx.objectStore(storeName).get(key));
  await done;
  return value;
}
