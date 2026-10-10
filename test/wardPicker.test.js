// Ward picker over the sharded catalogue (issue #122), run by `npm test`:
// seat type -> district -> panchayat -> ward, over the shards tools/sec-catalogue
// builds from fixtures/sec/catalogue-input (test/fixtures/catalogue/).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';

import {
  CATALOGUE_INDEX_URL, CatalogueError, SELECTION_SCHEMA_VERSION, buildSelection, createCatalogue,
  filterPanchayats, isSelection, readShard, wardForKey, wardRollSelection,
} from '../src/picker/catalogue.js';
import { SELECTION_STORAGE_KEY, loadLastSelection, saveLastSelection } from '../src/picker/lastSelection.js';
import { mountWardPicker, replacesSeat } from '../src/ui/wardPickerScreen.js';
import { createDocument, type } from './helpers/fakeDom.js';
import { catalogueFiles, catalogueResponse, pickerOption, pickerOptions, tapOption } from './helpers/catalogueFixture.js';

const read = (rel) => readFileSync(new URL('../' + rel, import.meta.url), 'utf8');
const strings = JSON.parse(read('src/strings.hi.json'));
const config = JSON.parse(read('config/constituency.json'));
const FIXTURE_INDEX = JSON.parse(read('test/fixtures/catalogue/index.json'));

async function waitFor(cond, ms = 4000) {
  const until = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > until) throw new Error('timed out');
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}

/** A catalogue over the test files, recording every URL it fetches. */
function fixtureCatalogue(files = catalogueFiles(), { fail = () => false } = {}) {
  const requests = [];
  const fetch = async (url) => {
    requests.push(url);
    if (fail(url)) throw new TypeError('Failed to fetch');
    return catalogueResponse(url, files) || new Response('', { status: 404 });
  };
  return { catalogue: createCatalogue({ fetch }), requests };
}

function mount(opts = {}) {
  const doc = createDocument();
  const { catalogue, requests } = opts.catalogue ? { catalogue: opts.catalogue, requests: [] } : fixtureCatalogue(opts.files, opts);
  const picked = [];
  const picker = mountWardPicker(doc.body, strings, { catalogue, onSelect: (s) => picked.push(s), ...opts.screen });
  return { doc, picker, picked, requests: opts.requests || requests, root: picker.root };
}

const values = (root) => pickerOptions(root).map((b) => b.getAttribute('data-value'));
const settled = (picker) => waitFor(() => picker.state !== 'loading');

test('the picker asks seat type, then district, then panchayat, then ward, in Hindi', async () => {
  const { picker, root, picked } = mount();
  assert.equal(picker.step, 'seat');
  assert.equal(picker.heading.textContent, strings.picker_seat_prompt);
  assert.deepEqual(values(root), ['ward-panch', 'sarpanch']);
  assert.deepEqual(pickerOptions(root).map((b) => b.querySelector('span.picker-option-name').textContent), ['वार्ड पंच', 'सरपंच']);
  assert.equal(picker.backButton.hidden, true);

  await tapOption(root, 'ward-panch');
  assert.equal(picker.step, 'district');
  assert.equal(picker.heading.textContent, strings.picker_district_prompt);
  await settled(picker);
  assert.deepEqual(values(root).sort(), [...FIXTURE_INDEX.districts.map((d) => d.id), '17'].sort());

  await tapOption(root, '8');
  assert.equal(picker.step, 'panchayat');
  assert.equal(picker.heading.textContent, strings.picker_panchayat_prompt);
  await settled(picker);
  assert.deepEqual(values(root), ['3044']);
  assert.equal(pickerOption(root, '3044').textContent, 'भोलासरकोलायत पंचायत समिति');

  await tapOption(root, '3044');
  assert.equal(picker.step, 'ward');
  assert.equal(picker.heading.textContent, strings.picker_ward_prompt);
  assert.deepEqual(values(root), ['1', '2', '3', '4', '5', '6', '7', '8', '9']);
  assert.equal(picked.length, 0);

  await tapOption(root, '3');
  assert.equal(picked.length, 1);
  assert.equal(picker.state, 'success');
  assert.equal(picker.message.getAttribute('data-tone'), 'success');
  assert.ok(picker.message.textContent.includes('भोलासर'), picker.message.textContent);
});

