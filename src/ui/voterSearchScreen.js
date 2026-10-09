// The search screen over every loaded ward (DESIGN.md "Search screen"), one
// `state` at a time: empty (no roll), loading (a roll opening, or a ticked
// has-number/not-called box waiting for its lookup), filled (rows with the
// match in <mark> from the engine's ranges), noResults, and error (what to do
// and whom to call: a ward/serial jump to a voter not loaded or filtered out,
// an inverted age range, an index that could not be built).
// setRolls() rebuilds the index (src/search/voterSearch.js) when a roll loads.
// Has-number comes from the contact store, not-called from the call list (a
// consented voter it hands to a worker counts as called). Tag and visit are
// Maps keyed by voterKey(); with none, those filters keep everyone.
// Voter text is only ever text nodes. No store writes, no network.

import {
  buildSearchIndex, searchVoters, parseWardSerial, voterKey, toAsciiDigits,
} from '../search/voterSearch.js';
import { buildCallList } from '../calls/callList.js';
import { el, textFrom, setNotice } from './dom.js';

export const DEBOUNCE_MS = 50;
export const RESULT_LIMIT = 100;
export const SEARCH_STATES = Object.freeze(['empty', 'loading', 'filled', 'noResults', 'error']);
export const SORT_KEYS = Object.freeze(['relevance', 'serial', 'name', 'age']);

// Copies of src/strings.hi.json entries, used when the caller passes no string
// table; test/voterSearchScreen.test.js fails if they drift.
export const FALLBACK_TEXT = {
  search_label: 'नाम, मकान नं. या वार्ड/क्रम (जैसे 3/145) लिखें',
  search_empty: 'खोजने के लिए पहले ऊपर वार्ड चुनकर मतदाता सूची लोड करें।',
  search_loading: 'खोज के लिए सूची तैयार हो रही है…',
  search_lookups_loading: 'नंबर और कॉल की जानकारी पढ़ी जा रही है…',
  search_lookups_failed: 'नंबर और कॉल की जानकारी नहीं पढ़ी जा सकी, ये दो फ़िल्टर बंद हैं। पेज फिर खोलें; न चले तो समन्वयक से संपर्क करें।',
  search_no_results: 'कोई मतदाता नहीं मिला। वर्तनी बदलें या फ़िल्टर हटाएँ।',
  search_jump_missing: 'यह मतदाता लोड सूची में नहीं है। वार्ड और क्रम जाँचें, या ऊपर वह वार्ड लोड करें।',
  search_jump_filtered: 'यह मतदाता फ़िल्टर से छिपा है। फ़िल्टर हटाकर फिर खोजें।',
  search_age_inverted: 'कम से कम उम्र, अधिक से अधिक उम्र से बड़ी नहीं हो सकती। उम्र ठीक करें।',
  search_failed: 'खोज नहीं चल सकी। पेज फिर खोलकर दोबारा खोजें।',
  search_error_contact: 'फिर भी न मिले तो अपने समन्वयक से संपर्क करें।',
  search_found: 'मतदाता मिले',
  search_capped: 'केवल ऊपर के नतीजे दिखे हैं। खोज और सटीक करें।',
  search_results_label: 'खोज के नतीजे',
  search_filter_place: 'वार्ड / बूथ',
  search_filter_gender: 'लिंग',
  search_age_min: 'कम से कम उम्र',
  search_age_max: 'अधिक से अधिक उम्र',
  search_filter_tag: 'टैग',
  search_filter_visit: 'संपर्क की स्थिति',
  search_has_number: 'केवल जिनका फ़ोन नंबर है',
  search_not_called: 'केवल जिन्हें अभी कॉल नहीं हुई',
  search_sort: 'क्रम से दिखाएँ',
  search_sort_relevance: 'सबसे मिलते-जुलते',
  search_sort_serial: 'क्रम संख्या',
  search_sort_name: 'नाम',
  search_sort_age: 'उम्र',
  search_all: 'सभी',
  search_ward: 'वार्ड',
  search_booth: 'बूथ',
  search_serial: 'क्रम',
  roll_age: 'उम्र',
  roll_house: 'मकान नं.',
  roll_progress_label: 'मतदाता सूची लोड हो रही है',
};

