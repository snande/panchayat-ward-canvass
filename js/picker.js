import { mountWardPicker } from '../src/ui/wardPickerScreen.js';
import { createRollFlow } from '../src/roll/rollFlow.js';
import { selectionForWardKey } from '../src/picker/wardPicker.js';
import {
  createCatalogue, loadLastSelection, saveLastSelection, toRollSelection,
} from '../src/picker/catalogue.js';
import { wardKeyFor } from '../src/roll/rollStore.js';
import { createWardRollScreen } from '../src/ui/wardRollScreen.js';
import { mountAppFrame } from '../src/ui/appFrame.js';
import { createVoterSearchScreen } from '../src/ui/voterSearchScreen.js';
import { voterRouteHash } from '../src/ui/voterRoute.js';
import { loadAssignments } from '../src/calls/assignmentStore.js';
import { getAuth, getDeviceId, joinTeam } from '../src/sync/teamAuth.js';
import { mountTeamJoin } from '../src/ui/teamJoinScreen.js';
import { renderSeatHeader, saveSeat, seatFromPick } from '../src/ui/seatHeader.js';
import { startSync } from '../src/sync/syncEngine.js';
import { createContactSync } from '../src/contacts/contactSync.js';
import * as marks from '../src/tally/seenVotingStore.js';
import {
  getTeamSmsNumber, listenForTeamSmsNumber, onTeamSmsNumberChange, setTeamSmsNumber,
} from '../src/team/teamSmsNumber.js';

// Copies of src/strings.hi.json entries, used if the table itself failed to
// load. repo-ci fails if they drift.
var FALLBACK_STRINGS = {
  picker_load_failed: "वार्ड सूची लोड नहीं हो सकी। कृपया पेज फिर से खोलें।",
  roll_retry: "फिर से कोशिश करें",
};

var container = document.getElementById('ward-picker');
var rollContainer = document.getElementById('roll');
var teamContainer = document.getElementById('team-join');
var seatHeader = document.getElementById('seat-header');
var searchContainer = document.getElementById('voter-search');

// Tapping a voter in the roll records their consent and number on the device,
// encrypted, and queues it for the team; numbers teammates saved arrive with
// every pull (src/contacts/contactSync.js).
var contacts = createContactSync();
contacts.listen();

// Seen-voting marks teammates made arrive with every pull too
// (src/tally/seenVotingStore.js), so the team count covers the whole team.
marks.listenForTeamMarks();

// So does the team's SMS number, set by the coordinator on the SMS entry
// screen (src/team/teamSmsNumber.js).
listenForTeamSmsNumber();

// Who marks a voter as seen voting: this device's id in its team, once it
// has joined one.
function workerId() {
  return getDeviceId()
    .then(function (id) {
      return id || 'device';
    })
    .catch(function () {
      return 'device';
    });
}

// The SMS tally (src/ui/smsTallyView.js) sends to the team's SMS number, a
// team record kept encrypted on the phone and synced (never part of the
// public config/constituency.json), and tags its messages with the joined team.
function smsSettings() {
  return Promise.all([getAuth(), getTeamSmsNumber()]).then(function (read) {
    var auth = read[0];
    return { teamSmsNumber: read[1], candidateId: auth ? auth.candidateId : '' };
  });
}
var teamNumber = { save: setTeamSmsNumber, onChange: onTeamSmsNumberChange };

function loadJson(url) {
  return fetch(url).then(function (r) {
    if (!r.ok) {
      throw new Error('HTTP ' + r.status);
    }
    return r.json();
  });
}

function showFailure(strings) {
  var p = document.createElement('p');
  p.setAttribute('class', 'notice');
  p.setAttribute('data-tone', 'error');
  p.setAttribute('role', 'alert');
  p.textContent = (strings && strings.picker_load_failed) || FALLBACK_STRINGS.picker_load_failed;
  container.replaceChildren(p);
}

// The last pick, kept with its schemaVersion (src/picker/catalogue.js); one
// of an unknown version is discarded there and the picker opens empty.
var lastSelection = loadLastSelection().selection;

// The roll flow's selection for a ward key: the constituency config's entry
// (it may list supplementary rolls), else the last pick's.
function selectionFor(wardKey) {
  var picked = toRollSelection(lastSelection);
  return (config && selectionForWardKey(config, wardKey))
    || (picked && wardKeyFor(picked) === wardKey ? picked : null);
}

// The header names the roll on screen (a failed download keeps the last
// seat), from its pick or else its catalogue shard, and stores the seat.
var config = null;
var seatStrings = null;
var shownWardKey = null;
var catalogue = createCatalogue();

