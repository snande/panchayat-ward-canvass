// Roll-view settings in localStorage (issue #127), run by `npm test`.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  loadRollSettings, saveRollSettings, ROLL_SETTINGS_STORAGE_KEY, ROLL_SETTINGS_SCHEMA_VERSION,
} from '../src/roll/rollSettings.js';

function memoryStorage() {
  const map = new Map();
  return {
    map,
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => { map.set(k, String(v)); },
  };
}

test('deletions are hidden by default', () => {
  assert.deepEqual(loadRollSettings(memoryStorage()), { settings: { showDeletions: false }, error: null });
  assert.deepEqual(loadRollSettings(null).settings, { showDeletions: false });
});

test('the toggle state is stored with a schema version and read back after a reload', () => {
  const storage = memoryStorage();
  assert.equal(saveRollSettings({ showDeletions: true }, storage), true);
  assert.deepEqual(JSON.parse(storage.map.get(ROLL_SETTINGS_STORAGE_KEY)),
    { schemaVersion: ROLL_SETTINGS_SCHEMA_VERSION, showDeletions: true });
  assert.deepEqual(loadRollSettings(storage), { settings: { showDeletions: true }, error: null });
  saveRollSettings({ showDeletions: false }, storage);
  assert.equal(loadRollSettings(storage).settings.showDeletions, false);
  assert.equal(saveRollSettings({ showDeletions: 'yes' }, storage), false);
});

test('a record of an unknown version is reported, not misread, and the defaults apply', () => {
  const storage = memoryStorage();
  storage.setItem(ROLL_SETTINGS_STORAGE_KEY, JSON.stringify({ schemaVersion: 99, showDeletions: true }));
  assert.deepEqual(loadRollSettings(storage),
    { settings: { showDeletions: false }, error: 'unknown-version', version: 99 });
  storage.setItem(ROLL_SETTINGS_STORAGE_KEY, '{not json');
  assert.deepEqual(loadRollSettings(storage), { settings: { showDeletions: false }, error: 'corrupt' });
  storage.setItem(ROLL_SETTINGS_STORAGE_KEY, JSON.stringify({ schemaVersion: 1, showDeletions: 'on' }));
  assert.equal(loadRollSettings(storage).error, 'corrupt');
  const broken = { getItem: () => { throw new Error('denied'); }, setItem: () => { throw new Error('full'); } };
  assert.equal(loadRollSettings(broken).error, 'unreadable');
  assert.equal(saveRollSettings({ showDeletions: true }, broken), false);
});
