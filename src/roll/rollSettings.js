// Local settings of the roll view, kept in localStorage (never voter data):
// showDeletions, whether supplementary deletions are listed. Off by default.
//
// The record carries schemaVersion ROLL_SETTINGS_SCHEMA_VERSION. A record of
// a version this code does not know is reported, never guessed at, and the
// defaults apply.

export const ROLL_SETTINGS_STORAGE_KEY = 'ward-canvass-roll-settings';
export const ROLL_SETTINGS_SCHEMA_VERSION = 1;
export const DEFAULT_ROLL_SETTINGS = Object.freeze({ showDeletions: false });

function defaultStorage() {
  try {
    return globalThis.localStorage || null;
  } catch {
    return null;
  }
}

/**
 * Read the roll settings. Returns { settings, error }: settings are the
 * defaults when nothing is stored or the record cannot be trusted, and error
 * then says why ('unknown-version' with the version found, 'corrupt' or
 * 'unreadable').
 */
export function loadRollSettings(storage = defaultStorage()) {
  const defaults = () => ({ ...DEFAULT_ROLL_SETTINGS });
  let raw;
  try {
    raw = storage ? storage.getItem(ROLL_SETTINGS_STORAGE_KEY) : null;
  } catch {
    return { settings: defaults(), error: 'unreadable' };
  }
  if (raw == null) return { settings: defaults(), error: null };
  let record;
  try {
    record = JSON.parse(raw);
  } catch {
    return { settings: defaults(), error: 'corrupt' };
  }
  if (!record || typeof record !== 'object') return { settings: defaults(), error: 'corrupt' };
  if (record.schemaVersion !== ROLL_SETTINGS_SCHEMA_VERSION) {
    return { settings: defaults(), error: 'unknown-version', version: record.schemaVersion };
  }
  if (typeof record.showDeletions !== 'boolean') return { settings: defaults(), error: 'corrupt' };
  return { settings: { showDeletions: record.showDeletions }, error: null };
}

/** Store the roll settings. Returns false if they could not be stored. */
export function saveRollSettings(settings, storage = defaultStorage()) {
  if (!storage || !settings || typeof settings.showDeletions !== 'boolean') return false;
  const record = { schemaVersion: ROLL_SETTINGS_SCHEMA_VERSION, showDeletions: settings.showDeletions };
  try {
    storage.setItem(ROLL_SETTINGS_STORAGE_KEY, JSON.stringify(record));
    return true;
  } catch {
    return false;
  }
}
