// Household index: a ward's roll entries grouped by normalised house number.
//
// Pure and offline: no DOM, no network and no storage access. The index is
// built in memory from the entries src/roll/rollStore.js keeps
// ({serial, name, relative, age, gender, house}), so it adds no stored record.
//
// House numbers are compared after normaliseHouse(): Devanagari digits become
// ASCII, surrounding whitespace is trimmed, whitespace around "/" and "-" is
// removed and Latin letters are lowercased. Any other difference keeps two
// houses separate ("12 A" and "12A" are different houses).
//
// Entries whose house is empty, whitespace-only or missing are EXCLUDED from
// the index: they belong to no household and are never merged with each
// other.

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
 * Group a ward's entries into households.
 *
 * @param {object[]} entries {serial, name, relative, age, gender, house}
 * @param {*} ward the ward the entries belong to, carried on each household
 * @returns {Map<string, {ward: *, key: string, house: string, members: object[]}>}
 *   keyed by normalised house number; `house` is the first spelling seen and
 *   `members` are the original entries in ascending serial order. Entries
 *   with an empty or missing house are left out.
 */
export function buildHouseholdIndex(entries, ward) {
  if (!Array.isArray(entries)) throw new TypeError('entries must be an array');
  const index = new Map();
  for (const entry of entries) {
    if (!entry || typeof entry !== 'object') continue;
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
