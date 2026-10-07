// Team join on the device (issue #48): the candidate code and the team
// passphrase yield a sync token and the team's encryption key.
//
// - The team key is AES-GCM 256-bit, derived with WebCrypto PBKDF2
//   (SHA-256, salt = the candidate code, PBKDF2_ITERATIONS rounds) and
//   imported with extractable: false, so every device of one team gets the
//   same key and no other candidate's passphrase yields it.
// - The server only ever sees the candidate code and a verifier,
//   base64url(SHA-256(PBKDF2 bits || 'verify')). POST /sync/join
//   (functions/sync.js) records the first verifier for a candidate and after
//   that issues a token only for the same verifier; anything else is a 401.
// - IndexedDB keeps the token, the candidate code and the key as a CryptoKey
//   object, like the device key in src/crypto/deviceKey.js. The passphrase
//   and the derived bits are never stored.
//
// getAuth() is how the sync engine gets its credentials.

import { KEYS_STORE, META_STORE, complete, createDbOpener, readValue } from '../storage/deviceDb.js';

export const JOIN_URL = '/sync/join';
export const PBKDF2_ITERATIONS = 210000;
export const TEAM_KEY_ID = 'team-key';
export const TEAM_AUTH_ID = 'team-auth';
// Same shape the server accepts for a candidateId.
export const CANDIDATE_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const RECORD_VERSION = 1;

/**
 * code: 'invalid-code' (candidate code has the wrong shape), 'invalid'
 * (empty passphrase), 'unauthorized' (wrong passphrase) or 'failed'.
 */
export class TeamJoinError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'TeamJoinError';
    this.code = code;
  }
}

// The same encoding as base64urlEncode in functions/sync.js. It is a copy,
// not an import: that file is bundled into the Pages Function, while this
// module runs on the device and is precached by sw.js, so neither side
// imports the other. test/teamAuth.test.js checks that the server stores
// exactly the verifier this produces.
function base64url(bytes) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * @param {{indexedDB?: IDBFactory, crypto?: Crypto, fetch?: typeof fetch, joinUrl?: string}} [deps]
 *   defaults to the browser globals; tests pass fakes
 */
export function createTeamAuth({
  indexedDB = globalThis.indexedDB,
  crypto = globalThis.crypto,
  fetch = (...args) => globalThis.fetch(...args),
  joinUrl = JOIN_URL,
} = {}) {
  const encoder = new TextEncoder();
  const db = createDbOpener(indexedDB);

  // The verifier for the server and the non-extractable team key, both from
  // one PBKDF2 derivation; the raw bits are wiped once both exist.
  async function deriveTeamSecrets(candidateId, passphrase) {
    const base = await crypto.subtle.importKey('raw', encoder.encode(passphrase), 'PBKDF2', false, ['deriveBits']);
    const bits = new Uint8Array(await crypto.subtle.deriveBits(
      { name: 'PBKDF2', salt: encoder.encode(candidateId), iterations: PBKDF2_ITERATIONS, hash: 'SHA-256' },
      base,
      256,
    ));
    const tag = encoder.encode('verify');
    const input = new Uint8Array(bits.length + tag.length);
    input.set(bits);
    input.set(tag, bits.length);
    try {
      const verifier = base64url(new Uint8Array(await crypto.subtle.digest('SHA-256', input)));
      const key = await crypto.subtle.importKey('raw', bits, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
      return { verifier, key };
    } finally {
      bits.fill(0);
      input.fill(0);
    }
  }

  async function requestToken(candidateId, verifier) {
    let response;
    try {
      response = await fetch(joinUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ candidateId, verifier }),
        cache: 'no-store',
      });
    } catch (err) {
      throw new TeamJoinError('failed', `join request failed: ${err && err.message}`);
    }
    if (response.status === 401) throw new TeamJoinError('unauthorized', 'wrong candidate code or passphrase');
    if (!response.ok) throw new TeamJoinError('failed', `join request failed: HTTP ${response.status}`);
    let body;
    try {
      body = await response.json();
    } catch {
      body = null;
    }
    if (!body || typeof body.token !== 'string' || !body.token || body.candidateId !== candidateId) {
      throw new TeamJoinError('failed', 'join response is malformed');
    }
    return { token: body.token, deviceId: typeof body.deviceId === 'string' ? body.deviceId : null };
  }

  /**
   * Join the candidate's team: get a device token and the team key, and
   * store both (with the candidate code) on the device.
   * @returns {Promise<{token: string, candidateId: string, key: CryptoKey}>}
   */
  async function joinTeam(candidateId, teamPassphrase) {
    const id = typeof candidateId === 'string' ? candidateId.trim() : '';
    if (!CANDIDATE_ID_PATTERN.test(id)) throw new TeamJoinError('invalid-code', 'candidate code is not valid');
    if (typeof teamPassphrase !== 'string' || !teamPassphrase.trim()) {
      throw new TeamJoinError('invalid', 'team passphrase is empty');
    }
    if (!crypto || !crypto.subtle) throw new Error('WebCrypto is not available');
    // NFC so the same Hindi passphrase typed on different keyboards matches.
    const { verifier, key } = await deriveTeamSecrets(id, teamPassphrase.normalize('NFC'));
    const { token, deviceId } = await requestToken(id, verifier);

    const tx = (await db()).transaction([KEYS_STORE, META_STORE], 'readwrite');
    const done = complete(tx);
    tx.objectStore(KEYS_STORE).put(key, TEAM_KEY_ID);
    tx.objectStore(META_STORE).put({ v: RECORD_VERSION, token, candidateId: id, deviceId }, TEAM_AUTH_ID);
    await done;
    return { token, candidateId: id, key };
  }

  /** The stored team credentials, or null when this device has not joined. */
  async function getAuth() {
    const record = await readValue(db, META_STORE, TEAM_AUTH_ID);
    if (!record || record.v !== RECORD_VERSION) return null;
    if (typeof record.token !== 'string' || typeof record.candidateId !== 'string') return null;
    const key = await readValue(db, KEYS_STORE, TEAM_KEY_ID);
    if (!key) return null;
    return { token: record.token, candidateId: record.candidateId, key };
  }

  return { joinTeam, getAuth };
}

let defaultAuth = null;
const auth = () => (defaultAuth ||= createTeamAuth());

export const joinTeam = (candidateId, teamPassphrase) => auth().joinTeam(candidateId, teamPassphrase);
export const getAuth = () => auth().getAuth();
