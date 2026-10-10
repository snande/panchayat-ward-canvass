// The SEC ward catalogue (data/sec/catalogue/): an index of districts and a
// shard per district. A file of an unknown schemaVersion is never read.

import { normalize } from '../search/hindiSearch.js';

export const CATALOGUE_SCHEMA_VERSION = 1;
export const CATALOGUE_BASE = 'data/sec/catalogue/';
export const SELECTION_SCHEMA_VERSION = 1;
export const LAST_SELECTION_KEY = 'ward-canvass-last-selection';
const SEATS = ['ward-panch', 'sarpanch'];
// Only plain file names inside the catalogue folder.
const SHARD_FILE = /^[a-z0-9][a-z0-9-]*\.json$/;

const isText = (v) => typeof v === 'string' && v.trim() !== '';

export class CatalogueVersionError extends Error {
  constructor(url, version) {
    super(`catalogue version not supported: ${url} has schemaVersion ${JSON.stringify(version)}`);
    this.name = 'CatalogueVersionError';
    this.version = version;
  }
}

export class CatalogueLoadError extends Error {
  constructor(url, reason) {
    super(`catalogue ${url}: ${reason}`);
    this.name = 'CatalogueLoadError';
  }
}

function check(doc, url, list) {
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) throw new CatalogueLoadError(url, 'not an object');
  if (doc.schemaVersion !== CATALOGUE_SCHEMA_VERSION) throw new CatalogueVersionError(url, doc.schemaVersion);
  if (!Array.isArray(doc[list])) throw new CatalogueLoadError(url, `no ${list}`);
}

const named = (x) => ({ id: x.id, name: isText(x.name) ? x.name : x.nameLatin, nameLatin: isText(x.nameLatin) ? x.nameLatin : '' });
const usable = (x) => x && isText(x.id) && (isText(x.name) || isText(x.nameLatin));

export function parseIndex(doc, url = CATALOGUE_BASE + 'index.json') {
  check(doc, url, 'districts');
  const districts = doc.districts.filter((d) => usable(d) && SHARD_FILE.test(String(d.file)))
    .map((d) => ({ ...named(d), file: d.file }));
  return { schemaVersion: doc.schemaVersion, districts };
}

function wardList(list) {
  const seen = new Set();
  return (Array.isArray(list) ? list : [])
    .filter((w) => w && Number.isInteger(w.ward) && w.ward > 0 && isText(w.pdfUrl) && !seen.has(w.ward) && seen.add(w.ward))
    .map((w) => ({ ward: w.ward, pdfUrl: w.pdfUrl }))
    .sort((a, b) => a.ward - b.ward);
}

export function parseShard(doc, district, url = CATALOGUE_BASE + (district ? district.file : '')) {
  check(doc, url, 'panchayats');
  if (district && doc.id !== district.id) throw new CatalogueLoadError(url, `shard of district ${doc.id}`);
  const panchayats = doc.panchayats.filter(usable).map((p) => ({
    ...named(p), block: p.block && isText(p.block.id) ? named(p.block) : null, wards: wardList(p.wards),
  }));
  return { ...named(doc), panchayats };
}

/** Loaders that fetch each file at most once per page (a failure is retried). */
export function createCatalogue({ fetch, base = CATALOGUE_BASE } = {}) {
  const cache = new Map();
  function load(file, parse) {
    const url = base + file;
    if (!cache.has(url)) {
      const pending = Promise.resolve()
        .then(() => (fetch || globalThis.fetch)(url))
        .then((r) => {
          if (!r.ok) throw new CatalogueLoadError(url, `HTTP ${r.status}`);
          return r.json();
        })
        .then((doc) => parse(doc, url));
      cache.set(url, pending);
      pending.catch(() => cache.delete(url));
    }
    return cache.get(url);
  }
  return {
    loadIndex: () => load('index.json', parseIndex),
    loadShard: (d) => (d && SHARD_FILE.test(String(d.file))
      ? load(d.file, (doc, url) => parseShard(doc, d, url))
      : Promise.reject(new CatalogueLoadError(String(d && d.file), 'not a shard'))),
  };
}

