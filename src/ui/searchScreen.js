// Offline Hindi voter search screen, rendered with plain DOM calls.
//
// The search index is built once on mount and kept in this closure only:
// nothing here performs network I/O or writes to any browser storage, so the
// screen works in airplane mode and leaves no voter data behind.

import { buildIndex, search } from '../search/hindiSearch.js';

export const DEBOUNCE_MS = 100;
export const RESULT_LIMIT = 50;
export const PLACEHOLDER = 'नाम खोजें';
export const NO_RESULTS_MESSAGE = 'कोई मतदाता नहीं मिला';

const STYLE = `
.pwc-search { font-family: 'Noto Sans Devanagari', 'Mangal', 'Kohinoor Devanagari', sans-serif; max-width: 40rem; margin: 0 auto; padding: 0.75rem; }
.pwc-search__input { box-sizing: border-box; width: 100%; font-size: 1.375rem; padding: 0.75rem 1rem; border: 1px solid #c7ccd4; border-radius: 0.75rem; outline: none; }
.pwc-search__input:focus { border-color: #2f6fde; box-shadow: 0 0 0 3px rgba(47, 111, 222, 0.2); }
.pwc-search__list { list-style: none; margin: 0.75rem 0 0; padding: 0; }
.pwc-search__row { padding: 0.75rem 0.25rem; border-bottom: 1px solid #e3e6eb; line-height: 1.5; }
.pwc-search__name { display: block; font-size: 1.25rem; font-weight: 600; color: #1d2330; }
.pwc-search__meta { display: flex; flex-wrap: wrap; gap: 0.25rem 1rem; font-size: 1rem; color: #4a5263; }
.pwc-search__empty { margin: 1rem 0.25rem; font-size: 1.125rem; color: #6b7280; }
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
 * for instrumentation). Returns { input, list, message, destroy }.
 */
export function mountSearchScreen(container, voters, options = {}) {
  const doc = container.ownerDocument || globalThis.document;
  const onRender = typeof options.onRender === 'function' ? options.onRender : null;
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

  const list = el(doc, 'ul', 'pwc-search__list');
  list.setAttribute('lang', 'hi');
  root.appendChild(list);

  const message = el(doc, 'p', 'pwc-search__empty', NO_RESULTS_MESSAGE);
  message.setAttribute('role', 'status');
  message.setAttribute('hidden', '');
  root.appendChild(message);

  container.appendChild(root);

  function render() {
    const query = input.value || '';
    const results = query.trim() ? search(index, query, { limit: RESULT_LIMIT }) : [];
    const fragment = doc.createDocumentFragment();
    for (const voter of results) fragment.appendChild(renderRow(doc, voter));
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
    destroy() {
      if (timer !== null) clearTimeout(timer);
      timer = null;
      input.removeEventListener('input', onInput);
      if (root.parentNode === container) container.removeChild(root);
    },
  };
}
