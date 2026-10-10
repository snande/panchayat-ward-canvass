// Ward catalogue + picker tests (issues #15 and #122), run by `npm test`.
// The constituency config helpers (src/picker/wardPicker.js) still name the
// relay's wards; the picker screen reads the sharded SEC catalogue, here a
// small slice of it under test/fixtures/catalogue/.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';

import {
  resolveWard, selectionFor, selectionForWardKey,
} from '../src/picker/wardPicker.js';
import { mountWardPicker, defaultIsOnline } from '../src/ui/wardPickerScreen.js';
import { createCatalogue } from '../src/picker/catalogue.js';
import { createDocument } from './helpers/fakeDom.js';
import { catalogueResponse, choose, optionValues, waitFor } from './helpers/picker.js';

const read = (rel) => readFileSync(new URL('../' + rel, import.meta.url), 'utf8');
const config = JSON.parse(read('config/constituency.json'));
const strings = JSON.parse(read('src/strings.hi.json'));
const doc = read('docs/research/sec-roll-source.md');

const WARD1 = 'https://esuchiroll.rajasthan.gov.in/Publication_PDF_2026/PRI/Final/125/BADLI-Ward%20No-001.pdf';
const SEC_PREFIX = 'https://esuchiroll.rajasthan.gov.in/Publication_PDF_2026/PRI/Final/';
const BADLI = { district: '17', samiti: '125', panchayat: '6313' };

test('Badli ward 1 resolves to the researched URL', () => {
  assert.equal(resolveWard(config, { ...BADLI, ward: '1' }), WARD1);
  assert.ok(doc.includes(WARD1));
});

test('config holds only Badli wards 1-7; every URL is in the research doc and on the SEC origin', () => {
  assert.deepEqual(config.districts.map((d) => d.id), ['17']);
  assert.deepEqual(config.districts[0].samitis.map((d) => d.id), ['125']);
  assert.deepEqual(config.districts[0].samitis[0].panchayats.map((d) => d.id), ['6313']);
  const list = config.districts[0].samitis[0].panchayats[0].wards;
  assert.equal(list.length, 7);
  for (const w of list) {
    const url = resolveWard(config, { ...BADLI, ward: w.id });
    assert.ok(doc.includes(url), url);
    assert.ok(url.startsWith(SEC_PREFIX), url);
  }
});

test('crafted selections outside the config yield no URL', () => {
  const bad = [
    null, undefined, 'x', {}, { ...BADLI }, { ...BADLI, ward: '8' }, { ...BADLI, ward: 1 },
    { ...BADLI, ward: '__proto__' }, { ...BADLI, ward: 'constructor' },
    { district: '17', samiti: '125', panchayat: '6314', ward: '1' },
    { district: '17', samiti: '999', panchayat: '6313', ward: '1' },
    { district: '1', samiti: '125', panchayat: '6313', ward: '1' },
  ];
  for (const sel of bad) {
    assert.equal(resolveWard(config, sel), null, JSON.stringify(sel));
    assert.equal(selectionFor(config, sel), null);
  }
  assert.equal(resolveWard(null, { ...BADLI, ward: '1' }), null);
});

test('picker strings are non-empty Hindi, with no Latin letters', () => {
  const keys = [
    'picker_seat_type', 'picker_seat_prompt', 'picker_seat_ward_panch', 'picker_seat_sarpanch',
    'picker_district', 'picker_panchayat_search', 'picker_panchayat', 'picker_ward',
    'picker_district_prompt', 'picker_panchayat_prompt', 'picker_ward_prompt',
    'network_unavailable', 'picker_loading', 'picker_load_failed', 'picker_no_districts',
    'picker_no_panchayats', 'picker_no_match', 'picker_error_retry', 'picker_error_contact',
    'catalogue_version_unsupported', 'picker_selected_ward', 'picker_selected_all_wards',
    'picker_confirm_replace', 'picker_confirm_replace_yes', 'picker_confirm_replace_no',
  ];
  for (const key of keys) {
    assert.match(strings[key] ?? '', /[ऀ-ॿ]/, key);
    assert.doesNotMatch(strings[key], /[A-Za-z]/, key);
  }
  const d = config.districts[0];
  const p = d.samitis[0].panchayats[0];
  for (const item of [d, d.samitis[0], p, ...p.wards]) assert.match(item.label, /[ऀ-ॿ]/, item.id);
});

test('stylesheet: 48 px touch targets, local Noto Sans Devanagari', () => {
  const css = read('styles.css');
  assert.match(css, /--touch-target:\s*48px/);
  const select = css.match(/\.picker-select\s*\{([^}]*)\}/)[1];
  assert.match(select, /min-height:\s*var\(--touch-target\)/);
  assert.match(select, /font:\s*inherit/);
  assert.match(css, /font-family:\s*"Noto Sans Devanagari"[^}]*src:\s*url\("fonts\/[^"]+\.woff2"\)/s);
  assert.match(css, /--font-family-base:\s*"Noto Sans Devanagari"/);
});

