// Virtualised voter list for a decoded ward roll.
//
// Rows have one fixed height: a spacer as tall as the list holds only the
// rows in view (plus OVERSCAN), recycled on the next animation frame. Text
// is set with textContent only.
// A struck-off entry stays listed, its "serial. name" in a <del>; one a
// supplementary roll struck off (supplement: 'deletion') says so.

import { el } from './dom.js';

export const ROW_HEIGHT = 100; // px; styles.css .roll-row content fits in this
export const OVERSCAN = 6;
const DEFAULT_VIEWPORT_HEIGHT = 600;

/** Index range [start, end) of the rows to render for a scroll position. */
export function visibleRange(scrollTop, viewportHeight, count, rowHeight = ROW_HEIGHT, overscan = OVERSCAN) {
  const top = Math.max(0, Number(scrollTop) || 0);
  const height = Math.max(0, Number(viewportHeight) || 0);
  const first = Math.floor(top / rowHeight);
  const last = Math.ceil((top + height) / rowHeight);
  return {
    start: Math.min(count, Math.max(0, first - overscan)),
    end: Math.min(count, last + overscan),
  };
}

function defaultFrame(fn) {
  if (typeof globalThis.requestAnimationFrame === 'function') return globalThis.requestAnimationFrame(fn);
  return setTimeout(fn, 0);
}

/**
 * Mount the list into container (replacing its content).
 * @param {object[]} entries {serial, name, relative, age, gender, house, struck, supplement?}
 * @param {Record<string,string>} strings the Hindi string table
 * @param {{viewportHeight?: number, requestFrame?: Function, onSelect?: (entry: object) => void}} [opts]
 *   onSelect is called with the entry of a tapped row (Enter or Space on a
 *   focused row too); viewportHeight and requestFrame are test hooks
 * @returns {{root, viewport, rendered: () => number[], render: () => void, destroy: () => void}}
 */
export function mountRollList(container, entries, strings, opts = {}) {
  const doc = container.ownerDocument;
  const text = (key) => (strings && Object.prototype.hasOwnProperty.call(strings, key) ? strings[key] : '');
  const requestFrame = opts.requestFrame || defaultFrame;
  const count = entries.length;

  const root = el(doc, 'div', 'roll');
  root.setAttribute('lang', 'hi');
  const struck = entries.filter((e) => e && e.struck === true).length;
  const counted = `${text('roll_count')}: ${count - struck}`;
  root.appendChild(el(doc, 'p', 'roll-count', struck ? `${counted} · ${text('roll_struck_count')}: ${struck}` : counted));

  if (count === 0) {
    const empty = el(doc, 'p', 'roll-message', text('roll_empty'));
    empty.setAttribute('role', 'status');
    root.appendChild(empty);
  }

  const viewport = el(doc, 'div', 'roll-viewport');
  viewport.setAttribute('role', 'list');
  viewport.setAttribute('aria-label', text('roll_list_label'));
  viewport.setAttribute('tabindex', '0');
  const spacer = el(doc, 'div', 'roll-spacer');
  spacer.setAttribute('style', `height: ${count * ROW_HEIGHT}px`);
  viewport.appendChild(spacer);
  root.appendChild(viewport);
  container.replaceChildren(root);

  const live = new Map(); // entry index -> row node
  const pool = [];
  const shownIndex = new Map(); // row node -> entry index it shows
  const onSelect = typeof opts.onSelect === 'function' ? opts.onSelect : null;

  function fillRow(row, entry, index) {
    row.setAttribute('style', `height: ${ROW_HEIGHT}px; transform: translateY(${index * ROW_HEIGHT}px)`);
    row.setAttribute('aria-posinset', String(index + 1));
    shownIndex.set(row, index);
    const [name, relative, meta] = row.childNodes;
    const label = `${entry.serial}. ${entry.name}`;
    const parts = [];
    if (entry.struck === true) {
      name.replaceChildren(el(doc, 'del', 'roll-struck', label));
      parts.push(text(entry.supplement === 'deletion' ? 'supp_deleted' : 'roll_struck_off'));
    } else name.textContent = label;
    relative.textContent = entry.relative;
    if (entry.age != null) parts.push(`${text('roll_age')} ${entry.age}`);
    if (entry.gender) parts.push(entry.gender);
    if (entry.house) parts.push(`${text('roll_house')} ${entry.house}`);
    meta.textContent = parts.join(' · ');
  }

  function newRow() {
    const row = el(doc, 'div', 'list-row roll-row');
    row.setAttribute('role', 'listitem');
    row.setAttribute('aria-setsize', String(count));
    row.appendChild(el(doc, 'span', 'roll-name'));
    row.appendChild(el(doc, 'span', 'roll-relative'));
    row.appendChild(el(doc, 'span', 'roll-meta'));
    if (onSelect) {
      row.setAttribute('tabindex', '0');
      const select = () => onSelect(entries[shownIndex.get(row)]);
      row.addEventListener('click', select);
      row.addEventListener('keydown', (event) => {
        if (event.key !== 'Enter' && event.key !== ' ') return;
        if (typeof event.preventDefault === 'function') event.preventDefault();
        select();
      });
    }
    return row;
  }

  function render() {
    const height = viewport.clientHeight || opts.viewportHeight || DEFAULT_VIEWPORT_HEIGHT;
    const { start, end } = visibleRange(viewport.scrollTop, height, count);
    for (const [index, row] of live) {
      if (index < start || index >= end) {
        live.delete(index);
        spacer.removeChild(row);
        pool.push(row);
      }
    }
    for (let i = start; i < end; i += 1) {
      if (live.has(i)) continue;
      const row = pool.pop() || newRow();
      fillRow(row, entries[i], i);
      spacer.appendChild(row);
      live.set(i, row);
    }
  }

  let scheduled = false;
  viewport.addEventListener('scroll', () => {
    if (scheduled) return;
    scheduled = true;
    requestFrame(() => {
      scheduled = false;
      render();
    });
  });

  render();
  // The real height is known only after layout; re-render once it is, and
  // again whenever the viewport resizes (rotation, keyboard).
  requestFrame(render);
  const win = doc.defaultView;
  const onResize = () => requestFrame(render);
  if (win && typeof win.addEventListener === 'function') win.addEventListener('resize', onResize);

  return {
    root,
    viewport,
    rendered: () => [...live.keys()].sort((a, b) => a - b),
    render,
    destroy() {
      if (win && typeof win.removeEventListener === 'function') win.removeEventListener('resize', onResize);
    },
  };
}
