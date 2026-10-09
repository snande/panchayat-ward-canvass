// Merge supplementary SEC rolls onto a ward's decoded roll.
//
// A supplementary roll PDF (the SEC's "Final With Supp-<n>" column) is decoded
// by the same decoder as the roll (src/decoder/decodeRoll.js). It reprints the
// roll with the supplement's changes: entries added at new serials, entries
// struck off and, rarely, entries struck off before and listed again. Merged
// by serial, in publication order, each supplement's printed struck-off state
// wins over the roll as merged so far:
//   - a serial not on it is an addition, tagged supplement: 'addition' (or
//     'deletion' if the supplement prints it struck off)
//   - a serial listed live that the supplement prints struck off is marked
//     struck: true, supplement: 'deletion'
//   - a serial struck off that the supplement prints live is reinstated:
//     struck: false, supplement: 'addition' (it is on the roll again)
// So an entry's tag is the last change a supplement made to it, relative to
// the roll merged so far: a serial supp-1 strikes off and supp-2 lists again
// is an addition, the same as one the roll itself struck off and a supplement
// reinstated. An entry no supplement changes keeps its tag, if any, and the
// roll's own record: name, age and the rest never change.
//
// Merging is sequential, so merging supp-1 and later merging supp-2 onto the
// result is the same as merging [supp-1, supp-2] at once; merging the same
// supplement twice changes nothing.

// loadSupplements downloads and decodes a selection's supplementary rolls in
// that order for src/roll/rollFlow.js, which loads this module only when a
// supplementary roll is to be downloaded.

import { supplementUrls } from './fetchRoll.js';

export { SUPPLEMENT_KINDS, isSupplementDeletion } from './supplementTags.js';

/**
 * @param {object[]} baseEntries the roll's decoded entries ({serial, ..., struck})
 * @param {object[][]} supplementEntries each supplement's decoded entries, in
 *   publication order
 * @returns {object[]} the merged entries in serial order; the inputs are not
 *   changed
 */
export function applySupplements(baseEntries, supplementEntries = []) {
  if (!Array.isArray(baseEntries)) throw new TypeError('baseEntries must be an array');
  const bySerial = new Map();
  for (const entry of baseEntries) {
    if (entry && Number.isFinite(entry.serial)) bySerial.set(entry.serial, { ...entry });
  }
  for (const supplement of Array.isArray(supplementEntries) ? supplementEntries : []) {
    for (const entry of Array.isArray(supplement) ? supplement : []) {
      if (!entry || !Number.isFinite(entry.serial)) continue;
      const struck = entry.struck === true;
      const prev = bySerial.get(entry.serial);
      if (!prev) {
        bySerial.set(entry.serial, { ...entry, struck, supplement: struck ? 'deletion' : 'addition' });
      } else if (struck !== (prev.struck === true)) {
        bySerial.set(entry.serial, { ...prev, struck, supplement: struck ? 'deletion' : 'addition' });
      }
    }
  }
  return [...bySerial.values()].sort((a, b) => a.serial - b.serial);
}

/** A supplementary roll downloaded and decoded, or null (logged) if it failed. */
async function loadSupplement(selection, url, { fetchSupplements, decode, log }) {
  const [result] = await fetchSupplements({ ...selection, supplementPdfUrls: [url] });
  if (!result || !result.ok) {
    log('supplementary roll could not be downloaded', url, result && result.error);
    return null;
  }
  try {
    const decoded = await decode(result.buffer);
    if (!Array.isArray(decoded) || decoded.length === 0) throw new Error('decoder returned no entries');
    return decoded;
  } catch (err) {
    log('supplementary roll could not be decoded', url, err);
    return null;
  }
}

/**
 * Download and decode, in publication order, the selection's supplementary
 * rolls after the `merged` ones, stopping at the first that fails: the later
 * ones wait, so an earlier supplement is never merged over a later one.
 * @param {{fetchSupplements: Function, decode: Function, log: Function}} deps
 * @returns {Promise<{lists: object[][], urls: string[], failed: boolean}>}
 *   the decoded rolls, every URL merged once these are (merged first), and
 *   whether one failed
 */
export async function loadSupplements(selection, merged, deps) {
  const lists = [];
  const urls = [...merged];
  for (const url of supplementUrls(selection).slice(merged.length)) {
    const decoded = await loadSupplement(selection, url, deps);
    if (!decoded) return { lists, urls, failed: true };
    lists.push(decoded);
    urls.push(url);
  }
  return { lists, urls, failed: false };
}
