// The app's one IndexedDB database on the device, shared by the roll store
// and the contact store. Every object store is created here so that both
// stores agree on the schema and the version.

export const DB_NAME = 'ward-canvass';
// v1: keys, rolls, meta. v2: adds contacts.
export const DB_VERSION = 2;
export const KEYS_STORE = 'keys';
export const ROLLS_STORE = 'rolls';
export const META_STORE = 'meta';
export const CONTACTS_STORE = 'contacts';
const ALL_STORES = Object.freeze([KEYS_STORE, ROLLS_STORE, META_STORE, CONTACTS_STORE]);

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
      for (const name of ALL_STORES) {
        if (!db.objectStoreNames.contains(name)) db.createObjectStore(name);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(new Error('device database is blocked by another tab'));
  });
}

/**
 * A memoised opener for the device database; a failed open is retried on
 * the next call.
 * @param {IDBFactory | null | undefined} indexedDB
 * @returns {() => Promise<IDBDatabase>}
 */
export function createDbOpener(indexedDB) {
  let dbPromise = null;
  return function db() {
    if (!indexedDB) return Promise.reject(new Error('IndexedDB is not available'));
    if (!dbPromise) {
      dbPromise = openDb(indexedDB).catch((err) => {
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
