// Four dependent native <select> dropdowns over the bundled ward catalogue.
// All text comes from the strings table handed in; the catalogue is local, so
// the picker itself needs no network and sends no request.
//
// Contract: choosing a configured ward sets wardSelection() and calls
// opts.onSelect(selection) synchronously, online or not (the selection is
// valid either way; fetching the PDF is the caller's job). When the device is
// offline the picker additionally shows the Hindi "no network" message.

import { districts, samitis, panchayats, wards, selectionFor } from '../picker/wardPicker.js';

const LEVELS = [
  { key: 'district', label: 'picker_district', prompt: 'picker_district_prompt' },
  { key: 'samiti', label: 'picker_samiti', prompt: 'picker_samiti_prompt' },
  { key: 'panchayat', label: 'picker_panchayat', prompt: 'picker_panchayat_prompt' },
  { key: 'ward', label: 'picker_ward', prompt: 'picker_ward_prompt' },
];

function el(doc, tag, className, text) {
  const node = doc.createElement(tag);
  if (className) node.setAttribute('class', className);
  if (text != null) node.textContent = String(text);
  return node;
}

/** Default offline signal: the browser's own flag. No request is sent. */
export function defaultIsOnline() {
  return typeof navigator === 'undefined' || navigator.onLine !== false;
}

export function mountWardPicker(container, config, strings, opts = {}) {
  const doc = container.ownerDocument;
  const isOnline = opts.isOnline || defaultIsOnline;
  const text = (key) => (Object.prototype.hasOwnProperty.call(strings, key) ? strings[key] : '');
  let current = null;

  const root = el(doc, 'div', 'ward-picker');
  const selects = {};
  for (const level of LEVELS) {
    const row = el(doc, 'div', 'picker-field');
    const id = `picker-${level.key}`;
    const label = el(doc, 'label', 'picker-label', text(level.label));
    label.setAttribute('for', id);
    const select = el(doc, 'select', 'picker-select');
    select.setAttribute('id', id);
    selects[level.key] = select;
    row.appendChild(label);
    row.appendChild(select);
    root.appendChild(row);
  }
  const message = el(doc, 'p', 'picker-message');
  message.setAttribute('aria-live', 'polite');
  root.appendChild(message);
  container.replaceChildren(root);

  const valueOf = (key) => selects[key].value;

  // Options for level i, derived from the already-refilled parent values.
  function itemsFor(i) {
    const d = valueOf('district');
    const s = valueOf('samiti');
    const p = valueOf('panchayat');
    if (i === 0) return districts(config);
    if (i === 1) return d ? samitis(config, d) : [];
    if (i === 2) return d && s ? panchayats(config, d, s) : [];
    return d && s && p ? wards(config, d, s, p) : [];
  }

  function fill(i) {
    const level = LEVELS[i];
    const select = selects[level.key];
    const items = itemsFor(i);
    const nodes = [];
    const placeholder = el(doc, 'option', null, text(level.prompt));
    placeholder.setAttribute('value', '');
    nodes.push(placeholder);
    for (const item of items) {
      const opt = el(doc, 'option', null, item.label);
      opt.setAttribute('value', item.id);
      nodes.push(opt);
    }
    select.replaceChildren(...nodes);
    select.value = '';
    if (items.length === 0) select.setAttribute('disabled', '');
    else select.removeAttribute('disabled');
  }

  function rebuildFrom(i) {
    for (let k = i; k < LEVELS.length; k += 1) fill(k);
  }

  function onChange(index) {
    current = null;
    message.textContent = '';
    if (index < 3) {
      rebuildFrom(index + 1);
      return;
    }
    const picked = selectionFor(config, {
      district: valueOf('district'),
      samiti: valueOf('samiti'),
      panchayat: valueOf('panchayat'),
      ward: valueOf('ward'),
    });
    if (!picked) return;
    current = picked;
    if (!isOnline()) message.textContent = text('network_unavailable');
    if (typeof opts.onSelect === 'function') opts.onSelect(picked);
  }

  LEVELS.forEach((level, index) => {
    selects[level.key].addEventListener('change', () => onChange(index));
  });

  rebuildFrom(0);

  return {
    wardSelection: () => current,
    selects,
    message,
  };
}
