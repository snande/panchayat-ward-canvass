// Seen-voting marks for the polling-day tally (issue #78): a worker marks a
// voter as seen voting, and the team's marks add up to one count per voter,
// however many devices marked them.
//
// - A mark is identified by the voter, not the worker: {wardId, serial}.
//   Marks form a grow-only set; marking a voter again (on this device, or a
//   teammate's mark arriving from a pull) never adds a second mark and never
//   replaces the first one.
// - Each record in the `marks` object store is {wardId, serial, iv, ct},
//   keyed by `${wardId}:${serial}`. Only the ward and serial are in clear;
//   `ct` is the WebCrypto AES-GCM encryption (the shared device key from
//   src/crypto/deviceKey.js, fresh 12-byte IV per write, the record key as
//   additional data) of JSON.stringify({workerId, markedAt}). No roll field
//   (name, relative, phone...) is ever stored here.
// - A new mark is queued for the team in the sync engine's encrypted outbox
//   (src/sync/syncEngine.js) as a record with id `mark:${wardId}:${serial}`,
//   updatedAt the time of the mark, and data {wardId, serial, workerId,
//   markedAt}; marks made offline wait there for the next sync. The server
//   (functions/sync.js) keeps one entry per team and mark id, so two devices
//   marking the same voter, or a retried push, still make one entry.
// - Marks pulled from the team are applied by applyRemote(), which adds the
//   ones this device lacks. teamCount() is the number of distinct voters this
//   device holds a mark for, its own and its teammates'.
//
// Every operation on the store works offline; only the sync engine talks to
// the network.

import { MARKS_STORE, complete, createDbOpener, request } from '../storage/deviceDb.js';
import { createDeviceKeyLoader } from '../crypto/deviceKey.js';
import { enqueue, onRemoteRecords } from '../sync/syncEngine.js';

export const MARK_RECORD_PREFIX = 'mark:';

/**
 * Storage key of a voter's mark. wardId never contains ':' and serial is a
 * whole number, so distinct voters never share a key.
 */
export function markKeyFor(wardId, serial) {
  return `${wardId}:${serial}`;
}

/** Sync record id of a voter's mark. */
export function markRecordId(wardId, serial) {
  return MARK_RECORD_PREFIX + markKeyFor(wardId, serial);
}

/** Validate a voter reference; returns the serial as a number (5 and '5' are one voter). */
function voterSerial(wardId, serial) {
  if (typeof wardId !== 'string' || !wardId || wardId.includes(':')) {
    throw new TypeError('wardId must be a non-empty string without ":"');
  }
  const n = typeof serial === 'string' && /^\d+$/.test(serial) ? Number(serial) : serial;
  if (!Number.isSafeInteger(n) || n < 0) throw new TypeError('serial must be a whole number');
  return n;
}

function validWorkerId(workerId) {
  return typeof workerId === 'string' && workerId.length > 0 && workerId.length <= 100;
}

// A pulled record -> {wardId, serial, workerId, markedAt}, or null when it is
// not a well-formed mark record.
function markFromRecord(record) {
  if (!record || typeof record.id !== 'string' || !record.id.startsWith(MARK_RECORD_PREFIX)) return null;
  const data = record.data;
  if (!data || typeof data !== 'object') return null;
  const { wardId, serial, workerId, markedAt } = data;
  if (typeof wardId !== 'string' || !wardId || wardId.includes(':')) return null;
  if (!Number.isSafeInteger(serial) || serial < 0) return null;
  if (markRecordId(wardId, serial) !== record.id) return null;
  if (!validWorkerId(workerId) || typeof markedAt !== 'string' || !markedAt) return null;
  return { wardId, serial, workerId, markedAt };
}

/**
 * @param {{
 *   indexedDB?: IDBFactory, crypto?: Crypto,
 *   engine?: {enqueue: Function, onRemoteRecords: Function},
 *   now?: () => string, log?: Function,
 * }} [deps] defaults to the browser globals and the device's sync engine; tests pass their own
 */
