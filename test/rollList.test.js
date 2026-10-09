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

test('a struck-off entry keeps its row, with its serial and name struck through', () => {
  const list = entries(3000).map((e) => ({ ...e, struck: e.serial % 2 === 0 }));
  const { view, flush } = mount(list);
  const at = (serial) => rows(view).find((r) => r.getAttribute('aria-posinset') === String(serial));
  const struckRow = at(2);
  assert.ok(struckRow.classList.contains('roll-row--struck'));
  assert.equal(struckRow.getAttribute('data-state'), 'struck-off');
  const del = struckRow.querySelector('del');
  assert.ok(del, 'serial and name are in a <del>');
  assert.equal(struckRow.children[0].children[0], del, 'the <del> is the name line');
  assert.equal(del.textContent, '2. नाम2');
  assert.equal(struckRow.children[1].textContent, 'सत्यनारायण');
  assert.ok(!at(1).classList.contains('roll-row--struck'));
  assert.equal(at(1).querySelector('del'), null);
  assert.equal(view.root.querySelector('p.roll-count').textContent, `${strings.roll_count}: 3000`);

  // Recycled rows take the look of the entry they now show, and the struck-off
  // entry stays reachable by scrolling, in roll order.
  view.viewport.scrollTop = 1500 * ROW_HEIGHT;
  view.viewport.dispatchEvent({ type: 'scroll' });
  flush();
  assert.equal(at(1501).getAttribute('data-state'), null);
  assert.equal(at(1501).querySelector('del'), null);
  assert.equal(at(1502).querySelector('del').textContent, '1502. नाम1502');
});

test('a struck-off row is tappable like any other', () => {
  const doc = createDocument();
  const picked = [];
  const list = [{ serial: 1, name: 'क', struck: true }, { serial: 2, name: 'ख', struck: false }];
  const view = mountRollList(doc.body, list, strings, { viewportHeight: VIEWPORT, requestFrame: () => {}, onSelect: (e) => picked.push(e.serial) });
  view.viewport.querySelectorAll('div.roll-row')[0].dispatchEvent({ type: 'click' });
  assert.deepEqual(picked, [1]);
});

test('resize re-renders for the new height and destroy() removes the listener', () => {
  const doc = createDocument();
  const listeners = new Map();
  doc.defaultView = {
    addEventListener: (type, fn) => listeners.set(type, fn),
    removeEventListener: (type, fn) => { if (listeners.get(type) === fn) listeners.delete(type); },
  };
  const frames = [];
  const view = mountRollList(doc.body, entries(500), strings, {
    viewportHeight: VIEWPORT,
    requestFrame: (fn) => frames.push(fn),
  });
  const flush = () => { while (frames.length) frames.shift()(); };
  flush();
  const tall = view.rendered().length;
  assert.ok(listeners.has('resize'));

  view.viewport.clientHeight = 200;
  listeners.get('resize')();
  assert.equal(frames.length, 1);
  flush();
  assert.ok(view.rendered().length < tall, `${view.rendered().length} < ${tall}`);

  view.destroy();
  assert.equal(listeners.has('resize'), false);
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

test('styles.css strikes a struck-off row through with a DESIGN.md colour token', () => {
  const css = readFileSync(new URL('../styles.css', import.meta.url), 'utf8');
  assert.match(css, /\.roll-row--struck\s*\{[^}]*background:\s*var\(--color-danger-bg\)/);
  const rule = css.match(/\.roll-row--struck \.roll-name\s*\{([^}]*)\}/)[1];
  assert.match(rule, /text-decoration:\s*line-through/);
  assert.match(rule, /color:\s*var\(--color-danger\)/);
  const design = readFileSync(new URL('../DESIGN.md', import.meta.url), 'utf8');
  assert.match(design, /`--color-danger`/);
  assert.match(design, /`\.roll-row--struck`/);
});