export const panchayatLabel = (p) => (p.block && isText(p.block.name) ? `${p.name} (${p.block.name})` : p.name);

// Matches the Hindi or block name, or (any case) the Latin name.
export function filterPanchayats(panchayats, query) {
  const list = Array.isArray(panchayats) ? panchayats : [];
  const q = normalize(query);
  if (!q) return list;
  const latin = q.toLowerCase();
  return list.filter((p) => normalize(p.name).includes(q) || (p.block && normalize(p.block.name).includes(q))
    || (isText(p.nameLatin) && p.nameLatin.toLowerCase().includes(latin)));
}

/**
 * The picker's selection: { schemaVersion, seatType, district, panchayat,
 * wards: [{ ward, pdfUrl }] }; every ward in ward-number order for a sarpanch,
 * the one ward for a ward panch. Null if that leaves no ward.
 */
export function buildSelection(seatType, district, panchayat, wardNumber) {
  if (!SEATS.includes(seatType) || !district || !panchayat) return null;
  const all = wardList(panchayat.wards);
  const wards = seatType === 'sarpanch' ? all : all.filter((w) => w.ward === Number(wardNumber));
  if (wards.length === 0) return null;
  return {
    schemaVersion: SELECTION_SCHEMA_VERSION,
    seatType,
    district: { id: district.id, name: district.name, nameLatin: district.nameLatin || '' },
    panchayat: { ...named(panchayat), block: panchayat.block ? { ...panchayat.block } : null },
    wards,
  };
}

export function isSelection(s) {
  if (!s || typeof s !== 'object' || s.schemaVersion !== SELECTION_SCHEMA_VERSION || !SEATS.includes(s.seatType)) return false;
  if (!s.district || !isText(s.district.id) || !s.panchayat || !isText(s.panchayat.id) || !isText(s.panchayat.name)) return false;
  if (!Array.isArray(s.wards) || s.wards.length === 0 || (s.seatType === 'ward-panch' && s.wards.length !== 1)) return false;
  return s.wards.every((w) => w && Number.isInteger(w.ward) && isText(w.pdfUrl));
}

/** A ward panch selection as src/roll/rollFlow.js opens it; null for a sarpanch. */
export function toRollSelection(s) {
  if (!isSelection(s) || s.seatType !== 'ward-panch') return null;
  const block = s.panchayat.block;
  return {
    district: s.district.id,
    samiti: block && isText(block.id) ? block.id : '',
    panchayat: s.panchayat.id,
    ward: String(s.wards[0].ward),
    pdfUrl: s.wards[0].pdfUrl,
  };
}

function storageOr(storage) {
  try {
    return storage === undefined ? globalThis.localStorage || null : storage;
  } catch {
    return null;
  }
}

/** Keep the last selection (seat, names, roll URLs; never voter data). */
export function saveLastSelection(selection, storage) {
  const store = storageOr(storage);
  if (!store || !isSelection(selection)) return false;
  try {
    store.setItem(LAST_SELECTION_KEY, JSON.stringify(selection));
    return true;
  } catch {
    return false;
  }
}

/**
 * The last selection, as { selection, error }. A record of an unknown
 * schemaVersion ('unknown-version') or a broken one ('corrupt') is deleted,
 * so the picker opens empty rather than misreading it.
 */
export function loadLastSelection(storage) {
  const store = storageOr(storage);
  let raw;
  try {
    raw = store ? store.getItem(LAST_SELECTION_KEY) : null;
  } catch {
    return { selection: null, error: 'unreadable' };
  }
  if (raw == null) return { selection: null, error: null };
  let record = null;
  try {
    record = JSON.parse(raw);
  } catch {
    // corrupt, below
  }
  if (isSelection(record)) return { selection: record, error: null };
  try {
    store.removeItem(LAST_SELECTION_KEY);
  } catch {
    // ignored either way
  }
  const unknown = record && typeof record === 'object' && !Array.isArray(record)
    && record.schemaVersion !== SELECTION_SCHEMA_VERSION;
  return unknown
    ? { selection: null, error: 'unknown-version', version: record.schemaVersion }
    : { selection: null, error: 'corrupt' };
}
