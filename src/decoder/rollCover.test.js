// readRollCover against the covers of Badli ward 1 and the five SEC fixture
// panchayats: the Hindi district and panchayat samiti names the statewide
// catalogue (tools/sec-catalogue) takes from the SEC's own roll covers.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { coverNames, readRollCover } from './rollCover.js';

const root = new URL('../../', import.meta.url);
const read = (rel) => readFileSync(new URL(rel, root));
const table = JSON.parse(read('src/decoder/master-glyph-table.json').toString('utf8'));

const covers = [
  ['fixtures/badli-ward1.pdf', 'जयपुर', 'चाकसू'],
  ['fixtures/sec/bharatpur/ARAUDA-ward-001.pdf', 'भरतपुर', 'नदबई'],
  ['fixtures/sec/bhilwara/ALMAS-ward-001.pdf', 'भीलवाडा', 'माण्डल'],
  ['fixtures/sec/bikaner/BHOLASAR-ward-001.pdf', 'बीकानेर', 'कोलायत'],
  ['fixtures/sec/jodhpur/ASHAPURA-ward-001.pdf', 'जोधपुर', 'ओसियाँ'],
  ['fixtures/sec/udaipur/AMARPURA-ward-001.pdf', 'उदयपुर', 'गिर्वा'],
];

for (const [pdf, district, samiti] of covers) {
  test(`readRollCover reads ${district} / ${samiti} from ${pdf}`, () => {
    assert.deepEqual(readRollCover(read(pdf), { table }), { district, samiti });
  });
}

test('coverNames falls back to the zila parishad header when the जिला row is missing', () => {
  const lines = [
    { x: 55, y: -83, text: 'जिलापरिषद का नाम : जयपुरजि॰ प॰ सदस्य निर्वाचन क्षेत्र : 34' },
    { x: 55, y: -119, text: 'पंचायत समिति का नाम : चाकसू' },
  ];
  assert.deepEqual(coverNames(lines), { district: 'जयपुर', samiti: 'चाकसू' });
});

test('coverNames returns null for a name it cannot read, never a garbled one', () => {
  const lines = [
    { x: 55, y: -119, text: 'पंचायत समिति का नाम : चा�सू' },
    { x: 60, y: -272, text: 'जिला' },
    { x: 151, y: -272, text: ':' },
  ];
  assert.deepEqual(coverNames(lines), { district: null, samiti: null });
  assert.deepEqual(coverNames([]), { district: null, samiti: null });
});
