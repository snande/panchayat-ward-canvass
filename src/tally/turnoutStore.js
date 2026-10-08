// The official turnout figure for a ward, typed in by the coordinator at the
// end of polling day (issue #87), kept on the device beside the team's count.
//
// - The figure is a whole number of voters and nothing else. Input may use
//   ASCII or Devanagari digits ('412' and '४१२' are the same figure); anything
//   that is not a non-negative whole number is rejected before the store is
//   touched, so a rejected value never replaces the stored one.
// - Each record in the `turnout` object store is {v, iv, ct}, keyed by the
//   ward. `ct` is the WebCrypto AES-GCM encryption (the shared device key from
//   src/crypto/deviceKey.js, fresh 12-byte IV per write, `turnout:${ward}` as
//   additional data) of JSON.stringify({count}); the figure is never stored in
//   clear. This is the same key and AES-GCM handling as the roll store
//   (src/roll/rollStore.js).
//
// No network access: saving and loading work offline, and nothing is synced.

import { TURNOUT_STORE, complete, createDbOpener, readValue } from '../storage/deviceDb.js';
import { createDeviceKeyLoader } from '../crypto/deviceKey.js';

export { TURNOUT_STORE };
const RECORD_VERSION = 1;
const DEVANAGARI_ZERO = 0x0966;

/**
 * Parse a turnout figure: a non-negative whole number, given as a number or
 * as a string of ASCII or Devanagari digits (surrounding spaces allowed).
 * @returns {number}
 * @throws {TypeError} when the value is not a non-negative whole number
 */
export function parseTurnoutCount(value) {
  let n = NaN;
  if (typeof value === 'number') {
    n = value;
  } else if (typeof value === 'string') {
    const ascii = value.trim().replace(/[०-९]/g, (d) => String(d.charCodeAt(0) - DEVANAGARI_ZERO));
    if (/^\d+$/.test(ascii)) n = Number(ascii);
  }
  if (!Number.isSafeInteger(n) || n < 0) throw new TypeError('turnout must be a non-negative whole number of voters');
  return n;
}

function checkWard(ward) {
  if (typeof ward !== 'string' || !ward) throw new TypeError('ward must be a non-empty string');
}

const additionalData = (ward) => `turnout:${ward}`;

/**
 * @param {{indexedDB?: IDBFactory, crypto?: Crypto}} [deps] defaults to the
 *   browser globals; tests pass fakes
 */
export function createTurnoutStore({ indexedDB = globalThis.indexedDB, crypto = globalThis.crypto } = {}) {
  const encoder = new TextEncoder();
  const db = createDbOpener(indexedDB);
  const deviceKey = createDeviceKeyLoader({ db, crypto });

  /**
   * Encrypt and store the ward's official turnout, replacing any earlier one.
   * @returns {Promise<number>} the figure that was stored
   */
  async function saveOfficialTurnout(ward, value) {
    checkWard(ward);
    const count = parseTurnoutCount(value);
    const key = await deviceKey();
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv, additionalData: encoder.encode(additionalData(ward)) },
      key,
      encoder.encode(JSON.stringify({ count })),
    );
    const tx = (await db()).transaction(TURNOUT_STORE, 'readwrite');
    const done = complete(tx);
    tx.objectStore(TURNOUT_STORE).put({ v: RECORD_VERSION, iv, ct: new Uint8Array(ct) }, ward);
    await done;
    return count;
  }

  /** The ward's last saved official turnout, or null when none is stored. */
  async function loadOfficialTurnout(ward) {
    checkWard(ward);
    const record = await readValue(db, TURNOUT_STORE, ward);
    if (!record || record.v !== RECORD_VERSION) return null;
    const key = await deviceKey();
    const plain = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: record.iv, additionalData: encoder.encode(additionalData(ward)) },
      key,
      record.ct,
    );
    const { count } = JSON.parse(new TextDecoder().decode(plain));
    return Number.isSafeInteger(count) && count >= 0 ? count : null;
  }

  return { saveOfficialTurnout, loadOfficialTurnout };
}

let defaultStore = null;
const store = () => (defaultStore ||= createTurnoutStore());

export const saveOfficialTurnout = async (ward, value) => store().saveOfficialTurnout(ward, value);
export const loadOfficialTurnout = async (ward) => store().loadOfficialTurnout(ward);
