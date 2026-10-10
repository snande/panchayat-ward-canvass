// Ward pick -> download -> decode -> encrypted store -> list (issue #16),
// run by `npm test` on the fake DOM and the in-memory IndexedDB.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { webcrypto } from 'node:crypto';
import { relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createRollFlow, decodeWithTable } from '../src/roll/rollFlow.js';
import {
  fetchRoll as realFetchRoll, fetchSupplements as realFetchSupplements, RELAY_PATH, RollFetchError,
} from '../src/roll/fetchRoll.js';
import { createRollStore, minimiseEntries, RECORD_VERSION, RollRecordVersionError } from '../src/roll/rollStore.js';
import { createDocument } from './helpers/fakeDom.js';
import { createFakeIndexedDB } from './helpers/fakeIndexedDB.js';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const read = (rel) => readFileSync(new URL('../' + rel, import.meta.url));
const strings = JSON.parse(read('src/strings.hi.json').toString('utf8'));
const PDF = read('fixtures/badli-ward1.pdf');
const expected = JSON.parse(read('fixtures/badli-ward1-expected.json').toString('utf8'));
const WARD1 = 'https://esuchiroll.rajasthan.gov.in/Publication_PDF_2026/PRI/Final/125/BADLI-Ward%20No-001.pdf';
const SELECTION = { district: '17', samiti: '125', panchayat: '6313', ward: '1', pdfUrl: WARD1 };

const pdfBuffer = () => PDF.buffer.slice(PDF.byteOffset, PDF.byteOffset + PDF.byteLength);

function setup({ fetchRoll, idb = createFakeIndexedDB(), decode = decodeWithTable } = {}) {
  const doc = createDocument();
  const container = doc.createElement('section');
  container.setAttribute('hidden', '');
  doc.body.appendChild(container);
  const calls = [];
  const shown = [];
  const errors = [];
  const store = createRollStore({ indexedDB: idb, crypto: webcrypto });
  const flow = createRollFlow(container, strings, {
    fetchRoll: async (sel) => {
      calls.push(sel);
      return fetchRoll(sel);
    },
    decode,
    store,
    onShow: (entries) => shown.push(entries),
    listOptions: { viewportHeight: 600, requestFrame: () => {} },
    log: (...args) => errors.push(args),
  });
  return { doc, container, flow, calls, shown, errors, idb, store };
}

async function waitFor(cond, ms = 5000) {
  const until = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > until) throw new Error('timed out');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

const rowCount = (container) => container.querySelectorAll('div.roll-row').length;
const countLine = (container) => container.querySelector('p.roll-count').textContent;

test('picking Badli ward 1 downloads, decodes, stores and lists the roll', async () => {
  const s = setup({ fetchRoll: async () => pdfBuffer() });
  await s.flow.open(SELECTION);
  assert.equal(s.calls.length, 1);
  assert.equal(s.calls[0].pdfUrl, WARD1);
  assert.equal(s.container.hidden, false);
  assert.equal(s.shown.length, 1);
  const list = s.shown[0];
  assert.ok(list.length > 200, `${list.length} entries`);
  // Every printed entry is listed; the 29 struck-off ones are counted apart.
  assert.equal(list.length, 326);
  assert.equal(list.filter((e) => e.struck).length, 29);
  assert.equal(countLine(s.container), `${strings.roll_count}: ${expected.length} · ${strings.roll_struck_count}: 29`);
  assert.ok(rowCount(s.container) > 0 && rowCount(s.container) < 30);

  // The decoder's Hindi reaches the screen unchanged.
  const first = expected.find((e) => e.serial === list[0].serial);
  assert.equal(list[0].name, first.name);
  assert.match(s.container.textContent, new RegExp(`1\\. ${first.name}`));
  assert.deepEqual(await s.store.loadStored('17/125/6313/1'), list);
  assert.deepEqual(s.errors, []);
});

test('reopening offline shows the same list with no network request', async () => {
  const idb = createFakeIndexedDB();
  const online = setup({ idb, fetchRoll: async () => pdfBuffer() });
  await online.flow.open(SELECTION);
  const before = online.shown[0];

  const offline = setup({ idb, fetchRoll: async () => { throw new RollFetchError('offline'); } });
  await offline.flow.restore();
  assert.equal(offline.calls.length, 0);
  assert.deepEqual(offline.shown, [before]);
  assert.equal(countLine(offline.container), countLine(online.container));

  // Picking the stored ward again also needs no network.
  await offline.flow.open(SELECTION);
  assert.equal(offline.calls.length, 0);
  assert.deepEqual(offline.shown[1], before);
});

