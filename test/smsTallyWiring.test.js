// Seen-voting marks wired to the SMS tally fallback (issue #81), run by
// `npm test`. Each phone is its own in-memory IndexedDB with its own team
// join, sync engine, mark store and SMS inbox; every sync request goes to the
// real functions/sync.js handler over an in-memory KV. Workers mark voters by
// tapping through the roll view (src/ui/rollSearch.js) on the fake DOM and
// send them with the SMS tally view it opens; the coordinator pastes those
// SMS into the same view and reads the count off it and the turnout screen.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { webcrypto } from 'node:crypto';

import { createDocument, type } from './helpers/fakeDom.js';
import { createFakeIndexedDB } from './helpers/fakeIndexedDB.js';
import { onRequest as syncOnRequest } from '../functions/sync.js';
import { createSyncEngine } from '../src/sync/syncEngine.js';
import { createTeamAuth } from '../src/sync/teamAuth.js';
import { createSeenVotingStore, markRecordId } from '../src/tally/seenVotingStore.js';
import { createSmsInbox } from '../src/tally/smsInbox.js';
import { decodeTallySms, encodeTallySms, teamTagFor } from '../src/tally/smsCodec.js';
import { applyTallySmsToMarks } from '../src/tally/smsMarks.js';
import { createTurnoutStore } from '../src/tally/turnoutStore.js';
import { mountRollWithSearch } from '../src/ui/rollSearch.js';
import { FALLBACK_TEXT, mountSmsTally } from '../src/ui/smsTallyView.js';
import { FALLBACK_TEXT as ENTRY_FALLBACK } from '../src/ui/smsEntryScreen.js';

const read = (rel) => readFileSync(new URL('../' + rel, import.meta.url), 'utf8');
const strings = JSON.parse(read('src/strings.hi.json'));
const ORIGIN = 'https://canvass.takshavid.com';
const WARD = '17/125/6313/1';
const TEAM = 'candA';
const PASS = 'हमारी टीम';
const NUMBER = '+919800000000';

