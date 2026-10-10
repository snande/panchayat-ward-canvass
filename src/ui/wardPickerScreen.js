// The ward picker over the SEC catalogue (src/picker/catalogue.js): seat
// type, district, gram panchayat, then ward, which a सरपंच seat skips (it
// selects every ward). A complete pick calls opts.onSelect(selection).

import { el, setNotice, textFrom } from './dom.js';
import { buildSelection, filterPanchayats, panchayatLabel, CatalogueVersionError } from '../picker/catalogue.js';

export function defaultIsOnline() {
  return typeof navigator === 'undefined' || navigator.onLine !== false;
}

export function mountWardPicker(container, catalogue, strings, opts = {}) {
  const doc = container.ownerDocument;
  const isOnline = opts.isOnline || defaultIsOnline;
  const hasLoadedRoll = opts.hasLoadedRoll || (() => false);
  const text = textFrom(strings, null);
  let index = null;
  let shard = null;
  let current = null;
  let generation = 0;
  let support = '';
  let retry = null;
  let pending = null;
  // The committed choice of each guarded step.
  const values = { seatType: '', district: '', panchayat: '' };

  const root = el(doc, 'div', 'ward-picker');
  const add = (node) => root.appendChild(node);
  const button = (cls, key) => {
    const b = el(doc, 'button', cls, text(key));
    b.setAttribute('type', 'button');
    return b;
  };
  function field(id, key, control) {
    const row = el(doc, 'div', 'picker-field');
    const label = el(doc, 'label', 'picker-label', text(key));
    label.setAttribute('for', id);
    control.setAttribute('id', id);
    row.appendChild(label);
    row.appendChild(control);
    return add(row);
  }
  const select = () => el(doc, 'select', 'picker-select');
  const selects = { seatType: select(), district: select(), panchayat: select(), ward: select() };
  const search = el(doc, 'input', 'field-input picker-search');
  search.setAttribute('type', 'search');
  field('picker-seat-type', 'picker_seat_type', selects.seatType);
  field('picker-district', 'picker_district', selects.district);
  field('picker-panchayat-search', 'picker_panchayat_search', search);
  field('picker-panchayat', 'picker_panchayat', selects.panchayat);
  const wardRow = field('picker-ward', 'picker_ward', selects.ward);

  const notice = add(el(doc, 'p', 'notice picker-notice'));
  notice.setAttribute('aria-live', 'polite');
  const contact = add(el(doc, 'p', 'picker-contact'));
  const retryButton = add(button('btn-secondary picker-retry', 'roll_retry'));
  // Nothing is replaced until "yes".
  const confirmBox = add(el(doc, 'div', 'alert picker-confirm'));
  confirmBox.setAttribute('data-tone', 'error');
  confirmBox.setAttribute('role', 'alertdialog');
  confirmBox.setAttribute('aria-describedby', 'picker-confirm-text');
  const confirmText = el(doc, 'p', null, text('picker_confirm_replace'));
  confirmText.setAttribute('id', 'picker-confirm-text');
  const confirmYes = button('btn-danger picker-confirm-yes', 'picker_confirm_replace_yes');
  const confirmNo = button('btn-secondary picker-confirm-no', 'picker_confirm_replace_no');
  for (const node of [confirmText, confirmYes, confirmNo]) confirmBox.appendChild(node);
  confirmBox.hidden = true;
  const message = add(el(doc, 'p', 'picker-message'));
  message.setAttribute('aria-live', 'polite');
  container.replaceChildren(root);

  const enable = (control, on) => (on ? control.removeAttribute('disabled') : control.setAttribute('disabled', ''));

  function fill(target, promptKey, items, keep = '') {
    const nodes = [['', text(promptKey)], ...items].map(([value, label]) => {
      const opt = el(doc, 'option', null, label);
      opt.setAttribute('value', value);
      return opt;
    });
    target.replaceChildren(...nodes);
    target.value = items.some(([value]) => value === keep) ? keep : '';
    enable(target, items.length > 0);
  }

  // One state at a time: loading, ready, empty, error, version or success.
  function setState(state, words = '') {
    const failed = state === 'error' || state === 'version';
    root.setAttribute('data-state', failed ? 'error' : state);
    if (state === 'version') root.setAttribute('data-error', 'version');
    else root.removeAttribute('data-error');
    setNotice(notice, words, failed ? 'error' : state === 'success' ? 'success' : 'info');
    if (failed) notice.setAttribute('role', 'alert');
    else notice.removeAttribute('role');
    contact.hidden = state !== 'error';
    contact.textContent = state === 'error' ? support || text('picker_error_contact') : '';
    retryButton.hidden = state !== 'error' || !retry;
    if (state !== 'success') message.textContent = '';
  }

  function fail(err, again) {
    const version = err instanceof CatalogueVersionError;
    retry = version ? null : again;
    setState(version ? 'version' : 'error', text(version ? 'catalogue_version_unsupported' : 'picker_error_retry'));
    console.error('ward catalogue failed to load', err);
  }

  const district = () => index && index.districts.find((d) => d.id === values.district);
  const panchayat = () => shard && shard.panchayats.find((p) => p.id === values.panchayat);

  function fillWards() {
    const p = panchayat();
    fill(selects.ward, 'picker_ward_prompt', p ? p.wards.map((w) => [String(w.ward), String(w.ward)]) : []);
  }

  function idle() {
    if (shard && selects.panchayat.children.length <= 1) {
      setState('empty', text(shard.panchayats.length ? 'picker_no_match' : 'picker_no_panchayats'));
    } else if (index) {
      setState('ready');
    }
  }

  function showSuccess() {
    const sarpanch = current.seatType === 'sarpanch';
    setState('success', `${text(sarpanch ? 'picker_selected_all_wards' : 'picker_selected_ward')} ${
      sarpanch ? current.wards.length : current.wards[0].ward}`);
    message.textContent = isOnline() ? '' : text('network_unavailable');
  }

  // The panchayat list follows the typed text (Hindi or Latin letters).
  function refreshPanchayats() {
    const list = filterPanchayats(shard.panchayats, search.value);
    fill(selects.panchayat, 'picker_panchayat_prompt', list.map((p) => [p.id, panchayatLabel(p)]), values.panchayat);
    if (current && list.length) showSuccess();
    else idle();
  }

  // A complete pick becomes the selection; anything less clears it.
  function settle(emit) {
    const ward = values.seatType === 'ward-panch' ? selects.ward.value : null;
    current = values.seatType && (ward || values.seatType === 'sarpanch') && district() && panchayat()
      ? buildSelection(values.seatType, district(), panchayat(), ward) : null;
    if (!current) return idle();
    showSuccess();
    if (emit && opts.onSelect) opts.onSelect(current);
  }

  function loadDistrict(after) {
    const gen = ++generation;
    const d = district();
    shard = null;
    current = null;
    search.value = '';
    enable(search, false);
    fill(selects.panchayat, 'picker_panchayat_prompt', []);
    fill(selects.ward, 'picker_ward_prompt', []);
    if (!d) return setState('ready');
    setState('loading', text('picker_loading'));
    return catalogue.loadShard(d).then((loaded) => {
      if (gen !== generation) return;
      shard = loaded;
      enable(search, true);
      refreshPanchayats();
      if (after) after();
    }, (err) => gen === generation && fail(err, () => loadDistrict(after)));
  }

  function setSeat(seatType) {
    values.seatType = seatType;
    wardRow.hidden = seatType === 'sarpanch';
    enable(selects.district, Boolean(seatType && index && index.districts.length));
  }

  const apply = {
    seatType: () => {
      setSeat(selects.seatType.value);
      settle(true);
    },
    district: () => {
      values.district = selects.district.value;
      values.panchayat = '';
      loadDistrict(null);
    },
    panchayat: () => {
      values.panchayat = selects.panchayat.value;
      fillWards();
      settle(true);
    },
  };

  // With a roll loaded, these changes wait for "yes" in the alert.
  for (const key of Object.keys(apply)) {
    selects[key].addEventListener('change', () => {
      const next = selects[key].value;
      const previous = values[key];
      if (next === previous) return;
      if (!previous || !hasLoadedRoll()) return apply[key]();
      selects[key].value = previous;
      pending = () => {
        selects[key].value = next;
        apply[key]();
      };
      confirmBox.hidden = false;
      if (confirmYes.focus) confirmYes.focus();
    });
  }
  selects.ward.addEventListener('change', () => settle(true));
  search.addEventListener('input', () => shard && refreshPanchayats());
  const closeConfirm = () => {
    const action = pending;
    confirmBox.hidden = true;
    pending = null;
    return action;
  };
  confirmYes.addEventListener('click', () => {
    const action = closeConfirm();
    if (action) action();
  });
  confirmNo.addEventListener('click', closeConfirm);
  retryButton.addEventListener('click', () => {
    const again = retry;
    retry = null;
    if (again) again();
  });

  // A stored selection is put back, not emitted.
  function restore(initial) {
    if (!initial || !index.districts.some((d) => d.id === initial.district.id)) return null;
    selects.seatType.value = initial.seatType;
    setSeat(initial.seatType);
    selects.district.value = initial.district.id;
    values.district = initial.district.id;
    return loadDistrict(() => {
      if (!shard.panchayats.some((p) => p.id === initial.panchayat.id)) return;
      values.panchayat = initial.panchayat.id;
      selects.panchayat.value = values.panchayat;
      fillWards();
      if (initial.seatType === 'ward-panch') selects.ward.value = String(initial.wards[0].ward);
      settle(false);
    });
  }

  function start() {
    setState('loading', text('picker_loading'));
    return catalogue.loadIndex().then((loaded) => {
      index = loaded;
      fill(selects.district, 'picker_district_prompt', index.districts.map((d) => [d.id, d.name]));
      setSeat(values.seatType);
      if (!index.districts.length) return setState('empty', text('picker_no_districts'));
      setState('ready');
      return restore(opts.initial);
    }, (err) => fail(err, start));
  }

  function setSupport(value) {
    support = typeof value === 'string' ? value.trim() : '';
    if (!contact.hidden) contact.textContent = support || text('picker_error_contact');
  }

  fill(selects.seatType, 'picker_seat_prompt',
    [['ward-panch', text('picker_seat_ward_panch')], ['sarpanch', text('picker_seat_sarpanch')]]);
  fill(selects.district, 'picker_district_prompt', []);
  fillWards();
  loadDistrict(null);
  setSupport(opts.support);
  const ready = start();

  return {
    wardSelection: () => current,
    selects,
    search,
    notice,
    contact,
    message,
    retryButton,
    confirmBox,
    confirmYes,
    confirmNo,
    ready,
    setSupport,
    state: () => root.getAttribute('data-state'),
  };
}