test('a stored roll of the old record version is downloaded and decoded again', async () => {
  const idb = createFakeIndexedDB();
  const first = setup({ idb, fetchRoll: async () => pdfBuffer() });
  await first.flow.open(SELECTION);
  // Rewrite the stored record as the old shape left it: version 1.
  const rolls = idb.databases.get('ward-canvass').stores.get('rolls');
  rolls.set('17/125/6313/1', { ...rolls.get('17/125/6313/1'), v: 1 });

  const again = setup({ idb, fetchRoll: async () => pdfBuffer() });
  await again.flow.open(SELECTION);
  assert.equal(again.calls.length, 1, 'the roll is downloaded again, not misread');
  assert.equal(again.shown[0].length, 326);
  assert.equal(rolls.get('17/125/6313/1').v, RECORD_VERSION);
  assert.deepEqual(again.errors, []);
});

test('a stored roll of an unknown record version is reported, then downloaded again', async () => {
  const idb = createFakeIndexedDB();
  const first = setup({ idb, fetchRoll: async () => pdfBuffer() });
  await first.flow.open(SELECTION);
  const rolls = idb.databases.get('ward-canvass').stores.get('rolls');
  rolls.set('17/125/6313/1', { ...rolls.get('17/125/6313/1'), v: 99 });

  const again = setup({ idb, fetchRoll: async () => pdfBuffer() });
  await again.flow.open(SELECTION);
  assert.equal(again.errors.length, 1);
  assert.ok(again.errors[0][1] instanceof RollRecordVersionError);
  assert.equal(again.errors[0][1].version, 99);
  assert.equal(again.calls.length, 1);
  assert.equal(again.shown[0].length, 326);
});

test('restore with nothing stored shows nothing and sends no request', async () => {
  const s = setup({ fetchRoll: async () => pdfBuffer() });
  assert.equal(await s.flow.restore(), null);
  assert.equal(s.calls.length, 0);
  assert.equal(s.container.hidden, true);
});

test('a failed download shows the Hindi error and a working retry button', async () => {
  let fail = true;
  const s = setup({
    fetchRoll: async () => {
      if (fail) throw new RollFetchError('roll download failed: HTTP 502', { status: 502 });
      return pdfBuffer();
    },
  });
  assert.equal(await s.flow.open(SELECTION), null);
  const alert = s.container.querySelector('p.roll-message');
  assert.equal(alert.getAttribute('role'), 'alert');
  assert.equal(alert.textContent, strings.roll_fetch_failed);
  const retry = s.container.querySelector('button.roll-retry');
  assert.equal(retry.textContent, strings.roll_retry);
  assert.equal(retry.getAttribute('type'), 'button');
  assert.equal(s.shown.length, 0);

  fail = false;
  retry.dispatchEvent({ type: 'click' });
  await waitFor(() => s.shown.length === 1);
  assert.equal(s.calls.length, 2);
  assert.equal(s.shown.length, 1);
  assert.equal(s.container.querySelector('button.roll-retry'), null);
});

test('a decode failure shows the generic Hindi error, not a crash', async () => {
  const s = setup({
    fetchRoll: async () => new TextEncoder().encode('%PDF-1.4 broken').buffer,
    decode: async () => { throw new Error('not a roll'); },
  });
  await s.flow.open(SELECTION);
  assert.equal(s.container.querySelector('p.roll-message').textContent, strings.roll_failed);
  assert.ok(s.container.querySelector('button.roll-retry'));
});

test('if storage fails the roll is still shown, minimised', async () => {
  const s = setup({ fetchRoll: async () => pdfBuffer() });
  s.store.encryptAndStore = async () => { throw new Error('quota'); };
  const decoded = await decodeWithTable(pdfBuffer());
  await s.flow.open(SELECTION);
  assert.deepEqual(s.shown[0], minimiseEntries(decoded));
  assert.equal(s.errors.length, 1);
});

test('a later pick wins over a slower earlier one', async () => {
  let release;
  const slow = new Promise((resolve) => { release = resolve; });
  const s = setup({
    fetchRoll: async (sel) => {
      if (sel.ward === '1') await slow;
      return pdfBuffer();
    },
  });
  const first = s.flow.open(SELECTION);
  const second = s.flow.open({ ...SELECTION, ward: '2', pdfUrl: WARD1.replace('001', '002') });
  await second;
  release();
  assert.equal(await first, null);
  assert.equal(s.shown.length, 1);
});

test('clear() puts the shown roll away and drops a download still running; the stored roll stays', async () => {
  let release;
  const slow = new Promise((resolve) => { release = resolve; });
  const s = setup({
    fetchRoll: async (sel) => {
      if (sel.ward === '2') await slow;
      return pdfBuffer();
    },
  });
  await s.flow.open(SELECTION);
  assert.ok(rowCount(s.container) > 0);
  const pending = s.flow.open({ ...SELECTION, ward: '2', pdfUrl: WARD1.replace('001', '002') });
  s.flow.clear({ seatType: 'sarpanch' });
  release();
  assert.equal(await pending, null, 'the dropped download shows nothing');
  assert.equal(s.flow.screen.state, 'empty');
  assert.equal(rowCount(s.container), 0);
  assert.equal(s.container.querySelector('p.roll-empty').textContent, strings.roll_sarpanch_all_wards);
  assert.equal(s.shown.length, 1);
  assert.ok(await s.store.loadStored('17/125/6313/1'), 'nothing is deleted from the phone');
});

