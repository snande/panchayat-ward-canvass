// Call list screen (issue #52), run by `npm test` on the in-process fake DOM
// (test/helpers/fakeDom.js), not a real browser.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { renderCallList, telHref } from '../src/ui/callListScreen.js';
import { buildCallList } from '../src/calls/callList.js';
import { createDocument } from './helpers/fakeDom.js';

const read = (rel) => readFileSync(new URL('../' + rel, import.meta.url), 'utf8');
const strings = JSON.parse(read('src/strings.hi.json'));
const source = read('src/ui/callListScreen.js');

const workers = [
  { workerId: 'w1', workerName: 'रमेश कुमार' },
  { workerId: 'w2', workerName: 'सीता देवी' },
];
const voters = [
  { serial: 1, name: 'राम प्रसाद', phone: '98765 432-10' },
  { serial: 7, name: 'गीता बाई', phone: '+91-91234-56789' },
];

function render(opts = {}) {
  const doc = createDocument();
  const rows = buildCallList(voters, { 1: { workerId: 'w2', workerName: 'सीता देवी' } });
  const calls = [];
  const view = renderCallList(doc.body, rows, {
    workers,
    onAssign: (serial, worker) => calls.push([serial, worker]),
    strings,
    ...opts,
  });
  const items = doc.body.querySelectorAll('li.call-row');
  return { doc, view, items, calls };
}

const assigneeOf = (item) => item.querySelector('span.call-row__assignee').textContent;

test('new call list strings are in the Hindi table', () => {
  for (const key of ['call_action', 'call_not_assigned', 'call_assign_label', 'call_assign_prompt']) {
    assert.equal(typeof strings[key], 'string', key);
    assert.match(strings[key], /[ऀ-ॿ]/, key);
  }
});

test('renders one row per consented voter with name and assignee', () => {
  const { items } = render();
  assert.equal(items.length, 2);
  assert.equal(items[0].querySelector('span.call-row__name').textContent, 'राम प्रसाद');
  assert.equal(assigneeOf(items[0]), 'सीता देवी');
  assert.equal(items[1].querySelector('span.call-row__name').textContent, 'गीता बाई');
  assert.equal(assigneeOf(items[1]), strings.call_not_assigned);
});

test('call control is a tel: anchor with spaces and hyphens removed', () => {
  const { items } = render();
  const links = items.map((item) => item.querySelector('a.call-btn'));
  assert.equal(links[0].tagName, 'A');
  assert.equal(links[0].getAttribute('href'), 'tel:9876543210');
  assert.equal(links[1].getAttribute('href'), 'tel:+919123456789');
  assert.equal(links[0].textContent, strings.call_action);
  assert.equal(telHref(' 12 3-4 '), 'tel:1234');
});

test('assign control lists the workers and is labelled from the table', () => {
  const { items } = render();
  const select = items[0].querySelector('select.call-row__select');
  const options = select.querySelectorAll('option');
  assert.deepEqual(options.map((o) => o.textContent), [strings.call_assign_prompt, 'रमेश कुमार', 'सीता देवी']);
  assert.deepEqual(options.map((o) => o.getAttribute('value')), ['', 'w1', 'w2']);
  assert.equal(select.value, 'w2');
  assert.equal(items[1].querySelector('select.call-row__select').value, '');
  assert.equal(items[0].querySelector('span.call-row__assign-label').textContent, strings.call_assign_label);
});

test('choosing a worker calls onAssign and re-renders that row', () => {
  const { view, items, calls } = render();
  const select = items[1].querySelector('select.call-row__select');
  select.value = 'w1';
  select.dispatchEvent({ type: 'change' });
  assert.deepEqual(calls, [[7, { workerId: 'w1', workerName: 'रमेश कुमार' }]]);
  assert.equal(assigneeOf(items[1]), 'रमेश कुमार');
  assert.equal(assigneeOf(items[0]), 'सीता देवी', 'other rows are untouched');
  assert.equal(view.rows()[1].workerId, 'w1');

  select.value = '';
  select.dispatchEvent({ type: 'change' });
  assert.equal(calls.length, 1, 'the empty prompt option assigns nobody');
  assert.equal(select.value, 'w1');
});

test('rendering never navigates, opens windows, taps links or hits the network', () => {
  const saved = {};
  const touched = [];
  for (const name of ['fetch', 'XMLHttpRequest', 'open', 'location']) {
    saved[name] = Object.getOwnPropertyDescriptor(globalThis, name);
    Object.defineProperty(globalThis, name, {
      configurable: true,
      get() { touched.push(name); return undefined; },
      set() { touched.push(name); },
    });
  }
  try {
    const { items } = render();
    items[0].querySelector('a.call-btn').click = () => touched.push('click');
    const select = items[0].querySelector('select.call-row__select');
    select.value = 'w1';
    select.dispatchEvent({ type: 'change' });
  } finally {
    for (const [name, desc] of Object.entries(saved)) {
      if (desc) Object.defineProperty(globalThis, name, desc);
      else delete globalThis[name];
    }
  }
  assert.deepEqual(touched, []);
});

test('source has no programmatic navigation or network calls', () => {
  const code = source.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
  for (const pattern of [/location/, /window\.open/, /\.click\s*\(/, /\bfetch\b/, /XMLHttpRequest/, /\bimport\s*\(/, /assign\s*\(\s*['"`]tel:/]) {
    assert.doesNotMatch(code, pattern);
  }
  assert.match(code, /setAttribute\('href', telHref/);
});

test('call button is a styled touch target of at least 44px', () => {
  const css = read('styles.css');
  const rule = css.match(/\.call-btn\s*\{([^}]*)\}/);
  assert.ok(rule, '.call-btn rule exists');
  const minHeight = rule[1].match(/min-height:\s*([^;]+);/)[1].trim();
  const touch = Number(css.match(/--touch-target:\s*(\d+)px/)[1]);
  const px = minHeight === 'var(--touch-target)' ? touch : Number(minHeight.replace('px', ''));
  assert.ok(px >= 44, `min-height ${px}px`);
  assert.doesNotMatch(css.slice(css.indexOf('.call-list')), /url\(|@import/);
});

test('the service worker precaches the screen and its imports (offline)', () => {
  const sw = read('sw.js');
  for (const path of ['src/ui/callListScreen.js', 'src/ui/dom.js', 'src/strings.hi.json', 'styles.css']) {
    assert.ok(sw.includes(`"${path}"`), path);
  }
});
