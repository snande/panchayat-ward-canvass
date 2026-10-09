// Entries struck off the roll (struck: true) outside the roll list and the
// voter card: search rows mark them struck off, the seen-voting control offers
// no mark for them, and the SMS tally neither counts a pasted struck-off
// serial nor sends one. All on the fake DOM over in-memory stores.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { webcrypto } from 'node:crypto';

import { createDocument, type } from './helpers/fakeDom.js';
import { createFakeIndexedDB } from './helpers/fakeIndexedDB.js';
import { createSeenVotingStore } from '../src/tally/seenVotingStore.js';
import { createSmsInbox } from '../src/tally/smsInbox.js';
import { encodeTallySms, teamTagFor } from '../src/tally/smsCodec.js';
import { mountRollWithSearch, toVoter } from '../src/ui/rollSearch.js';
import { mountSearchScreen, STRUCK_OFF_LABEL, DEBOUNCE_MS as ROLL_SEARCH_DEBOUNCE_MS } from '../src/ui/searchScreen.js';
import { mountSeenVotingMark } from '../src/ui/seenVotingMark.js';
import { mountSmsTally } from '../src/ui/smsTallyView.js';
import { createVoterSearchScreen, DEBOUNCE_MS, FALLBACK_TEXT } from '../src/ui/voterSearchScreen.js';

const read = (rel) => readFileSync(new URL('../' + rel, import.meta.url), 'utf8');
const strings = JSON.parse(read('src/strings.hi.json'));
const WARD = '17/125/6313/1';
const TEAM = 'candA';
const NUMBER = '+919800000000';
const ENTRIES = [
  { serial: 8, name: 'रमेश कुमार', relative: 'सुरेश', age: 42, gender: 'पुरुष', house: '12', struck: false },
  { serial: 9, name: 'रमेश चंद', relative: 'हरि', age: 61, gender: 'पुरुष', house: '12', struck: true },
  { serial: 10, name: 'रमेश लाल', relative: 'मोहन', age: 33, gender: 'पुरुष', house: '14', struck: true, supplement: 'deletion' },
];
const noContacts = { getContact: async () => null, listConsented: async () => [] };

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitFor(cond, ms = 5000) {
  const until = Date.now() + ms;
  while (!(await cond())) {
    if (Date.now() > until) throw new Error('timed out');
    await sleep(5);
  }
}

function marksStore() {
  return createSeenVotingStore({
    indexedDB: createFakeIndexedDB(), crypto: webcrypto,
    engine: { enqueue: async () => {}, onRemoteRecords: () => () => {} }, log: () => {},
  });
}

test('the search screen lists a struck-off entry struck through, its second line led by the struck-off wording', async () => {
  const doc = createDocument();
  const host = doc.createElement('section');
  doc.body.appendChild(host);
  const screen = createVoterSearchScreen(host, strings, { log: () => {} });
  await screen.setRolls(new Map([[WARD, ENTRIES]]));
  type(screen.input, 'रमेश');
  await sleep(DEBOUNCE_MS + 20);
  assert.equal(screen.state, 'filled');
  const row = (key) => screen.list.children.find((r) => r.getAttribute('data-key') === key);
  const meta = (r) => r.querySelector('span.search-row-meta');

  const live = row('1:8');
  assert.equal(live.querySelector('del'), null);
  assert.equal(live.children[0].tagName, 'SPAN');
  assert.equal(meta(live).children[0].getAttribute('class'), 'search-relative');

  const struck = row('1:9');
  const head = struck.children[0];
  assert.equal(head.tagName, 'DEL', 'serial and name sit in a <del>');
  assert.ok(head.classList.contains('roll-struck') && head.classList.contains('search-row-head'));
  assert.equal(head.querySelector('span.search-serial').textContent, '1/9');
  assert.ok(head.querySelector('span.search-name').querySelector('mark'), 'the match still shows in the struck name');
  assert.equal(meta(struck).children[0].textContent, strings.roll_struck_off);

  assert.equal(meta(row('1:10')).children[0].textContent, strings.supp_deleted);
  assert.equal(FALLBACK_TEXT.roll_struck_off, strings.roll_struck_off);
  assert.equal(FALLBACK_TEXT.supp_deleted, strings.supp_deleted);
  screen.destroy();
});