test('clear() during a pending restore() wins: the stored roll is not shown', async () => {
  const idb = createFakeIndexedDB();
  const first = setup({ fetchRoll: async () => pdfBuffer(), idb });
  await first.flow.open(SELECTION);
  const s = setup({ fetchRoll: async () => { throw new Error('no network expected'); }, idb });
  const restoring = s.flow.restore();
  s.flow.clear({ seatType: 'sarpanch' });
  assert.equal(await restoring, null);
  assert.equal(s.flow.screen.state, 'empty');
  assert.equal(rowCount(s.container), 0);
  assert.equal(s.shown.length, 0);
  assert.equal(s.calls.length, 0);
});

test('restore() with a record that fails to decrypt neither crashes nor shows a list', async () => {
  const idb = createFakeIndexedDB();
  const online = setup({ idb, fetchRoll: async () => pdfBuffer() });
  await online.flow.open(SELECTION);
  const rolls = idb.databases.get('ward-canvass').stores.get('rolls');
  const record = rolls.get('17/125/6313/1');
  record.iv[0] ^= 0xff; // tampered
  const s = setup({ idb, fetchRoll: async () => pdfBuffer() });
  assert.equal(await s.flow.restore(), null);
  assert.equal(s.shown.length, 0);
  assert.equal(s.calls.length, 0);
  assert.equal(s.container.hidden, true);
  assert.equal(s.errors.length, 1);
  // Picking the ward again refetches and heals the copy.
  await s.flow.open(SELECTION);
  assert.equal(s.calls.length, 1);
  assert.equal(s.shown.length, 1);
});

test('a PDF that decodes to no entries is an error with retry, and is not stored', async () => {
  const s = setup({ fetchRoll: async () => pdfBuffer(), decode: async () => [] });
  await s.flow.open(SELECTION);
  assert.equal(s.container.querySelector('p.roll-message').textContent, strings.roll_failed);
  assert.ok(s.container.querySelector('button.roll-retry'));
  assert.equal(await s.store.loadStored('17/125/6313/1'), null);
});

test('rollFlow reaches the decoder only through dynamic imports (offline startup)', () => {
  const statics = (rel) => [...read(rel).toString('utf8').matchAll(/^import\s[^;]*from\s+'([^']+)'/gm)].map((m) => m[1]);
  const seen = new Set();
  const walk = (rel) => {
    for (const spec of statics(rel)) {
      const next = relative(repoRoot, fileURLToPath(new URL(spec, new URL('../' + rel, import.meta.url)))).split(sep).join('/');
      assert.doesNotMatch(next, /decoder/, `${rel} statically imports ${spec}`);
      if (!seen.has(next)) { seen.add(next); walk(next); }
    }
  };
  walk('js/picker.js');
  assert.ok(seen.has('src/roll/rollFlow.js'));
});

test('open() during a pending restore() wins; restore shows nothing', async () => {
  const idb = createFakeIndexedDB();
  const first = setup({ idb, fetchRoll: async () => pdfBuffer() });
  await first.flow.open(SELECTION); // ward 1 is now the stored "last" ward

  const s = setup({ idb, fetchRoll: async () => pdfBuffer() });
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const realLast = s.store.lastWardKey;
  s.store.lastWardKey = async () => { await gate; return realLast(); };

  const restoring = s.flow.restore();
  const ward2 = { ...SELECTION, ward: '2', pdfUrl: WARD1.replace('001', '002') };
  await s.flow.open(ward2);
  assert.equal(s.shown.length, 1);
  release();
  assert.equal(await restoring, null);
  assert.equal(s.shown.length, 1, 'the restored ward did not replace the picked one');
  assert.equal(s.calls[0].ward, '2');
});

