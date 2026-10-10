// Drives the ward picker (src/ui/wardPickerScreen.js) the way a worker does:
// seat type, district, panchayat, then ward (skipped for a sarpanch). Works on
// the fake DOM, against whatever catalogue the test's fetch serves.

async function waitFor(cond, what, ms = 8000) {
  const until = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > until) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/** Fire a select's change event with value chosen. */
export function choose(select, value) {
  select.value = value;
  select.dispatchEvent({ type: 'change' });
}

export const tap = (node) => node.dispatchEvent({ type: 'click' });

export const seatButton = (root, type) => root.querySelectorAll('button.picker-seat-option')
  .find((b) => b.getAttribute('data-seat-type') === type) || null;

export const districtSelect = (root) => root.querySelectorAll('select').find((s) => s.getAttribute('id') === 'picker-district') || null;

export const wardSelect = (root) => root.querySelectorAll('select').find((s) => s.getAttribute('id') === 'picker-ward') || null;

export const panchayatRow = (root, id) => root.querySelectorAll('button.picker-panchayat-option')
  .find((b) => b.getAttribute('data-id') === id) || null;

/** Resolves once the picker is mounted (its seat-type buttons are there). */
export function pickerReady(root) {
  return waitFor(() => seatButton(root, 'ward-panch') !== null, 'the picker');
}

/** Choose the seat type and district, and wait for the district's panchayat rows. */
export async function openDistrict(root, { seat = 'ward-panch', district = '17' } = {}) {
  await pickerReady(root);
  tap(seatButton(root, seat));
  const select = districtSelect(root);
  await waitFor(() => !select.hasAttribute('disabled') && select.children.length > 1, 'the district list');
  choose(select, district);
  await waitFor(() => root.querySelectorAll('button.picker-panchayat-option').length > 0, 'the panchayat list');
}

/**
 * Pick a seat: Badli ward 1 by default. A sarpanch pick stops at the
 * panchayat. Pass ward: null to stop before the ward step.
 */
export async function pickWard(root, {
  seat = 'ward-panch', district = '17', panchayat = '6313', ward = '1',
} = {}) {
  await openDistrict(root, { seat, district });
  tap(panchayatRow(root, panchayat));
  if (seat === 'ward-panch' && ward !== null) choose(wardSelect(root), ward);
}
