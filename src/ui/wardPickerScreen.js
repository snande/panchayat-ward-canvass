// The ward picker: seat type, then district, then panchayat, then ward, over
// the sharded catalogue (src/picker/catalogueLoader.js). All text comes from
// the strings table handed in (with copies below for when it is missing).
//
// 1. Seat type: two buttons, वार्ड पंच and सरपंच.
// 2. District: a select filled from data/sec/catalogue/index.json, the only
//    file fetched on first open.
// 3. Panchayat: a text field over the district's list, a list row each,
//    fetched only once the district is chosen. Typing filters the list by the
//    Hindi name or the Latin one (nameLatin).
// 4. Ward: a select; skipped for a sarpanch, whose selection is every ward.
//
// Contract: a complete pick sets wardSelection() and calls
// opts.onSelect(selection, { panchayat }) synchronously, online or not (the
// selection is valid either way; fetching the roll is the caller's job), with
// the selection of src/picker/wardPicker.js and the shard's panchayat entry.
// Offline, the picker also shows the Hindi "no network" line.
//
// One state at a time in the notice (DESIGN.md "States every surface
// carries"): loading while a catalogue file is fetched, empty when a district
// lists no panchayat or the typed name matches none, error (with retry and
// whom to call, or "update the app" for a catalogue version this app cannot
// read), success once a seat is picked.
//
// Changing the seat type, district or panchayat while opts.hasLoadedRoll()
// says a roll is loaded asks first (DESIGN.md "Alert"): nothing is replaced
// until the danger button is tapped.

import { el, setNotice, textFrom } from './dom.js';
import {
  buildSelection, districtOptions, filterPanchayats, findPanchayat, isSelection, sortedWards,
  SEAT_SARPANCH, SEAT_WARD_PANCH,
} from '../picker/wardPicker.js';

// Copies of src/strings.hi.json entries, used if the table lacks them.
// test/wardPicker.test.js fails if they drift.
export const FALLBACK_TEXT = {
  picker_seat_type: 'सीट का प्रकार',
  picker_seat_ward_panch: 'वार्ड पंच',
  picker_seat_sarpanch: 'सरपंच',
  picker_district: 'ज़िला',
  picker_district_prompt: 'ज़िला चुनें',
  picker_panchayat: 'ग्राम पंचायत',
  picker_panchayat_filter: 'पंचायत का नाम लिखें, हिंदी या अंग्रेज़ी अक्षरों में',
  picker_panchayat_empty: 'इस ज़िले की सूची में कोई ग्राम पंचायत नहीं है। दूसरा ज़िला चुनें।',
  picker_panchayat_no_match: 'इस नाम की कोई ग्राम पंचायत नहीं मिली। नाम दोबारा लिखें।',
  picker_ward: 'वार्ड',
  picker_ward_prompt: 'वार्ड चुनें',
  picker_all_wards: 'सभी वार्ड',
  picker_selected: 'चुना गया',
  picker_loading: 'वार्ड सूची लोड हो रही है…',
  picker_load_failed: 'वार्ड सूची लोड नहीं हो सकी। इंटरनेट चालू होने पर फिर से कोशिश करें, या टीम के सहायता नंबर पर कॉल करें।',
  picker_version_unsupported: 'वार्ड सूची का यह संस्करण यह ऐप नहीं पढ़ सकता। ऐप अपडेट करें।',
  picker_retry: 'फिर से कोशिश करें',
  picker_confirm_replace: 'अभी लोड की गई सीट की जगह नई सीट आ जाएगी। क्या सीट बदलनी है?',
  picker_confirm_yes: 'हाँ, सीट बदलें',
  picker_confirm_no: 'नहीं',
  network_unavailable: 'नेटवर्क नहीं है',
};

export const PICKER_STATES = ['loading', 'empty', 'error', 'success', 'ready'];

/** Default offline signal: the browser's own flag. No request is sent. */
export function defaultIsOnline() {
  return typeof navigator === 'undefined' || navigator.onLine !== false;
}

function field(doc, id, labelText) {
  const row = el(doc, 'div', 'picker-field');
  const label = el(doc, 'label', 'picker-label', labelText);
  label.setAttribute('for', id);
  row.appendChild(label);
  return row;
}

function button(doc, className, text) {
  const node = el(doc, 'button', className, text);
  node.setAttribute('type', 'button');
  return node;
}

