// Voter card with the consent box gating the phone number (issue #42), run by
// `npm test` against the fake DOM and the fake IndexedDB.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { webcrypto } from 'node:crypto';

import { mountVoterCard } from '../src/ui/voterCard.js';
import { mountRollWithSearch } from '../src/ui/rollSearch.js';
import { createContactStore } from '../src/contacts/contactStore.js';
import { createDocument, type } from './helpers/fakeDom.js';
import { createFakeIndexedDB } from './helpers/fakeIndexedDB.js';

const read = (rel) => readFileSync(new URL('../' + rel, import.meta.url), 'utf8');
const strings = JSON.parse(read('src/strings.hi.json'));

const WARD = '17/125/6313/1';
const ENTRY = { serial: 4, name: 'राम प्रसाद', relative: 'गोपाल', age: 45, gender: 'पु', house: '3' };
const PHONE = '9876543210';

// A real contact store over the given fake IndexedDB, with every call logged.
function spyStore(idb) {
  const real = createContactStore({ indexedDB: idb, crypto: webcrypto, storage: null });
  const calls = [];
  const store = {};
  for (const name of ['recordConsent', 'saveNumber', 'getContact', 'revokeConsent']) {
    store[name] = async (...args) => {
      calls.push([name, ...args]);
      return real[name](...args);
    };
  }
  return { store, calls, real };
}

async function open({ idb = createFakeIndexedDB(), entry = ENTRY } = {}) {
  const doc = createDocument();
  const spy = spyStore(idb);
  const card = mountVoterCard(doc.body, entry, strings, { wardId: WARD, store: spy.store, log: () => {} });
  await card.ready;
  return { doc, idb, card, ...spy };
}

function tick(card, checked) {
  card.consent.checked = checked;
  card.consent.dispatchEvent({ type: 'change' });
  return card.whenIdle();
}

function clickSave(card) {
  card.save.dispatchEvent({ type: 'click' });
  return card.whenIdle();
}

const locked = (card) => card.phone.hasAttribute('disabled') && card.save.hasAttribute('disabled');

test('the card shows name, relative, age and house with a consent box, phone input and save button', async () => {
  const { card } = await open();
  const text = card.root.textContent;
  for (const part of [ENTRY.name, ENTRY.relative, `${strings.roll_age} ${ENTRY.age}`, `${strings.roll_house} ${ENTRY.house}`]) {
    assert.ok(text.includes(part), part);
  }
  assert.equal(card.consent.getAttribute('type'), 'checkbox');
  assert.equal(card.phone.tagName, 'INPUT');
  assert.equal(card.phone.getAttribute('type'), 'tel');
  assert.equal(card.save.tagName, 'BUTTON');
  assert.ok(text.includes(strings.contact_consent_label));
  assert.ok(text.includes(strings.contact_phone_label));
  assert.equal(card.save.textContent, strings.contact_save);
});

test('without consent the phone input and save button are disabled', async () => {
  const { card, calls } = await open();
  assert.deepEqual(calls, [['getContact', WARD, ENTRY.serial]]);
  assert.equal(card.consent.checked, false);
  assert.ok(locked(card));
  assert.equal(card.consent.hasAttribute('disabled'), false, 'the consent box is usable once loaded');
});

test('ticking consent calls recordConsent before the phone input unlocks', async () => {
  const doc = createDocument();
  const { real } = spyStore(createFakeIndexedDB());
  let lockedDuringCall = null;
  const store = {
    getContact: real.getContact,
    recordConsent: async (...args) => {
      lockedDuringCall = locked(card);
      return real.recordConsent(...args);
    },
  };
  const card = mountVoterCard(doc.body, ENTRY, strings, { wardId: WARD, store });
  await card.ready;
  await tick(card, true);
  assert.equal(lockedDuringCall, true, 'still locked while recordConsent runs');
  assert.equal(locked(card), false);
  assert.equal(card.consent.checked, true);
  assert.notEqual(await real.getContact(WARD, ENTRY.serial), null);
});

test('saving stores the number, and reopening against the same IndexedDB shows it', async () => {
  const first = await open();
  await tick(first.card, true);
  type(first.card.phone, '98765 43210');
  await clickSave(first.card);
  assert.deepEqual(first.calls.map(([name]) => name), ['getContact', 'recordConsent', 'saveNumber']);
  assert.equal(first.card.message.textContent, strings.contact_saved);
  first.card.destroy();

  const again = await open({ idb: first.idb });
  assert.equal(again.card.consent.checked, true);
  assert.equal(again.card.phone.value, PHONE);
  assert.equal(locked(again.card), false);
});

test('an invalid number shows the Hindi error and saves nothing', async () => {
  const { card, calls, real } = await open();
  await tick(card, true);
  for (const bad of ['12345', '98765432100', 'abcdefghij', '']) {
    type(card.phone, bad);
    await clickSave(card);
    assert.equal(card.message.textContent, strings.contact_invalid_phone, bad);
    assert.equal(card.message.getAttribute('role'), 'alert');
  }
  assert.equal(calls.filter(([name]) => name === 'saveNumber').length, 0);
  assert.equal((await real.getContact(WARD, ENTRY.serial)).phone, null);
});

