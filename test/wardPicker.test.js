// Ward picker over the sharded catalogue (issues #15, #122): seat type ->
// district -> panchayat -> ward, lazy shard fetches, Hindi/Latin panchayat
// filter, its four states, catalogue version checks, the confirmation before
// a loaded seat is replaced, and the stored last selection. Runs over the
// test shards built from fixtures/sec/catalogue-input (fixtures/sec/catalogue)
// and the committed data/sec/catalogue. Run by `npm test`.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';

import {
  CATALOGUE_SCHEMA_VERSION, CatalogueError, checkIndex, checkShard, createCatalogueLoader,
} from '../src/picker/catalogueLoader.js';
import {
  buildSelection, filterPanchayats, rollSelectionFor, wardForWardKey, SELECTION_SCHEMA_VERSION,
} from '../src/picker/wardPicker.js';
import {
  LAST_SELECTION_KEY, loadLastSelection, saveLastSelection,
} from '../src/picker/lastSelection.js';
import { mountWardPicker, defaultIsOnline, FALLBACK_TEXT } from '../src/ui/wardPickerScreen.js';
import { createDocument, type } from './helpers/fakeDom.js';
import {
  choose, districtSelect, panchayatRow, seatButton, tap, wardSelect,
} from './helpers/pickWard.js';

const read = (rel) => readFileSync(new URL('../' + rel, import.meta.url), 'utf8');
const json = (rel) => JSON.parse(read(rel));
const strings = json('src/strings.hi.json');
const css = read('styles.css');
const BASE = 'data/sec/catalogue/';
const SEC_FINAL = 'https://esuchiroll.rajasthan.gov.in/Publication_PDF_2026/PRI/Final/';
const BADLI_WARD1 = `${SEC_FINAL}125/BADLI-Ward%20No-001.pdf`;

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
async function settle() {
  for (let i = 0; i < 5; i += 1) await tick();
}

const jsonResponse = (doc) => new Response(JSON.stringify(doc), { headers: { 'Content-Type': 'application/json' } });

// A fetch over a directory of catalogue files, with per-file overrides
// (a document, or a function returning a Response or throwing).
function catalogueFetch(dir = 'fixtures/sec/catalogue/', overrides = {}) {
  const requests = [];
  const fetch = async (url) => {
    requests.push(String(url));
    const name = String(url).slice(BASE.length);
    if (!String(url).startsWith(BASE)) return new Response('', { status: 404 });
    if (Object.prototype.hasOwnProperty.call(overrides, name)) {
      const o = overrides[name];
      return typeof o === 'function' ? o() : jsonResponse(o);
    }
    if (!existsSync(new URL(`../${dir}${name}`, import.meta.url))) return new Response('', { status: 404 });
    return new Response(read(dir + name));
  };
  return { fetch, requests };
}

async function mount({ dir, overrides, opts = {} } = {}) {
  const d = createDocument();
  const net = catalogueFetch(dir, overrides);
  const loader = createCatalogueLoader({ fetch: net.fetch });
  const picked = [];
  const picker = mountWardPicker(d.body, loader, strings, {
    isOnline: () => true,
    onSelect: (s, detail) => picked.push({ selection: s, detail }),
    ...opts,
  });
  await settle();
  return { d, picker, picked, requests: net.requests, loader };
}

async function openDistrict(picker, root, seat, district) {
  tap(seatButton(root, seat));
  choose(districtSelect(root), district);
  await settle();
}

const optionValues = (select) => select.children.map((o) => o.getAttribute('value'));
const rowIds = (root) => root.querySelectorAll('button.picker-panchayat-option').map((b) => b.getAttribute('data-id'));
const fieldOf = (node) => node.parentNode || null;

// The four step containers, in DOM order.
function steps(root) {
  return root.querySelectorAll('div.picker-field');
}

