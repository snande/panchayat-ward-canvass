// A ward roll with its name search box on top.
//
// The search screen (src/ui/searchScreen.js) sits above the virtualised list
// (src/ui/rollList.js). While the box holds a query the results replace the
// full list; clearing it brings the list back. Tapping a result opens its
// voter card (src/ui/voterCard.js) at the top. Everything stays on the
// device, so it works offline.

import { el } from './dom.js';
import { mountRollList } from './rollList.js';
import { mountSearchScreen } from './searchScreen.js';
import { mountVoterCard } from './voterCard.js';

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
 * Same signature as mountRollList, which it wraps. opts.wardId is the ward's
 * contact-store id for the voter card; opts.contactStore overrides the
 * default contact store (tests).
 * @returns {{root, search, list, card, openCard: (voter) => void, closeCard: () => void, destroy: () => void}}
 */
export function mountRollWithSearch(container, entries, strings, opts = {}) {
  const doc = container.ownerDocument;
  const root = el(doc, 'div', 'roll-with-search');
  const cardHost = el(doc, 'div', 'roll-card');
  cardHost.setAttribute('hidden', '');
  const searchHost = el(doc, 'div', 'roll-search');
  const listHost = el(doc, 'div', 'roll-full');
  root.appendChild(cardHost);
  root.appendChild(searchHost);
  root.appendChild(listHost);
  container.replaceChildren(root);

  const bySerial = new Map(entries.map((entry) => [entry.serial, entry]));
  let card = null;

  function closeCard() {
    if (card) card.destroy();
    card = null;
    cardHost.setAttribute('hidden', '');
  }

  function openCard(voter) {
    const entry = bySerial.get(voter.serial);
    if (!entry) return;
    closeCard();
    card = mountVoterCard(cardHost, entry, strings, {
      wardId: opts.wardId,
      store: opts.contactStore,
      onClose: closeCard,
    });
    cardHost.removeAttribute('hidden');
    if (typeof cardHost.scrollIntoView === 'function') cardHost.scrollIntoView({ block: 'start' });
  }

  let list = null;
  const search = mountSearchScreen(searchHost, entries.map(toVoter), {
    onSelect: openCard,
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
    get card() {
      return card;
    },
    openCard,
    closeCard,
    destroy() {
      closeCard();
      search.destroy();
      list.destroy();
    },
  };
}
