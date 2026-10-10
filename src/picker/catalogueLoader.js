// The sharded SEC ward catalogue (tools/sec-catalogue/build_catalogue.py):
// data/sec/catalogue/index.json lists the districts, and each district's
// panchayats and wards are in its own shard, fetched only when that district
// is chosen. Every file carries schemaVersion; a file of a version this code
// does not know, or of a shape it cannot read, is rejected whole with a
// CatalogueError, never read as a shorter or garbled list.
//
// Index:  { schemaVersion, districts: [{ id, name, nameLatin, file, panchayatCount }] }
// Shard:  { schemaVersion, id, name, nameLatin,
//           panchayats: [{ id, name, nameLatin, block: { id, name, nameLatin },
//                          wards: [{ ward, pdfUrl, supplementUrl }] }] }

export const CATALOGUE_SCHEMA_VERSION = 1;
export const CATALOGUE_BASE = 'data/sec/catalogue/';
export const CATALOGUE_INDEX_FILE = 'index.json';

// A shard is named by the index; only a plain file name beside it is fetched.
const SHARD_FILE = /^[a-z0-9][a-z0-9_-]*\.json$/;

/**
 * Why a catalogue file could not be used: 'unsupported-version' (a
 * schemaVersion this code does not know: update the app), 'invalid' (not the
 * catalogue's shape) or 'network' (not fetched: offline or an HTTP error).
 */
export class CatalogueError extends Error {
  constructor(kind, message, version) {
    super(message);
    this.name = 'CatalogueError';
    this.kind = kind;
    if (version !== undefined) this.version = version;
  }
}

const isText = (value) => typeof value === 'string' && value.trim() !== '';
const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

function invalid(what, message) {
  return new CatalogueError('invalid', `${what}: ${message}`);
}

function checkVersion(doc, what) {
  if (!isObject(doc)) throw invalid(what, 'not a JSON object');
  if (doc.schemaVersion !== CATALOGUE_SCHEMA_VERSION) {
    throw new CatalogueError('unsupported-version',
      `${what}: catalogue schemaVersion ${JSON.stringify(doc.schemaVersion)} is not supported`, doc.schemaVersion);
  }
}

function checkNamed(item, what) {
  if (!isObject(item) || !isText(item.id) || !isText(item.name) || typeof item.nameLatin !== 'string') {
    throw invalid(what, 'an entry lacks id, name or nameLatin');
  }
}

/** The index document, checked; throws a CatalogueError otherwise. */
export function checkIndex(doc) {
  const what = CATALOGUE_INDEX_FILE;
  checkVersion(doc, what);
  if (!Array.isArray(doc.districts)) throw invalid(what, 'no districts list');
  const seen = new Set();
  for (const district of doc.districts) {
    checkNamed(district, what);
    if (typeof district.file !== 'string' || !SHARD_FILE.test(district.file) || district.file === CATALOGUE_INDEX_FILE) {
      throw invalid(what, `district ${district.id} names no shard file`);
    }
    if (seen.has(district.id)) throw invalid(what, `district ${district.id} is listed twice`);
    seen.add(district.id);
  }
  return doc;
}

function checkWard(ward, what) {
  if (!isObject(ward) || !Number.isInteger(ward.ward) || ward.ward < 1) throw invalid(what, 'a ward has no ward number');
  if (typeof ward.pdfUrl !== 'string' || !ward.pdfUrl.startsWith('https://')) {
    throw invalid(what, `ward ${ward.ward} has no pdfUrl`);
  }
  if (ward.supplementUrl != null && (typeof ward.supplementUrl !== 'string' || !ward.supplementUrl.startsWith('https://'))) {
    throw invalid(what, `ward ${ward.ward} has a malformed supplementUrl`);
  }
}

/** A district shard, checked against its index entry; throws a CatalogueError otherwise. */
export function checkShard(doc, district) {
  const what = (district && district.file) || 'district shard';
  checkVersion(doc, what);
  checkNamed(doc, what);
  if (district && doc.id !== district.id) throw invalid(what, `holds district ${doc.id}, not ${district.id}`);
  if (!Array.isArray(doc.panchayats)) throw invalid(what, 'no panchayats list');
  for (const panchayat of doc.panchayats) {
    checkNamed(panchayat, what);
    checkNamed(panchayat.block, what);
    if (!Array.isArray(panchayat.wards)) throw invalid(what, `panchayat ${panchayat.id} has no wards list`);
    const numbers = new Set();
    for (const ward of panchayat.wards) {
      checkWard(ward, what);
      if (numbers.has(ward.ward)) throw invalid(what, `panchayat ${panchayat.id} lists ward ${ward.ward} twice`);
      numbers.add(ward.ward);
    }
  }
  return doc;
}

/**
 * The catalogue as the picker reads it: loadIndex() fetches only the index,
 * loadShard(districtId) fetches that district's shard (once; a failed fetch
 * is tried again on the next call). cachedShard(districtId) is a shard
 * already loaded, or null, with no request.
 * @param {{fetch?: Function, base?: string}} [opts]
 */
export function createCatalogueLoader(opts = {}) {
  const fetchImpl = opts.fetch || ((...args) => globalThis.fetch(...args));
  const base = opts.base == null ? CATALOGUE_BASE : opts.base;
  let index = null;
  const shards = new Map();
  const loaded = new Map();

  async function getJson(url) {
    let response;
    try {
      response = await fetchImpl(url);
    } catch (err) {
      throw new CatalogueError('network', `${url}: ${err && err.message ? err.message : err}`);
    }
    if (!response || !response.ok) {
      throw new CatalogueError('network', `${url}: HTTP ${response ? response.status : 'no response'}`);
    }
    try {
      return await response.json();
    } catch {
      throw invalid(url, 'not JSON');
    }
  }

  // A promise kept until it fails, so a retry fetches again.
  function remember(map, key, make) {
    if (map.has(key)) return map.get(key);
    const promise = make();
    map.set(key, promise);
    promise.catch(() => {
      if (map.get(key) === promise) map.delete(key);
    });
    return promise;
  }

  function loadIndex() {
    if (index) return index;
    const promise = getJson(base + CATALOGUE_INDEX_FILE).then(checkIndex);
    index = promise;
    promise.catch(() => {
      if (index === promise) index = null;
    });
    return promise;
  }

  function loadShard(districtId) {
    return remember(shards, districtId, async () => {
      const doc = await loadIndex();
      const district = doc.districts.find((d) => d.id === districtId);
      if (!district) throw invalid(CATALOGUE_INDEX_FILE, `no district ${districtId}`);
      const shard = checkShard(await getJson(base + district.file), district);
      loaded.set(districtId, shard);
      return shard;
    });
  }

  return {
    loadIndex,
    loadShard,
    cachedShard: (districtId) => loaded.get(districtId) || null,
  };
}
