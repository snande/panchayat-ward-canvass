// The search screen: one query box over every loaded ward of the
// constituency, with filter and sort controls (DESIGN.md "Search screen").
//
// It renders from one `state` field, one state at a time:
//   empty     no roll loaded yet: an info notice saying what brings one
//   loading   a roll is being opened: the progress bar and an info notice
//   filled    result rows (.list-row): serial, name, relative, age, gender
//             and house, the matched text in <mark> from the engine's ranges
//   noResults an info notice saying what to change
//   error     an error notice saying what to do, and a line saying whom to
//             call: a "ward/serial" jump (e.g. 3/145) to a voter who is not
//             in the loaded rolls, or an index that could not be built
// setRolls() rebuilds the index (src/search/voterSearch.js) whenever a roll
// finishes loading. The has-number lookup is read from the contact store and
// the not-called lookup from the call list: a consented voter the call list
// hands to a worker counts as called. Tag and visit lookups are Maps keyed by
// voterKey() passed in by the caller; with none, those filters keep everyone.
//
// Voter text reaches the page only as text nodes, never as markup. Nothing
// here writes to any store or makes a network request, so it works offline.

import { buildSearchIndex, searchVoters, parseWardSerial, voterKey } from '../search/voterSearch.js';
import { buildCallList } from '../calls/callList.js';
import { el, textFrom, setNotice } from './dom.js';

export const DEBOUNCE_MS = 50;
export const RESULT_LIMIT = 100;
export const SEARCH_STATES = Object.freeze(['empty', 'loading', 'filled', 'noResults', 'error']);
export const SORT_KEYS = Object.freeze(['relevance', 'serial', 'name', 'age']);

