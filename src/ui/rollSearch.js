// A ward roll with its name search box on top.
//
// The search screen (src/ui/searchScreen.js) sits above the virtualised list
// (src/ui/rollList.js). While the box holds a query the results replace the
// full list; clearing it brings the list back. Everything stays in memory, so
// it works offline.

import { el } from './dom.js';
import { mountRollList } from './rollList.js';
import { mountSearchScreen } from './searchScreen.js';

/** Map a stored roll entry to the voter shape the search screen shows. */
export function toVoter(entry) {
  return {
    id: entry.serial,
    serial: entry.serial,
    name: entry.name,
    relativeName: entry.relative,
    houseNo: entry.house,
  };
}

/**
 * Same signature as mountRollList, which it wraps.
 * @returns {{root, search, list, destroy: () => void}}
 */
export function mountRollWithSearch(container, entries, strings, opts = {}) {
  const doc = container.ownerDocument;
  const root = el(doc, 'div', 'roll-with-search');
  const searchHost = el(doc, 'div', 'roll-search');
  const listHost = el(doc, 'div', 'roll-full');
  root.appendChild(searchHost);
  root.appendChild(listHost);
  container.replaceChildren(root);

  let list = null;
  const search = mountSearchScreen(searchHost, entries.map(toVoter), {
    onRender() {
      // Re-read the box: onRender fires after every debounced render.
      const querying = (search.input.value || '').trim() !== '';
      if (querying) {
        listHost.setAttribute('hidden', '');
      } else if (listHost.hasAttribute('hidden')) {
        listHost.removeAttribute('hidden');
        // While hidden the viewport had no height, so lay the rows out again
        // now that it has one.
        if (list) list.render();
      }
    },
  });
  list = mountRollList(listHost, entries, strings, opts);

  return {
    root,
    search,
    list,
    destroy() {
      search.destroy();
      list.destroy();
    },
  };
}