test('the picker asks seat type, then district, then panchayat, then ward', async () => {
  const { d, picker } = await mount();
  const [seat, district, panchayat, ward] = steps(d.body);
  assert.equal(steps(d.body).length, 4);
  assert.deepEqual(seat.querySelectorAll('button.picker-seat-option').map((b) => b.textContent), ['वार्ड पंच', 'सरपंच']);
  assert.ok(district.querySelector('select'), 'district is a select');
  assert.ok(panchayat.querySelector('input.field-input'), 'panchayat is a text field over a list');
  assert.ok(ward.querySelector('select'), 'ward is a select');
  assert.deepEqual(d.body.querySelectorAll('label').map((l) => l.textContent), ['ज़िला', 'ग्राम पंचायत', 'वार्ड']);

  // Each step shows only once the one before it is answered.
  assert.deepEqual([seat.hidden, district.hidden, panchayat.hidden, ward.hidden], [false, true, true, true]);
  tap(seatButton(d.body, 'ward-panch'));
  assert.equal(seatButton(d.body, 'ward-panch').getAttribute('aria-pressed'), 'true');
  assert.deepEqual([district.hidden, panchayat.hidden, ward.hidden], [false, true, true]);
  assert.deepEqual(optionValues(picker.selects.district), ['', '33', '22', '8', '6', '7']);
  choose(picker.selects.district, '7');
  await settle();
  assert.deepEqual([panchayat.hidden, ward.hidden], [false, true]);
  tap(panchayatRow(d.body, '2610'));
  assert.equal(ward.hidden, false);
  assert.deepEqual(optionValues(picker.selects.ward), ['', '1', '2', '3', '4', '5', '6', '7', '8', '9']);
});

test('a ward panch pick emits exactly one ward with its pdfUrl, and the selection fields', async () => {
  const { d, picker, picked } = await mount();
  await openDistrict(picker, d.body, 'ward-panch', '7');
  tap(panchayatRow(d.body, '2610'));
  assert.equal(picked.length, 0, 'nothing is emitted before the ward');
  choose(wardSelect(d.body), '3');
  assert.equal(picked.length, 1);
  const { selection, detail } = picked[0];
  assert.deepEqual(Object.keys(selection).sort(), ['district', 'panchayat', 'schemaVersion', 'seatType', 'wards']);
  assert.equal(selection.schemaVersion, SELECTION_SCHEMA_VERSION);
  assert.equal(selection.seatType, 'ward-panch');
  assert.equal(selection.district.id, '7');
  assert.equal(selection.district.name, 'भीलवाडा');
  assert.equal(selection.panchayat.id, '2610');
  assert.equal(selection.panchayat.block.id, '60');
  const shardWard = json('fixtures/sec/catalogue/bhilwara.json').panchayats[0].wards.find((w) => w.ward === 3);
  assert.deepEqual(selection.wards, [{ ward: 3, pdfUrl: shardWard.pdfUrl }]);
  assert.equal(detail.panchayat.id, '2610');
  assert.deepEqual(picker.wardSelection(), selection);
  assert.equal(picker.state(), 'success');
  assert.equal(picker.message.getAttribute('data-tone'), 'success');
});

test('a sarpanch pick skips the ward step and emits every ward in ward-number order', async () => {
  // Wards listed out of order in the shard still come out sorted.
  const shard = json('fixtures/sec/catalogue/bhilwara.json');
  shard.panchayats[0].wards.reverse();
  const { d, picker, picked } = await mount({ overrides: { 'bhilwara.json': shard } });
  await openDistrict(picker, d.body, 'sarpanch', '7');
  tap(panchayatRow(d.body, '2610'));
  assert.equal(fieldOf(wardSelect(d.body)).hidden, true, 'no ward step for a sarpanch');
  assert.equal(picked.length, 1);
  const { selection } = picked[0];
  assert.equal(selection.seatType, 'sarpanch');
  assert.deepEqual(selection.wards.map((w) => w.ward), [1, 2, 3, 4, 5, 6, 7, 8, 9]);
  const urls = new Map(shard.panchayats[0].wards.map((w) => [w.ward, w.pdfUrl]));
  for (const w of selection.wards) {
    assert.deepEqual(Object.keys(w).sort(), ['pdfUrl', 'ward']);
    assert.equal(w.pdfUrl, urls.get(w.ward));
  }
});

