// Voter card with the consent-gated phone number (issue #42), run by `npm test`.
//
// DOM is the in-process fake from ./helpers/fakeDom.js and storage is the fake
// IndexedDB from ./helpers/fakeIndexedDB.js behind the real contact store.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { webcrypto } from 'node:crypto';

import { mountVoterCard } from '../src/ui/voterCard.js';
import { mountRollWithSearch } from '../src/ui/rollSearch.js';
import { DEBOUNCE_MS } from '../src/ui/searchScreen.js';
import { createContactStore } from '../src/contacts/contactStore.js';
import { createDocument, type } from './helpers/fakeDom.js';
import { createFakeIndexedDB } from './helpers/fakeIndexedDB.js';

const read = (rel) => readFileSync(new URL('../' + rel, import.meta.url), 'utf8');
const strings = JSON.parse(read('src/strings.hi.json'));

const WARD = '17/125/6313/1';
const ENTRY = { serial: 4, name: 'राम प्रसाद', relative: 'गोपाल', age: 45, gender: 'पु', house: '3' };
const PHONE = '9876543210';

const newStore = (idb) => createContactStore({ indexedDB: idb, crypto: webcrypto, storage: null });

/** A contact store that records each call and the phone field's lock at that moment. */
function spyStore(store, card) {
  const calls = [];
  const wrap = (name) => async (...args) => {
    const lockedAtCall = card.current ? card.current.phone.hasAttribute('disabled') : null;
    const result = await store[name](...args);
    const lockedAtResolve = card.current ? card.current.phone.hasAttribute('disabled') : null;
    calls.push({ name, args, lockedAtCall, lockedAtResolve });
    return result;
  };
  return {
    calls,
    contacts: {
      getContact: wrap('getContact'),
      recordConsent: wrap('recordConsent'),
      saveNumber: wrap('saveNumber'),
      revokeConsent: wrap('revokeConsent'),
    },
  };
}

async function mount({ idb = createFakeIndexedDB(), entry = ENTRY } = {}) {
  const doc = createDocument();
  const holder = { current: null };
  const spy = spyStore(newStore(idb), holder);
  const card = mountVoterCard(doc.body, entry, strings, { wardId: WARD, contacts: spy.contacts });
  holder.current = card;
  await card.ready;
  return { doc, idb, card, calls: spy.calls, named: (name) => spy.calls.filter((c) => c.name === name) };
}

function tick(card, checked) {
  card.consent.checked = checked;
  card.consent.dispatchEvent({ type: 'change' });
  return card.idle();
}

function save(card, value) {
  card.phone.value = value;
  card.save.dispatchEvent({ type: 'click' });
  return card.idle();
}

const locked = (card) => card.phone.hasAttribute('disabled') && card.save.hasAttribute('disabled');

function withFetchSpy(fn) {
  const saved = Object.getOwnPropertyDescriptor(globalThis, 'fetch');
  const spy = { calls: 0 };
  globalThis.fetch = async () => {
    spy.calls += 1;
    throw new TypeError('offline');
  };
  return Promise.resolve()
    .then(() => fn(spy))
    .finally(() => {
      if (saved) Object.defineProperty(globalThis, 'fetch', saved);
      else delete globalThis.fetch;
    });
}

test('the card shows the name, relative, age and house plus the consent box, phone input and save button', async () => {
  const { card } = await mount();
  const t = card.root.textContent;
  for (const part of [ENTRY.name, ENTRY.relative, `${strings.roll_age} 45`, `${strings.roll_house} 3`]) {
    assert.ok(t.includes(part), part);
  }
  assert.equal(card.consent.tagName, 'INPUT');
  assert.equal(card.consent.getAttribute('type'), 'checkbox');
  assert.equal(card.phone.tagName, 'INPUT');
  assert.equal(card.phone.getAttribute('type'), 'tel');
  assert.equal(card.save.tagName, 'BUTTON');
  assert.equal(card.root.querySelectorAll('input').length, 2);
});

test('with no consent on record the phone input and save button are disabled', async () => {
  const { card } = await mount();
  assert.equal(card.consent.checked, false);
  assert.equal(card.consent.hasAttribute('disabled'), false, 'consent can be marked once loaded');
  assert.ok(card.phone.hasAttribute('disabled'));
  assert.ok(card.save.hasAttribute('disabled'));
  assert.equal(card.message.textContent, '', 'the loading line is cleared');
});

