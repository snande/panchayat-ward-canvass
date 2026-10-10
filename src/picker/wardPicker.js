// Pure ward-picker helpers over the sharded catalogue
// (src/picker/catalogueLoader.js): no DOM, no network. A selection is only
// ever built from a checked shard's entries, so a pdfUrl never comes from
// anywhere else.
//
// The selection the picker emits:
//   { schemaVersion, seatType: 'ward-panch' | 'sarpanch',
//     district: { id, name, nameLatin },
//     panchayat: { id, name, nameLatin, block: { id, name, nameLatin } },
//     wards: [{ ward, pdfUrl }] }
// A ward panch's selection holds exactly its one ward; a sarpanch's holds
// every ward of the panchayat, in ward-number order.

import { normalize } from '../search/hindiSearch.js';
import { urlList } from '../roll/supplementTags.js';

export const SELECTION_SCHEMA_VERSION = 1;
export const SEAT_WARD_PANCH = 'ward-panch';
export const SEAT_SARPANCH = 'sarpanch';
export const SEAT_TYPES = [SEAT_WARD_PANCH, SEAT_SARPANCH];

const isText = (value) => typeof value === 'string' && value.trim() !== '';
const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

/** The index's districts as options: { id, label (Hindi), latin }. */
export function districtOptions(index) {
  const list = index && Array.isArray(index.districts) ? index.districts : [];
  return list.map((d) => ({ id: d.id, label: d.name, latin: d.nameLatin }));
}

/** A shard's panchayat by id, or null. */
export function findPanchayat(shard, panchayatId) {
  const list = shard && Array.isArray(shard.panchayats) ? shard.panchayats : [];
  return list.find((p) => p.id === panchayatId) || null;
}

/** Fold a name or a typed query so Hindi spellings and Latin case compare equal. */
export function foldName(text) {
  return normalize(text).toLowerCase();
}

/**
 * The panchayats whose Hindi name or Latin name (nameLatin) contains the
 * typed query; names starting with it come first, otherwise the shard's
 * order is kept. An empty query keeps every panchayat.
 */
export function filterPanchayats(panchayats, query) {
  const list = Array.isArray(panchayats) ? panchayats : [];
  const q = foldName(query);
  if (!q) return list.slice();
  const starts = [];
  const contains = [];
  for (const p of list) {
    const names = [foldName(p.name), foldName(p.nameLatin)];
    if (names.some((n) => n.startsWith(q))) starts.push(p);
    else if (names.some((n) => n.includes(q))) contains.push(p);
  }
  return starts.concat(contains);
}

/** A panchayat's wards in ward-number order. */
export function sortedWards(panchayat) {
  const list = panchayat && Array.isArray(panchayat.wards) ? panchayat.wards : [];
  return list.slice().sort((a, b) => a.ward - b.ward);
}

const named = ({ id, name, nameLatin }) => ({ id, name, nameLatin });

/**
 * The selection for a seat: a ward panch's one ward (wardNumber, a number or
 * its decimal string) or, for a sarpanch, every ward. Null when the seat
 * type, district, panchayat or ward is not one the catalogue lists.
 */
export function buildSelection(seatType, district, panchayat, wardNumber) {
  if (!SEAT_TYPES.includes(seatType) || !isObject(district) || !isObject(panchayat)) return null;
  const all = sortedWards(panchayat);
  let wards;
  if (seatType === SEAT_SARPANCH) {
    wards = all;
  } else {
    const ward = all.find((w) => String(w.ward) === String(wardNumber));
    wards = ward ? [ward] : [];
  }
  if (wards.length === 0) return null;
  return {
    schemaVersion: SELECTION_SCHEMA_VERSION,
    seatType,
    district: named(district),
    panchayat: { ...named(panchayat), block: named(panchayat.block) },
    wards: wards.map(({ ward, pdfUrl }) => ({ ward, pdfUrl })),
  };
}

/** A selection of the shape above with a known schemaVersion. */
export function isSelection(value) {
  if (!isObject(value) || value.schemaVersion !== SELECTION_SCHEMA_VERSION) return false;
  if (!SEAT_TYPES.includes(value.seatType)) return false;
  const d = value.district;
  const p = value.panchayat;
  if (!isObject(d) || !isText(d.id) || !isText(d.name)) return false;
  if (!isObject(p) || !isText(p.id) || !isText(p.name) || !isObject(p.block) || !isText(p.block.id)) return false;
  if (!Array.isArray(value.wards) || value.wards.length === 0) return false;
  if (value.seatType === SEAT_WARD_PANCH && value.wards.length !== 1) return false;
  return value.wards.every((w) => isObject(w) && Number.isInteger(w.ward) && isText(w.pdfUrl));
}

/**
 * The roll flow's selection for one ward of a picker selection
 * (src/roll/rollFlow.js: district, samiti, panchayat and ward ids, pdfUrl and
 * the supplementary roll URLs), with the supplement taken from the shard's
 * panchayat entry when it is given.
 */
export function rollSelectionFor(selection, ward, panchayat = null) {
  if (!isObject(selection) || !isObject(ward) || !isText(ward.pdfUrl)) return null;
  const roll = {
    district: selection.district.id,
    samiti: selection.panchayat.block.id,
    panchayat: selection.panchayat.id,
    ward: String(ward.ward),
    pdfUrl: ward.pdfUrl,
  };
  const entry = panchayat ? sortedWards(panchayat).find((w) => w.ward === ward.ward) : null;
  if (entry && entry.supplementUrl) roll.supplementPdfUrls = urlList([entry.supplementUrl]);
  return roll;
}

function wardKeyParts(wardKey) {
  if (typeof wardKey !== 'string') return null;
  const parts = wardKey.split('/');
  if (parts.length !== 4 || parts.some((part) => part === '')) return null;
  const [district, samiti, panchayat, ward] = parts;
  return { district, samiti, panchayat, ward };
}

/** The district id of a roll's ward key ("district/samiti/panchayat/ward"), or null. */
export function districtOfWardKey(wardKey) {
  const parts = wardKeyParts(wardKey);
  return parts ? parts.district : null;
}

/**
 * The ward a roll's ward key names in a district shard, as
 * { selection (a ward panch's), rollSelection, seat (src/ui/seatHeader.js) },
 * or null when the shard does not list it.
 */
export function wardForWardKey(shard, wardKey) {
  const parts = wardKeyParts(wardKey);
  if (!parts || !shard || shard.id !== parts.district) return null;
  const panchayat = findPanchayat(shard, parts.panchayat);
  if (!panchayat || panchayat.block.id !== parts.samiti) return null;
  const selection = buildSelection(SEAT_WARD_PANCH, shard, panchayat, parts.ward);
  if (!selection) return null;
  return {
    selection,
    rollSelection: rollSelectionFor(selection, selection.wards[0], panchayat),
    seat: { seatType: 'ward', panchayat: panchayat.name, ward: String(selection.wards[0].ward) },
  };
}
