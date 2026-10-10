// The sharded statewide catalogue (tools/sec-catalogue): index.json lists the
// districts, each district's file its panchayats (with block and wards); names
// in Hindi with nameLatin beside. An unknown schemaVersion or a wrong shape
// rejects with a CatalogueError, never a misread list. A selection is
// {schemaVersion, seatType, district, panchayat (with block), wards:
// [{ward, pdfUrl, supplementUrl}]} in ward order: one ward for a ward panch,
// every ward for a sarpanch.

import { normalize } from '../search/hindiSearch.js';

export const CATALOGUE_BASE = 'data/sec/catalogue/';
export const CATALOGUE_INDEX_URL = `${CATALOGUE_BASE}index.json`;
/** The catalogue schemaVersions this code reads. */
export const CATALOGUE_SCHEMA_VERSIONS = Object.freeze([1]);
export const SELECTION_SCHEMA_VERSION = 1;
export const SEAT_TYPES = Object.freeze(['ward-panch', 'sarpanch']);

// A shard is a plain file name beside the index: no path, no traversal.
const SHARD_FILE = /^[a-z0-9][a-z0-9_-]*\.json$/i;

/** kind: 'network' (retry when online), 'version' (update the app) or 'corrupt'. */
export class CatalogueError extends Error {
  constructor(kind, message, detail = {}) {
    super(message);
    this.name = 'CatalogueError';
    this.kind = kind;
    Object.assign(this, detail);
  }
}

const isText = (v) => typeof v === 'string' && v.trim() !== '';
const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isWardNumber = (v) => Number.isInteger(v) && v > 0;
const isHttps = (v) => typeof v === 'string' && v.startsWith('https://');
const isNamed = (item) => isObject(item) && isText(item.id) && isText(item.name);
const named = (item) => ({ id: item.id, name: item.name, nameLatin: isText(item.nameLatin) ? item.nameLatin : item.name });
const corrupt = (url, why) => new CatalogueError('corrupt', `${url}: ${why}`, { url });

function checkVersion(url, doc) {
  if (!isObject(doc)) throw corrupt(url, 'not a JSON object');
  if (!CATALOGUE_SCHEMA_VERSIONS.includes(doc.schemaVersion)) {
    throw new CatalogueError('version', `${url}: unknown schemaVersion ${doc.schemaVersion}`, { url, version: doc.schemaVersion });
  }
}

/** The index's districts, checked: {schemaVersion, districts: [{id, name, nameLatin, file}]}. */
export function readIndex(doc, url = CATALOGUE_INDEX_URL) {
  checkVersion(url, doc);
  if (!Array.isArray(doc.districts)) throw corrupt(url, 'no districts list');
  const districts = doc.districts.map((d) => {
    if (!isNamed(d) || typeof d.file !== 'string' || !SHARD_FILE.test(d.file)) throw corrupt(url, `bad district ${JSON.stringify(d)}`);
    return { ...named(d), file: d.file };
  });
  return { schemaVersion: doc.schemaVersion, districts };
}

function readWard(url, w) {
  if (!isObject(w) || !isWardNumber(w.ward) || !isHttps(w.pdfUrl)
    || (w.supplementUrl != null && !isHttps(w.supplementUrl))) throw corrupt(url, `bad ward ${JSON.stringify(w)}`);
  return { ward: w.ward, pdfUrl: w.pdfUrl, supplementUrl: w.supplementUrl || null };
}

/** A district's shard, checked: {id, name, nameLatin, panchayats}, wards sorted by number. */
export function readShard(doc, district, url = CATALOGUE_BASE + (district && district.file)) {
  checkVersion(url, doc);
  if (!isNamed(doc) || (district && doc.id !== district.id)) throw corrupt(url, 'not this district\'s file');
  if (!Array.isArray(doc.panchayats)) throw corrupt(url, 'no panchayats list');
  const panchayats = doc.panchayats.map((p) => {
    if (!isNamed(p) || !isNamed(p.block) || !Array.isArray(p.wards)) throw corrupt(url, `bad panchayat ${JSON.stringify(p && p.id)}`);
    const wards = p.wards.map((w) => readWard(url, w)).sort((a, b) => a.ward - b.ward);
    if (wards.some((w, i) => i > 0 && w.ward === wards[i - 1].ward)) throw corrupt(url, `panchayat ${p.id} lists a ward twice`);
    return { ...named(p), block: named(p.block), wards };
  });
  return { ...named(doc), panchayats };
}

