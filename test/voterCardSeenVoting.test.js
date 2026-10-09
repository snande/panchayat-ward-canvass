// The "seen voting" action and the live team count: a voter found by search
// is marked from the contact panel the result opens, which then shows the
// marked badge, and the count line follows the mark store (this phone's marks and
// teammates' marks from a pull). Runs on the fake DOM over the real encrypted
// mark store and an in-memory IndexedDB, with a scripted sync engine.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { webcrypto } from 'node:crypto';

import { createContactStore } from '../src/contacts/contactStore.js';
import { createSeenVotingStore, markRecordId } from '../src/tally/seenVotingStore.js';
import { mountRollWithSearch } from '../src/ui/rollSearch.js';
import { mountSeenVotingMark } from '../src/ui/seenVotingMark.js';
import { createDocument, type } from './helpers/fakeDom.js';
import { createFakeIndexedDB } from './helpers/fakeIndexedDB.js';

const read = (rel) => readFileSync(new URL('../' + rel, import.meta.url), 'utf8');
const strings = JSON.parse(read('src/strings.hi.json'));
const WARD = '17/125/6313/1';
const ENTRIES = [
  { serial: 7, name: 'सुनीता देवी', relative: 'रामलाल', age: 41, gender: 'स्त्री', house: '12' },
  { serial: 9, name: 'मोहन लाल', relative: 'श्याम लाल', age: 52, gender: 'पु', house: '14' },
];

