// The SEC catalogue loader and selection helpers (src/picker/catalogue.js,
// issue #122), over the test catalogue in test/fixtures/catalogue/ and the
// committed statewide index.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  CATALOGUE_SCHEMA_VERSION, CatalogueLoadError, CatalogueVersionError, LAST_SELECTION_KEY,
  buildSelection, createCatalogue, filterPanchayats, isSelection, loadLastSelection,
  parseIndex, parseShard, saveLastSelection, toRollSelection,
} from '../src/picker/catalogue.js';
import { catalogueResponse } from './helpers/picker.js';

const read = (rel) => JSON.parse(readFileSync(new URL('../' + rel, import.meta.url), 'utf8'));
const index = read('test/fixtures/catalogue/index.json');
const jaipur = read('test/fixtures/catalogue/jaipur.json');
const JAIPUR = { id: '17', name: 'जयपुर', nameLatin: 'JAIPUR', file: 'jaipur.json' };

function fixtureFetch(log = [], fail = () => false) {
  return async (url) => {
    log.push(url);
    if (fail(url)) return new Response('', { status: 503 });
    return catalogueResponse(url, 'test/fixtures/catalogue/');
  };
}

function memoryStorage() {
  const stored = new Map();
  return {
    stored,
    getItem: (k) => stored.get(k) ?? null,
    setItem: (k, v) => { stored.set(k, String(v)); },
    removeItem: (k) => { stored.delete(k); },
  };
}

test('the committed statewide index and every shard carry the schemaVersion the loader knows', () => {
  const statewide = read('data/sec/catalogue/index.json');
  const parsed = parseIndex(statewide);
  assert.equal(parsed.districts.length, statewide.districts.length);
  assert.equal(CATALOGUE_SCHEMA_VERSION, 1);
  for (const d of parsed.districts) {
    assert.match(d.name, /[ऀ-ॿ]/, d.id);
    assert.match(d.file, /^[a-z0-9-]+\.json$/);
  }
  const shard = parseShard(read('data/sec/catalogue/jaipur.json'), parsed.districts.find((d) => d.id === '17'));
  const badli = shard.panchayats.find((p) => p.id === '6313');
  assert.equal(badli.name, 'बडली');
  assert.equal(badli.block.id, '125');
  assert.deepEqual(badli.wards.map((w) => w.ward), [1, 2, 3, 4, 5, 6, 7]);
});

test('an index or shard of an unknown or missing schemaVersion is a CatalogueVersionError', () => {
  for (const version of [2, 0, '1', null, undefined]) {
    assert.throws(() => parseIndex({ ...index, schemaVersion: version }), CatalogueVersionError, String(version));
    assert.throws(() => parseShard({ ...jaipur, schemaVersion: version }, JAIPUR), CatalogueVersionError);
  }
  const err = (() => { try { parseIndex({ ...index, schemaVersion: 7 }); } catch (e) { return e; } })();
  assert.equal(err.version, 7);
  assert.throws(() => parseIndex(null), CatalogueLoadError);
  assert.throws(() => parseIndex({ schemaVersion: 1 }), CatalogueLoadError);
  assert.throws(() => parseShard({ ...jaipur, id: '1' }, JAIPUR), CatalogueLoadError, 'a shard of another district');
});

test('index entries naming a file outside the catalogue folder are dropped', () => {
  const doc = {
    ...index,
    districts: [...index.districts, { id: '99', name: 'बाहर', file: '../../config/constituency.json' },
      { id: '98', name: 'बाहर', file: 'https://other.test/x.json' }],
  };
  assert.deepEqual(parseIndex(doc).districts.map((d) => d.id), ['1', '17']);
});

test('the index is fetched once; a shard only when asked for, once, and again after a failure', async () => {
  const log = [];
  let fail = true;
  const catalogue = createCatalogue({ fetch: fixtureFetch(log, (url) => fail && url.endsWith('jaipur.json')) });
  const loaded = await catalogue.loadIndex();
  await catalogue.loadIndex();
  assert.deepEqual(log, ['data/sec/catalogue/index.json']);
  await assert.rejects(catalogue.loadShard(loaded.districts[1]), CatalogueLoadError);
  fail = false;
  const shard = await catalogue.loadShard(loaded.districts[1]);
  await catalogue.loadShard(loaded.districts[1]);
  assert.equal(shard.id, '17');
  assert.deepEqual(log, ['data/sec/catalogue/index.json', 'data/sec/catalogue/jaipur.json', 'data/sec/catalogue/jaipur.json']);
  await assert.rejects(catalogue.loadShard({ id: '1', file: '../x.json' }), CatalogueLoadError);
});

