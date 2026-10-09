// Voter route (issue #139): `#/voter/<ward>/<serial>` opens one voter's card
// from the encrypted roll stored on the phone, with loading, empty and error
// states, a back button over browser history, and no network request. It is
// the app's only voter card.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { webcrypto } from 'node:crypto';
import vm from 'node:vm';

import {
  startVoterRoute, createVoterRouteScreen, parseVoterRoute, voterRouteHash, resolveWardKey,
  FALLBACK_TEXT, VOTER_ROUTE_STATES,
} from '../src/ui/voterRoute.js';
import { createRollStore } from '../src/roll/rollStore.js';
import { mountRollWithSearch } from '../src/ui/rollSearch.js';
import { createContactStore } from '../src/contacts/contactStore.js';
import { saveSeat, SEAT_STORAGE_KEY } from '../src/ui/seatHeader.js';
import { createDocument, type } from './helpers/fakeDom.js';
import { createFakeIndexedDB } from './helpers/fakeIndexedDB.js';

const read = (rel) => readFileSync(new URL('../' + rel, import.meta.url), 'utf8');
const table = JSON.parse(read('src/strings.hi.json'));
const appUrl = new URL('../js/app.js', import.meta.url);

const WARD_1 = '17/125/6313/1';
const WARD_3 = '17/125/6313/3';
const ENTRIES = [
  { serial: 145, name: 'नन्दकिशोर', relative: 'सत्यनारायण', age: 38, gender: 'पुरूष', house: '7' },
  { serial: 146, name: 'किशनादेवी', relative: 'सत्यनारायण', age: 57, gender: 'स्त्री', house: '7' },
];
const SEAT = () => ({ seatType: 'ward', panchayat: 'बडली', ward: '3' });