test('every fixture panchayat: ward panch emits one ward, sarpanch all of them', () => {
  const index = checkIndex(json('fixtures/sec/catalogue/index.json'));
  for (const district of index.districts) {
    const shard = checkShard(json(`fixtures/sec/catalogue/${district.file}`), district);
    for (const p of shard.panchayats) {
      const all = buildSelection('sarpanch', shard, p);
      assert.equal(all.wards.length, p.wards.length, p.id);
      const one = buildSelection('ward-panch', shard, p, p.wards[0].ward);
      assert.equal(one.wards.length, 1);
      assert.equal(buildSelection('ward-panch', shard, p, 999), null);
      assert.equal(buildSelection('zila', shard, p, 1), null);
    }
  }
});

test('first open fetches only the index; a shard only once its district is chosen, and once', async () => {
  const { d, picker, requests } = await mount();
  assert.deepEqual(requests, ['data/sec/catalogue/index.json']);
  tap(seatButton(d.body, 'ward-panch'));
  await settle();
  assert.deepEqual(requests, ['data/sec/catalogue/index.json']);
  choose(picker.selects.district, '7');
  await settle();
  assert.deepEqual(requests, ['data/sec/catalogue/index.json', 'data/sec/catalogue/bhilwara.json']);
  choose(picker.selects.district, '22');
  await settle();
  choose(picker.selects.district, '7');
  await settle();
  assert.deepEqual(requests, ['data/sec/catalogue/index.json', 'data/sec/catalogue/bhilwara.json',
    'data/sec/catalogue/jodhpur.json'], 'a district opened before is not fetched again');
  assert.ok(!requests.some((u) => u.endsWith('catalogue.json')));
});

const FILTER_SHARD = {
  schemaVersion: 1, id: '7', name: 'भीलवाडा', nameLatin: 'BHILWARA',
  panchayats: [
    ['1', 'अजमेरी', 'Ajmeri'], ['2', 'बड़ली', 'BADLI'], ['3', 'नई बड़ली', 'Nai Badli'], ['4', 'सरेरी', 'Sareri'],
  ].map(([id, name, nameLatin]) => ({
    id, name, nameLatin, block: { id: '60', name: 'माण्डल', nameLatin: 'MANDAL' },
    wards: [{ ward: 1, pdfUrl: `${SEC_FINAL}60/${nameLatin.toUpperCase()}-Ward%20No-001.pdf`, supplementUrl: null }],
  })),
};

test('the panchayat list filters as the user types, in Hindi or in Latin letters', async () => {
  const { d, picker } = await mount({ overrides: { 'bhilwara.json': FILTER_SHARD } });
  await openDistrict(picker, d.body, 'ward-panch', '7');
  assert.deepEqual(rowIds(d.body), ['1', '2', '3', '4']);
  type(picker.filter, 'बड़');
  assert.deepEqual(rowIds(d.body), ['2', '3'], 'names starting with the query first');
  type(picker.filter, 'बडली');
  assert.deepEqual(rowIds(d.body), ['2', '3'], 'with or without the nukta');
  type(picker.filter, 'सरे');
  assert.deepEqual(rowIds(d.body), ['4']);
  type(picker.filter, 'badli');
  assert.deepEqual(rowIds(d.body), ['2', '3'], 'nameLatin matches, any case');
  type(picker.filter, 'AJM');
  assert.deepEqual(rowIds(d.body), ['1']);
  type(picker.filter, 'xyz');
  assert.deepEqual(rowIds(d.body), []);
  assert.equal(picker.state(), 'empty');
  assert.equal(picker.message.textContent, strings.picker_panchayat_no_match);
  type(picker.filter, '');
  assert.deepEqual(rowIds(d.body), ['1', '2', '3', '4']);
  assert.deepEqual(filterPanchayats(FILTER_SHARD.panchayats, ' नई ').map((p) => p.id), ['3']);
});

