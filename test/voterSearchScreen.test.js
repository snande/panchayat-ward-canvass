// The search screen (issue #135): live results over every loaded ward with the
// match in <mark>, filter and sort controls, the "3/145" jump, and its empty,
// loading, no-results and error states, all under the fake DOM.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  createVoterSearchScreen, FALLBACK_TEXT, DEBOUNCE_MS, RESULT_LIMIT, SEARCH_STATES, SORT_KEYS, wardOfKey,
} from '../src/ui/voterSearchScreen.js';
import { buildSearchIndex, searchVoters } from '../src/search/voterSearch.js';
import { createDocument, type } from './helpers/fakeDom.js';

const read = (rel) => readFileSync(new URL('../' + rel, import.meta.url), 'utf8');
const strings = JSON.parse(read('src/strings.hi.json'));
const source = read('src/ui/voterSearchScreen.js');

const W3 = '17/125/6313/3';
const W5 = '17/125/6313/5';
const ROLL3 = [
  { serial: 145, name: 'रमेश कुमार', relative: 'सुरेश', age: 42, gender: 'पुरुष', house: '12' },
  { serial: 146, name: 'सीता देवी', relative: 'रमेश कुमार', age: 38, gender: 'स्त्री', house: '12' },
  { serial: 7, name: 'कमला', relative: 'मोहन', age: 67, gender: 'स्त्री', house: '4' },
];
const ROLL5 = [
  { serial: 1, name: 'रमेश चंद', relative: 'हरि', age: 25, gender: 'पुरुष', house: '9' },
  { serial: 2, name: 'गीता', relative: 'श्याम', age: 55, gender: 'स्त्री', house: '3' },
];
const ROLLS = new Map([[W3, ROLL3], [W5, ROLL5]]);

const contacts = {
  listConsented: async (wardKey) => (wardKey === W3
    ? [{ serial: 145, phone: '9876543210' }, { serial: 7, phone: '9876500000' }, { serial: 146, phone: null }]
    : []),
};
const assignments = { loadAssignments: async () => ({ 145: { workerId: 'w1', workerName: 'अनु' } }) };

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const keys = (screen) => screen.list.children.map((row) => row.getAttribute('data-key'));
const tone = (node) => node.getAttribute('data-tone');

function mount(opts = {}) {
  const doc = createDocument();
  const host = doc.createElement('section');
  doc.body.appendChild(host);
  const screen = createVoterSearchScreen(host, opts.strings === undefined ? strings : opts.strings,
    { contacts, assignments, log: () => {}, ...opts });
  return { doc, host, screen };
}

async function search(screen, query) {
  type(screen.input, query);
  await sleep(DEBOUNCE_MS + 20);
}

function change(node, value) {
  if (typeof value === 'boolean') node.checked = value;
  else node.value = value;
  node.dispatchEvent({ type: 'change' });
}

test('the fallback copies match the string table, and every key the screen uses is in it', () => {
  for (const [key, value] of Object.entries(FALLBACK_TEXT)) assert.equal(value, strings[key], key);
  for (const key of SORT_KEYS) assert.ok(strings[`search_sort_${key}`], key);
  assert.ok(strings.nav_search);
  assert.equal(DEBOUNCE_MS, 50);
  assert.equal(RESULT_LIMIT, 100);
  assert.deepEqual([...SEARCH_STATES], ['empty', 'loading', 'filled', 'noResults', 'error']);
  assert.equal(wardOfKey(W3), '3');
});

test('with no roll loaded it is the empty state; while a roll opens it is the loading state', async () => {
  const { screen } = mount();
  assert.equal(screen.state, 'empty');
  assert.equal(screen.message.textContent, strings.search_empty);
  assert.equal(tone(screen.message), 'info');
  assert.equal(screen.root.querySelector('div.search-controls').hidden, true, 'no control before a roll');
  assert.equal(screen.progress.hidden, true);

  screen.setLoading(true);
  assert.equal(screen.state, 'loading');
  assert.equal(screen.message.textContent, strings.search_loading);
  assert.equal(screen.progress.hidden, false);
  assert.equal(screen.progress.getAttribute('role'), 'progressbar');

  await screen.setRolls(ROLLS);
  assert.equal(screen.state, 'filled');
  assert.equal(screen.progress.hidden, true);
  assert.equal(screen.root.querySelector('div.search-controls').hidden, false);
});

