// A ward roll with its name search box on top.
//
// The search screen (src/ui/searchScreen.js) sits above the virtualised list
// (src/ui/rollList.js). While the box holds a query the results replace the
// full list; clearing it brings the list back. Everything stays in memory, so
// it works offline.
//
// With opts.contacts (src/contacts/contactSync.js) and opts.wardKey, tapping
// a voter in the list or in the search results opens the consent and phone
// panel (src/ui/contactPanel.js) for that voter above the search box.
// Selecting a search result opens the voter card (src/ui/voterCard.js) instead.
// The same opts add a call-list button on top: it opens the ward's call list
// (src/ui/callListFlow.js) in that place, with opts.assignments and
// opts.roster defaulting to the device's assignment store and worker roster.

import * as defaultAssignments from '../calls/assignmentStore.js';
import * as defaultRoster from '../calls/workerRoster.js';
import { mountCallListFlow } from './callListFlow.js';
import { mountContactPanel } from './contactPanel.js';
import { el } from './dom.js';
import { mountVoterCard } from './voterCard.js';
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
 * Same signature as mountRollList, which it wraps; opts may also carry
 * contacts, wardKey, assignments and roster (see above).
 * @returns {{root, search, list, contactHost, callListButton, openContact: (entry) => object | null,
 *   openVoterCard: (entry) => object | null, openCallList: () => object | null, destroy: () => void}}
 */
export function mountRollWithSearch(container, entries, strings, opts = {}) {
  const doc = container.ownerDocument;
  const root = el(doc, 'div', 'roll-with-search');
  const contactHost = el(doc, 'div', 'roll-contact');
  const searchHost = el(doc, 'div', 'roll-search');
  const listHost = el(doc, 'div', 'roll-full');

  const { contacts, wardKey } = opts;
  const canCapture = Boolean(contacts && typeof wardKey === 'string' && wardKey);
  let callListButton = null;
  if (canCapture) {
    callListButton = el(doc, 'button', 'btn-primary call-list-open', strings && strings.call_list_open);
    callListButton.setAttribute('type', 'button');
    callListButton.addEventListener('click', () => { openCallList(); });
    root.appendChild(callListButton);
  }
  root.appendChild(contactHost);
  root.appendChild(searchHost);
  root.appendChild(listHost);
  container.replaceChildren(root);

  function openContact(entry) {
    if (!canCapture || !entry) return null;
    const panel = mountContactPanel(contactHost, strings, { contacts, wardId: wardKey, entry });
    if (typeof panel.root.scrollIntoView === 'function') panel.root.scrollIntoView();
    return panel;
  }
  function openVoterCard(entry) {
    if (!canCapture || !entry) return null;
    const card = mountVoterCard(contactHost, strings, { contacts, wardId: wardKey, entry });
    if (typeof card.root.scrollIntoView === 'function') card.root.scrollIntoView();
    return card;
  }
  function openCallList() {
    if (!canCapture) return null;
    const screen = mountCallListFlow(contactHost, strings, {
      contacts,
      wardId: wardKey,
      entries,
      assignments: opts.assignments || defaultAssignments,
      roster: opts.roster || defaultRoster,
    });
    if (typeof screen.root.scrollIntoView === 'function') screen.root.scrollIntoView();
    return screen;
  }
  const bySerial = new Map(entries.map((entry) => [entry.serial, entry]));

  let list = null;
  const search = mountSearchScreen(searchHost, entries.map(toVoter), {
    onSelect: canCapture ? (voter) => openVoterCard(bySerial.get(voter.serial)) : undefined,
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
  list = mountRollList(listHost, entries, strings, canCapture ? { ...opts, onSelect: openContact } : opts);

  return {
    root,
    search,
    list,
    contactHost,
    callListButton,
    openContact,
    openVoterCard,
    openCallList,
    destroy() {
      search.destroy();
      list.destroy();
    },
  };
}