test('loading, then success; a district with no panchayat is the empty state', async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const index = json('fixtures/sec/catalogue/index.json');
  const { d, picker } = await mount({
    overrides: {
      'index.json': () => gate.then(() => jsonResponse(index)),
      'bhilwara.json': { ...FILTER_SHARD, panchayats: [] },
    },
  });
  assert.equal(picker.state(), 'loading');
  assert.equal(picker.message.textContent, strings.picker_loading);
  assert.equal(picker.message.getAttribute('data-tone'), 'info');
  assert.ok(picker.selects.district.hasAttribute('disabled'));
  release();
  await settle();
  assert.equal(picker.state(), 'ready');
  assert.equal(picker.message.hidden, true);
  await openDistrict(picker, d.body, 'ward-panch', '7');
  assert.equal(picker.state(), 'empty');
  assert.equal(picker.message.textContent, strings.picker_panchayat_empty);
});

test('a failed fetch is the error state: what to do in Hindi, whom to call, and a retry that works', async () => {
  let fail = true;
  const index = json('fixtures/sec/catalogue/index.json');
  const { d, picker } = await mount({
    overrides: {
      'index.json': () => {
        if (fail) throw new TypeError('Failed to fetch');
        return jsonResponse(index);
      },
    },
    opts: { support: 'ब्लॉक समन्वयक: 98xxxxxx10' },
  });
  assert.equal(picker.state(), 'error');
  assert.equal(picker.message.getAttribute('data-tone'), 'error');
  assert.equal(picker.message.textContent, strings.picker_load_failed);
  assert.match(strings.picker_load_failed, /इंटरनेट/, 'retry when online');
  assert.match(strings.picker_load_failed, /सहायता नंबर पर कॉल/, 'or call the support number');
  assert.equal(picker.contact.hidden, false);
  assert.equal(picker.contact.textContent, 'ब्लॉक समन्वयक: 98xxxxxx10');
  assert.equal(picker.retry.hidden, false);
  assert.equal(picker.retry.textContent, strings.picker_retry);
  fail = false;
  tap(picker.retry);
  await settle();
  assert.equal(picker.state(), 'ready');
  assert.equal(picker.retry.hidden, true);
  assert.equal(picker.contact.hidden, true);
  tap(seatButton(d.body, 'sarpanch'));
  assert.equal(picker.selects.district.children.length, 6);
});

test('an HTTP error on a shard is the error state too, and retry fetches it again', async () => {
  let status = 503;
  const { d, picker, requests } = await mount({
    overrides: { 'bhilwara.json': () => (status === 200 ? new Response(read('fixtures/sec/catalogue/bhilwara.json')) : new Response('', { status })) },
  });
  await openDistrict(picker, d.body, 'ward-panch', '7');
  assert.equal(picker.state(), 'error');
  assert.deepEqual(rowIds(d.body), []);
  status = 200;
  tap(picker.retry);
  await settle();
  assert.equal(picker.state(), 'ready');
  assert.deepEqual(rowIds(d.body), ['2610']);
  assert.equal(requests.filter((u) => u.endsWith('bhilwara.json')).length, 2);
});

test('a catalogue file of an unknown schemaVersion shows "update the app", never a list', async () => {
  const index = json('fixtures/sec/catalogue/index.json');
  for (const version of [2, 0, '1', undefined]) {
    const { picker } = await mount({ overrides: { 'index.json': { ...index, schemaVersion: version } } });
    assert.equal(picker.state(), 'error', String(version));
    assert.equal(picker.message.textContent, strings.picker_version_unsupported);
    assert.match(strings.picker_version_unsupported, /ऐप अपडेट करें/);
    assert.equal(picker.retry.hidden, true, 'retrying cannot help');
    assert.deepEqual(optionValues(picker.selects.district), [''], 'no district is listed');
  }
  const shard = json('fixtures/sec/catalogue/bhilwara.json');
  const { d, picker } = await mount({ overrides: { 'bhilwara.json': { ...shard, schemaVersion: 2 } } });
  await openDistrict(picker, d.body, 'ward-panch', '7');
  assert.equal(picker.state(), 'error');
  assert.equal(picker.message.textContent, strings.picker_version_unsupported);
  assert.deepEqual(rowIds(d.body), []);
  assert.equal(fieldOf(picker.filter).hidden, true);
});

