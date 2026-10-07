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
const click = (node) => node.dispatchEvent({ type: 'click' });
const submit = (card) => card.saveButton.parentNode.dispatchEvent({ type: 'submit', preventDefault() {} });
const locked = (card) => card.phoneInput.hasAttribute('disabled') && card.saveButton.hasAttribute('disabled');

async function withNumber(indexedDB) {
  const contacts = storeOver(indexedDB);
  await contacts.recordConsent(WARD, 7);
  await contacts.saveNumber(WARD, 7, '9876543210');
  return contacts;
}

test('shows voter details and keeps the number locked until consent is marked', async () => {
  const card = await open(storeOver(idb()));
  const text = card.root.textContent;
  for (const part of ['सुनीता देवी', 'रामलाल', '41', '12']) assert.ok(text.includes(part), part);
  assert.equal(card.consentInput.checked, false);
  assert.equal(locked(card), true);
});

test('consent is recorded before the field unlocks; save and reopen shows both', async () => {
  const indexedDB = idb();
  const contacts = storeOver(indexedDB);
  const calls = [];
  const spy = {
    getContact: (...a) => contacts.getContact(...a),
    recordConsent: async (...a) => {
      calls.push('record');
      assert.equal(locked(card), true);
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

test('a +91 or 0 prefixed number is saved as its 10 digits', async () => {
  const contacts = storeOver(idb());
  const card = await open(contacts);
  check(card, true);
  await waitFor(() => !card.phoneInput.hasAttribute('disabled'));
  type(card.phoneInput, '+91 98765 43210');
  submit(card);
  await waitFor(() => card.message.textContent === strings.contact_saved);
  assert.equal((await contacts.getContact(WARD, 7)).phone, '9876543210');
  assert.equal(card.phoneInput.value, '9876543210');
  type(card.phoneInput, '09123456789');
  submit(card);
  await waitFor(() => card.phoneInput.value === '9123456789');
});

test('unmarking asks first; "no" keeps the consent and the number', async () => {
  const indexedDB = idb();
  const contacts = await withNumber(indexedDB);
  let revoked = 0;
  const card = await open({ ...contacts, getContact: (...a) => contacts.getContact(...a), revokeConsent: async () => { revoked += 1; } });
  check(card, false);
  assert.equal(card.confirmBox.hidden, false);
  assert.equal(card.consentInput.checked, true);
  assert.equal(card.phoneInput.value, '9876543210');
  assert.equal(revoked, 0);
  click(card.cancelRevokeButton);
  assert.equal(card.confirmBox.hidden, true);
  assert.equal(revoked, 0);
  assert.equal(locked(card), false);
});

test('confirming revoke clears the number, locks the field and survives a reopen', async () => {
  const indexedDB = idb();
  const contacts = await withNumber(indexedDB);
  const card = await open(contacts);
  assert.equal(card.phoneInput.value, '9876543210');
  check(card, false);
  click(card.confirmRevokeButton);
  await waitFor(() => card.message.textContent === strings.contact_revoked);
  assert.equal(card.consentInput.checked, false);
  assert.equal(card.phoneInput.value, '');
  assert.equal(locked(card), true);
  assert.equal(await contacts.getContact(WARD, 7), null);

  const again = await open(storeOver(indexedDB));
  assert.equal(again.consentInput.checked, false);
  assert.equal(again.phoneInput.value, '');
  assert.equal(locked(again), true);
});

test('a failed recordConsent leaves the box off and the field locked', async () => {
  const contacts = storeOver(idb());
  const card = await open({
    getContact: (...a) => contacts.getContact(...a),
    recordConsent: async () => { throw new Error('disk full'); },
  });
  check(card, true);
  await waitFor(() => card.message.textContent === strings.contact_failed);
  assert.equal(card.consentInput.checked, false);
  assert.equal(locked(card), true);
});

test('a failed revokeConsent keeps the stored consent and number on the card', async () => {
  const contacts = await withNumber(idb());
  const card = await open({
    getContact: (...a) => contacts.getContact(...a),
    revokeConsent: async () => { throw new Error('disk full'); },
  });
  check(card, false);
  click(card.confirmRevokeButton);
  await waitFor(() => card.message.textContent === strings.contact_failed);
  assert.equal(card.consentInput.checked, true);
  assert.equal(card.phoneInput.value, '9876543210');
  assert.equal(locked(card), false);
  assert.equal(card.confirmBox.hidden, true);
});

test('a failed first read keeps the card locked and a retry loads it', async () => {
  const contacts = await withNumber(idb());
  let fail = true;
  const card = await open({
    getContact: (...a) => { if (fail) return Promise.reject(new Error('unreadable')); return contacts.getContact(...a); },
  });
  assert.equal(card.message.textContent, strings.contact_failed);
  assert.equal(card.retryButton.hidden, false);
  assert.equal(card.consentInput.hasAttribute('disabled'), true);
  assert.equal(locked(card), true);

  fail = false;
  click(card.retryButton);
  await waitFor(() => card.retryButton.hidden && card.message.textContent === '');
  assert.equal(card.consentInput.checked, true);
  assert.equal(card.phoneInput.value, '9876543210');
  assert.equal(card.consentInput.hasAttribute('disabled'), false);
});

test('a second change while consent is being recorded is ignored', async () => {
  const contacts = storeOver(idb());
  let release;
  let records = 0;
  const card = await open({
    getContact: (...a) => contacts.getContact(...a),
    recordConsent: (...a) => { records += 1; return new Promise((resolve) => { release = () => resolve(contacts.recordConsent(...a)); }); },
  });
  check(card, true);
  check(card, false);
  assert.equal(card.consentInput.checked, true);
  assert.equal(card.confirmBox.hidden, true);
  release();
  await waitFor(() => !card.phoneInput.hasAttribute('disabled'));
  assert.equal(records, 1);
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
