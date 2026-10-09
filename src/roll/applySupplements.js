// Merge supplementary SEC rolls onto a ward's decoded roll.
//
// A supplementary roll PDF (the SEC's "Final With Supp-<n>" column) is decoded
// by the same decoder as the roll (src/decoder/decodeRoll.js). It reprints the
// roll with the supplement's changes: entries added at new serials and entries
// struck off. Merged by serial:
//   - a serial the roll does not have is an addition, tagged
//     supplement: 'addition' (or 'deletion' if the supplement prints it struck
//     off)
//   - a serial the roll lists live but the supplement prints struck off marks
//     the roll's entry struck: true, supplement: 'deletion'
// Entries the roll already printed struck off stay as they are, untagged.
// Nothing else of the roll's entry changes: the roll's own record wins.

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
      } else if (struck && prev.struck !== true) {
        bySerial.set(entry.serial, { ...prev, struck: true, supplement: 'deletion' });
      }
    }
  }
  return [...bySerial.values()].sort((a, b) => a.serial - b.serial);
}

/** Whether an entry is a supplementary deletion, hidden unless deletions show. */
export function isSupplementDeletion(entry) {
  return Boolean(entry) && entry.supplement === 'deletion';
}
