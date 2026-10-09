// Encrypted on-device copy of a decoded ward roll.
//
// - STORED_FIELDS of every entry, struck-off ones included, plus `supplement`
//   ('addition' or 'deletion') on an entry a supplementary roll added or
//   struck off (src/roll/applySupplements.js); never the PDF, EPIC numbers or
//   pages.
// - The record's supplement state (SUPPLEMENT_STATES): 'none' when the ward
//   has no supplementary roll, 'merged' when every one was merged, 'failed'
//   when one could not be downloaded or decoded (so it is tried again).
// - Record version RECORD_VERSION. An older one reads as null (decode
//   again); an unknown one throws RollRecordVersionError.
// - AES-GCM (fresh 12-byte IV, ward key as additional data) under the shared
//   non-extractable device key (src/crypto/deviceKey.js), in IndexedDB.
// No network access: reopening a stored ward works offline.

import {
  DB_NAME, KEYS_STORE, ROLLS_STORE, META_STORE, complete, createDbOpener, readValue,
} from '../storage/deviceDb.js';
import { createDeviceKeyLoader } from '../crypto/deviceKey.js';

export { DB_NAME, KEYS_STORE, ROLLS_STORE, META_STORE };
const LAST_WARD = 'last-ward';

export const RECORD_VERSION = 3; // 2 keeps struck-off entries; 3 adds supplements
export const STALE_RECORD_VERSIONS = Object.freeze([1, 2]);

export const STORED_FIELDS = Object.freeze(['serial', 'name', 'relative', 'age', 'gender', 'house', 'struck']);
/** Kept, after STORED_FIELDS, only on an entry a supplementary roll changed. */
export const SUPPLEMENT_FIELD = 'supplement';
const SUPPLEMENT_KINDS = Object.freeze(['addition', 'deletion']);
export const SUPPLEMENT_STATES = Object.freeze(['none', 'merged', 'failed']);

export class RollRecordVersionError extends Error {
  constructor(version) {
    super(`unknown roll record version ${version}`);
    this.name = 'RollRecordVersionError';
    this.version = version;
  }
}

/** Stable storage key for a ward selection {district, samiti, panchayat, ward}. */
export function wardKeyFor(selection) {
  return [selection.district, selection.samiti, selection.panchayat, selection.ward].join('/');
}

/** STORED_FIELDS of every entry, struck off or not, plus its supplement tag. */
export function minimiseEntries(entries) {
  if (!Array.isArray(entries)) throw new TypeError('entries must be an array');
  const out = [];
  for (const entry of entries) {
    if (!entry || typeof entry !== 'object') continue;
    if (!Number.isFinite(entry.serial)) continue;
    out.push({
      serial: entry.serial,
      name: typeof entry.name === 'string' ? entry.name : '',
      relative: typeof entry.relative === 'string' ? entry.relative : '',
      age: Number.isFinite(entry.age) ? entry.age : null,
      gender: typeof entry.gender === 'string' ? entry.gender : '',
      house: entry.house == null ? '' : String(entry.house),
      struck: entry.struck === true,
    });
    if (SUPPLEMENT_KINDS.includes(entry.supplement)) out[out.length - 1].supplement = entry.supplement;
  }
  return out;
}

/**
 * @param {{indexedDB?: IDBFactory, crypto?: Crypto}} [deps] defaults to the
 *   browser globals; tests pass fakes
 */
export function createRollStore({ indexedDB = globalThis.indexedDB, crypto = globalThis.crypto } = {}) {
  const encoder = new TextEncoder();
  const db = createDbOpener(indexedDB);
  // The device key: created once, non-extractable, shared by every store.
  const deviceKey = createDeviceKeyLoader({ db, crypto });

  /**
   * Encrypt and store a ward's entries; remembers it as the last opened ward.
   * @param {{supplement?: string}} [meta] the supplement state, 'none' by default
   * @returns {Promise<object[]>} the minimised entries that were stored
   */
  async function encryptAndStore(wardKey, entries, { supplement = 'none' } = {}) {
    if (typeof wardKey !== 'string' || !wardKey) throw new TypeError('wardKey must be a non-empty string');
    if (!SUPPLEMENT_STATES.includes(supplement)) throw new TypeError(`unknown supplement state: ${supplement}`);
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
    tx.objectStore(ROLLS_STORE).put({ v: RECORD_VERSION, iv, data, supplement }, wardKey);
    tx.objectStore(META_STORE).put(wardKey, LAST_WARD);
    await done;
    return minimal;
  }

  /** The stored record; null when none or an old version is stored. */
  async function currentRecord(wardKey) {
    const record = await readValue(db, ROLLS_STORE, wardKey);
    if (!record) return null;
    if (STALE_RECORD_VERSIONS.includes(record.v)) return null;
    if (record.v !== RECORD_VERSION) throw new RollRecordVersionError(record.v);
    return record;
  }

  /** Stored entries; null when none or an old version is stored. */
  async function loadStored(wardKey) {
    const record = await currentRecord(wardKey);
    if (!record) return null;
    const key = await deviceKey();
    const plain = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: record.iv, additionalData: encoder.encode(wardKey) },
      key,
      record.data,
    );
    return minimiseEntries(JSON.parse(new TextDecoder().decode(plain)));
  }

  /**
   * The stored roll's supplement state ('none', 'merged' or 'failed'); null
   * when no current record is stored. An unknown state reads as 'failed', so
   * the supplements are fetched again rather than trusted.
   */
  async function supplementState(wardKey) {
    const record = await currentRecord(wardKey);
    if (!record) return null;
    return SUPPLEMENT_STATES.includes(record.supplement) ? record.supplement : 'failed';
  }

  /** Key of the ward stored most recently, or null. */
  async function lastWardKey() {
    const value = await readValue(db, META_STORE, LAST_WARD);
    return typeof value === 'string' ? value : null;
  }

  return { encryptAndStore, loadStored, supplementState, lastWardKey };
}

let defaultStore = null;
const store = () => (defaultStore ||= createRollStore());

export const encryptAndStore = (wardKey, entries, meta) => store().encryptAndStore(wardKey, entries, meta);
export const loadStored = (wardKey) => store().loadStored(wardKey);
export const supplementState = (wardKey) => store().supplementState(wardKey);
export const lastWardKey = () => store().lastWardKey();
