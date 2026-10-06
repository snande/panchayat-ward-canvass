import { mountWardPicker } from '../src/ui/wardPickerScreen.js';

var container = document.getElementById('ward-picker');

if (container) {
  Promise.all([
    fetch('config/constituency.json').then(function (r) { return r.json(); }),
    fetch('src/strings.hi.json').then(function (r) { return r.json(); }),
  ])
    .then(function (loaded) {
      var picker = mountWardPicker(container, loaded[0], loaded[1]);
      window.wardSelection = picker.wardSelection;
    })
    .catch(function (err) {
      console.error('ward picker failed to load', err);
    });
}
