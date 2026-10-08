// Coordinator's SMS inbox (issue #85): applies a pasted tally SMS to the team
// tally kept on this device.
//
// - The applied roll serials are one record in the `meta` object store under
//   the key `sms-tally-serials`: {v, iv, ct}, where `ct` is the WebCrypto
//   AES-GCM encryption (the shared device key, fresh 12-byte IV per write, the
//   record key as additional data) of JSON.stringify([serial, ...]), ascending.
// - Merging is by set union, so a resent message, a split part or two
//   overlapping messages never count a serial twice.
// - A message that fails decodeTallySms (bad checksum, another candidate's
//   teamTag, wrong format) is rejected with {ok:false, reason} and nothing is
//   written.
// - onSerialsAdded(callback) is called with each non-empty batch of new
//   serials, after it is stored. The team count subscribes to it.
//
// No network access: every operation works offline, with `fetch` undefined.

import { META_STORE, complete, createDbOpener, readValue } from '../storage/deviceDb.js';
import { createDeviceKeyLoader } from '../crypto/deviceKey.js';
import { decodeTallySms } from './smsCodec.js';

export const SMS_SERIALS_ID = 'sms-tally-serials';
const RECORD_VERSION = 1;

/**
 * @param {{indexedDB?: IDBFactory, crypto?: Crypto, log?: Function}} [deps]
 *   defaults to the browser globals; tests pass fakes
 */
export function createSmsInbox({
  indexedDB = globalThis.indexedDB,
  crypto = globalThis.crypto,
  log = (...args) => console.error(...args),
} = {}) {
  const encoder = new TextEncoder();
  const db = createDbOpener(indexedDB);
  const deviceKey = createDeviceKeyLoader({ db, crypto });
  const subscribers = new Set();
  // applyTallySms reads and then rewrites the serial set: one at a time.
  let queue = Promise.resolve();
  const serialised = (fn) => {
    const run = queue.then(fn, fn);
    queue = run.catch(() => {});
    return run;
  };

  async function read() {
    const record = await readValue(db, META_STORE, SMS_SERIALS_ID);
    if (!record || record.v !== RECORD_VERSION) return new Set();
    const key = await deviceKey();
    const plain = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: record.iv, additionalData: encoder.encode(SMS_SERIALS_ID) },
      key,
      record.ct,
    );
    const list = JSON.parse(new TextDecoder().decode(plain));
    return new Set(Array.isArray(list) ? list.filter((n) => Number.isSafeInteger(n) && n >= 1) : []);
  }

  async function write(serials) {
    const key = await deviceKey();
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv, additionalData: encoder.encode(SMS_SERIALS_ID) },
      key,
      encoder.encode(JSON.stringify([...serials].sort((a, b) => a - b))),
    );
    const tx = (await db()).transaction(META_STORE, 'readwrite');
    const done = complete(tx);
    tx.objectStore(META_STORE).put({ v: RECORD_VERSION, iv, ct }, SMS_SERIALS_ID);
    await done;
  }

  function notify(newSerials) {
    for (const callback of [...subscribers]) {
      try {
        callback([...newSerials]);
      } catch (err) {
        log('onSerialsAdded subscriber failed', err);
      }
    }
  }

  /**
   * @param {string} text one SMS as pasted by the coordinator
   * @param {{teamTag: string}} opts this installation's teamTag
   * @returns {Promise<{ok: true, workerId: string, newSerials: number[], duplicateSerials: number[]}
   *   | {ok: false, reason: string}>} serials ascending
   */
  async function applyTallySms(text, { teamTag } = {}) {
    const decoded = decodeTallySms(text, teamTag);
    if (!decoded.ok) return { ok: false, reason: decoded.reason };
    const incoming = [...new Set(decoded.serials)].sort((a, b) => a - b);
    const newSerials = await serialised(async () => {
      const stored = await read();
      const added = incoming.filter((n) => !stored.has(n));
      if (added.length) {
        for (const n of added) stored.add(n);
        await write(stored);
      }
      return added;
    });
    const fresh = new Set(newSerials);
    const duplicateSerials = incoming.filter((n) => !fresh.has(n));
    if (newSerials.length) notify(newSerials);
    return { ok: true, workerId: decoded.workerId, newSerials, duplicateSerials };
  }

  /**
   * @param {(newSerials: number[]) => void} callback
   * @returns {() => void} unsubscribe
   */
  function onSerialsAdded(callback) {
    if (typeof callback !== 'function') throw new TypeError('onSerialsAdded needs a function');
    subscribers.add(callback);
    return () => subscribers.delete(callback);
  }

  /** @returns {Promise<number[]>} every applied serial, ascending */
  async function listAppliedSerials() {
    return serialised(async () => [...(await read())].sort((a, b) => a - b));
  }

  // The hook is reachable from applyTallySms too: applyTallySms.onSerialsAdded(cb).
  applyTallySms.onSerialsAdded = onSerialsAdded;
  return { applyTallySms, onSerialsAdded, listAppliedSerials };
}

let defaultInbox = null;
const inbox = () => (defaultInbox ||= createSmsInbox());

export const applyTallySms = async (text, opts) => inbox().applyTallySms(text, opts);
export const onSerialsAdded = (callback) => inbox().onSerialsAdded(callback);
export const listAppliedSerials = async () => inbox().listAppliedSerials();
applyTallySms.onSerialsAdded = onSerialsAdded;