function renderSeat(seat) {
  saveSeat(seat);
  renderSeatHeader(seatHeader, seat, seatStrings || {});
}

function showSeat(wardKey) {
  var picked = toRollSelection(lastSelection);
  var seat = picked && wardKeyFor(picked) === wardKey && seatFromPick(lastSelection);
  if (seat && wardKey === shownWardKey) {
    return renderSeat(seat);
  }
  var ids = wardKey.split('/');
  var byId = function (id) {
    return function (x) { return x.id === id; };
  };
  catalogue.loadIndex()
    .then(function (index) {
      var district = index.districts.find(byId(ids[0]));
      return district ? catalogue.loadShard(district) : null;
    })
    .then(function (shard) {
      var p = shard && shard.panchayats.find(byId(ids[2]));
      if (p && ids[3] && wardKey === shownWardKey) {
        renderSeat({ seatType: 'ward', panchayat: p.name, ward: ids[3] });
      }
    })
    .catch(function (err) { console.error('roll seat lookup failed', err); });
}

function lastSarpanch() {
  return Boolean(lastSelection && lastSelection.seatType === 'sarpanch');
}

// A sarpanch seat (every ward) is named at once; the shown roll is put away.
function showSarpanch(selection) {
  var seat = seatFromPick(selection);
  if (!seat || seat.seatType !== 'sarpanch') {
    return false;
  }
  shownWardKey = null;
  if (roll) {
    roll.clear({ seatType: 'sarpanch' });
  }
  renderSeat(seat);
  return true;
}

// The search screen (src/ui/voterSearchScreen.js) covers every roll shown
// since the app opened (held in memory). Only the nav bar opens it and only
// going elsewhere closes it; a background roll load leaves it alone.
var searchScreen = null;
var searchShown = false;
var loadedRolls = new Map();

function onRollShown(entries, wardKey) {
  shownWardKey = wardKey;
  showSeat(wardKey);
  loadedRolls.set(wardKey, entries);
  if (searchScreen) {
    searchScreen.setRolls(loadedRolls);
  }
}

function startSearch(strings) {
  if (!searchContainer) {
    return;
  }
  searchScreen = createVoterSearchScreen(searchContainer, strings, {
    contacts: contacts,
    assignments: { loadAssignments: loadAssignments },
    // A household member tap opens their voter card (src/ui/voterRoute.js).
    onOpenVoter: function (voter) {
      window.location.hash = voterRouteHash(voter.ward, voter.serial);
    },
  });
}

function showSearch(on) {
  if (!searchContainer) {
    return;
  }
  searchShown = on;
  searchContainer.hidden = !on;
  if (on && searchScreen) {
    if (typeof searchContainer.scrollIntoView === 'function') {
      searchContainer.scrollIntoView();
    }
    var input = searchScreen.input;
    if (!input.disabled && typeof input.focus === 'function') {
      input.focus();
    }
  }
}

// The ward-roll screen (src/ui/wardRollScreen.js); the "not loaded yet" card
// shows only in its empty state.
var rollScreen = null;
// The bottom navigation bar (src/ui/appFrame.js), once mounted.
var frame = null;

// The nav bar marks what is open: a new roll state shows the roll itself, and
// the roll view reports the call list, polling-day count or SMS tally opening
// over it, or closing (src/ui/rollSearch.js onHostChange).
var NAV_FOR_VIEW = { calls: 'calls', turnout: 'turnout', sms: 'sms' };
function markNav(id) {
  if (frame) {
    frame.select(id);
  }
}

// Picking a ward downloads, decodes and stores its roll (src/roll/rollFlow.js);
// at startup the last stored roll is shown again with no network request.
function startRoll(strings) {
  if (!rollContainer) {
    return null;
  }
  var table = Object.assign({}, FALLBACK_STRINGS, strings || {});
  rollScreen = createWardRollScreen(rollContainer, table, {
    emptyCard: document.querySelector('.empty-state'),
    onState: function (state) {
      if (searchScreen) {
        searchScreen.setLoading(state === 'loading');
      }
      if (!searchShown) {
        markNav('roll');
      }
    },
  });
  rollScreen.setState('empty');
  var flow = createRollFlow(rollContainer, table, {
    screen: rollScreen,
    onShow: onRollShown,
    // A restored roll whose supplementary roll failed retries it with the
    // ward's selection from the catalogue.
    selectionFor: selectionFor,
    // marks: tapping a voter offers "seen voting", and the turnout button
    // shows the ward's de-duplicated count beside the official turnout.
    // sms: with no mobile data, marks go out and come in by SMS and join the
    // same de-duplicated count.
    listOptions: {
      contacts: contacts, marks: marks, workerId: workerId, sms: { settings: smsSettings, teamNumber: teamNumber },
      onHostChange: function (view) {
        showSearch(false);
        markNav(NAV_FOR_VIEW[view] || 'roll');
      },
    },
  });
  // No roll for a stored sarpanch pick; with none restored, no seat.
  if (!lastSarpanch()) {
    flow.restore().then(function () {
      if (rollScreen.state === 'empty' && !lastSarpanch()) {
        renderSeatHeader(seatHeader, null, strings || {});
      }
    });
  }
  return flow;
}

