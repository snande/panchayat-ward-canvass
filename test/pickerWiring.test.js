// js/picker.js wiring (issue #16): choosing a ward calls the roll flow's
// open(), a shown roll hides the "not loaded yet" card, and a stored roll is
// restored at startup. Runs the real module against the fake DOM, a stubbed
// fetch and the in-memory IndexedDB.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { createDocument } from './helpers/fakeDom.js';
import { createFakeIndexedDB } from './helpers/fakeIndexedDB.js';

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

function boot(idb, requests) {
  const doc = createDocument();
  const picker = doc.createElement('section');
  const roll = doc.createElement('section');
  roll.setAttribute('hidden', '');
  const empty = doc.createElement('section');
  const byId = { 'ward-picker': picker, roll };
  const fakeDocument = {
    getElementById: (id) => byId[id] || null,
    querySelector: (sel) => (sel === '.empty-state' ? empty : null),
    createElement: (tag) => doc.createElement(tag),
    ownerDocument: doc,
  };
  picker.ownerDocument = doc;
  const fetch = async (input) => {
    const url = String(input);
    requests.push(url);
    if (url.startsWith('file:')) return new Response(readFileSync(fileURLToPath(url)));
    if (url === 'src/strings.hi.json') return new Response(read('src/strings.hi.json'));
    if (url === 'config/constituency.json') return new Response(read('config/constituency.json'));
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
  return { picker, roll, empty, restore };
}

function choose(select, value) {
  select.value = value;
  select.dispatchEvent({ type: 'change' });
}

test('picking a ward opens its roll and hides the empty state; a reload restores it offline', async () => {
  const idb = createFakeIndexedDB();
  const requests = [];
  const first = boot(idb, requests);
  try {
    await import('../js/picker.js?wiring=1');
    await waitFor(() => first.picker.querySelector('select') !== null);
    const [district, samiti, panchayat, ward] = first.picker.querySelectorAll('select');
    choose(district, '17');
    choose(samiti, '125');
    choose(panchayat, '6313');
    assert.equal(first.roll.querySelectorAll('div.roll-row').length, 0);
    choose(ward, '1');

    await waitFor(() => first.roll.querySelectorAll('div.roll-row').length > 0);
    assert.ok(requests.includes(`/roll?url=${encodeURIComponent(WARD1)}`), requests.join('\n'));
    assert.equal(first.empty.hidden, true);
    assert.equal(first.roll.hidden, false);
  } finally {
    first.restore();
  }

  // "Reopen the app": a fresh page over the same IndexedDB makes no roll request.
  const reopenRequests = [];
  const second = boot(idb, reopenRequests);
  try {
    await import('../js/picker.js?wiring=2');
    await waitFor(() => second.roll.querySelectorAll('div.roll-row').length > 0);
    assert.equal(second.empty.hidden, true);
    assert.ok(!reopenRequests.some((u) => u.startsWith('/roll')), reopenRequests.join('\n'));
  } finally {
    second.restore();
  }
});
