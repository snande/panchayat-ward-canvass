import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createDocument } from './helpers/fakeDom.js';
import { buildCallList } from '../src/calls/callList.js';
import { renderCallList } from '../src/ui/callListScreen.js';

const read = (rel) => readFileSync(new URL('../' + rel, import.meta.url), 'utf8');
const strings = JSON.parse(read('src/strings.hi.json'));
const workers = [
  { workerId: 'w1', workerName: 'रमेश' },
  { workerId: 'w2', workerName: 'सीता' },
];
const voters = [
  { serial: 1, name: 'अनिल कुमार', phone: '98765 43210' },
  { serial: 2, name: 'सुनीता देवी', phone: '98-765-00000' },
];

function mount(assignments = { 1: workers[0] }, onAssign = () => {}, list = voters) {
  const doc = createDocument();
  renderCallList(doc.body, buildCallList(list, assignments), { workers, onAssign, strings });
  return doc;
}

test('renders voter and assignee names, Hindi string when unassigned', () => {
  const doc = mount();
  const rows = doc.body.querySelectorAll('div.call-row');
  assert.equal(rows.length, 2);
  assert.match(rows[0].querySelector('.call-name').textContent, /अनिल कुमार/);
  assert.equal(rows[0].querySelector('.call-assignee').textContent, 'रमेश');
  assert.equal(rows[1].querySelector('.call-assignee').textContent, strings.call_not_assigned);
});

test('Call is an anchor with a tel: href without spaces or hyphens', () => {
  const doc = mount();
  const links = doc.body.querySelectorAll('a.call-btn');
  assert.equal(links[0].getAttribute('href'), 'tel:9876543210');
  assert.equal(links[1].getAttribute('href'), 'tel:9876500000');
  assert.equal(links[0].textContent, strings.call_action);
});

test('a voter without a phone gets a disabled control, not a dead link', () => {
  const doc = mount({}, () => {}, [{ serial: 3, name: 'x', phone: '' }]);
  assert.equal(doc.body.querySelectorAll('a.call-btn').length, 0);
  const ctl = doc.body.querySelector('.call-btn');
  assert.equal(ctl.getAttribute('aria-disabled'), 'true');
  assert.equal(ctl.hasAttribute('href'), false);
});

test('choosing a worker calls onAssign and updates the row in place', () => {
  const calls = [];
  const doc = mount({}, (serial, assignee) => calls.push([serial, assignee]));
  const select = doc.body.querySelectorAll('select.call-assign')[1];
  const link = doc.body.querySelectorAll('a.call-btn')[1];
  const names = select.querySelectorAll('option').map((o) => o.textContent);
  assert.deepEqual(names.slice(1), ['रमेश', 'सीता']);
  select.value = 'w2';
  select.dispatchEvent({ type: 'change' });
  assert.deepEqual(calls, [[2, { workerId: 'w2', workerName: 'सीता' }]]);
  const rows = doc.body.querySelectorAll('div.call-row');
  assert.equal(rows[1].querySelector('.call-assignee').textContent, 'सीता');
  assert.equal(rows[0].querySelector('.call-assignee').textContent, strings.call_not_assigned);
  // same nodes: the select keeps its choice and focus, the link is untouched
  assert.equal(doc.body.querySelectorAll('select.call-assign')[1], select);
  assert.equal(select.value, 'w2');
  assert.equal(doc.body.querySelectorAll('a.call-btn')[1], link);
  assert.equal(link.getAttribute('href'), 'tel:9876500000');
});

test('if onAssign throws, the row goes back to its previous assignee', () => {
  const doc = mount({ 1: workers[0] }, () => { throw new Error('save failed'); });
  const select = doc.body.querySelectorAll('select.call-assign')[0];
  select.value = 'w2';
  assert.throws(() => select.dispatchEvent({ type: 'change' }), /save failed/);
  assert.equal(doc.body.querySelectorAll('.call-assignee')[0].textContent, 'रमेश');
  assert.equal(select.value, 'w1');
});

test('missing strings fail loudly instead of rendering blank labels', () => {
  const doc = createDocument();
  assert.throws(() => renderCallList(doc.body, [], { workers }), /strings\.call_action/);
  assert.throws(() => renderCallList(doc.body, [], { workers, strings: {} }), TypeError);
});

test('new strings exist in Hindi', () => {
  for (const key of ['call_action', 'call_not_assigned', 'call_assign_label']) {
    assert.match(strings[key], /[ऀ-ॿ]/, key);
  }
});

test('the module never navigates to tel: or fetches', () => {
  const src = read('src/ui/callListScreen.js').replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
  assert.doesNotMatch(src, /\blocation\b|window\.open|\.click\(|\bfetch\b|XMLHttpRequest|sendBeacon|dispatchEvent/);
  // the only href is the one set on the Call anchor, from telHref
  assert.equal(src.match(/['"]href['"]/g).length, 1);
  assert.match(src, /call\.setAttribute\('href', telHref\(row\.phone\)\)/);
  assert.equal(src.match(/tel:/g).length, 1);
});

test('.call-btn is a touch target of at least 44px', () => {
  const css = read('styles.css');
  const token = Number(css.match(/--touch-target:\s*(\d+)px/)[1]);
  const block = css.match(/\.call-btn\s*\{([^}]*)\}/)[1];
  const min = block.match(/min-height:\s*([^;]+);/)[1].trim();
  assert.ok(min === 'var(--touch-target)' ? token >= 44 : parseFloat(min) >= 44, min);
});

test('service worker precaches the call list screen', () => {
  assert.ok(read('sw.js').includes('"src/ui/callListScreen.js"'));
});
