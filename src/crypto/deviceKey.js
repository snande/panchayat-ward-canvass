// The device's one encryption key, shared by every encrypted store.
//
// It is a WebCrypto AES-GCM 256-bit key generated on the device with
// extractable: false and kept in IndexedDB as a CryptoKey object, so its
// bytes can never be read by script.
//
// Its users: the roll store, the contact store, the sync engine's outbox and
// the seen-voting mark store (src/tally/seenVotingStore.js), whose marks are
// encrypted at rest with this same key, the official-turnout store
// (src/tally/turnoutStore.js) and the SMS tally inbox (src/tally/smsInbox.js).

import { KEYS_STORE, complete, readValue, request } from '../storage/deviceDb.js';

// The key was first created by the roll store under 'roll-key'; the stored id
// stays the same so devices that already hold a key (and rolls encrypted with
// it) keep using it.
export const DEVICE_KEY_ID = 'roll-key';

/**
 * @param {{db: () => Promise<IDBDatabase>, crypto?: Crypto | null}} deps
 * @returns {() => Promise<CryptoKey>} memoised loader; creates the key on first use
 */
export function createDeviceKeyLoader({ db, crypto }) {
  let keyPromise = null;

  async function createOrLoadKey() {
    const existing = await readValue(db, KEYS_STORE, DEVICE_KEY_ID);
    if (existing) return existing;
    const fresh = await crypto.subtle.generateKey(
      { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'],
    );
    // Another tab may have stored a key meanwhile: keep the first one written.
    const tx = (await db()).transaction(KEYS_STORE, 'readwrite');
    const done = complete(tx);
    const store = tx.objectStore(KEYS_STORE);
    let key = await request(store.get(DEVICE_KEY_ID));
    if (!key) {
      store.add(fresh, DEVICE_KEY_ID);
      key = fresh;
    }
    await done;
    return key;
  }

  return function deviceKey() {
    if (!crypto || !crypto.subtle) return Promise.reject(new Error('WebCrypto is not available'));
    if (!keyPromise) {
      keyPromise = createOrLoadKey().catch((err) => {
        keyPromise = null;
        throw err;
      });
    }
    return keyPromise;
  };
}
