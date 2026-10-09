// The SEC disclaimer footer: three static lines below every screen giving the
// roll's data source, saying this is not an official State Election
// Commission app, and saying the printed roll prevails.
//
// The copy is fixed here (not fetched), so the footer renders offline and
// before the string table loads. It stores nothing and carries no party name,
// symbol or candidate branding. test/secFooter.test.js pins the exact text.

import { el } from './dom.js';

export const SEC_FOOTER_SOURCE = 'स्रोत: राज्य निर्वाचन आयोग, राजस्थान की प्रकाशित मतदाता सूची';
export const SEC_FOOTER_NOT_OFFICIAL = 'यह राज्य निर्वाचन आयोग का आधिकारिक ऐप नहीं है';
export const SEC_FOOTER_PRINTED_PREVAILS = 'मुद्रित मतदाता सूची ही मान्य है';

/** The footer's lines, in the order they show. */
export const SEC_FOOTER_LINES = Object.freeze([
  SEC_FOOTER_SOURCE,
  SEC_FOOTER_NOT_OFFICIAL,
  SEC_FOOTER_PRINTED_PREVAILS,
]);

/**
 * Render the footer's three lines into root. Safe to call again: the lines
 * are replaced, never duplicated.
 * @param {Element|null} root
 */
export function renderSecFooter(root) {
  if (!root) return null;
  const doc = root.ownerDocument || document;
  const lines = SEC_FOOTER_LINES.map((line) => el(doc, 'p', 'sec-footer-text', line));
  root.replaceChildren(...lines);
  return lines;
}
