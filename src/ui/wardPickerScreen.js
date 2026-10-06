// Four dependent native <select> dropdowns over the bundled ward catalogue.
// All text comes from the strings table handed in; the catalogue is local, so
// the picker itself needs no network.

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

function defaultConnectivityCheck(pdfUrl) {
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return Promise.resolve(false);
  if (typeof fetch !== 'function') return Promise.resolve(true);
  return fetch(pdfUrl, { method: 'HEAD', mode: 'no-cors' }).then(
    () => true,
    () => false,
  );
}

export function mountWardPicker(container, config, strings, opts = {}) {
  const doc = container.ownerDocument;
  const connectivityCheck = opts.connectivityCheck || defaultConnectivityCheck;
  const text = (key) => (Object.prototype.hasOwnProperty.call(strings, key) ? strings[key] : '');
  let current = null;
  let checkId = 0;

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
  container.appendChild(root);

  function fill(level, items) {
    const select = selects[level.key];
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
  }

  function values() {
    return {
      district: selects.district.value,
      samiti: selects.samiti.value,
      panchayat: selects.panchayat.value,
      ward: selects.ward.value,
    };
  }

  function refresh(from) {
    const v = values();
    if (from <= 1) fill(LEVELS[1], v.district ? samitis(config, v.district) : []);
    if (from <= 2) fill(LEVELS[2], panchayats(config, v.district, selects.samiti.value));
    if (from <= 3) fill(LEVELS[3], wards(config, v.district, selects.samiti.value, selects.panchayat.value));
  }

  function onChange(index) {
    checkId += 1;
    current = null;
    message.textContent = '';
    if (index < 3) {
      refresh(index + 1);
      return;
    }
    const picked = selectionFor(config, values());
    if (!picked) return;
    current = picked;
    const mine = checkId;
    Promise.resolve(connectivityCheck(picked.pdfUrl)).then((online) => {
      if (mine === checkId && !online) message.textContent = text('network_unavailable');
      if (typeof opts.onSelect === 'function' && mine === checkId) opts.onSelect(picked);
    });
  }

  LEVELS.forEach((level, index) => {
    selects[level.key].addEventListener('change', () => onChange(index));
  });

  fill(LEVELS[0], districts(config));
  refresh(1);

  return {
    wardSelection: () => current,
    selects,
    message,
  };
}