test('typing shows rows with serial, name, relative, age, gender and house, the match in <mark> from the ranges', async () => {
  const { screen } = mount();
  await screen.setRolls(ROLLS);
  await search(screen, 'रमेश');
  assert.equal(screen.state, 'filled');
  assert.deepEqual(keys(screen), ['3:145', '5:1', '3:146'], 'every loaded ward is searched');

  const expected = searchVoters(buildSearchIndex([...ROLL3.map((e) => ({ ...e, ward: '3' })),
    ...ROLL5.map((e) => ({ ...e, ward: '5' }))]), 'रमेश');
  screen.list.children.forEach((row, i) => {
    const { entry, field, ranges } = expected[i];
    const text = row.textContent;
    for (const part of [`${entry.ward}/${entry.serial}`, entry.name, entry.relative, `${strings.roll_age} ${entry.age}`,
      entry.gender, `${strings.roll_house} ${entry.house}`]) {
      assert.ok(text.includes(part), `${part} in ${text}`);
    }
    const marks = row.querySelectorAll('mark');
    assert.deepEqual(marks.map((m) => m.textContent), ranges.map((r) => String(entry[field]).slice(r.start, r.end)));
    assert.ok(row.querySelector(`span.search-${field}`).querySelector('mark'), `mark sits in the ${field}`);
    assert.ok(row.classList.contains('list-row'));
  });
  assert.equal(screen.count.textContent, `3 ${strings.search_found}`);
});

test('voter text is put on the page as text nodes, never parsed as markup', async () => {
  const { screen } = mount();
  await screen.setRolls(new Map([[W3, [{ serial: 1, name: '<img src=x onerror=alert(1)>', relative: '', age: 30, gender: '', house: '' }]]]));
  await search(screen, 'img');
  assert.equal(screen.list.children.length, 1);
  assert.equal(screen.list.querySelectorAll('img').length, 0);
  assert.ok(screen.list.textContent.includes('<img src=x onerror=alert(1)>'));
  assert.doesNotMatch(source, /innerHTML|outerHTML|insertAdjacentHTML/);
});

test('the index is rebuilt when another roll finishes loading', async () => {
  const { screen } = mount();
  await screen.setRolls(new Map([[W3, ROLL3]]));
  await search(screen, 'गीता');
  assert.equal(screen.state, 'noResults');
  assert.equal(screen.message.textContent, strings.search_no_results);
  assert.equal(tone(screen.message), 'info');
  await screen.setRolls(ROLLS);
  assert.equal(screen.state, 'filled');
  assert.deepEqual(keys(screen), ['5:2']);
});

test('ward/booth, gender and age range filters re-render the results', async () => {
  const { screen } = mount();
  await screen.setRolls(new Map([[W3, ROLL3], [W5, ROLL5.map((e) => ({ ...e, booth: '12' }))]]));
  const { place, gender, ageMin, ageMax } = screen.controls;
  assert.deepEqual(place.children.map((o) => o.getAttribute('value')), ['', 'w:3', 'w:5', 'b:12']);
  change(place, 'w:3');
  assert.deepEqual(keys(screen), ['3:7', '3:145', '3:146']);
  change(place, 'b:12');
  assert.deepEqual(keys(screen), ['5:1', '5:2']);
  change(place, '');
  change(gender, 'स्त्री');
  assert.deepEqual(keys(screen), ['3:7', '3:146', '5:2']);
  change(gender, '');
  type(ageMin, '40');
  type(ageMax, '60');
  await sleep(DEBOUNCE_MS + 20);
  assert.deepEqual(keys(screen), ['3:145', '5:2']);
});

test('has-number and not-called come from the contact store and the call list', async () => {
  const { screen } = mount();
  await screen.setRolls(ROLLS);
  const { hasNumber, notCalled } = screen.controls;
  change(hasNumber, true);
  assert.deepEqual(keys(screen), ['3:7', '3:145']);
  change(notCalled, true);
  assert.deepEqual(keys(screen), ['3:7'], '145 is on the call list with a worker');
  change(hasNumber, false);
  assert.deepEqual(keys(screen), ['3:7', '3:146', '5:1', '5:2']);
});

test('tag and visit filters take maps; with none they keep everyone', async () => {
  const { screen } = mount();
  await screen.setRolls(ROLLS);
  const { tag, visit } = screen.controls;
  assert.equal(tag.disabled, true);
  assert.equal(visit.disabled, true);
  change(tag, '');
  assert.equal(screen.list.children.length, 5);

  screen.setLookups({
    tags: new Map([['3:145', ['समर्थक']], ['5:2', ['समर्थक', 'बुज़ुर्ग']]]),
    visits: new Map([['3:7', 'मिले'], ['5:1', 'घर बंद']]),
  });
  assert.equal(tag.disabled, false);
  change(tag, 'समर्थक');
  assert.deepEqual(keys(screen), ['3:145', '5:2']);
  change(tag, '');
  change(visit, 'मिले');
  assert.deepEqual(keys(screen), ['3:7']);
});

test('the sort control orders by relevance, serial, name or age', async () => {
  const { screen } = mount();
  await screen.setRolls(ROLLS);
  const { sort } = screen.controls;
  assert.deepEqual(sort.children.map((o) => o.getAttribute('value')), ['relevance', 'serial', 'name', 'age']);
  assert.deepEqual(sort.children.map((o) => o.textContent), SORT_KEYS.map((k) => strings[`search_sort_${k}`]));
  change(sort, 'age');
  assert.deepEqual(keys(screen), ['5:1', '3:146', '3:145', '5:2', '3:7']);
  change(sort, 'serial');
  assert.deepEqual(keys(screen), ['3:7', '3:145', '3:146', '5:1', '5:2']);
  await search(screen, 'रमेश');
  change(sort, 'relevance');
  assert.deepEqual(keys(screen), ['3:145', '5:1', '3:146']);
  change(sort, 'name');
  assert.equal(keys(screen).length, 3);
});

