// The ward-roll screen (issue #110): the frame's default screen renders its
// empty, loading, filled and error states from one state field, with shared
// controls only, and src/roll/rollFlow.js drives that field. Runs on the fake
// DOM (test/helpers/fakeDom.js).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { webcrypto } from 'node:crypto';

import { createWardRollScreen, FALLBACK_TEXT, ROLL_STATES } from '../src/ui/wardRollScreen.js';
import { createRollFlow } from '../src/roll/rollFlow.js';
import { RollFetchError } from '../src/roll/fetchRoll.js';
import { createRollStore } from '../src/roll/rollStore.js';
import { mountRollList } from '../src/ui/rollList.js';
import { createDocument } from './helpers/fakeDom.js';
import { createFakeIndexedDB } from './helpers/fakeIndexedDB.js';

const strings = JSON.parse(readFileSync(new URL('../src/strings.hi.json', import.meta.url), 'utf8'));
const ENTRY = { serial: 7, name: 'सुनीता देवी', relative: 'रामलाल', age: 41, gender: 'स्त्री', house: '12' };
const SELECTION = { district: '17', samiti: '125', panchayat: '6313', ward: '1', pdfUrl: 'https://example.invalid/w1.pdf' };
const WARD_KEY = '17/125/6313/1';

// Every class DESIGN.md names as a shared control a native control may carry.
const SHARED_CONTROLS = ['btn-primary', 'btn-secondary', 'btn-quiet', 'btn-quiet-danger', 'btn-danger',
  'field-input', 'field-select', 'picker-select', 'choice-input', 'nav-item'];

function setup(opts = {}) {
  const doc = createDocument();
  const container = doc.createElement('section');
  container.setAttribute('hidden', '');
  const emptyCard = doc.createElement('section');
  doc.body.appendChild(emptyCard);
  doc.body.appendChild(container);
  const seen = [];
  const screen = createWardRollScreen(container, strings, { emptyCard, onState: (s) => seen.push(s), ...opts });
  return { doc, container, emptyCard, screen, seen };
}

function assertSharedControls(root) {
  for (const tag of ['button', 'input', 'select', 'textarea']) {
    for (const node of root.querySelectorAll(tag)) {
      const classes = node.className.split(/\s+/);
      assert.ok(SHARED_CONTROLS.some((c) => classes.includes(c)), `<${tag} class="${node.className}"> has no shared control class`);
    }
  }
}

const notice = (root) => root.querySelector('p.notice');
const memoryStore = (stored = null) => ({
  loadStored: async () => stored,
  encryptAndStore: async (key, entries) => entries,
  lastWardKey: async () => (stored ? WARD_KEY : null),
});

test('the fallback copies match the string table', () => {
  for (const [key, value] of Object.entries(FALLBACK_TEXT)) assert.equal(value, strings[key], key);
});

test('the screen has exactly the four states and rejects any other', () => {
  assert.deepEqual([...ROLL_STATES], ['empty', 'loading', 'filled', 'error']);
  const s = setup();
  assert.equal(s.screen.state, null);
  assert.throws(() => s.screen.setState('done'), TypeError);
});

test('empty: an info notice tells the user to pick a ward, with the "not loaded" card', () => {
  const s = setup();
  s.screen.setState('empty');
  assert.equal(s.screen.state, 'empty');
  assert.equal(s.container.hidden, false);
  assert.equal(s.emptyCard.hidden, false);
  assert.equal(notice(s.container).textContent, strings.roll_pick_ward);
  assert.equal(notice(s.container).getAttribute('data-tone'), 'info');
  assert.equal(s.container.querySelector('div.progress'), null);
  assertSharedControls(s.container);
});

