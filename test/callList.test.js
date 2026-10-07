// Call list rows (issue #51), run by `npm test`.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildCallList } from '../src/calls/callList.js';

const VOTERS = [
  { serial: 1, name: 'किशनादेवी', phone: '9876543210' },
  { serial: 2, name: 'रामलाल', phone: '8123456789' },
  { serial: 3, name: 'सीता', phone: '7000000003' },
];

test('one row per consented voter, in order, with the assignee or nulls', () => {
  const rows = buildCallList(VOTERS, {
    1: { workerId: 'w1', workerName: 'अनिल' },
    3: { workerId: 'w2', workerName: 'सुनीता' },
  });
  assert.deepEqual(rows, [
    { serial: 1, name: 'किशनादेवी', phone: '9876543210', workerId: 'w1', workerName: 'अनिल' },
    { serial: 2, name: 'रामलाल', phone: '8123456789', workerId: null, workerName: null },
    { serial: 3, name: 'सीता', phone: '7000000003', workerId: 'w2', workerName: 'सुनीता' },
  ]);
});

test('an assignment for a voter who is not consented never appears', () => {
  const rows = buildCallList(VOTERS.slice(0, 1), {
    1: { workerId: 'w1', workerName: 'अनिल' },
    99: { workerId: 'w9', workerName: 'छुपा' },
  });
  assert.equal(rows.length, 1);
  assert.ok(!rows.some((row) => row.serial === 99));
  assert.ok(!JSON.stringify(rows).includes('छुपा'));
  assert.deepEqual(buildCallList([], { 1: { workerId: 'w1', workerName: 'अनिल' } }), []);
});

test('no assignments leaves every voter unassigned', () => {
  for (const assignments of [{}, undefined, null, new Map()]) {
    const rows = buildCallList(VOTERS, assignments);
    assert.equal(rows.length, VOTERS.length);
    for (const row of rows) {
      assert.equal(row.workerId, null);
      assert.equal(row.workerName, null);
    }
  }
});

test('rows carry exactly the five fields and inherited keys are not assignments', () => {
  const voters = [{ serial: 1, name: 'a', phone: '1', house: '7', relative: 'x' }];
  const [row] = buildCallList(voters, Object.create({ 1: { workerId: 'w', workerName: 'n' } }));
  assert.deepEqual(Object.keys(row).sort(), ['name', 'phone', 'serial', 'workerId', 'workerName']);
  assert.equal(row.workerId, null);
});

test('a Map of assignments works as well', () => {
  const rows = buildCallList(VOTERS, new Map([[2, { workerId: 'w1', workerName: 'अनिल' }]]));
  assert.equal(rows[1].workerId, 'w1');
  assert.equal(rows[0].workerId, null);
});

test('the inputs are not mutated', () => {
  const voters = structuredClone(VOTERS);
  const assignments = { 1: { workerId: 'w1', workerName: 'अनिल' } };
  buildCallList(voters, assignments);
  assert.deepEqual(voters, VOTERS);
  assert.deepEqual(assignments, { 1: { workerId: 'w1', workerName: 'अनिल' } });
});