test('"3/145" selects and scrolls to that row; a voter not loaded is a Hindi error saying what to do and whom to call', async () => {
  const { doc, screen } = mount();
  const scrolled = [];
  Object.getPrototypeOf(doc.createElement('li')).scrollIntoView = function scrollIntoView() { scrolled.push(this); };
  try {
    await screen.setRolls(ROLLS);
    await search(screen, '3/145');
    const row = screen.list.children[0];
    assert.equal(row.getAttribute('data-key'), '3:145');
    assert.equal(row.getAttribute('aria-selected'), 'true');
    assert.deepEqual(scrolled, [row]);
    assert.equal(row.querySelector('span.search-serial').querySelector('mark').textContent, '145');

    await search(screen, '3/999');
    assert.equal(screen.state, 'error');
    assert.equal(tone(screen.message), 'error');
    assert.equal(screen.message.getAttribute('role'), 'alert');
    assert.ok(screen.message.textContent.includes(strings.search_jump_missing));
    assert.ok(screen.message.textContent.includes('999'));
    assert.equal(screen.contact.textContent, strings.search_error_contact);
    assert.equal(screen.list.children.length, 0);
    assert.equal(screen.input.value, '3/999', 'the typed input stays');

    screen.setSupport('ब्लॉक समन्वयक से संपर्क करें।');
    assert.equal(screen.contact.textContent, 'ब्लॉक समन्वयक से संपर्क करें।');
  } finally {
    delete Object.getPrototypeOf(doc.createElement('li')).scrollIntoView;
  }
});

test('a roll the index cannot be built from is the error state with whom to call', async () => {
  const { screen } = mount();
  await screen.setRolls([[W3, 5]]);
  assert.equal(screen.state, 'error');
  assert.equal(screen.message.textContent, strings.search_failed);
  assert.equal(screen.contact.hidden, false);
  assert.equal(screen.contact.textContent, strings.search_error_contact);
});

test('at most the top 100 rows are rendered', async () => {
  const { screen } = mount();
  const big = Array.from({ length: 150 }, (_, i) => ({ serial: i + 1, name: 'रमेश', relative: '', age: 30, gender: 'पुरुष', house: '' }));
  await screen.setRolls(new Map([[W3, big]]));
  await search(screen, 'रमेश');
  assert.equal(screen.list.children.length, 100);
  assert.ok(screen.count.textContent.includes(strings.search_capped));
});

test('with no string table every line is still Hindi', async () => {
  const { screen } = mount({ strings: null });
  assert.equal(screen.message.textContent, FALLBACK_TEXT.search_empty);
  await screen.setRolls(ROLLS);
  await search(screen, 'ज़ज़ज़');
  assert.equal(screen.message.textContent, FALLBACK_TEXT.search_no_results);
});

test('built from shared controls: no unstyled native control, 48 px rows and 16 px text', async () => {
  const { screen } = mount();
  await screen.setRolls(ROLLS);
  const shared = ['field-input', 'field-select', 'choice-input'];
  for (const tag of ['input', 'select', 'button', 'textarea']) {
    for (const node of screen.root.querySelectorAll(tag)) {
      assert.ok(shared.some((c) => node.classList.contains(c)), `${tag}.${node.className}`);
    }
  }
  assert.equal(screen.root.querySelectorAll('input').length, 5);
  assert.equal(screen.root.querySelectorAll('select').length, 5);
  for (const label of screen.root.querySelectorAll('label.choice')) assert.ok(label.querySelector('input.choice-input'));
  for (const row of screen.list.children) assert.ok(row.classList.contains('list-row'), 'rows are 48 px list rows');
  assert.ok(screen.message.classList.contains('notice'));

  const css = read('styles.css');
  const block = css.slice(css.indexOf('/* Search screen'));
  assert.ok(block.includes('.search-screen {'));
  assert.doesNotMatch(block, /#[0-9a-f]{3,8}\b|rgba?\(/i);
  for (const [, value] of block.matchAll(/font-size:\s*([^;]+);/g)) {
    assert.match(value, /^var\(--font-size-(sm|body|lg|xl)\)$/, 'text from the type scale (16 px and up)');
  }
  const design = read('DESIGN.md');
  assert.ok(design.includes('`.search-screen`') && design.includes('src/ui/voterSearchScreen.js'));
});

test('the screen writes no store and makes no request, and both modules are precached', () => {
  assert.doesNotMatch(source, /localStorage|sessionStorage|indexedDB|fetch\(|XMLHttpRequest|saveNumber|recordConsent|assignVoter/);
  const sw = read('sw.js');
  for (const file of ['src/search/voterSearch.js', 'src/ui/voterSearchScreen.js', 'src/calls/callList.js', 'src/ui/dom.js',
    'src/search/hindiSearch.js']) {
    assert.ok(sw.includes(`"${file}"`), file);
  }
});