// Copies of src/strings.hi.json entries, used when the caller passes no string
// table; test/voterSearchScreen.test.js fails if they drift.
export const FALLBACK_TEXT = {
  search_label: 'नाम, पिता/पति का नाम, मकान नं. या वार्ड/क्रम (जैसे 3/145) लिखें',
  search_empty: 'खोजने के लिए पहले ऊपर अपना ज़िला, पंचायत और वार्ड चुनकर मतदाता सूची लोड करें।',
  search_loading: 'मतदाता सूची खोज के लिए तैयार हो रही है…',
  search_no_results: 'कोई मतदाता नहीं मिला। नाम की वर्तनी बदलकर देखें या फ़िल्टर हटाएँ।',
  search_jump_missing: 'यह मतदाता लोड की गई सूची में नहीं है। वार्ड और क्रम संख्या जाँचें, या ऊपर वह वार्ड चुनकर उसकी सूची लोड करें।',
  search_failed: 'खोज नहीं चल सकी। पेज फिर से खोलें और दोबारा खोजें।',
  search_error_contact: 'फिर भी न मिले तो अपने समन्वयक से संपर्क करें।',
  search_found: 'मतदाता मिले',
  search_capped: 'केवल सबसे ऊपर के नतीजे दिखाए गए हैं। खोज और सटीक करें।',
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

const byNumber = (a, b) => (Number(a) - Number(b)) || (a < b ? -1 : a > b ? 1 : 0);

/**
 * @param {Element} container the section the screen renders into
 * @param {Record<string,string>|null} strings the Hindi string table
 * @param {{contacts?: {listConsented: (wardKey: string) => Promise<object[]>},
 *   assignments?: {loadAssignments: () => Promise<object>}, tags?: Map, visits?: Map,
 *   support?: string, onRender?: (results: object[]) => void, log?: Function}} [opts]
 */
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
    const input = el(doc, 'input', 'field-input');
    input.setAttribute('type', 'number');
    input.setAttribute('inputmode', 'numeric');
    input.setAttribute('min', '18');
    input.setAttribute('max', '120');
    return field(parent, labelKey, input);
  }
  function choice(parent, labelKey) {
    const row = el(doc, 'label', 'choice search-choice');
    const input = el(doc, 'input', 'choice-input');
    input.setAttribute('type', 'checkbox');
    input.checked = false;
    row.appendChild(input);
    row.appendChild(el(doc, 'span', null, text(labelKey)));
    parent.appendChild(row);
    return input;
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

  const controls = el(doc, 'div', 'search-controls');
  const input = field(controls, 'search_label', el(doc, 'input', 'field-input search-input'));
  input.setAttribute('type', 'search');
  input.setAttribute('inputmode', 'text');
  input.setAttribute('autocomplete', 'off');
  input.setAttribute('spellcheck', 'false');
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
    controls.hidden = next === 'empty' || next === 'loading';
    progress.hidden = next !== 'loading';
    setNotice(message, key ? prefix + text(key) : '', tone);
    message.setAttribute('role', tone === 'error' ? 'alert' : 'status');
    contact.textContent = next === 'error' ? support || text('search_error_contact') : '';
    contact.hidden = next !== 'error';
    count.hidden = next !== 'filled';
    list.hidden = next !== 'filled';
    if (next !== 'filled') list.replaceChildren();
  }

  function filters() {
    const f = {};
    const [kind, value] = place.value ? [place.value[0], place.value.slice(2)] : [];
    if (kind === 'w') f.ward = value;
    if (kind === 'b') f.booth = value;
    if (gender.value) f.gender = gender.value;
    if (String(ageMin.value).trim()) f.ageMin = Number(ageMin.value);
    if (String(ageMax.value).trim()) f.ageMax = Number(ageMax.value);
    if (tags && tag.value) f.tag = { lookup: tags, value: tag.value };
    if (visits && visit.value) f.visit = { lookup: visits, value: visit.value };
    if (hasNumber.checked) f.hasNumber = lookups.hasNumber;
    if (notCalled.checked) f.notCalled = lookups.called;
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

  function render() {
    if (!index) {
      if (loading) show('loading', 'search_loading', 'info');
      else show('empty', 'search_empty', 'info');
      results = [];
    } else {
      const query = input.value || '';
      results = searchVoters(index, query, { filters: filters(), sort: sort.value, limit: RESULT_LIMIT });
      const jump = parseWardSerial(query);
      if (jump && !(results[0] && results[0].jump)) {
        const who = `${text('search_ward')} ${jump.ward}, ${text('search_serial')} ${jump.serial}: `;
        show('error', 'search_jump_missing', 'error', who);
        results = [];
      } else if (!results.length) {
        show('noResults', 'search_no_results', 'info');
      } else {
        show('filled');
        list.replaceChildren(...results.map(renderRow));
        count.textContent = `${results.length} ${text('search_found')}`
          + (results.length >= RESULT_LIMIT ? ` ${text('search_capped')}` : '');
        if (jump) {
          const row = list.children[0];
          row.setAttribute('aria-selected', 'true');
          if (typeof row.scrollIntoView === 'function') row.scrollIntoView({ block: 'center' });
        }
      }
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

  // Has-number and called sets, keyed by voterKey, from the contact store and
  // the call list of every loaded ward.
  async function readLookups(wardKeys) {
    const next = { hasNumber: new Set(), called: new Set() };
    const assigned = opts.assignments ? await opts.assignments.loadAssignments() : {};
    for (const wardKey of wardKeys) {
      const consented = opts.contacts ? await opts.contacts.listConsented(wardKey) : [];
      const ward = wardOfKey(wardKey);
      const withNumber = consented.filter((c) => c && c.phone);
      for (const c of withNumber) next.hasNumber.add(voterKey({ ward, serial: c.serial }));
      for (const row of buildCallList(withNumber, assigned)) {
        if (row.workerId) next.called.add(voterKey({ ward, serial: row.serial }));
      }
    }
    return next;
  }

  /**
   * Rebuild the index over every loaded ward's roll: rolls is a Map (or
   * [wardKey, entries] pairs). Each entry gets its ward number from the ward
   * key; the stored entries are not changed. Resolves once the has-number and
   * not-called lookups are read.
   */
  function setRolls(rolls) {
    const pairs = rolls instanceof Map ? [...rolls] : [...(rolls || [])];
    const mine = ++generation;
    loading = false;
    try {
      const entries = [];
      for (const [wardKey, roll] of pairs) {
        const ward = wardOfKey(wardKey);
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
    render();
    return readLookups(pairs.map(([wardKey]) => wardKey)).then((next) => {
      if (mine !== generation) return results;
      lookups = next;
      return render();
    }, (err) => {
      log('has-number and call lookups could not be read', err);
      return results;
    });
  }

  /** A roll is being opened: show loading until one is there. */
  function setLoading(on) {
    loading = Boolean(on);
    if (!index) render();
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
    root, input, list, message, contact, count, progress,
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