/** The ward number of a ward key ("district/samiti/panchayat/ward"). */
export function wardOfKey(wardKey) {
  return String(wardKey).split('/').pop();
}

// The distinct values of a lookup (Map or object; a value may be a list).
function lookupValues(lookup) {
  const out = new Set();
  const all = lookup instanceof Map ? [...lookup.values()] : Object.values(lookup || {});
  for (const v of all) {
    for (const one of Array.isArray(v) || v instanceof Set ? v : [v]) {
      if (one !== undefined && one !== null && one !== '') out.add(String(one));
    }
  }
  return [...out].sort();
}

// A typed age, or null when the box is blank or holds no number.
function ageValue(node) {
  const s = toAsciiDigits(String(node.value ?? '')).trim();
  const n = s ? Number(s) : NaN;
  return Number.isFinite(n) ? n : null;
}

const byNumber = (a, b) => (Number(a) - Number(b)) || (a < b ? -1 : a > b ? 1 : 0);

// Has-number and called sets, keyed by voterKey, for the given ward keys.
export async function readLookups(wardKeys, { contacts, assignments } = {}) {
  const next = { hasNumber: new Set(), called: new Set() };
  const assigned = assignments ? await assignments.loadAssignments() : {};
  const perWard = [];
  const wardsOfSerial = new Map();
  for (const wardKey of wardKeys) {
    const consented = contacts ? await contacts.listConsented(wardKey) : [];
    const withNumber = (consented || []).filter((c) => c && c.phone);
    perWard.push([wardOfKey(wardKey), withNumber]);
    for (const c of withNumber) wardsOfSerial.set(String(c.serial), (wardsOfSerial.get(String(c.serial)) || 0) + 1);
  }
  for (const [ward, withNumber] of perWard) {
    for (const c of withNumber) next.hasNumber.add(voterKey({ ward, serial: c.serial }));
    for (const row of buildCallList(withNumber, assigned)) {
      // An assignment names no ward: keep it only where its serial is unambiguous.
      if (row.workerId && wardsOfSerial.get(String(row.serial)) === 1) {
        next.called.add(voterKey({ ward, serial: row.serial }));
      }
    }
  }
  return next;
}

