// Virtualised roll list (issue #16), run by `npm test` on the in-process
// fake DOM (test/helpers/fakeDom.js), not a real browser.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { mountRollList, visibleRange, ROW_HEIGHT, OVERSCAN } from '../src/ui/rollList.js';
import { createDocument } from './helpers/fakeDom.js';

const strings = JSON.parse(readFileSync(new URL('../src/strings.hi.json', import.meta.url), 'utf8'));
const VIEWPORT = 600;

function entries(n) {
  return Array.from({ length: n }, (_, i) => ({
    serial: i + 1, name: `नाम${i + 1}`, relative: 'सत्यनारायण', age: 30 + (i % 50), gender: 'स्त्री', house: String(i % 90),
  }));
}

function mount(list) {
  const doc = createDocument();
  const frames = [];
  const view = mountRollList(doc.body, list, strings, {
    viewportHeight: VIEWPORT,
    requestFrame: (fn) => frames.push(fn),
  });
  const flush = () => {
    while (frames.length) frames.shift()();
  };
  return { doc, view, frames, flush };
}

const rows = (view) => view.viewport.querySelectorAll('div.roll-row');
const maxRows = Math.ceil(VIEWPORT / ROW_HEIGHT) + 2 * OVERSCAN + 1;

test('visibleRange clamps to the list and adds overscan', () => {
  assert.deepEqual(visibleRange(0, 600, 1000, 100, 6), { start: 0, end: 12 });
  assert.deepEqual(visibleRange(50_000, 600, 1000, 100, 6), { start: 494, end: 512 });
  assert.deepEqual(visibleRange(99_900, 600, 1000, 100, 6), { start: 993, end: 1000 });
  assert.deepEqual(visibleRange(0, 600, 3, 100, 6), { start: 0, end: 3 });
  assert.deepEqual(visibleRange(-5, NaN, 0, 100, 6), { start: 0, end: 0 });
});

test('a 3,000-voter ward renders only the rows in view', () => {
  const { view } = mount(entries(3000));
  const nodes = rows(view);
  assert.ok(nodes.length > 0);
  assert.ok(nodes.length <= maxRows, `${nodes.length} rows`);
  const spacer = view.viewport.querySelector('div.roll-spacer');
  assert.equal(spacer.getAttribute('style'), `height: ${3000 * ROW_HEIGHT}px`);
  assert.equal(view.rendered()[0], 0);
});

test('scrolling renders the rows at the new position and recycles nodes', () => {
  const { doc, view, flush } = mount(entries(3000));
  view.viewport.scrollTop = 1500 * ROW_HEIGHT;
  view.viewport.dispatchEvent({ type: 'scroll' });
  view.viewport.dispatchEvent({ type: 'scroll' });
  const created = doc.mutations;
  flush();
  const shown = view.rendered();
  assert.ok(shown.includes(1500) && shown.includes(1505), String(shown));
  assert.ok(!shown.includes(0));
  assert.equal(rows(view).length, shown.length);
  assert.ok(rows(view).length <= maxRows);
  assert.ok(doc.mutations > created);

  const row = rows(view).find((r) => r.getAttribute('aria-posinset') === '1501');
  assert.match(row.getAttribute('style'), new RegExp(`translateY\\(${1500 * ROW_HEIGHT}px\\)`));
  assert.equal(row.textContent.startsWith('1501. नाम1501'), true);
});

test('a row shows serial, name, relative, age, gender and house in Hindi', () => {
  const list = [{ serial: 7, name: 'किशनादेवी', relative: 'सत्यनारायण', age: 57, gender: 'स्त्री', house: '1' }];
  const { view } = mount(list);
  const [row] = rows(view);
  const [name, relative, meta] = row.children;
  assert.equal(name.textContent, '7. किशनादेवी');
  assert.equal(relative.textContent, 'सत्यनारायण');
  assert.equal(meta.textContent, `${strings.roll_age} 57 · स्त्री · ${strings.roll_house} 1`);
  assert.equal(view.root.getAttribute('lang'), 'hi');
  assert.equal(view.root.querySelector('p.roll-count').textContent, `${strings.roll_count}: 1`);
  assert.equal(view.viewport.getAttribute('role'), 'list');
  assert.equal(view.viewport.getAttribute('aria-label'), strings.roll_list_label);
});

test('an empty roll renders no rows and does not throw', () => {
  const { view, flush } = mount([]);
  flush();
  assert.equal(rows(view).length, 0);
});

test('names are text, never markup', () => {
  const { view } = mount([{ serial: 1, name: '<img src=x onerror=alert(1)>', relative: '', age: null, gender: '', house: '' }]);
  const [row] = rows(view);
  assert.equal(row.querySelectorAll('img').length, 0);
  assert.equal(row.children[2].textContent, '');
});

test('the list uses the Noto Sans Devanagari base font and fixed-height rows', () => {
  const css = readFileSync(new URL('../styles.css', import.meta.url), 'utf8');
  assert.match(css, /body\s*\{[^}]*font-family:\s*var\(--font-family-base\)/);
  assert.match(css, /--font-family-base:\s*"Noto Sans Devanagari"/);
  const row = css.match(/\.roll-row\s*\{([^}]*)\}/)[1];
  assert.match(row, /position:\s*absolute/);
  assert.match(row, /overflow:\s*hidden/);
  assert.doesNotMatch(row, /font-family/);
  assert.match(css, /\.roll-viewport\s*\{[^}]*overflow-y:\s*auto/);
});