test('over every test shard: a ward panch emits exactly one ward, a sarpanch every ward in order', async () => {
  for (const d of FIXTURE_INDEX.districts) {
    const shard = JSON.parse(read(`test/fixtures/catalogue/${d.file}`));
    for (const p of shard.panchayats) {
      const ordered = p.wards.map((w) => w.ward).sort((a, b) => a - b);
      const panch = mount();
      await tapOption(panch.root, 'ward-panch');
      await tapOption(panch.root, d.id);
      await tapOption(panch.root, p.id);
      await tapOption(panch.root, String(ordered[1]));
      assert.equal(panch.picked.length, 1);
      const one = panch.picked[0];
      assert.deepEqual(Object.keys(one).sort(), ['district', 'panchayat', 'schemaVersion', 'seatType', 'wards']);
      assert.equal(one.seatType, 'ward-panch');
      assert.equal(one.schemaVersion, SELECTION_SCHEMA_VERSION);
      assert.deepEqual([one.district.id, one.district.name], [d.id, d.name]);
      assert.deepEqual([one.panchayat.id, one.panchayat.name, one.panchayat.block.id], [p.id, p.name, p.block.id]);
      assert.equal(one.wards.length, 1);
      const want = p.wards.find((w) => w.ward === ordered[1]);
      assert.deepEqual(one.wards[0], { ward: want.ward, pdfUrl: want.pdfUrl, supplementUrl: want.supplementUrl });

      const sarpanch = mount();
      await tapOption(sarpanch.root, 'sarpanch');
      await tapOption(sarpanch.root, d.id);
      await tapOption(sarpanch.root, p.id);
      assert.equal(sarpanch.picker.step, 'panchayat', 'a sarpanch never sees the ward step');
      assert.equal(sarpanch.picked.length, 1);
      const all = sarpanch.picked[0];
      assert.equal(all.seatType, 'sarpanch');
      assert.equal(all.schemaVersion, SELECTION_SCHEMA_VERSION);
      assert.deepEqual(all.wards.map((w) => w.ward), ordered);
      for (const w of all.wards) {
        assert.equal(w.pdfUrl, p.wards.find((x) => x.ward === w.ward).pdfUrl);
        assert.ok(w.pdfUrl.startsWith('https://esuchiroll.rajasthan.gov.in/'), w.pdfUrl);
      }
      assert.equal(isSelection(one) && isSelection(all), true);
    }
  }
});

test('first open fetches only the index; a district shard only once that district is chosen', async () => {
  const { picker, root, requests } = mount();
  await waitFor(() => requests.length > 0);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(requests, [CATALOGUE_INDEX_URL]);
  await tapOption(root, 'ward-panch');
  await settled(picker);
  assert.deepEqual(requests, [CATALOGUE_INDEX_URL], 'the district list reuses the index');
  await tapOption(root, '33');
  await settled(picker);
  assert.deepEqual(requests, [CATALOGUE_INDEX_URL, 'data/sec/catalogue/udaipur.json']);
  // Back to the districts and into the same one again: no second request.
  picker.backButton.dispatchEvent({ type: 'click' });
  await tapOption(root, '33');
  await settled(picker);
  assert.equal(requests.filter((u) => u.endsWith('udaipur.json')).length, 1);
});

