// The last seat picked (a catalogue.js selection, which carries
// schemaVersion), kept in local storage; no voter data. A record of an
// unknown version or wrong shape is reported and removed, never guessed at.

import { isSelection, SELECTION_SCHEMA_VERSION } from './catalogue.js';

export const SELECTION_STORAGE_KEY = 'ward-canvass-selection';

function defaultStorage() {
  try {
    return globalThis.localStorage || null;
  } catch {
    return null;
  }
}

/** Store the selection. Returns false if it is not one or could not be stored. */
export function saveLastSelection(selection, storage = defaultStorage()) {
  if (!storage || !isSelection(selection)) return false;
  try {
    storage.setItem(SELECTION_STORAGE_KEY, JSON.stringify(selection));
    return true;
  } catch {
    return false;
  }
}

/**
 * Read the stored selection: { selection, error }. error is null, or why
 * there is none: 'unknown-version' (with version), 'corrupt' or 'unreadable'.
 */
export function loadLastSelection(storage = defaultStorage()) {
  let raw;
  try {
    raw = storage ? storage.getItem(SELECTION_STORAGE_KEY) : null;
  } catch {
    return { selection: null, error: 'unreadable' };
  }
  if (raw == null || raw === '') return { selection: null, error: null };
  let record = null;
  try {
    record = JSON.parse(raw);
  } catch {
    // Reported as corrupt below.
  }
  let result = { selection: record, error: null };
  if (!record || typeof record !== 'object') result = { selection: null, error: 'corrupt' };
  else if (record.schemaVersion !== SELECTION_SCHEMA_VERSION) {
    result = { selection: null, error: 'unknown-version', version: record.schemaVersion };
  } else if (!isSelection(record)) result = { selection: null, error: 'corrupt' };
  if (result.error) {
    try {
      if (typeof storage.removeItem === 'function') storage.removeItem(SELECTION_STORAGE_KEY);
      else storage.setItem(SELECTION_STORAGE_KEY, '');
    } catch {
      // The record is ignored either way.
    }
  }
  return result;
}
