// Seen-voting marks wired to the polling-day count beside the official
// turnout (issue #82), run by `npm test`. Each phone is its own in-memory
// IndexedDB with its own team join, sync engine and mark store; every sync
// request goes to the real functions/sync.js handler over an in-memory KV.
// The marks are made by tapping through the roll view (src/ui/rollSearch.js)
// on the fake DOM, and the count is read off the turnout screen it opens.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { webcrypto } from 'node:crypto';

import { catalogueResponse, pickSeat } from './helpers/catalogueFixture.js';
import { createDocument, type } from './helpers/fakeDom.js';
import { createFakeIndexedDB } from './helpers/fakeIndexedDB.js';
import { createSyncD1 } from './helpers/memoryD1.js';
import { onRequest as syncOnRequest } from '../functions/sync.js';
import { createSyncEngine } from '../src/sync/syncEngine.js';
import { createTeamAuth } from '../src/sync/teamAuth.js';
import { createSeenVotingStore, markRecordId } from '../src/tally/seenVotingStore.js';
import { createTurnoutStore } from '../src/tally/turnoutStore.js';
import { mountRollWithSearch } from '../src/ui/rollSearch.js';
import { mountSeenVotingMark } from '../src/ui/seenVotingMark.js';
import { DB_NAME, MARKS_STORE, OUTBOX_STORE } from '../src/storage/deviceDb.js';

const read = (rel) => readFileSync(new URL('../' + rel, import.meta.url));
const strings = JSON.parse(read('src/strings.hi.json'));
const ORIGIN = 'https://canvass.takshavid.com';
const WARD = '17/125/6313/1';
const OTHER_WARD = '17/125/6313/2';
const PASS = 'हमारी टीम';

const settle = () => new Promise((resolve) => setImmediate(resolve));