/**
 * Mount the picker into container.
 * @param {Element} container
 * @param {{loadIndex: Function, loadShard: Function, cachedShard?: Function}} loader
 * @param {Record<string,string>|null} strings
 * @param {{onSelect?: Function, isOnline?: Function, hasLoadedRoll?: Function, support?: string}} [opts]
 */
export function mountWardPicker(container, loader, strings, opts = {}) {
  const doc = container.ownerDocument;
  const isOnline = opts.isOnline || defaultIsOnline;
  const text = textFrom(strings, FALLBACK_TEXT);

  let seatType = null;
  let index = null;
  let indexError = null;
  let districtId = '';
  let shard = null;
  let shardError = null;
  let shardLoading = false;
  let panchayat = null;
  let query = '';
  let current = null;
  let pending = null;
  let support = typeof opts.support === 'string' ? opts.support : '';
  let state = 'loading';

  const root = el(doc, 'div', 'ward-picker');

  // 1. Seat type.
  const seatField = el(doc, 'div', 'picker-field');
  const seatLabel = el(doc, 'p', 'picker-label', text('picker_seat_type'));
  seatLabel.setAttribute('id', 'picker-seat-label');
  const seatGroup = el(doc, 'div', 'picker-seat-types');
  seatGroup.setAttribute('role', 'group');
  seatGroup.setAttribute('aria-labelledby', 'picker-seat-label');
  const seatButtons = {};
  for (const [type, key] of [[SEAT_WARD_PANCH, 'picker_seat_ward_panch'], [SEAT_SARPANCH, 'picker_seat_sarpanch']]) {
    const node = button(doc, 'btn-secondary picker-seat-option', text(key));
    node.setAttribute('data-seat-type', type);
    node.setAttribute('aria-pressed', 'false');
    node.addEventListener('click', () => chooseSeat(type));
    seatButtons[type] = node;
    seatGroup.appendChild(node);
  }
  // The first control: js/app.js and js/picker.js move focus here.
  seatButtons[SEAT_WARD_PANCH].setAttribute('id', 'picker-seat-type');
  seatField.appendChild(seatLabel);
  seatField.appendChild(seatGroup);

  // 2. District.
  const districtField = field(doc, 'picker-district', text('picker_district'));
  const districtSelect = el(doc, 'select', 'field-select picker-district');
  districtSelect.setAttribute('id', 'picker-district');
  districtSelect.addEventListener('change', () => chooseDistrict(districtSelect.value));
  districtField.appendChild(districtSelect);

  // 3. Panchayat.
  const panchayatField = field(doc, 'picker-panchayat', text('picker_panchayat'));
  const filter = el(doc, 'input', 'field-input picker-panchayat-filter');
  filter.setAttribute('id', 'picker-panchayat');
  filter.setAttribute('type', 'search');
  filter.setAttribute('autocomplete', 'off');
  filter.setAttribute('placeholder', text('picker_panchayat_filter'));
  filter.addEventListener('input', () => {
    query = filter.value || '';
    renderPanchayats();
    update();
  });
  const panchayatList = el(doc, 'div', 'picker-panchayat-list');
  panchayatList.setAttribute('role', 'list');
  panchayatField.appendChild(filter);
  panchayatField.appendChild(panchayatList);

  // 4. Ward.
  const wardField = field(doc, 'picker-ward', text('picker_ward'));
  const wardSelect = el(doc, 'select', 'field-select picker-ward');
  wardSelect.setAttribute('id', 'picker-ward');
  wardSelect.addEventListener('change', () => chooseWard(wardSelect.value));
  wardField.appendChild(wardSelect);

  // The confirmation before a loaded seat is replaced.
  const confirm = el(doc, 'div', 'alert picker-confirm');
  confirm.setAttribute('data-tone', 'error');
  confirm.setAttribute('role', 'alertdialog');
  confirm.hidden = true;
  const confirmText = el(doc, 'p', null, text('picker_confirm_replace'));
  const confirmActions = el(doc, 'div', 'picker-confirm-actions');
  const confirmYes = button(doc, 'btn-danger picker-confirm-yes', text('picker_confirm_yes'));
  const confirmNo = button(doc, 'btn-secondary picker-confirm-no', text('picker_confirm_no'));
  confirmActions.appendChild(confirmYes);
  confirmActions.appendChild(confirmNo);
  confirm.appendChild(confirmText);
  confirm.appendChild(confirmActions);
  confirmYes.addEventListener('click', () => {
    const action = pending;
    closeConfirm();
    if (action) action.apply();
  });
  confirmNo.addEventListener('click', () => {
    const action = pending;
    closeConfirm();
    if (action && action.revert) action.revert();
  });

  // The one notice, whom to call, and retry.
  const message = el(doc, 'p', 'notice picker-message');
  message.setAttribute('role', 'status');
  message.setAttribute('aria-live', 'polite');
  const contact = el(doc, 'p', 'picker-contact');
  contact.hidden = true;
  const retry = button(doc, 'btn-secondary picker-retry', text('picker_retry'));
  retry.hidden = true;
  retry.addEventListener('click', onRetry);

  for (const node of [seatField, districtField, panchayatField, wardField, confirm, message, contact, retry]) {
    root.appendChild(node);
  }
  container.replaceChildren(root);

  const loadedRoll = () => typeof opts.hasLoadedRoll === 'function' && Boolean(opts.hasLoadedRoll());

  // Run a change now, or, with a roll loaded and a seat to replace, once confirmed.
  function guard(replaces, apply, revert) {
    if (replaces && loadedRoll()) {
      pending = { apply, revert };
      confirm.hidden = false;
      update();
      if (typeof confirmNo.focus === 'function') confirmNo.focus();
      return;
    }
    apply();
  }

  function closeConfirm() {
    pending = null;
    confirm.hidden = true;
  }

  function emit(selection) {
    current = selection;
    update();
    if (selection && typeof opts.onSelect === 'function') opts.onSelect(selection, { panchayat });
  }

  function chooseSeat(type) {
    if (type === seatType) return;
    guard(seatType !== null, () => {
      seatType = type;
      current = null;
      wardSelect.value = '';
      update();
      if (type === SEAT_SARPANCH && panchayat) emit(buildSelection(SEAT_SARPANCH, shard, panchayat));
    });
  }

  function chooseDistrict(id) {
    if (id === districtId) return;
    guard(panchayat !== null, () => {
      districtId = id;
      districtSelect.value = id;
      shard = null;
      shardError = null;
      panchayat = null;
      current = null;
      query = '';
      filter.value = '';
      renderPanchayats();
      fillWards();
      if (id) loadDistrict(id);
      update();
    }, () => {
      districtSelect.value = districtId;
    });
  }

  function choosePanchayat(id) {
    if (panchayat && panchayat.id === id) return;
    const next = findPanchayat(shard, id);
    if (!next) return;
    guard(true, () => {
      panchayat = next;
      current = null;
      renderPanchayats();
      fillWards();
      update();
      if (seatType === SEAT_SARPANCH) emit(buildSelection(SEAT_SARPANCH, shard, panchayat));
    });
  }

  function chooseWard(value) {
    current = null;
    if (!value || seatType !== SEAT_WARD_PANCH || !panchayat) {
      update();
      return;
    }
    const selection = buildSelection(SEAT_WARD_PANCH, shard, panchayat, value);
    if (!selection) {
      update();
      return;
    }
    emit(selection);
  }

  function loadIndex() {
    indexError = null;
    update();
    return loader.loadIndex().then((doc) => {
      index = doc;
      fillDistricts();
      update();
    }, (err) => {
      indexError = err;
      update();
    });
  }

  function loadDistrict(id) {
    const cached = typeof loader.cachedShard === 'function' ? loader.cachedShard(id) : null;
    if (cached) {
      shardLoading = false;
      shardError = null;
      shard = cached;
      renderPanchayats();
      return;
    }
    shardLoading = true;
    shardError = null;
    loader.loadShard(id).then((doc) => {
      if (districtId !== id) return;
      shardLoading = false;
      shard = doc;
      renderPanchayats();
      update();
    }, (err) => {
      if (districtId !== id) return;
      shardLoading = false;
      shardError = err;
      update();
    });
  }

  function onRetry() {
    if (indexError) loadIndex();
    else if (shardError && districtId) {
      loadDistrict(districtId);
      update();
    }
  }

  function option(value, label) {
    const node = el(doc, 'option', null, label);
    node.setAttribute('value', value);
    return node;
  }

  function fillDistricts() {
    const nodes = [option('', text('picker_district_prompt'))];
    for (const d of districtOptions(index)) nodes.push(option(d.id, d.label));
    districtSelect.replaceChildren(...nodes);
    districtSelect.value = districtId;
  }

  function fillWards() {
    const nodes = [option('', text('picker_ward_prompt'))];
    for (const w of sortedWards(panchayat)) nodes.push(option(String(w.ward), `${text('picker_ward')} ${w.ward}`));
    wardSelect.replaceChildren(...nodes);
    wardSelect.value = '';
  }

  function shown() {
    return shard ? filterPanchayats(shard.panchayats, query) : [];
  }

  function renderPanchayats() {
    const rows = [];
    for (const p of shown()) {
      const row = button(doc, 'list-row picker-panchayat-option');
      row.setAttribute('data-id', p.id);
      row.setAttribute('role', 'listitem');
      row.setAttribute('aria-pressed', panchayat && panchayat.id === p.id ? 'true' : 'false');
      row.appendChild(el(doc, 'span', 'picker-option-name', p.name));
      row.appendChild(el(doc, 'span', 'picker-option-detail', p.block.name));
      row.addEventListener('click', () => choosePanchayat(p.id));
      rows.push(row);
    }
    panchayatList.replaceChildren(...rows);
  }

  function errorText(err) {
    return err && err.kind === 'unsupported-version' ? text('picker_version_unsupported') : text('picker_load_failed');
  }

  function selectedText(selection) {
    const where = `${text('picker_selected')}: ${selection.panchayat.name}`;
    if (selection.seatType === SEAT_SARPANCH) return `${where} · ${text('picker_all_wards')} (${selection.wards.length})`;
    return `${where} · ${text('picker_ward')} ${selection.wards[0].ward}`;
  }

  // The notice and which steps show, from the state above.
  function update() {
    for (const [type, node] of Object.entries(seatButtons)) {
      node.setAttribute('aria-pressed', type === seatType ? 'true' : 'false');
    }
    districtField.hidden = seatType === null;
    if (index) districtSelect.removeAttribute('disabled');
    else districtSelect.setAttribute('disabled', '');
    panchayatField.hidden = seatType === null || !shard;
    wardField.hidden = seatType !== SEAT_WARD_PANCH || !panchayat;

    const error = indexError || shardError;
    let notice = '';
    let tone = 'info';
    if (error) {
      state = 'error';
      notice = errorText(error);
      tone = 'error';
    } else if (!index || shardLoading) {
      state = 'loading';
      notice = text('picker_loading');
    } else if (shard && shard.panchayats.length === 0) {
      state = 'empty';
      notice = text('picker_panchayat_empty');
    } else if (shard && shown().length === 0) {
      state = 'empty';
      notice = text('picker_panchayat_no_match');
    } else if (current) {
      state = 'success';
      if (isOnline()) {
        notice = selectedText(current);
        tone = 'success';
      } else {
        notice = text('network_unavailable');
      }
    } else {
      state = 'ready';
    }
    setNotice(message, notice, tone);
    message.hidden = !notice;
    root.setAttribute('data-state', state);
    retry.hidden = !error || error.kind === 'unsupported-version';
    contact.textContent = support;
    contact.hidden = !error || !support;
  }

  /**
   * Reopen the picker on a stored selection (src/picker/lastSelection.js),
   * re-read from the catalogue, without calling onSelect. Resolves false, and
   * leaves the picker at its first step, when the catalogue no longer lists
   * it or a pick has already started.
   */
  async function restore(selection) {
    if (!isSelection(selection)) return false;
    try {
      const doc = await loader.loadIndex();
      if (!doc.districts.some((d) => d.id === selection.district.id)) return false;
      const districtShard = await loader.loadShard(selection.district.id);
      const entry = findPanchayat(districtShard, selection.panchayat.id);
      if (!entry || entry.block.id !== selection.panchayat.block.id) return false;
      const again = buildSelection(selection.seatType, districtShard, entry, selection.wards[0].ward);
      if (!again || seatType !== null || districtId !== '') return false;
      index = doc;
      fillDistricts();
      seatType = selection.seatType;
      districtId = districtShard.id;
      districtSelect.value = districtId;
      shard = districtShard;
      panchayat = entry;
      renderPanchayats();
      fillWards();
      if (seatType === SEAT_WARD_PANCH) wardSelect.value = String(again.wards[0].ward);
      current = again;
      update();
      return true;
    } catch {
      return false;
    }
  }

  fillDistricts();
  fillWards();
  update();
  loadIndex();

  return {
    root,
    wardSelection: () => current,
    state: () => state,
    restore,
    setSupport(value) {
      support = typeof value === 'string' ? value : '';
      update();
    },
    seatButtons,
    selects: { district: districtSelect, ward: wardSelect },
    filter,
    panchayatList,
    panchayatOptions: () => panchayatList.querySelectorAll('button.picker-panchayat-option'),
    message,
    contact,
    retry,
    confirm: { root: confirm, yes: confirmYes, no: confirmNo },
  };
}