test('marking consent calls recordConsent while the field is still locked, then unlocks it', async () => {
  const { card, named, idb } = await mount();
  await tick(card, true);
  const [record] = named('recordConsent');
  assert.ok(record, 'recordConsent was called');
  assert.deepEqual(record.args, [WARD, 4]);
  assert.equal(record.lockedAtCall, true);
  assert.equal(record.lockedAtResolve, true, 'still locked when recordConsent resolved');
  assert.equal(card.phone.hasAttribute('disabled'), false);
  assert.equal(card.save.hasAttribute('disabled'), false);
  assert.ok(await newStore(idb).getContact(WARD, 4), 'consent is stored');
});

test('a saved number reappears when the card is re-created over the same IndexedDB', async () => {
  const idb = createFakeIndexedDB();
  const first = await mount({ idb });
  await tick(first.card, true);
  await save(first.card, '98765 43210');
  assert.deepEqual(first.named('saveNumber').map((c) => c.args), [[WARD, 4, PHONE]]);
  assert.equal(first.card.message.textContent, strings.contact_saved);
  first.card.destroy();
  assert.equal(first.doc.body.querySelector('article.voter-card'), null);

  const again = await mount({ idb });
  assert.equal(again.card.consent.checked, true);
  assert.equal(again.card.phone.value, PHONE);
  assert.equal(again.card.phone.hasAttribute('disabled'), false);
  assert.equal(again.card.save.hasAttribute('disabled'), false);
});

test('an invalid number shows the Hindi error and saves nothing', async () => {
  const { card, named, idb } = await mount();
  await tick(card, true);
  for (const bad of ['12345', '98765432101', 'abcdefghij', '']) {
    await save(card, bad);
    assert.equal(card.message.textContent, strings.contact_phone_invalid, bad);
    assert.match(card.message.textContent, /[ऀ-ॿ]/);
    assert.equal(card.phone.getAttribute('aria-invalid'), 'true');
  }
  assert.equal(named('saveNumber').length, 0);
  assert.equal((await newStore(idb).getContact(WARD, 4)).phone, null);
});

test('unmarking consent calls revokeConsent, clears the number and locks the field again', async () => {
  const idb = createFakeIndexedDB();
  const { card, named } = await mount({ idb });
  await tick(card, true);
  await save(card, PHONE);
  await tick(card, false);
  assert.deepEqual(named('revokeConsent').map((c) => c.args), [[WARD, 4]]);
  assert.equal(card.phone.value, '');
  assert.ok(locked(card));
  assert.equal(card.message.textContent, strings.contact_revoked);
  assert.equal(await newStore(idb).getContact(WARD, 4), null, 'the stored record is gone');

  const reopened = await mount({ idb });
  assert.equal(reopened.card.consent.checked, false);
  assert.equal(reopened.card.phone.value, '');
  assert.ok(locked(reopened.card));
});

test('a revoke can be undone from the card, restoring consent and the number', async () => {
  const idb = createFakeIndexedDB();
  const { card } = await mount({ idb });
  assert.ok(card.undo.hasAttribute('hidden'), 'no undo before any revoke');
  await tick(card, true);
  await save(card, PHONE);
  await tick(card, false);
  assert.equal(card.undo.hasAttribute('hidden'), false);

  card.undo.dispatchEvent({ type: 'click' });
  await card.idle();
  assert.equal(card.consent.checked, true);
  assert.equal(card.phone.value, PHONE);
  assert.equal(card.phone.hasAttribute('disabled'), false);
  assert.ok(card.undo.hasAttribute('hidden'));
  assert.equal(card.message.textContent, strings.contact_restored);
  assert.equal((await newStore(idb).getContact(WARD, 4)).phone, PHONE);
});

test('a failing getContact leaves every control locked and says so in Hindi', async () => {
  const doc = createDocument();
  const store = newStore(createFakeIndexedDB());
  const contacts = { ...store, getContact: async () => { throw new Error('storage gone'); } };
  const card = mountVoterCard(doc.body, ENTRY, strings, { wardId: WARD, contacts });
  assert.equal(card.message.textContent, strings.contact_loading, 'a loading line shows while reading');
  await card.ready;
  assert.ok(card.consent.hasAttribute('disabled'));
  assert.ok(locked(card));
  assert.equal(card.message.textContent, strings.contact_load_failed);
});

