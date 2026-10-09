// Household index: a ward's roll entries grouped by normaliseHouse() key
// (Devanagari digits to ASCII, trimmed, no space around "/" or "-",
// lowercase; "12 A" and "12A" stay apart). Entries with no house or struck
// off are left out. Pure, in memory, no stored record.

import { toAsciiDigits } from '../search/voterSearch.js';

const SEPARATOR_SPACING = /\s*([/-])\s*/g;

/** Normalise a house number or typed query to its comparison key. */
export function normaliseHouse(str) {
  if (str == null) return '';
  return toAsciiDigits(String(str).normalize('NFC'))
    .trim()
    .replace(SEPARATOR_SPACING, '$1')
    .toLowerCase();
}

function bySerial(a, b) {
  const x = Number.isFinite(a.serial) ? a.serial : Infinity;
  const y = Number.isFinite(b.serial) ? b.serial : Infinity;
  return x === y ? 0 : x < y ? -1 : 1;
}

/**
 * Map of key -> {ward, key, house (first spelling), members (by serial)}.
 */
export function buildHouseholdIndex(entries, ward) {
  if (!Array.isArray(entries)) throw new TypeError('entries must be an array');
  const index = new Map();
  for (const entry of entries) {
    if (!entry || typeof entry !== 'object' || entry.struck === true) continue;
    const key = normaliseHouse(entry.house);
    if (key === '') continue;
    let household = index.get(key);
    if (!household) {
      household = { ward, key, house: String(entry.house).trim(), members: [] };
      index.set(key, household);
    }
    household.members.push(entry);
  }
  for (const household of index.values()) household.members.sort(bySerial);
  return index;
}

/**
 * The household whose normalised house number equals the normalised query,
 * or null when none matches (including an empty query).
 */
export function findHousehold(index, query) {
  if (!(index instanceof Map)) return null;
  const key = normaliseHouse(query);
  if (key === '') return null;
  return index.get(key) ?? null;
}
