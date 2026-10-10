// A ward roll (src/ui/rollList.js) with its name search box
// (src/ui/searchScreen.js) on top; a query's results replace the list.
//
// With opts.contacts and opts.wardKey, a voter tap opens the contact panel
// above the box, and a call-list button opens the ward's call list there.
// opts.marks adds the "seen voting" control and a turnout button (its count is
// the mark store's de-duplicated wardCount, re-read as marks arrive). Every
// count read here skips marks on serials struck off this roll, however old the
// mark or whichever phone made it. opts.sms
// adds an SMS tally button whose view is imported on first open, as nothing
// under src/decoder loads at startup. One view at a time; opts.onHostChange
// (view) hears 'contact', 'calls', 'turnout', 'sms' or null, for the nav bar.

import * as defaultAssignments from '../calls/assignmentStore.js';
import * as defaultRoster from '../calls/workerRoster.js';
import { mountCallListFlow } from './callListFlow.js';
import { mountContactPanel } from './contactPanel.js';
import { el } from './dom.js';
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

// The mark store with its counts skipping marks skip(wardId, serial) is true for.
function countingLiveSerials(store, skip) {
  const view = { ...store };
  if (typeof store.teamCount === 'function') view.teamCount = () => store.teamCount({ skip });
  if (typeof store.wardCount === 'function') view.wardCount = (wardId) => store.wardCount(wardId, { skip });
  return view;
}

/**
 * Same signature as mountRollList, which it wraps; opts may also carry
 * contacts, wardKey, assignments, roster, marks, workerId, turnout and sms (see above).
 * @returns {{root, search, list, contactHost, callListButton, turnoutButton, smsTallyButton,
 *   openContact: (entry) => object | null,
 *   openCallList: () => object | null, openTurnout: () => object | null,
 *   openSmsTally: () => Promise<object | null>, destroy: () => void}}
 *   openSmsTally resolves to null when another view opened there first
 *   openContact returns the panel, with seenVoting
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
  const canTally = canCapture && Boolean(opts.marks);
  // Serials struck off this roll as text, so 5 and '5' are one voter; the
  // counts below leave out marks stored against them.
  const struckSerials = new Set(entries.filter((e) => e.struck === true).map((e) => String(e.serial)));
  const skip = (wardId, serial) => wardId === wardKey && struckSerials.has(String(serial));
  const marks = canTally ? countingLiveSerials(opts.marks, skip) : null;
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
  const hostChanged = (view) => {
    if (typeof opts.onHostChange === 'function') opts.onHostChange(view);
  };
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
    hostChanged('contact');
    if (typeof panel.root.scrollIntoView === 'function') panel.root.scrollIntoView();
    return panel;
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
    hostChanged('turnout');
    if (typeof screen.root.scrollIntoView === 'function') screen.root.scrollIntoView();
    return screen;
  }
  // Live roll serials as text, so 5 and '5' are one voter.
  const rollSerials = new Set(entries.filter((e) => e.struck !== true).map((e) => String(e.serial)));
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
    hostChanged('sms');
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
      onClose: () => hostChanged(null),
    });
    hostChanged('calls');
    if (typeof screen.root.scrollIntoView === 'function') screen.root.scrollIntoView();
    return screen;
  }
  const bySerial = new Map(entries.map((entry) => [entry.serial, entry]));

  let list = null;
  const search = mountSearchScreen(searchHost, entries.map(toVoter), {
    onSelect: canCapture ? (voter) => openContact(bySerial.get(voter.serial)) : undefined,
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
