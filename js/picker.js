import { mountWardPicker } from '../src/ui/wardPickerScreen.js';
import { createRollFlow } from '../src/roll/rollFlow.js';
import { createWardRollScreen } from '../src/ui/wardRollScreen.js';
import { mountAppFrame } from '../src/ui/appFrame.js';
import { getAuth, getDeviceId, joinTeam } from '../src/sync/teamAuth.js';
import { mountTeamJoin } from '../src/ui/teamJoinScreen.js';
import { renderSeatHeader, saveSeat, seatFromWardKey } from '../src/ui/seatHeader.js';
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
  roll_loading: "मतदाता सूची डाउनलोड हो रही है…",
  roll_fetch_failed: "मतदाता सूची डाउनलोड नहीं हो सकी। इंटरनेट जाँचें और फिर से कोशिश करें।",
  roll_failed: "मतदाता सूची खोली नहीं जा सकी। फिर से कोशिश करें।",
  roll_retry: "फिर से कोशिश करें",
};

var container = document.getElementById('ward-picker');
var rollContainer = document.getElementById('roll');
var teamContainer = document.getElementById('team-join');
var seatHeader = document.getElementById('seat-header');

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

// The seat header above every screen names the ward whose roll is on screen,
// and keeps it (panchayat name, ward, seat type only) for the next cold start.
// It follows the shown roll, not the pick: a pick whose download fails leaves
// the previous seat (and its roll) in place. A roll restored before the ward
// catalogue has loaded is named once the catalogue is there.
var catalogue = null;
var seatStrings = null;
var shownWardKey = null;

function showSeat() {
  var seat = catalogue && seatFromWardKey(catalogue, shownWardKey);
  if (!seat) {
    return;
  }
  saveSeat(seat);
  renderSeatHeader(seatHeader, seat, seatStrings || {});
}

function onRollShown(entries, wardKey) {
  shownWardKey = wardKey;
  showSeat();
}

// The ward-roll screen (src/ui/wardRollScreen.js): empty until a ward is
// picked or a stored roll is restored, then loading, filled or error. The
// "not loaded yet" card shows only in its empty state.
var rollScreen = null;
var frame = null;

// Picking a ward downloads, decodes and stores its roll (src/roll/rollFlow.js);
// at startup the last stored roll is shown again with no network request.
function startRoll(strings) {
  if (!rollContainer) {
    return null;
  }
  var table = Object.assign({}, FALLBACK_STRINGS, strings || {});
  rollScreen = createWardRollScreen(rollContainer, table, {
    emptyCard: document.querySelector('.empty-state'),
    // A new state replaces whatever was open over the roll, so the nav bar
    // marks the ward roll as current again.
    onState: function () {
      if (frame) {
        frame.select('roll');
      }
    },
  });
  rollScreen.setState('empty');
  var roll = createRollFlow(rollContainer, table, {
    screen: rollScreen,
    onShow: onRollShown,
    // marks: tapping a voter offers "seen voting", and the turnout button
    // shows the ward's de-duplicated count beside the official turnout.
    // sms: with no mobile data, marks go out and come in by SMS and join the
    // same de-duplicated count.
    listOptions: { contacts: contacts, marks: marks, workerId: workerId, sms: { settings: smsSettings, teamNumber: teamNumber } },
  });
  roll.restore();
  return roll;
}

// Brings the ward-roll screen into view: the roll (or its loading line or
// error) once there is one, otherwise the ward picker's first dropdown.
function showRollScreen() {
  var target = rollScreen && rollScreen.state !== 'empty' ? rollContainer : container;
  if (target && typeof target.scrollIntoView === 'function') {
    target.scrollIntoView();
  }
  if (!rollScreen || rollScreen.state === 'empty') {
    var first = document.getElementById('picker-district');
    if (first && typeof first.focus === 'function') {
      first.focus();
    }
  }
}

// The bottom navigation bar (src/ui/appFrame.js) reaches every screen. The
// call list, polling-day count and SMS tally belong to a loaded ward, so they
// open over the roll on screen; with none, the entry leads to the ward picker.
function navigate(id) {
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

// Until this device has joined its candidate's team, show the join screen
// (candidate code + team passphrase). The ward roll works either way.
// Once the device is in a team, records saved on it go to the team (and
// teammates' records come in) now, on reconnect, when the page is shown
// again and every 30 s while online (src/sync/syncEngine.js).
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

if (container) {
  var table = null;
  var roll = null;
  loadJson('src/strings.hi.json')
    .catch(function (err) {
      roll = startRoll(null);
      startFrame(null);
      throw err;
    })
    .then(function (strings) {
      table = strings;
      roll = startRoll(strings);
      startFrame(strings);
      startTeamJoin(strings);
      return loadJson('config/constituency.json');
    })
    .then(function (config) {
      catalogue = config;
      seatStrings = table;
      // Whom to call when a roll will not open: the constituency's support
      // contact if the catalogue names one, else the neutral coordinator line.
      if (rollScreen) {
        rollScreen.setSupport(config && config.supportContact);
      }
      showSeat();
      var picker = mountWardPicker(container, config, table, {
        onSelect: function (selection) {
          if (roll) {
            roll.open(selection);
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
    })
    .catch(function (err) {
      console.error('ward picker failed to load', err);
      showFailure(table);
    });
}
