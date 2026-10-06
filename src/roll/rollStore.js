// Encrypted on-device copy of a decoded ward roll.
//
// - Only STORED_FIELDS of each entry are kept; the PDF bytes, EPIC numbers,
//   page numbers and struck-off (deleted) entries are never written.
// - The entries are encrypted with WebCrypto AES-GCM (256-bit key, fresh
//   12-byte IV per write, the ward key as additional data) and stored in
//   IndexedDB.
// - The key is generated on the device with extractable: false and kept in
//   IndexedDB as a CryptoKey object, so its bytes can never be read by script.
//
// No network access: reopening a stored ward works offline.

export const DB_NAME = 'ward-canvass';
const DB_VERSION = 1;
export const KEYS_STORE = 'keys';
export const ROLLS_STORE = 'rolls';
export const META_STORE = 'meta';
const KEY_ID = 'roll-key';
const LAST_WARD = 'last-ward';
const RECORD_VERSION = 1;

export const STORED_FIELDS = Object.freeze(['serial', 'name', 'relative', 'age', 'gender', 'house']);

/** Stable storage key for a ward selection {district, samiti, panchayat, ward}. */
export function wardKeyFor(selection) {
  return [selection.district, selection.samiti, selection.panchayat, selection.ward].join('/');
}

/** Keep only STORED_FIELDS of the live (not struck-off) entries. */
export function minimiseEntries(entries) {
  if (!Array.isArray(entries)) throw new TypeError('entries must be an array');
  const out = [];
  for (const entry of entries) {
    if (!entry || typeof entry !== 'object' || entry.deleted === true) continue;
    if (!Number.isFinite(entry.serial)) continue;
    out.push({
      serial: entry.serial,
      name: typeof entry.name === 'string' ? entry.name : '',
      relative: typeof entry.relative === 'string' ? entry.relative : '',
      age: Number.isFinite(entry.age) ? entry.age : null,
      gender: typeof entry.gender === 'string' ? entry.gender : '',
      house: entry.house == null ? '' : String(entry.house),
    });
  }
  return out;
}

function request(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function complete(tx) {
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
      for (const name of [KEYS_STORE, ROLLS_STORE, META_STORE]) {
        if (!db.objectStoreNames.contains(name)) db.createObjectStore(name);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(new Error('roll database is blocked by another tab'));
  });
}

/**
 * @param {{indexedDB?: IDBFactory, crypto?: Crypto}} [deps] defaults to the
 *   browser globals; tests pass fakes
 */
export function createRollStore({ indexedDB = globalThis.indexedDB, crypto = globalThis.crypto } = {}) {
  const encoder = new TextEncoder();
  let dbPromise = null;
  let keyPromise = null;

  function db() {
    if (!indexedDB) return Promise.reject(new Error('IndexedDB is not available'));
    if (!dbPromise) {
      dbPromise = openDb(indexedDB).catch((err) => {
        dbPromise = null;
        throw err;
      });
    }
    return dbPromise;
  }

  async function readValue(storeName, key) {
    const tx = (await db()).transaction(storeName, 'readonly');
    const done = complete(tx);
    const value = await request(tx.objectStore(storeName).get(key));
    await done;
    return value;
  }

  // The device key: created once, non-extractable, shared by every ward.
  async function createOrLoadKey() {
    const existing = await readValue(KEYS_STORE, KEY_ID);
    if (existing) return existing;
    const fresh = await crypto.subtle.generateKey(
      { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'],
    );
    // Another tab may have stored a key meanwhile: keep the first one written.
    const tx = (await db()).transaction(KEYS_STORE, 'readwrite');
    const done = complete(tx);
    const store = tx.objectStore(KEYS_STORE);
    let key = await request(store.get(KEY_ID));
    if (!key) {
      store.add(fresh, KEY_ID);
      key = fresh;
    }
    await done;
    return key;
  }

  function deviceKey() {
    if (!crypto || !crypto.subtle) return Promise.reject(new Error('WebCrypto is not available'));
    if (!keyPromise) {
      keyPromise = createOrLoadKey().catch((err) => {
        keyPromise = null;
        throw err;
      });
    }
    return keyPromise;
  }

  /**
   * Encrypt and store a ward's entries; remembers it as the last opened ward.
   * @returns {Promise<object[]>} the minimised entries that were stored
   */
  async function encryptAndStore(wardKey, entries) {
    if (typeof wardKey !== 'string' || !wardKey) throw new TypeError('wardKey must be a non-empty string');
    const minimal = minimiseEntries(entries);
    const key = await deviceKey();
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const data = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv, additionalData: encoder.encode(wardKey) },
      key,
      encoder.encode(JSON.stringify(minimal)),
    );
    const tx = (await db()).transaction([ROLLS_STORE, META_STORE], 'readwrite');
    const done = complete(tx);
    tx.objectStore(ROLLS_STORE).put({ v: RECORD_VERSION, iv, data }, wardKey);
    tx.objectStore(META_STORE).put(wardKey, LAST_WARD);
    await done;
    return minimal;
  }

  /** Decrypt a stored ward's entries, or null when none is stored. */
  async function loadStored(wardKey) {
    const record = await readValue(ROLLS_STORE, wardKey);
    if (!record) return null;
    if (record.v !== RECORD_VERSION) return null;
    const key = await deviceKey();
    const plain = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: record.iv, additionalData: encoder.encode(wardKey) },
      key,
      record.data,
    );
    return minimiseEntries(JSON.parse(new TextDecoder().decode(plain)));
  }

  /** Key of the ward stored most recently, or null. */
  async function lastWardKey() {
    const value = await readValue(META_STORE, LAST_WARD);
    return typeof value === 'string' ? value : null;
  }

  return { encryptAndStore, loadStored, lastWardKey };
}

let defaultStore = null;
const store = () => (defaultStore ||= createRollStore());

export const encryptAndStore = (wardKey, entries) => store().encryptAndStore(wardKey, entries);
export const loadStored = (wardKey) => store().loadStored(wardKey);
export const lastWardKey = () => store().lastWardKey();