test('the loaders reject an unknown version or a malformed file with a CatalogueError', async () => {
  const index = json('fixtures/sec/catalogue/index.json');
  assert.throws(() => checkIndex({ ...index, schemaVersion: CATALOGUE_SCHEMA_VERSION + 1 }),
    (e) => e instanceof CatalogueError && e.kind === 'unsupported-version' && e.version === 2);
  for (const bad of [null, [], { schemaVersion: 1 }, { schemaVersion: 1, districts: [{ id: '7' }] },
    { schemaVersion: 1, districts: [{ id: '7', name: 'क', nameLatin: 'K', file: '../secret.json' }] }]) {
    assert.throws(() => checkIndex(bad), (e) => e instanceof CatalogueError && e.kind === 'invalid', JSON.stringify(bad));
  }
  const district = index.districts.find((d) => d.id === '7');
  const shard = json('fixtures/sec/catalogue/bhilwara.json');
  assert.throws(() => checkShard({ ...shard, id: '8' }, district), (e) => e.kind === 'invalid');
  const noUrl = structuredClone(shard);
  delete noUrl.panchayats[0].wards[0].pdfUrl;
  assert.throws(() => checkShard(noUrl, district), (e) => e.kind === 'invalid');
  const twice = structuredClone(shard);
  twice.panchayats[0].wards.push(twice.panchayats[0].wards[0]);
  assert.throws(() => checkShard(twice, district), (e) => e.kind === 'invalid');

  const net = catalogueFetch('fixtures/sec/catalogue/', { 'index.json': () => new Response('not json') });
  await assert.rejects(createCatalogueLoader({ fetch: net.fetch }).loadIndex(), (e) => e.kind === 'invalid');
});

test('with a roll loaded, changing the seat type or panchayat asks before replacing it', async () => {
  let loaded = false;
  const { d, picker, picked } = await mount({
    overrides: { 'bhilwara.json': FILTER_SHARD },
    opts: { hasLoadedRoll: () => loaded },
  });
  await openDistrict(picker, d.body, 'ward-panch', '7');
  tap(panchayatRow(d.body, '2'));
  choose(wardSelect(d.body), '1');
  assert.equal(picked.length, 1);
  assert.equal(picker.confirm.root.hidden, true, 'no roll loaded: no question');
  loaded = true;

  // Panchayat: "no" keeps the loaded seat.
  tap(panchayatRow(d.body, '3'));
  assert.equal(picker.confirm.root.hidden, false);
  assert.equal(picker.confirm.root.getAttribute('data-tone'), 'error');
  assert.equal(picker.confirm.yes.className.split(' ')[0], 'btn-danger');
  assert.equal(picker.confirm.root.querySelector('p').textContent, strings.picker_confirm_replace);
  tap(picker.confirm.no);
  assert.equal(picker.confirm.root.hidden, true);
  assert.equal(picker.wardSelection().panchayat.id, '2');
  assert.equal(panchayatRow(d.body, '2').getAttribute('aria-pressed'), 'true');
  assert.equal(picked.length, 1);

  // Seat type: "yes" replaces it; a sarpanch's panchayat is then every ward.
  tap(seatButton(d.body, 'sarpanch'));
  assert.equal(picker.confirm.root.hidden, false);
  assert.equal(seatButton(d.body, 'ward-panch').getAttribute('aria-pressed'), 'true', 'nothing changes before yes');
  tap(picker.confirm.yes);
  assert.equal(picker.confirm.root.hidden, true);
  assert.equal(picked.length, 2);
  assert.equal(picked[1].selection.seatType, 'sarpanch');
  assert.equal(picked[1].selection.panchayat.id, '2');

  // Panchayat: "yes" replaces it.
  tap(panchayatRow(d.body, '4'));
  tap(picker.confirm.yes);
  assert.equal(picked.length, 3);
  assert.equal(picked[2].selection.panchayat.id, '4');

  // District: "no" puts the select back.
  choose(picker.selects.district, '22');
  assert.equal(picker.confirm.root.hidden, false);
  tap(picker.confirm.no);
  assert.equal(picker.selects.district.value, '7');
  assert.equal(picker.wardSelection().panchayat.id, '4');
});