// loadIndex() fetches only the index, loadShard(district) only its file;
// once each, and a failure is forgotten so the next ask retries.
export function createCatalogue(deps = {}) {
  const base = deps.base || CATALOGUE_BASE;
  const files = new Map();

  async function getJson(url) {
    let response;
    try {
      response = await (deps.fetch || globalThis.fetch)(url);
    } catch (err) {
      throw new CatalogueError('network', `${url}: ${err && err.message}`, { url });
    }
    if (!response || !response.ok) throw new CatalogueError('network', `${url}: HTTP ${response && response.status}`, { url });
    try {
      return await response.json();
    } catch {
      throw corrupt(url, 'not JSON');
    }
  }

  function once(url, read) {
    if (!files.has(url)) {
      files.set(url, getJson(url).then(read).catch((err) => {
        files.delete(url);
        throw err;
      }));
    }
    return files.get(url);
  }

  return {
    loadIndex: () => once(`${base}index.json`, (doc) => readIndex(doc, `${base}index.json`)),
    loadShard(district) {
      if (!district || typeof district.file !== 'string' || !SHARD_FILE.test(district.file)) {
        return Promise.reject(corrupt(String(district && district.file), 'not a shard file name'));
      }
      return once(base + district.file, (doc) => readShard(doc, district, base + district.file));
    },
  };
}

/** The panchayats whose Hindi or Latin name holds the typed text. */
export function filterPanchayats(panchayats, query) {
  const list = Array.isArray(panchayats) ? panchayats : [];
  const q = normalize(query).toLowerCase();
  if (!q) return list;
  return list.filter((p) => normalize(p.name).toLowerCase().includes(q) || normalize(p.nameLatin).toLowerCase().includes(q));
}

/** A ward panch's one ward (ward given) or a sarpanch's every ward; null if not in the shard. */
export function buildSelection(seatType, district, panchayat, ward = null) {
  if (!SEAT_TYPES.includes(seatType) || !isNamed(district) || !isNamed(panchayat)) return null;
  const all = Array.isArray(panchayat.wards) ? panchayat.wards : [];
  const wards = seatType === 'sarpanch' ? all : all.filter((w) => w.ward === ward);
  if (wards.length === 0) return null;
  return {
    schemaVersion: SELECTION_SCHEMA_VERSION,
    seatType,
    district: named(district),
    panchayat: { ...named(panchayat), block: named(panchayat.block) },
    wards: wards.map((w) => ({ ward: w.ward, pdfUrl: w.pdfUrl, supplementUrl: w.supplementUrl || null })),
  };
}

/** A selection this code can use as is: its version and shape both checked. */
export function isSelection(sel) {
  if (!isObject(sel) || sel.schemaVersion !== SELECTION_SCHEMA_VERSION || !SEAT_TYPES.includes(sel.seatType)) return false;
  if (!isNamed(sel.district) || !isNamed(sel.panchayat) || !isNamed(sel.panchayat.block)) return false;
  if (!Array.isArray(sel.wards) || sel.wards.length === 0) return false;
  if (sel.seatType === 'ward-panch' && sel.wards.length !== 1) return false;
  return sel.wards.every((w) => isObject(w) && isWardNumber(w.ward) && isHttps(w.pdfUrl)
    && (w.supplementUrl == null || isHttps(w.supplementUrl)));
}

/** What the roll flow opens for one ward: ward key "district/block/panchayat/ward". */
export function wardRollSelection(selection, wardEntry) {
  const roll = {
    district: selection.district.id,
    samiti: selection.panchayat.block.id,
    panchayat: selection.panchayat.id,
    ward: String(wardEntry.ward),
    pdfUrl: wardEntry.pdfUrl,
  };
  if (wardEntry.supplementUrl) roll.supplementPdfUrls = [wardEntry.supplementUrl];
  return roll;
}

/** The ward of a selection whose roll is stored under wardKey, or null. */
export function wardForKey(selection, wardKey) {
  if (!isSelection(selection) || typeof wardKey !== 'string') return null;
  const prefix = [selection.district.id, selection.panchayat.block.id, selection.panchayat.id].join('/');
  return selection.wards.find((w) => `${prefix}/${w.ward}` === wardKey) || null;
}
