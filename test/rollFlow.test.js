// Ward pick -> download -> decode -> encrypted store -> list (issue #16),
// run by `npm test` on the fake DOM and the in-memory IndexedDB.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { webcrypto } from 'node:crypto';

import { createRollFlow, decodeWithTable } from '../src/roll/rollFlow.js';
import { RollFetchError } from '../src/roll/fetchRoll.js';
import { createRollStore, minimiseEntries } from '../src/roll/rollStore.js';
import { createDocument } from './helpers/fakeDom.js';
import { createFakeIndexedDB } from './helpers/fakeIndexedDB.js';

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

test('the flow source never offers an upload path', () => {
  for (const rel of ['src/roll/rollFlow.js', 'src/roll/fetchRoll.js', 'js/picker.js', 'src/ui/rollList.js']) {
    const src = read(rel).toString('utf8');
    assert.doesNotMatch(src, /FileReader|createElement\(\s*['"]input['"]/, rel);
  }
});
