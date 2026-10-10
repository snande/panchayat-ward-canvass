// js/picker.js wiring (issue #16): choosing a ward calls the roll flow's
// open(), a shown roll hides the "not loaded yet" card, and a stored roll is
// restored at startup. The picker reads the sharded SEC catalogue (#122):
// seat type, district, panchayat, ward. Runs the real module against the fake
// DOM, a stubbed fetch and the in-memory IndexedDB.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { createDocument } from './helpers/fakeDom.js';
import { createFakeIndexedDB } from './helpers/fakeIndexedDB.js';
import { createSyncD1 } from './helpers/memoryD1.js';
import { onRequest as syncOnRequest } from '../functions/sync.js';
import {
  catalogueResponse, choose, pickPanchayat, pickWard, pickerSelects, waitFor, optionValues,
} from './helpers/picker.js';
import { LAST_SELECTION_KEY } from '../src/picker/catalogue.js';
import { SEC_FOOTER_LINES } from '../src/ui/secFooter.js';

const root = (rel) => new URL('../' + rel, import.meta.url);
const read = (rel) => readFileSync(root(rel));
const WARD1 = 'https://esuchiroll.rajasthan.gov.in/Publication_PDF_2026/PRI/Final/125/BADLI-Ward%20No-001.pdf';

