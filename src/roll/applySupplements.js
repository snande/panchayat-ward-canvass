// Merge supplementary SEC rolls onto a ward's decoded roll.
//
// A supplementary roll PDF (the SEC's "Final With Supp-<n>" column) is decoded
// by the same decoder as the roll (src/decoder/decodeRoll.js). It reprints the
// roll with the supplement's changes: entries added at new serials, entries
// struck off and, rarely, entries struck off before and listed again. Merged
// by serial, the supplement's printed struck-off state wins:
//   - a serial the roll does not have is an addition, tagged
//     supplement: 'addition' (or 'deletion' if the supplement prints it struck
//     off)
//   - a serial the roll lists live but the supplement prints struck off marks
//     the roll's entry struck: true, supplement: 'deletion'
//   - a serial the roll prints struck off but the supplement prints live is
//     reinstated: struck: false, supplement: 'addition' (it is on the roll again)
// An entry whose struck-off state the supplement does not change keeps its
// tag, if any, and the roll's own record: name, age and the rest never change.
// Merging the same supplement twice changes nothing.

export const SUPPLEMENT_KINDS = Object.freeze(['addition', 'deletion']);

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

/** Whether an entry is a supplementary deletion, hidden unless deletions show. */
export function isSupplementDeletion(entry) {
  return Boolean(entry) && entry.supplement === 'deletion';
}
