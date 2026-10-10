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
//   device holds a mark for, its own and its teammates'; wardCount(wardId)
//   is the same count for one ward, which is the supporter count the
//   polling-day turnout screen (src/ui/turnoutScreen.js) shows. Both take
//   {skip(wardId, serial)}: a mark it returns true for is kept but not
//   counted, which is how a serial struck off the roll after it was marked
//   (or marked on a teammate's older build) stays out of the count.
// - onMarksChanged(callback) is called after a mark is added on this device or
//   pulled marks add at least one, so an open count can be read again.
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
  const changeListeners = new Set();

  function changed() {
    for (const callback of [...changeListeners]) {
      try {
        callback();
      } catch (err) {
        log('a seen-voting change listener failed', err);
      }
    }
  }

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
   * @returns {Promise<{mark: {wardId, serial: number, workerId: string, markedAt: string}, added: boolean}>}
   *   added is false when the voter already had a mark
   */
  async function recordSeen(wardId, serial, workerId) {
    const n = voterSerial(wardId, serial);
    if (!validWorkerId(workerId)) throw new TypeError('workerId must be a string of 1-100 characters');
    const { mark, added } = await insert(wardId, n, workerId, now());
    if (added) {
      changed();
      try {
        await engine.enqueue({ id: markRecordId(wardId, n), updatedAt: mark.markedAt, data: { ...mark } });
      } catch (err) {
        log('seen-voting mark could not be queued for the team', err);
      }
    }
    return { mark, added };
  }

  /** Like recordSeen, returning only the mark now on record. */
  async function markSeen(wardId, serial, workerId) {
    return (await recordSeen(wardId, serial, workerId)).mark;
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

  // How many distinct voters with a well-formed record pass keep(record).
  async function countWhere(keep) {
    const tx = (await db()).transaction(MARKS_STORE, 'readonly');
    const done = complete(tx);
    const store = tx.objectStore(MARKS_STORE);
    const [ids, records] = await Promise.all([request(store.getAllKeys()), request(store.getAll())]);
    await done;
    let count = 0;
    for (let i = 0; i < ids.length; i += 1) {
      const record = records[i];
      if (record && ids[i] === markKeyFor(record.wardId, record.serial) && keep(record)) count += 1;
    }
    return count;
  }

  // The skip option as a predicate on a stored record.
  function counted(opts) {
    const skip = opts && opts.skip;
    if (skip === undefined) return () => true;
    if (typeof skip !== 'function') throw new TypeError('skip must be a function');
    return (record) => !skip(record.wardId, record.serial);
  }

  /**
   * How many distinct voters the team has marked, as far as this device knows.
   * @param {{skip?: (wardId: string, serial: number) => boolean}} [opts] marks skip returns true for are not counted
   */
  async function teamCount(opts) {
    return countWhere(counted(opts));
  }

  /**
   * How many distinct voters of one ward the team has marked, as far as this device knows.
   * @param {string} wardId
   * @param {{skip?: (wardId: string, serial: number) => boolean}} [opts] marks skip returns true for are not counted
   */
  async function wardCount(wardId, opts) {
    if (typeof wardId !== 'string' || !wardId || wardId.includes(':')) {
      throw new TypeError('wardId must be a non-empty string without ":"');
    }
    const keep = counted(opts);
    return countWhere((record) => record.wardId === wardId && keep(record));
  }

  /**
   * The voter's mark (this device's or a teammate's), or null when the voter
   * is not marked as far as this device knows.
   * @returns {Promise<{wardId, serial: number, workerId: string, markedAt: string} | null>}
   */
  async function getMark(wardId, serial) {
    const n = voterSerial(wardId, serial);
    const id = markKeyFor(wardId, n);
    const tx = (await db()).transaction(MARKS_STORE, 'readonly');
    const done = complete(tx);
    const record = await request(tx.objectStore(MARKS_STORE).get(id));
    await done;
    return record ? decrypt(id, record) : null;
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
    if (added > 0) changed();
    return added;
  }

  /** Apply every later pull to the mark store; returns an unsubscribe function. */
  function listen() {
    return engine.onRemoteRecords(applyRemote);
  }

  /** Call callback after marks are added (see above); returns an unsubscribe function. */
  function onMarksChanged(callback) {
    if (typeof callback !== 'function') throw new TypeError('callback must be a function');
    changeListeners.add(callback);
    return () => changeListeners.delete(callback);
  }

  return { markSeen, recordSeen, getMark, listMarks, teamCount, wardCount, applyRemote, listen, onMarksChanged };
}

let defaultStore = null;
const store = () => (defaultStore ||= createSeenVotingStore());

export const markSeen = async (wardId, serial, workerId) => store().markSeen(wardId, serial, workerId);
export const listMarks = async () => store().listMarks();
export const recordSeen = async (wardId, serial, workerId) => store().recordSeen(wardId, serial, workerId);
export const getMark = async (wardId, serial) => store().getMark(wardId, serial);
export const teamCount = async (opts) => store().teamCount(opts);
export const wardCount = async (wardId, opts) => store().wardCount(wardId, opts);
export const onMarksChanged = (callback) => store().onMarksChanged(callback);
export const listenForTeamMarks = () => store().listen();