test('service worker precaches the picker, its catalogue loader and strings, and caches the catalogue it fetches', () => {
  const sw = read('sw.js');
  const html = read('index.html');
  assert.match(sw, /CATALOGUE_PATH = .*catalogue/);
  assert.match(sw, /caches\s*\.open\(CATALOGUE_CACHE\)/);
  for (const file of ['js/picker.js', 'config/constituency.json', 'src/picker/wardPicker.js',
    'src/ui/wardPickerScreen.js', 'src/strings.hi.json', 'src/picker/catalogue.js']) {
    assert.ok(sw.includes(`"${file}"`), file);
  }
  assert.match(html, /<script type="module" src="js\/picker\.js">/);
});

test('a ward\'s supplementary roll URLs from its catalogue entry ride on the selection', () => {
  const SUPP = 'https://esuchiroll.rajasthan.gov.in/Publication_PDF_2026/PRI/Supplement/125/BADLI-Ward%20No-001.pdf';
  const withSupp = structuredClone(config);
  withSupp.districts[0].samitis[0].panchayats[0].wards[0].supplementPdfUrls = [SUPP, 5];
  const sel = { district: '17', samiti: '125', panchayat: '6313', ward: '1' };
  assert.deepEqual(selectionFor(withSupp, sel).supplementPdfUrls, [SUPP]);
  assert.equal('supplementPdfUrls' in selectionFor(config, sel), false);
  assert.deepEqual(selectionForWardKey(withSupp, '17/125/6313/1'), selectionFor(withSupp, sel));
  assert.equal(selectionForWardKey(withSupp, '17/125'), null);
  assert.equal(selectionForWardKey(withSupp, null), null);
});

// The picker screen over the test catalogue: Jaipur (Badli, wards listed out
// of order) and Ajmer.
const SHARD = 'data/sec/catalogue/jaipur.json';
const BADLI_WARD = (n) => `https://esuchiroll.rajasthan.gov.in/Publication_PDF_2026/PRI/Final/125/BADLI-Ward%20No-00${n}.pdf`;

function mountScreen(opts = {}) {
  const d = createDocument();
  const requests = [];
  const fetch = opts.fetch || (async (url) => {
    requests.push(url);
    return catalogueResponse(url, 'test/fixtures/catalogue/');
  });
  const picked = [];
  const picker = mountWardPicker(d.body, createCatalogue({ fetch }), strings, {
    onSelect: (s) => picked.push(s), isOnline: () => true, ...opts,
  });
  return { d, picked, picker, requests };
}

async function toPanchayat(picker, seatType = 'ward-panch') {
  await picker.ready;
  choose(picker.selects.seatType, seatType);
  choose(picker.selects.district, '17');
  await waitFor(() => optionValues(picker.selects.panchayat).includes('6313'));
  choose(picker.selects.panchayat, '6313');
}

test('picker steps run seat type, district, panchayat, ward, in Hindi', async () => {
  const { d, picker } = mountScreen();
  assert.equal(picker.state(), 'loading');
  assert.equal(picker.notice.textContent, strings.picker_loading);
  await picker.ready;
  const labels = d.body.querySelectorAll('label').map((l) => l.textContent);
  assert.deepEqual(labels, ['सीट', 'ज़िला', strings.picker_panchayat_search, 'ग्राम पंचायत', 'वार्ड']);
  assert.deepEqual(d.body.querySelectorAll('select'),
    [picker.selects.seatType, picker.selects.district, picker.selects.panchayat, picker.selects.ward]);
  assert.deepEqual(optionValues(picker.selects.seatType), ['', 'ward-panch', 'sarpanch']);
  assert.deepEqual(optionValues(picker.selects.district), ['', '1', '17']);
  assert.deepEqual(picker.selects.district.children.map((o) => o.textContent), ['ज़िला चुनें', 'अजमेर', 'जयपुर']);
  assert.ok(picker.selects.district.hasAttribute('disabled'), 'district waits for the seat type');
  assert.ok(picker.selects.panchayat.hasAttribute('disabled'));
  assert.ok(picker.search.hasAttribute('disabled'));
  choose(picker.selects.seatType, 'ward-panch');
  assert.ok(!picker.selects.district.hasAttribute('disabled'));
});