test('offline: the Hindi "no network" line shows and the selection is still emitted', async () => {
  const { d, picker, picked } = await mount({ opts: { isOnline: () => false } });
  await openDistrict(picker, d.body, 'ward-panch', '7');
  tap(panchayatRow(d.body, '2610'));
  choose(wardSelect(d.body), '1');
  assert.equal(picked.length, 1);
  assert.equal(picker.message.textContent, 'नेटवर्क नहीं है');
});

test('default online check uses navigator.onLine and sends no request', () => {
  const desc = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  const setNav = (value) => Object.defineProperty(globalThis, 'navigator', { value, configurable: true });
  try {
    setNav({ onLine: false });
    assert.equal(defaultIsOnline(), false);
    setNav({ onLine: true });
    assert.equal(defaultIsOnline(), true);
  } finally {
    if (desc) Object.defineProperty(globalThis, 'navigator', desc);
    else delete globalThis.navigator;
  }
});

test('restore reopens the picker on a stored selection, re-read from the catalogue, without emitting', async () => {
  const shard = json('fixtures/sec/catalogue/bhilwara.json');
  const stored = buildSelection('ward-panch', shard, shard.panchayats[0], 4);
  const { d, picker, picked } = await mount();
  assert.equal(await picker.restore(stored), true);
  assert.equal(picked.length, 0);
  assert.equal(seatButton(d.body, 'ward-panch').getAttribute('aria-pressed'), 'true');
  assert.equal(picker.selects.district.value, '7');
  assert.equal(picker.selects.ward.value, '4');
  assert.deepEqual(picker.wardSelection(), stored);

  const other = await mount();
  const gone = { ...stored, panchayat: { ...stored.panchayat, id: '9999' } };
  assert.equal(await other.picker.restore(gone), false);
  assert.equal(other.picker.wardSelection(), null);
  assert.equal(fieldOf(other.picker.selects.district).hidden, true, 'the picker stays at its first step');
  assert.equal(await other.picker.restore({ ...stored, schemaVersion: 9 }), false);
});

test('the last selection is stored with schemaVersion; an unknown version is discarded', () => {
  const map = new Map();
  const storage = { getItem: (k) => (map.has(k) ? map.get(k) : null), setItem: (k, v) => map.set(k, String(v)), removeItem: (k) => map.delete(k) };
  const shard = json('fixtures/sec/catalogue/bhilwara.json');
  const selection = buildSelection('sarpanch', shard, shard.panchayats[0]);
  assert.equal(saveLastSelection(selection, storage), true);
  assert.equal(JSON.parse(map.get(LAST_SELECTION_KEY)).schemaVersion, SELECTION_SCHEMA_VERSION);
  assert.deepEqual(loadLastSelection(storage), { selection, error: null });

  map.set(LAST_SELECTION_KEY, JSON.stringify({ ...selection, schemaVersion: 2 }));
  assert.deepEqual(loadLastSelection(storage), { selection: null, error: 'unknown-version', version: 2 });
  assert.equal(map.has(LAST_SELECTION_KEY), false, 'discarded');

  for (const raw of ['{', '[]', JSON.stringify({ schemaVersion: 1, seatType: 'ward-panch' })]) {
    map.set(LAST_SELECTION_KEY, raw);
    assert.equal(loadLastSelection(storage).error, 'corrupt', raw);
    assert.equal(map.has(LAST_SELECTION_KEY), false);
  }
  assert.deepEqual(loadLastSelection(storage), { selection: null, error: null });
  assert.equal(saveLastSelection({ seatType: 'sarpanch' }, storage), false);
});

