// Coordinator's SMS inbox for the polling-day tally (issue #85): a tally SMS
// received at the team number is pasted into the app and merged into the
// team's set of roll serials seen voting.
//
// - Merging is a set union of roll serials, so a resent message, the parts of
//   a split tally and two workers' overlapping messages never count a serial
//   twice. applyTallySms() reports which of the message's serials are new to
//   this device and which were already applied.
// - The message is decoded with decodeTallySms (src/tally/smsCodec.js); a
//   message that fails its checksum, is malformed or carries another team's
//   teamTag is rejected with ok:false and the stored set is not touched.
// - The applied serials are one record in the `smsTally` object store, keyed
//   by the teamTag: {v, iv, ct}, where `ct` is the WebCrypto AES-GCM
//   encryption (the shared device key from src/crypto/deviceKey.js, fresh
//   12-byte IV per write, `sms-tally:${teamTag}` as additional data) of
//   JSON.stringify({serials}). The serials are never stored in clear.
// - onSerialsAdded(callback) is called with each batch of newSerials after it
//   has been stored; the team count subscribes to it.
//
// No network access: pasting and merging work offline, and nothing is synced.

import { SMS_TALLY_STORE, complete, createDbOpener, readValue } from '../storage/deviceDb.js';
import { createDeviceKeyLoader } from '../crypto/deviceKey.js';
import { decodeTallySms } from './smsCodec.js';

export { SMS_TALLY_STORE };
const RECORD_VERSION = 1;

const additionalData = (teamTag) => `sms-tally:${teamTag}`;
const ascending = (a, b) => a - b;

function checkTeamTag(teamTag) {
  if (typeof teamTag !== 'string' || !teamTag) throw new TypeError('teamTag must be a non-empty string');
}

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
  const listeners = new Set();
  // Applies run one after another, so two pastes in quick succession cannot
  // both read the old set and lose one another's serials.
  let queue = Promise.resolve();

  async function readSerials(teamTag) {
    const record = await readValue(db, SMS_TALLY_STORE, teamTag);
    if (!record || record.v !== RECORD_VERSION) return new Set();
    const key = await deviceKey();
    const plain = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: record.iv, additionalData: encoder.encode(additionalData(teamTag)) },
      key,
      record.ct,
    );
    const { serials } = JSON.parse(new TextDecoder().decode(plain));
    return new Set((Array.isArray(serials) ? serials : []).filter((n) => Number.isSafeInteger(n) && n >= 1));
  }

  async function writeSerials(teamTag, serials) {
    const key = await deviceKey();
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv, additionalData: encoder.encode(additionalData(teamTag)) },
      key,
      encoder.encode(JSON.stringify({ serials: [...serials].sort(ascending) })),
    );
    const tx = (await db()).transaction(SMS_TALLY_STORE, 'readwrite');
    const done = complete(tx);
    tx.objectStore(SMS_TALLY_STORE).put({ v: RECORD_VERSION, iv, ct: new Uint8Array(ct) }, teamTag);
    await done;
  }

  function notify(newSerials) {
    for (const callback of [...listeners]) {
      try {
        callback([...newSerials]);
      } catch (err) {
        log('an SMS tally subscriber failed', err);
      }
    }
  }

  async function merge(text, teamTag) {
    const decoded = decodeTallySms(text, teamTag);
    if (!decoded.ok) return { ok: false, reason: decoded.reason, workerId: null, newSerials: [], duplicateSerials: [] };
    const stored = await readSerials(teamTag);
    const newSerials = [];
    const duplicateSerials = [];
    for (const serial of [...new Set(decoded.serials)].sort(ascending)) {
      (stored.has(serial) ? duplicateSerials : newSerials).push(serial);
    }
    if (newSerials.length) {
      for (const serial of newSerials) stored.add(serial);
      await writeSerials(teamTag, stored);
      notify(newSerials);
    }
    return { ok: true, workerId: decoded.workerId, newSerials, duplicateSerials };
  }

  /**
   * Decode one pasted tally SMS and add its serials to the stored set.
   * @param {string} text the SMS as received
   * @param {{teamTag: string}} opts this installation's teamTag
   * @returns {Promise<{ok: boolean, workerId: string|null, newSerials: number[],
   *   duplicateSerials: number[], reason?: string}>} reason ('prefix',
   *   'format', 'checksum' or 'team') is set when ok is false
   * @throws when the stored set cannot be read or written
   */
  function applyTallySms(text, { teamTag } = {}) {
    try {
      checkTeamTag(teamTag);
    } catch (err) {
      return Promise.reject(err);
    }
    const run = queue.then(() => merge(text, teamTag));
    queue = run.catch(() => {});
    return run;
  }

  /** Every serial applied from SMS for this team, ascending. */
  async function loadAppliedSerials(teamTag) {
    checkTeamTag(teamTag);
    await queue;
    return [...(await readSerials(teamTag))].sort(ascending);
  }

  /** Call callback with each stored batch of newSerials; returns an unsubscribe function. */
  function onSerialsAdded(callback) {
    if (typeof callback !== 'function') throw new TypeError('callback must be a function');
    listeners.add(callback);
    return () => listeners.delete(callback);
  }

  applyTallySms.onSerialsAdded = onSerialsAdded;
  return { applyTallySms, loadAppliedSerials, onSerialsAdded };
}

let defaultInbox = null;
const inbox = () => (defaultInbox ||= createSmsInbox());

export const onSerialsAdded = (callback) => inbox().onSerialsAdded(callback);
export const loadAppliedSerials = async (teamTag) => inbox().loadAppliedSerials(teamTag);
export async function applyTallySms(text, opts) {
  return inbox().applyTallySms(text, opts);
}
applyTallySms.onSerialsAdded = onSerialsAdded;
