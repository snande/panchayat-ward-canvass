// js/picker.js wiring for consent capture and team sync (issue #44): with
// the phone in airplane mode, tap a voter in the restored roll, record
// consent and a number; reopen the app the next day and the number is still
// there, and once online it reaches a teammate's device through
// functions/sync.js. Runs the real module against the fake DOM, a stubbed
// fetch and the in-memory IndexedDB.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { webcrypto } from 'node:crypto';

import { createDocument, type } from './helpers/fakeDom.js';
import { createFakeIndexedDB } from './helpers/fakeIndexedDB.js';
import { createSyncD1 } from './helpers/memoryD1.js';
import { onRequest as syncOnRequest } from '../functions/sync.js';
import { createSyncEngine, syncNow } from '../src/sync/syncEngine.js';
import { createTeamAuth } from '../src/sync/teamAuth.js';
import { createContactStore } from '../src/contacts/contactStore.js';
import { createContactSync, contactRecordId } from '../src/contacts/contactSync.js';
import { CONTACTS_STORE, DB_NAME, OUTBOX_STORE } from '../src/storage/deviceDb.js';

const root = (rel) => new URL('../' + rel, import.meta.url);
const read = (rel) => readFileSync(root(rel));
const ORIGIN = 'https://canvass.takshavid.com';
const WARD_KEY = '17/125/6313/1';
const PHONE = '9876543210';
const strings = JSON.parse(read('src/strings.hi.json'));

async function waitFor(cond, ms = 8000) {
  const until = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > until) throw new Error('timed out');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

const syncEnv = { SYNC_SECRET: 'test-sync-secret', SYNC_DB: await createSyncD1() };
const toServer = (url, init) => syncOnRequest({ request: new Request(new URL(url, ORIGIN), init), env: syncEnv });
const teamRecords = (candidateId) =>
  syncEnv.SYNC_DB.sqlite.query('SELECT seq FROM records WHERE candidate_id = ? ORDER BY seq', [candidateId]).map((r) => r.seq);
// Every row the sync store holds, as text, to check nothing plaintext lands.
const storedText = (db) =>
  ['records', 'counters', 'marks', 'verifiers'].map((t) => JSON.stringify(db.sqlite.query(`SELECT * FROM ${t}`, []))).join('\n');

// offline: every request except the precached shell files (served by sw.js)
// fails like a phone in airplane mode.
function boot(idb, { offline = false } = {}) {
  const requests = [];
  const doc = createDocument();
  const picker = doc.createElement('section');
  const roll = doc.createElement('section');
  roll.setAttribute('hidden', '');
  const empty = doc.createElement('section');
  const team = doc.createElement('section');
  team.setAttribute('hidden', '');
  const byId = { 'ward-picker': picker, roll, 'team-join': team };
  const fakeDocument = {
    getElementById: (id) => byId[id] || null,
    querySelector: (sel) => (sel === '.empty-state' ? empty : null),
    createElement: (tag) => doc.createElement(tag),
    ownerDocument: doc,
  };
  picker.ownerDocument = doc;
  const fetch = async (input, init) => {
    const url = String(input);
    requests.push(url);
    if (url.startsWith('file:')) return new Response(readFileSync(fileURLToPath(url)));
    if (url === 'src/strings.hi.json') return new Response(read('src/strings.hi.json'));
    if (url === 'config/constituency.json') return new Response(read('config/constituency.json'));
    if (offline) throw new TypeError('Failed to fetch');
    if (url.startsWith('/sync/')) return toServer(url, init);
    if (url.startsWith('/roll?url=')) {
      return new Response(read('fixtures/badli-ward1.pdf'), { headers: { 'Content-Type': 'application/pdf' } });
    }
    return new Response('', { status: 404 });
  };
  const saved = {};
  const globals = { document: fakeDocument, window: {}, fetch, indexedDB: idb };
  for (const [k, v] of Object.entries(globals)) {
    saved[k] = Object.getOwnPropertyDescriptor(globalThis, k);
    Object.defineProperty(globalThis, k, { value: v, configurable: true, writable: true });
  }
  const restore = () => {
    for (const [k, d] of Object.entries(saved)) {
      if (d) Object.defineProperty(globalThis, k, d);
      else delete globalThis[k];
    }
  };
  return { picker, roll, team, requests, restore };
}

function choose(select, value) {
  select.value = value;
  select.dispatchEvent({ type: 'change' });
}

const firstRow = (page) => page.roll.querySelector('div.roll-row');
const panelOf = (page) => page.roll.querySelector('section.contact-panel');
const button = (page, cls) => panelOf(page).querySelector(`button.${cls}`);
const message = (page) => panelOf(page).querySelector('p.contact-message').textContent;
const stored = (idb, name) => idb.databases.get(DB_NAME)?.stores.get(name) ?? new Map();