async function storedRoll() {
  const idb = createFakeIndexedDB();
  const store = createRollStore({ indexedDB: idb, crypto: webcrypto });
  await store.encryptAndStore(WARD_3, ENTRIES);
  return { idb, store };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

async function waitFor(cond, ms = 5000) {
  const until = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > until) throw new Error('timed out');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

// A window with a settable location.hash that fires hashchange, like a browser.
function fakeWindow(hash, historyLength = 2) {
  const listeners = new Map();
  const win = {
    backs: 0,
    replaced: [],
    location: { pathname: '/', search: '', hash },
    history: {
      length: historyLength,
      back() { win.backs += 1; },
      replaceState(state, title, url) { win.replaced.push(url); win.location.hash = ''; },
    },
    addEventListener(type, fn) { listeners.set(type, fn); },
    go(next) {
      win.location.hash = next;
      listeners.get('hashchange')();
    },
  };
  return win;
}

function mount(hash, opts = {}) {
  const doc = createDocument();
  const main = doc.createElement('main');
  const section = doc.createElement('section');
  section.hidden = true;
  main.appendChild(section);
  doc.body.appendChild(main);
  const win = opts.window || fakeWindow(hash);
  const logs = [];
  const route = startVoterRoute(section, table, {
    window: win, main, store: opts.store, seat: opts.seat || SEAT, log: (...a) => logs.push(a),
  });
  return { doc, main, section, win, route, logs };
}

const state = (section) => section.querySelector('div.voter-route').getAttribute('data-state');
const message = (section) => section.querySelector('p.voter-route-message');
const contactLine = (section) => section.querySelector('p.voter-route-contact');
const seatLine = (section) => section.querySelector('p.voter-route-seat').textContent;

// Any fetch while a voter opens fails the test.
function noNetwork(t) {
  const calls = [];
  const saved = globalThis.fetch;
  globalThis.fetch = (...args) => { calls.push(args); return Promise.reject(new Error('network')); };
  t.after(() => { globalThis.fetch = saved; });
  return calls;
}

test('the route parses #/voter/<ward>/<serial> and builds it back', () => {
  assert.deepEqual(parseVoterRoute('#/voter/3/145'), { ward: '3', serial: 145 });
  assert.deepEqual(parseVoterRoute('#/voter/03/145/'), { ward: '3', serial: 145 });
  for (const bad of ['', '#roll', '#/voter/3/', '#/voter//145', '#/voter/3/abc', '#/voter/3/145/9']) {
    assert.equal(parseVoterRoute(bad), null, bad);
  }
  assert.equal(voterRouteHash(3, 145), '#/voter/3/145');
  assert.deepEqual(parseVoterRoute(voterRouteHash('03', '145')), { ward: '3', serial: 145 });
  assert.deepEqual(VOTER_ROUTE_STATES, ['loading', 'empty', 'error', 'card']);
});

test('the ward resolves in the loaded panchayat, the one of the last stored roll', () => {
  assert.equal(resolveWardKey(WARD_1, '3'), WARD_3);
  assert.equal(resolveWardKey(null, '3'), null);
  assert.equal(resolveWardKey('broken', '3'), null);
});

test('setting location.hash to a stored ward/serial renders the voter card, with no network request', async (t) => {
  const fetches = noNetwork(t);
  const { store } = await storedRoll();
  const { section, main, route, win } = mount('#roll', { store });
  assert.equal(section.hidden, true);
  assert.equal(await route.settled, null);

  win.go('#/voter/3/145');
  assert.equal(await route.settled, 'card');
  assert.equal(section.hidden, false);
  assert.equal(main.getAttribute('data-route'), 'voter');
  assert.equal(state(section), 'card');
  const card = section.querySelector('section.voter-roll-card');
  assert.ok(card, 'the renderVoterCard panel');
  assert.equal(section.querySelector('h2.panel-title').textContent, 'नन्दकिशोर');
  assert.ok(card.textContent.includes('145'));
  assert.equal(seatLine(section), 'पंचायत: बडली · वार्ड: 3');
  assert.deepEqual(fetches, []);
});

test('an unknown serial and an unknown ward each render the Hindi empty state with the coordinator line', async (t) => {
  const fetches = noNetwork(t);
  const { store } = await storedRoll();
  const { section, route, win } = mount('#/voter/3/999', { store });
  assert.equal(await route.settled, 'empty');
  assert.equal(message(section).textContent, table.voter_route_empty);
  assert.equal(message(section).getAttribute('data-tone'), 'info');
  assert.match(table.voter_route_empty, /खोज पर वापस जाएँ/, 'says to go back to search');
  assert.equal(contactLine(section).textContent, table.voter_route_empty_contact);
  assert.match(table.voter_route_empty_contact, /समन्वयक/, 'names the team coordinator');
  assert.equal(section.querySelector('section.voter-roll-card'), null);

  win.go('#/voter/9/145');
  assert.equal(await route.settled, 'empty');
  assert.equal(message(section).textContent, table.voter_route_empty);
  assert.deepEqual(fetches, []);
});

test('a ward of another panchayat is not looked up there: the route searches the loaded panchayat only', async () => {
  // Ward 3 of panchayat 6313 is stored, then ward 3 of panchayat 7000 is the
  // last roll stored: "3/145" now means ward 3 of 7000, which has no 145.
  const { store } = await storedRoll();
  await store.encryptAndStore('17/125/7000/3', [{ serial: 1, name: 'राधा', age: 30 }]);
  const seen = [];
  const spy = { lastWardKey: store.lastWardKey, loadStored: (k) => { seen.push(k); return store.loadStored(k); } };
  const { section, route } = mount('#/voter/3/145', { store: spy, seat: () => ({ seatType: 'ward', panchayat: 'दूसरी', ward: '3' }) });
  assert.equal(await route.settled, 'empty');
  assert.deepEqual(seen, ['17/125/7000/3']);
  assert.equal(seatLine(section), 'पंचायत: दूसरी · वार्ड: 3');
});

test('the seat line names the panchayat only when the stored seat is the searched roll\'s, else the ward alone', async () => {
  const { store } = await storedRoll();
  // The stored seat is ward 8 while the last stored roll is ward 3: the two
  // stores disagree, so the line does not name the seat's panchayat.
  const { section, route } = mount('#/voter/3/145', { store, seat: () => ({ seatType: 'ward', panchayat: 'दूसरी', ward: '8' }) });
  assert.equal(await route.settled, 'card');
  assert.equal(seatLine(section), 'वार्ड: 3');
});

test('with no roll stored at all, and for a malformed voter address, the screen is the empty state', async () => {
  const empty = createRollStore({ indexedDB: createFakeIndexedDB(), crypto: webcrypto });
  const { section, route, win } = mount('#/voter/3/145', { store: empty });
  assert.equal(await route.settled, 'empty');
  win.go('#/voter/3/abc');
  assert.equal(await route.settled, 'empty');
  assert.equal(section.hidden, false);
  assert.equal(message(section).textContent, table.voter_route_empty);
});

test('the loading state shows while the lookup is pending', async () => {
  const gate = deferred();
  const { store } = await storedRoll();
  const slow = { lastWardKey: store.lastWardKey, loadStored: async (k) => { await gate.promise; return store.loadStored(k); } };
  const { section, route } = mount('#/voter/3/145', { store: slow });
  assert.equal(state(section), 'loading');
  assert.equal(section.querySelector('div.voter-route').getAttribute('aria-busy'), 'true');
  assert.equal(message(section).textContent, table.voter_route_loading);
  assert.ok(section.querySelector('div.progress'));
  gate.resolve();
  assert.equal(await route.settled, 'card');
  assert.equal(section.querySelector('div.voter-route').getAttribute('aria-busy'), null);
});

test('a storage or decryption failure renders the error state with whom to call and a retry that looks up again', async (t) => {
  const fetches = noNetwork(t);
  const { store } = await storedRoll();
  let reads = 0;
  const flaky = {
    lastWardKey: store.lastWardKey,
    loadStored: async (k) => {
      reads += 1;
      if (reads === 1) throw new Error('OperationError: decryption failed');
      return store.loadStored(k);
    },
  };
  const { section, route, logs } = mount('#/voter/3/145', { store: flaky });
  assert.equal(await route.settled, 'error');
  assert.equal(message(section).textContent, table.voter_route_error);
  assert.equal(message(section).getAttribute('data-tone'), 'error');
  assert.equal(message(section).getAttribute('role'), 'alert');
  assert.equal(contactLine(section).textContent, table.voter_route_error_contact);
  assert.equal(logs.length, 1);
  const retry = section.querySelector('button.voter-route-retry');
  assert.ok(retry.classList.contains('btn-secondary'));
  assert.equal(retry.getAttribute('type'), 'button');

  retry.dispatchEvent({ type: 'click' });
  assert.equal(state(section), 'loading');
  await waitFor(() => state(section) === 'card');
  assert.equal(reads, 2);
  assert.deepEqual(fetches, []);
});

test('a lookup overtaken by a newer one resolves to the newer one\'s final state and does not render', async () => {
  const doc = createDocument();
  const container = doc.createElement('section');
  const first = deferred();
  const store = {
    lastWardKey: async () => WARD_3,
    loadStored: (k) => (k === WARD_3 ? first.promise : Promise.resolve(null)),
  };
  const screen = createVoterRouteScreen(container, table, { store, seat: SEAT, log() {} });
  const older = screen.open({ ward: '3', serial: 145 });
  const newer = screen.open({ ward: '4', serial: 1 });
  assert.equal(await newer, 'empty');
  first.resolve(ENTRIES);
  assert.equal(await older, 'empty');
  assert.equal(screen.state, 'empty');
  assert.equal(container.querySelector('section.voter-roll-card'), null);
});

test('back returns in browser history to the app screen the voter was opened from', async () => {
  const { store } = await storedRoll();
  const opened = mount('#roll', { store });
  opened.win.go('#/voter/3/145');
  await opened.route.settled;
  const back = opened.section.querySelector('button.voter-route-back');
  assert.ok(back.classList.contains('btn-secondary'), 'a shared 48 px control');
  assert.equal(back.getAttribute('type'), 'button');
  assert.equal(back.textContent, table.voter_route_back);
  back.dispatchEvent({ type: 'click' });
  assert.equal(opened.win.backs, 1);
  assert.deepEqual(opened.win.replaced, []);
});

test('opened straight at a voter address, back stays in the app: it drops the hash and closes the route', async () => {
  const { store } = await storedRoll();
  // Other sites before this one in the tab: history.length says nothing about the app.
  const direct = mount(null, { store, window: fakeWindow('#/voter/3/145', 5) });
  await direct.route.settled;
  direct.section.querySelector('button.voter-route-back').dispatchEvent({ type: 'click' });
  assert.equal(direct.win.backs, 0);
  assert.deepEqual(direct.win.replaced, ['/']);
  assert.equal(await direct.route.settled, null);
  assert.equal(direct.section.hidden, true);
  assert.equal(direct.main.getAttribute('data-route'), null);
});

test('a non-voter hash hides the route and removes data-route', async () => {
  const { store } = await storedRoll();
  const { section, main, route, win } = mount('#/voter/3/145', { store });
  await route.settled;
  win.go('#ward-picker');
  assert.equal(await route.settled, null);
  assert.equal(section.hidden, true);
  assert.equal(main.getAttribute('data-route'), null);
});

test('the fallback copies match the string table, which carries every key the route uses', () => {
  for (const [key, value] of Object.entries(FALLBACK_TEXT)) assert.equal(table[key], value, key);
});

// Every app module: src/ and js/, tests aside.
function appModules() {
  const out = [];
  const walk = (dir) => {
    for (const entry of readdirSync(new URL('../' + dir, import.meta.url), { withFileTypes: true })) {
      const rel = `${dir}/${entry.name}`;
      if (entry.isDirectory()) walk(rel);
      else if (entry.name.endsWith('.js') && !entry.name.endsWith('.test.js')) out.push(rel);
    }
  };
  walk('src');
  walk('js');
  return out;
}

test('the voter route is the only code path that shows a voter card', () => {
  const callers = appModules().filter((rel) => rel !== 'src/card/voterCard.js' && /renderVoterCard\(/.test(read(rel)));
  assert.deepEqual(callers, ['src/ui/voterRoute.js']);
  // The old consent "voter card" of the roll search (src/ui/voterCard.js) is gone.
  assert.equal(existsSync(new URL('../src/ui/voterCard.js', import.meta.url)), false);
  for (const rel of appModules()) {
    assert.doesNotMatch(read(rel), /ui\/voterCard\.js|from '\.\/voterCard\.js'|mountVoterCard/, rel);
  }
  assert.doesNotMatch(read('sw.js'), /"src\/ui\/voterCard\.js"/);
});

test('selecting a roll search result opens the contact panel, not a second voter card', async () => {
  const doc = createDocument();
  const contacts = createContactStore({ indexedDB: createFakeIndexedDB(), crypto: webcrypto, storage: null });
  const hosts = [];
  const view = mountRollWithSearch(doc.body, ENTRIES, table, {
    viewportHeight: 600, requestFrame: () => {}, contacts, wardKey: WARD_3, onHostChange: (v) => hosts.push(v),
  });
  assert.equal(view.openVoterCard, undefined);
  type(view.search.input, 'नन्दकिशोर');
  await waitFor(() => view.search.list.querySelectorAll('li').length === 1);
  view.search.list.querySelector('li').dispatchEvent({ type: 'click' });
  assert.ok(view.contactHost.querySelector('section.contact-panel'));
  assert.equal(view.contactHost.querySelector('section.voter-roll-card'), null);
  assert.deepEqual(hosts, ['contact']);
  view.destroy();
});

test('index.html has the route slot inside <main>, and sw.js precaches the route and its card', () => {
  const html = read('index.html');
  const slot = html.indexOf('id="voter-route"');
  assert.ok(slot > html.indexOf('<main') && slot < html.indexOf('</main>'));
  assert.ok(html.indexOf('id="sec-footer"') > html.indexOf('</main>'), 'the shared footer stays outside the route');
  const sw = read('sw.js');
  assert.match(sw, /"src\/ui\/voterRoute\.js"/);
  assert.match(sw, /"src\/card\/voterCard\.js"/);
  assert.match(read('styles.css'), /#app\[data-route="voter"\] > :not\(#voter-route\)/);
});

// vm.constants.USE_MAIN_CONTEXT_DEFAULT_LOADER arrived in Node 20.12 and 21.7.
const canImport = Boolean(vm.constants && vm.constants.USE_MAIN_CONTEXT_DEFAULT_LOADER);

test('opening the app directly at #/voter/3/145 shows the card from the default encrypted store, fetching only the string table', { skip: !canImport && 'no vm dynamic import' }, async (t) => {
  // The default store reads the browser globals: install fakes for them.
  const idb = createFakeIndexedDB();
  await createRollStore({ indexedDB: idb, crypto: globalThis.crypto }).encryptAndStore(WARD_3, ENTRIES);
  const storage = new Map();
  const localStorage = {
    getItem: (k) => (storage.has(k) ? storage.get(k) : null),
    setItem: (k, v) => { storage.set(k, String(v)); },
    removeItem: (k) => { storage.delete(k); },
  };
  saveSeat({ seatType: 'ward', panchayat: 'बडली', ward: '3' }, localStorage);
  assert.ok(storage.has(SEAT_STORAGE_KEY));
  const saved = {
    indexedDB: Object.getOwnPropertyDescriptor(globalThis, 'indexedDB'),
    localStorage: Object.getOwnPropertyDescriptor(globalThis, 'localStorage'),
  };
  Object.defineProperty(globalThis, 'indexedDB', { value: idb, configurable: true, writable: true });
  Object.defineProperty(globalThis, 'localStorage', { value: localStorage, configurable: true, writable: true });
  t.after(() => {
    for (const [name, desc] of Object.entries(saved)) {
      if (desc) Object.defineProperty(globalThis, name, desc);
      else delete globalThis[name];
    }
  });

  const doc = createDocument();
  const main = doc.createElement('main');
  const section = doc.createElement('section');
  section.hidden = true;
  main.appendChild(section);
  const fetched = [];
  const errors = [];
  const ctx = vm.createContext({
    document: {
      title: '',
      querySelectorAll: () => [],
      getElementById: (id) => ({ 'voter-route': section, app: main })[id] ?? null,
    },
    fetch: async (url) => { fetched.push(url); return { ok: true, status: 200, json: async () => table }; },
    navigator: {},
    window: fakeWindow('#/voter/3/145', 1),
    console: { error: (...a) => errors.push(a) },
  });
  const script = new vm.Script(read('js/app.js'), {
    filename: fileURLToPath(appUrl),
    importModuleDynamically: vm.constants.USE_MAIN_CONTEXT_DEFAULT_LOADER,
  });
  script.runInContext(ctx);
  await waitFor(() => section.querySelector('section.voter-roll-card') || errors.length > 0);
  assert.deepEqual(errors, []);
  assert.equal(section.hidden, false);
  assert.equal(main.getAttribute('data-route'), 'voter');
  assert.equal(section.querySelector('div.voter-route').getAttribute('data-state'), 'card');
  assert.equal(section.querySelector('h2.panel-title').textContent, 'नन्दकिशोर');
  assert.equal(seatLine(section), 'पंचायत: बडली · वार्ड: 3');
  // The shell's string table is the only request; opening the voter makes none.
  assert.deepEqual(fetched, ['src/strings.hi.json']);
});