test('unticking consent calls revokeConsent, clears the number and locks it again', async () => {
  const { card, calls, idb, real } = await open();
  await tick(card, true);
  type(card.phone, PHONE);
  await clickSave(card);

  await tick(card, false);
  assert.deepEqual(calls.at(-1), ['revokeConsent', WARD, ENTRY.serial]);
  assert.equal(card.phone.value, '');
  assert.ok(locked(card));
  assert.equal(card.consent.checked, false);
  assert.equal(await real.getContact(WARD, ENTRY.serial), null);

  const again = await open({ idb });
  assert.equal(again.card.consent.checked, false);
  assert.equal(again.card.phone.value, '');
  assert.ok(locked(again.card));
});

test('open, consent and save make no network request', async () => {
  const saved = Object.getOwnPropertyDescriptor(globalThis, 'fetch');
  let fetches = 0;
  globalThis.fetch = async () => {
    fetches += 1;
    throw new Error('offline');
  };
  try {
    const { card } = await open();
    await tick(card, true);
    type(card.phone, PHONE);
    await clickSave(card);
    assert.equal(card.message.textContent, strings.contact_saved);
  } finally {
    if (saved) Object.defineProperty(globalThis, 'fetch', saved);
    else delete globalThis.fetch;
  }
  assert.equal(fetches, 0);
  assert.doesNotMatch(read('src/ui/voterCard.js'), /\bfetch\b|XMLHttpRequest/);
});

test('every card label comes from the Hindi string table', () => {
  const src = read('src/ui/voterCard.js');
  for (const key of ['contact_consent_label', 'contact_phone_label', 'contact_save', 'contact_saved', 'contact_invalid_phone']) {
    assert.match(strings[key], /[ऀ-ॿ]/, key);
    assert.doesNotMatch(strings[key], /[A-Za-z]/, key);
    assert.ok(src.includes(`'${key}'`), key);
  }
  // The only string literals that reach the screen are table keys: no
  // hard-coded text is passed to el().
  assert.doesNotMatch(src, /el\(doc, '[a-z0-9]+', [^,)]+, '[^']+'\)/);
});

test('card controls are touch-sized and use the self-hosted Devanagari face', () => {
  const css = read('styles.css');
  assert.match(css, /url\("fonts\/noto-sans-devanagari-subset\.woff2"\)/);
  assert.match(css, /--touch-target:\s*(4[4-9]|[5-9]\d)px/);
  assert.match(css, /\.voter-card\s*\{[^}]*font-family:\s*var\(--font-family-base\)/);
  for (const cls of ['voter-card-consent', 'voter-card-phone', 'voter-card-close']) {
    const rule = css.match(new RegExp(`\\.${cls}\\s*\\{([^}]*)\\}`))[1];
    assert.match(rule, /min-height:\s*var\(--touch-target\)/, cls);
  }
  // The save button is a .btn-primary, which is touch-target tall.
  assert.match(css, /\.btn-primary\s*\{[^}]*min-height:\s*var\(--touch-target\)/);
});

test('tapping a search result opens its voter card, which reopens with the saved number', async () => {
  const entries = [
    { serial: 1, name: 'सीताराम मीणा', relative: 'मोहन', age: 40, gender: 'पु', house: '1' },
    ENTRY,
  ];
  const idb = createFakeIndexedDB();
  const mount = () => {
    const doc = createDocument();
    const container = doc.createElement('section');
    doc.body.appendChild(container);
    const { store } = spyStore(idb);
    return mountRollWithSearch(container, entries, strings, {
      viewportHeight: 600, requestFrame: () => {}, wardId: WARD, contactStore: store,
    });
  };
  const searchFor = async (view, query) => {
    const rendered = new Promise((resolve) => setTimeout(resolve, 200));
    type(view.search.input, query);
    await rendered;
    return view.search.list.querySelectorAll('li');
  };

  const view = mount();
  const [row] = await searchFor(view, 'राम प्रसाद');
  assert.equal(row.getAttribute('role'), 'button');
  row.dispatchEvent({ type: 'click' });
  assert.ok(view.card, 'the card is open');
  assert.equal(view.root.querySelector('div.roll-card').hidden, false);
  await view.card.ready;
  assert.ok(view.card.root.textContent.includes(ENTRY.name));
  await tick(view.card, true);
  type(view.card.phone, PHONE);
  await clickSave(view.card);
  view.destroy();

  const reopened = mount();
  const [again] = await searchFor(reopened, 'राम प्रसाद');
  again.dispatchEvent({ type: 'click' });
  await reopened.card.ready;
  assert.equal(reopened.card.consent.checked, true);
  assert.equal(reopened.card.phone.value, PHONE);

  reopened.card.root.querySelector('button.voter-card-close').dispatchEvent({ type: 'click' });
  assert.equal(reopened.card, null);
  assert.equal(reopened.root.querySelector('div.roll-card').hidden, true);
  reopened.destroy();
});

test('the service worker precaches the card and every module it imports (offline)', () => {
  const sw = read('sw.js');
  const pending = ['src/ui/rollSearch.js'];
  const seen = new Set();
  while (pending.length) {
    const rel = pending.pop();
    if (seen.has(rel)) continue;
    seen.add(rel);
    assert.ok(sw.includes(`"${rel}"`), rel);
    for (const [, spec] of read(rel).matchAll(/from '(\.[^']+)'/g)) {
      pending.push(new URL(spec, 'file:///' + rel).pathname.slice(1));
    }
  }
  assert.ok(seen.has('src/ui/voterCard.js'));
});
