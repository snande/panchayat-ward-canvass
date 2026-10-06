// Ward catalogue + picker tests (issue #15), run by `npm test`.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  districts, samitis, panchayats, wards, resolveWard, selectionFor,
} from '../src/picker/wardPicker.js';
import { mountWardPicker } from '../src/ui/wardPickerScreen.js';
import { createDocument } from './helpers/fakeDom.js';

const read = (rel) => readFileSync(new URL('../' + rel, import.meta.url), 'utf8');
const config = JSON.parse(read('config/constituency.json'));
const strings = JSON.parse(read('src/strings.hi.json'));
const doc = read('docs/research/sec-roll-source.md');

const WARD1 = 'https://esuchiroll.rajasthan.gov.in/Publication_PDF_2026/PRI/Final/125/BADLI-Ward%20No-001.pdf';
const BADLI = { district: '17', samiti: '125', panchayat: '6313' };

test('Badli ward 1 resolves to the researched URL', () => {
  assert.equal(resolveWard(config, { ...BADLI, ward: '1' }), WARD1);
  assert.ok(doc.includes(WARD1));
});

test('config holds only Badli wards 1-7 and every URL is in the research doc', () => {
  assert.deepEqual(districts(config).map((d) => d.id), ['17']);
  assert.deepEqual(samitis(config, '17').map((d) => d.id), ['125']);
  assert.deepEqual(panchayats(config, '17', '125').map((d) => d.id), ['6313']);
  const list = wards(config, '17', '125', '6313');
  assert.equal(list.length, 7);
  for (const w of list) {
    const url = resolveWard(config, { ...BADLI, ward: w.id });
    assert.ok(doc.includes(url), url);
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
const settle = () => new Promise((resolve) => setImmediate(resolve));

test('picker shows four dependent Hindi dropdowns in order', async () => {
  const d = createDocument();
  const picked = [];
  const picker = mountWardPicker(d.body, config, strings, {
    connectivityCheck: async () => true, onSelect: (s) => picked.push(s),
  });
  const labels = d.body.querySelectorAll('label').map((l) => l.textContent);
  assert.deepEqual(labels, ['ज़िला', 'पंचायत समिति', 'ग्राम पंचायत', 'वार्ड']);
  const { district, samiti, panchayat, ward } = picker.selects;
  assert.deepEqual(optionValues(district), ['', '17']);
  assert.deepEqual(optionValues(samiti), ['']);

  choose(district, '17');
  assert.deepEqual(optionValues(samiti), ['', '125']);
  assert.deepEqual(optionValues(panchayat), ['']);
  choose(samiti, '125');
  choose(panchayat, '6313');
  assert.deepEqual(optionValues(ward), ['', '1', '2', '3', '4', '5', '6', '7']);
  assert.equal(picker.wardSelection(), null);

  choose(ward, '1');
  await settle();
  assert.deepEqual(picker.wardSelection(), { ...BADLI, ward: '1', pdfUrl: WARD1 });
  assert.equal(picked.length, 1);
  assert.equal(picker.message.textContent, '');

  choose(district, '17');
  assert.equal(picker.wardSelection(), null, 'changing a parent clears the ward');
  assert.deepEqual(optionValues(ward), ['']);
});

test('choosing a ward offline shows the Hindi network message', async () => {
  const d = createDocument();
  const picker = mountWardPicker(d.body, config, strings, { connectivityCheck: async () => false });
  choose(picker.selects.district, '17');
  choose(picker.selects.samiti, '125');
  choose(picker.selects.panchayat, '6313');
  choose(picker.selects.ward, '3');
  await settle();
  assert.equal(picker.message.textContent, 'नेटवर्क नहीं है');
});

test('a ward value outside the config cannot be selected', async () => {
  const d = createDocument();
  const picker = mountWardPicker(d.body, config, strings, { connectivityCheck: async () => true });
  choose(picker.selects.district, '17');
  choose(picker.selects.samiti, '125');
  choose(picker.selects.panchayat, '6313');
  choose(picker.selects.ward, '99');
  await settle();
  assert.equal(picker.wardSelection(), null);
});
