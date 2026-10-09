// Shared DOM helper for the roll screens.

/** Create an element with an optional class attribute and text content. */
export function el(doc, tag, className, text) {
  const node = doc.createElement(tag);
  if (className) node.setAttribute('class', className);
  if (text != null) node.textContent = String(text);
  return node;
}

/**
 * A lookup into a string table that falls back to a module's own copies of
 * its strings (used when the table failed to load).
 * @param {Record<string,string>|null} strings
 * @param {Record<string,string>} fallback
 * @returns {(key: string) => string}
 */
export function textFrom(strings, fallback) {
  return (key) => (strings && Object.prototype.hasOwnProperty.call(strings, key) && strings[key])
    || (fallback && fallback[key]) || '';
}

/**
 * Show a one-line notice (DESIGN.md "Notice"): the text plus its tone, which
 * styles.css colours. Empty text hides the notice.
 * @param {Element} node
 * @param {string} text
 * @param {'info'|'success'|'error'} [tone]
 */
export function setNotice(node, text, tone = 'info') {
  node.textContent = text || '';
  if (text) node.setAttribute('data-tone', tone);
  else node.removeAttribute('data-tone');
}

/**
 * The shared panel header (DESIGN.md "Panel"): a title, an optional muted
 * subtitle and a quiet close button on the right.
 * @returns {{header: Element, title: Element, closeButton: Element}}
 */
export function panelHeader(doc, { title, titleClass, subtitle, closeText, closeClass }) {
  const header = el(doc, 'div', 'panel-header');
  const heading = el(doc, 'div', 'panel-heading');
  const titleNode = el(doc, 'h2', `panel-title ${titleClass || ''}`.trim(), title);
  heading.appendChild(titleNode);
  if (subtitle) heading.appendChild(el(doc, 'p', 'panel-subtitle', subtitle));
  const closeButton = el(doc, 'button', `btn-quiet ${closeClass || ''}`.trim(), closeText);
  closeButton.setAttribute('type', 'button');
  header.appendChild(heading);
  header.appendChild(closeButton);
  return { header, title: titleNode, closeButton };
}

/** The muted details line under a voter's name: relative · age · house. */
export function voterMeta(entry, text) {
  const meta = [];
  if (entry.relative) meta.push(entry.relative);
  if (entry.age != null) meta.push(`${text('roll_age')} ${entry.age}`);
  if (entry.house) meta.push(`${text('roll_house')} ${entry.house}`);
  return meta.join(' · ');
}