test('panchayat filter: Hindi (nukta and joiner differences ignored), block name, Latin letters in any case', () => {
  const { panchayats } = parseShard(jaipur, JAIPUR);
  const ids = (q) => filterPanchayats(panchayats, q).map((p) => p.id);
  assert.deepEqual(ids(''), ['6714', '6250', '6313']);
  assert.deepEqual(ids('  '), ['6714', '6250', '6313']);
  assert.deepEqual(ids('बडली'), ['6313']);
  assert.deepEqual(ids('बड़ली'), ['6313'], 'a typed nukta still matches');
  assert.deepEqual(ids('चाकसू'), ['6313']);
  assert.deepEqual(ids('badli'), ['6313']);
  assert.deepEqual(ids('ACH'), ['6250']);
  assert.deepEqual(ids('zzz'), []);
});

test('a sarpanch selection holds every ward in ward-number order; a ward panch selection exactly one', () => {
  const district = parseIndex(index).districts[1];
  const badli = parseShard(jaipur, JAIPUR).panchayats.find((p) => p.id === '6313');
  assert.deepEqual(jaipur.panchayats.find((p) => p.id === '6313').wards.map((w) => w.ward), [7, 6, 5, 4, 3, 2, 1],
    'the fixture lists them out of order');
  const all = buildSelection('sarpanch', district, badli);
  assert.deepEqual(Object.keys(all).sort(), ['district', 'panchayat', 'schemaVersion', 'seatType', 'wards']);
  assert.equal(all.schemaVersion, 1);
  assert.deepEqual(all.wards.map((w) => w.ward), [1, 2, 3, 4, 5, 6, 7]);
  for (const w of all.wards) assert.deepEqual(Object.keys(w), ['ward', 'pdfUrl']);
  const one = buildSelection('ward-panch', district, badli, '4');
  assert.equal(one.seatType, 'ward-panch');
  assert.deepEqual(one.wards, [all.wards[3]]);
  assert.equal(buildSelection('ward-panch', district, badli, '8'), null);
  assert.equal(buildSelection('ward-panch', district, badli), null);
  assert.equal(buildSelection('panch', district, badli, '1'), null);
  assert.ok(isSelection(all) && isSelection(one));
  assert.equal(isSelection({ ...one, wards: all.wards }), false, 'a ward panch has one ward');
});

test('a ward panch selection opens in the roll flow by its constituency ids; a sarpanch one does not (yet)', () => {
  const district = parseIndex(index).districts[1];
  const badli = parseShard(jaipur, JAIPUR).panchayats.find((p) => p.id === '6313');
  assert.deepEqual(toRollSelection(buildSelection('ward-panch', district, badli, '1')), {
    district: '17', samiti: '125', panchayat: '6313', ward: '1',
    pdfUrl: 'https://esuchiroll.rajasthan.gov.in/Publication_PDF_2026/PRI/Final/125/BADLI-Ward%20No-001.pdf',
  });
  assert.equal(toRollSelection(buildSelection('sarpanch', district, badli)), null);
  assert.equal(toRollSelection(null), null);
});

test('the last selection is stored with its schemaVersion; an unknown version or broken record is discarded', () => {
  const district = parseIndex(index).districts[1];
  const badli = parseShard(jaipur, JAIPUR).panchayats.find((p) => p.id === '6313');
  const selection = buildSelection('sarpanch', district, badli);
  const storage = memoryStorage();
  assert.deepEqual(loadLastSelection(storage), { selection: null, error: null });
  assert.equal(saveLastSelection(selection, storage), true);
  assert.equal(JSON.parse(storage.stored.get(LAST_SELECTION_KEY)).schemaVersion, 1);
  assert.deepEqual(loadLastSelection(storage), { selection, error: null });
  assert.equal(saveLastSelection({ ...selection, schemaVersion: 2 }, storage), false, 'only a known shape is stored');

  storage.setItem(LAST_SELECTION_KEY, JSON.stringify({ ...selection, schemaVersion: 2 }));
  assert.deepEqual(loadLastSelection(storage), { selection: null, error: 'unknown-version', version: 2 });
  assert.equal(storage.stored.has(LAST_SELECTION_KEY), false);

  for (const raw of ['{', '[]', JSON.stringify({ ...selection, wards: [] })]) {
    storage.setItem(LAST_SELECTION_KEY, raw);
    assert.equal(loadLastSelection(storage).error, 'corrupt', raw);
    assert.equal(storage.stored.has(LAST_SELECTION_KEY), false);
  }
  assert.equal(loadLastSelection({ getItem() { throw new Error('denied'); } }).error, 'unreadable');
  assert.equal(saveLastSelection(selection, null), false);
});
