// Household card (src/households/householdCard.js): one card per house
// number, one tappable 48 px row per member with tag, number and visit status,
// four states built from DESIGN.md components, no store write, no network.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { webcrypto } from 'node:crypto';

import { renderHouseholdCard, HOUSEHOLD_TEXT, HOUSEHOLD_CARD_STATES } from '../src/households/householdCard.js';
import { buildHouseholdIndex, findHousehold } from '../src/households/householdIndex.js';
import { createContactStore } from '../src/contacts/contactStore.js';
import { createDocument } from './helpers/fakeDom.js';
import { createFakeIndexedDB } from './helpers/fakeIndexedDB.js';

const read = (rel) => readFileSync(new URL('../' + rel, import.meta.url), 'utf8');
const strings = JSON.parse(read('src/strings.hi.json'));
const css = read('styles.css');
const design = read('DESIGN.md');
const WARD = '17/125/6313/1';
const ENTRIES = [
  { serial: 9, name: 'राजेश कुमार', relative: 'रामलाल', age: 19, gender: 'पुरुष', house: '12' },
  { serial: 7, name: 'सुनीता देवी', relative: 'रामलाल', age: 41, gender: 'स्त्री', house: '१२' },
  { serial: 8, name: 'गीता', relative: '', age: null, gender: undefined, house: '12 ' },
  { serial: 3, name: 'अन्य', relative: 'कोई', age: 50, gender: 'पुरुष', house: '4' },
];
const HOUSE = findHousehold(buildHouseholdIndex(ENTRIES, WARD), '12');
// The sentences the precached string table has no room for.
const MODULE_ONLY = ['household_loading', 'household_empty', 'household_failed'];

const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
};
const classes = (node) => node.className.split(/\s+/);
const tone = (node) => node.getAttribute('data-tone');
const rowsOf = (view) => view.list.querySelectorAll('button.household-member');
const fieldValue = (row, cls) => row.querySelector(`span.${cls}`).querySelector('span.household-member-value').textContent;
// styles.css as innermost `selectors { body }` rules, comments stripped.
const rules = [...css.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/([^{}]+)\{([^{}]*)\}/g)]
  .map((m) => ({ selectors: m[1].trim().split(/,\s*/), body: m[2] }));
const ruleOf = (selector) => rules.filter((r) => r.selectors.includes(selector)).map((r) => r.body).join(';');

function mount(household, overrides = {}) {
  const doc = createDocument();
  const container = doc.createElement('div');
  const opened = [];
  const view = renderHouseholdCard(container, household, {
    strings,
    contacts: { getContact: async (ward, serial) => (serial === 7 ? { phone: '9876543210', consentAt: 'x' } : null) },
    getMemberStatus: async (ward, serial) => (serial === 7 ? { tag: 'समर्थक', visit: 'मिल लिए' } : serial === 9 ? { tag: 'अनिश्चित' } : null),
    onOpenMember: (member) => opened.push(member),
    log: () => {},
    ...overrides,
  });
  return { doc, container, view, opened };
}

test('the card\'s copy is Hindi; every label matches src/strings.hi.json, only its three sentences are not in it', () => {
  for (const [key, value] of Object.entries(HOUSEHOLD_TEXT)) {
    assert.match(value, /[ऀ-ॿ]/, key);
    assert.doesNotMatch(value, /[A-Za-z]/, key);
    if (MODULE_ONLY.includes(key)) assert.equal(strings[key], undefined, key);
    else assert.equal(strings[key], value, key);
  }
});

test('success: one card headed by house number and member count, one row per member in serial order', async () => {
  const { container, view } = mount(HOUSE);
  await view.ready;
  assert.equal(view.state, 'success');
  assert.equal(container.children.length, 1);
  assert.equal(container.children[0], view.root);
  assert.ok(classes(view.root).includes('panel'));
  assert.equal(view.root.querySelector('h2.panel-title').textContent, 'मकान नं. 12');
  assert.equal(view.root.querySelector('p.panel-subtitle').textContent, '3 सदस्य');
  assert.equal(view.message.textContent, '');
  assert.equal(tone(view.message), null);
  assert.equal(view.list.hidden, false);
  assert.equal(view.retryButton.hidden, true);

  const rows = rowsOf(view);
  assert.equal(rows.length, 3);
  assert.deepEqual(rows.map((r) => r.getAttribute('data-serial')), ['7', '8', '9']);
  const first = rows[0];
  assert.equal(first.querySelector('span.household-member-serial').textContent, 'क्रम 7');
  assert.equal(first.querySelector('span.household-member-name').textContent, 'सुनीता देवी');
  assert.equal(first.querySelector('span.household-member-relative').textContent, 'रामलाल');
  assert.equal(first.querySelector('span.household-member-age').textContent, 'उम्र 41');
  assert.equal(first.querySelector('span.household-member-gender').textContent, 'स्त्री');
  assert.equal(fieldValue(first, 'household-member-phone'), '9876543210');
  assert.equal(fieldValue(first, 'household-member-tag'), 'समर्थक');
  assert.equal(fieldValue(first, 'household-member-visit'), 'मिल लिए');
  assert.ok(classes(first.querySelector('span.household-member-tag')).includes('badge'));
  assert.ok(classes(first.querySelector('span.household-member-visit')).includes('badge'));
});

