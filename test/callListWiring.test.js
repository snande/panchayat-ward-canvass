// The call list is reachable from the roll view (issue #70): with consent
// capture on, a call-list button sits above the search box; tapping it lists
// the ward's consented voters with a tel: Call link, a worker can be added,
// and choosing them on a row saves the assignment and shows their name.
// Runs the real stores against the in-memory IndexedDB and the fake DOM.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { webcrypto } from 'node:crypto';

import { createDocument } from './helpers/fakeDom.js';
import { createFakeIndexedDB } from './helpers/fakeIndexedDB.js';
import { createContactStore } from '../src/contacts/contactStore.js';
import { createAssignmentStore } from '../src/calls/assignmentStore.js';
import { createWorkerRoster } from '../src/calls/workerRoster.js';
import { mountRollWithSearch } from '../src/ui/rollSearch.js';
import { mountCallListFlow } from '../src/ui/callListFlow.js';

const read = (rel) => readFileSync(new URL('../' + rel, import.meta.url), 'utf8');
const strings = JSON.parse(read('src/strings.hi.json'));
const WARD = '17/125/6313/1';
const ENTRIES = [
  { serial: 7, name: 'सुनीता देवी', relative: '', age: 40, gender: '', house: '12' },
  { serial: 8, name: 'मोहन लाल', relative: '', age: 52, gender: '', house: '13' },
  { serial: 9, name: 'राजेश', relative: '', age: 30, gender: '', house: '14' },
];

async function waitFor(cond, ms = 4000) {
  const until = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > until) throw new Error('timed out');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function stores() {
  const idb = createFakeIndexedDB();
  const deps = { indexedDB: idb, crypto: webcrypto };
  return {
    contacts: createContactStore({ ...deps, storage: null }),
    assignments: createAssignmentStore(deps),
    roster: createWorkerRoster(deps),
  };
}

function mountView(s) {
  const doc = createDocument();
  return mountRollWithSearch(doc.body, ENTRIES, strings, {
    viewportHeight: 600, requestFrame: () => {}, wardKey: WARD, ...s,
  });
}

const submit = (form) => form.dispatchEvent({ type: 'submit', preventDefault() {} });

test('the roll view shows the call-list button only when consent capture is on', () => {
  const view = mountView(stores());
  assert.equal(view.callListButton.textContent, strings.call_list_open);
  assert.equal(view.root.children[0], view.callListButton);
  view.destroy();

  const doc = createDocument();
  const plain = mountRollWithSearch(doc.body, ENTRIES, strings, { viewportHeight: 600, requestFrame: () => {} });
  assert.equal(plain.callListButton, null);
  assert.equal(plain.root.querySelector('button.call-list-open'), null);
  assert.equal(plain.openCallList(), null);
  plain.destroy();
});

test('assign a consented voter to a new worker and tap Call: name shown, tel: link prefilled', async () => {
  const s = stores();
  await s.contacts.recordConsent(WARD, 8);
  await s.contacts.saveNumber(WARD, 8, '98765 43210');
  await s.contacts.recordConsent(WARD, 9);
  const view = mountView(s);

  view.callListButton.dispatchEvent({ type: 'click' });
  const screen = view.contactHost.querySelector('section.call-list-screen');
  assert.ok(screen);
  await waitFor(() => screen.querySelectorAll('div.call-row').length === 2);
  const names = screen.querySelectorAll('span.call-name').map((n) => n.textContent);
  assert.deepEqual(names, ['8. मोहन लाल', '9. राजेश']);
  const link = screen.querySelector('a.call-btn');
  assert.equal(link.getAttribute('href'), 'tel:9876543210');
  assert.equal(link.textContent, strings.call_action);
  // No number saved yet for 9: a disabled control, not a link.
  assert.equal(screen.querySelectorAll('a.call-btn').length, 1);

  const nameInput = screen.querySelector('input.call-worker-name');
  nameInput.value = 'रमेश';
  submit(screen.querySelector('form.call-worker-form'));
  await waitFor(() => screen.querySelector('select.call-assign')?.children.length === 2);
  assert.equal(nameInput.value, '');
  assert.equal(screen.querySelector('p.contact-message').textContent, strings.call_worker_added);

  const [worker] = await s.roster.listWorkers();
  const select = screen.querySelector('select.call-assign');
  select.value = worker.workerId;
  select.dispatchEvent({ type: 'change' });
  assert.equal(screen.querySelector('span.call-assignee').textContent, 'रमेश');
  await waitFor(() => screen.querySelector('p.contact-message').textContent === strings.call_assigned);
  assert.deepEqual(await s.assignments.loadAssignments(), { 8: worker });

  // Reopening reads the saved assignment back.
  screen.querySelector('button.call-list-close').dispatchEvent({ type: 'click' });
  assert.equal(view.contactHost.querySelector('section'), null);
  const again = view.openCallList();
  await again.ready;
  assert.equal(again.root.querySelector('span.call-assignee').textContent, 'रमेश');
  view.destroy();
});

test('with no consented voter the screen says how to add one', async () => {
  const view = mountView(stores());
  const screen = view.openCallList();
  await screen.ready;
  assert.equal(screen.root.querySelectorAll('div.call-row').length, 0);
  assert.equal(screen.message.textContent, strings.call_list_empty);
  view.destroy();
});

test('a failed read offers a retry; a failed save shows the failure and the stored state', async () => {
  const doc = createDocument();
  let fail = true;
  const assigned = {};
  const screen = mountCallListFlow(doc.body, strings, {
    wardId: WARD,
    entries: ENTRIES,
    contacts: {
      listConsented: async () => {
        if (fail) throw new Error('read failed');
        return [{ wardId: WARD, serial: 7, phone: '9876543210', consentAt: 'x' }];
      },
    },
    assignments: {
      loadAssignments: async () => ({ ...assigned }),
      assignVoter: async () => { throw new Error('disk full'); },
    },
    roster: { listWorkers: async () => [{ workerId: 'w1', workerName: 'सीता' }], addWorker: async () => ({}) },
    log: () => {},
  });
  await screen.ready;
  assert.equal(screen.message.textContent, strings.call_list_failed);
  assert.equal(screen.retryButton.hidden, false);

  fail = false;
  screen.retryButton.dispatchEvent({ type: 'click' });
  await waitFor(() => screen.root.querySelectorAll('div.call-row').length === 1);
  assert.equal(screen.retryButton.hidden, true);

  const select = screen.root.querySelector('select.call-assign');
  select.value = 'w1';
  select.dispatchEvent({ type: 'change' });
  await waitFor(() => screen.message.textContent === strings.call_assign_failed);
  assert.equal(screen.root.querySelector('span.call-assignee').textContent, strings.call_not_assigned);
});

test('the service worker precaches the call-list screen and the worker roster', () => {
  const sw = read('sw.js');
  for (const rel of ['src/ui/callListFlow.js', 'src/calls/workerRoster.js']) assert.ok(sw.includes(`"${rel}"`), rel);
});
