// Voter card (issue #42): consent gates the phone field. Runs on the fake DOM
// over the real encrypted contact store and an in-memory IndexedDB.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { webcrypto } from 'node:crypto';

import { mountVoterCard } from '../src/ui/voterCard.js';
import { mountRollWithSearch } from '../src/ui/rollSearch.js';
import { createContactStore } from '../src/contacts/contactStore.js';
import { createDocument, type } from './helpers/fakeDom.js';
import { createFakeIndexedDB } from './helpers/fakeIndexedDB.js';

const strings = JSON.parse(readFileSync(new URL('../src/strings.hi.json', import.meta.url), 'utf8'));
const WARD = '17/125/6313/1';
const ENTRY = { serial: 7, name: 'सुनीता देवी', relative: 'रामलाल', age: 41, gender: 'स्त्री', house: '12' };

async function waitFor(cond, ms = 5000) {
  const until = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > until) throw new Error('timed out');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

const idb = () => createFakeIndexedDB();
const storeOver = (indexedDB) => createContactStore({ indexedDB, crypto: webcrypto, storage: null });

async function open(contacts) {
  const doc = createDocument();
  const card = mountVoterCard(doc.body, strings, { contacts, wardId: WARD, entry: ENTRY, log: () => {} });
  await card.ready;
  return card;
}

const check = (card, value) => {
  card.consentInput.checked = value;
  card.consentInput.dispatchEvent({ type: 'change' });
};
const submit = (card) => card.saveButton.parentNode.dispatchEvent({ type: 'submit', preventDefault() {} });

test('shows voter details and keeps the number locked until consent is marked', async () => {
  const card = await open(storeOver(idb()));
  const text = card.root.textContent;
  for (const part of ['सुनीता देवी', 'रामलाल', '41', '12']) assert.ok(text.includes(part), part);
  assert.equal(card.consentInput.checked, false);
  assert.equal(card.phoneInput.hasAttribute('disabled'), true);
  assert.equal(card.saveButton.hasAttribute('disabled'), true);
});

test('consent is recorded before the field unlocks; save and reopen shows both', async () => {
  const indexedDB = idb();
  const contacts = storeOver(indexedDB);
  const calls = [];
  const spy = {
    ...contacts,
    getContact: (...a) => contacts.getContact(...a),
    recordConsent: async (...a) => {
      calls.push('record');
      assert.equal(card.phoneInput.hasAttribute('disabled'), true);
      return contacts.recordConsent(...a);
    },
    saveNumber: (...a) => { calls.push('save'); return contacts.saveNumber(...a); },
  };
  const card = await open(spy);
  check(card, true);
  await waitFor(() => !card.phoneInput.hasAttribute('disabled'));
  assert.equal(card.saveButton.hasAttribute('disabled'), false);
  type(card.phoneInput, '98765 43210');
  submit(card);
  await waitFor(() => card.message.textContent === strings.contact_saved);
  assert.deepEqual(calls, ['record', 'save']);

  const again = await open(storeOver(indexedDB));
  assert.equal(again.consentInput.checked, true);
  assert.equal(again.phoneInput.value, '9876543210');
  assert.equal(again.phoneInput.hasAttribute('disabled'), false);
});

test('an invalid number shows the Hindi error and saves nothing', async () => {
  const contacts = storeOver(idb());
  const card = await open(contacts);
  check(card, true);
  await waitFor(() => !card.phoneInput.hasAttribute('disabled'));
  type(card.phoneInput, '12345');
  submit(card);
  assert.equal(card.message.textContent, strings.contact_phone_invalid);
  assert.equal((await contacts.getContact(WARD, 7)).phone, null);
});

test('unmarking consent revokes, clears the number and locks the field', async () => {
  const contacts = storeOver(idb());
  await contacts.recordConsent(WARD, 7);
  await contacts.saveNumber(WARD, 7, '9876543210');
  const card = await open(contacts);
  assert.equal(card.phoneInput.value, '9876543210');
  check(card, false);
  await waitFor(() => card.message.textContent === strings.contact_revoked);
  assert.equal(card.phoneInput.value, '');
  assert.equal(card.phoneInput.hasAttribute('disabled'), true);
  assert.equal(card.saveButton.hasAttribute('disabled'), true);
  assert.equal(await contacts.getContact(WARD, 7), null);
});

test('no fetch call on open, consent or save', async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = () => { throw new Error('network used'); };
  try {
    const card = await open(storeOver(idb()));
    check(card, true);
    await waitFor(() => !card.phoneInput.hasAttribute('disabled'));
    type(card.phoneInput, '9876543210');
    submit(card);
    await waitFor(() => card.message.textContent === strings.contact_saved);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('selecting a search result opens the voter card', async () => {
  const doc = createDocument();
  const view = mountRollWithSearch(doc.body, [ENTRY], strings, {
    viewportHeight: 600, requestFrame: () => {}, contacts: storeOver(idb()), wardKey: WARD,
  });
  type(view.search.input, 'सुनीता');
  await waitFor(() => view.search.list.querySelectorAll('li').length === 1);
  view.search.list.querySelector('li').dispatchEvent({ type: 'click' });
  assert.ok(view.contactHost.querySelector('section.voter-card'));
  assert.equal(view.contactHost.querySelector('h2').textContent, 'सुनीता देवी');
  view.destroy();
});