test('without a string table the card shows the same copy', async () => {
  const { view } = mount(HOUSE, { strings: undefined });
  await view.ready;
  assert.equal(view.root.querySelector('h2.panel-title').textContent, 'मकान नं. 12');
  assert.equal(view.root.querySelector('p.panel-subtitle').textContent, '3 सदस्य');
  assert.equal(rowsOf(view)[0].querySelector('span.household-member-serial').textContent, 'क्रम 7');
});

test('a field with no value reads "—", never blank or undefined', async () => {
  const { view } = mount(HOUSE);
  await view.ready;
  const [, gita, rajesh] = rowsOf(view);
  assert.equal(gita.querySelector('span.household-member-relative').textContent, '—');
  assert.equal(gita.querySelector('span.household-member-age').textContent, 'उम्र —');
  assert.equal(gita.querySelector('span.household-member-gender').textContent, '—');
  for (const cls of ['household-member-phone', 'household-member-tag', 'household-member-visit']) {
    assert.equal(fieldValue(gita, cls), '—', cls);
  }
  assert.equal(fieldValue(rajesh, 'household-member-phone'), '—');
  assert.equal(fieldValue(rajesh, 'household-member-tag'), 'अनिश्चित');
  assert.equal(fieldValue(rajesh, 'household-member-visit'), '—');
  for (const row of rowsOf(view)) {
    assert.doesNotMatch(row.textContent, /undefined|null|NaN/);
    for (const span of row.querySelectorAll('span')) assert.notEqual(span.textContent.trim(), '', span.className);
  }
});

test('the phone number is read from src/contacts/contactStore.js for that voter', async () => {
  const contacts = createContactStore({ indexedDB: createFakeIndexedDB(), crypto: webcrypto, storage: null });
  await contacts.recordConsent(WARD, 9);
  await contacts.saveNumber(WARD, 9, '+91 98765 43211');
  const { view } = mount(HOUSE, { contacts });
  await view.ready;
  const rows = rowsOf(view);
  assert.equal(fieldValue(rows[2], 'household-member-phone'), '9876543211');
  assert.equal(fieldValue(rows[0], 'household-member-phone'), '—');
});

test('a tap calls onOpenMember exactly once with that member\'s ward and serial', async () => {
  const { view, opened } = mount(HOUSE);
  await view.ready;
  const rows = rowsOf(view);
  rows[1].dispatchEvent({ type: 'click' });
  assert.deepEqual(opened, [{ ward: WARD, serial: 8 }]);
  rows[0].dispatchEvent({ type: 'click' });
  assert.deepEqual(opened, [{ ward: WARD, serial: 8 }, { ward: WARD, serial: 7 }]);
});

test('each row is a button-role .list-row at least 48 px tall', async () => {
  const { view } = mount(HOUSE);
  await view.ready;
  for (const row of rowsOf(view)) {
    assert.equal(row.tagName, 'BUTTON');
    assert.equal(row.getAttribute('type'), 'button');
    assert.equal(row.getAttribute('role'), null, 'a <button> keeps its native button role');
    assert.ok(classes(row).includes('list-row'));
    assert.equal(row.parentNode.tagName, 'LI');
  }
  assert.match(css, /:root\s*\{[^}]*--touch-target:\s*48px/);
  const listRow = ruleOf('.list-row');
  assert.match(listRow, /min-height:\s*var\(--touch-target\)/);
  assert.match(listRow, /appearance:\s*none/);
  assert.doesNotMatch(ruleOf('.household-member'), /min-height|height/);
});

test('loading: an info notice and aria-busy until every member\'s data settles', async () => {
  const pending = deferred();
  const { view } = mount(HOUSE, { getMemberStatus: () => pending.promise });
  assert.equal(view.state, 'loading');
  assert.equal(view.root.getAttribute('data-state'), 'loading');
  assert.equal(view.root.getAttribute('aria-busy'), 'true');
  assert.equal(view.message.textContent, HOUSEHOLD_TEXT.household_loading);
  assert.equal(tone(view.message), 'info');
  assert.ok(classes(view.message).includes('notice'));
  assert.equal(view.list.hidden, true);
  assert.equal(view.retryButton.hidden, true);
  assert.equal(rowsOf(view).length, 0);
  pending.resolve({ tag: 'समर्थक', visit: 'मिल लिए' });
  await view.ready;
  assert.equal(view.state, 'success');
  assert.equal(view.root.getAttribute('aria-busy'), null);
  assert.equal(rowsOf(view).length, 3);
});

