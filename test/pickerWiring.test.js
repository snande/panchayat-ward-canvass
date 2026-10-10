// js/picker.js wiring (issues #16, #122): choosing a ward panch's ward calls
// the roll flow's open(), a shown roll hides the "not loaded yet" card, and a
// stored roll is restored at startup. Runs the real module against the fake DOM, a stubbed
// fetch and the in-memory IndexedDB.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { createDocument } from './helpers/fakeDom.js';
import { createFakeIndexedDB } from './helpers/fakeIndexedDB.js';
import { createSyncD1 } from './helpers/memoryD1.js';
import { onRequest as syncOnRequest } from '../functions/sync.js';
import {
  choose, districtSelect, pickWard, pickerReady, seatButton, tap, wardSelect,
} from './helpers/pickWard.js';

const root = (rel) => new URL('../' + rel, import.meta.url);
const read = (rel) => readFileSync(root(rel));
const WARD1 = 'https://esuchiroll.rajasthan.gov.in/Publication_PDF_2026/PRI/Final/125/BADLI-Ward%20No-001.pdf';

async function waitFor(cond, ms = 8000) {
  const until = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > until) throw new Error('timed out');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function boot(idb, requests, { syncEnv, localStorage, rollFails = () => false, config } = {}) {
  const doc = createDocument();
  const picker = doc.createElement('section');
  const roll = doc.createElement('section');
  roll.setAttribute('hidden', '');
  const empty = doc.createElement('section');
  const team = doc.createElement('section');
  team.setAttribute('hidden', '');
  const seat = doc.createElement('div');
  seat.setAttribute('data-state', 'pending');
  const nav = doc.createElement('nav');
  const search = doc.createElement('section');
  search.setAttribute('hidden', '');
  const byId = { 'ward-picker': picker, roll, 'seat-header': seat, 'nav-bar': nav, 'voter-search': search };
  if (syncEnv) byId['team-join'] = team;
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
    if (url === 'config/constituency.json') return new Response(config ? JSON.stringify(config) : read('config/constituency.json'));
    if (url.startsWith('data/sec/catalogue/')) return new Response(read(url));
    if (url === '/sync/join' && syncEnv) {
      return syncOnRequest({ request: new Request(new URL(url, 'https://canvass.takshavid.com'), init), env: syncEnv });
    }
    if (url.startsWith('/roll?url=') && rollFails(url)) return new Response('', { status: 503 });
    if (url.startsWith('/roll?url=')) {
      return new Response(read('fixtures/badli-ward1.pdf'), { headers: { 'Content-Type': 'application/pdf' } });
    }
    return new Response('', { status: 404 });
  };
  const saved = {};
  const globals = { document: fakeDocument, window: {}, fetch, indexedDB: idb, localStorage };
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
  const navItem = (id) => nav.querySelectorAll('button.nav-item').find((b) => b.getAttribute('data-screen') === id);
  const currentNav = () => nav.querySelectorAll('button.nav-item')
    .filter((b) => b.getAttribute('aria-current') === 'page').map((b) => b.getAttribute('data-screen'));
  return { picker, roll, empty, team, seat, nav, search, navItem, currentNav, restore };
}

function memoryStorage() {
  const stored = new Map();
  return {
    stored,
    getItem: (k) => stored.get(k) ?? null,
    setItem: (k, v) => { stored.set(k, String(v)); },
    removeItem: (k) => { stored.delete(k); },
  };
}
const storedSeat = (storage) => JSON.parse(storage.stored.get('ward-canvass-seat'));