function boot(idb, requests, { syncEnv, localStorage, rollFails = () => false, config, catalogue } = {}) {
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
  const footer = doc.createElement('footer');
  const byId = {
    'ward-picker': picker, roll, 'seat-header': seat, 'nav-bar': nav, 'voter-search': search, 'sec-footer': footer,
  };
  if (syncEnv) byId['team-join'] = team;
  const fakeDocument = {
    getElementById: (id) => byId[id] || null,
    querySelector: (sel) => (sel === '.empty-state' ? empty : null),
    // js/app.js re-applies the string table to [data-i18n] nodes; there are none here.
    querySelectorAll: () => [],
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
    if (catalogue && url.startsWith('data/')) return catalogue(url);
    if (catalogueResponse(url)) return catalogueResponse(url);
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
  return { picker, roll, empty, team, seat, nav, search, footer, navItem, currentNav, restore };
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
    const { ward } = await pickPanchayat(first.picker);
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
    await waitFor(() => second.picker.querySelector('select') !== null);
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
    await waitFor(() => page.picker.querySelector('select') !== null);
    assert.equal(page.nav.querySelectorAll('button.nav-item').length, 5);
    // No roll yet: each entry leads to the ward picker and the roll stays current.
    for (const id of ['turnout', 'sms', 'calls']) {
      page.navItem(id).dispatchEvent({ type: 'click' });
      assert.deepEqual(page.currentNav(), ['roll'], id);
    }
    assert.equal(page.roll.querySelector('form.turnout-screen'), null);

    await pickWard(page.picker, '1');
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
    await waitFor(() => page.picker.querySelector('select') !== null);
    await pickWard(page.picker, '1');
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
    await waitFor(() => page.picker.querySelector('select') !== null);
    page.navItem('search').dispatchEvent({ type: 'click' });
    assert.deepEqual(page.currentNav(), ['search']);
    assert.equal(page.search.hidden, false);
    const screen = page.search.querySelector('section.search-screen');
    assert.equal(screen.getAttribute('data-state'), 'empty');
    const input = screen.querySelector('input.search-input');
    assert.equal(input.disabled, true, 'the query box shows, disabled, until a roll is loaded');

    await pickWard(page.picker, '1');
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

// The catalogue files a page fetched, in order.
const catalogueRequests = (requests) => requests.filter((u) => u.startsWith('data/sec/catalogue'));

test('the picker asks seat type, district, panchayat, ward, and fetches a district shard only once it is chosen', async () => {
  const requests = [];
  const page = boot(createFakeIndexedDB(), requests, { localStorage: memoryStorage() });
  try {
    await import('../js/picker.js?wiring=8');
    await waitFor(() => optionValues(pickerSelects(page.picker).district).includes('17'));
    const labels = page.picker.querySelectorAll('label').map((l) => l.textContent);
    assert.deepEqual(labels, ['सीट', 'ज़िला', 'ग्राम पंचायत खोजें', 'ग्राम पंचायत', 'वार्ड']);
    const { seatType, district } = pickerSelects(page.picker);
    assert.deepEqual(seatType.children.map((o) => o.textContent), ['सीट चुनें', 'वार्ड पंच', 'सरपंच']);
    assert.ok(district.hasAttribute('disabled'), 'the district waits for the seat type');
    assert.deepEqual(catalogueRequests(requests), ['data/sec/catalogue/index.json'], 'first open: only the index');
    assert.equal(optionValues(district).length, 42, 'every district of the index');

    choose(seatType, 'ward-panch');
    assert.deepEqual(catalogueRequests(requests), ['data/sec/catalogue/index.json']);
    choose(district, '17');
    await waitFor(() => optionValues(pickerSelects(page.picker).panchayat).includes('6313'));
    assert.deepEqual(catalogueRequests(requests), ['data/sec/catalogue/index.json', 'data/sec/catalogue/jaipur.json']);
    assert.ok(!requests.includes('data/sec/catalogue.json'), 'the old single-file catalogue is never read');
  } finally {
    page.restore();
  }
});

test('a ward panch pick emits exactly one ward, kept with its schemaVersion', async () => {
  const requests = [];
  const storage = memoryStorage();
  const page = boot(createFakeIndexedDB(), requests, { localStorage: storage });
  try {
    await import('../js/picker.js?wiring=9');
    await pickWard(page.picker, '3');
    const selection = globalThis.window.wardSelection();
    assert.equal(selection.seatType, 'ward-panch');
    assert.equal(selection.schemaVersion, 1);
    assert.equal(selection.district.id, '17');
    assert.equal(selection.panchayat.id, '6313');
    assert.equal(selection.panchayat.name, 'बडली');
    assert.deepEqual(selection.wards, [
      { ward: 3, pdfUrl: 'https://esuchiroll.rajasthan.gov.in/Publication_PDF_2026/PRI/Final/125/BADLI-Ward%20No-003.pdf' },
    ]);
    assert.deepEqual(JSON.parse(storage.stored.get(LAST_SELECTION_KEY)), selection);
    await waitFor(() => requests.some((u) => u.startsWith('/roll?url=')));
    assert.ok(requests.includes(`/roll?url=${encodeURIComponent(selection.wards[0].pdfUrl)}`));
  } finally {
    page.restore();
  }
});

test('a sarpanch pick skips the ward step and emits every ward in ward-number order', async () => {
  const requests = [];
  const page = boot(createFakeIndexedDB(), requests, { localStorage: memoryStorage() });
  try {
    await import('../js/picker.js?wiring=10');
    const { ward } = await pickPanchayat(page.picker, { seatType: 'sarpanch' });
    assert.ok(ward.parentNode.hidden, 'no ward step for a sarpanch');
    const selection = globalThis.window.wardSelection();
    assert.equal(selection.seatType, 'sarpanch');
    assert.deepEqual(selection.wards.map((w) => w.ward), [1, 2, 3, 4, 5, 6, 7]);
    for (const w of selection.wards) {
      assert.equal(w.pdfUrl, `https://esuchiroll.rajasthan.gov.in/Publication_PDF_2026/PRI/Final/125/BADLI-Ward%20No-00${w.ward}.pdf`);
    }
    assert.equal(page.picker.querySelector('div.ward-picker').getAttribute('data-state'), 'success');
    // Loading several wards is the roll decoder's work: nothing is downloaded yet.
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.ok(!requests.some((u) => u.startsWith('/roll')), requests.join('\n'));
  } finally {
    page.restore();
  }
});

// Five gram panchayats in five districts of the statewide catalogue, each the
// first of its district shard (data/sec/catalogue/<district>.json).
const FIVE = [
  { district: '1', panchayat: '54', name: 'अजगरा' },
  { district: '2', panchayat: '465', name: 'अंगारी' },
  { district: '33', panchayat: '12395', name: 'अटाटिया' },
  { district: '23', panchayat: '9109', name: 'अकबरपुर' },
  { district: '24', panchayat: '9249', name: 'अभयपुरा', ward: '2' },
];
const footerLines = (page) => page.footer.children.map((p) => p.textContent);

test('five panchayats in five districts: the seat header names each pick, the SEC footer stays below every screen', async () => {
  const strings = JSON.parse(read('src/strings.hi.json').toString('utf8'));
  const requests = [];
  const storage = memoryStorage();
  const page = boot(createFakeIndexedDB(), requests, { localStorage: storage });
  try {
    // The whole page: the shell (js/app.js: stored seat, SEC footer) and the screens (js/picker.js).
    await import('../js/app.js?wiring=17');
    await import('../js/picker.js?wiring=17');
    await waitFor(() => page.seat.getAttribute('data-state') === 'empty' && page.footer.children.length === 3);
    assert.deepEqual(footerLines(page), [...SEC_FOOTER_LINES]);

    for (const pick of FIVE.slice(0, 4)) {
      // A sarpanch seat: the header names the panchayat and every ward at once.
      await pickPanchayat(page.picker, { seatType: 'sarpanch', district: pick.district, panchayat: pick.panchayat });
      const selection = globalThis.window.wardSelection();
      assert.equal(selection.district.id, pick.district);
      assert.equal(selection.panchayat.name, pick.name);
      assert.equal(page.seat.getAttribute('data-state'), 'loaded');
      assert.equal(page.seat.textContent, `पंचायत: ${pick.name} · सभी वार्ड`);
      assert.deepEqual(storedSeat(storage), { schemaVersion: 1, seatType: 'sarpanch', panchayat: pick.name, ward: null });
      assert.equal(page.roll.querySelector('p.roll-empty').textContent, strings.roll_sarpanch_all_wards);
      assert.deepEqual(footerLines(page), [...SEC_FOOTER_LINES]);
    }
    assert.ok(!requests.some((u) => u.startsWith('/roll')), 'a sarpanch seat downloads no roll');

    // A ward panch seat in the fifth district: the header follows the roll once it shows.
    const last = FIVE[4];
    await pickWard(page.picker, last.ward, { seatType: 'ward-panch', district: last.district, panchayat: last.panchayat });
    await waitFor(() => page.roll.querySelectorAll('div.roll-row').length > 0);
    const selection = globalThis.window.wardSelection();
    assert.ok(requests.includes(`/roll?url=${encodeURIComponent(selection.wards[0].pdfUrl)}`), requests.join('\n'));
    assert.equal(page.seat.textContent, `पंचायत: ${last.name} · वार्ड: ${last.ward}`);
    assert.deepEqual(storedSeat(storage), { schemaVersion: 1, seatType: 'ward', panchayat: last.name, ward: last.ward });
    assert.deepEqual(footerLines(page), [...SEC_FOOTER_LINES]);
    assert.deepEqual(new Set(catalogueRequests(requests)), new Set([
      'data/sec/catalogue/index.json', 'data/sec/catalogue/ajmer.json', 'data/sec/catalogue/alwar.json',
      'data/sec/catalogue/udaipur.json', 'data/sec/catalogue/karauli.json', 'data/sec/catalogue/kota.json',
    ]), 'one shard per district picked');
  } finally {
    page.restore();
  }
});

test('a sarpanch seat picked last time opens again: the header names it, and no single roll is restored', async () => {
  const strings = JSON.parse(read('src/strings.hi.json').toString('utf8'));
  const idb = createFakeIndexedDB();
  const storage = memoryStorage();
  const first = boot(idb, [], { localStorage: storage });
  try {
    await import('../js/picker.js?wiring=18');
    const selects = await pickWard(first.picker, '1');
    await waitFor(() => first.roll.querySelectorAll('div.roll-row').length > 0);
    // A roll is loaded, so the seat change waits for "yes".
    choose(selects.seatType, 'sarpanch');
    assert.equal(first.seat.textContent, 'पंचायत: बडली · वार्ड: 1', 'nothing changes before "yes"');
    first.picker.querySelector('button.picker-confirm-yes').dispatchEvent({ type: 'click' });
    assert.equal(first.seat.textContent, 'पंचायत: बडली · सभी वार्ड', 'the loaded panchayat, every ward');
    // No roll is on screen now, so a new district needs no alert.
    await pickPanchayat(first.picker, { seatType: 'sarpanch', district: '1', panchayat: '54' });
    assert.equal(first.picker.querySelector('div.picker-confirm').hidden, true);
    assert.equal(first.seat.textContent, 'पंचायत: अजगरा · सभी वार्ड');
  } finally {
    first.restore();
  }

  const requests = [];
  const second = boot(idb, requests, { localStorage: storage });
  try {
    await import('../js/app.js?wiring=19');
    await import('../js/picker.js?wiring=19');
    await waitFor(() => globalThis.window.wardSelection && globalThis.window.wardSelection() !== null);
    assert.equal(globalThis.window.wardSelection().seatType, 'sarpanch');
    assert.equal(second.seat.textContent, 'पंचायत: अजगरा · सभी वार्ड');
    assert.equal(second.roll.querySelector('p.roll-empty').textContent, strings.roll_sarpanch_all_wards);
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(second.roll.querySelectorAll('div.roll-row').length, 0, 'ward 1 stays stored, not shown');
    assert.equal(second.seat.textContent, 'पंचायत: अजगरा · सभी वार्ड');
    assert.deepEqual(footerLines(second), [...SEC_FOOTER_LINES]);
    assert.ok(!requests.some((u) => u.startsWith('/roll')), requests.join('\n'));
  } finally {
    second.restore();
  }
});

test('the panchayat list filters as the user types, in Hindi or in Latin letters', async () => {
  const page = boot(createFakeIndexedDB(), [], { localStorage: memoryStorage() });
  try {
    await import('../js/picker.js?wiring=11');
    await waitFor(() => page.picker.querySelector('select') !== null);
    const { seatType, district, panchayat } = pickerSelects(page.picker);
    choose(seatType, 'ward-panch');
    await waitFor(() => optionValues(district).includes('17'));
    choose(district, '17');
    await waitFor(() => optionValues(panchayat).includes('6313'));
    const all = optionValues(panchayat).length;
    const search = page.picker.querySelector('input.picker-search');
    assert.equal(search.getAttribute('type'), 'search');
    search.value = 'बडली';
    search.dispatchEvent({ type: 'input' });
    assert.ok(optionValues(panchayat).length < all);
    assert.ok(optionValues(panchayat).includes('6313'));
    assert.ok(panchayat.children.slice(1).every((o) => o.textContent.includes('बडली')));
    search.value = 'badl';
    search.dispatchEvent({ type: 'input' });
    assert.ok(optionValues(panchayat).includes('6313'), 'Latin letters match nameLatin');
    search.value = 'ज़ज़ज़ज़';
    search.dispatchEvent({ type: 'input' });
    assert.deepEqual(optionValues(panchayat), ['']);
    const root = page.picker.querySelector('div.ward-picker');
    assert.equal(root.getAttribute('data-state'), 'empty');
    assert.match(page.picker.querySelector('p.picker-notice').textContent, /नहीं मिली/);
  } finally {
    page.restore();
  }
});

test('a catalogue of an unknown schemaVersion shows "update the app", never a list', async () => {
  const strings = JSON.parse(read('src/strings.hi.json').toString('utf8'));
  const index = JSON.parse(read('data/sec/catalogue/index.json').toString('utf8'));
  const page = boot(createFakeIndexedDB(), [], {
    localStorage: memoryStorage(),
    catalogue: () => new Response(JSON.stringify({ ...index, schemaVersion: 99 })),
  });
  try {
    await import('../js/picker.js?wiring=12');
    const root = () => page.picker.querySelector('div.ward-picker');
    await waitFor(() => root() && root().getAttribute('data-state') === 'error');
    assert.equal(root().getAttribute('data-error'), 'version');
    assert.equal(page.picker.querySelector('p.picker-notice').textContent, strings.catalogue_version_unsupported);
    assert.deepEqual(optionValues(pickerSelects(page.picker).district), ['']);
    assert.ok(page.picker.querySelector('button.picker-retry').hidden, 'retrying cannot help');
  } finally {
    page.restore();
  }
});

test('a catalogue that will not load says, in Hindi, to retry when online or call the support number', async () => {
  const strings = JSON.parse(read('src/strings.hi.json').toString('utf8'));
  let online = false;
  const page = boot(createFakeIndexedDB(), [], {
    localStorage: memoryStorage(),
    catalogue: (url) => (online ? catalogueResponse(url) : new Response('', { status: 503 })),
  });
  try {
    await import('../js/picker.js?wiring=13');
    const root = () => page.picker.querySelector('div.ward-picker');
    await waitFor(() => root() && root().getAttribute('data-state') === 'error');
    assert.equal(page.picker.querySelector('p.picker-notice').textContent, strings.picker_error_retry);
    assert.equal(page.picker.querySelector('p.picker-notice').getAttribute('role'), 'alert');
    assert.equal(page.picker.querySelector('p.picker-contact').textContent, strings.picker_error_contact);
    const retry = page.picker.querySelector('button.picker-retry');
    assert.equal(retry.hidden, false);
    online = true;
    retry.dispatchEvent({ type: 'click' });
    await waitFor(() => optionValues(pickerSelects(page.picker).district).includes('17'));
    assert.equal(root().getAttribute('data-state'), 'ready');
    assert.ok(page.picker.querySelector('p.picker-contact').hidden);
  } finally {
    page.restore();
  }
});

test('a stored last selection of an unknown version is discarded and the picker opens empty; a known one is put back', async () => {
  const storage = memoryStorage();
  storage.setItem(LAST_SELECTION_KEY, JSON.stringify({ schemaVersion: 99, seatType: 'sarpanch', wards: [] }));
  const requests = [];
  const page = boot(createFakeIndexedDB(), requests, { localStorage: storage });
  try {
    await import('../js/picker.js?wiring=14');
    await waitFor(() => optionValues(pickerSelects(page.picker).district).includes('17'));
    assert.equal(storage.stored.has(LAST_SELECTION_KEY), false, 'the unknown record is dropped');
    assert.equal(pickerSelects(page.picker).seatType.value, '');
    assert.equal(globalThis.window.wardSelection(), null);
    await pickPanchayat(page.picker, { seatType: 'sarpanch' });
    assert.equal(JSON.parse(storage.stored.get(LAST_SELECTION_KEY)).schemaVersion, 1);
  } finally {
    page.restore();
  }

  const again = boot(createFakeIndexedDB(), [], { localStorage: storage });
  try {
    await import('../js/picker.js?wiring=15');
    await waitFor(() => globalThis.window.wardSelection && globalThis.window.wardSelection() !== null);
    const selects = pickerSelects(again.picker);
    assert.equal(selects.seatType.value, 'sarpanch');
    assert.equal(selects.district.value, '17');
    assert.equal(selects.panchayat.value, '6313');
    assert.equal(globalThis.window.wardSelection().wards.length, 7);
  } finally {
    again.restore();
  }
});

test('with a roll loaded, changing the seat type or panchayat asks before the selection is replaced', async () => {
  const requests = [];
  const page = boot(createFakeIndexedDB(), requests, { localStorage: memoryStorage() });
  try {
    await import('../js/picker.js?wiring=16');
    const selects = await pickWard(page.picker, '1');
    await waitFor(() => page.roll.querySelectorAll('div.roll-row').length > 0);
    const confirm = page.picker.querySelector('div.picker-confirm');
    assert.equal(confirm.hidden, true);
    const before = globalThis.window.wardSelection();

    choose(selects.seatType, 'sarpanch');
    assert.equal(confirm.hidden, false, 'the alert asks first');
    assert.equal(selects.seatType.value, 'ward-panch', 'nothing changes until "yes"');
    assert.equal(globalThis.window.wardSelection(), before);
    page.picker.querySelector('button.picker-confirm-no').dispatchEvent({ type: 'click' });
    assert.equal(confirm.hidden, true);
    assert.equal(globalThis.window.wardSelection(), before, '"no" keeps the loaded selection');

    choose(selects.panchayat, '6250');
    assert.equal(confirm.hidden, false);
    assert.equal(selects.panchayat.value, '6313');
    page.picker.querySelector('button.picker-confirm-no').dispatchEvent({ type: 'click' });

    choose(selects.seatType, 'sarpanch');
    page.picker.querySelector('button.picker-confirm-yes').dispatchEvent({ type: 'click' });
    assert.equal(confirm.hidden, true);
    assert.equal(selects.seatType.value, 'sarpanch');
    assert.equal(globalThis.window.wardSelection().seatType, 'sarpanch');
    assert.equal(globalThis.window.wardSelection().wards.length, 7);
    // "Yes" replaces the loaded ward: the header names the sarpanch seat and
    // the roll screen says how to open one ward.
    assert.equal(page.seat.textContent, 'पंचायत: बडली · सभी वार्ड');
    assert.equal(page.roll.querySelectorAll('div.roll-row').length, 0);
    assert.ok(page.roll.querySelector('p.roll-empty'));
  } finally {
    page.restore();
  }
});