test('the roll\'s name search strikes through a struck-off voter and says it was struck off', async () => {
  assert.equal(toVoter(ENTRIES[1]).struck, true);
  assert.equal(toVoter(ENTRIES[0]).struck, false);
  assert.equal(STRUCK_OFF_LABEL, strings.roll_struck_off);
  const doc = createDocument();
  const host = doc.createElement('section');
  doc.body.appendChild(host);
  const screen = mountSearchScreen(host, ENTRIES.map(toVoter));
  type(screen.input, 'रमेश');
  await sleep(ROLL_SEARCH_DEBOUNCE_MS + 20);
  const byName = (name) => screen.list.children
    .find((r) => r.querySelector('span.pwc-search__name').textContent === name);
  const live = byName('रमेश कुमार');
  assert.equal(live.querySelector('del'), null);
  assert.ok(!live.textContent.includes(STRUCK_OFF_LABEL));
  const struck = byName('रमेश चंद');
  assert.ok(struck.querySelector('span.pwc-search__name').querySelector('del.roll-struck'));
  assert.equal(struck.querySelector('span.pwc-search__meta').children[0].textContent, STRUCK_OFF_LABEL);
  screen.destroy();
});

test('a struck-off voter gets no seen-voting button, a notice says why, and no mark is recorded', async () => {
  const doc = createDocument();
  const calls = [];
  const marks = {
    getMark: async () => null,
    markSeen: async () => { calls.push('markSeen'); return null; },
    teamCount: async () => 3,
  };
  const view = mountSeenVotingMark(doc.body, strings, {
    marks, wardId: WARD, entry: ENTRIES[1], workerId: () => 'w1', log: () => {},
  });
  assert.equal(view.button.hidden, true, 'no button even while the mark is read');
  await view.ready;
  assert.equal(view.button.hidden, true);
  assert.equal(view.badge.hidden, true);
  assert.equal(view.status.textContent, strings.seen_struck_off);
  assert.equal(view.status.getAttribute('data-tone'), 'info');
  assert.equal(view.countValue.textContent, '3', 'the team count still shows');
  await view.mark();
  view.button.dispatchEvent({ type: 'click' });
  await sleep(10);
  assert.deepEqual(calls, []);

  const live = mountSeenVotingMark(doc.body, strings, {
    marks, wardId: WARD, entry: ENTRIES[0], workerId: () => 'w1', log: () => {},
  });
  await live.ready;
  assert.equal(live.button.hidden, false);
  assert.equal(live.status.textContent, '');
});

test('tapping a struck-off voter in the roll opens no mark button for them', async () => {
  const container = createDocument().createElement('section');
  const marks = marksStore();
  const view = mountRollWithSearch(container, ENTRIES, strings, {
    contacts: noContacts, wardKey: WARD, marks, workerId: async () => 'w1', viewportHeight: 1200,
  });
  const panel = view.openContact(ENTRIES[1]);
  await panel.seenVoting.ready;
  assert.equal(panel.seenVoting.button.hidden, true);
  assert.equal(panel.seenVoting.status.textContent, strings.seen_struck_off);
  assert.equal(await marks.getMark(WARD, 9), null);
  view.destroy();
});

test('a pasted tally SMS naming a struck-off serial is told so and that serial is not counted', async () => {
  const container = createDocument().createElement('section');
  const marks = marksStore();
  const view = mountRollWithSearch(container, ENTRIES, strings, {
    contacts: noContacts, wardKey: WARD, marks, workerId: async () => 'coord', viewportHeight: 1200,
    sms: {
      settings: async () => ({ teamSmsNumber: NUMBER, candidateId: TEAM }),
      inbox: createSmsInbox({ indexedDB: createFakeIndexedDB(), crypto: webcrypto }),
      location: { href: '' },
    },
  });
  const tally = await view.openSmsTally();
  await tally.ready;
  const [message] = encodeTallySms({ teamTag: teamTagFor(TEAM), workerId: 'w1', serials: [8, 9] });
  const form = view.contactHost.querySelector('form.sms-entry-screen');
  type(form.querySelector('textarea.sms-entry-input'), message);
  form.dispatchEvent({ type: 'submit', preventDefault() {} });
  const note = () => view.contactHost.querySelector('p.sms-entry-message');
  await waitFor(() => note().textContent !== '');
  assert.equal(note().textContent, strings['tally.smsEntryOutsideWard']);
  assert.equal(note().getAttribute('data-tone'), 'error');
  assert.ok(await marks.getMark(WARD, 8), 'the live serial is counted');
  assert.equal(await marks.getMark(WARD, 9), null, 'the struck-off serial is not');
  view.destroy();
});

test('the send panel leaves out this worker\'s marks on serials struck off the roll', async () => {
  const marks = marksStore();
  await marks.markSeen(WARD, 8, 'w1');
  await marks.markSeen(WARD, 9, 'w1');
  const view = mountSmsTally(createDocument().createElement('div'), strings, {
    marks, wardId: WARD, workerId: () => 'w1', log: () => {},
    settings: async () => ({ teamSmsNumber: NUMBER, candidateId: TEAM }),
    inbox: createSmsInbox({ indexedDB: createFakeIndexedDB(), crypto: webcrypto }),
    inRoll: (serial) => serial === 8,
  });
  await view.ready;
  await waitFor(() => view.ownValue.textContent === '1');
});