test('a ward panch pick emits exactly one ward with its pdfUrl; the shard is fetched only after its district', async () => {
  const { picked, picker, requests } = mountScreen();
  await picker.ready;
  assert.deepEqual(requests, ['data/sec/catalogue/index.json']);
  choose(picker.selects.seatType, 'ward-panch');
  assert.deepEqual(requests, ['data/sec/catalogue/index.json']);
  await toPanchayat(picker);
  assert.deepEqual(requests, ['data/sec/catalogue/index.json', SHARD]);
  assert.deepEqual(optionValues(picker.selects.ward), ['', '1', '2', '3', '4', '5', '6', '7'], 'ward-number order');
  assert.equal(picked.length, 0);
  choose(picker.selects.ward, '2');
  assert.equal(picked.length, 1);
  assert.deepEqual(picked[0], {
    schemaVersion: 1,
    seatType: 'ward-panch',
    district: { id: '17', name: 'जयपुर', nameLatin: 'JAIPUR' },
    panchayat: { id: '6313', name: 'बडली', nameLatin: 'Badli', block: { id: '125', name: 'चाकसू', nameLatin: 'CHAKSU' } },
    wards: [{ ward: 2, pdfUrl: BADLI_WARD(2) }],
  });
  assert.equal(picker.wardSelection(), picked[0]);
  assert.equal(picker.state(), 'success');
  // Picking the same district again later uses the shard already loaded.
  choose(picker.selects.district, '1');
  await waitFor(() => optionValues(picker.selects.panchayat).includes('24'));
  choose(picker.selects.district, '17');
  await waitFor(() => optionValues(picker.selects.panchayat).includes('6313'));
  assert.deepEqual(requests, ['data/sec/catalogue/index.json', SHARD, 'data/sec/catalogue/ajmer.json']);
});

test('a sarpanch pick skips the ward step and selects every ward in ward-number order', async () => {
  const { picked, picker } = mountScreen();
  await toPanchayat(picker, 'sarpanch');
  assert.ok(picker.selects.ward.parentNode.hidden);
  assert.equal(picked.length, 1);
  assert.equal(picked[0].seatType, 'sarpanch');
  assert.deepEqual(picked[0].wards, [1, 2, 3, 4, 5, 6, 7].map((n) => ({ ward: n, pdfUrl: BADLI_WARD(n) })));
  assert.match(picker.notice.textContent, / 7$/);
  // Back to ward panch: the ward step returns and nothing is selected until a ward is.
  choose(picker.selects.seatType, 'ward-panch');
  assert.equal(picker.selects.ward.parentNode.hidden, false);
  assert.equal(picker.wardSelection(), null);
});

test('offline: Hindi message shown, selection still valid and onSelect still fires', async () => {
  const { picked, picker } = mountScreen({ isOnline: () => false });
  await toPanchayat(picker);
  choose(picker.selects.ward, '3');
  assert.equal(picker.message.textContent, 'नेटवर्क नहीं है');
  assert.equal(picker.wardSelection().wards[0].ward, 3);
  assert.equal(picked.length, 1);
  choose(picker.selects.ward, '');
  assert.equal(picker.message.textContent, '', 'message clears when the selection does');
  assert.equal(picker.wardSelection(), null);
});