test('picking a ward opens its roll and hides the empty state; a reload restores it offline', async () => {
  const idb = createFakeIndexedDB();
  const requests = [];
  const storage = memoryStorage();
  // Ward 2's download fails: the header must keep naming ward 1, whose roll stays.
  const first = boot(idb, requests, { localStorage: storage, rollFails: (url) => url.includes('No-002') });
  try {
    await import('../js/picker.js?wiring=1');
    await pickWard(first.picker, { ward: null });
    const ward = wardSelect(first.picker);
    assert.equal(first.roll.querySelectorAll('div.roll-row').length, 0);
    // The empty ward-roll screen says to pick a ward; the call list entry in
    // the nav bar leads there too, as it needs a loaded ward.
    assert.equal(first.empty.hidden, false);
    assert.ok(first.roll.querySelector('p.roll-empty'));
    first.navItem('calls').dispatchEvent({ type: 'click' });
    assert.deepEqual(first.currentNav(), ['roll']);
    assert.equal(first.roll.querySelector('section.call-list-screen'), null);
    choose(ward, '1');

    await waitFor(() => first.roll.querySelectorAll('div.roll-row').length > 0);
    // With a roll on screen the nav bar opens its call list; closing the call
    // list makes the roll the current entry again.
    first.navItem('calls').dispatchEvent({ type: 'click' });
    assert.ok(first.roll.querySelector('section.call-list-screen'), 'the call list opens from the nav bar');
    assert.deepEqual(first.currentNav(), ['calls']);
    first.roll.querySelector('button.call-list-close').dispatchEvent({ type: 'click' });
    assert.equal(first.roll.querySelector('section.call-list-screen'), null);
    assert.deepEqual(first.currentNav(), ['roll']);
    assert.ok(requests.includes(`/roll?url=${encodeURIComponent(WARD1)}`), requests.join('\n'));
    assert.equal(first.empty.hidden, true);
    assert.equal(first.roll.hidden, false);
    // The seat header names the ward whose roll is on screen and keeps only the seat.
    assert.equal(first.seat.textContent, 'पंचायत: बडली · वार्ड: 1');
    assert.deepEqual(storedSeat(storage), { schemaVersion: 1, seatType: 'ward', panchayat: 'बडली', ward: '1' });

    choose(ward, '2');
    await waitFor(() => first.roll.querySelector('.roll-error') !== null);
    assert.equal(first.seat.textContent, 'पंचायत: बडली · वार्ड: 1', 'a failed pick leaves the shown seat');
    assert.equal(storedSeat(storage).ward, '1', 'a failed pick is not stored');
  } finally {
    first.restore();
  }

  // "Reopen the app": a fresh page over the same IndexedDB makes no roll request.
  const reopenRequests = [];
  const second = boot(idb, reopenRequests, { localStorage: memoryStorage() });
  try {
    await import('../js/picker.js?wiring=2');
    await waitFor(() => second.roll.querySelectorAll('div.roll-row').length > 0);
    assert.equal(second.empty.hidden, true);
    // The restored roll names its seat once the ward catalogue is there.
    await waitFor(() => second.seat.getAttribute('data-state') === 'loaded');
    assert.equal(second.seat.textContent, 'पंचायत: बडली · वार्ड: 1');
    assert.ok(!reopenRequests.some((u) => u.startsWith('/roll')), reopenRequests.join('\n'));
  } finally {
    second.restore();
  }
});

test('with no team credentials the join screen shows; after joining a reload skips it', async () => {
  const idb = createFakeIndexedDB();
  const syncEnv = { SYNC_SECRET: 'test-sync-secret', SYNC_DB: await createSyncD1() };
  const first = boot(idb, [], { syncEnv });
  try {
    await import('../js/picker.js?wiring=3');
    await waitFor(() => first.team.querySelector('form') !== null);
    assert.equal(first.team.hidden, false);
    const [code, pass] = first.team.querySelectorAll('input');
    code.value = 'candA';
    pass.value = 'हमारी टीम';
    first.team.querySelector('form').dispatchEvent({ type: 'submit', preventDefault() {} });
    await waitFor(() => first.team.hidden === true);
    assert.equal(first.team.querySelector('form'), null);
    assert.equal(syncEnv.SYNC_DB.sqlite.query('SELECT 1 FROM verifiers WHERE candidate_id = ?', ['candA']).length, 1);
  } finally {
    first.restore();
  }

  const second = boot(idb, [], { syncEnv });
  try {
    await import('../js/picker.js?wiring=4');
    await pickerReady(second.picker);
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(second.team.hidden, true);
    assert.equal(second.team.querySelector('form'), null);
  } finally {
    second.restore();
  }
});

