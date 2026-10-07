// The team's workers the call list can assign voters to, kept on the device.
//
// - The roster is one record in the `meta` object store under the key
//   `workers`: {v, iv, ct}, where `ct` is the WebCrypto AES-GCM encryption
//   (the shared device key, fresh 12-byte IV per write, the record key as
//   additional data) of JSON.stringify([{workerId, workerName}, ...]).
// - A worker is added by name; adding a name already on the roster returns
//   that worker instead of a second one.
//
// No network access: every operation works offline, with `fetch` undefined.

import { META_STORE, complete, createDbOpener, readValue } from '../storage/deviceDb.js';
import { createDeviceKeyLoader } from '../crypto/deviceKey.js';

export const ROSTER_ID = 'workers';
const RECORD_VERSION = 1;

/**
 * @param {{indexedDB?: IDBFactory, crypto?: Crypto}} [deps] defaults to the
 *   browser globals; tests pass fakes
 */
export function createWorkerRoster({ indexedDB = globalThis.indexedDB, crypto = globalThis.crypto } = {}) {
  const encoder = new TextEncoder();
  const db = createDbOpener(indexedDB);
  const deviceKey = createDeviceKeyLoader({ db, crypto });
  // addWorker reads and then rewrites the roster: one at a time.
  let queue = Promise.resolve();
  const serialised = (fn) => {
    const run = queue.then(fn, fn);
    queue = run.catch(() => {});
    return run;
  };

  async function read() {
    const record = await readValue(db, META_STORE, ROSTER_ID);
    if (!record || record.v !== RECORD_VERSION) return [];
    const key = await deviceKey();
    const plain = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: record.iv, additionalData: encoder.encode(ROSTER_ID) },
      key,
      record.ct,
    );
    const list = JSON.parse(new TextDecoder().decode(plain));
    return Array.isArray(list)
      ? list.map(({ workerId, workerName }) => ({ workerId, workerName }))
      : [];
  }

  async function write(list) {
    const key = await deviceKey();
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv, additionalData: encoder.encode(ROSTER_ID) },
      key,
      encoder.encode(JSON.stringify(list)),
    );
    const tx = (await db()).transaction(META_STORE, 'readwrite');
    const done = complete(tx);
    tx.objectStore(META_STORE).put({ v: RECORD_VERSION, iv, ct }, ROSTER_ID);
    await done;
  }

  function newWorkerId() {
    const bytes = crypto.getRandomValues(new Uint8Array(8));
    return 'worker-' + Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  }

  /** @returns {Promise<{workerId: string, workerName: string}[]>} in the order added */
  async function listWorkers() {
    return serialised(read);
  }

  /**
   * Add a worker by name (surrounding spaces are dropped); rejects an empty name.
   * @returns {Promise<{workerId: string, workerName: string}>}
   */
  async function addWorker(name) {
    const workerName = typeof name === 'string' ? name.trim() : '';
    if (!workerName) throw new TypeError('worker name must not be empty');
    return serialised(async () => {
      const list = await read();
      const existing = list.find((w) => w.workerName === workerName);
      if (existing) return existing;
      const worker = { workerId: newWorkerId(), workerName };
      await write([...list, worker]);
      return worker;
    });
  }

  return { listWorkers, addWorker };
}

let defaultRoster = null;
const roster = () => (defaultRoster ||= createWorkerRoster());

export const listWorkers = async () => roster().listWorkers();
export const addWorker = async (name) => roster().addWorker(name);