test('the panchayat list filters as the user types, in Hindi or in English letters', async () => {
  const files = catalogueFiles();
  // A second Bhilwara panchayat, so the filter has something to drop.
  const extra = structuredClone(files['bhilwara.json'].panchayats[0]);
  Object.assign(extra, { id: '9001', name: 'अजमेरी', nameLatin: 'AJMERI' });
  files['bhilwara.json'].panchayats.push(extra);
  const { picker, root } = mount({ files });
  await tapOption(root, 'ward-panch');
  await tapOption(root, '7');
  await settled(picker);
  assert.equal(picker.filter.parentNode.hidden, false);
  assert.deepEqual(values(root).sort(), ['2610', '9001']);
  const almas = files['bhilwara.json'].panchayats[0];
  type(picker.filter, almas.name.slice(0, 2));
  assert.deepEqual(values(root), ['2610']);
  type(picker.filter, 'ajm');
  assert.deepEqual(values(root), ['9001']);
  type(picker.filter, 'जयपुर');
  assert.deepEqual(values(root), []);
  assert.equal(picker.state, 'empty');
  assert.equal(picker.message.textContent, strings.picker_filter_empty);
  type(picker.filter, '');
  assert.equal(picker.state, 'filled');
  assert.equal(values(root).length, 2);
  // The filter text matches nukta-less typing too (hindiSearch normalize).
  assert.deepEqual(filterPanchayats([{ name: 'ज़ावर', nameLatin: 'ZAWAR' }], 'जावर').length, 1);
});

test('loading, empty, error and success states, one at a time', async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const files = catalogueFiles();
  const slow = { loadIndex: () => gate.then(() => ({ districts: [] })), loadShard: () => Promise.resolve(null) };
  const empty = mount({ catalogue: slow });
  await tapOption(empty.root, 'sarpanch');
  assert.equal(empty.picker.state, 'loading');
  assert.equal(empty.picker.message.textContent, strings.picker_loading);
  assert.equal(empty.picker.message.getAttribute('data-tone'), 'info');
  release();
  await settled(empty.picker);
  assert.equal(empty.picker.state, 'empty');
  assert.equal(empty.picker.message.textContent, strings.picker_districts_empty);

  let offline = true;
  const net = mount({ files, fail: () => offline });
  await tapOption(net.root, 'ward-panch');
  await settled(net.picker);
  assert.equal(net.picker.state, 'error');
  assert.equal(net.picker.message.getAttribute('data-tone'), 'error');
  assert.equal(net.picker.message.getAttribute('role'), 'alert');
  assert.equal(net.picker.message.textContent, strings.picker_fetch_failed);
  assert.match(strings.picker_fetch_failed, /इंटरनेट/);
  assert.equal(net.picker.contact.hidden, false);
  assert.equal(net.picker.contact.textContent, strings.picker_error_contact);
  assert.match(strings.picker_error_contact, /सहायता नंबर/);
  net.picker.setSupport('ब्लॉक समन्वयक: ९८७६५४३२१०');
  assert.equal(net.picker.contact.textContent, 'ब्लॉक समन्वयक: ९८७६५४३२१०');
  assert.equal(net.picker.retryButton.hidden, false);
  assert.equal(pickerOptions(net.root).length, 0);
  offline = false;
  net.picker.retryButton.dispatchEvent({ type: 'click' });
  await settled(net.picker);
  assert.equal(net.picker.state, 'filled');
  assert.equal(net.picker.contact.hidden, true);
  assert.equal(net.picker.retryButton.hidden, true);
  await tapOption(net.root, '6');
  await tapOption(net.root, '2240');
  await tapOption(net.root, '1');
  assert.equal(net.picker.state, 'success');
});

test('a catalogue file of an unknown schemaVersion shows "not supported, update the app", never a list', async () => {
  for (const file of ['index.json', 'bikaner.json']) {
    const files = catalogueFiles();
    files[file] = { ...files[file], schemaVersion: 2 };
    const { picker, root, picked } = mount({ files });
    await tapOption(root, 'ward-panch');
    if (file !== 'index.json') await tapOption(root, '8');
    await settled(picker);
    assert.equal(picker.state, 'error', file);
    assert.equal(picker.message.textContent, strings.picker_version_unsupported);
    assert.match(strings.picker_version_unsupported, /ऐप अपडेट करें/);
    assert.equal(picker.retryButton.hidden, true, 'fetching it again cannot help');
    assert.equal(pickerOptions(root).length, 0);
    assert.equal(picked.length, 0);
  }
  await assert.rejects(createCatalogue({ fetch: async () => new Response('{"schemaVersion": 7, "districts": []}') }).loadIndex(),
    (err) => err instanceof CatalogueError && err.kind === 'version' && err.version === 7);
});