test('a failing recordConsent leaves the box unticked and the field locked', async () => {
  const doc = createDocument();
  const store = newStore(createFakeIndexedDB());
  const contacts = { ...store, recordConsent: async () => { throw new Error('write failed'); } };
  const card = mountVoterCard(doc.body, ENTRY, strings, { wardId: WARD, contacts });
  await card.ready;
  await tick(card, true);
  assert.equal(card.consent.checked, false);
  assert.ok(locked(card));
  assert.equal(card.message.textContent, strings.contact_save_failed);
});

test('selecting a search result opens that voter\'s card', async () => {
  const doc = createDocument();
  const entries = [
    { serial: 1, name: 'सीता देवी', relative: 'मोहन', age: 38, gender: 'म', house: '1' },
    ENTRY,
  ];
  const view = mountRollWithSearch(doc.body, entries, strings, {
    wardId: WARD,
    contacts: newStore(createFakeIndexedDB()),
    viewportHeight: 600,
    requestFrame: () => {},
  });
  type(view.search.input, 'राम प्रसाद');
  await new Promise((resolve) => setTimeout(resolve, DEBOUNCE_MS + 50));
  const rows = view.search.list.querySelectorAll('li.pwc-search__row');
  assert.ok(rows.length > 0);
  assert.equal(view.search.cardHost.querySelector('article.voter-card'), null);

  rows[0].dispatchEvent({ type: 'click' });
  const card = view.search.cardHost.querySelector('article.voter-card');
  assert.ok(card, 'the card is mounted in the card slot');
  assert.equal(card.querySelector('h2.voter-card__name').textContent, ENTRY.name);
  assert.ok(card.textContent.includes(`${strings.roll_age} 45`), 'the roll entry, with its age, is shown');

  card.querySelector('button.voter-card__close').dispatchEvent({ type: 'click' });
  assert.equal(view.search.cardHost.querySelector('article.voter-card'), null);
  view.destroy();
});

test('open, consent, save and revoke make no fetch call', async () => {
  await withFetchSpy(async (spy) => {
    const { card } = await mount();
    await tick(card, true);
    await save(card, PHONE);
    await tick(card, false);
    assert.equal(spy.calls, 0);
  });
});

test('every label on the card comes from the Hindi string table', async () => {
  const doc = createDocument();
  const card = mountVoterCard(doc.body, ENTRY, strings, {
    wardId: WARD, contacts: newStore(createFakeIndexedDB()), onClose() {},
  });
  await card.ready;
  const label = (sel) => card.root.querySelector(sel).textContent;
  assert.equal(label('span.voter-card__consent-text'), strings.contact_consent_label);
  assert.equal(label('span.voter-card__label'), strings.contact_phone_label);
  assert.equal(label('button.voter-card__save'), strings.contact_save);
  assert.equal(label('button.voter-card__undo'), strings.contact_undo);
  assert.equal(label('button.voter-card__close'), strings.voter_card_close);
  assert.equal(label('p.voter-card__relative'), `${strings.roll_relative}: ${ENTRY.relative}`);
  assert.equal(card.root.getAttribute('aria-label'), strings.voter_card_label);
  assert.doesNotMatch(card.root.textContent, /[A-Za-z]/);

  const source = read('src/ui/voterCard.js');
  for (const key of ['contact_consent_label', 'contact_phone_label', 'contact_save', 'contact_saved',
    'contact_phone_invalid', 'contact_loading', 'contact_load_failed', 'contact_revoked', 'contact_undo']) {
    assert.ok(source.includes(`'${key}'`), key);
    assert.match(strings[key], /[ऀ-ॿ]/, key);
  }
});

test('styles.css gives the card the self-hosted Devanagari face and 44px+ controls', () => {
  const css = read('styles.css');
  assert.match(css, /@font-face\s*{[^}]*url\("fonts\/noto-sans-devanagari-subset\.woff2"\)/);
  const touch = Number(/--touch-target:\s*(\d+)px/.exec(css)[1]);
  assert.ok(touch >= 44, `--touch-target is ${touch}px`);
  const rule = (sel) => {
    const m = new RegExp(`(?:^|\\n)${sel.replace('.', '\\.')}\\s*{([^}]*)}`).exec(css);
    assert.ok(m, sel);
    return m[1];
  };
  assert.match(rule('.voter-card'), /font-family:\s*var\(--font-family-base\)/);
  for (const sel of ['.voter-card__phone', '.voter-card__save', '.voter-card__consent']) {
    assert.match(rule(sel), /min-height:\s*var\(--touch-target\)/, sel);
  }
  assert.match(css, /\.voter-card__undo,\s*\.voter-card__close\s*{[^}]*min-height:\s*var\(--touch-target\)/);
});