async function waitFor(cond, ms = 5000) {
  const until = Date.now() + ms;
  while (!(await cond())) {
    if (Date.now() > until) throw new Error('timed out');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

const click = (node) => node.dispatchEvent({ type: 'click' });

// A sync engine that never touches the network: enqueue keeps the record,
// pull(records) hands records to the subscribers as a finished pull would.
function scriptedEngine() {
  const queued = [];
  const subscribers = new Set();
  return {
    queued,
    enqueue: async (record) => { queued.push(record); },
    onRemoteRecords: (cb) => { subscribers.add(cb); return () => subscribers.delete(cb); },
    pull: (records) => Promise.all([...subscribers].map((cb) => cb(records))),
  };
}

function phone() {
  const indexedDB = createFakeIndexedDB();
  const engine = scriptedEngine();
  const marks = createSeenVotingStore({ indexedDB, crypto: webcrypto, engine, log: () => {} });
  marks.listen();
  const contacts = createContactStore({ indexedDB, crypto: webcrypto, storage: null });
  const doc = createDocument();
  const view = mountRollWithSearch(doc.body, ENTRIES, strings, {
    viewportHeight: 600, requestFrame: () => {}, contacts, wardKey: WARD, marks, workerId: async () => 'worker-a',
  });
  return { engine, marks, view };
}

// Search for the voter and open their contact panel from the result.
async function openFromSearch(view, query) {
  type(view.search.input, query);
  await waitFor(() => view.search.list.querySelectorAll('li').length === 1);
  click(view.search.list.querySelector('li'));
  const panel = view.contactHost.querySelector('section.contact-panel');
  assert.ok(panel, 'the contact panel opens');
  const control = view.contactHost.querySelector('section.seen-voting');
  assert.ok(control, 'the panel carries the seen-voting control');
  return control;
}

const parts = (control) => ({
  button: control.querySelector('button.seen-voting-mark'),
  badge: control.querySelector('p.seen-voting-badge'),
  count: control.querySelector('span.seen-voting-count-value'),
  message: control.querySelector('p.seen-voting-message'),
});

test('the panel from a search result offers "मतदान किया" and shows the team count', async () => {
  const { view } = phone();
  const control = await openFromSearch(view, 'सुनीता');
  const { button, badge, count } = parts(control);
  await waitFor(() => !button.hidden && count.textContent === '0');
  assert.equal(button.textContent, strings.seen_mark_action);
  assert.equal(strings.seen_mark_action, 'मतदान किया');
  assert.equal(button.getAttribute('type'), 'button');
  assert.equal(badge.hidden, true);
  assert.equal(control.querySelector('span.seen-voting-count-label').textContent, strings.seen_team_count_label);
  view.destroy();
});

test('marking a found voter twice makes one mark, shows "चिह्नित" and raises the count by exactly one', async () => {
  const { engine, marks, view } = phone();
  const realFetch = globalThis.fetch;
  let fetched = 0;
  globalThis.fetch = async () => { fetched += 1; throw new Error('offline'); };
  try {
    const control = await openFromSearch(view, 'सुनीता');
    const { button, badge, count, message } = parts(control);
    await waitFor(() => !button.hidden && count.textContent === '0');
    const before = Number(count.textContent);

    click(button);
    await waitFor(() => message.textContent === strings.seen_mark_saved);
    // Marked: the badge replaces the button.
    assert.equal(button.hidden, true);
    assert.equal(badge.hidden, false);
    assert.equal(badge.textContent, strings.seen_marked);
    assert.equal(strings.seen_marked, 'चिह्नित');
    assert.equal(badge.getAttribute('data-tone'), 'success');
    await waitFor(() => count.textContent === String(before + 1));

    // A second tap, even straight on the hidden button, adds nothing.
    click(button);
    await view.openContact(ENTRIES[0]).seenVoting.mark();
    const again = parts(view.contactHost.querySelector('section.seen-voting'));
    await waitFor(() => again.badge.hidden === false && again.count.textContent === String(before + 1));
    assert.equal(await marks.teamCount(), 1);
    assert.deepEqual((await marks.listMarks()).map((m) => [m.wardId, m.serial, m.workerId]), [[WARD, 7, 'worker-a']]);
    assert.deepEqual(engine.queued.map((r) => r.id), [markRecordId(WARD, 7)]);
    // Everything happened on the device.
    assert.equal(fetched, 0);
  } finally {
    globalThis.fetch = realFetch;
    view.destroy();
  }
});

test('the count follows a sync pull that brings teammates\' marks, and a pulled voter shows as marked', async () => {
  const { engine, view } = phone();
  const control = await openFromSearch(view, 'सुनीता');
  const { button, count } = parts(control);
  await waitFor(() => !button.hidden && count.textContent === '0');

  click(button);
  await waitFor(() => count.textContent === '1');

  const mark = (serial, workerId) => ({
    id: markRecordId(WARD, serial), updatedAt: '2026-10-07T10:00:00.000Z',
    data: { wardId: WARD, serial, workerId, markedAt: '2026-10-07T10:00:00.000Z' },
  });
  // A teammate marked voter 9 and, on their own phone, voter 7 as well.
  await engine.pull([mark(9, 'worker-b'), mark(7, 'worker-b')]);
  await waitFor(() => count.textContent === '2');

  const other = await openFromSearch(view, 'मोहन');
  const next = parts(other);
  await waitFor(() => next.badge.hidden === false && next.count.textContent === '2');
  assert.equal(next.button.hidden, true);
  // Pulling the same marks again changes nothing.
  await engine.pull([mark(9, 'worker-b')]);
  assert.equal(next.count.textContent, '2');
  view.destroy();
});

// The control against a scripted store, to pin what it asks of it.
function control(overrides = {}) {
  const doc = createDocument();
  const calls = [];
  const listeners = new Set();
  const marks = {
    getMark: async () => null,
    markSeen: async (wardId, serial, workerId) => {
      calls.push([wardId, serial, workerId]);
      return { wardId, serial, workerId, markedAt: 't' };
    },
    teamCount: async () => calls.length,
    onMarksChanged: (cb) => { listeners.add(cb); return () => listeners.delete(cb); },
    ...overrides,
  };
  const view = mountSeenVotingMark(doc.body, strings, {
    marks, wardId: WARD, entry: { serial: 7 }, workerId: () => 'worker-a', log: () => {},
  });
  return { ...view, calls, notify: () => [...listeners].forEach((cb) => cb()) };
}

test('tapping the button calls markSeen with the voter\'s ward and serial', async () => {
  const c = control();
  await c.ready;
  click(c.button);
  await waitFor(() => c.calls.length === 1 && !c.badge.hidden);
  assert.deepEqual(c.calls, [[WARD, 7, 'worker-a']]);
});

test('the count shows a placeholder while counting and says so when it cannot be read', async () => {
  let release;
  const c = control({ teamCount: () => new Promise((resolve) => { release = resolve; }) });
  assert.equal(c.countValue.textContent, strings.seen_team_count_loading);
  assert.ok(c.countValue.className.includes('seen-voting-count-pending'));
  release(4);
  await c.ready;
  assert.equal(c.countValue.textContent, '4');
  assert.ok(!c.countValue.className.includes('seen-voting-count-pending'));

  const failed = control({ teamCount: async () => { throw new Error('locked'); } });
  await failed.ready;
  assert.equal(failed.countValue.textContent, strings.seen_team_count_failed);
  assert.ok(failed.countValue.className.includes('seen-voting-count-pending'));
});

test('without teamCount the control has no count line', async () => {
  const c = control({ teamCount: undefined });
  await c.ready;
  assert.equal(c.count, null);
  assert.equal(c.root.querySelector('p.seen-voting-count'), null);
});

test('every text the control shows comes from the strings table', async () => {
  const c = control();
  await c.ready;
  click(c.button);
  await waitFor(() => !c.badge.hidden && c.countValue.textContent === '1');
  const values = new Set(Object.values(strings));
  const leaves = [];
  (function walk(node) {
    if (node.childNodes.length === 0) {
      if (node.textContent) leaves.push(node.textContent);
      return;
    }
    for (const child of node.childNodes) walk(child);
  })(c.root);
  assert.ok(leaves.length >= 4);
  for (const leaf of leaves) assert.ok(values.has(leaf) || /^\d+$/.test(leaf), leaf);

  const source = read('src/ui/seenVotingMark.js').replace(/^\s*\/\/.*$/gm, '');
  assert.doesNotMatch(source, /[ऀ-ॿ]/);
});

test('the control\'s styles use tokens only and load no other asset', () => {
  const css = read('styles.css');
  for (const selector of ['.seen-voting-badge', '.seen-voting-count', '.seen-voting-count-value', '.seen-voting-count-pending']) {
    const m = css.match(new RegExp(`\\n${selector.replace(/[.-]/g, '\\$&')}\\s*\\{([^}]*)\\}`));
    assert.ok(m, selector);
    assert.doesNotMatch(m[1], /#[0-9a-f]{3,8}\b|rgb|url\(|\d+px(?!\s+solid)/i, selector);
  }
});