test('the loader rejects a wrong-shaped file and a shard file name with a path', async () => {
  const district = { id: '8', name: 'बीकानेर', file: 'bikaner.json' };
  const shard = catalogueFiles()['bikaner.json'];
  for (const bad of [
    { ...shard, id: '9' },
    { ...shard, panchayats: [{ ...shard.panchayats[0], wards: [{ ward: '1', pdfUrl: 'x' }] }] },
    { ...shard, panchayats: [{ ...shard.panchayats[0], wards: [shard.panchayats[0].wards[0], shard.panchayats[0].wards[0]] }] },
    { ...shard, panchayats: [{ ...shard.panchayats[0], block: null }] },
  ]) {
    assert.throws(() => readShard(bad, district), (err) => err.kind === 'corrupt');
  }
  const requests = [];
  const catalogue = createCatalogue({ fetch: async (url) => { requests.push(url); return new Response('{}'); } });
  await assert.rejects(catalogue.loadShard({ id: '8', file: '../secret.json' }), (err) => err.kind === 'corrupt');
  assert.deepEqual(requests, []);
  const files = catalogueFiles();
  files['index.json'].districts[0].file = '../../etc/passwd';
  const { picker, root } = mount({ files });
  await tapOption(root, 'ward-panch');
  await settled(picker);
  assert.equal(picker.state, 'error');
});

test('changing seat type or panchayat after a roll is loaded asks first; another ward does not', async () => {
  let loaded = null;
  const screen = { hasLoadedRoll: () => true, loadedSelection: () => loaded };
  const { picker, root, picked } = mount({ screen });
  await tapOption(root, 'ward-panch');
  await tapOption(root, '17');
  await tapOption(root, '6313');
  // Nothing known about the loaded roll: even the first pick asks.
  await tapOption(root, '1');
  assert.equal(picker.confirmBox.hidden, false);
  assert.equal(picker.confirmBox.getAttribute('data-tone'), 'error');
  assert.equal(picker.confirmYes.className, 'btn-danger picker-confirm-yes');
  assert.equal(picked.length, 0);
  picker.confirmYes.dispatchEvent({ type: 'click' });
  assert.equal(picked.length, 1);
  assert.equal(picker.confirmBox.hidden, true);
  loaded = picked[0];

  // Another ward of the same panchayat: no question.
  await tapOption(root, '2');
  assert.equal(picked.length, 2);
  assert.equal(picker.confirmBox.hidden, true);
  loaded = picked[1];

  // Another seat type: asks, and "no" keeps the loaded selection.
  picker.backButton.dispatchEvent({ type: 'click' });
  picker.backButton.dispatchEvent({ type: 'click' });
  picker.backButton.dispatchEvent({ type: 'click' });
  assert.equal(picker.step, 'seat');
  await tapOption(root, 'sarpanch');
  await tapOption(root, '17');
  await tapOption(root, '6313');
  assert.equal(picker.confirmBox.hidden, false);
  assert.equal(picker.confirmBox.querySelector('p').textContent, strings.picker_confirm_replace);
  picker.confirmNo.dispatchEvent({ type: 'click' });
  assert.equal(picker.confirmBox.hidden, true);
  assert.equal(picked.length, 2);
  assert.equal(picker.wardSelection(), loaded);

  // Another panchayat (of another district) asks too; "yes" replaces.
  picker.backButton.dispatchEvent({ type: 'click' });
  await tapOption(root, '8');
  await tapOption(root, '3044');
  assert.equal(picker.confirmBox.hidden, false);
  picker.confirmYes.dispatchEvent({ type: 'click' });
  assert.equal(picked.length, 3);
  assert.equal(picked[2].seatType, 'sarpanch');

  assert.equal(replacesSeat(loaded, { ...loaded, wards: [] }), false);
  assert.equal(replacesSeat(loaded, { ...loaded, seatType: 'sarpanch' }), true);
  assert.equal(replacesSeat(loaded, { ...loaded, panchayat: { ...loaded.panchayat, id: 'x' } }), true);
});