test('airplane mode on, record consent and a number, reopen the next day: it is kept and reaches the team', async () => {
  const idb = createFakeIndexedDB();

  // Day 0, online: join the team and download the ward roll.
  const setup = boot(idb);
  try {
    await import('../js/picker.js?contacts=1');
    await waitFor(() => setup.team.querySelector('form') !== null);
    const [code, pass] = setup.team.querySelectorAll('input');
    code.value = 'candA';
    pass.value = 'हमारी टीम';
    setup.team.querySelector('form').dispatchEvent({ type: 'submit', preventDefault() {} });
    await waitFor(() => setup.team.hidden === true);
    await waitFor(() => setup.picker.querySelector('select') !== null);
    const [district, samiti, panchayat, ward] = setup.picker.querySelectorAll('select');
    choose(district, '17');
    choose(samiti, '125');
    choose(panchayat, '6313');
    choose(ward, '1');
    await waitFor(() => firstRow(setup) !== null);
  } finally {
    setup.restore();
  }

  // Airplane mode: the stored roll opens; tap a voter, record consent and a number.
  const airplane = boot(idb, { offline: true });
  let voterName;
  try {
    await import('../js/picker.js?contacts=2');
    await waitFor(() => firstRow(airplane) !== null);
    voterName = firstRow(airplane).querySelector('span.roll-name').textContent;
    firstRow(airplane).dispatchEvent({ type: 'click' });
    await waitFor(() => panelOf(airplane) !== null);
    assert.equal(panelOf(airplane).querySelector('h2').textContent, voterName);
    await waitFor(() => !button(airplane, 'contact-consent').hidden);
    assert.equal(message(airplane), '');

    button(airplane, 'contact-consent').dispatchEvent({ type: 'click' });
    await waitFor(() => message(airplane) === strings.contact_consent_done);
    type(panelOf(airplane).querySelector('input'), PHONE);
    panelOf(airplane).querySelector('form').dispatchEvent({ type: 'submit', preventDefault() {} });
    await waitFor(() => message(airplane) === strings.contact_saved);

    // On the device, encrypted, and waiting in the outbox: nothing reached the server.
    assert.equal(stored(idb, CONTACTS_STORE).size, 1);
    const [contactKey] = stored(idb, CONTACTS_STORE).keys();
    assert.ok(contactKey.startsWith(`${WARD_KEY}:`), contactKey);
    assert.deepEqual([...stored(idb, OUTBOX_STORE).keys()], [`contact:${contactKey}`]);
    for (const value of stored(idb, CONTACTS_STORE).values()) {
      assert.ok(!Buffer.from(value.ct).includes(Buffer.from(PHONE)));
    }
    assert.deepEqual(teamRecords('candA'), []);
    assert.ok(!airplane.requests.some((u) => u.startsWith('/roll')), airplane.requests.join('\n'));
  } finally {
    airplane.restore();
  }

  // The next day, the app is opened again: the voter shows the saved number.
  const nextDay = boot(idb);
  try {
    await import('../js/picker.js?contacts=3');
    await waitFor(() => firstRow(nextDay) !== null);
    assert.equal(nextDay.team.hidden, true);
    firstRow(nextDay).dispatchEvent({ type: 'click' });
    await waitFor(() => panelOf(nextDay) !== null && panelOf(nextDay).querySelector('input').value === PHONE);
    assert.equal(button(nextDay, 'contact-consent').hidden, true);

    // Back online: the sync that picker.js started (run on reconnect, on
    // page show and every 60 s while shown) delivers the queued number to the team.
    const result = await syncNow();
    assert.equal(result.status, 'ok', String(result.error));
    assert.equal(stored(idb, OUTBOX_STORE).size, 0);
    assert.equal(teamRecords('candA').length, 1);
    assert.ok(!storedText(syncEnv.SYNC_DB).includes(PHONE));
  } finally {
    nextDay.restore();
  }

  // A teammate's device on the same candidate's team receives it; another
  // candidate's team does not.
  async function teamDevice(candidateId, passphrase) {
    const otherIdb = createFakeIndexedDB();
    const auth = createTeamAuth({ indexedDB: otherIdb, crypto: webcrypto, fetch: toServer });
    await auth.joinTeam(candidateId, passphrase);
    const engine = createSyncEngine({
      indexedDB: otherIdb, crypto: webcrypto, fetch: toServer, getAuth: auth.getAuth,
      window: null, document: null, navigator: { onLine: true }, setInterval: () => 0, clearInterval: () => {},
    });
    const store = createContactStore({ indexedDB: otherIdb, crypto: webcrypto, storage: null });
    createContactSync({ contacts: store, engine }).listen();
    await engine.syncNow();
    return store;
  }
  const serial = Number(voterName.split('.')[0]);
  const teammate = await teamDevice('candA', 'हमारी टीम');
  assert.equal((await teammate.getContact(WARD_KEY, serial)).phone, PHONE);
  assert.equal(contactRecordId(WARD_KEY, serial), `contact:${WARD_KEY}:${serial}`);
  const rival = await teamDevice('candB', 'दूसरी टीम');
  assert.equal(await rival.getContact(WARD_KEY, serial), null);
});