test('empty: a null household shows Hindi copy saying no such house in the loaded ward and what to try', async () => {
  const { view } = mount(null);
  await view.ready;
  assert.equal(view.state, 'empty');
  assert.ok(classes(view.root).includes('panel'));
  assert.equal(view.message.textContent, HOUSEHOLD_TEXT.household_empty);
  assert.equal(tone(view.message), 'info');
  assert.match(view.message.textContent, /वार्ड/);
  assert.match(view.message.textContent, /नहीं मिला/);
  assert.match(view.message.textContent, /जाँचें/);
  assert.equal(view.list.hidden, true);
  assert.equal(view.retryButton.hidden, true);
  assert.equal(view.root.querySelector('p.household-contact').hidden, true);
});

test('error: a dependency that throws shows what to do and whom to call, and a retry reads again', async () => {
  for (const overrides of [
    { getMemberStatus: () => { throw new Error('locked'); } },
    { contacts: { getContact: async () => { throw new Error('locked'); } } },
  ]) {
    let errors = 0;
    const { view } = mount(HOUSE, { ...overrides, log: () => { errors += 1; } });
    await view.ready;
    assert.equal(view.state, 'error');
    assert.equal(errors, 1);
    assert.equal(view.message.textContent, HOUSEHOLD_TEXT.household_failed);
    assert.equal(tone(view.message), 'error');
    assert.match(view.message.textContent, /कोशिश करें/);
    const contact = view.root.querySelector('p.household-contact');
    assert.equal(contact.hidden, false);
    assert.ok(classes(contact).includes('roll-contact'));
    assert.equal(contact.textContent, strings.roll_error_contact);
    assert.match(contact.textContent, /समन्वयक/);
    assert.equal(view.retryButton.hidden, false);
    assert.equal(view.retryButton.textContent, strings.roll_retry);
    assert.ok(classes(view.retryButton).includes('btn-secondary'));
    assert.equal(view.list.hidden, true);
    assert.equal(view.root.getAttribute('aria-busy'), null);
  }

  let fail = true;
  const { view } = mount(HOUSE, {
    getMemberStatus: async () => {
      if (fail) throw new Error('locked');
      return { tag: 'समर्थक' };
    },
  });
  await view.ready;
  assert.equal(view.state, 'error');
  fail = false;
  view.retryButton.dispatchEvent({ type: 'click' });
  assert.equal(view.state, 'loading');
  await view.reload();
  assert.equal(view.state, 'success');
  assert.equal(view.root.querySelector('p.household-contact').hidden, true);
  assert.equal(rowsOf(view).length, 3);
});

test('the four states are distinct', () => {
  assert.deepEqual([...HOUSEHOLD_CARD_STATES], ['loading', 'empty', 'error', 'success']);
});

test('body text is at least 16 px in theme text colour tokens, with no literal sizes or colours', () => {
  assert.match(ruleOf('.list-row'), /color:\s*var\(--color-text\)/);
  assert.match(ruleOf('.list-row'), /font-size:\s*var\(--font-size-body\)/);
  assert.match(ruleOf('.household-card'), /color:\s*var\(--color-text\)/);
  assert.match(ruleOf('.search-row-meta'), /font-size:\s*var\(--font-size-sm\)/);
  const own = rules.filter((r) => r.selectors.some((sel) => sel.includes('.household-')));
  assert.ok(own.length >= 2);
  for (const { selectors, body } of own) {
    for (const m of body.matchAll(/font-size:\s*([^;]+)/g)) {
      assert.match(m[1].trim(), /^var\(--font-size-(sm|body|lg)\)$/, String(selectors));
    }
    for (const m of body.matchAll(/(?:^|[\s;])color:\s*([^;]+)/g)) {
      assert.match(m[1].trim(), /^var\(--color-[\w-]+\)$/, String(selectors));
    }
  }
});

test('DESIGN.md names the household card and its classes', () => {
  const table = design.slice(design.indexOf('## Shared controls'), design.indexOf('## States'));
  for (const name of ['household-card', 'household-members']) {
    assert.ok(table.includes(`\`.${name}\``), name);
  }
  assert.match(design, /renderHouseholdCard\(\)/);
});

test('it writes no stored record, has no destructive action and makes no network request', async () => {
  const source = read('src/households/householdCard.js').replace(/\/\/.*$/gm, '');
  assert.doesNotMatch(source, /\bfetch\b|XMLHttpRequest|WebSocket|sendBeacon|indexedDB|localStorage|sessionStorage/);
  assert.doesNotMatch(source, /saveNumber|recordConsent|revokeConsent|putSyncedContact|\.delete\(|\.put\(/);

  const calls = [];
  const contacts = new Proxy({}, {
    get: (_, name) => async () => { calls.push(name); return name === 'getContact' ? { phone: '9876543210' } : null; },
  });
  const realFetch = globalThis.fetch;
  globalThis.fetch = () => { throw new Error('no network'); };
  try {
    const { view } = mount(HOUSE, { contacts });
    await view.ready;
    assert.equal(view.state, 'success');
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.deepEqual([...new Set(calls)], ['getContact']);
  assert.equal(calls.length, 3);
});