test('a ward panch selection maps to the roll flow\'s selection and ward key', () => {
  const shard = json('fixtures/sec/catalogue/bhilwara.json');
  const p = shard.panchayats[0];
  const selection = buildSelection('ward-panch', shard, p, 2);
  const roll = rollSelectionFor(selection, selection.wards[0], p);
  assert.deepEqual(roll, {
    district: '7', samiti: '60', panchayat: '2610', ward: '2',
    pdfUrl: p.wards[1].pdfUrl, supplementPdfUrls: [p.wards[1].supplementUrl],
  });
  const hit = wardForWardKey(shard, '7/60/2610/2');
  assert.deepEqual(hit.rollSelection, roll);
  assert.deepEqual(hit.seat, { seatType: 'ward', panchayat: p.name, ward: '2' });
  for (const key of ['7/60/2610/99', '7/61/2610/2', '8/60/2610/2', '7/60/2610', null]) {
    assert.equal(wardForWardKey(shard, key), null, String(key));
  }
});

test('the committed catalogue reads cleanly; Badli\'s URLs are the researched SEC ones', () => {
  const index = checkIndex(json('data/sec/catalogue/index.json'));
  const doc = read('docs/research/sec-roll-source.md');
  for (const district of index.districts) {
    const shard = checkShard(json(`data/sec/catalogue/${district.file}`), district);
    for (const p of shard.panchayats) {
      for (const w of p.wards) assert.ok(w.pdfUrl.startsWith(SEC_FINAL), w.pdfUrl);
    }
  }
  const jaipur = checkShard(json('data/sec/catalogue/jaipur.json'), index.districts.find((d) => d.id === '17'));
  const badli = jaipur.panchayats.find((p) => p.id === '6313');
  assert.equal(badli.wards[0].pdfUrl, BADLI_WARD1);
  for (const w of badli.wards) assert.ok(doc.includes(w.pdfUrl), w.pdfUrl);
});

test('the single-file data/sec/catalogue.json is gone and nothing reads it', () => {
  assert.equal(existsSync(new URL('../data/sec/catalogue.json', import.meta.url)), false);
  for (const file of ['js/picker.js', 'src/ui/wardPickerScreen.js', 'src/picker/wardPicker.js',
    'src/picker/catalogueLoader.js', 'src/picker/lastSelection.js', 'sw.js', 'tools/sec-catalogue/make_test_input.py']) {
    assert.doesNotMatch(read(file), /data\/sec\/catalogue\.json/, file);
  }
});

test('picker strings are non-empty Hindi with no Latin letters, and the fallback copies match', () => {
  for (const [key, value] of Object.entries(FALLBACK_TEXT)) {
    assert.equal(value, strings[key], key);
    assert.match(value, /[ऀ-ॿ]/, key);
    assert.doesNotMatch(value, /[A-Za-z]/, key);
  }
  assert.equal(read('js/picker.js').includes(JSON.stringify(strings.picker_load_failed)), true,
    'js/picker.js keeps a copy of picker_load_failed');
});

// The innermost `selector { body }` rules naming a selector, merged.
function ruleFor(selector) {
  const out = {};
  for (const m of css.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if (!m[1].split(',').map((s) => s.trim()).includes(selector)) continue;
    for (const decl of m[2].split(';')) {
      const i = decl.indexOf(':');
      if (i > 0) out[decl.slice(0, i).trim()] = decl.slice(i + 1).trim();
    }
  }
  return out;
}

test('every picker tap target is at least 48 px tall, and none is a file input', async () => {
  assert.equal(ruleFor(':root')['--touch-target'], '48px');
  const { d, picker } = await mount({ opts: { hasLoadedRoll: () => true } });
  await openDistrict(picker, d.body, 'ward-panch', '7');
  tap(panchayatRow(d.body, '2610'));
  tap(seatButton(d.body, 'sarpanch'));
  assert.equal(picker.confirm.root.hidden, false);
  const controls = ['button', 'select', 'input'].flatMap((tag) => d.body.querySelectorAll(tag));
  assert.ok(controls.length >= 7, `${controls.length} controls`);
  for (const node of controls) {
    const tall = node.className.split(/\s+/).some((cls) => ruleFor(`.${cls}`)['min-height'] === 'var(--touch-target)');
    assert.ok(tall, `${node.tagName}.${node.className} has no 48 px min-height`);
    if (node.tagName === 'INPUT') assert.equal(node.getAttribute('type'), 'search');
  }
});
