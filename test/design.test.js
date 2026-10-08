// The number recording panels follow DESIGN.md: shared panel header with the
// close action, consent badge, toned notices, a quiet revoke and a red
// confirm. Also checks DESIGN.md and styles.css agree on tokens and controls.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { webcrypto } from 'node:crypto';

import { mountContactPanel } from '../src/ui/contactPanel.js';
import { mountVoterCard } from '../src/ui/voterCard.js';
import { mountCallListFlow } from '../src/ui/callListFlow.js';
import { setNotice } from '../src/ui/dom.js';
import { createContactStore } from '../src/contacts/contactStore.js';
import { createDocument, type } from './helpers/fakeDom.js';
import { createFakeIndexedDB } from './helpers/fakeIndexedDB.js';

const read = (rel) => readFileSync(new URL('../' + rel, import.meta.url), 'utf8');
const strings = JSON.parse(read('src/strings.hi.json'));
const css = read('styles.css');
const design = read('DESIGN.md');
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
const classes = (node) => node.className.split(/\s+/);
const tone = (node) => node.getAttribute('data-tone');
const ruleFor = (selector) => {
  const m = css.match(new RegExp(`(?:^|\\n)${selector.replace(/[.[\]"=]/g, '\\$&')}\\s*\\{([^}]*)\\}`));
  return m ? m[1] : null;
};

test('DESIGN.md names every :root token and styles.css defines every one it names', () => {
  const root = css.match(/:root\s*\{([^}]*)\}/)[1];
  const defined = new Set([...root.matchAll(/(--[\w-]+)\s*:/g)].map((m) => m[1]));
  const named = new Set([...design.matchAll(/`(--[\w-]+)`/g)].map((m) => m[1]));
  for (const token of defined) assert.ok(named.has(token), `DESIGN.md lacks ${token}`);
  for (const token of named) assert.ok(defined.has(token), `styles.css lacks ${token}`);
});

test('every shared control DESIGN.md names has a rule in styles.css', () => {
  const table = design.slice(design.indexOf('## Shared controls'), design.indexOf('## States'));
  const names = [...table.matchAll(/`\.([\w-]+)`/g)].map((m) => m[1]);
  assert.ok(names.length >= 10);
  const selectors = [...css.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/([^{}]+)\{/g)]
    .flatMap((m) => m[1].split(',').map((sel) => sel.trim()));
  for (const name of names) assert.ok(selectors.includes(`.${name}`), `styles.css has no .${name} rule`);
});