// opts: contacts {listConsented}, assignments {loadAssignments}, tags, visits,
// support (whom to call), onRender(results), log.
export function createVoterSearchScreen(container, strings, opts = {}) {
  const doc = container.ownerDocument;
  const text = textFrom(strings, FALLBACK_TEXT);
  const log = opts.log || ((...args) => console.error(...args));
  let state = null;
  let index = null;
  let support = '';
  let loading = false;
  let results = [];
  let tags = opts.tags || null;
  let visits = opts.visits || null;
  let lookups = { hasNumber: new Set(), called: new Set() };
  let lookupsPending = false;
  let lookupsFailed = false;
  let generation = 0;

  const root = el(doc, 'section', 'search-screen');
  root.setAttribute('lang', 'hi');

  function field(parent, labelKey, control) {
    const wrap = el(doc, 'label', 'picker-field search-field');
    wrap.appendChild(el(doc, 'span', 'picker-label', text(labelKey)));
    wrap.appendChild(control);
    parent.appendChild(wrap);
    return control;
  }
  function select(parent, labelKey) {
    return field(parent, labelKey, el(doc, 'select', 'field-select'));
  }
  function numberInput(parent, labelKey) {
    const node = el(doc, 'input', 'field-input');
    node.setAttribute('type', 'number');
    node.setAttribute('inputmode', 'numeric');
    node.setAttribute('min', '18');
    node.setAttribute('max', '120');
    return field(parent, labelKey, node);
  }
  function choice(parent, labelKey) {
    const row = el(doc, 'label', 'choice search-choice');
    const node = el(doc, 'input', 'choice-input');
    node.setAttribute('type', 'checkbox');
    node.checked = false;
    row.appendChild(node);
    row.appendChild(el(doc, 'span', null, text(labelKey)));
    parent.appendChild(row);
    return node;
  }
  function setOptions(node, values) {
    const keep = node.value;
    const all = el(doc, 'option', null, text('search_all'));
    all.setAttribute('value', '');
    node.replaceChildren(all, ...values.map(([value, label]) => {
      const option = el(doc, 'option', null, label);
      option.setAttribute('value', value);
      return option;
    }));
    node.value = values.some(([value]) => value === keep) ? keep : '';
    node.disabled = values.length === 0;
  }

  // The query box stays on screen in every state (disabled until a roll is
  // there); the filters show once there is something to filter.
  const input = field(root, 'search_label', el(doc, 'input', 'field-input search-input'));
  input.setAttribute('type', 'search');
  input.setAttribute('inputmode', 'text');
  input.setAttribute('autocomplete', 'off');
  input.setAttribute('spellcheck', 'false');
  const controls = el(doc, 'div', 'search-controls');
  const filtersBox = el(doc, 'div', 'search-filters');
  const place = select(filtersBox, 'search_filter_place');
  const gender = select(filtersBox, 'search_filter_gender');
  const ageMin = numberInput(filtersBox, 'search_age_min');
  const ageMax = numberInput(filtersBox, 'search_age_max');
  const tag = select(filtersBox, 'search_filter_tag');
  const visit = select(filtersBox, 'search_filter_visit');
  const sort = select(filtersBox, 'search_sort');
  sort.replaceChildren(...SORT_KEYS.map((key) => {
    const option = el(doc, 'option', null, text(`search_sort_${key}`));
    option.setAttribute('value', key);
    return option;
  }));
  sort.value = 'relevance';
  controls.appendChild(filtersBox);
  const hasNumber = choice(controls, 'search_has_number');
  const notCalled = choice(controls, 'search_not_called');
  const lookupNote = el(doc, 'p', 'search-contact search-lookup-note', text('search_lookups_failed'));
  lookupNote.hidden = true;
  controls.appendChild(lookupNote);

  const progress = el(doc, 'div', 'progress');
  progress.setAttribute('role', 'progressbar');
  progress.setAttribute('aria-label', text('roll_progress_label'));
  progress.appendChild(el(doc, 'span', 'progress-bar'));
  const message = el(doc, 'p', 'notice search-message');
  const contact = el(doc, 'p', 'search-contact');
  const count = el(doc, 'p', 'search-count');
  count.setAttribute('role', 'status');
  const list = el(doc, 'ul', 'search-results');
  list.setAttribute('role', 'listbox');
  list.setAttribute('aria-label', text('search_results_label'));
  for (const node of [controls, progress, message, contact, count, list]) root.appendChild(node);
  container.replaceChildren(root);

  function show(next, key, tone, prefix = '') {
    state = next;
    root.setAttribute('data-state', next);
    input.disabled = !index;
    controls.hidden = !index;
    progress.hidden = next !== 'loading';
    setNotice(message, key ? prefix + text(key) : '', tone);
    message.setAttribute('role', tone === 'error' ? 'alert' : 'status');
    contact.textContent = next === 'error' ? support || text('search_error_contact') : '';
    contact.hidden = next !== 'error';
    count.hidden = next !== 'filled';
    list.hidden = next !== 'filled';
    if (next !== 'filled') list.replaceChildren();
  }

  function filters(age) {
    const f = {};
    const [kind, value, extra] = String(place.value || '').split(':');
    if (value && extra === undefined && kind === 'w') f.ward = value;
    if (value && extra === undefined && kind === 'b') f.booth = value;
    if (gender.value) f.gender = gender.value;
    if (age.min !== null) f.ageMin = age.min;
    if (age.max !== null) f.ageMax = age.max;
    if (tags && tag.value) f.tag = { lookup: tags, value: tag.value };
    if (visits && visit.value) f.visit = { lookup: visits, value: visit.value };
    if (hasNumber.checked && !lookupsFailed) f.hasNumber = lookups.hasNumber;
    if (notCalled.checked && !lookupsFailed) f.notCalled = lookups.called;
    return f;
  }

  // The field's text with each range wrapped in <mark>, as text nodes.
  function marked(value, ranges) {
    const str = value == null ? '' : String(value);
    const frag = doc.createDocumentFragment();
    let at = 0;
    for (const { start, end } of ranges || []) {
      if (start > at) frag.appendChild(doc.createTextNode(str.slice(at, start)));
      const mark = doc.createElement('mark');
      mark.appendChild(doc.createTextNode(str.slice(start, end)));
      frag.appendChild(mark);
      at = end;
    }
    if (at < str.length) frag.appendChild(doc.createTextNode(str.slice(at)));
    return frag;
  }

  function part(parent, className, prefix, value, ranges) {
    const span = el(doc, 'span', className, prefix);
    span.appendChild(marked(value, ranges));
    parent.appendChild(span);
  }

  function renderRow(result) {
    const { entry, field: hit, ranges } = result;
    const at = (name) => (hit === name ? ranges : null);
    const row = el(doc, 'li', 'list-row search-row');
    row.setAttribute('role', 'option');
    row.setAttribute('data-key', result.key);
    const head = el(doc, 'span', 'search-row-head');
    part(head, 'search-serial', `${entry.ward}/`, entry.serial, at('serial'));
    part(head, 'search-name', '', entry.name, at('name'));
    row.appendChild(head);
    const meta = el(doc, 'span', 'search-row-meta');
    part(meta, 'search-relative', '', entry.relative, at('relative'));
    part(meta, 'search-age', `${text('roll_age')} `, entry.age ?? '—', null);
    part(meta, 'search-gender', '', entry.gender || '—', null);
    part(meta, 'search-house', `${text('roll_house')} `, entry.house, at('house'));
    row.appendChild(meta);
    return row;
  }

  function search() {
    const age = { min: ageValue(ageMin), max: ageValue(ageMax) };
    if (age.min !== null && age.max !== null && age.min > age.max) {
      show('error', 'search_age_inverted', 'error');
      return [];
    }
    const query = input.value || '';
    const found = searchVoters(index, query, { filters: filters(age), sort: sort.value, limit: RESULT_LIMIT });
    const jump = parseWardSerial(query);
    const target = jump ? `${jump.ward}:${jump.serial}` : null;
    const at = target ? found.findIndex((r) => r.key === target) : -1;
    if (target && at < 0) {
      // Loaded but not listed means a filter hides the voter.
      const key = index.byKey.has(target) ? 'search_jump_filtered' : 'search_jump_missing';
      show('error', key, 'error', `${text('search_ward')} ${jump.ward}, ${text('search_serial')} ${jump.serial}: `);
      return [];
    }
    if (!found.length) {
      show('noResults', 'search_no_results', 'info');
      return found;
    }
    show('filled');
    const rows = found.map(renderRow);
    list.replaceChildren(...rows);
    count.textContent = `${found.length} ${text('search_found')}`
      + (found.length >= RESULT_LIMIT ? ` ${text('search_capped')}` : '');
    if (at >= 0) {
      rows[at].setAttribute('aria-selected', 'true');
      if (typeof rows[at].scrollIntoView === 'function') rows[at].scrollIntoView({ block: 'center' });
    }
    return found;
  }

  function render() {
    hasNumber.disabled = lookupsFailed;
    notCalled.disabled = lookupsFailed;
    lookupNote.hidden = !lookupsFailed;
    if (!index) {
      if (loading) show('loading', 'search_loading', 'info');
      else show('empty', 'search_empty', 'info');
      results = [];
    } else if (loading) {
      show('loading', 'search_loading', 'info');
      results = [];
    } else if (lookupsPending && (hasNumber.checked || notCalled.checked)) {
      // A ticked box waits for its lookup rather than filtering on old sets.
      show('loading', 'search_lookups_loading', 'info');
      results = [];
    } else {
      results = search();
    }
    if (typeof opts.onRender === 'function') opts.onRender(results);
    return results;
  }

  let timer = null;
  function later() {
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      render();
    }, DEBOUNCE_MS);
  }
  const typed = [input, ageMin, ageMax];
  const picked = [place, gender, tag, visit, sort, hasNumber, notCalled];
  for (const node of typed) node.addEventListener('input', later);
  for (const node of picked) node.addEventListener('change', render);

  function refreshOptions(entries) {
    const wards = new Set();
    const booths = new Set();
    const genders = new Set();
    for (const e of entries) {
      if (e.ward !== undefined && e.ward !== '') wards.add(String(e.ward));
      if (e.booth !== undefined && e.booth !== null && e.booth !== '') booths.add(String(e.booth));
      if (e.gender) genders.add(String(e.gender));
    }
    setOptions(place, [
      ...[...wards].sort(byNumber).map((w) => [`w:${w}`, `${text('search_ward')} ${w}`]),
      ...[...booths].sort(byNumber).map((b) => [`b:${b}`, `${text('search_booth')} ${b}`]),
    ]);
    setOptions(gender, [...genders].sort().map((g) => [g, g]));
    setOptions(tag, tags ? lookupValues(tags).map((v) => [v, v]) : []);
    setOptions(visit, visits ? lookupValues(visits).map((v) => [v, v]) : []);
  }

  // Rebuild the index over every loaded roll (a Map or [wardKey, entries]
  // pairs; entries are copied, never changed) and end loading. Resolves once
  // the lookups are read; a later call wins over an earlier, slower one.
  function setRolls(rolls) {
    const pairs = rolls instanceof Map ? [...rolls] : [...(rolls || [])];
    const mine = ++generation;
    loading = false;
    try {
      const entries = [];
      const keyOfWard = new Map();
      for (const [wardKey, roll] of pairs) {
        const ward = wardOfKey(wardKey);
        // The engine keys voters by ward number and serial only.
        if (keyOfWard.has(ward)) log(`search: wards ${keyOfWard.get(ward)} and ${wardKey} share number ${ward}`);
        keyOfWard.set(ward, wardKey);
        for (const entry of roll || []) entries.push({ ...entry, ward: entry.ward ?? ward });
      }
      index = entries.length ? buildSearchIndex(entries) : null;
      refreshOptions(entries);
    } catch (err) {
      log('search index could not be built', err);
      index = null;
      show('error', 'search_failed', 'error');
      return Promise.resolve([]);
    }
    lookupsPending = true;
    render();
    return readLookups(pairs.map(([wardKey]) => wardKey), opts).then((next) => {
      if (mine !== generation) return results;
      lookups = next;
      lookupsPending = false;
      lookupsFailed = false;
      return render();
    }, (err) => {
      if (mine !== generation) return results;
      log('has-number and call lookups could not be read', err);
      lookupsPending = false;
      lookupsFailed = true;
      hasNumber.checked = false;
      notCalled.checked = false;
      return render();
    });
  }

  // A roll is opening (true), or opening ended with no new roll (false):
  // loading shows over earlier results until setRolls() or setLoading(false).
  function setLoading(on) {
    if (loading === Boolean(on)) return;
    loading = Boolean(on);
    render();
  }

  /** Tag and visit lookups (Maps keyed by voterKey); null keeps everyone. */
  function setLookups(next = {}) {
    if ('tags' in next) tags = next.tags || null;
    if ('visits' in next) visits = next.visits || null;
    setOptions(tag, tags ? lookupValues(tags).map((v) => [v, v]) : []);
    setOptions(visit, visits ? lookupValues(visits).map((v) => [v, v]) : []);
    return render();
  }

  /** The whom-to-call line of the error state; blank keeps the neutral line. */
  function setSupport(value) {
    support = typeof value === 'string' ? value.trim() : '';
    if (state === 'error') contact.textContent = support || text('search_error_contact');
  }
  setSupport(opts.support);
  render();

  return {
    root, input, list, message, contact, count, progress, lookupNote,
    controls: { place, gender, ageMin, ageMax, tag, visit, sort, hasNumber, notCalled },
    get state() { return state; },
    get results() { return results; },
    setRolls, setLoading, setLookups, setSupport, render,
    destroy() {
      if (timer !== null) clearTimeout(timer);
      timer = null;
      generation += 1;
      for (const node of typed) node.removeEventListener('input', later);
      for (const node of picked) node.removeEventListener('change', render);
      if (root.parentNode === container) container.removeChild(root);
    },
  };
}
