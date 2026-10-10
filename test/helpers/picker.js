// Drives the ward picker (src/ui/wardPickerScreen.js) the way a canvasser
// does: seat type, district, gram panchayat, ward. The catalogue loads
// asynchronously, so each step waits for its options to appear.

import { readFileSync } from 'node:fs';

const root = (rel) => new URL('../../' + rel, import.meta.url);

/** The catalogue file a page fetch asks for (data/sec/catalogue/...), or null. */
export function catalogueResponse(url, dir = 'data/sec/catalogue/') {
  const m = /^data\/sec\/catalogue\/([a-z0-9-]+\.json)$/.exec(url);
  if (!m) return null;
  try {
    return new Response(readFileSync(root(dir + m[1])));
  } catch {
    return new Response('', { status: 404 });
  }
}

export async function waitFor(cond, ms = 8000) {
  const until = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > until) throw new Error('timed out');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

export function choose(select, value) {
  select.value = value;
  select.dispatchEvent({ type: 'change' });
}

export const optionValues = (select) => (select ? select.children.map((o) => o.getAttribute('value')) : []);
const hasOption = (select, value) => optionValues(select).includes(value);

/** The picker's four selects, in order: seat type, district, panchayat, ward. */
export function pickerSelects(container) {
  const [seatType, district, panchayat, ward] = container.querySelectorAll('select');
  return { seatType, district, panchayat, ward };
}

/** Choose a seat type, district and panchayat (Badli, Chaksu, Jaipur by default). */
export async function pickPanchayat(container, { seatType = 'ward-panch', district = '17', panchayat = '6313' } = {}) {
  await waitFor(() => container.querySelector('select') !== null);
  const selects = pickerSelects(container);
  choose(selects.seatType, seatType);
  await waitFor(() => hasOption(selects.district, district));
  choose(selects.district, district);
  await waitFor(() => hasOption(selects.panchayat, panchayat));
  choose(selects.panchayat, panchayat);
  return selects;
}

/** A full ward panch pick: seat type, district, panchayat and ward. */
export async function pickWard(container, ward = '1', opts = {}) {
  const selects = await pickPanchayat(container, opts);
  choose(selects.ward, ward);
  return selects;
}