async function waitFor(cond, ms = 8000) {
  const until = Date.now() + ms;
  while (!(await cond())) {
    if (Date.now() > until) throw new Error('timed out');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

async function server() {
  const env = { SYNC_SECRET: 'test-sync-secret', SYNC_DB: await createSyncD1() };
  const handle = (url, init = {}) => syncOnRequest({ request: new Request(new URL(url, ORIGIN), init), env });
  // The team's stored mark entries (not the index), for one candidate.
  const markEntries = (candidateId) =>
    env.SYNC_DB.sqlite.query(
      "SELECT id, updated_at AS updatedAt, ciphertext, iv, seq, device_id AS deviceId FROM records WHERE candidate_id = ? AND id LIKE 'mark:%' ORDER BY seq",
      [candidateId],
    );
  return { env, handle, markEntries };
}

function clock(start) {
  let t = Date.parse(start);
  return () => new Date((t += 1000)).toISOString();
}

const ENTRIES = Array.from({ length: 30 }, (_, i) => ({
  serial: i + 1, name: `मतदाता ${i + 1}`, relative: 'पिता', age: 30 + i, gender: 'पु', house: String(i + 1),
}));

// No contact is on record for anyone; the contact panel only reads.
const noContacts = {
  getContact: async () => null,
  recordConsent: async () => null,
  saveNumber: async () => null,
  revokeConsent: async () => null,
  listConsented: async () => [],
};

// A phone with the ward roll on screen. state.offline makes every request
// throw like a phone in airplane mode.
function phone(srv, name, start) {
  const idb = createFakeIndexedDB();
  const state = { offline: false };
  const fetch = async (url, init = {}) => {
    if (state.offline) throw new TypeError('Failed to fetch');
    return srv.handle(url, init);
  };
  const auth = createTeamAuth({ indexedDB: idb, crypto: webcrypto, fetch });
  const engine = createSyncEngine({
    indexedDB: idb, crypto: webcrypto, fetch, getAuth: auth.getAuth,
    window: null, document: null, navigator: { onLine: true },
    setInterval: () => 0, clearInterval: () => {},
  });
  const marks = createSeenVotingStore({ indexedDB: idb, crypto: webcrypto, engine, now: clock(start), log: () => {} });
  marks.listen();
  const turnout = createTurnoutStore({ indexedDB: idb, crypto: webcrypto });
  const doc = createDocument();
  const container = doc.createElement('section');
  const view = mountRollWithSearch(container, ENTRIES, strings, {
    contacts: noContacts, wardKey: WARD, marks, turnout, workerId: async () => name, viewportHeight: 1200,
  });
  return { idb, state, auth, engine, marks, turnout, view };
}

function rowFor(p, serial) {
  return p.view.list.root.querySelectorAll('div.roll-row')
    .find((row) => row.querySelector('span.roll-name').textContent === `${serial}. मतदाता ${serial}`);
}

const host = (p) => p.view.contactHost;
const markButton = (p) => host(p).querySelector('button.seen-voting-mark');
const markBadge = (p) => host(p).querySelector('p.seen-voting-badge');
const isMarked = (p) => Boolean(markBadge(p)) && !markBadge(p).hidden;

// Tap the voter in the roll, then "seen voting" in the panel that opens.
async function markByTap(p, serial) {
  rowFor(p, serial).dispatchEvent({ type: 'click' });
  await waitFor(() => markButton(p) && !markButton(p).hidden);
  markButton(p).dispatchEvent({ type: 'click' });
  await waitFor(() => host(p).querySelector('p.seen-voting-message').textContent === strings.seen_mark_saved);
  assert.equal(isMarked(p), true);
  assert.equal(markButton(p).hidden, true);
}

// Tap the turnout button; resolves once the count is read.
async function openTurnout(p) {
  p.view.turnoutButton.dispatchEvent({ type: 'click' });
  assert.ok(host(p).querySelector('form.turnout-screen'), 'the turnout screen opens in the roll view');
  await waitFor(() => /^\d+$/.test(supporterText(p)));
}

const values = (p) => host(p).querySelector('form.turnout-screen').querySelectorAll('p.turnout-value');
const supporterText = (p) => values(p)[1].textContent;
const turnoutText = (p) => values(p)[0].textContent;
const stored = (idb, name) => idb.databases.get(DB_NAME)?.stores.get(name) ?? new Map();

test('one voter marked on two offline phones counts once beside the official turnout after both reconnect', async () => {
  const srv = await server();
  const a = phone(srv, 'worker-a', '2026-10-07T10:00:00.000Z');
  const b = phone(srv, 'worker-b', '2026-10-07T10:00:00.500Z');
  await a.auth.joinTeam('candA', PASS);
  await b.auth.joinTeam('candA', PASS);
  assert.equal(a.view.turnoutButton.textContent, strings.turnout_open);

  // Both phones offline: phone A marks voters 3 and 5, phone B marks voter 3.
  a.state.offline = true;
  b.state.offline = true;
  await markByTap(a, 3);
  await markByTap(a, 5);
  await markByTap(b, 3);
  assert.deepEqual(srv.markEntries('candA'), []);
  assert.equal(stored(a.idb, OUTBOX_STORE).size, 2);
  assert.equal(stored(b.idb, OUTBOX_STORE).size, 1);

  // Offline, each phone counts what it holds.
  await openTurnout(a);
  assert.equal(supporterText(a), '2');
  await openTurnout(b);
  assert.equal(supporterText(b), '1');

  // Reconnect both; each pulls after both pushed. B's screen stays open and
  // its count is read again as A's marks arrive.
  a.state.offline = false;
  b.state.offline = false;
  for (const p of [a, b, a, b]) assert.equal((await p.engine.syncNow()).status, 'ok');
  await waitFor(() => supporterText(b) === '2');

  // Voter 3 is one entry on the server and one in each phone's count.
  assert.equal(srv.markEntries('candA').length, 2);
  assert.equal(srv.markEntries('candA').filter((r) => r.id === markRecordId(WARD, 3)).length, 1);
  await openTurnout(a);
  assert.equal(supporterText(a), '2');
  assert.equal(supporterText(b), '2');

  // The coordinator enters the official turnout on phone A: it shows beside
  // the de-duplicated count.
  const screen = host(a).querySelector('form.turnout-screen');
  type(screen.querySelector('input'), '४१२');
  screen.dispatchEvent({ type: 'submit', preventDefault() {} });
  await waitFor(() => turnoutText(a) === '412');
  assert.equal(supporterText(a), '2');

  // A voter a teammate marked shows as marked, with no button to mark again.
  rowFor(b, 5).dispatchEvent({ type: 'click' });
  await waitFor(() => isMarked(b));
  assert.equal(markButton(b).hidden, true);
});

test('a teammate\'s mark arriving while the panel is open replaces the button', async () => {
  const srv = await server();
  const a = phone(srv, 'worker-a', '2026-10-07T10:00:00.000Z');
  const b = phone(srv, 'worker-b', '2026-10-07T10:00:00.500Z');
  await a.auth.joinTeam('candA', PASS);
  await b.auth.joinTeam('candA', PASS);
  a.state.offline = true;
  await markByTap(b, 7);
  await b.engine.syncNow();

  rowFor(a, 7).dispatchEvent({ type: 'click' });
  await waitFor(() => markButton(a) && !markButton(a).hidden);
  a.state.offline = false;
  await a.engine.syncNow();
  await waitFor(() => isMarked(a));
  assert.equal(markButton(a).hidden, true);
});

test('tapping two voters in a row leaves one seen-voting control, for the second voter', async () => {
  const srv = await server();
  const a = phone(srv, 'worker-a', '2026-10-07T10:00:00.000Z');
  await markByTap(a, 1);
  rowFor(a, 2).dispatchEvent({ type: 'click' });
  await waitFor(() => markButton(a) && !markButton(a).hidden);
  assert.equal(host(a).querySelectorAll('section.seen-voting').length, 1);
  assert.equal(host(a).querySelectorAll('section.contact-panel').length, 1);
  assert.equal(host(a).querySelector('h2').textContent, '2. मतदाता 2');

  // Opening the turnout screen replaces the control.
  await openTurnout(a);
  assert.equal(host(a).querySelectorAll('section.seen-voting').length, 0);
  assert.equal(host(a).querySelectorAll('form.turnout-screen').length, 1);
});

test('the supporter count is the ward\'s marks only, and a destroyed roll view stops refreshing it', async () => {
  const srv = await server();
  const a = phone(srv, 'worker-a', '2026-10-07T10:00:00.000Z');
  await a.marks.markSeen(WARD, 1, 'worker-a');
  await a.marks.markSeen(OTHER_WARD, 1, 'worker-a');
  await a.marks.markSeen(OTHER_WARD, 2, 'worker-a');
  assert.equal(await a.marks.teamCount(), 3);
  assert.equal(await a.marks.wardCount(WARD), 1);
  assert.equal(await a.marks.wardCount(OTHER_WARD), 2);
  await assert.rejects(a.marks.wardCount('bad:ward'), TypeError);

  await openTurnout(a);
  assert.equal(supporterText(a), '1');
  await markByTap(a, 2);
  assert.equal(host(a).querySelector('form.turnout-screen'), null);
  await openTurnout(a);
  assert.equal(supporterText(a), '2');

  // Once the roll view is gone its screen no longer follows mark changes.
  a.view.destroy();
  await a.marks.markSeen(WARD, 9, 'worker-a');
  for (let i = 0; i < 5; i += 1) await settle();
  assert.equal(await a.marks.wardCount(WARD), 3);
  assert.equal(supporterText(a), '2');
});

test('without a mark store the roll view has no turnout button and no seen-voting control', async () => {
  const doc = createDocument();
  const container = doc.createElement('section');
  const view = mountRollWithSearch(container, ENTRIES, strings, { contacts: noContacts, wardKey: WARD });
  assert.equal(view.turnoutButton, null);
  assert.equal(view.openTurnout(), null);
  const panel = view.openContact(ENTRIES[0]);
  assert.equal(panel.seenVoting, undefined);
  assert.equal(view.contactHost.querySelector('section.seen-voting'), null);
});

// The control against a scripted mark store.
function control({ getMark = async () => null, markSeen, ...rest } = {}) {
  const doc = createDocument();
  const container = doc.createElement('div');
  const logged = [];
  const listeners = new Set();
  const marks = {
    getMark,
    markSeen: markSeen || (async (wardId, serial, workerId) => ({ wardId, serial, workerId, markedAt: 't' })),
    onMarksChanged: (cb) => { listeners.add(cb); return () => listeners.delete(cb); },
    ...rest,
  };
  const view = mountSeenVotingMark(container, strings, {
    marks, wardId: WARD, entry: { serial: 4 }, log: (...args) => logged.push(args),
  });
  return { ...view, container, logged, listeners, notify: () => [...listeners].forEach((cb) => cb()) };
}

test('a voter marked by a teammate before the tap shows as marked, without the saved message', async () => {
  const existing = { wardId: WARD, serial: 4, workerId: 'someone-else', markedAt: 't0' };
  const c = control({ markSeen: async () => existing });
  await c.ready;
  assert.equal(c.button.hidden, false);
  c.button.dispatchEvent({ type: 'click' });
  await waitFor(() => !c.badge.hidden);
  assert.equal(c.message.textContent, '');
  assert.equal(c.button.hidden, true);
});

test('a failed save shows the failure message and keeps the button', async () => {
  const c = control({ markSeen: async () => { throw new Error('disk full'); } });
  await c.ready;
  c.button.dispatchEvent({ type: 'click' });
  await waitFor(() => c.message.textContent === strings.seen_mark_failed);
  assert.equal(c.button.hidden, false);
  assert.equal(c.button.hasAttribute('disabled'), false);
  assert.equal(c.logged.length, 1);
});

test('a failed read says so and keeps the button instead of presenting the voter as unmarked', async () => {
  const c = control({ getMark: async () => { throw new Error('locked'); } });
  await c.ready;
  assert.equal(c.status.textContent, strings.seen_mark_read_failed);
  assert.equal(c.button.hidden, false);
  assert.equal(c.logged.length, 1);
});

test('a slow initial read does not overwrite the state a later change set', async () => {
  let release;
  let calls = 0;
  const c = control({
    getMark: () => {
      calls += 1;
      if (calls === 1) return new Promise((resolve) => { release = () => resolve(null); });
      return Promise.resolve({ wardId: WARD, serial: 4, workerId: 'w', markedAt: 't' });
    },
  });
  assert.equal(c.button.hidden, true);
  assert.equal(c.status.textContent, strings.seen_mark_loading);
  c.notify();
  await waitFor(() => !c.badge.hidden);
  release();
  await c.ready;
  await settle();
  assert.equal(c.badge.hidden, false);
  assert.equal(c.button.hidden, true);
});

test('destroy() stops the control listening, and a control that left the page unsubscribes itself', async () => {
  const c = control();
  await c.ready;
  assert.equal(c.listeners.size, 1);
  c.destroy();
  assert.equal(c.listeners.size, 0);

  const d = control();
  await d.ready;
  d.container.replaceChildren();
  d.notify();
  assert.equal(d.listeners.size, 0);
});

// The running app: js/picker.js on the fake DOM with a stubbed fetch, as in
// test/contactWiring.test.js.
function boot(idb, srv) {
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
  const fetch = async (input, init) => {
    const url = String(input);
    if (url.startsWith('file:')) return new Response(readFileSync(fileURLToPath(url)));
    if (url === 'src/strings.hi.json') return new Response(read('src/strings.hi.json'));
    const catalogue = catalogueResponse(url);
    if (catalogue) return catalogue;
    if (url === 'config/constituency.json') return new Response(read('config/constituency.json'));
    if (url.startsWith('/sync/')) return srv.handle(url, init);
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
  return { picker, roll, team, restore };
}

test('in the running app, a voter tapped in the roll can be marked and the turnout button shows the count', async () => {
  const srv = await server();
  const idb = createFakeIndexedDB();
  const page = boot(idb, srv);
  try {
    await import('../js/picker.js?turnout=1');
    await waitFor(() => page.team.querySelector('form') !== null);
    const [code, pass] = page.team.querySelectorAll('input');
    code.value = 'candA';
    pass.value = PASS;
    page.team.querySelector('form').dispatchEvent({ type: 'submit', preventDefault() {} });
    await waitFor(() => page.team.hidden === true);
    await pickSeat(page.picker);
    await waitFor(() => page.roll.querySelector('div.roll-row') !== null);

    const row = page.roll.querySelector('div.roll-row');
    const serial = Number(row.querySelector('span.roll-name').textContent.split('.')[0]);
    row.dispatchEvent({ type: 'click' });
    await waitFor(() => {
      const button = page.roll.querySelector('button.seen-voting-mark');
      return button && !button.hidden;
    });
    page.roll.querySelector('button.seen-voting-mark').dispatchEvent({ type: 'click' });
    await waitFor(() => page.roll.querySelector('p.seen-voting-message').textContent === strings.seen_mark_saved);

    // Stored on the device and queued for the team under the voter's mark id.
    assert.deepEqual([...stored(idb, MARKS_STORE).keys()], [`${WARD}:${serial}`]);
    assert.ok(stored(idb, OUTBOX_STORE).has(markRecordId(WARD, serial)));

    page.roll.querySelector('button.turnout-open').dispatchEvent({ type: 'click' });
    await waitFor(() => {
      const screen = page.roll.querySelector('form.turnout-screen');
      return screen && screen.querySelectorAll('p.turnout-value')[1].textContent === '1';
    });
    assert.equal(page.roll.querySelector('form.turnout-screen').querySelectorAll('p.turnout-value')[0].textContent,
      strings['turnout.notEntered']);
  } finally {
    page.restore();
  }
});
