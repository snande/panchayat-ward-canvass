// Ward pick -> download -> decode -> encrypted store -> list (issue #16),
// run by `npm test` on the fake DOM and the in-memory IndexedDB.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { webcrypto } from 'node:crypto';
import { relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createRollFlow, decodeWithTable } from '../src/roll/rollFlow.js';
import { RollFetchError } from '../src/roll/fetchRoll.js';
import { createRollStore, minimiseEntries } from '../src/roll/rollStore.js';
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
  assert.equal(countLine(s.container), `${strings.roll_count}: ${list.length}`);
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

test('the stored roll keeps the struck-off entries, flagged, and the list shows every serial', async () => {
  const s = setup({ fetchRoll: async () => pdfBuffer() });
  await s.flow.open(SELECTION);
  const list = s.shown[0];
  assert.deepEqual(list.map((e) => e.serial), Array.from({ length: 326 }, (_, i) => i + 1));
  assert.equal(list.filter((e) => !e.struck).length, expected.length);
  assert.equal(list.find((e) => e.serial === 9).struck, true);
  assert.equal(countLine(s.container), `${strings.roll_count}: 326`);
  assert.deepEqual(await s.store.loadStored('17/125/6313/1'), list);
});

test('an old-version stored roll is decoded again, not misread', async () => {
  const idb = createFakeIndexedDB();
  const online = setup({ idb, fetchRoll: async () => pdfBuffer() });
  await online.flow.open(SELECTION);
  const rolls = idb.databases.get('ward-canvass').stores.get('rolls');
  rolls.set('17/125/6313/1', { ...rolls.get('17/125/6313/1'), v: 1 });

  const s = setup({ idb, fetchRoll: async () => pdfBuffer() });
  // restore() has no PDF address: it shows nothing rather than the old copy
  assert.equal(await s.flow.restore(), null);
  assert.equal(s.calls.length, 0);
  // picking the ward downloads and decodes it again and stores the current shape
  await s.flow.open(SELECTION);
  assert.equal(s.calls.length, 1);
  assert.deepEqual(s.shown, online.shown);
  assert.equal(rolls.get('17/125/6313/1').v, 2);
  assert.deepEqual(s.errors, []);
});

test('a stored roll of an unknown version is reported and decoded again', async () => {
  const idb = createFakeIndexedDB();
  const online = setup({ idb, fetchRoll: async () => pdfBuffer() });
  await online.flow.open(SELECTION);
  const rolls = idb.databases.get('ward-canvass').stores.get('rolls');
  rolls.set('17/125/6313/1', { ...rolls.get('17/125/6313/1'), v: 99 });

  const s = setup({ idb, fetchRoll: async () => pdfBuffer() });
  await s.flow.open(SELECTION);
  assert.equal(s.errors.length, 1);
  assert.match(s.errors[0][0], /unknown record version 99/);
  assert.equal(s.errors[0][1].name, 'RollRecordVersionError');
  assert.equal(s.calls.length, 1);
  assert.deepEqual(s.shown, online.shown);
  assert.equal(rolls.get('17/125/6313/1').v, 2);
});

test('a PDF that decodes to no entries is an error with retry, and is not stored', async () => {
  const s = setup({ fetchRoll: async () => pdfBuffer(), decode: async () => [] });
  await s.flow.open(SELECTION);
  assert.equal(s.container.querySelector('p.roll-message').textContent, strings.roll_failed);
  assert.ok(s.container.querySelector('button.roll-retry'));
  assert.equal(await s.store.loadStored('17/125/6313/1'), null);

  // nor does one whose every entry is struck off
  const allStruck = setup({ fetchRoll: async () => pdfBuffer(), decode: async () => [{ serial: 1, name: 'क', struck: true }] });
  await allStruck.flow.open(SELECTION);
  assert.equal(allStruck.container.querySelector('p.roll-message').textContent, strings.roll_failed);
  assert.equal(await allStruck.store.loadStored('17/125/6313/1'), null);
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