async function waitFor(cond, ms = 8000) {
  const until = Date.now() + ms;
  while (!(await cond())) {
    if (Date.now() > until) throw new Error('timed out');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function memoryKV() {
  const map = new Map();
  return {
    map,
    async get(key) {
      return map.has(key) ? map.get(key) : null;
    },
    async put(key, value) {
      map.set(key, String(value));
    },
    async list({ prefix = '' } = {}) {
      const names = [...map.keys()].filter((k) => k.startsWith(prefix)).sort();
      return { keys: names.map((name) => ({ name })), list_complete: true };
    },
  };
}

function server() {
  const env = { SYNC_SECRET: 'test-sync-secret', SYNC_KV: memoryKV() };
  const handle = (url, init = {}) => syncOnRequest({ request: new Request(new URL(url, ORIGIN), init), env });
  const markEntries = (candidateId) => [...env.SYNC_KV.map.entries()]
    .filter(([k]) => k.startsWith(`c/${candidateId}/r/`))
    .map(([, v]) => JSON.parse(v))
    .filter((r) => r.id.startsWith('mark:'));
  return { handle, markEntries };
}

function clock(start) {
  let t = Date.parse(start);
  return () => new Date((t += 1000)).toISOString();
}

const ENTRIES = Array.from({ length: 30 }, (_, i) => ({
  serial: i + 1, name: `मतदाता ${i + 1}`, relative: 'पिता', age: 30 + i, gender: 'पु', house: String(i + 1),
}));

const noContacts = {
  getContact: async () => null,
  recordConsent: async () => null,
  saveNumber: async () => null,
  revokeConsent: async () => null,
  listConsented: async () => [],
};

// A phone with the ward roll on screen. state.offline makes every request
// throw like a phone in airplane mode; location is where the SMS app is sent.
function phone(srv, name, start, settings = async () => ({ teamSmsNumber: NUMBER, candidateId: TEAM })) {
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
  const inbox = createSmsInbox({ indexedDB: idb, crypto: webcrypto });
  const location = { href: '' };
  const doc = createDocument();
  const container = doc.createElement('section');
  const view = mountRollWithSearch(container, ENTRIES, strings, {
    contacts: noContacts,
    wardKey: WARD,
    marks,
    turnout: createTurnoutStore({ indexedDB: idb, crypto: webcrypto }),
    workerId: async () => name,
    viewportHeight: 1200,
    sms: { settings, inbox, location },
  });
  return { idb, state, auth, engine, marks, inbox, location, view };
}

const host = (p) => p.view.contactHost;
const q = (p, sel) => host(p).querySelector(sel);

function rowFor(p, serial) {
  return p.view.list.root.querySelectorAll('div.roll-row')
    .find((row) => row.querySelector('span.roll-name').textContent === `${serial}. मतदाता ${serial}`);
}

async function markByTap(p, serial) {
  rowFor(p, serial).dispatchEvent({ type: 'click' });
  await waitFor(() => q(p, 'button.seen-voting-mark') && !q(p, 'button.seen-voting-mark').hidden);
  q(p, 'button.seen-voting-mark').dispatchEvent({ type: 'click' });
  await waitFor(() => q(p, 'p.seen-voting-message').textContent === strings.seen_mark_saved);
}

// The fake DOM takes simple selectors only, so nested lookups are chained.
const countIn = (line) => (line ? line.querySelector('span.seen-voting-count-value').textContent : '');
const wardCount = (p) => countIn(q(p, 'p.sms-tally-ward-count'));
const ownCount = (p) => countIn(q(p, 'p.sms-tally-own-count'));
const figureValue = (p, cls) => q(p, `div.${cls}`).querySelector('p.sms-entry-value').textContent;
const status = (p) => q(p, 'p.sms-tally-status');
const entryMessage = (p) => q(p, 'p.sms-entry-message');

// Tap the SMS tally button; resolves once the view has read its counts.
async function openSms(p) {
  p.view.smsTallyButton.dispatchEvent({ type: 'click' });
  await waitFor(() => q(p, 'div.sms-tally') && /^\d+$/.test(wardCount(p)));
}

// Tap "send by SMS" and return the message the phone's SMS app was given.
function sendBySms(p) {
  q(p, 'button.sms-send-button').dispatchEvent({ type: 'click' });
  const href = p.location.href;
  assert.ok(href.startsWith(`sms:${NUMBER}?body=`), href);
  return decodeURIComponent(href.slice(href.indexOf('?body=') + 6));
}

// Paste an SMS into the coordinator's form and add it.
async function paste(p, message) {
  const form = q(p, 'form.sms-entry-screen');
  setNoticeEmpty(p);
  type(form.querySelector('textarea.sms-entry-input'), message);
  form.dispatchEvent({ type: 'submit', preventDefault() {} });
  await waitFor(() => !form.hasAttribute('aria-busy') && entryMessage(p).textContent !== '');
}
// Clears the form's last message so paste() waits for this add's outcome.
function setNoticeEmpty(p) {
  entryMessage(p).textContent = '';
}

test('one voter marked on two offline phones and sent by SMS counts once, before and after both reconnect', async () => {
  const srv = server();
  const a = phone(srv, 'worker-a', '2026-10-07T10:00:00.000Z');
  const b = phone(srv, 'worker-b', '2026-10-07T10:00:00.500Z');
  const coordinator = phone(srv, 'coord', '2026-10-07T10:00:01.000Z');
  for (const p of [a, b, coordinator]) await p.auth.joinTeam(TEAM, PASS);
  assert.equal(a.view.smsTallyButton.textContent, strings.sms_tally_open);

  // No data signal anywhere: A marks voters 3 and 5, B marks voter 3.
  for (const p of [a, b, coordinator]) p.state.offline = true;
  await markByTap(a, 3);
  await markByTap(a, 5);
  await markByTap(b, 3);

  // Each worker opens the SMS tally and sends their own marks.
  await openSms(a);
  await waitFor(() => ownCount(a) === '2');
  assert.equal(status(a).textContent, '');
  const fromA = sendBySms(a);
  await openSms(b);
  await waitFor(() => ownCount(b) === '1');
  const fromB = sendBySms(b);
  assert.deepEqual(decodeTallySms(fromA, TEAM), { ok: true, workerId: 'worker-a', serials: [3, 5] });
  assert.deepEqual(decodeTallySms(fromB, TEAM), { ok: true, workerId: 'worker-b', serials: [3] });

  // The coordinator pastes both: voter 3 is counted once.
  await openSms(coordinator);
  assert.equal(wardCount(coordinator), '0');
  await paste(coordinator, fromA);
  assert.equal(entryMessage(coordinator).textContent, strings['tally.smsEntryAdded']);
  assert.equal(figureValue(coordinator, 'sms-entry-figure-new'), '2');
  await paste(coordinator, fromB);
  assert.equal(entryMessage(coordinator).textContent, strings['tally.smsEntryNothingNew']);
  assert.equal(figureValue(coordinator, 'sms-entry-figure-duplicate'), '1');
  await waitFor(() => wardCount(coordinator) === '2');
  assert.equal(await coordinator.marks.wardCount(WARD), 2);
  assert.equal((await coordinator.marks.getMark(WARD, 3)).workerId, 'worker-a');

  // Every phone reconnects and syncs; each pulls after all have pushed.
  for (const p of [a, b, coordinator]) p.state.offline = false;
  for (const p of [a, b, coordinator, a, b, coordinator]) assert.equal((await p.engine.syncNow()).status, 'ok');

  // One server entry per voter, and 2 on every phone, the open view included.
  assert.equal(srv.markEntries(TEAM).length, 2);
  assert.equal(srv.markEntries(TEAM).filter((r) => r.id === markRecordId(WARD, 3)).length, 1);
  assert.equal(wardCount(coordinator), '2');
  for (const p of [a, b, coordinator]) assert.equal(await p.marks.wardCount(WARD), 2);
  await waitFor(() => wardCount(b) === '2');

  // The turnout screen's supporter count is the same de-duplicated figure.
  coordinator.view.turnoutButton.dispatchEvent({ type: 'click' });
  await waitFor(() => q(coordinator, 'form.turnout-screen').querySelectorAll('p.turnout-value')[1].textContent === '2');
});

test('pasting the same SMS again changes nothing', async () => {
  const srv = server();
  const c = phone(srv, 'coord', '2026-10-07T10:00:00.000Z');
  const [message] = encodeTallySms({ teamTag: TEAM, workerId: 'w1', serials: [1, 2, 4] });
  await openSms(c);
  await paste(c, message);
  await waitFor(() => wardCount(c) === '3');
  await paste(c, message);
  assert.equal(entryMessage(c).textContent, strings['tally.smsEntryNothingNew']);
  assert.equal(figureValue(c, 'sms-entry-figure-new'), '0');
  assert.equal(figureValue(c, 'sms-entry-figure-duplicate'), '3');
  assert.equal(wardCount(c), '3');
});

test('serials that are not in this ward\'s roll are not counted, and the pasted text stays', async () => {
  const srv = server();
  const c = phone(srv, 'coord', '2026-10-07T10:00:00.000Z');
  const [message] = encodeTallySms({ teamTag: TEAM, workerId: 'w1', serials: [2, 99] });
  await openSms(c);
  await paste(c, message);
  assert.equal(entryMessage(c).textContent, strings['tally.smsEntryOutsideWard']);
  assert.equal(entryMessage(c).getAttribute('data-tone'), 'error');
  assert.equal(q(c, 'textarea.sms-entry-input').value, message);
  await waitFor(() => wardCount(c) === '1');
  assert.equal(await c.marks.getMark(WARD, 99), null);
});

test('a rejected SMS marks nothing', async () => {
  const srv = server();
  const c = phone(srv, 'coord', '2026-10-07T10:00:00.000Z');
  const [other] = encodeTallySms({ teamTag: 'cand-99', workerId: 'w1', serials: [2] });
  await openSms(c);
  await paste(c, other);
  assert.equal(entryMessage(c).textContent, strings['tally.smsEntryRejectedTeam']);
  assert.equal(await c.marks.wardCount(WARD), 0);
});

test('with no marks of its own the send panel says how to make one and hides the button', async () => {
  const srv = server();
  const a = phone(srv, 'worker-a', '2026-10-07T10:00:00.000Z');
  await a.marks.markSeen(WARD, 4, 'someone-else');
  await openSms(a);
  await waitFor(() => status(a).textContent === strings['tally.sendEmpty']);
  assert.equal(status(a).getAttribute('data-tone'), 'info');
  assert.equal(q(a, 'div.sms-tally-send-host').hidden, true);
  assert.equal(wardCount(a), '1');

  // A mark made while the view is open brings the button.
  await a.marks.markSeen(WARD, 6, 'worker-a');
  await waitFor(() => !q(a, 'div.sms-tally-send-host').hidden);
  assert.equal(ownCount(a), '1');
  assert.equal(status(a).textContent, '');
});

test('without a team both panels say so and nothing can be sent or added', async () => {
  const srv = server();
  const a = phone(srv, 'worker-a', '2026-10-07T10:00:00.000Z', async () => ({ teamSmsNumber: NUMBER, candidateId: '' }));
  await a.marks.markSeen(WARD, 4, 'worker-a');
  await openSms(a);
  await waitFor(() => status(a).textContent === strings['tally.sendTeamMissing']);
  assert.equal(status(a).getAttribute('data-tone'), 'error');
  assert.equal(q(a, 'div.sms-tally-send-host').hidden, true);
  assert.ok(q(a, 'textarea.sms-entry-input').hasAttribute('disabled'));
});

test('settings that cannot be read show an error with a retry that recovers', async () => {
  const doc = createDocument();
  const container = doc.createElement('div');
  let fail = true;
  const marks = createSeenVotingStore({
    indexedDB: createFakeIndexedDB(), crypto: webcrypto,
    engine: { enqueue: async () => {}, onRemoteRecords: () => () => {} }, log: () => {},
  });
  await marks.markSeen(WARD, 2, 'w1');
  const view = mountSmsTally(container, strings, {
    marks, wardId: WARD, workerId: () => 'w1', log: () => {},
    settings: async () => {
      if (fail) throw new Error('db closed');
      return { teamSmsNumber: NUMBER, candidateId: TEAM };
    },
  });
  assert.equal(view.status.textContent, strings['tally.sendLoading']);
  await view.ready;
  assert.equal(view.status.textContent, strings['tally.sendReadFailed']);
  assert.equal(view.retryButton.hidden, false);
  fail = false;
  view.retryButton.dispatchEvent({ type: 'click' });
  await waitFor(() => view.wardValue.textContent === '1');
  await waitFor(() => view.ownValue.textContent === '1');
  assert.equal(view.retryButton.hidden, true);
  assert.ok(view.entry);
});

test('a view opened after the SMS tally was tapped is not replaced by it', async () => {
  const srv = server();
  const a = phone(srv, 'worker-a', '2026-10-07T10:00:00.000Z');
  const opening = a.view.openSmsTally();
  const panel = a.view.openContact(ENTRIES[1]);
  assert.equal(await opening, null);
  assert.ok(host(a).querySelector('section.contact-panel'));
  assert.equal(q(a, 'div.sms-tally'), null);
  assert.ok(panel);
});

test('applyTallySmsToMarks reports new, already counted and outside serials', async () => {
  const recorded = [];
  const outcome = await applyTallySmsToMarks('pasted', {
    teamTag: TEAM,
    wardId: WARD,
    inRoll: (serial) => serial < 10,
    inbox: { applyTallySms: async () => ({ ok: true, workerId: 'w7', newSerials: [12, 3], duplicateSerials: [5] }) },
    marks: {
      recordSeen: async (wardId, serial, workerId) => {
        recorded.push([wardId, serial, workerId]);
        return { added: serial === 3 };
      },
    },
  });
  assert.deepEqual(outcome, { ok: true, workerId: 'w7', newSerials: [3], duplicateSerials: [5], outsideSerials: [12] });
  assert.deepEqual(recorded, [[WARD, 3, 'w7'], [WARD, 5, 'w7']]);

  const rejected = await applyTallySmsToMarks('x', {
    teamTag: TEAM, wardId: WARD,
    inbox: { applyTallySms: async () => ({ ok: false, reason: 'checksum', workerId: null, newSerials: [], duplicateSerials: [] }) },
    marks: { recordSeen: async () => assert.fail('nothing is marked') },
  });
  assert.equal(rejected.ok, false);
  assert.equal(rejected.reason, 'checksum');
});

test('teamTagFor keeps a short candidate code and shortens a long one the same way on every phone', () => {
  assert.equal(teamTagFor('candA'), 'candA');
  assert.equal(teamTagFor(' candA '), 'candA');
  assert.equal(teamTagFor(''), '');
  assert.equal(teamTagFor(undefined), '');
  const long = 'candidate-of-badli-ward-one';
  assert.match(teamTagFor(long), /^[0-9a-f]{16}$/);
  assert.equal(teamTagFor(long), teamTagFor(long));
  const [message] = encodeTallySms({ teamTag: teamTagFor(long), workerId: 'w1', serials: [1] });
  assert.equal(decodeTallySms(message, teamTagFor(long)).ok, true);
});

test('fallback copies match src/strings.hi.json, and the new strings are Hindi', () => {
  for (const [key, value] of Object.entries(FALLBACK_TEXT)) assert.equal(value, strings[key], key);
  assert.equal(ENTRY_FALLBACK['tally.smsEntryOutsideWard'], strings['tally.smsEntryOutsideWard']);
  assert.match(strings.sms_tally_open, /[ऀ-ॿ]/);
});

test('the SMS tally modules are precached, so the view opens offline', () => {
  const sw = read('sw.js');
  for (const file of ['src/tally/smsMarks.js', 'src/ui/smsTallyView.js', 'src/tally/smsCodec.js', 'src/tally/smsInbox.js']) {
    assert.ok(sw.includes(`"${file}"`), file);
  }
});
