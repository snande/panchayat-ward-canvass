// The team's SMS number (issue #103): where workers send their tally SMS when
// there is no mobile data. It is a per-team setting, never part of the public
// constituency config: the coordinator types it into the SMS entry screen
// (src/ui/smsEntryScreen.js) and it reaches every teammate's phone through the
// sync engine, like contacts.
//
// - The number is kept in international form: '+' and 8-15 digits. A
//   10-digit Indian mobile number (with or without a leading 0) gets +91;
//   spaces, dashes and brackets are dropped, and Devanagari digits read as
//   ASCII ones. Anything else is rejected before the store is touched.
// - On the device the `team` object store holds one record, keyed
//   'smsNumber': {v, iv, ct}, where `ct` is the WebCrypto AES-GCM encryption
//   (the shared device key from src/crypto/deviceKey.js, fresh 12-byte IV per
//   write, `team:smsNumber` as additional data) of
//   JSON.stringify({number, updatedAt}). The number is never stored in clear.
// - A save is queued for the team as the sync record
//   {id: 'team:smsNumber', updatedAt, data: {smsNumber}}, which the sync
//   engine encrypts with the team key. A pulled record replaces the local
//   number only when its updatedAt is later, so the last save on any phone
//   wins everywhere.
//
// Saving and reading work offline; the number goes out on the next sync.

import { TEAM_STORE, complete, createDbOpener, readValue } from '../storage/deviceDb.js';
import { createDeviceKeyLoader } from '../crypto/deviceKey.js';
import { enqueue, isNewer, onRemoteRecords } from '../sync/syncEngine.js';

export const TEAM_SMS_RECORD_ID = 'team:smsNumber';
const LOCAL_KEY = 'smsNumber';
const RECORD_VERSION = 1;
const DEVANAGARI_ZERO = 0x0966;

/**
 * The number in international form ('+919876543210'), or null when it is not
 * a phone number.
 */
export function normaliseSmsNumber(value) {
  if (typeof value !== 'string') return null;
  let text = value.trim()
    .replace(/[०-९]/g, (d) => String(d.charCodeAt(0) - DEVANAGARI_ZERO))
    .replace(/[\s\-().]/g, '');
  if (text.startsWith('00')) text = `+${text.slice(2)}`;
  if (/^0?\d{10}$/.test(text)) return `+91${text.slice(-10)}`;
  return /^\+[1-9]\d{7,14}$/.test(text) ? text : null;
}

/**
 * @param {{
 *   indexedDB?: IDBFactory, crypto?: Crypto,
 *   engine?: {enqueue: Function, onRemoteRecords: Function},
 *   now?: () => string, log?: Function,
 * }} [deps] defaults to the browser globals and the device's sync engine;
 *   tests pass fakes
 */
export function createTeamSmsNumber({
  indexedDB = globalThis.indexedDB,
  crypto = globalThis.crypto,
  engine = { enqueue, onRemoteRecords },
  now = () => new Date().toISOString(),
  log = (...args) => console.error(...args),
} = {}) {
  const encoder = new TextEncoder();
  const db = createDbOpener(indexedDB);
  const deviceKey = createDeviceKeyLoader({ db, crypto });
  const listeners = new Set();
  // Writes compare with the stored record first, so they run one at a time.
  let queue = Promise.resolve();
  const serialised = (fn) => {
    const run = queue.then(fn, fn);
    queue = run.catch(() => {});
    return run;
  };

  async function readLocal() {
    const record = await readValue(db, TEAM_STORE, LOCAL_KEY);
    if (!record || record.v !== RECORD_VERSION) return null;
    const plain = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: record.iv, additionalData: encoder.encode(TEAM_SMS_RECORD_ID) },
      await deviceKey(),
      record.ct,
    );
    const { number, updatedAt } = JSON.parse(new TextDecoder().decode(plain));
    const normal = normaliseSmsNumber(number);
    return normal ? { number: normal, updatedAt } : null;
  }

  async function writeLocal(number, updatedAt) {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv, additionalData: encoder.encode(TEAM_SMS_RECORD_ID) },
      await deviceKey(),
      encoder.encode(JSON.stringify({ number, updatedAt })),
    );
    const tx = (await db()).transaction(TEAM_STORE, 'readwrite');
    const done = complete(tx);
    tx.objectStore(TEAM_STORE).put({ v: RECORD_VERSION, iv, ct: new Uint8Array(ct) }, LOCAL_KEY);
    await done;
  }

  function notify(number) {
    for (const listener of [...listeners]) {
      try {
        listener(number);
      } catch (err) {
        log('a team SMS number listener failed', err);
      }
    }
  }

  /** The team's SMS number, or '' when none is set on this phone yet. */
  async function getTeamSmsNumber() {
    const local = await serialised(readLocal);
    return local ? local.number : '';
  }

  /**
   * Store the team's SMS number on this phone and queue it for the team.
   * @returns {Promise<string>} the number as stored
   * @throws {TypeError} when value is not a phone number (nothing is stored)
   */
  async function setTeamSmsNumber(value) {
    const number = normaliseSmsNumber(value);
    if (!number) throw new TypeError('the team SMS number must be a phone number with its country code');
    const updatedAt = now();
    await serialised(() => writeLocal(number, updatedAt));
    // The number is already saved on the phone; a failure to queue it is
    // logged rather than reported as a failed save.
    try {
      await engine.enqueue({ id: TEAM_SMS_RECORD_ID, updatedAt, data: { smsNumber: number } });
    } catch (err) {
      log('the team SMS number could not be queued for the team', err);
    }
    notify(number);
    return number;
  }

  /** Apply records pulled from the team; other record ids are ignored. Returns how many applied. */
  async function applyRemote(records) {
    let applied = 0;
    for (const record of records || []) {
      if (!record || record.id !== TEAM_SMS_RECORD_ID || !record.data) continue;
      const number = normaliseSmsNumber(record.data.smsNumber);
      if (!number) continue;
      try {
        const changed = await serialised(async () => {
          let local = null;
          try {
            local = await readLocal();
          } catch (err) {
            log('the stored team SMS number could not be read; replacing it', err);
          }
          if (local && !isNewer(record.updatedAt, local.updatedAt)) return false;
          await writeLocal(number, record.updatedAt);
          return true;
        });
        if (changed) {
          applied += 1;
          notify(number);
        }
      } catch (err) {
        log('a synced team SMS number could not be stored', err);
      }
    }
    return applied;
  }

  /** Apply every later pull to this phone; returns an unsubscribe function. */
  function listen() {
    return engine.onRemoteRecords(applyRemote);
  }

  /** Call listener(number) whenever the number changes here or arrives from the team. */
  function onChange(listener) {
    if (typeof listener !== 'function') throw new TypeError('listener must be a function');
    listeners.add(listener);
    return () => listeners.delete(listener);
  }

  return { getTeamSmsNumber, setTeamSmsNumber, applyRemote, listen, onChange };
}

let defaultStore = null;
const store = () => (defaultStore ||= createTeamSmsNumber());

export const getTeamSmsNumber = async () => store().getTeamSmsNumber();
export const setTeamSmsNumber = async (value) => store().setTeamSmsNumber(value);
export const listenForTeamSmsNumber = () => store().listen();
export const onTeamSmsNumberChange = (listener) => store().onChange(listener);
