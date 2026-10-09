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
//
// With opts.marks (src/tally/seenVotingStore.js) as well, the contact panel
// and the voter card carry the voter's "seen voting" control
// (src/ui/seenVotingMark.js, with opts.workerId), and a turnout button on top
// opens the polling-day screen (src/ui/turnoutScreen.js) in the same place.
// opts.turnout defaults to the device's turnout store
// (src/tally/turnoutStore.js). Its supporter count is the mark store's
// wardCount for this ward, so a voter marked on several phones counts once,
// and it is read again whenever marks are added, including teammates' marks
// arriving with a pull. Whatever is open in the contact host is replaced when
// another view opens there, and its mark subscriptions end with it.
//
// With opts.sms ({settings, teamNumber?, inbox?, location?}) as well, an SMS tally button
// on top opens src/ui/smsTallyView.js in the same place: the worker's marks
// in this ward go out by SMS, and a pasted tally SMS becomes marks of this
// ward in opts.marks, for the serials that are in this ward's roll. That view
// is imported when first opened, as its SMS checksum comes from
// src/decoder/sha256.js and nothing under src/decoder loads at startup.

import * as defaultAssignments from '../calls/assignmentStore.js';
import * as defaultRoster from '../calls/workerRoster.js';
import { mountCallListFlow } from './callListFlow.js';
import { mountContactPanel } from './contactPanel.js';
import { el } from './dom.js';
import { mountVoterCard } from './voterCard.js';
import { mountRollList } from './rollList.js';
import { mountSearchScreen } from './searchScreen.js';
import { mountSeenVotingMark } from './seenVotingMark.js';
import { renderTurnoutScreen } from './turnoutScreen.js';

/** Map a stored roll entry to the voter shape the search screen shows. */
export function toVoter(entry) {
  return {
    id: entry.serial,
    serial: entry.serial,
    name: entry.name,
    relativeName: entry.relative,
    houseNo: entry.house,
    struck: entry.struck === true,
  };
}

/**
 * Same signature as mountRollList, which it wraps; opts may also carry
 * contacts, wardKey, assignments, roster, marks, workerId, turnout and sms (see above).
 * @returns {{root, search, list, contactHost, callListButton, turnoutButton, smsTallyButton,
 *   openContact: (entry) => object | null, openVoterCard: (entry) => object | null,
 *   openCallList: () => object | null, openTurnout: () => object | null,
 *   openSmsTally: () => Promise<object | null>, destroy: () => void}}
 *   openSmsTally resolves to null when another view opened there first
 *   openContact and openVoterCard return the panel or card, with seenVoting
 *   set to its seen-voting control when opts.marks is given
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
  const { marks } = opts;
  const canTally = canCapture && Boolean(marks);
  let turnoutButton = null;
  if (canTally) {
    turnoutButton = el(doc, 'button', 'btn-secondary turnout-open', strings && strings.turnout_open);
    turnoutButton.setAttribute('type', 'button');
    turnoutButton.addEventListener('click', () => { openTurnout(); });
    root.appendChild(turnoutButton);
  }
  const canSms = canTally && Boolean(opts.sms && typeof opts.sms.settings === 'function');
  let smsTallyButton = null;
  if (canSms) {
    smsTallyButton = el(doc, 'button', 'btn-secondary sms-tally-open', strings && strings.sms_tally_open);
    smsTallyButton.setAttribute('type', 'button');
    smsTallyButton.addEventListener('click', () => { openSmsTally(); });
    root.appendChild(smsTallyButton);
  }
  root.appendChild(contactHost);
  root.appendChild(searchHost);
  root.appendChild(listHost);
  container.replaceChildren(root);

  // Ends the mark subscriptions of whatever the contact host shows; each
  // opener's mount then replaces the host's content.
  let endHostView = null;
  // Counts leaveHost() calls, so a view that loads late can tell that
  // another one opened (or the roll view went away) meanwhile.
  let hostTurn = 0;
  function leaveHost() {
    hostTurn += 1;
    if (endHostView) endHostView();
    endHostView = null;
  }
  function addSeenVoting(view, entry) {
    if (canTally) {
      view.seenVoting = mountSeenVotingMark(contactHost, strings, {
        marks, wardId: wardKey, entry, workerId: opts.workerId,
      });
      endHostView = view.seenVoting.destroy;
    }
    return view;
  }
  function openContact(entry) {
    if (!canCapture || !entry) return null;
    leaveHost();
    const panel = addSeenVoting(mountContactPanel(contactHost, strings, { contacts, wardId: wardKey, entry }), entry);
    if (typeof panel.root.scrollIntoView === 'function') panel.root.scrollIntoView();
    return panel;
  }
  function openVoterCard(entry) {
    if (!canCapture || !entry) return null;
    leaveHost();
    const card = addSeenVoting(mountVoterCard(contactHost, strings, { contacts, wardId: wardKey, entry }), entry);
    if (typeof card.root.scrollIntoView === 'function') card.root.scrollIntoView();
    return card;
  }
  function openTurnout() {
    if (!canTally) return null;
    leaveHost();
    const screen = renderTurnoutScreen(contactHost, {
      ward: wardKey,
      strings,
      store: opts.turnout,
      getSupporterCount: () => marks.wardCount(wardKey),
    });
    if (typeof marks.onMarksChanged === 'function') {
      endHostView = marks.onMarksChanged(() => { screen.refreshCount(); });
    }
    if (typeof screen.root.scrollIntoView === 'function') screen.root.scrollIntoView();
    return screen;
  }
  // Roll serials as text, so 5 and '5' are one voter.
  const rollSerials = new Set(entries.map((entry) => String(entry.serial)));
  async function openSmsTally() {
    if (!canSms) return null;
    leaveHost();
    const turn = hostTurn;
    let mountSmsTally;
    try {
      ({ mountSmsTally } = await import('./smsTallyView.js'));
    } catch (err) {
      console.error('SMS tally view could not be loaded', err);
      return null;
    }
    if (turn !== hostTurn) return null;
    const view = mountSmsTally(contactHost, strings, {
      marks,
      wardId: wardKey,
      workerId: opts.workerId,
      settings: opts.sms.settings,
      teamNumber: opts.sms.teamNumber,
      inbox: opts.sms.inbox,
      location: opts.sms.location,
      inRoll: (serial) => rollSerials.has(String(serial)),
    });
    endHostView = view.destroy;
    if (typeof view.root.scrollIntoView === 'function') view.root.scrollIntoView();
    return view;
  }
  function openCallList() {
    if (!canCapture) return null;
    leaveHost();
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
    struckLabel: strings && typeof strings.roll_struck === 'string' ? strings.roll_struck : '',
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
    turnoutButton,
    smsTallyButton,
    openContact,
    openVoterCard,
    openCallList,
    openTurnout,
    openSmsTally,
    destroy() {
      leaveHost();
      search.destroy();
      list.destroy();
    },
  };
}
