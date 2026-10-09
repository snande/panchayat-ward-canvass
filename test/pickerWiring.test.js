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
import { onRequest as syncOnRequest } from '../functions/sync.js';

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

function boot(idb, requests, { syncEnv, localStorage, rollFails = () => false } = {}) {
  const doc = createDocument();
  const picker = doc.createElement('section');
  const roll = doc.createElement('section');
  roll.setAttribute('hidden', '');
  const empty = doc.createElement('section');
  const team = doc.createElement('section');
  team.setAttribute('hidden', '');
  const seat = doc.createElement('div');
  seat.setAttribute('data-state', 'pending');
  const byId = { 'ward-picker': picker, roll, 'seat-header': seat };
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
    if (url === 'config/constituency.json') return new Response(read('config/constituency.json'));
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
  return { picker, roll, empty, team, seat, restore };
}

function choose(select, value) {
  select.value = value;
  select.dispatchEvent({ type: 'change' });
}

function memoryStorage() {
  const stored = new Map();
  return { stored, getItem: (k) => stored.get(k) ?? null, setItem: (k, v) => { stored.set(k, String(v)); } };
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
  const store = new Map();
  const syncEnv = {
    SYNC_SECRET: 'test-sync-secret',
    SYNC_KV: { get: async (k) => (store.has(k) ? store.get(k) : null), put: async (k, v) => { store.set(k, String(v)); } },
  };
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
    assert.ok(store.has('c/candA/verifier'));
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
