import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { LIMITS, overLimits, simulate } from './sync-poll-sim.mjs';
import { createSyncD1 } from '../test/helpers/memoryD1.js';

const SCRIPT = fileURLToPath(new URL('./sync-poll-sim.mjs', import.meta.url));
const run = (args = []) => promisify(execFile)(process.execPath, [SCRIPT, ...args]);

test('the D1 shim reports rows read and written on every result', async () => {
  const db = await createSyncD1();
  const insert = await db.prepare('INSERT INTO counters (candidate_id, seq) VALUES (?, 0)').bind('t').run();
  assert.equal(insert.meta.rows_written, 1);
  const select = await db.prepare('SELECT seq FROM counters WHERE candidate_id = ?').bind('t').all();
  assert.equal(select.meta.rows_read, 1);
  assert.equal(select.meta.rows_written, 0);
  assert.equal(db.usage.rowsWritten, 1);
  assert.ok(db.usage.rowsRead >= 2);
});

test('five teams of 20 phones stay under half the Workers Free limits for an 8-hour day', async () => {
  const result = await simulate();
  assert.equal(result.phones, 20);
  assert.equal(result.hours, 8);
  assert.match(result.backend, /^memoryD1 \((node:sqlite|sql\.js)\)$/);
  for (const key of ['requests', 'rowsRead', 'rowsWritten']) {
    assert.ok(result.team[key] > 0, `${key} is measured`);
    assert.equal(result.fiveTeams[key], result.team[key] * 5);
  }
  assert.ok(result.fiveTeams.requests < 50000, `requests ${result.fiveTeams.requests}`);
  assert.ok(result.fiveTeams.rowsRead < 2500000, `rows read ${result.fiveTeams.rowsRead}`);
  assert.ok(result.fiveTeams.rowsWritten < 50000, `rows written ${result.fiveTeams.rowsWritten}`);
  assert.deepEqual(overLimits(result.fiveTeams), []);
});

test('the script prints the backend and the three labelled totals and exits 0', async () => {
  const { stdout } = await run();
  assert.match(stdout, /^Backend: memoryD1 \((node:sqlite|sql\.js)\)$/m);
  for (const label of ['Function requests', 'Rows read', 'Rows written']) {
    assert.match(stdout, new RegExp(`^  ${label}: [1-9]\\d*$`, 'm'), label);
  }
});

test('the script exits non-zero when a five-team total reaches its limit', async () => {
  assert.deepEqual(overLimits({ ...LIMITS, requests: LIMITS.requests - 1 }), ['rowsRead', 'rowsWritten']);
  // Syncing every 5 s for an hour is 14 400 pulls a team, 72 000 for five.
  await assert.rejects(run(['--hours', '1', '--interval-ms', '5000']), (err) => {
    assert.equal(err.code, 1);
    assert.match(err.stderr, /Over the limit: Function requests/);
    return true;
  });
});