test('the nav bar opens the polling-day count and the SMS tally over a loaded roll, and only then', async () => {
  const page = boot(createFakeIndexedDB(), [], { localStorage: memoryStorage() });
  try {
    await import('../js/picker.js?wiring=5');
    await pickerReady(page.picker);
    assert.equal(page.nav.querySelectorAll('button.nav-item').length, 5);
    // No roll yet: each entry leads to the ward picker and the roll stays current.
    for (const id of ['turnout', 'sms', 'calls']) {
      page.navItem(id).dispatchEvent({ type: 'click' });
      assert.deepEqual(page.currentNav(), ['roll'], id);
    }
    assert.equal(page.roll.querySelector('form.turnout-screen'), null);

    await pickWard(page.picker);
    await waitFor(() => page.roll.querySelectorAll('div.roll-row').length > 0);
    assert.deepEqual(page.currentNav(), ['roll']);

    page.navItem('turnout').dispatchEvent({ type: 'click' });
    assert.ok(page.roll.querySelector('form.turnout-screen'), 'the polling-day count opens from the nav bar');
    assert.deepEqual(page.currentNav(), ['turnout']);

    page.navItem('sms').dispatchEvent({ type: 'click' });
    await waitFor(() => page.roll.querySelector('div.sms-tally') !== null);
    assert.equal(page.roll.querySelector('form.turnout-screen'), null, 'one view at a time');
    assert.deepEqual(page.currentNav(), ['sms']);

    // Tapping a voter opens the contact panel there instead: the roll is current.
    page.roll.querySelector('div.roll-row').dispatchEvent({ type: 'click' });
    assert.equal(page.roll.querySelector('div.sms-tally'), null);
    assert.deepEqual(page.currentNav(), ['roll']);
  } finally {
    page.restore();
  }
});

test("a failed download names the catalogue's support contact as whom to call", async () => {
  const config = JSON.parse(read('config/constituency.json').toString('utf8'));
  config.supportContact = 'ब्लॉक समन्वयक से संपर्क करें।';
  const page = boot(createFakeIndexedDB(), [], { localStorage: memoryStorage(), rollFails: () => true, config });
  try {
    await import('../js/picker.js?wiring=6');
    await pickWard(page.picker);
    await waitFor(() => page.roll.querySelector('.roll-error') !== null);
    assert.equal(page.roll.querySelector('p.roll-contact').textContent, config.supportContact);
    assert.ok(page.roll.querySelector('button.roll-retry'));
    assert.equal(page.empty.hidden, true, 'one state at a time');
  } finally {
    page.restore();
  }
});

test('the nav bar opens the search screen; a roll loading behind it leaves it open, and the jump finds the loaded voter', async () => {
  const page = boot(createFakeIndexedDB(), [], { localStorage: memoryStorage() });
  try {
    await import('../js/picker.js?wiring=7');
    await pickerReady(page.picker);
    page.navItem('search').dispatchEvent({ type: 'click' });
    assert.deepEqual(page.currentNav(), ['search']);
    assert.equal(page.search.hidden, false);
    const screen = page.search.querySelector('section.search-screen');
    assert.equal(screen.getAttribute('data-state'), 'empty');
    const input = screen.querySelector('input.search-input');
    assert.equal(input.disabled, true, 'the query box shows, disabled, until a roll is loaded');

    await pickWard(page.picker);
    await waitFor(() => page.roll.querySelectorAll('div.roll-row').length > 0);
    assert.equal(page.search.hidden, false, 'a roll loading in the background does not close the search');
    assert.deepEqual(page.currentNav(), ['search']);
    await waitFor(() => screen.getAttribute('data-state') === 'filled');
    assert.equal(input.disabled, false);

    input.value = '1/1';
    input.dispatchEvent({ type: 'input' });
    await waitFor(() => screen.querySelector('li.search-row')?.getAttribute('aria-selected') === 'true');
    assert.equal(screen.querySelector('li.search-row').getAttribute('data-key'), '1:1');

    page.navItem('roll').dispatchEvent({ type: 'click' });
    assert.equal(page.search.hidden, true);
    assert.deepEqual(page.currentNav(), ['roll']);
  } finally {
    page.restore();
  }
});

const catalogueRequests = (requests) => requests.filter((u) => u.startsWith('data/sec/'));