test('loading: a progress bar and a Hindi status line, for opening, download and decode', () => {
  const s = setup();
  s.screen.setState('empty');
  s.screen.setState('loading', { phase: 'open' });
  const progress = s.container.querySelector('div.progress');
  assert.ok(progress, 'progress indicator');
  assert.equal(progress.getAttribute('role'), 'progressbar');
  assert.equal(progress.getAttribute('aria-label'), strings.roll_progress_label);
  assert.ok(progress.querySelector('span.progress-bar'));
  assert.equal(notice(s.container).textContent, strings.roll_opening);
  assert.equal(notice(s.container).getAttribute('data-tone'), 'info');
  assert.equal(notice(s.container).getAttribute('role'), 'status');
  assert.equal(s.emptyCard.hidden, true, 'one state at a time');

  s.screen.setState('loading', { phase: 'download' });
  assert.equal(notice(s.container).textContent, strings.roll_loading);
  s.screen.setState('loading', { phase: 'decode' });
  assert.equal(notice(s.container).textContent, strings.roll_decoding);
  assertSharedControls(s.container);
});

test('filled: entries are list rows showing serial, name, relative, age, gender and house', () => {
  const s = setup();
  const list = s.screen.setState('filled', {
    render: (target) => mountRollList(target, [ENTRY], strings, { viewportHeight: 600, requestFrame: () => {} }),
  });
  assert.equal(s.screen.state, 'filled');
  assert.equal(s.screen.list, list);
  assert.equal(s.emptyCard.hidden, true);
  const rows = s.container.querySelectorAll('div.list-row');
  assert.equal(rows.length, 1);
  const row = rows[0].textContent;
  for (const part of [`${ENTRY.serial}. ${ENTRY.name}`, ENTRY.relative, `${strings.roll_age} ${ENTRY.age}`,
    ENTRY.gender, `${strings.roll_house} ${ENTRY.house}`]) {
    assert.ok(row.includes(part), `row lacks ${part}: ${row}`);
  }
  assert.equal(notice(s.container), null);
  assertSharedControls(s.container);
});

test('error: says what to do and whom to call, with a secondary retry', () => {
  const s = setup();
  let retried = 0;
  s.screen.setState('error', { fetchFailed: true, retry: () => { retried += 1; } });
  const alert = notice(s.container);
  assert.equal(alert.textContent, strings.roll_fetch_failed);
  assert.equal(alert.getAttribute('data-tone'), 'error');
  assert.equal(alert.getAttribute('role'), 'alert');
  assert.equal(s.container.querySelector('p.roll-contact').textContent, strings.roll_error_contact);
  assert.doesNotMatch(s.container.textContent, /\d{6,}/, 'no phone number is made up');
  const retry = s.container.querySelector('button.roll-retry');
  assert.ok(retry.className.split(/\s+/).includes('btn-secondary'));
  assert.equal(retry.getAttribute('type'), 'button');
  assert.equal(retry.textContent, strings.roll_retry);
  retry.dispatchEvent({ type: 'click' });
  assert.equal(retried, 1);
  assertSharedControls(s.container);

  s.screen.setState('error', { fetchFailed: false });
  assert.equal(notice(s.container).textContent, strings.roll_failed);
});

test('error: a support contact from the catalogue replaces the neutral line', () => {
  const s = setup();
  s.screen.setSupport('ब्लॉक कार्यालय से संपर्क करें।');
  s.screen.setState('error', {});
  assert.equal(s.container.querySelector('p.roll-contact').textContent, 'ब्लॉक कार्यालय से संपर्क करें।');
  s.screen.setSupport(undefined);
  s.screen.setState('error', {});
  assert.equal(s.container.querySelector('p.roll-contact').textContent, strings.roll_error_contact);
});

test('leaving the filled state unmounts the list', () => {
  const s = setup();
  let destroyed = 0;
  s.screen.setState('filled', { render: () => ({ destroy: () => { destroyed += 1; } }) });
  s.screen.setState('loading', {});
  assert.equal(destroyed, 1);
  assert.equal(s.screen.list, null);
});

test('rollFlow drives the field: opening, download, decode, then filled', async () => {
  const s = setup();
  const flow = createRollFlow(s.container, strings, {
    screen: s.screen,
    fetchRoll: async () => new ArrayBuffer(8),
    decode: async () => [ENTRY],
    store: memoryStore(),
    mountList: () => ({ destroy() {} }),
    log: () => {},
  });
  s.screen.setState('empty');
  const phases = [];
  const setState = s.screen.setState;
  s.screen.setState = (state, detail) => { phases.push(detail && detail.phase); return setState(state, detail); };
  await flow.open(SELECTION);
  assert.deepEqual(s.seen, ['empty', 'loading', 'loading', 'loading', 'filled']);
  assert.deepEqual(phases.slice(0, 3), ['open', 'download', 'decode']);
  assert.equal(s.screen.state, 'filled');
});