test('default online check uses navigator.onLine', () => {
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

test('a ward value outside the panchayat cannot be selected', async () => {
  const { picked, picker } = mountScreen();
  await toPanchayat(picker);
  choose(picker.selects.ward, '99');
  assert.equal(picker.wardSelection(), null);
  assert.equal(picked.length, 0);
});

test('the panchayat search filters by Hindi name, block name or Latin name', async () => {
  const { picker } = mountScreen();
  await toPanchayat(picker);
  const type = (text) => { picker.search.value = text; picker.search.dispatchEvent({ type: 'input' }); };
  assert.deepEqual(optionValues(picker.selects.panchayat), ['', '6714', '6250', '6313']);
  type('बड');
  assert.deepEqual(optionValues(picker.selects.panchayat), ['', '6313']);
  type('ACHR');
  assert.deepEqual(optionValues(picker.selects.panchayat), ['', '6250']);
  type('आमेर');
  assert.deepEqual(optionValues(picker.selects.panchayat), ['', '6250'], 'the block name matches too');
  type('क्ष');
  assert.deepEqual(optionValues(picker.selects.panchayat), ['']);
  assert.equal(picker.state(), 'empty');
  assert.equal(picker.notice.textContent, strings.picker_no_match);
  type('');
  assert.equal(optionValues(picker.selects.panchayat).length, 4);
  assert.equal(picker.selects.panchayat.children[3].textContent, 'बडली (चाकसू)');
});

test('loading, error with retry and support contact, then success', async () => {
  let failShard = true;
  const fetch = async (url) => (url === SHARD && failShard ? new Response('', { status: 503 })
    : catalogueResponse(url, 'test/fixtures/catalogue/'));
  const { picker } = mountScreen({ fetch, support: 'ब्लॉक समन्वयक: ९८७६५' });
  await picker.ready;
  choose(picker.selects.seatType, 'sarpanch');
  choose(picker.selects.district, '17');
  assert.equal(picker.state(), 'loading');
  await waitFor(() => picker.state() === 'error');
  assert.equal(picker.notice.textContent, strings.picker_error_retry);
  assert.equal(picker.contact.textContent, 'ब्लॉक समन्वयक: ९८७६५');
  assert.equal(picker.retryButton.hidden, false);
  failShard = false;
  picker.retryButton.dispatchEvent({ type: 'click' });
  await waitFor(() => optionValues(picker.selects.panchayat).includes('6313'));
  assert.equal(picker.state(), 'ready');
  assert.equal(picker.retryButton.hidden, true);
  choose(picker.selects.panchayat, '6313');
  assert.equal(picker.state(), 'success');
});

test('a shard of an unknown schemaVersion is a visible "update the app" error, never a misread list', async () => {
  const fetch = async (url) => {
    if (url !== SHARD) return catalogueResponse(url, 'test/fixtures/catalogue/');
    const doc = JSON.parse(read('test/fixtures/catalogue/jaipur.json'));
    return new Response(JSON.stringify({ ...doc, schemaVersion: 2 }));
  };
  const { picker } = mountScreen({ fetch });
  await picker.ready;
  choose(picker.selects.seatType, 'ward-panch');
  choose(picker.selects.district, '17');
  await waitFor(() => picker.state() === 'error');
  assert.equal(picker.notice.textContent, strings.catalogue_version_unsupported);
  assert.deepEqual(optionValues(picker.selects.panchayat), ['']);
  assert.equal(picker.retryButton.hidden, true);
});

test('with a roll loaded, a seat type, district or panchayat change waits for "yes"; a ward change does not', async () => {
  let loaded = false;
  const { picked, picker } = mountScreen({ hasLoadedRoll: () => loaded });
  await toPanchayat(picker);
  choose(picker.selects.ward, '1');
  loaded = true;
  choose(picker.selects.ward, '2');
  assert.equal(picker.confirmBox.hidden, true);
  assert.equal(picked.length, 2);

  for (const [key, value] of [['seatType', 'sarpanch'], ['district', '1'], ['panchayat', '6250']]) {
    choose(picker.selects[key], value);
    assert.equal(picker.confirmBox.hidden, false, key);
    assert.equal(picker.confirmBox.getAttribute('role'), 'alertdialog');
    assert.notEqual(picker.selects[key].value, value, `${key} unchanged until "yes"`);
    picker.confirmNo.dispatchEvent({ type: 'click' });
    assert.equal(picker.confirmBox.hidden, true);
    assert.equal(picker.wardSelection().wards[0].ward, 2);
  }
  assert.equal(picked.length, 2, 'nothing replaced');

  choose(picker.selects.panchayat, '6250');
  picker.confirmYes.dispatchEvent({ type: 'click' });
  assert.equal(picker.selects.panchayat.value, '6250');
  assert.equal(picker.wardSelection(), null, 'a new panchayat needs its ward');
  assert.ok(picker.confirmYes.className.includes('btn-danger'));
  assert.ok(picker.confirmNo.className.includes('btn-secondary'));
});

test('a stored selection is put back without being emitted', async () => {
  const first = mountScreen();
  await toPanchayat(first.picker);
  choose(first.picker.selects.ward, '5');
  const { picked, picker } = mountScreen({ initial: first.picked[0] });
  await picker.ready;
  await waitFor(() => picker.wardSelection() !== null);
  assert.equal(picker.selects.ward.value, '5');
  assert.deepEqual(picker.wardSelection(), first.picked[0]);
  assert.equal(picked.length, 0);
});

test('every picker tap target is at least 48 px tall', async () => {
  const css = read('styles.css').replace(/\/\*[\s\S]*?\*\//g, '');
  const tall = (cls) => [...css.matchAll(/([^{}]+)\{([^}]*)\}/g)]
    .some((m) => m[1].split(',').map((x) => x.trim()).includes(`.${cls}`)
      && /min-height:\s*var\(--touch-target\)/.test(m[2]));
  const { d, picker } = mountScreen();
  await picker.ready;
  const controls = [...d.body.querySelectorAll('select'), ...d.body.querySelectorAll('input'),
    ...d.body.querySelectorAll('button')];
  assert.equal(controls.length, 4 + 1 + 3);
  for (const control of controls) {
    const classes = control.className.split(/\s+/);
    assert.ok(classes.some(tall), `${control.tagName}.${control.className} is under 48 px`);
  }
});

test('the old single-file catalogue is gone and nothing reads it', () => {
  assert.equal(existsSync(new URL('../data/sec/catalogue.json', import.meta.url)), false);
  for (const rel of ['js/picker.js', 'src/ui/wardPickerScreen.js', 'src/picker/catalogue.js', 'sw.js']) {
    assert.doesNotMatch(read(rel), /data\/sec\/catalogue\.json/, rel);
  }
});
