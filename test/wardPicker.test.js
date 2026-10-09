// Ward catalogue + picker tests (issue #15), run by `npm test`.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  districts, samitis, panchayats, wards, resolveWard, selectionFor, selectionForWardKey,
} from '../src/picker/wardPicker.js';
import { mountWardPicker, defaultIsOnline } from '../src/ui/wardPickerScreen.js';
import { createDocument } from './helpers/fakeDom.js';

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
  assert.deepEqual(districts(config).map((d) => d.id), ['17']);
  assert.deepEqual(samitis(config, '17').map((d) => d.id), ['125']);
  assert.deepEqual(panchayats(config, '17', '125').map((d) => d.id), ['6313']);
  const list = wards(config, '17', '125', '6313');
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

function choose(select, value) {
  select.value = value;
  select.dispatchEvent({ type: 'change' });
}
const optionValues = (select) => select.children.map((o) => o.getAttribute('value'));

function mount(opts = {}) {
  const d = createDocument();
  const picked = [];
  const picker = mountWardPicker(d.body, config, strings, { onSelect: (s) => picked.push(s), ...opts });
  return { d, picked, picker };
}

function pickBadli(picker, ward) {
  choose(picker.selects.district, '17');
  choose(picker.selects.samiti, '125');
  choose(picker.selects.panchayat, '6313');
  choose(picker.selects.ward, ward);
}

test('picker shows four dependent Hindi dropdowns in order', () => {
  const { d, picked, picker } = mount({ isOnline: () => true });
  const labels = d.body.querySelectorAll('label').map((l) => l.textContent);
  assert.deepEqual(labels, ['ज़िला', 'पंचायत समिति', 'ग्राम पंचायत', 'वार्ड']);
  const { district, samiti, panchayat, ward } = picker.selects;
  assert.deepEqual(optionValues(district), ['', '17']);
  assert.deepEqual(optionValues(samiti), ['']);
  assert.ok(samiti.hasAttribute('disabled'), 'child is disabled until its parent is chosen');
  assert.ok(!district.hasAttribute('disabled'));

  choose(district, '17');
  assert.deepEqual(optionValues(samiti), ['', '125']);
  assert.ok(!samiti.hasAttribute('disabled'));
  assert.deepEqual(optionValues(panchayat), ['']);
  choose(samiti, '125');
  choose(panchayat, '6313');
  assert.deepEqual(optionValues(ward), ['', '1', '2', '3', '4', '5', '6', '7']);
  assert.equal(picker.wardSelection(), null);

  choose(ward, '1');
  assert.deepEqual(picker.wardSelection(), { ...BADLI, ward: '1', pdfUrl: WARD1 });
  assert.equal(picked.length, 1);
  assert.equal(picker.message.textContent, '');

  choose(district, '17');
  assert.equal(picker.wardSelection(), null, 'changing a parent clears the ward');
  assert.deepEqual(optionValues(ward), ['']);
});

test('choosing the placeholder at a parent level clears everything below', () => {
  const { picker } = mount({ isOnline: () => true });
  pickBadli(picker, '2');
  assert.ok(picker.wardSelection());
  choose(picker.selects.panchayat, '');
  assert.equal(picker.wardSelection(), null);
  assert.deepEqual(optionValues(picker.selects.ward), ['']);
  pickBadli(picker, '2');
  choose(picker.selects.district, '');
  assert.equal(picker.wardSelection(), null);
  assert.deepEqual(optionValues(picker.selects.samiti), ['']);
  assert.deepEqual(optionValues(picker.selects.panchayat), ['']);
  assert.deepEqual(optionValues(picker.selects.ward), ['']);
  assert.ok(picker.selects.ward.hasAttribute('disabled'));
});

test('offline: Hindi message shown, selection still valid and onSelect still fires', () => {
  const { picked, picker } = mount({ isOnline: () => false });
  pickBadli(picker, '3');
  assert.equal(picker.message.textContent, 'नेटवर्क नहीं है');
  assert.equal(picker.wardSelection().ward, '3');
  assert.equal(picked.length, 1);
  choose(picker.selects.ward, '4');
  assert.equal(picker.message.textContent, 'नेटवर्क नहीं है');
  choose(picker.selects.district, '17');
  assert.equal(picker.message.textContent, '', 'message clears when the selection changes');
});

test('default online check uses navigator.onLine and sends no request', () => {
  const realFetch = globalThis.fetch;
  let fetched = 0;
  globalThis.fetch = () => { fetched += 1; return Promise.reject(new Error('no')); };
  const desc = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  const setNav = (value) => Object.defineProperty(globalThis, 'navigator', { value, configurable: true });
  try {
    setNav({ onLine: false });
    assert.equal(defaultIsOnline(), false);
    const { picker } = mount();
    pickBadli(picker, '1');
    assert.equal(picker.message.textContent, 'नेटवर्क नहीं है');
    setNav({ onLine: true });
    assert.equal(defaultIsOnline(), true);
    assert.equal(fetched, 0);
  } finally {
    globalThis.fetch = realFetch;
    if (desc) Object.defineProperty(globalThis, 'navigator', desc);
    else delete globalThis.navigator;
  }
});

test('a ward value outside the config cannot be selected', () => {
  const { picked, picker } = mount({ isOnline: () => true });
  pickBadli(picker, '99');
  assert.equal(picker.wardSelection(), null);
  assert.equal(picked.length, 0);
});

test('picker strings are non-empty Hindi, with no Latin letters', () => {
  const keys = [
    'picker_district', 'picker_samiti', 'picker_panchayat', 'picker_ward',
    'picker_district_prompt', 'picker_samiti_prompt', 'picker_panchayat_prompt',
    'picker_ward_prompt', 'network_unavailable', 'picker_loading', 'picker_load_failed',
  ];
  for (const key of keys) {
    assert.match(strings[key] ?? '', /[ऀ-ॿ]/, key);
    assert.doesNotMatch(strings[key], /[A-Za-z]/, key);
  }
  for (const level of [districts(config), samitis(config, '17'), panchayats(config, '17', '125'),
    wards(config, '17', '125', '6313')]) {
    for (const item of level) assert.match(item.label, /[ऀ-ॿ]/, item.id);
  }
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

test('service worker precaches the picker, its catalogue and strings', () => {
  const sw = read('sw.js');
  const html = read('index.html');
  for (const file of ['js/picker.js', 'config/constituency.json', 'src/picker/wardPicker.js',
    'src/ui/wardPickerScreen.js', 'src/strings.hi.json']) {
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
