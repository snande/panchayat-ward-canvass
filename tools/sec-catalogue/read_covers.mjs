#!/usr/bin/env node
// Prints, as one JSON object, the Hindi district and panchayat samiti names
// printed on the cover page of each roll PDF given, keyed by the path as
// given: {"<path>": {"district": "जयपुर", "samiti": "चाकसू"}, ...}. A name the
// cover does not yield, or a file that cannot be read or decoded, is null.
// build_catalogue.py calls this; it uses the repo's glyph-matching decoder
// (src/decoder, no OCR) and the committed master glyph table.
//
//   node tools/sec-catalogue/read_covers.mjs cover-60.pdf cover-240.pdf

import { readFileSync } from 'node:fs';

import { readRollCover } from '../../src/decoder/rollCover.js';

const table = JSON.parse(
  readFileSync(new URL('../../src/decoder/master-glyph-table.json', import.meta.url), 'utf8'),
);

const out = {};
for (const path of process.argv.slice(2)) {
  try {
    out[path] = readRollCover(readFileSync(path), { table });
  } catch (err) {
    out[path] = { district: null, samiti: null, error: String(err && err.message ? err.message : err) };
  }
}
process.stdout.write(`${JSON.stringify(out)}\n`);
