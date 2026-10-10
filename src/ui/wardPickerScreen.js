// The ward picker (DESIGN.md controls): seat type -> district (the index) ->
// panchayat (the district's shard, fetched once chosen; filtered by Hindi or
// Latin name) -> ward; a sarpanch skips the ward step and selects every ward.
// States: loading, empty, error, filled, success. Replacing a loaded roll's
// seat type or panchayat asks first (.alert). Picks go to opts.onSelect.

import { buildSelection, filterPanchayats } from '../picker/catalogue.js';
import { el, setNotice, textFrom } from './dom.js';
import { seatLabel } from './seatHeader.js';

export const PICKER_STEPS = Object.freeze(['seat', 'district', 'panchayat', 'ward']);

const SEATS = [['ward-panch', 'picker_seat_ward_panch'], ['sarpanch', 'picker_seat_sarpanch']];

/** Whether `next` would replace the seat of `loaded` (not just its ward). */
export function replacesSeat(loaded, next) {
  return !loaded || !next || loaded.seatType !== next.seatType
    || !loaded.district || loaded.district.id !== next.district.id
    || !loaded.panchayat || loaded.panchayat.id !== next.panchayat.id;
}

// opts: catalogue ({loadIndex, loadShard}), onSelect, hasLoadedRoll,
// loadedSelection, log.
export function mountWardPicker(container, strings, opts = {}) {
  const doc = container.ownerDocument;
  const text = textFrom(strings, null);
  const { catalogue } = opts;
  let step = 'seat';
  let state = 'filled';
  let seatType = null;
  let index = null;
  let district = null;
  let shard = null;
  let panchayat = null;
  let current = null;
  let pending = null;
  let support = '';
  let errorKind = null;
  let generation = 0;

  const node = (tag, cls, txt, attrs = {}) => {
    const n = el(doc, tag, cls, txt);
    for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
    return n;
  };
  const button = (cls, txt) => node('button', cls, txt, { type: 'button' });
  const add = (parent, ...kids) => kids.forEach((kid) => parent.appendChild(kid));
  const root = node('div', 'ward-picker');
  const heading = node('h2', 'picker-heading', null, { id: 'picker-heading', tabindex: '-1' });
  const filterField = node('div', 'picker-field');
  const filter = node('input', 'field-input picker-filter', null, { id: 'picker-filter', type: 'search', autocomplete: 'off' });
  add(filterField, node('label', 'picker-label', text('picker_filter_label'), { for: 'picker-filter' }), filter);
  const message = node('p', 'notice picker-message', null, { 'aria-live': 'polite' });
  const contact = node('p', 'picker-contact');
  const retry = button('btn-secondary picker-retry', text('roll_retry'));
  const options = node('div', 'picker-options', null, { role: 'list' });
  const confirmBox = node('div', 'alert picker-confirm', null,
    { 'data-tone': 'error', role: 'alertdialog', 'aria-describedby': 'picker-confirm-text' });
  const confirmYes = button('btn-danger picker-confirm-yes', text('picker_confirm_yes'));
  const confirmNo = button('btn-secondary picker-confirm-no', text('picker_confirm_no'));
  add(confirmBox, node('p', null, text('picker_confirm_replace'), { id: 'picker-confirm-text' }), confirmYes, confirmNo);
  const back = button('btn-quiet picker-back', text('picker_back'));
  add(root, heading, filterField, message, contact, retry, options, confirmBox, back);
  container.replaceChildren(root);

  function option({ value, label, meta }) {
    const row = button('list-row picker-option');
    row.setAttribute('data-value', value);
    add(row, el(doc, 'span', 'picker-option-name', label));
    if (meta) add(row, el(doc, 'span', 'picker-option-meta', meta));
    row.addEventListener('click', () => choose(value));
    return row;
  }

  function successText(sel) {
    const sarpanch = sel.seatType === 'sarpanch';
    const seat = { seatType: sarpanch ? 'sarpanch' : 'ward', panchayat: sel.panchayat.name, ward: String(sel.wards[0].ward) };
    return `${text('picker_chosen')} — ${seatLabel(seat, strings || {})}${sarpanch ? ` (${sel.wards.length})` : ''}`;
  }

  // The step's options; [] while they are not known.
  function items() {
    if (step === 'seat') return SEATS.map(([value, key]) => ({ value, label: text(key), meta: text(`${key}_hint`) }));
    if (step === 'district') return index ? index.districts.map((d) => ({ value: d.id, label: d.name })) : [];
    if (step === 'panchayat') {
      return shard ? filterPanchayats(shard.panchayats, filter.value)
        .map((p) => ({ value: p.id, label: p.name, meta: `${p.block.name} ${text('picker_samiti')}` })) : [];
    }
    return panchayat ? panchayat.wards.map((w) => ({ value: String(w.ward), label: `${text('picker_ward')} ${w.ward}` })) : [];
  }

  function noticeText() {
    if (state === 'loading') return text('picker_loading');
    if (state === 'error') return text(errorKind === 'version' ? 'picker_version_unsupported' : 'picker_fetch_failed');
    if (state === 'success') return successText(current);
    if (state !== 'empty') return '';
    if (step === 'panchayat') return text(shard && shard.panchayats.length ? 'picker_filter_empty' : 'picker_panchayats_empty');
    return text(step === 'district' ? 'picker_districts_empty' : 'picker_wards_empty');
  }

  function render() {
    const list = state === 'loading' || state === 'error' ? [] : items();
    if (state === 'filled' || state === 'empty') state = list.length ? 'filled' : 'empty';
    root.setAttribute('data-step', step);
    root.setAttribute('data-state', state);
    heading.textContent = text(`picker_${step}_prompt`);
    filterField.hidden = step !== 'panchayat' || !shard || shard.panchayats.length === 0;
    setNotice(message, noticeText(), { error: 'error', success: 'success' }[state] || 'info');
    message.hidden = !message.textContent;
    if (state === 'error') message.setAttribute('role', 'alert');
    else message.removeAttribute('role');
    contact.textContent = support || text('picker_error_contact');
    contact.hidden = state !== 'error';
    // An unsupported catalogue cannot be fixed by fetching it again.
    retry.hidden = state !== 'error' || errorKind === 'version';
    options.replaceChildren(...list.map(option));
    options.hidden = list.length === 0;
    confirmBox.hidden = !pending;
    back.hidden = step === 'seat';
  }

  // Loads what the step lists; a result for a step since left is dropped.
  function load() {
    const mine = ++generation;
    errorKind = null;
    const read = step === 'district' ? catalogue.loadIndex() : step === 'panchayat' ? catalogue.loadShard(district) : null;
    state = read ? 'loading' : 'filled';
    render();
    if (!read) return;
    read.then((got) => {
      if (mine !== generation) return;
      if (step === 'district') index = got;
      else shard = got;
      state = 'filled';
      render();
    }, (err) => {
      if (mine !== generation) return;
      errorKind = err && err.kind === 'version' ? 'version' : 'network';
      state = 'error';
      if (opts.log) opts.log('ward catalogue could not be read', err);
      render();
    });
  }

  function go(next) {
    step = next;
    pending = null;
    // A list already read shows at once; going back never refetches it.
    if ((next === 'district' && index) || (next === 'panchayat' && shard)) {
      generation += 1;
      state = 'filled';
      render();
    } else {
      load();
    }
  }

  function commit(selection) {
    pending = null;
    current = selection;
    state = 'success';
    render();
    if (opts.onSelect) opts.onSelect(selection);
  }

  function offer(selection) {
    if (!selection) return;
    const loaded = (opts.loadedSelection && opts.loadedSelection()) || current;
    if (opts.hasLoadedRoll && opts.hasLoadedRoll() && replacesSeat(loaded, selection)) {
      pending = selection;
      render();
    } else {
      commit(selection);
    }
  }

  function choose(value) {
    if (step === 'seat') {
      seatType = value;
      go('district');
    } else if (step === 'district') {
      const next = index && index.districts.find((d) => d.id === value);
      if (!next) return;
      if (!district || district.id !== next.id) {
        district = next;
        shard = null;
        panchayat = null;
        filter.value = '';
      }
      go('panchayat');
    } else if (step === 'panchayat') {
      panchayat = (shard && shard.panchayats.find((p) => p.id === value)) || null;
      if (!panchayat) return;
      if (seatType === 'sarpanch') offer(buildSelection('sarpanch', district, panchayat));
      else go('ward');
    } else {
      offer(buildSelection('ward-panch', district, panchayat, Number(value)));
    }
  }

  filter.addEventListener('input', () => {
    if (step !== 'panchayat' || !shard) return;
    if (state !== 'success') state = 'filled';
    render();
  });
  retry.addEventListener('click', load);
  back.addEventListener('click', () => {
    if (step !== 'seat') go(PICKER_STEPS[PICKER_STEPS.indexOf(step) - 1]);
  });
  confirmYes.addEventListener('click', () => pending && commit(pending));
  confirmNo.addEventListener('click', () => {
    pending = null;
    render();
  });

  // The index is all the first open fetches; shards wait for their district.
  catalogue.loadIndex().then((got) => { index = got; }, () => {});
  render();

  return {
    root, heading, filter, options, message, contact, confirmBox, confirmYes, confirmNo,
    retryButton: retry,
    backButton: back,
    get step() { return step; },
    get state() { return state; },
    wardSelection: () => current,
    /** Whom to call when the catalogue will not load. */
    setSupport(value) {
      support = typeof value === 'string' ? value.trim() : '';
      render();
    },
  };
}
