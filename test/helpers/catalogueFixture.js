// The sharded ward catalogue for tests: the shards tools/sec-catalogue builds
// from fixtures/sec/catalogue-input (test/fixtures/catalogue/, rebuilt with
// `python3 tools/sec-catalogue/build_catalogue.py --input
// fixtures/sec/catalogue-input --out test/fixtures/catalogue`), plus a Jaipur
// shard holding Badli (district 17, samiti 125, panchayat 6313) taken from
// config/constituency.json, so the wiring tests keep the ward key
// 17/125/6313/<ward> and the Badli roll fixture.

import { readFileSync } from 'node:fs';

const read = (rel) => readFileSync(new URL(`../../${rel}`, import.meta.url), 'utf8');

export const CATALOGUE_DIR = 'test/fixtures/catalogue/';

/** The catalogue files by URL path (data/sec/catalogue/<file>), as parsed JSON. */
export function catalogueFiles() {
  const index = JSON.parse(read(`${CATALOGUE_DIR}index.json`));
  const files = {};
  for (const d of index.districts) files[d.file] = JSON.parse(read(CATALOGUE_DIR + d.file));
  const config = JSON.parse(read('config/constituency.json'));
  const district = config.districts[0];
  const samiti = district.samitis[0];
  files['jaipur.json'] = {
    schemaVersion: 1,
    id: district.id,
    name: district.label,
    nameLatin: 'JAIPUR',
    panchayats: samiti.panchayats.map((p) => ({
      id: p.id,
      name: p.label,
      nameLatin: 'BADLI',
      block: { id: samiti.id, name: samiti.label, nameLatin: 'CHAKSU' },
      wards: p.wards.map((w) => ({ ward: Number(w.id), pdfUrl: w.pdfUrl, supplementUrl: null })),
    })),
  };
  index.districts.push({ id: district.id, name: district.label, nameLatin: 'JAIPUR', file: 'jaipur.json', panchayatCount: 1 });
  files['index.json'] = index;
  return files;
}

/**
 * A Response for a catalogue URL ("data/sec/catalogue/<file>"), or null for
 * any other URL. files defaults to catalogueFiles(); a missing file is a 404.
 */
export function catalogueResponse(url, files = catalogueFiles()) {
  const m = /^(?:\/)?data\/sec\/catalogue\/([^/]+)$/.exec(String(url));
  if (!m) return null;
  return files[m[1]] ? new Response(JSON.stringify(files[m[1]])) : new Response('', { status: 404 });
}

async function waitFor(cond, ms = 8000) {
  const until = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > until) throw new Error('timed out');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/** The picker's option buttons under root. */
export const pickerOptions = (root) => root.querySelectorAll('button.picker-option');

/** The option button with this value, or null. */
export const pickerOption = (root, value) => pickerOptions(root)
  .find((b) => b.getAttribute('data-value') === String(value)) || null;

/** Wait for an option to show, then tap it. */
export async function tapOption(root, value) {
  await waitFor(() => pickerOption(root, value) !== null);
  pickerOption(root, value).dispatchEvent({ type: 'click' });
}

/** Tap through the picker: seat type, district, panchayat and (ward panch) ward. */
export async function pickSeat(root, { seat = 'ward-panch', district = '17', panchayat = '6313', ward = '1' } = {}) {
  await tapOption(root, seat);
  await tapOption(root, district);
  await tapOption(root, panchayat);
  if (seat === 'ward-panch') await tapOption(root, ward);
}
