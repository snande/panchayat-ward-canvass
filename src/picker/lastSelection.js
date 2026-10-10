// The last picker selection, kept in local storage so the picker reopens on
// it. The record is the selection itself (src/picker/wardPicker.js): seat
// type, district, panchayat and ward numbers with their PDF URLs, carrying
// schemaVersion. No voter data.
//
// A record of a version this code does not know, or one it cannot read, is
// discarded (removed) and reported, never guessed at; the picker then opens
// at its first step.

import { isSelection, SELECTION_SCHEMA_VERSION } from './wardPicker.js';

export const LAST_SELECTION_KEY = 'ward-canvass-last-selection';
export const LAST_SELECTION_SCHEMA_VERSION = SELECTION_SCHEMA_VERSION;

function defaultStorage() {
  try {
    return globalThis.localStorage || null;
  } catch {
    return null;
  }
}

/** Store a selection. Returns false if it is not a selection or could not be stored. */
export function saveLastSelection(selection, storage = defaultStorage()) {
  if (!storage || !isSelection(selection)) return false;
  try {
    storage.setItem(LAST_SELECTION_KEY, JSON.stringify(selection));
    return true;
  } catch {
    return false;
  }
}

function discard(storage) {
  try {
    if (typeof storage.removeItem === 'function') storage.removeItem(LAST_SELECTION_KEY);
  } catch {
    // Nothing more to do: the record is ignored either way.
  }
}

/**
 * Read the stored selection: { selection, error }. selection is null when
 * nothing is stored or the record was discarded; error then says why
 * ('unknown-version' with the version found, 'corrupt' or 'unreadable').
 */
export function loadLastSelection(storage = defaultStorage()) {
  let raw;
  try {
    raw = storage ? storage.getItem(LAST_SELECTION_KEY) : null;
  } catch {
    return { selection: null, error: 'unreadable' };
  }
  if (raw == null) return { selection: null, error: null };
  let record;
  try {
    record = JSON.parse(raw);
  } catch {
    discard(storage);
    return { selection: null, error: 'corrupt' };
  }
  if (!record || typeof record !== 'object' || Array.isArray(record)) {
    discard(storage);
    return { selection: null, error: 'corrupt' };
  }
  if (record.schemaVersion !== LAST_SELECTION_SCHEMA_VERSION) {
    discard(storage);
    return { selection: null, error: 'unknown-version', version: record.schemaVersion };
  }
  if (!isSelection(record)) {
    discard(storage);
    return { selection: null, error: 'corrupt' };
  }
  return { selection: record, error: null };
}
