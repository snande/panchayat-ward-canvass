// Consent-first phone capture panel (issue #44), run by `npm test` on the
// in-process fake DOM (test/helpers/fakeDom.js) over the real encrypted
// contact store and an in-memory IndexedDB.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { webcrypto } from 'node:crypto';

import { mountContactPanel } from '../src/ui/contactPanel.js';
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

const newStore = () => createContactStore({ indexedDB: createFakeIndexedDB(), crypto: webcrypto, storage: null });

function mount(contacts = newStore()) {
  const doc = createDocument();
  const panel = mountContactPanel(doc.body, strings, { contacts, wardId: WARD, entry: ENTRY, log: () => {} });
  return { doc, panel, contacts };
}

const form = (panel) => panel.saveButton.parentNode;
const submit = (panel) => form(panel).dispatchEvent({ type: 'submit', preventDefault() {} });

async function withSavedNumber() {
  const contacts = newStore();
  await contacts.recordConsent(WARD, 7);
  await contacts.saveNumber(WARD, 7, '9876543210');
  const { panel } = mount(contacts);
  await panel.ready;
  return { contacts, panel };
}

test('without consent only the consent button shows; the number form follows it', async () => {
  const { panel, contacts } = mount();
  await panel.ready;
  assert.equal(panel.root.querySelector('h2').textContent, '7. सुनीता देवी');
  assert.equal(panel.consentButton.hidden, false);
  assert.equal(form(panel).hidden, true);
  assert.equal(panel.confirmBox.hidden, true);
  assert.equal(panel.message.textContent, '');

  panel.consentButton.dispatchEvent({ type: 'click' });
  await waitFor(() => panel.message.textContent === strings.contact_consent_done);
  assert.equal(panel.consentButton.hidden, true);
  assert.equal(form(panel).hidden, false);
  assert.equal((await contacts.getContact(WARD, 7)).phone, null);

  type(panel.phoneInput, '98765 43210');
  submit(panel);
  await waitFor(() => panel.message.textContent === strings.contact_saved);
  assert.equal((await contacts.getContact(WARD, 7)).phone, '9876543210');
});

test('while the saved state is read neither the consent button nor the form shows', async () => {
  let release;
  const contacts = {
    getContact: () => new Promise((resolve) => { release = resolve; }),
    recordConsent: async () => { throw new Error('must not be called while loading'); },
  };
  const { panel } = mount(contacts);
  assert.equal(panel.message.textContent, strings.contact_loading);
  assert.equal(panel.consentButton.hidden, true);
  assert.equal(form(panel).hidden, true);
  assert.equal(panel.confirmBox.hidden, true);

  await waitFor(() => typeof release === 'function');
  release({ wardId: WARD, serial: 7, phone: '9876543210', consentAt: '2026-10-06T09:00:00.000Z' });
  await panel.ready;
  assert.equal(panel.message.textContent, '');
  assert.equal(panel.consentButton.hidden, true);
  assert.equal(form(panel).hidden, false);
  assert.equal(panel.phoneInput.value, '9876543210');
});

test('a malformed number is refused and kept in the field', async () => {
  const { panel, contacts } = mount();
  await panel.ready;
  panel.consentButton.dispatchEvent({ type: 'click' });
  await waitFor(() => panel.message.textContent === strings.contact_consent_done);
  type(panel.phoneInput, '12345');
  submit(panel);
  assert.equal(panel.message.textContent, strings.contact_phone_invalid);
  assert.equal(panel.phoneInput.value, '12345');
  assert.equal((await contacts.getContact(WARD, 7)).phone, null);
});

test('revoking asks first; "no" keeps the number', async () => {
  const { contacts, panel } = await withSavedNumber();
  assert.equal(panel.consentButton.hidden, true);
  assert.equal(panel.phoneInput.value, '9876543210');

  panel.revokeButton.dispatchEvent({ type: 'click' });
  assert.equal(panel.confirmBox.hidden, false);
  assert.equal(form(panel).hidden, true);
  assert.equal(panel.confirmBox.querySelector('p').textContent, strings.contact_revoke_confirm);
  // Nothing is deleted by the first tap.
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal((await contacts.getContact(WARD, 7)).phone, '9876543210');

  panel.cancelRevokeButton.dispatchEvent({ type: 'click' });
  assert.equal(panel.confirmBox.hidden, true);
  assert.equal(form(panel).hidden, false);
  assert.equal(panel.phoneInput.value, '9876543210');
  assert.equal((await contacts.getContact(WARD, 7)).phone, '9876543210');
});

test('revoking and then confirming deletes the number', async () => {
  const { contacts, panel } = await withSavedNumber();
  panel.revokeButton.dispatchEvent({ type: 'click' });
  panel.confirmRevokeButton.dispatchEvent({ type: 'click' });
  await waitFor(() => panel.message.textContent === strings.contact_revoked);
  assert.equal(await contacts.getContact(WARD, 7), null);
  assert.equal(panel.confirmBox.hidden, true);
  assert.equal(panel.consentButton.hidden, false);
  assert.equal(form(panel).hidden, true);
});

test('a failed save shows the Hindi failure message', async () => {
  const contacts = {
    getContact: async () => ({ wardId: WARD, serial: 7, phone: null, consentAt: 'x' }),
    saveNumber: async () => { throw new Error('disk full'); },
  };
  const { panel } = mount(contacts);
  await panel.ready;
  type(panel.phoneInput, '9876543210');
  submit(panel);
  await waitFor(() => panel.message.textContent === strings.contact_failed);
});

test('tapping a roll row or a search result opens the panel for that voter', async () => {
  const doc = createDocument();
  const contacts = newStore();
  const entries = [ENTRY, { ...ENTRY, serial: 8, name: 'मोहन लाल' }];
  const view = mountRollWithSearch(doc.body, entries, strings, {
    viewportHeight: 600, requestFrame: () => {}, contacts, wardKey: WARD,
  });
  const rows = view.list.viewport.querySelectorAll('div.roll-row');
  assert.equal(rows[1].getAttribute('tabindex'), '0');
  rows[1].dispatchEvent({ type: 'click' });
  assert.equal(view.contactHost.querySelector('h2').textContent, '8. मोहन लाल');

  rows[0].dispatchEvent({ type: 'keydown', key: 'Enter', preventDefault() {} });
  assert.equal(view.contactHost.querySelector('h2').textContent, '7. सुनीता देवी');

  view.contactHost.querySelector('button.contact-close').dispatchEvent({ type: 'click' });
  assert.equal(view.contactHost.querySelector('section'), null);

  type(view.search.input, 'मोहन');
  await waitFor(() => view.search.list.querySelectorAll('li').length === 1);
  view.search.list.querySelector('li').dispatchEvent({ type: 'click' });
  // A search result opens the same contact panel as a row; the voter card is
  // the voter route's alone (src/ui/voterRoute.js).
  assert.ok(view.contactHost.querySelector('section.contact-panel'));
  assert.equal(view.contactHost.querySelector('h2').textContent, '8. मोहन लाल');
  view.destroy();
});

test('without a contact store the roll rows are not tappable', () => {
  const doc = createDocument();
  const view = mountRollWithSearch(doc.body, [ENTRY], strings, { viewportHeight: 600, requestFrame: () => {} });
  const row = view.list.viewport.querySelector('div.roll-row');
  assert.equal(row.getAttribute('tabindex'), null);
  row.dispatchEvent({ type: 'click' });
  assert.equal(view.contactHost.querySelector('section'), null);
  view.destroy();
});