test('first open fetches only the catalogue index; the district shard comes once the district is chosen', async () => {
  const requests = [];
  const page = boot(createFakeIndexedDB(), requests, { localStorage: memoryStorage() });
  try {
    await import('../js/picker.js?wiring=8');
    await pickerReady(page.picker);
    const select = districtSelect(page.picker);
    await waitFor(() => select.children.length > 1);
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.deepEqual(catalogueRequests(requests), ['data/sec/catalogue/index.json']);
    await pickWard(page.picker);
    assert.deepEqual(catalogueRequests(requests), ['data/sec/catalogue/index.json', 'data/sec/catalogue/jaipur.json']);
    assert.ok(!requests.includes('data/sec/catalogue.json'));
  } finally {
    page.restore();
  }
});

test('a sarpanch pick hands on every ward and stores it with schemaVersion; no roll is opened here', async () => {
  const requests = [];
  const storage = memoryStorage();
  const page = boot(createFakeIndexedDB(), requests, { localStorage: storage });
  try {
    await import('../js/picker.js?wiring=9');
    await pickWard(page.picker, { seat: 'sarpanch' });
    const selection = globalThis.window.wardSelection();
    assert.equal(selection.seatType, 'sarpanch');
    assert.deepEqual(selection.wards.map((w) => w.ward), [1, 2, 3, 4, 5, 6, 7]);
    assert.equal(selection.wards[0].pdfUrl, WARD1);
    const stored = JSON.parse(storage.stored.get('ward-canvass-last-selection'));
    assert.equal(stored.schemaVersion, 1);
    assert.deepEqual(stored, selection);
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.ok(!requests.some((u) => u.startsWith('/roll')), 'loading several wards is the roll decoder\'s work');
  } finally {
    page.restore();
  }

  // Reopened, the picker shows the stored pick again.
  const again = boot(createFakeIndexedDB(), [], { localStorage: storage });
  try {
    await import('../js/picker.js?wiring=10');
    await pickerReady(again.picker);
    await waitFor(() => globalThis.window.wardSelection && globalThis.window.wardSelection() !== null);
    assert.equal(globalThis.window.wardSelection().seatType, 'sarpanch');
    assert.equal(seatButton(again.picker, 'sarpanch').getAttribute('aria-pressed'), 'true');
  } finally {
    again.restore();
  }
});

test('a stored selection of an unknown version is discarded and the picker opens at its first step', async () => {
  const storage = memoryStorage();
  storage.setItem('ward-canvass-last-selection', JSON.stringify({ schemaVersion: 99, seatType: 'sarpanch' }));
  const requests = [];
  const page = boot(createFakeIndexedDB(), requests, { localStorage: storage });
  const errors = [];
  const realError = console.error;
  console.error = (...args) => errors.push(args);
  try {
    await import('../js/picker.js?wiring=11');
    await pickerReady(page.picker);
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(storage.stored.has('ward-canvass-last-selection'), false);
    assert.ok(errors.some((args) => args.includes('unknown-version')), 'the discard is reported');
    assert.equal(globalThis.window.wardSelection(), null);
    assert.equal(seatButton(page.picker, 'ward-panch').getAttribute('aria-pressed'), 'false');
    assert.equal(districtSelect(page.picker).parentNode.hidden, true);
    assert.deepEqual(catalogueRequests(requests), ['data/sec/catalogue/index.json']);
  } finally {
    console.error = realError;
    page.restore();
  }
});

test('with a roll on screen, changing the seat type asks before the loaded seat is replaced', async () => {
  const requests = [];
  const page = boot(createFakeIndexedDB(), requests, { localStorage: memoryStorage() });
  try {
    await import('../js/picker.js?wiring=12');
    await pickWard(page.picker);
    await waitFor(() => page.roll.querySelectorAll('div.roll-row').length > 0);
    const alert = page.picker.querySelector('div.picker-confirm');
    assert.equal(alert.hidden, true);
    tap(seatButton(page.picker, 'sarpanch'));
    assert.equal(alert.hidden, false, 'asks first');
    assert.equal(globalThis.window.wardSelection().seatType, 'ward-panch');
    tap(page.picker.querySelector('button.picker-confirm-no'));
    assert.equal(alert.hidden, true);
    assert.equal(globalThis.window.wardSelection().seatType, 'ward-panch');
    assert.equal(page.seat.textContent, 'पंचायत: बडली · वार्ड: 1');
    tap(seatButton(page.picker, 'sarpanch'));
    tap(page.picker.querySelector('button.picker-confirm-yes'));
    assert.equal(globalThis.window.wardSelection().seatType, 'sarpanch');
  } finally {
    page.restore();
  }
});