export function createSeenVotingStore({
  indexedDB = globalThis.indexedDB,
  crypto = globalThis.crypto,
  engine = { enqueue, onRemoteRecords },
  now = () => new Date().toISOString(),
  log = (...args) => console.error(...args),
} = {}) {
  const encoder = new TextEncoder();
  const db = createDbOpener(indexedDB);
  const deviceKey = createDeviceKeyLoader({ db, crypto });

  async function encrypt(id, payload) {
    const key = await deviceKey();
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv, additionalData: encoder.encode(id) },
      key,
      encoder.encode(JSON.stringify(payload)),
    );
    return { iv, ct: new Uint8Array(ct) };
  }

  async function decrypt(id, record) {
    const key = await deviceKey();
    const plain = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: record.iv, additionalData: encoder.encode(id) },
      key,
      record.ct,
    );
    const { workerId, markedAt } = JSON.parse(new TextDecoder().decode(plain));
    return { wardId: record.wardId, serial: record.serial, workerId, markedAt };
  }

  // Stores the mark unless the voter already has one. Returns
  // {mark, added}: the mark now on record and whether this call added it.
  async function insert(wardId, serial, workerId, markedAt) {
    const id = markKeyFor(wardId, serial);
    const { iv, ct } = await encrypt(id, { workerId, markedAt });
    const tx = (await db()).transaction(MARKS_STORE, 'readwrite');
    const done = complete(tx);
    const store = tx.objectStore(MARKS_STORE);
    const existing = await request(store.get(id));
    if (!existing) store.put({ wardId, serial, iv, ct }, id);
    await done;
    if (existing) return { mark: await decrypt(id, existing), added: false };
    return { mark: { wardId, serial, workerId, markedAt }, added: true };
  }

  /**
   * Mark the voter as seen voting. A voter already marked keeps their first
   * mark, which is returned unchanged and not queued again. A new mark is
   * saved on the device and then queued for the team; a failure to queue it
   * is logged rather than reported, as the mark is already saved.
   * @returns {Promise<{wardId, serial: number, workerId: string, markedAt: string}>}
   */
  async function markSeen(wardId, serial, workerId) {
    const n = voterSerial(wardId, serial);
    if (!validWorkerId(workerId)) throw new TypeError('workerId must be a string of 1-100 characters');
    const { mark, added } = await insert(wardId, n, workerId, now());
    if (added) {
      try {
        await engine.enqueue({ id: markRecordId(wardId, n), updatedAt: mark.markedAt, data: { ...mark } });
      } catch (err) {
        log('seen-voting mark could not be queued for the team', err);
      }
    }
    return mark;
  }

  /**
   * Every mark this device holds, its own and its teammates', by ward and
   * then serial.
   * @returns {Promise<{wardId, serial: number, workerId: string, markedAt: string}[]>}
   */
  async function listMarks() {
    const tx = (await db()).transaction(MARKS_STORE, 'readonly');
    const done = complete(tx);
    const store = tx.objectStore(MARKS_STORE);
    const [ids, records] = await Promise.all([request(store.getAllKeys()), request(store.getAll())]);
    await done;
    const out = [];
    for (let i = 0; i < ids.length; i += 1) {
      const record = records[i];
      if (!record || ids[i] !== markKeyFor(record.wardId, record.serial)) continue;
      out.push(await decrypt(ids[i], record));
    }
    return out.sort((a, b) => (a.wardId < b.wardId ? -1 : a.wardId > b.wardId ? 1 : a.serial - b.serial));
  }

  /** How many distinct voters the team has marked, as far as this device knows. */
  async function teamCount() {
    const tx = (await db()).transaction(MARKS_STORE, 'readonly');
    const done = complete(tx);
    const store = tx.objectStore(MARKS_STORE);
    const [ids, records] = await Promise.all([request(store.getAllKeys()), request(store.getAll())]);
    await done;
    let count = 0;
    for (let i = 0; i < ids.length; i += 1) {
      const record = records[i];
      if (record && ids[i] === markKeyFor(record.wardId, record.serial)) count += 1;
    }
    return count;
  }

  /** Add the pulled marks this device lacks; other record types are ignored. Returns how many were added. */
  async function applyRemote(records) {
    let added = 0;
    for (const record of records || []) {
      const mark = markFromRecord(record);
      if (!mark) continue;
      try {
        const result = await insert(mark.wardId, mark.serial, mark.workerId, mark.markedAt);
        if (result.added) added += 1;
      } catch (err) {
        log('a synced seen-voting mark could not be stored', err);
      }
    }
    return added;
  }

  /** Apply every later pull to the mark store; returns an unsubscribe function. */
  function listen() {
    return engine.onRemoteRecords(applyRemote);
  }

  return { markSeen, listMarks, teamCount, applyRemote, listen };
}

let defaultStore = null;
const store = () => (defaultStore ||= createSeenVotingStore());

export const markSeen = async (wardId, serial, workerId) => store().markSeen(wardId, serial, workerId);
export const listMarks = async () => store().listMarks();
export const teamCount = async () => store().teamCount();
export const listenForTeamMarks = () => store().listen();