test('the flow source never offers an upload path', () => {
  for (const rel of ['src/roll/rollFlow.js', 'src/roll/fetchRoll.js', 'js/picker.js', 'src/ui/rollList.js', 'src/ui/rollSearch.js']) {
    const src = read(rel).toString('utf8');
    assert.doesNotMatch(src, /FileReader|createElement\(\s*['"]input['"]/, rel);
  }
});

// Small roll for the search tests; two names contain राम (one starts with it).
const SEARCH_ENTRIES = [
  { serial: 1, name: 'सीताराम मीणा', relative: 'मोहन', age: 40, gender: 'पु', house: '1' },
  { serial: 2, name: 'सीता देवी', relative: 'सीताराम मीणा', age: 38, gender: 'म', house: '1' },
  { serial: 3, name: 'श्याम लाल', relative: 'गोपाल', age: 50, gender: 'पु', house: '2' },
  { serial: 4, name: 'राम प्रसाद', relative: 'गोपाल', age: 45, gender: 'पु', house: '3' },
];

function searchSetup({ idb = createFakeIndexedDB(), fetchRoll = async () => pdfBuffer() } = {}) {
  const doc = createDocument();
  const container = doc.createElement('section');
  container.setAttribute('hidden', '');
  doc.body.appendChild(container);
  const calls = [];
  const store = createRollStore({ indexedDB: idb, crypto: webcrypto });
  const flow = createRollFlow(container, strings, {
    fetchRoll: async (sel) => {
      calls.push(sel);
      return fetchRoll(sel);
    },
    decode: async () => SEARCH_ENTRIES,
    store,
    listOptions: { viewportHeight: 600, requestFrame: () => {} },
    log: () => {},
  });
  return { container, flow, calls };
}

async function typeQuery(container, query) {
  const input = container.querySelector('input.pwc-search__input');
  input.value = query;
  input.dispatchEvent({ type: 'input' });
}

const resultSerials = (container) =>
  container.querySelectorAll('span.pwc-search__serial').map((n) => n.textContent.replace(/\D/g, ''));

test('the default flow shows the name search box above the list and finds a voter by name', async () => {
  const { container, flow } = searchSetup();
  await flow.open(SELECTION);
  assert.ok(container.querySelector('input.pwc-search__input'), 'search input is present');
  assert.equal(rowCount(container), SEARCH_ENTRIES.length);

  await typeQuery(container, 'श्याम लाल');
  await waitFor(() => container.querySelectorAll('li.pwc-search__row').length === 1);
  assert.deepEqual(resultSerials(container), ['3']);
  assert.equal(container.querySelector('div.roll-full').hidden, true);

  await typeQuery(container, '');
  await waitFor(() => container.querySelector('div.roll-full').hidden === false);
  assert.equal(rowCount(container), SEARCH_ENTRIES.length);
});

test('a roll restored offline at startup shows the search box', async () => {
  const idb = createFakeIndexedDB();
  const online = searchSetup({ idb });
  await online.flow.open(SELECTION);

  const offline = searchSetup({ idb, fetchRoll: async () => { throw new RollFetchError('offline'); } });
  assert.equal(offline.container.querySelector('input.pwc-search__input'), null);
  await offline.flow.restore();
  assert.equal(offline.calls.length, 0);
  assert.equal(offline.container.hidden, false);
  assert.ok(offline.container.querySelector('input.pwc-search__input'), 'search input is present offline');

  await typeQuery(offline.container, 'राम प्रसाद');
  await waitFor(() => resultSerials(offline.container).length > 0);
  assert.equal(resultSerials(offline.container)[0], '4');
});

test('a partial name lists every voter containing it, prefix matches first', async () => {
  const { container, flow } = searchSetup();
  await flow.open(SELECTION);
  await typeQuery(container, 'राम');
  await waitFor(() => resultSerials(container).length > 0);
  // राम प्रसाद starts with the query; सीताराम मीणा only contains it.
  assert.deepEqual(resultSerials(container), ['4', '1']);
  const names = container.querySelectorAll('span.pwc-search__name').map((n) => n.textContent);
  assert.deepEqual(names, ['राम प्रसाद', 'सीताराम मीणा']);
});

// --- supplementary rolls and the deletions toggle (issue #127) ---------------------

const ALMAS = read('fixtures/sec/bhilwara/ALMAS-ward-001.pdf');
const ALMAS_SUPP = read('fixtures/sec/bhilwara/ALMAS-ward-001-supp-2.pdf');
const SEC = 'https://esuchiroll.rajasthan.gov.in/Publication_PDF_2026/PRI';
const ALMAS_URL = `${SEC}/Final/60/ALMAS-Ward%20No-001.pdf`;
const ALMAS_SUPP_URL = `${SEC}/Supplement/60/ALMAS-Ward%20No-001.pdf`;
const ALMAS_KEY = '2/60/9/1';
const ALMAS_SELECTION = {
  district: '2', samiti: '60', panchayat: '9', ward: '1', pdfUrl: ALMAS_URL, supplementPdfUrls: [ALMAS_SUPP_URL],
};
const withSupplements = (...urls) => ({ ...ALMAS_SELECTION, supplementPdfUrls: urls });

// Supplements with set contents: served as marker PDFs that the test decoder
// reads as the entries below (the ALMAS PDFs decode for real).
const MARKED = {
  // A later supplement: strikes off serial 10 and adds serial 377.
  [`${SEC}/Supplement3/60/ALMAS-Ward%20No-001.pdf`]: [
    { serial: 10, name: 'बालू', relative: 'खेमा', age: 73, gender: 'पुरूष', house: '2', struck: true },
    { serial: 377, name: 'नई मतदाता', relative: 'रामलाल', age: 18, gender: 'स्त्री', house: '9', struck: false },
  ],
  // An earlier supplement that prints serial 12 live and adds 378...
  [`${SEC}/SuppA/60/ALMAS-Ward%20No-001.pdf`]: [
    { serial: 12, name: 'हजारी', relative: 'खेमा', age: 63, gender: 'पुरूष', house: '2', struck: false },
    { serial: 378, name: 'नया मतदाता', relative: 'हजारी', age: 19, gender: 'पुरूष', house: '2', struck: false },
  ],
  // ...and the one after it, which strikes serial 12 off.
  [`${SEC}/SuppB/60/ALMAS-Ward%20No-001.pdf`]: [
    { serial: 12, name: 'हजारी', relative: 'खेमा', age: 63, gender: 'पुरूष', house: '2', struck: true },
    { serial: 378, name: 'नया मतदाता', relative: 'हजारी', age: 19, gender: 'पुरूष', house: '2', struck: false },
  ],
};
const [SUPP3_URL, SUPP_A_URL, SUPP_B_URL] = Object.keys(MARKED);
const MARKER = '%PDF-1.4 marker ';
const markerPdf = (url) => new TextEncoder().encode(MARKER + url);

async function decodeAlmas(bytes) {
  const text = new TextDecoder().decode(new Uint8Array(bytes).subarray(0, 200));
  if (text.startsWith(MARKER)) return MARKED[text.slice(MARKER.length)].map((e) => ({ ...e }));
  return decodeWithTable(bytes);
}

function memorySettings() {
  let record = null;
  return {
    load: () => ({ showDeletions: record ? record.showDeletions : false }),
    save: (s) => { record = { ...s }; return true; },
  };
}

// The real fetchRoll/fetchSupplements over a fake network that answers the
// same-origin relay only, and records every request. fails(url) makes that
// URL answer 502.
function almasSetup({
  idb = createFakeIndexedDB(), settings = memorySettings(), fails = () => false, selectionFor = ALMAS_SELECTION,
} = {}) {
  const requests = [];
  const fetch = async (url, init) => {
    requests.push({ url, method: (init && init.method) || 'GET', init });
    const target = new URL(url, 'https://canvass.example');
    assert.equal(target.pathname, RELAY_PATH);
    const pdfUrl = target.searchParams.get('url');
    if (fails(pdfUrl)) return new Response('no', { status: 502 });
    const bytes = pdfUrl === ALMAS_URL ? ALMAS : pdfUrl === ALMAS_SUPP_URL ? ALMAS_SUPP
      : MARKED[pdfUrl] ? markerPdf(pdfUrl) : null;
    return bytes ? new Response(bytes, { status: 200 }) : new Response('no', { status: 403 });
  };
  const doc = createDocument();
  const container = doc.createElement('section');
  doc.body.appendChild(container);
  const shown = [];
  const errors = [];
  const store = createRollStore({ indexedDB: idb, crypto: webcrypto });
  const flow = createRollFlow(container, strings, {
    fetchRoll: (sel) => realFetchRoll(sel, { fetch }),
    fetchSupplements: (sel) => realFetchSupplements(sel, { fetch }),
    decode: decodeAlmas,
    store,
    settings,
    selectionFor: (key) => (key === ALMAS_KEY ? selectionFor : null),
    onShow: (entries) => shown.push(entries),
    listOptions: { viewportHeight: 40000, requestFrame: () => {} },
    log: (...args) => errors.push(args),
  });
  return { doc, container, flow, requests, shown, errors, store, idb, settings };
}

const relayed = (url) => `${RELAY_PATH}?url=${encodeURIComponent(url)}`;
const requested = (s, from = 0) => s.requests.slice(from).map((r) => r.url);
const listedSerials = (container) => container.querySelectorAll('span.roll-name')
  .map((n) => Number(n.textContent.split('.')[0]));
const toggleInput = (container) => container.querySelector('input.choice-input');
const supplementBox = (container) => container.querySelector('div.roll-supplement');
const tagged = (entries, kind) => entries.filter((e) => e.supplement === kind).map((e) => e.serial);
const flip = (container, on) => {
  toggleInput(container).checked = on;
  toggleInput(container).dispatchEvent({ type: 'change' });
};

async function retry(s) {
  const before = s.requests.length;
  const count = s.shown.length;
  s.container.querySelector('button.roll-supplement-retry').dispatchEvent({ type: 'click' });
  await waitFor(() => s.shown.length === count + 1);
  return requested(s, before);
}

test('the ALMAS supplement is fetched through the relay, merged, and its deletion hidden until the toggle is on', async () => {
  const s = almasSetup();
  await s.flow.open(ALMAS_SELECTION);
  assert.deepEqual(s.errors, []);
  // Two same-origin GETs to the relay: the roll, then its supplement.
  assert.deepEqual(s.requests.map((r) => [r.method, r.url]), [['GET', relayed(ALMAS_URL)], ['GET', relayed(ALMAS_SUPP_URL)]]);
  for (const r of s.requests) assert.equal(r.init.credentials, 'same-origin');

  const entries = s.shown[0];
  assert.equal(entries.length, 376);
  assert.deepEqual(tagged(entries, 'deletion'), [258]);
  assert.deepEqual(await s.store.loadStored(ALMAS_KEY), entries);
  assert.deepEqual(await s.store.supplementState(ALMAS_KEY), { state: 'merged', urls: [ALMAS_SUPP_URL] });

  // Off by default: serial 258 is not listed; the roll's own struck-off ones are.
  const input = toggleInput(s.container);
  assert.equal(input.checked, false);
  assert.ok(input.parentNode.classList.contains('choice'));
  assert.ok(!listedSerials(s.container).includes(258));
  assert.ok(listedSerials(s.container).includes(81));
  assert.equal(listedSerials(s.container).length, 375);

  // On: it shows, struck through and marked deleted by the supplement.
  flip(s.container, true);
  assert.ok(listedSerials(s.container).includes(258));
  const row = s.container.querySelectorAll('div.roll-row')
    .find((r) => r.querySelector('span.roll-name').textContent.startsWith('258.'));
  assert.ok(row.querySelector('del.roll-struck'));
  assert.ok(row.querySelector('span.roll-meta').textContent.startsWith(strings.supp_deleted));
  assert.equal(s.flow.screen.list.root.querySelectorAll('div.roll-row').length, 376);

  // Off again hides it.
  flip(s.container, false);
  assert.ok(!listedSerials(s.container).includes(258));
});

test('flipping the toggle keeps a typed search query', async () => {
  const s = almasSetup();
  await s.flow.open(ALMAS_SELECTION);
  const query = () => s.container.querySelector('input.pwc-search__input');
  query().value = 'मन्शा';
  flip(s.container, true);
  assert.equal(query().value, 'मन्शा');
  flip(s.container, false);
  assert.equal(query().value, 'मन्शा');
});

test('the toggle state persists: a reload restores the roll offline with deletions shown', async () => {
  const idb = createFakeIndexedDB();
  const settings = memorySettings();
  const first = almasSetup({ idb, settings });
  await first.flow.open(ALMAS_SELECTION);
  flip(first.container, true);
  assert.equal(settings.load().showDeletions, true);

  const reload = almasSetup({ idb, settings });
  await reload.flow.restore();
  assert.equal(reload.requests.length, 0, 'no network on restore');
  assert.equal(toggleInput(reload.container).checked, true);
  assert.ok(listedSerials(reload.container).includes(258));
  // Picking the stored ward again needs no network either: its supplement is merged.
  await reload.flow.open(ALMAS_SELECTION);
  assert.equal(reload.requests.length, 0);
});

test('a supplement the catalogue lists after the ward was merged is fetched, alone, and merged on open', async () => {
  const idb = createFakeIndexedDB();
  await almasSetup({ idb }).flow.open(ALMAS_SELECTION);

  const later = almasSetup({ idb });
  await later.flow.open(withSupplements(ALMAS_SUPP_URL, SUPP3_URL));
  assert.deepEqual(requested(later), [relayed(SUPP3_URL)]);
  assert.deepEqual(later.errors, []);
  const entries = later.shown[0];
  assert.equal(entries.length, 377);
  assert.deepEqual(tagged(entries, 'deletion'), [10, 258]);
  assert.deepEqual(tagged(entries, 'addition'), [377]);
  assert.deepEqual(await later.store.supplementState(ALMAS_KEY), { state: 'merged', urls: [ALMAS_SUPP_URL, SUPP3_URL] });
  // Opened again, nothing new is listed: no request.
  await later.flow.open(withSupplements(ALMAS_SUPP_URL, SUPP3_URL));
  assert.equal(later.requests.length, 1);
});

test('a ward whose catalogue no longer lists its merged supplement is merged again from the roll, without it', async () => {
  const idb = createFakeIndexedDB();
  await almasSetup({ idb }).flow.open(ALMAS_SELECTION);

  // Offline, the stored roll shows as it is, merged deletions and all.
  const offline = almasSetup({ idb, fails: () => true });
  await offline.flow.open(withSupplements());
  assert.deepEqual(requested(offline), [relayed(ALMAS_URL)]);
  assert.equal(offline.flow.screen.state, 'filled');
  assert.deepEqual(tagged(offline.shown[0], 'deletion'), [258]);
  assert.equal(supplementBox(offline.container).getAttribute('data-state'), 'filled');
  assert.equal(offline.errors.length, 1);

  // Online, the roll is downloaded again and the supplement's changes go.
  const online = almasSetup({ idb });
  await online.flow.open(withSupplements());
  assert.deepEqual(requested(online), [relayed(ALMAS_URL)]);
  assert.equal(online.shown[0].filter((e) => e.supplement).length, 0);
  assert.equal(online.shown[0].find((e) => e.serial === 258).struck, false);
  assert.deepEqual(await online.store.supplementState(ALMAS_KEY), { state: 'none', urls: [] });
  // The toggle shows its empty state: no supplementary roll is published.
  assert.equal(supplementBox(online.container).getAttribute('data-state'), 'empty');
  assert.equal(supplementBox(online.container).querySelector('p.notice').textContent, strings.supp_no_deletions);
});

test('a ward with no supplementary roll shows the toggle\'s empty line, not an error', async () => {
  const s = setup({ fetchRoll: async () => pdfBuffer() });
  await s.flow.open(SELECTION);
  const notice = supplementBox(s.container).querySelector('p.notice');
  assert.equal(notice.textContent, strings.supp_no_deletions);
  assert.equal(notice.getAttribute('data-tone'), 'info');
  assert.equal(s.container.querySelector('input.choice-input'), null);
  assert.equal(s.container.querySelector('button.roll-supplement-retry'), null);
  assert.deepEqual(s.errors, []);
});

test('a supplement that fails to download leaves the roll loaded, with an error to retry and whom to call', async () => {
  let fail = true;
  const s = almasSetup({ fails: (url) => fail && url === ALMAS_SUPP_URL });
  s.flow.screen.setSupport('समन्वयक: 98290 00000');
  await s.flow.open(ALMAS_SELECTION);
  assert.equal(s.flow.screen.state, 'filled');
  assert.equal(s.shown[0].length, 376);
  assert.equal(s.shown[0].filter((e) => e.supplement).length, 0);
  assert.deepEqual(await s.store.supplementState(ALMAS_KEY), { state: 'failed', urls: [] });
  const box = supplementBox(s.container);
  const notice = box.querySelector('p.notice');
  assert.equal(notice.textContent, strings.supp_failed);
  assert.equal(notice.getAttribute('data-tone'), 'error');
  assert.equal(box.querySelector('p.roll-contact').textContent, 'समन्वयक: 98290 00000');
  assert.equal(s.errors.length, 1);

  // Retry fetches only the supplement again (the roll is stored) and merges it.
  fail = false;
  assert.deepEqual(await retry(s), [relayed(ALMAS_SUPP_URL)]);
  assert.deepEqual(tagged(s.shown[1], 'deletion'), [258]);
  assert.deepEqual(await s.store.supplementState(ALMAS_KEY), { state: 'merged', urls: [ALMAS_SUPP_URL] });
  assert.ok(toggleInput(s.container));
});

test('a restored roll whose supplement failed retries it: only the supplement is fetched, then merged', async () => {
  const idb = createFakeIndexedDB();
  const first = almasSetup({ idb, fails: (url) => url === ALMAS_SUPP_URL });
  await first.flow.open(ALMAS_SELECTION);
  assert.deepEqual(await first.store.supplementState(ALMAS_KEY), { state: 'failed', urls: [] });

  // A reload: restore() shows the stored roll with no request, in the error state.
  const reload = almasSetup({ idb });
  await reload.flow.restore();
  assert.equal(reload.requests.length, 0);
  assert.equal(supplementBox(reload.container).getAttribute('data-state'), 'error');
  assert.equal(reload.shown[0].length, 376);

  // Its retry finds the ward's selection (deps.selectionFor, as js/picker.js wires it).
  assert.deepEqual(await retry(reload), [relayed(ALMAS_SUPP_URL)]);
  assert.deepEqual(tagged(reload.shown[1], 'deletion'), [258]);
  assert.equal(supplementBox(reload.container).getAttribute('data-state'), 'filled');
  assert.deepEqual(await reload.store.supplementState(ALMAS_KEY), { state: 'merged', urls: [ALMAS_SUPP_URL] });
});

test('one of two supplements failing keeps the other\'s tags under the error; a retry merges the rest once', async () => {
  let fail = true;
  const selection = withSupplements(ALMAS_SUPP_URL, SUPP3_URL);
  const s = almasSetup({ fails: (url) => fail && url === SUPP3_URL, selectionFor: selection });
  await s.flow.open(selection);
  // The supplement that downloaded is merged; the error says the other failed.
  assert.deepEqual(tagged(s.shown[0], 'deletion'), [258]);
  assert.deepEqual(tagged(s.shown[0], 'addition'), []);
  assert.deepEqual(await s.store.supplementState(ALMAS_KEY), { state: 'failed', urls: [ALMAS_SUPP_URL] });
  const box = supplementBox(s.container);
  assert.equal(box.getAttribute('data-state'), 'error');
  assert.equal(box.querySelector('p.notice').textContent, strings.supp_failed);
  assert.ok(box.querySelector('p.roll-contact'));

  fail = false;
  // Only the failed one is fetched again; no tag is lost or doubled.
  assert.deepEqual(await retry(s), [relayed(SUPP3_URL)]);
  const entries = s.shown[1];
  assert.equal(entries.length, 377);
  assert.equal(new Set(entries.map((e) => e.serial)).size, entries.length);
  assert.deepEqual(tagged(entries, 'deletion'), [10, 258]);
  assert.deepEqual(tagged(entries, 'addition'), [377]);
  assert.deepEqual(await s.store.supplementState(ALMAS_KEY), { state: 'merged', urls: [ALMAS_SUPP_URL, SUPP3_URL] });
  assert.equal(supplementBox(s.container).getAttribute('data-state'), 'filled');
  assert.equal(supplementBox(s.container).textContent, `${strings.supp_show_deletions} (2)`);
});

test('an earlier supplement that fails holds the later ones back, so its retry cannot undo a later strike-off', async () => {
  let fail = true;
  const selection = withSupplements(SUPP_A_URL, SUPP_B_URL);
  const s = almasSetup({ fails: (url) => fail && url === SUPP_A_URL, selectionFor: selection });
  await s.flow.open(selection);
  // supp-1 failed, so supp-2 is not even fetched: nothing is merged yet.
  assert.deepEqual(requested(s), [relayed(ALMAS_URL), relayed(SUPP_A_URL)]);
  assert.equal(s.shown[0].filter((e) => e.supplement).length, 0);
  assert.deepEqual(await s.store.supplementState(ALMAS_KEY), { state: 'failed', urls: [] });
  assert.equal(supplementBox(s.container).getAttribute('data-state'), 'error');

  // The retry merges supp-1 then supp-2, in publication order: serial 12,
  // which supp-1 prints live and supp-2 strikes off, ends struck off.
  fail = false;
  assert.deepEqual(await retry(s), [relayed(SUPP_A_URL), relayed(SUPP_B_URL)]);
  const twelve = s.shown[1].find((e) => e.serial === 12);
  assert.equal(twelve.struck, true);
  assert.equal(twelve.supplement, 'deletion');
  assert.deepEqual(tagged(s.shown[1], 'addition'), [378]);
  assert.deepEqual(await s.store.supplementState(ALMAS_KEY), { state: 'merged', urls: [SUPP_A_URL, SUPP_B_URL] });
});

test('tags after two staggered merges are the same as one merge of both, relative to the roll merged so far', async () => {
  // Staggered: supp-1 merged on one open, supp-2 on a later open over the stored roll.
  const idb = createFakeIndexedDB();
  await almasSetup({ idb }).flow.open(withSupplements(SUPP_A_URL));
  const later = almasSetup({ idb });
  await later.flow.open(withSupplements(SUPP_A_URL, SUPP_B_URL));
  assert.deepEqual(requested(later), [relayed(SUPP_B_URL)]);
  // At once: both on a fresh device.
  const once = almasSetup();
  await once.flow.open(withSupplements(SUPP_A_URL, SUPP_B_URL));
  const summary = (entries) => entries.map((e) => [e.serial, e.struck, e.supplement]);
  assert.deepEqual(summary(later.shown[0]), summary(once.shown[0]));
  assert.deepEqual(tagged(once.shown[0], 'deletion'), [12]);
  assert.deepEqual(tagged(once.shown[0], 'addition'), [378]);
});

test('a supplement that fails to decode still shows the roll, with the supplement error', async () => {
  const s = setup({ fetchRoll: async () => pdfBuffer() });
  const flow = createRollFlow(s.container, strings, {
    fetchRoll: async () => pdfBuffer(),
    fetchSupplements: async (sel) => sel.supplementPdfUrls.map((url) => ({ url, ok: true, buffer: new TextEncoder().encode('%PDF-1.4 x').buffer })),
    decode: async (bytes) => {
      if (bytes.byteLength < 100) throw new Error('not a roll');
      return decodeWithTable(bytes);
    },
    store: s.store,
    settings: memorySettings(),
    onShow: (entries) => s.shown.push(entries),
    listOptions: { viewportHeight: 600, requestFrame: () => {} },
    log: (...args) => s.errors.push(args),
  });
  await flow.open({ ...SELECTION, supplementPdfUrls: ['https://esuchiroll.rajasthan.gov.in/x.pdf'] });
  assert.equal(flow.screen.state, 'filled');
  assert.equal(s.shown[0].length, 326);
  assert.equal(supplementBox(s.container).getAttribute('data-state'), 'error');
  assert.match(String(s.errors[0][0]), /could not be decoded/);
});

test('roll settings of an unknown version are reported in the log, and deletions stay hidden', async () => {
  const saved = globalThis.localStorage;
  globalThis.localStorage = {
    getItem: () => JSON.stringify({ schemaVersion: 99, showDeletions: true }),
    setItem: () => {},
  };
  try {
    const doc = createDocument();
    const container = doc.createElement('section');
    const errors = [];
    const flow = createRollFlow(container, strings, {
      fetchRoll: async () => pdfBuffer(),
      store: createRollStore({ indexedDB: createFakeIndexedDB(), crypto: webcrypto }),
      listOptions: { viewportHeight: 600, requestFrame: () => {} },
      log: (...args) => errors.push(args),
    });
    await flow.open(SELECTION);
    assert.deepEqual(errors, [['roll settings could not be read', 'unknown-version', 99]]);
  } finally {
    globalThis.localStorage = saved;
  }
});
