// Offline Hindi voter search screen, rendered with plain DOM calls.
//
// The search index is built once on mount and kept in this closure only:
// nothing here performs network I/O or writes to any browser storage, so the
// screen works in airplane mode and leaves no voter data behind.
//
// Selecting a result (tap, or Enter/Space on a focused row) opens that voter's
// card in a slot above the results through options.openCard, which the caller
// injects (src/ui/rollSearch.js passes src/ui/voterCard.js), so this module
// stays free of any storage code.

import { buildIndex, search } from '../search/hindiSearch.js';

export const DEBOUNCE_MS = 100;
export const RESULT_LIMIT = 50;
export const PLACEHOLDER = 'नाम खोजें';
export const NO_RESULTS_MESSAGE = 'कोई मतदाता नहीं मिला';

const STYLE = `
.pwc-search { font-family: var(--font-family-base, 'Noto Sans Devanagari', 'Mangal', sans-serif); max-width: 40rem; margin: 0 auto 0.75rem; }
.pwc-search__input { box-sizing: border-box; width: 100%; min-height: 3rem; font: inherit; font-size: 1.25rem; padding: 0.75rem 1rem; color: var(--color-text, #1f2933); background: var(--color-surface, #fff); border: 1px solid var(--color-border, #e1ddd3); border-radius: var(--radius-md, 0.75rem); box-shadow: var(--shadow-card, none); outline: none; }
.pwc-search__input:focus { border-color: var(--color-primary, #0f766e); box-shadow: 0 0 0 3px rgba(15, 118, 110, 0.25); }
.pwc-search__list { list-style: none; margin: 0.5rem 0 0; padding: 0; }
.pwc-search__row { padding: 0.75rem 0.25rem; border-bottom: 1px solid var(--color-border, #e1ddd3); line-height: 1.5; min-height: var(--touch-target, 48px); }
.pwc-search__row[role="button"] { cursor: pointer; }
.pwc-search__row[role="button"]:focus-visible { outline: 3px solid var(--color-focus, #f59e0b); outline-offset: -3px; }
.pwc-search__card:empty { display: none; }
.pwc-search__name { display: block; font-size: 1.25rem; font-weight: 600; color: var(--color-text, #1f2933); }
.pwc-search__meta { display: flex; flex-wrap: wrap; gap: 0.25rem 1rem; font-size: 1rem; color: var(--color-text-muted, #52606d); }
.pwc-search__serial { font-weight: 600; color: var(--color-primary-strong, #115e59); }
.pwc-search__empty { margin: 1rem 0.25rem; font-size: 1.125rem; color: var(--color-text-muted, #52606d); }
`;

function el(doc, tag, className, text) {
  const node = doc.createElement(tag);
  if (className) node.setAttribute('class', className);
  if (text != null) node.textContent = String(text);
  return node;
}

function renderRow(doc, voter) {
  const row = el(doc, 'li', 'pwc-search__row');
  row.appendChild(el(doc, 'span', 'pwc-search__name', voter.name));
  const meta = el(doc, 'span', 'pwc-search__meta');
  meta.appendChild(el(doc, 'span', 'pwc-search__relative', voter.relativeName ?? ''));
  meta.appendChild(el(doc, 'span', 'pwc-search__serial', `क्रम सं. ${voter.serial ?? ''}`));
  meta.appendChild(el(doc, 'span', 'pwc-search__house', `मकान नं. ${voter.houseNo ?? ''}`));
  row.appendChild(meta);
  return row;
}

/**
 * Mount the search screen into container over the given voters
 * ({ id, serial, name, relativeName, houseNo }).
 *
 * options.onRender(results) is called after each render (used by tests and
 * for instrumentation). options.openCard(host, voter) is called when a result
 * is selected; it mounts the voter card into host and may return an object
 * with destroy(), called when another voter is selected, on closeCard() and
 * on destroy(). Without it the rows are plain text.
 * Returns { input, list, message, cardHost, closeCard, destroy }.
 */
export function mountSearchScreen(container, voters, options = {}) {
  const doc = container.ownerDocument || globalThis.document;
  const onRender = typeof options.onRender === 'function' ? options.onRender : null;
  const openCard = typeof options.openCard === 'function' ? options.openCard : null;
  const index = buildIndex(voters);

  const root = el(doc, 'section', 'pwc-search');
  root.appendChild(el(doc, 'style', null, STYLE));

  const input = el(doc, 'input', 'pwc-search__input');
  input.setAttribute('type', 'search');
  input.setAttribute('placeholder', PLACEHOLDER);
  input.setAttribute('lang', 'hi');
  input.setAttribute('inputmode', 'text');
  input.setAttribute('autocomplete', 'off');
  input.setAttribute('spellcheck', 'false');
  input.setAttribute('aria-label', PLACEHOLDER);
  root.appendChild(input);

  const cardHost = el(doc, 'div', 'pwc-search__card');
  root.appendChild(cardHost);

  const list = el(doc, 'ul', 'pwc-search__list');
  list.setAttribute('lang', 'hi');
  root.appendChild(list);

  const message = el(doc, 'p', 'pwc-search__empty', NO_RESULTS_MESSAGE);
  message.setAttribute('role', 'status');
  message.setAttribute('hidden', '');
  root.appendChild(message);

  container.appendChild(root);

  let card = null;
  function closeCard() {
    if (card && typeof card.destroy === 'function') card.destroy();
    card = null;
    cardHost.replaceChildren();
  }

  function select(voter) {
    closeCard();
    card = openCard(cardHost, voter) || null;
    if (typeof cardHost.scrollIntoView === 'function') cardHost.scrollIntoView({ block: 'nearest' });
  }

  function selectable(row, voter) {
    row.setAttribute('role', 'button');
    row.setAttribute('tabindex', '0');
    row.addEventListener('click', () => select(voter));
    row.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      if (typeof event.preventDefault === 'function') event.preventDefault();
      select(voter);
    });
    return row;
  }

  function render() {
    const query = input.value || '';
    const results = query.trim() ? search(index, query, { limit: RESULT_LIMIT }) : [];
    const fragment = doc.createDocumentFragment();
    for (const voter of results) {
      const row = renderRow(doc, voter);
      fragment.appendChild(openCard ? selectable(row, voter) : row);
    }
    list.replaceChildren(fragment);
    if (query.trim() && results.length === 0) message.removeAttribute('hidden');
    else message.setAttribute('hidden', '');
    if (onRender) onRender(results);
  }

  let timer = null;
  function onInput() {
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      render();
    }, DEBOUNCE_MS);
  }
  input.addEventListener('input', onInput);

  return {
    input,
    list,
    message,
    cardHost,
    closeCard,
    destroy() {
      if (timer !== null) clearTimeout(timer);
      timer = null;
      closeCard();
      input.removeEventListener('input', onInput);
      if (root.parentNode === container) container.removeChild(root);
    },
  };
}
