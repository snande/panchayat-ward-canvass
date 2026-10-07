// Client sync engine (issue #49): records saved on this device reach the
// rest of the candidate's team through functions/sync.js.
//
// - enqueue({id, updatedAt, data}) puts the record in the `outbox` object
//   store, keyed by id. At rest the outbox holds {id, updatedAt, iv, ct}:
//   `data` is encrypted with the device key (src/crypto/deviceKey.js), so a
//   record can be saved before the device has joined its team.
// - syncNow() pushes the outbox, then pulls. Each record's `data` is
//   encrypted for the team with the team key from getAuth() (AES-GCM, fresh
//   12-byte IV, additional data JSON.stringify([id, updatedAt]) so the server
//   cannot move a ciphertext to another id or time) and POSTed to /sync/push
//   in batches of PUSH_BATCH_SIZE. A batch's outbox entries are deleted only
//   after its 2xx response, and only if they were not saved again while the
//   push was in flight; a failed or offline push leaves every undelivered
//   entry for the next attempt. The pull runs even when the push failed, so
//   a push the server keeps refusing never cuts the device off from its
//   teammates' records.
// - The pull asks GET /sync/pull?since=<cursor>, with the cursor kept in the
//   meta store. Records that fail to decrypt with this team's key are
//   discarded. The rest are merged by id against the `synced` store, which
//   keeps only {updatedAt} per id (never the plaintext): a record reaches
//   the onRemoteRecords callbacks only when its updatedAt is newer than what
//   this device has already seen, pushed or still has waiting in its outbox,
//   so pulling a record twice delivers it once. The index and the cursor are
//   written after the callbacks return, so a crash in between re-delivers
//   rather than loses.
// - start() runs syncNow() at startup, on the window `online` event, when the
//   page becomes visible, and every SYNC_INTERVAL_MS while navigator.onLine.
//
// With no team credentials (getAuth() returns null) nothing touches the
// network. Requests use cache: 'no-store', and sw.js leaves /sync/* to the
// network.

import {
  META_STORE, OUTBOX_STORE, SYNCED_STORE, complete, createDbOpener, readValue, request,
} from '../storage/deviceDb.js';
import { createDeviceKeyLoader } from '../crypto/deviceKey.js';
import { getAuth as storedAuth } from './teamAuth.js';

export const PUSH_URL = '/sync/push';
export const PULL_URL = '/sync/pull';
export const SYNC_INTERVAL_MS = 30000;
// MAX_PUSH_RECORDS in functions/sync.js.
export const PUSH_BATCH_SIZE = 500;
export const CURSOR_ID = 'sync-cursor';
const CURSOR_VERSION = 1;
const IV_BYTES = 12;
// A pull answers at most 1000 records; this bounds one syncNow() to 50 000.
const MAX_PULL_PAGES = 50;

// The same encoding as base64urlEncode in functions/sync.js (see the note in
// src/sync/teamAuth.js on why it is copied rather than imported).
function base64urlEncode(bytes) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64urlDecode(text) {
  if (typeof text !== 'string' || !/^[A-Za-z0-9_-]*$/.test(text)) return null;
  const padded = text.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (text.length % 4)) % 4);
  try {
    return Uint8Array.from(atob(padded), (ch) => ch.charCodeAt(0));
  } catch {
    return null;
  }
}

// The server's id rule for a pushed record.
function validId(id) {
  return typeof id === 'string' && id.length > 0 && id.length <= 200;
}

// Epoch milliseconds, or a date string Date.parse reads (ISO 8601). Stricter
// than the server, so every updatedAt can be compared with every other one.
function validUpdatedAt(updatedAt) {
  if (typeof updatedAt === 'number') return Number.isFinite(updatedAt);
  return typeof updatedAt === 'string' && Number.isFinite(Date.parse(updatedAt));
}

/**
 * True when updatedAt `a` is strictly later than `b`. Numbers compare as
 * numbers and strings (ISO timestamps) as strings; a number against a string
 * compares as epoch milliseconds.
 */
export function isNewer(a, b) {
  if (typeof a === typeof b) return a > b;
  const ms = (v) => (typeof v === 'number' ? v : Date.parse(v));
  return ms(a) > ms(b);
}