test('a stored ward opens with no "downloading" line: opening, then filled', async () => {
  const s = setup();
  const lines = [];
  const flow = createRollFlow(s.container, strings, {
    screen: s.screen,
    fetchRoll: async () => { throw new Error('no network expected'); },
    store: { ...memoryStore([ENTRY]), loadStored: async () => { lines.push(notice(s.container).textContent); return [ENTRY]; } },
    mountList: () => ({ destroy() {} }),
    log: () => {},
  });
  await flow.open(SELECTION);
  assert.deepEqual(lines, [strings.roll_opening]);
  assert.deepEqual(s.seen, ['loading', 'filled']);
});

test('a failed download is the error state; its retry reaches filled', async () => {
  const s = setup();
  let fail = true;
  const flow = createRollFlow(s.container, strings, {
    screen: s.screen,
    fetchRoll: async () => {
      if (fail) throw new RollFetchError('roll download failed: HTTP 503', { status: 503 });
      return new ArrayBuffer(8);
    },
    decode: async () => [ENTRY],
    store: memoryStore(),
    mountList: () => ({ destroy() {} }),
    log: () => {},
  });
  await flow.open(SELECTION);
  assert.deepEqual(s.seen, ['loading', 'loading', 'error']);
  assert.equal(notice(s.container).textContent, strings.roll_fetch_failed);

  fail = false;
  s.container.querySelector('button.roll-retry').dispatchEvent({ type: 'click' });
  const until = Date.now() + 2000;
  while (s.screen.state !== 'filled' && Date.now() < until) await new Promise((r) => setTimeout(r, 5));
  assert.equal(s.screen.state, 'filled');
});

test('a decode failure is the error state with the generic message', async () => {
  const s = setup();
  const flow = createRollFlow(s.container, strings, {
    screen: s.screen,
    fetchRoll: async () => new ArrayBuffer(8),
    decode: async () => { throw new Error('not a roll'); },
    store: memoryStore(),
    log: () => {},
  });
  await flow.open(SELECTION);
  assert.deepEqual(s.seen, ['loading', 'loading', 'loading', 'error']);
  assert.equal(notice(s.container).textContent, strings.roll_failed);
});

test('restore(): a stored roll takes the screen from empty to filled', async () => {
  const idb = createFakeIndexedDB();
  const store = createRollStore({ indexedDB: idb, crypto: webcrypto });
  await store.encryptAndStore(WARD_KEY, [ENTRY]);
  const s = setup();
  const flow = createRollFlow(s.container, strings, {
    screen: s.screen,
    store,
    fetchRoll: async () => { throw new Error('no network expected'); },
    mountList: (target, entries) => mountRollList(target, entries, strings, { viewportHeight: 600, requestFrame: () => {} }),
    log: () => {},
  });
  s.screen.setState('empty');
  assert.ok(await flow.restore());
  assert.deepEqual(s.seen, ['empty', 'filled']);
  assert.equal(s.emptyCard.hidden, true);
  assert.ok(s.container.querySelector('div.list-row').textContent.includes(ENTRY.name));
});

test('restore(): nothing stored, or a copy that cannot be read, leaves the screen empty with its notice', async () => {
  for (const store of [
    memoryStore(),
    { ...memoryStore([ENTRY]), loadStored: async () => { throw new Error('cannot decrypt'); } },
  ]) {
    const s = setup();
    const flow = createRollFlow(s.container, strings, { screen: s.screen, store, log: () => {} });
    s.screen.setState('empty');
    assert.equal(await flow.restore(), null);
    assert.equal(s.screen.state, 'empty');
    assert.deepEqual(s.seen, ['empty']);
    assert.equal(notice(s.container).textContent, strings.roll_pick_ward);
    assert.equal(s.emptyCard.hidden, false);
  }
});
