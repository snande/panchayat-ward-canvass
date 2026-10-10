// Reads the district and panchayat samiti names a roll's cover page prints
// in Hindi. The cover is decoded by the same glyph-matching decoder as the
// entries (readCoverLines); no OCR. The statewide catalogue
// (tools/sec-catalogue) takes its Hindi district and samiti names from here,
// because the SEC portal's dropdowns publish them in Latin only.
//
// The cover of every 2026 PRI roll seen so far (Badli and the five
// fixtures/sec panchayats) prints, as decoded lines:
//   "जिलापरिषद का नाम : जयपुरजि॰ प॰ सदस्य निर्वाचन क्षेत्र : 34"
//   "पंचायत समिति का नाम : चाकसू"
//   "जिला"  ":"  "जयपुर"            (three runs on one row)
// The तहसील row is not the samiti (Girwa's tahsil is बारापाल).

import { readCoverLines } from './decodeRoll.js';

// A name is Devanagari letters and marks, spaces, hyphens and the
// abbreviation sign; anything else (a replacement character, digits, a
// colon) means the read failed.
const NAME = /^[ऀ-ॿ॰]+(?:[ -][ऀ-ॿ॰]+)*$/u;
const SAMITI_LABEL = /^पंचायत\s*समिति\s*का\s*नाम\s*:\s*(.+)$/u;
const ZP_LABEL = /^जिलापरिषद\s*का\s*नाम\s*:\s*(.+?)\s*जि॰\s*प॰/u;
const DISTRICT_LABEL = /^जिला\s*:?$/u;

const clean = (v) => {
  if (typeof v !== 'string') return null;
  const t = v.replace(/\s+/gu, ' ').trim().normalize('NFC');
  return NAME.test(t) ? t : null;
};

/**
 * The district and samiti names on a roll's cover, from its decoded lines.
 * @param {{x: number, y: number, text: string}[]} lines readCoverLines output
 * @returns {{district: string|null, samiti: string|null}} null where unreadable
 */
export function coverNames(lines) {
  let samiti = null;
  let zp = null;
  let district = null;
  for (const ln of lines) {
    const s = SAMITI_LABEL.exec(ln.text);
    if (s && samiti === null) samiti = clean(s[1]);
    const z = ZP_LABEL.exec(ln.text);
    if (z && zp === null) zp = clean(z[1]);
    if (DISTRICT_LABEL.test(ln.text) && district === null) {
      const row = lines
        .filter((o) => o !== ln && Math.abs(o.y - ln.y) < 2.0 && o.x > ln.x)
        .sort((a, b) => a.x - b.x)
        .map((o) => o.text.replace(/^:\s*/u, ''))
        .filter((t) => t !== '');
      if (row.length) district = clean(row.join(' '));
    }
  }
  return { district: district ?? zp, samiti };
}

/**
 * Read the district and samiti names from a roll PDF's cover page.
 * @param {Uint8Array|ArrayBuffer} pdfBytes the roll PDF
 * @param {{table?: {glyphs: Record<string, object>}}} [options] master glyph table
 * @returns {{district: string|null, samiti: string|null}}
 */
export function readRollCover(pdfBytes, { table } = {}) {
  return coverNames(readCoverLines(pdfBytes, { table }));
}