// Brings the ward-roll screen into view: the roll (or its loading line or
// error) once there is one, otherwise the ward picker's first step.
function showRollScreen() {
  var target = rollScreen && rollScreen.state !== 'empty' ? rollContainer : container;
  if (target && typeof target.scrollIntoView === 'function') {
    target.scrollIntoView();
  }
  if (!rollScreen || rollScreen.state === 'empty') {
    var first = document.getElementById('picker-seat-type');
    if (first && typeof first.focus === 'function') {
      first.focus();
    }
  }
}

// The bottom navigation bar reaches every screen. The call list, polling-day
// count and SMS tally belong to a loaded ward, so they open over the roll on
// screen; with none, the entry leads to the ward picker and the roll stays
// the current entry.
function navigate(id) {
  if (id === 'search') {
    showSearch(true);
    return true;
  }
  showSearch(false);
  var list = rollScreen && rollScreen.state === 'filled' ? rollScreen.list : null;
  var openers = list ? { calls: list.openCallList, turnout: list.openTurnout, sms: list.openSmsTally } : {};
  if (id !== 'roll' && typeof openers[id] === 'function' && openers[id]()) {
    return true;
  }
  showRollScreen();
  return id === 'roll';
}

function startFrame(strings) {
  var nav = document.getElementById('nav-bar');
  if (nav) {
    frame = mountAppFrame(nav, strings, { onNavigate: navigate });
  }
}

// Until this device joins its candidate's team, show the join screen; the
// roll works either way. In a team, records sync now, on reconnect, on show
// and every 60 s online while shown (src/sync/syncEngine.js).
function startTeamJoin(strings) {
  if (!teamContainer) {
    return;
  }
  getAuth()
    .then(function (auth) {
      if (auth) {
        startSync();
        return;
      }
      teamContainer.hidden = false;
      mountTeamJoin(teamContainer, strings, {
        joinTeam: joinTeam,
        onJoined: function () {
          teamContainer.hidden = true;
          teamContainer.replaceChildren();
          startSync();
        },
      });
    })
    .catch(function (err) {
      console.error('team credentials could not be read', err);
    });
}

// A ward panch pick opens its roll; a sarpanch pick names its seat.
function startPicker(strings) {
  var picker = mountWardPicker(container, catalogue, strings, {
    initial: lastSelection,
    hasLoadedRoll: function () {
      return shownWardKey !== null;
    },
    onSelect: function (selection) {
      lastSelection = selection;
      saveLastSelection(selection);
      if (showSarpanch(selection)) {
        return;
      }
      var picked = toRollSelection(selection);
      if (roll && picked) {
        roll.open(selectionFor(wardKeyFor(picked)));
      }
    },
  });
  window.wardSelection = picker.wardSelection;
  // The empty card's button points at the picker, so it shows only once
  // the picker is there: one state at a time (DESIGN.md).
  var action = document.getElementById('primary-action');
  if (action) {
    action.hidden = false;
  }
  return picker;
}

var roll = null;

if (container) {
  var table = null;
  loadJson('src/strings.hi.json')
    .catch(function (err) {
      startSearch(null);
      roll = startRoll(null);
      startFrame(null);
      throw err;
    })
    .then(function (strings) {
      table = strings;
      seatStrings = strings;
      startSearch(strings);
      roll = startRoll(strings);
      showSarpanch(lastSelection);
      startFrame(strings);
      startTeamJoin(strings);
      var picker = startPicker(strings);
      // Whom to call when a roll or the catalogue will not open.
      loadJson('config/constituency.json')
        .then(function (loaded) {
          config = loaded;
          var support = loaded && loaded.supportContact;
          if (rollScreen) {
            rollScreen.setSupport(support);
          }
          if (searchScreen) {
            searchScreen.setSupport(support);
          }
          picker.setSupport(support);
        })
        .catch(function (err) {
          console.error('constituency config failed to load', err);
        });
    })
    .catch(function (err) {
      console.error('ward picker failed to load', err);
      showFailure(table);
    });
}
