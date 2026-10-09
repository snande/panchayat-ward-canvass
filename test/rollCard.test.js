// Voter card render (issue #138): the full roll line plus booth name and
// address, "—" for what an entry lacks, a struck-off marker, and a pure render.
// Runs on the fake DOM.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  renderVoterCard, VOTER_CARD_LABELS, STRUCK_OFF_LABEL, MISSING,
} from '../src/card/voterCard.js';
import { createDocument } from './helpers/fakeDom.js';

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const expected = JSON.parse(read('fixtures/badli-ward1-expected.json'));
const css = read('styles.css').replace(/\/\*[\s\S]*?\*\//g, '');
const BOOTH = { name: 'राजकीय प्राथमिक विद्यालय, बदली', address: 'कक्ष 1, ग्राम बदली' };
const KEYS = Object.keys(VOTER_CARD_LABELS);

const render = (entry, ward, booth) => renderVoterCard(entry, ward, booth, createDocument());

// { key: [label, value] } of the card's rows.
function rows(card) {
  return Object.fromEntries(card.querySelectorAll('div.voter-roll-field').map((row) => [
    row.getAttribute('data-field'),
    [row.querySelector('dt').textContent, row.querySelector('dd').textContent],
  ]));
}

function all(node) {
  return node.children.flatMap((c) => [c, ...all(c)]);
}

test('a fixture entry and its booth show all ten labelled fields', () => {
  const entry = expected[0];
  const card = render(entry, '1', BOOTH);
  assert.equal(card.tagName, 'SECTION');
  assert.equal(card.querySelectorAll('dt').length, 10);
  assert.equal(card.querySelectorAll('dd').length, 10);
  const got = rows(card);
  assert.deepEqual(Object.keys(got), KEYS);
  for (const key of KEYS) assert.equal(got[key][0], VOTER_CARD_LABELS[key], key);
  assert.deepEqual(Object.fromEntries(KEYS.map((k) => [k, got[k][1]])), {
    name: entry.name,
    relation: `${entry.relation} ${entry.relative}`,
    age: String(entry.age),
    gender: entry.gender,
    house: entry.house,
    epic: entry.epic,
    serial: String(entry.serial),
    ward: '1',
    boothName: BOOTH.name,
    boothAddress: BOOTH.address,
  });
  assert.equal(card.querySelector('h2').textContent, entry.name);
  assert.equal(card.querySelector('del'), null);
  assert.equal(card.querySelector('.badge'), null);
  assert.equal(card.hasAttribute('data-state'), false);
});

test('every label is Hindi text', () => {
  for (const label of Object.values(VOTER_CARD_LABELS)) {
    assert.match(label, /[ऀ-ॿ]/, label);
    assert.doesNotMatch(label, /[A-Za-z]/, label);
  }
});

test('every fixture entry renders without a blank or undefined field', () => {
  for (const entry of expected) {
    for (const [, value] of Object.values(rows(render(entry, 1, BOOTH)))) {
      assert.ok(value.trim(), `serial ${entry.serial}`);
      assert.doesNotMatch(value, /undefined|null|NaN/, `serial ${entry.serial}`);
    }
  }
});

test('a v1 rollStore entry with no booth shows — for what it lacks', () => {
  const v1 = { serial: 7, name: 'सुनीता देवी', relative: 'रामलाल', age: 41, gender: 'स्त्री', house: '12' };
  const got = rows(render(v1, '3'));
  assert.equal(got.relation[1], 'रामलाल');
  for (const key of ['epic', 'boothName', 'boothAddress']) assert.equal(got[key][1], MISSING, key);
  assert.equal(got.ward[1], '3');

  const noRelative = rows(render({ ...v1, relative: undefined, epic: null, house: '  ' }, null, {}));
  for (const key of ['relation', 'epic', 'house', 'ward', 'boothName', 'boothAddress']) {
    assert.equal(noRelative[key][1], MISSING, key);
  }
});

test('nothing at all still renders ten "—" fields and never throws', () => {
  for (const args of [[{}, undefined, null], [undefined, undefined, undefined], [null, {}, 'x']]) {
    const got = rows(render(...args));
    assert.equal(Object.keys(got).length, 10);
    for (const key of KEYS) assert.equal(got[key][1], MISSING, key);
  }
});

test('a ward can be passed as a seat-like object', () => {
  assert.equal(rows(render(expected[0], { ward: '4' }, BOOTH)).ward[1], '4');
  assert.equal(rows(render(expected[0], 0, BOOTH)).ward[1], '0');
});

test('a struck-off entry carries the हटाया गया badge and a struck-through name', () => {
  const card = render({ ...expected[1], deleted: true }, '1', BOOTH);
  assert.equal(card.getAttribute('data-state'), 'struck-off');
  const badge = card.querySelector('span.badge');
  assert.ok(badge);
  assert.equal(badge.textContent, STRUCK_OFF_LABEL);
  assert.equal(badge.getAttribute('data-tone'), 'error');
  const struck = card.querySelectorAll('del');
  assert.equal(struck.length, 2);
  for (const node of struck) assert.equal(node.textContent, expected[1].name);
  assert.equal(card.querySelector('h2').querySelector('del').textContent, expected[1].name);
  assert.equal(card.querySelector('dd').querySelector('del').textContent, expected[1].name);
  // The rest of the roll line still shows.
  assert.equal(rows(card).epic[1], expected[1].epic);

  assert.equal(render({ ...expected[1], deleted: false }, '1', BOOTH).querySelector('del'), null);
});

test('the card uses only styled classes, no inline style and no control', () => {
  const card = render({ ...expected[0], deleted: true }, '1', BOOTH);
  const nodes = [card, ...all(card)];
  const classes = new Set(nodes.flatMap((n) => n.className.split(/\s+/).filter(Boolean)));
  for (const name of classes) {
    assert.match(css, new RegExp(`\\.${name}(?![\\w-])[^{}]*\\{`), `styles.css has no .${name} rule`);
  }
  for (const node of nodes) {
    assert.equal(node.hasAttribute('style'), false, node.tagName);
    assert.ok(!['BUTTON', 'INPUT', 'SELECT', 'TEXTAREA', 'A'].includes(node.tagName), node.tagName);
  }
  // Body text is at least 16 px: the label and value use the type scale.
  const rule = (sel) => css.match(new RegExp(`(^|\\})\\s*${sel.replace(/[.[\]"]/g, '\\$&')}\\s*\\{([^}]*)\\}`))[2];
  assert.match(rule('.voter-roll-label'), /font-size:\s*var\(--font-size-sm\)/);
  assert.match(rule('.voter-roll-value'), /font-size:\s*var\(--font-size-body\)/);
  const sm = /--font-size-sm:\s*([\d.]+)rem/.exec(css);
  assert.ok(Number(sm[1]) * 16 >= 16);
  assert.doesNotMatch(rule('.badge[data-tone="error"]'), /#[0-9a-f]{3,8}\b|rgba?\(/i);
});

test('rendering stores, deletes and fetches nothing', () => {
  const touched = [];
  const names = ['indexedDB', 'localStorage', 'sessionStorage', 'fetch'];
  const saved = names.map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]);
  for (const name of names) {
    Object.defineProperty(globalThis, name, {
      configurable: true,
      get() { touched.push(name); throw new Error(`${name} used`); },
    });
  }
  try {
    render(expected[0], '1', BOOTH);
    render({ ...expected[2], deleted: true }, '1', BOOTH);
    render({}, undefined, undefined);
  } finally {
    for (const [name, desc] of saved) {
      if (desc) Object.defineProperty(globalThis, name, desc);
      else delete globalThis[name];
    }
  }
  assert.deepEqual(touched, []);
});

test('the card renders into the page document by default', () => {
  const doc = createDocument();
  const had = Object.getOwnPropertyDescriptor(globalThis, 'document');
  globalThis.document = doc;
  try {
    const card = renderVoterCard(expected[0], '1', BOOTH);
    assert.equal(card.ownerDocument, doc);
  } finally {
    if (had) Object.defineProperty(globalThis, 'document', had);
    else delete globalThis.document;
  }
});