test('with no roll loaded a pick never asks', async () => {
  const { picker, root, picked } = mount({ screen: { hasLoadedRoll: () => false } });
  await tapOption(root, 'sarpanch');
  await tapOption(root, '17');
  await tapOption(root, '6313');
  assert.equal(picker.confirmBox.hidden, true);
  assert.equal(picked.length, 1);
  assert.equal(picked[0].wards.length, config.districts[0].samitis[0].panchayats[0].wards.length);
});

test('every picker tap target is a DESIGN.md control at least 48 px tall', async () => {
  const css = read('styles.css');
  const { picker, root } = mount({ screen: { hasLoadedRoll: () => true } });
  const SIZED = ['list-row', 'btn-secondary', 'btn-quiet', 'btn-danger', 'field-input'];
  const check = () => {
    const controls = [...root.querySelectorAll('button'), ...root.querySelectorAll('input')];
    assert.ok(controls.length > 0);
    for (const c of controls) {
      const cls = SIZED.find((name) => c.classList.contains(name));
      assert.ok(cls, `${c.tagName}.${c.className} is not a 48 px control`);
    }
  };
  check();
  await tapOption(root, 'ward-panch');
  await tapOption(root, '7');
  await tapOption(root, '2610');
  await tapOption(root, '1');
  check();
  assert.equal(picker.confirmBox.hidden, false);
  for (const name of SIZED) {
    const rule = css.match(new RegExp(`(?:^|\\n)\\.${name}(?:,\\n[^{]*)?\\s*\\{([^}]*)\\}`));
    assert.ok(rule, name);
    assert.match(rule[1], /min-height:\s*var\(--touch-target\)/, name);
  }
  assert.match(css, /--touch-target:\s*48px/);
  assert.equal(root.querySelectorAll('select').length, 0);
});

test('the selection the roll flow opens for a ward, and the ward a stored roll key names', () => {
  const files = catalogueFiles();
  const shard = readShard(files['bikaner.json'], { id: '8', file: 'bikaner.json' });
  const p = shard.panchayats[0];
  const sel = buildSelection('sarpanch', shard, p);
  const roll = wardRollSelection(sel, sel.wards[2]);
  assert.deepEqual(roll, {
    district: '8', samiti: p.block.id, panchayat: p.id, ward: '3', pdfUrl: p.wards[2].pdfUrl,
    supplementPdfUrls: [p.wards[2].supplementUrl],
  });
  assert.equal(wardForKey(sel, `8/${p.block.id}/${p.id}/3`), sel.wards[2]);
  assert.equal(wardForKey(sel, `8/${p.block.id}/${p.id}/99`), null);
  assert.equal(buildSelection('ward-panch', shard, p, 99), null, 'a ward outside the shard selects nothing');
  assert.equal(buildSelection('mayor', shard, p, 1), null);
});

function memoryStorage(init = {}) {
  const stored = new Map(Object.entries(init));
  return {
    stored,
    getItem: (k) => stored.get(k) ?? null,
    setItem: (k, v) => { stored.set(k, String(v)); },
    removeItem: (k) => { stored.delete(k); },
  };
}

