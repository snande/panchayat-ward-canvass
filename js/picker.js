import { mountWardPicker } from '../src/ui/wardPickerScreen.js';

// Copy of picker_load_failed in src/strings.hi.json, used if the table itself
// failed to load. repo-ci fails if it drifts.
var FALLBACK_STRINGS = {
  picker_load_failed: "वार्ड सूची लोड नहीं हो सकी। कृपया पेज फिर से खोलें।",
};

var container = document.getElementById('ward-picker');

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

if (container) {
  var table = null;
  loadJson('src/strings.hi.json')
    .then(function (strings) {
      table = strings;
      return loadJson('config/constituency.json');
    })
    .then(function (config) {
      var picker = mountWardPicker(container, config, table);
      window.wardSelection = picker.wardSelection;
    })
    .catch(function (err) {
      console.error('ward picker failed to load', err);
      showFailure(table);
    });
}
