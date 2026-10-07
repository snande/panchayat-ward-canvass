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

function mount(assignments = { 1: workers[0] }, onAssign = () => {}) {
  const doc = createDocument();
  renderCallList(doc.body, buildCallList(voters, assignments), { workers, onAssign, strings });
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

test('assign control lists workers; choosing one calls onAssign and updates the row', () => {
  const calls = [];
  const doc = mount({}, (serial, assignee) => calls.push([serial, assignee]));
  const select = doc.body.querySelectorAll('select.call-assign')[1];
  const names = select.querySelectorAll('option').map((o) => o.textContent);
  assert.deepEqual(names.slice(1), ['रमेश', 'सीता']);
  select.value = 'w2';
  select.dispatchEvent({ type: 'change' });
  assert.deepEqual(calls, [[2, { workerId: 'w2', workerName: 'सीता' }]]);
  const rows = doc.body.querySelectorAll('div.call-row');
  assert.equal(rows.length, 2);
  assert.equal(rows[1].querySelector('.call-assignee').textContent, 'सीता');
  assert.equal(rows[0].querySelector('.call-assignee').textContent, strings.call_not_assigned);
});

test('new strings exist and the module never navigates or fetches', () => {
  for (const key of ['call_action', 'call_not_assigned', 'call_assign_label']) assert.ok(strings[key], key);
  const src = read('src/ui/callListScreen.js').replace(/\/\/.*$/gm, '');
  assert.doesNotMatch(src, /location|window\.open|\.click\(|fetch|XMLHttpRequest/);
});

test('service worker precaches the call list screen', () => {
  assert.ok(read('sw.js').includes('"src/ui/callListScreen.js"'));
});
