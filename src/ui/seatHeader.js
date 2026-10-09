// The seat header: one line above every screen naming the loaded panchayat
// and ward (or, for a sarpanch, the whole panchayat). With no seat it shows
// the empty state, a link to the ward picker.
//
// The last seat is kept in local storage so a cold start names it again. The
// record holds only { schemaVersion, seatType, panchayat, ward } (panchayat
// name, ward number, seat type), never voter data.

import { el } from './dom.js';

// Copies of src/strings.hi.json entries, so the header renders before (or
// without) the table. test/seatHeader.test.js fails if they drift.
const DEFAULT_STRINGS = {
  seat_header_panchayat: 'पंचायत',
  seat_header_ward: 'वार्ड',
  seat_header_all_wards: 'सभी वार्ड',
  seat_header_empty: 'कोई वार्ड लोड नहीं — ऊपर पंचायत और वार्ड चुनें',
};

export const SEAT_STORAGE_KEY = 'ward-canvass-seat';
export const SEAT_SCHEMA_VERSION = 1;
export const SEAT_TYPES = ['ward', 'sarpanch'];
// The picker's container: the empty state links here.
const PICKER_HREF = '#ward-picker';

const has = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);
const isText = (value) => typeof value === 'string' && value.trim() !== '';

/** A seat that can be shown: a known seat type, a panchayat name, and a ward for a ward panch. */
export function isSeat(seat) {
  if (!seat || typeof seat !== 'object') return false;
  if (!SEAT_TYPES.includes(seat.seatType) || !isText(seat.panchayat)) return false;
  return seat.seatType === 'sarpanch' || isText(seat.ward);
}

/** The header line for a seat, e.g. "पंचायत: बडली · वार्ड: 3". */
export function seatLabel(seat, strings = {}) {
  const text = (key) => (has(strings, key) && strings[key]) || DEFAULT_STRINGS[key];
  const where = `${text('seat_header_panchayat')}: ${seat.panchayat.trim()}`;
  if (seat.seatType === 'sarpanch') return `${where} · ${text('seat_header_all_wards')}`;
  return `${where} · ${text('seat_header_ward')}: ${seat.ward.trim()}`;
}

/**
 * Render the header into root: the seat's line, or the empty state (a link to
 * the picker) when there is no valid seat. Safe to call again on every change.
 * @param {Element|null} root
 * @param {{seatType: 'ward'|'sarpanch', panchayat: string, ward?: string}|null} selection
 * @param {Object<string,string>} [strings] the string table, if loaded
 */
export function renderSeatHeader(root, selection, strings = {}) {
  if (!root) return null;
  const doc = root.ownerDocument || document;
  const table = strings || {};
  let node;
  if (isSeat(selection)) {
    node = el(doc, 'p', 'seat-header-text', seatLabel(selection, table));
    root.setAttribute('data-state', 'loaded');
  } else {
    const empty = (has(table, 'seat_header_empty') && table.seat_header_empty) || DEFAULT_STRINGS.seat_header_empty;
    node = el(doc, 'a', 'seat-header-link', empty);
    node.setAttribute('href', PICKER_HREF);
    root.setAttribute('data-state', 'empty');
  }
  root.replaceChildren(node);
  return node;
}

/** The seat a picker selection names: its panchayat's label and its ward id. */
export function seatFromSelection(config, selection) {
  if (!config || !selection) return null;
  const find = (list, id) => (Array.isArray(list) ? list.find((item) => item && item.id === id) : null) || null;
  const district = find(config.districts, selection.district);
  const samiti = district && find(district.samitis, selection.samiti);
  const panchayat = samiti && find(samiti.panchayats, selection.panchayat);
  if (!panchayat || !isText(panchayat.label)) return null;
  const ward = find(panchayat.wards, selection.ward);
  if (!ward) return null;
  return { seatType: 'ward', panchayat: panchayat.label, ward: String(ward.id) };
}

/**
 * The seat of a shown roll, from its ward key ("district/samiti/panchayat/ward",
 * see wardKeyFor in src/roll/rollStore.js), or null outside the catalogue.
 */
export function seatFromWardKey(config, wardKey) {
  if (typeof wardKey !== 'string') return null;
  const parts = wardKey.split('/');
  if (parts.length !== 4) return null;
  const [district, samiti, panchayat, ward] = parts;
  return seatFromSelection(config, { district, samiti, panchayat, ward });
}

function defaultStorage() {
  try {
    return globalThis.localStorage || null;
  } catch {
    return null;
  }
}

/** Store the seat (never voter data). Returns false if it could not be stored. */
export function saveSeat(seat, storage = defaultStorage()) {
  if (!storage || !isSeat(seat)) return false;
  const record = {
    schemaVersion: SEAT_SCHEMA_VERSION,
    seatType: seat.seatType,
    panchayat: seat.panchayat,
    ward: seat.seatType === 'sarpanch' ? null : seat.ward,
  };
  try {
    storage.setItem(SEAT_STORAGE_KEY, JSON.stringify(record));
    return true;
  } catch {
    return false;
  }
}

/**
 * Read the stored seat. Returns { seat, error }: seat is null when nothing is
 * stored or the record cannot be trusted, and error then says why
 * ('unknown-version' with the version found, 'corrupt' or 'unreadable').
 * A record from a version this code does not know is reported, never guessed at.
 */
export function loadSeat(storage = defaultStorage()) {
  let raw;
  try {
    raw = storage ? storage.getItem(SEAT_STORAGE_KEY) : null;
  } catch {
    return { seat: null, error: 'unreadable' };
  }
  if (raw == null) return { seat: null, error: null };
  let record;
  try {
    record = JSON.parse(raw);
  } catch {
    return { seat: null, error: 'corrupt' };
  }
  if (!record || typeof record !== 'object') return { seat: null, error: 'corrupt' };
  if (record.schemaVersion !== SEAT_SCHEMA_VERSION) {
    return { seat: null, error: 'unknown-version', version: record.schemaVersion };
  }
  const seat = { seatType: record.seatType, panchayat: record.panchayat };
  if (record.seatType !== 'sarpanch') seat.ward = record.ward;
  return isSeat(seat) ? { seat, error: null } : { seat: null, error: 'corrupt' };
}
