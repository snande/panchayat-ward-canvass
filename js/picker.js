import { mountWardPicker } from '../src/ui/wardPickerScreen.js';
import { createRollFlow } from '../src/roll/rollFlow.js';
import { getAuth, joinTeam } from '../src/sync/teamAuth.js';
import { mountTeamJoin } from '../src/ui/teamJoinScreen.js';

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
  p.setAttribute('class', 'picker-message');
  p.setAttribute('role', 'alert');
  p.textContent = (strings && strings.picker_load_failed) || FALLBACK_STRINGS.picker_load_failed;
  container.replaceChildren(p);
}

// Once a roll is on screen the "not loaded yet" card is no longer true.
function hideEmptyState() {
  var empty = document.querySelector('.empty-state');
  if (empty) {
    empty.hidden = true;
  }
}

// Picking a ward downloads, decodes and stores its roll (src/roll/rollFlow.js);
// at startup the last stored roll is shown again with no network request.
function startRoll(strings) {
  if (!rollContainer) {
    return null;
  }
  var roll = createRollFlow(rollContainer, Object.assign({}, FALLBACK_STRINGS, strings || {}), {
    onShow: hideEmptyState,
  });
  roll.restore();
  return roll;
}

// Until this device has joined its candidate's team, show the join screen
// (candidate code + team passphrase). The ward roll works either way.
function startTeamJoin(strings) {
  if (!teamContainer) {
    return;
  }
  getAuth()
    .then(function (auth) {
      if (auth) {
        return;
      }
      teamContainer.hidden = false;
      mountTeamJoin(teamContainer, strings, {
        joinTeam: joinTeam,
        onJoined: function () {
          teamContainer.hidden = true;
          teamContainer.replaceChildren();
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
      throw err;
    })
    .then(function (strings) {
      table = strings;
      roll = startRoll(strings);
      startTeamJoin(strings);
      return loadJson('config/constituency.json');
    })
    .then(function (config) {
      var picker = mountWardPicker(container, config, table, {
        onSelect: function (selection) {
          if (roll) {
            roll.open(selection);
          }
        },
      });
      window.wardSelection = picker.wardSelection;
    })
    .catch(function (err) {
      console.error('ward picker failed to load', err);
      showFailure(table);
    });
}