test('feedback colours come from tokens, and the danger and quiet buttons are tap-sized', () => {
  for (const sel of ['.notice', '.notice[data-tone="success"]', '.notice[data-tone="error"]', '.badge',
    '.alert[data-tone="error"]', '.btn-danger', '.btn-quiet-danger', '.panel', '.choice']) {
    const body = ruleFor(sel);
    assert.ok(body, sel);
    assert.doesNotMatch(body, /#[0-9a-f]{3,8}\b|rgba?\(/i, sel);
  }
  assert.match(ruleFor('.btn-danger'), /min-height:\s*var\(--touch-target\)/);
  assert.match(css, /\.btn-quiet,\n\.btn-quiet-danger\s*\{[^}]*min-height:\s*var\(--touch-target\)/);
  assert.match(ruleFor('.notice:empty'), /display:\s*none/);
  // The Devanagari face has one weight; titles must not be synthesised bold.
  assert.match(ruleFor('.panel-title'), /font-weight:\s*400/);
});

test('setNotice sets the text and tone, and clearing it drops the tone', () => {
  const p = createDocument().createElement('p');
  setNotice(p, 'ठीक', 'success');
  assert.equal(p.textContent, 'ठीक');
  assert.equal(tone(p), 'success');
  setNotice(p, '');
  assert.equal(p.textContent, '');
  assert.equal(tone(p), null);
  setNotice(p, 'खुल रहा है');
  assert.equal(tone(p), 'info');
});

test('contact panel: panel header with details and close, badge once consented, toned notices', async () => {
  const doc = createDocument();
  const contacts = newStore();
  const panel = mountContactPanel(doc.body, strings, { contacts, wardId: WARD, entry: ENTRY, log: () => {} });
  assert.ok(classes(panel.root).includes('panel'));
  assert.equal(tone(panel.message), 'info');
  assert.equal(panel.message.textContent, strings.contact_loading);
  await panel.ready;

  const header = panel.root.children[0];
  assert.ok(classes(header).includes('panel-header'));
  assert.equal(panel.closeButton.parentNode, header);
  assert.ok(classes(panel.closeButton).includes('btn-quiet'));
  assert.equal(header.querySelector('p.panel-subtitle').textContent, 'रामलाल · उम्र 41 · मकान नं. 12');
  assert.equal(panel.badge.hidden, true);

  panel.consentButton.dispatchEvent({ type: 'click' });
  await waitFor(() => panel.message.textContent === strings.contact_consent_done);
  assert.equal(tone(panel.message), 'success');
  assert.equal(panel.badge.hidden, false);
  assert.equal(panel.badge.textContent, strings.contact_consent_on_record);
  assert.ok(classes(panel.phoneInput).includes('field-phone'));

  type(panel.phoneInput, '123');
  panel.saveButton.parentNode.dispatchEvent({ type: 'submit', preventDefault() {} });
  assert.equal(panel.message.textContent, strings.contact_phone_invalid);
  assert.equal(tone(panel.message), 'error');

  assert.ok(classes(panel.revokeButton).includes('btn-quiet-danger'));
  panel.revokeButton.dispatchEvent({ type: 'click' });
  assert.ok(classes(panel.confirmBox).includes('alert'));
  assert.equal(tone(panel.confirmBox), 'error');
  assert.ok(classes(panel.confirmRevokeButton).includes('btn-danger'));
  assert.equal(panel.message.textContent, '');
  assert.equal(tone(panel.message), null);
});

test('contact panel is busy while a save is in flight', async () => {
  let finish;
  const contacts = {
    getContact: async () => null,
    recordConsent: () => new Promise((resolve) => { finish = resolve; }),
  };
  const doc = createDocument();
  const panel = mountContactPanel(doc.body, strings, { contacts, wardId: WARD, entry: ENTRY, log: () => {} });
  await panel.ready;
  panel.consentButton.dispatchEvent({ type: 'click' });
  await waitFor(() => typeof finish === 'function');
  assert.equal(panel.root.getAttribute('aria-busy'), 'true');
  finish({ wardId: WARD, serial: 7, phone: null, consentAt: 'x' });
  await waitFor(() => panel.message.textContent === strings.contact_consent_done);
  assert.equal(panel.root.getAttribute('aria-busy'), null);
});

test('voter card: same panel header, consent as a choice row, toned failure', async () => {
  const doc = createDocument();
  const contacts = {
    getContact: async () => null,
    recordConsent: async () => { throw new Error('disk full'); },
  };
  const card = mountVoterCard(doc.body, strings, { contacts, wardId: WARD, entry: ENTRY, log: () => {} });
  await card.ready;
  assert.ok(classes(card.root).includes('panel'));
  assert.ok(classes(card.closeButton).includes('btn-quiet'));
  assert.ok(classes(card.closeButton.parentNode).includes('panel-header'));
  assert.ok(classes(card.consentInput.parentNode).includes('choice'));
  assert.ok(classes(card.confirmRevokeButton).includes('btn-danger'));
  card.consentInput.checked = true;
  card.consentInput.dispatchEvent({ type: 'change' });
  await waitFor(() => card.message.textContent === strings.contact_failed);
  assert.equal(tone(card.message), 'error');
});

test('call list: same panel with close in the header and an info empty state', async () => {
  const doc = createDocument();
  const screen = mountCallListFlow(doc.body, strings, {
    contacts: { listConsented: async () => [] }, wardId: WARD, entries: [ENTRY],
    assignments: { loadAssignments: async () => [], assignVoter: async () => {} },
    roster: { listWorkers: async () => [], addWorker: async () => {} },
    log: () => {},
  });
  await screen.ready;
  assert.ok(classes(screen.root).includes('panel'));
  assert.ok(classes(screen.closeButton.parentNode).includes('panel-header'));
  assert.equal(screen.message.textContent, strings.call_list_empty);
  assert.equal(tone(screen.message), 'info');
});
