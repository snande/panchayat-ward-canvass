// Voter card render (issue #138): the full roll line plus booth name and
// address, "—" for what an entry lacks, a struck-off marker, and a pure render.
// The share button (issue #140): one voter's labelled text through a stubbed
// navigator.share or clipboard, and its copied / failed notices.
// Runs on the fake DOM.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  renderVoterCard, VOTER_CARD_LABELS, STRUCK_OFF_LABEL, MISSING,
  voterShareText, VOTER_SHARE_LABEL, VOTER_SHARE_COPIED, VOTER_SHARE_FAILED,
} from '../src/card/voterCard.js';
import { SEC_FOOTER_LINES } from '../src/ui/secFooter.js';
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

test('the card uses only styled classes, no inline style and one control, the share button', () => {
  const card = render({ ...expected[0], deleted: true }, '1', BOOTH);
  const nodes = [card, ...all(card)];
  const classes = new Set(nodes.flatMap((n) => n.className.split(/\s+/).filter(Boolean)));
  for (const name of classes) {
    assert.match(css, new RegExp(`\\.${name}(?![\\w-])[^{}]*\\{`), `styles.css has no .${name} rule`);
  }
  for (const node of nodes) {
    assert.equal(node.hasAttribute('style'), false, node.tagName);
    assert.ok(!['INPUT', 'SELECT', 'TEXTAREA', 'A'].includes(node.tagName), node.tagName);
  }
  const buttons = nodes.filter((n) => n.tagName === 'BUTTON');
  assert.equal(buttons.length, 1);
  assert.ok(buttons[0].classList.contains('voter-share'));
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

// A share tap through stubbed navigators: the card, its share button and notice.
function shareCard(nav, entry = expected[0], booth = BOOTH) {
  const card = renderVoterCard(entry, '1', booth, createDocument(), { navigator: nav });
  return { card, button: card.querySelector('button.voter-share'), message: card.querySelector('p.voter-share-message') };
}

test('the share text carries the ten labelled fields and ends with the SEC lines', () => {
  const entry = expected[0];
  const text = voterShareText(entry, '1', BOOTH);
  const lines = text.split('\n');
  assert.deepEqual(lines.slice(0, 10), [
    `${VOTER_CARD_LABELS.name}: ${entry.name}`,
    `${VOTER_CARD_LABELS.relation}: ${entry.relation} ${entry.relative}`,
    `${VOTER_CARD_LABELS.age}: ${entry.age}`,
    `${VOTER_CARD_LABELS.gender}: ${entry.gender}`,
    `${VOTER_CARD_LABELS.house}: ${entry.house}`,
    `${VOTER_CARD_LABELS.epic}: ${entry.epic}`,
    `${VOTER_CARD_LABELS.serial}: ${entry.serial}`,
    `${VOTER_CARD_LABELS.ward}: 1`,
    `${VOTER_CARD_LABELS.boothName}: ${BOOTH.name}`,
    `${VOTER_CARD_LABELS.boothAddress}: ${BOOTH.address}`,
  ]);
  assert.deepEqual(lines.slice(-SEC_FOOTER_LINES.length), [...SEC_FOOTER_LINES]);
  assert.ok(text.endsWith(SEC_FOOTER_LINES.at(-1)));
  // Nothing else: the ten fields, a blank line and the SEC lines.
  assert.equal(lines.length, 10 + 1 + SEC_FOOTER_LINES.length);
  assert.equal(lines[10], '');
  // Neutral: no candidate, party, symbol or slogan wording.
  for (const word of ['पार्टी', 'प्रत्याशी', 'उम्मीदवार', 'चुनाव चिह्न', 'वोट दें']) {
    assert.ok(!text.includes(word), word);
  }
  // Another voter's details never ride along.
  assert.ok(!text.includes(expected[1].epic));
});

test('a missing field reads — in the share text', () => {
  const lines = voterShareText({ name: 'राम' }, undefined, undefined).split('\n');
  assert.equal(lines[0], `${VOTER_CARD_LABELS.name}: राम`);
  for (const key of KEYS.slice(1)) {
    assert.ok(lines.includes(`${VOTER_CARD_LABELS[key]}: ${MISSING}`), key);
  }
});

test('the card has one साझा करें button, a shared 48 px control', () => {
  const { card, button, message } = shareCard({});
  assert.equal(card.querySelectorAll('button').length, 1);
  assert.equal(button.textContent, VOTER_SHARE_LABEL);
  assert.equal(VOTER_SHARE_LABEL, 'साझा करें');
  assert.equal(button.getAttribute('type'), 'button');
  assert.ok(button.classList.contains('btn-secondary'));
  assert.match(css, /\.btn-secondary\s*\{[^}]*min-height:\s*var\(--touch-target\)/);
  assert.match(css, /--touch-target:\s*48px/);
  assert.equal(message.textContent, '');
  assert.equal(card.hasAttribute('data-share-state'), false);
});

test('with navigator.share a tap shares this one voter\'s text once', async () => {
  const calls = [];
  const writes = [];
  const nav = {
    share: async (data) => { calls.push(data); },
    clipboard: { writeText: async (t) => { writes.push(t); } },
  };
  const { card, button, message } = shareCard(nav);
  button.dispatchEvent({ type: 'click' });
  assert.equal(await card.share(), 'shared');
  assert.equal(calls.length, 2, 'one share per tap');
  assert.deepEqual(calls[0], { text: voterShareText(expected[0], '1', BOOTH) });
  for (const key of KEYS) assert.ok(calls[0].text.includes(`${VOTER_CARD_LABELS[key]}: `), key);
  for (const line of SEC_FOOTER_LINES) assert.ok(calls[0].text.includes(line));
  assert.deepEqual(writes, []);
  assert.equal(card.getAttribute('data-share-state'), 'shared');
  assert.notEqual(message.getAttribute('data-tone'), 'error');
});

test('without navigator.share the clipboard gets the same text and the card says कॉपी हो गया', async () => {
  const writes = [];
  const { card, message } = shareCard({ clipboard: { writeText: async (t) => { writes.push(t); } } });
  assert.equal(await card.share(), 'copied');
  assert.deepEqual(writes, [voterShareText(expected[0], '1', BOOTH)]);
  assert.ok(message.textContent.includes('कॉपी हो गया'));
  assert.equal(message.textContent, VOTER_SHARE_COPIED);
  assert.equal(message.getAttribute('data-tone'), 'success');
  assert.equal(card.getAttribute('data-share-state'), 'copied');
});

test('a cancelled share or refused clipboard shows what to do and whom to call, and does not throw', async () => {
  const abort = Object.assign(new Error('cancelled'), { name: 'AbortError' });
  const navs = [
    { share: async () => { throw abort; } },
    { share: () => { throw new Error('sync'); } },
    { clipboard: { writeText: async () => { throw new Error('denied'); } } },
    {},
    undefined,
  ];
  for (const nav of navs) {
    const { card, button, message } = shareCard(nav);
    button.dispatchEvent({ type: 'click' });
    assert.equal(await card.share(), 'failed');
    assert.equal(message.textContent, VOTER_SHARE_FAILED);
    assert.equal(message.getAttribute('data-tone'), 'error');
    assert.equal(card.getAttribute('data-share-state'), 'failed');
  }
  assert.match(VOTER_SHARE_FAILED, /फिर से कोशिश करें/);
  assert.match(VOTER_SHARE_FAILED, /देर तक दबाकर कॉपी/);
  assert.match(VOTER_SHARE_FAILED, /समन्वयक/);
  // A failure after a copy replaces the copied notice.
  let fail = false;
  const { card, message } = shareCard({ clipboard: { writeText: async () => { if (fail) throw new Error('x'); } } });
  assert.equal(await card.share(), 'copied');
  fail = true;
  assert.equal(await card.share(), 'failed');
  assert.equal(message.textContent, VOTER_SHARE_FAILED);
});