test('the stored last selection carries schemaVersion; an unknown version is discarded', () => {
  const files = catalogueFiles();
  const shard = readShard(files['jaipur.json'], { id: '17', file: 'jaipur.json' });
  const sel = buildSelection('ward-panch', shard, shard.panchayats[0], 1);
  const storage = memoryStorage();
  assert.equal(saveLastSelection(sel, storage), true);
  const record = JSON.parse(storage.stored.get(SELECTION_STORAGE_KEY));
  assert.equal(record.schemaVersion, SELECTION_SCHEMA_VERSION);
  assert.deepEqual(loadLastSelection(storage), { selection: sel, error: null });
  assert.equal(saveLastSelection({ ...sel, wards: [] }, storage), false);

  const future = memoryStorage({ [SELECTION_STORAGE_KEY]: JSON.stringify({ ...sel, schemaVersion: 2 }) });
  assert.deepEqual(loadLastSelection(future), { selection: null, error: 'unknown-version', version: 2 });
  assert.equal(future.stored.has(SELECTION_STORAGE_KEY), false, 'discarded');
  const broken = memoryStorage({ [SELECTION_STORAGE_KEY]: '{"schemaVersion": 1, "seatType": "ward-panch"}' });
  assert.equal(loadLastSelection(broken).error, 'corrupt');
  assert.equal(broken.stored.has(SELECTION_STORAGE_KEY), false);
  assert.equal(loadLastSelection(memoryStorage({ [SELECTION_STORAGE_KEY]: 'not json' })).error, 'corrupt');
  assert.deepEqual(loadLastSelection(memoryStorage()), { selection: null, error: null });
});

test('the picker no longer reads data/sec/catalogue.json, and the file is gone', () => {
  assert.equal(existsSync(new URL('../data/sec/catalogue.json', import.meta.url)), false);
  for (const rel of ['js/picker.js', 'js/app.js', 'sw.js', 'src/picker/catalogue.js', 'src/picker/lastSelection.js',
    'src/ui/wardPickerScreen.js']) {
    assert.doesNotMatch(read(rel), /catalogue\.json/, rel);
  }
  assert.match(read('src/picker/catalogue.js'), /data\/sec\/catalogue\//);
  assert.deepEqual(readdirSync(new URL('../src/picker/', import.meta.url)).sort(), ['catalogue.js', 'lastSelection.js']);
});

test('service worker precaches the picker modules and strings; index.html loads the picker', () => {
  const sw = read('sw.js');
  for (const file of ['js/picker.js', 'src/picker/catalogue.js', 'src/picker/lastSelection.js',
    'src/ui/wardPickerScreen.js', 'src/strings.hi.json']) {
    assert.ok(sw.includes(`"${file}"`), file);
  }
  assert.ok(!sw.includes('"src/picker/wardPicker.js"'));
  assert.match(read('index.html'), /<script type="module" src="js\/picker\.js">/);
});

test('picker strings are Hindi with no Latin letters', () => {
  const keys = Object.keys(strings).filter((k) => k.startsWith('picker_'));
  assert.ok(keys.length >= 20, keys.join());
  for (const key of keys) {
    assert.match(strings[key], /[ऀ-ॿ]/, key);
    assert.doesNotMatch(strings[key], /[A-Za-z]/, key);
  }
  for (const key of ['picker_seat_prompt', 'picker_district_prompt', 'picker_panchayat_prompt', 'picker_ward_prompt',
    'picker_seat_ward_panch', 'picker_seat_sarpanch', 'picker_filter_label', 'picker_confirm_replace']) {
    assert.ok(strings[key], key);
  }
});

test('the bundled constituency config (the relay allowlist) holds Badli wards 1-7 on the SEC origin', () => {
  const panchayat = config.districts[0].samitis[0].panchayats[0];
  assert.equal(panchayat.wards.length, 7);
  for (const w of panchayat.wards) {
    assert.ok(read('docs/research/sec-roll-source.md').includes(w.pdfUrl), w.pdfUrl);
    assert.ok(w.pdfUrl.startsWith('https://esuchiroll.rajasthan.gov.in/Publication_PDF_2026/PRI/Final/'), w.pdfUrl);
  }
});