function sameBytes(a, b) {
  if (!a || !b || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) return false;
  return true;
}

/**
 * @param {{
 *   indexedDB?: IDBFactory, crypto?: Crypto, fetch?: typeof fetch,
 *   getAuth?: () => Promise<{token: string, candidateId: string, key: CryptoKey} | null>,
 *   pushUrl?: string, pullUrl?: string,
 *   window?: EventTarget, document?: EventTarget & {visibilityState?: string},
 *   navigator?: {onLine?: boolean},
 *   setInterval?: typeof setInterval, clearInterval?: typeof clearInterval,
 * }} [deps] defaults to the browser globals; tests pass fakes
 */
export function createSyncEngine({
  indexedDB = globalThis.indexedDB,
  crypto = globalThis.crypto,
  fetch = (...args) => globalThis.fetch(...args),
  getAuth = storedAuth,
  pushUrl = PUSH_URL,
  pullUrl = PULL_URL,
  window: win = globalThis.window,
  document: doc = globalThis.document,
  navigator: nav = globalThis.navigator,
  // Under Node (tests importing js/picker.js) the timer must not keep the
  // process alive; browsers return a number and skip the unref.
  setInterval: every = (fn, ms) => {
    const handle = globalThis.setInterval(fn, ms);
    if (handle && typeof handle.unref === 'function') handle.unref();
    return handle;
  },
  clearInterval: stopEvery = (handle) => globalThis.clearInterval(handle),
} = {}) {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const db = createDbOpener(indexedDB);
  const deviceKey = createDeviceKeyLoader({ db, crypto });
  const callbacks = new Set();

  const aad = (id, updatedAt) => encoder.encode(JSON.stringify([id, updatedAt]));

  /** Save a record for the team. A later save of the same id replaces it unless it is older. */
  async function enqueue(record) {
    const { id, updatedAt, data } = record || {};
    if (!validId(id)) throw new TypeError('record id must be a string of 1-200 characters');
    if (!validUpdatedAt(updatedAt)) {
      throw new TypeError('record updatedAt must be epoch milliseconds or an ISO date string');
    }
    const plain = JSON.stringify(data);
    if (plain === undefined) throw new TypeError('record data must be JSON-serialisable');

    const key = await deviceKey();
    const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
    const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: aad(id, updatedAt) }, key, encoder.encode(plain));

    const tx = (await db()).transaction(OUTBOX_STORE, 'readwrite');
    const done = complete(tx);
    const store = tx.objectStore(OUTBOX_STORE);
    const existing = await request(store.get(id));
    if (!existing || !isNewer(existing.updatedAt, updatedAt)) {
      store.put({ id, updatedAt, iv, ct: new Uint8Array(ct) }, id);
    }
    await done;
  }

  /** Register a callback for decrypted records from a pull; returns an unsubscribe function. */
  function onRemoteRecords(callback) {
    if (typeof callback !== 'function') throw new TypeError('callback must be a function');
    callbacks.add(callback);
    return () => callbacks.delete(callback);
  }

  async function readAll(storeName) {
    const tx = (await db()).transaction(storeName, 'readonly');
    const done = complete(tx);
    const values = await request(tx.objectStore(storeName).getAll());
    await done;
    return values;
  }

  // Outbox entry -> {id, updatedAt, ciphertext, iv} for the server, or null
  // when the device key can no longer open it (it then stays in the outbox).
  async function sealForTeam(teamKey, entry) {
    let plain;
    try {
      plain = await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: entry.iv, additionalData: aad(entry.id, entry.updatedAt) },
        await deviceKey(),
        entry.ct,
      );
    } catch {
      return null;
    }
    const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
    const ct = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv, additionalData: aad(entry.id, entry.updatedAt) }, teamKey, plain,
    );
    return { id: entry.id, updatedAt: entry.updatedAt, ciphertext: base64urlEncode(new Uint8Array(ct)), iv: base64urlEncode(iv) };
  }

  // Pulled record -> {id, updatedAt, data}, or null when it is malformed or
  // does not decrypt with this team's key.
  async function openFromTeam(teamKey, record) {
    if (!record || typeof record !== 'object') return null;
    const { id, updatedAt } = record;
    if (!validId(id) || !validUpdatedAt(updatedAt)) return null;
    const iv = base64urlDecode(record.iv);
    const ct = base64urlDecode(record.ciphertext);
    if (!iv || iv.length !== IV_BYTES || !ct) return null;
    try {
      const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv, additionalData: aad(id, updatedAt) }, teamKey, ct);
      return { id, updatedAt, data: JSON.parse(decoder.decode(plain)) };
    } catch {
      return null;
    }
  }

  async function send(url, init, auth) {
    const response = await fetch(url, {
      ...init,
      headers: { ...(init.headers || {}), Authorization: `Bearer ${auth.token}` },
      cache: 'no-store',
    });
    if (!response.ok) throw new Error(`${url} failed: HTTP ${response.status}`);
    return response;
  }

  // Returns {pushed, error}: the entries delivered before the first failure,
  // which (if any) stops the push and leaves the rest of the outbox in place.
  async function push(auth) {
    let pushed = 0;
    try {
      const entries = await readAll(OUTBOX_STORE);
      for (let start = 0; start < entries.length; start += PUSH_BATCH_SIZE) {
        const batch = [];
        const records = [];
        for (const entry of entries.slice(start, start + PUSH_BATCH_SIZE)) {
          const sealed = await sealForTeam(auth.key, entry);
          if (!sealed) continue;
          batch.push(entry);
          records.push(sealed);
        }
        if (records.length === 0) continue;
        await send(pushUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ records }),
        }, auth);

        // Delivered: drop the entries that were not saved again meanwhile, and
        // note their updatedAt so their echo from the next pull is not news.
        const tx = (await db()).transaction([OUTBOX_STORE, SYNCED_STORE], 'readwrite');
        const done = complete(tx);
        const outbox = tx.objectStore(OUTBOX_STORE);
        const synced = tx.objectStore(SYNCED_STORE);
        for (const entry of batch) {
          const current = await request(outbox.get(entry.id));
          if (current && current.updatedAt === entry.updatedAt && sameBytes(current.iv, entry.iv)) {
            outbox.delete(entry.id);
          }
          const seen = await request(synced.get(entry.id));
          if (!seen || isNewer(entry.updatedAt, seen.updatedAt)) synced.put({ updatedAt: entry.updatedAt }, entry.id);
        }
        await done;
        pushed += batch.length;
      }
    } catch (error) {
      return { pushed, error };
    }
    return { pushed, error: null };
  }

  async function readCursor(candidateId) {
    const stored = await readValue(db, META_STORE, CURSOR_ID);
    // A cursor from another team (the device rejoined) does not apply.
    if (!stored || stored.v !== CURSOR_VERSION || stored.candidateId !== candidateId) return 0;
    return Number.isSafeInteger(stored.cursor) && stored.cursor >= 0 ? stored.cursor : 0;
  }

  // Of the opened records, those newer than anything this device has seen,
  // pushed or still has waiting in its outbox; one per id.
  async function newerThanLocal(records) {
    const latest = new Map();
    for (const record of records) {
      const prev = latest.get(record.id);
      if (!prev || isNewer(record.updatedAt, prev.updatedAt)) latest.set(record.id, record);
    }
    const tx = (await db()).transaction([SYNCED_STORE, OUTBOX_STORE], 'readonly');
    const done = complete(tx);
    const synced = tx.objectStore(SYNCED_STORE);
    const outbox = tx.objectStore(OUTBOX_STORE);
    const winners = [];
    for (const record of latest.values()) {
      const seen = await request(synced.get(record.id));
      if (seen && !isNewer(record.updatedAt, seen.updatedAt)) continue;
      const pending = await request(outbox.get(record.id));
      if (pending && !isNewer(record.updatedAt, pending.updatedAt)) continue;
      winners.push(record);
    }
    await done;
    return winners;
  }

  async function commitPull(candidateId, winners, cursor) {
    const tx = (await db()).transaction([SYNCED_STORE, META_STORE], 'readwrite');
    const done = complete(tx);
    const synced = tx.objectStore(SYNCED_STORE);
    for (const record of winners) {
      const seen = await request(synced.get(record.id));
      if (!seen || isNewer(record.updatedAt, seen.updatedAt)) synced.put({ updatedAt: record.updatedAt }, record.id);
    }
    tx.objectStore(META_STORE).put({ v: CURSOR_VERSION, candidateId, cursor }, CURSOR_ID);
    await done;
  }

  async function deliver(records) {
    if (records.length === 0) return;
    for (const callback of [...callbacks]) {
      try {
        await callback(records.map((record) => ({ ...record })));
      } catch (err) {
        console.error('sync: a remote-records callback failed', err);
      }
    }
  }

  async function pull(auth) {
    let cursor = await readCursor(auth.candidateId);
    let received = 0;
    for (let page = 0; page < MAX_PULL_PAGES; page += 1) {
      const response = await send(`${pullUrl}?since=${cursor}`, { method: 'GET' }, auth);
      const body = await response.json();
      if (!body || !Array.isArray(body.records) || !Number.isSafeInteger(body.cursor) || body.cursor < 0) {
        throw new Error('pull response is malformed');
      }
      const opened = [];
      for (const record of body.records) {
        const open = await openFromTeam(auth.key, record);
        if (open) opened.push(open);
      }
      const winners = await newerThanLocal(opened);
      await deliver(winners);
      const next = Math.max(cursor, body.cursor);
      await commitPull(auth.candidateId, winners, next);
      received += winners.length;
      if (!body.more || next === cursor) break;
      cursor = next;
    }
    return received;
  }

  async function runSync() {
    let auth;
    try {
      auth = await getAuth();
    } catch (error) {
      return { status: 'failed', pushed: 0, received: 0, error };
    }
    if (!auth || !auth.key || typeof auth.token !== 'string') return { status: 'no-auth', pushed: 0, received: 0 };
    const { pushed, error: pushError } = await push(auth);
    let received = 0;
    try {
      received = await pull(auth);
    } catch (error) {
      return { status: 'failed', pushed, received, error: pushError || error };
    }
    if (pushError) return { status: 'failed', pushed, received, error: pushError };
    return { status: 'ok', pushed, received };
  }

  let running = null;
  let queued = null;

  /**
   * Push the outbox, then pull. Never rejects: resolves with
   * {status: 'ok' | 'no-auth' | 'failed', pushed, received, error?}. A call
   * made while a sync is running gets one more sync after it, so records
   * saved meanwhile are not left waiting for the next trigger.
   */
  function syncNow() {
    if (!running) {
      running = runSync().finally(() => {
        running = null;
      });
      return running;
    }
    if (!queued) {
      queued = running.then(() => {
        queued = null;
        return syncNow();
      });
    }
    return queued;
  }

  let started = false;
  let timer = null;
  const trigger = () => {
    syncNow();
  };
  const onVisible = () => {
    if (doc && doc.visibilityState === 'visible') trigger();
  };
  const onTick = () => {
    if (!nav || nav.onLine !== false) trigger();
  };

  /** Sync now and on every later trigger (online, visible, every 30 s while online). */
  function start() {
    if (started) return;
    started = true;
    if (win && typeof win.addEventListener === 'function') win.addEventListener('online', trigger);
    if (doc && typeof doc.addEventListener === 'function') doc.addEventListener('visibilitychange', onVisible);
    timer = every(onTick, SYNC_INTERVAL_MS);
    trigger();
  }

  function stop() {
    if (!started) return;
    started = false;
    if (win && typeof win.removeEventListener === 'function') win.removeEventListener('online', trigger);
    if (doc && typeof doc.removeEventListener === 'function') doc.removeEventListener('visibilitychange', onVisible);
    stopEvery(timer);
    timer = null;
  }

  return { enqueue, syncNow, onRemoteRecords, start, stop };
}

let defaultEngine = null;
const engine = () => (defaultEngine ||= createSyncEngine());

export const enqueue = (record) => engine().enqueue(record);
export const syncNow = () => engine().syncNow();
export const onRemoteRecords = (callback) => engine().onRemoteRecords(callback);
export const startSync = () => engine().start();
