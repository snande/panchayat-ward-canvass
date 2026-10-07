// Encrypted call assignments: which worker calls which consented voter.
//
// - Each record in the `assignments` object store is {v, iv, ct}, keyed by an
//   opaque random id. Nothing about the voter or the worker is in clear: `ct`
//   is the WebCrypto AES-GCM encryption (the shared 256-bit device key, fresh
//   12-byte IV per write, the record id as additional data) of
//   JSON.stringify({serial, workerId, workerName}).
// - Only those three fields are ever stored. Phone numbers stay in the
//   consent-capture store (src/contacts/contactStore.js).
// - A voter has at most one assignee: assigning again replaces the record.
//
// No network access: every operation works offline, with `fetch` undefined.

import { ASSIGNMENTS_STORE, complete, createDbOpener, request } from '../storage/deviceDb.js';
import { createDeviceKeyLoader } from '../crypto/deviceKey.js';

const RECORD_VERSION = 1;

/** Validate a voter serial; returns it as a number (5 and '5' are one voter). */
function voterSerial(serial) {
  const n = typeof serial === 'string' && /^\d+$/.test(serial) ? Number(serial) : serial;
  if (!Number.isSafeInteger(n) || n < 0) throw new TypeError('serial must be a whole number');
  return n;
}

/** Validate an assignee; returns exactly {workerId, workerName}. */
function assignee(worker) {
  const { workerId, workerName } = worker || {};
  if (typeof workerId !== 'string' || !workerId) throw new TypeError('workerId must be a non-empty string');
  if (typeof workerName !== 'string') throw new TypeError('workerName must be a string');
  return { workerId, workerName };
}

/**
 * @param {{indexedDB?: IDBFactory, crypto?: Crypto}} [deps] defaults to the
 *   browser globals; tests pass fakes
 */
export function createAssignmentStore({ indexedDB = globalThis.indexedDB, crypto = globalThis.crypto } = {}) {
  const encoder = new TextEncoder();
  const db = createDbOpener(indexedDB);
  const deviceKey = createDeviceKeyLoader({ db, crypto });
  // Writes read, decrypt and then replace records, which cannot share one
  // IndexedDB transaction; running them one at a time keeps one record per voter.
  let queue = Promise.resolve();
  const serialised = (fn) => {
    const run = queue.then(fn, fn);
    queue = run.catch(() => {});
    return run;
  };

  function newRecordId() {
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  }

  async function encrypt(id, payload) {
    const key = await deviceKey();
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv, additionalData: encoder.encode(id) },
      key,
      encoder.encode(JSON.stringify(payload)),
    );
    return { v: RECORD_VERSION, iv, ct };
  }

  async function decrypt(id, record) {
    const key = await deviceKey();
    const plain = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: record.iv, additionalData: encoder.encode(id) },
      key,
      record.ct,
    );
    const { serial, workerId, workerName } = JSON.parse(new TextDecoder().decode(plain));
    return { serial, workerId, workerName };
  }

  /** Every stored assignment as [{id, serial, workerId, workerName}]. */
  async function readAll() {
    const tx = (await db()).transaction(ASSIGNMENTS_STORE, 'readonly');
    const done = complete(tx);
    const store = tx.objectStore(ASSIGNMENTS_STORE);
    const [ids, records] = await Promise.all([request(store.getAllKeys()), request(store.getAll())]);
    await done;
    const out = [];
    for (let i = 0; i < ids.length; i += 1) {
      const record = records[i];
      if (!record || record.v !== RECORD_VERSION) continue;
      out.push({ id: ids[i], ...(await decrypt(ids[i], record)) });
    }
    return out;
  }

  /** Delete the records in `remove` and put `add` ({id, record}) in one transaction. */
  async function replace(remove, add) {
    const tx = (await db()).transaction(ASSIGNMENTS_STORE, 'readwrite');
    const done = complete(tx);
    const store = tx.objectStore(ASSIGNMENTS_STORE);
    for (const id of remove) store.delete(id);
    if (add) store.put(add.record, add.id);
    await done;
  }

  /**
   * Assign the voter to a worker, replacing any previous assignee.
   * @returns {Promise<{serial: number, workerId: string, workerName: string}>}
   */
  async function assignVoter(serial, worker) {
    const n = voterSerial(serial);
    const { workerId, workerName } = assignee(worker);
    return serialised(async () => {
      const stale = (await readAll()).filter((a) => a.serial === n).map((a) => a.id);
      const id = newRecordId();
      const record = await encrypt(id, { serial: n, workerId, workerName });
      await replace(stale, { id, record });
      return { serial: n, workerId, workerName };
    });
  }

  /** Remove the voter's assignee; a no-op when the voter is unassigned. */
  async function unassignVoter(serial) {
    const n = voterSerial(serial);
    return serialised(async () => {
      const stale = (await readAll()).filter((a) => a.serial === n).map((a) => a.id);
      if (stale.length) await replace(stale, null);
    });
  }

  /** @returns {Promise<Record<number, {workerId: string, workerName: string}>>} serial -> assignee */
  async function loadAssignments() {
    return serialised(async () => {
      const map = {};
      for (const { serial, workerId, workerName } of await readAll()) map[serial] = { workerId, workerName };
      return map;
    });
  }

  return { assignVoter, unassignVoter, loadAssignments };
}

let defaultStore = null;
const store = () => (defaultStore ||= createAssignmentStore());

export const assignVoter = async (serial, worker) => store().assignVoter(serial, worker);
export const unassignVoter = async (serial) => store().unassignVoter(serial);
export const loadAssignments = async () => store().loadAssignments();
