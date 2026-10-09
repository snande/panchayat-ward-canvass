// The voter route (issue #139): `#/voter/<ward>/<serial>` shows one voter's
// card, the only voter card in the app, from the encrypted store (offline,
// read-only). The ward is looked up in the panchayat of the last stored ward
// key. One `state` at a time (DESIGN.md): loading, empty, error or card, each
// with a back button and the seat line.

import { el, textFrom } from './dom.js';
import { renderVoterCard } from '../card/voterCard.js';
import { loadStored, lastWardKey } from '../roll/rollStore.js';
import { loadSeat, seatLabel } from './seatHeader.js';

export const VOTER_ROUTE_STATES = Object.freeze(['loading', 'empty', 'error', 'card']);

// Copies of src/strings.hi.json entries.
export const FALLBACK_TEXT = {
  voter_route_loading: 'मतदाता की जानकारी खोली जा रही है…',
  voter_route_empty: 'यह मतदाता इस फ़ोन पर लोड सूची में नहीं है। खोज पर वापस जाएँ और वार्ड व क्रम संख्या जाँचें।',
  voter_route_empty_contact: 'फिर भी न मिले तो अपनी टीम के समन्वयक को फ़ोन करें।',
  voter_route_error: 'मतदाता की जानकारी इस फ़ोन पर पढ़ी नहीं जा सकी। फिर से कोशिश करें या खोज पर वापस जाएँ।',
  voter_route_error_contact: 'फिर भी न खुले तो अपनी टीम के समन्वयक को फ़ोन करें।',
  voter_route_back: 'वापस जाएँ',
  seat_header_ward: 'वार्ड',
  roll_progress_label: 'मतदाता सूची लोड हो रही है',
  roll_retry: 'फिर से कोशिश करें',
};

const PREFIX = '#/voter/';
const ROUTE = /^#\/voter\/([^/]+)\/(\d+)\/?$/;

// "03" and "3" are the same ward; the catalogue's ward ids are unpadded.
const wardPart = (value) => (/^\d+$/.test(value) ? String(Number(value)) : value);

/** Whether a hash is a voter address at all, well formed or not. */
export function isVoterHash(hash) {
  return String(hash || '').startsWith(PREFIX);
}

/** "#/voter/3/145" gives { ward: '3', serial: 145 }; anything else null. */
export function parseVoterRoute(hash) {
  const m = ROUTE.exec(String(hash || ''));
  if (!m) return null;
  let ward;
  try {
    ward = decodeURIComponent(m[1]).trim();
  } catch {
    return null;
  }
  if (!ward || ward.includes('/')) return null;
  return { ward: wardPart(ward), serial: Number(m[2]) };
}

/** The hash that opens a voter, e.g. voterRouteHash(3, 145) is "#/voter/3/145". */
export function voterRouteHash(ward, serial) {
  return `${PREFIX}${encodeURIComponent(wardPart(String(ward).trim()))}/${Number(serial)}`;
}

/** The ward key of `ward` in lastKey's panchayat, or null. */
export function resolveWardKey(lastKey, ward) {
  if (typeof lastKey !== 'string') return null;
  const parts = lastKey.split('/');
  if (parts.length !== 4) return null;
  parts[3] = ward;
  return parts.join('/');
}

/** Find the entry with this serial in a stored ward's entries, or null. */
export function findEntry(entries, serial) {
  if (!Array.isArray(entries)) return null;
  return entries.find((entry) => entry && Number(entry.serial) === serial) || null;
}

/** { entry, lastKey }, entry null when not stored; a failed read rejects. */
export async function lookupVoter(store, route) {
  const lastKey = await store.lastWardKey();
  const wardKey = resolveWardKey(lastKey, route.ward);
  if (!wardKey) return { entry: null, lastKey: null };
  return { entry: findEntry(await store.loadStored(wardKey), route.serial), lastKey };
}

/** The voter screen. opts: store, seat, onBack, support, log. */
export function createVoterRouteScreen(container, strings, opts = {}) {
  const doc = container.ownerDocument;
  const text = textFrom(strings, FALLBACK_TEXT);
  const store = opts.store || { loadStored, lastWardKey };
  const seat = opts.seat || (() => loadSeat().seat);
  const log = opts.log || ((...args) => console.error(...args));
  let state = null;
  let support = '';
  // Only the newest open() renders; an older one resolves with the newest.
  let current = 0;
  let latest = Promise.resolve(null);

  const root = el(doc, 'div', 'voter-route');
  root.setAttribute('lang', 'hi');
  const back = el(doc, 'button', 'btn-secondary voter-route-back', text('voter_route_back'));
  back.setAttribute('type', 'button');
  back.addEventListener('click', () => {
    if (typeof opts.onBack === 'function') opts.onBack();
  });
  const where = el(doc, 'p', 'voter-route-seat');
  const body = el(doc, 'div', 'voter-route-body');
  body.setAttribute('aria-live', 'polite');
  root.appendChild(back);
  root.appendChild(where);
  root.appendChild(body);
  container.replaceChildren(root);

  function notice(key, tone, role) {
    const p = el(doc, 'p', 'notice voter-route-message', text(key));
    p.setAttribute('data-tone', tone);
    p.setAttribute('role', role);
    return p;
  }

  function contact(key) {
    return el(doc, 'p', 'voter-route-contact', support || text(key));
  }

  // The seat line (seatLabel) names the panchayat only when the stored seat
  // is the searched roll's; otherwise the ward alone.
  function seatLine(route, lastKey) {
    if (!route) return '';
    let panchayat = '';
    try {
      const s = seat();
      const lastWard = typeof lastKey === 'string' ? lastKey.split('/').pop() : null;
      if (s && typeof s.panchayat === 'string' && lastWard !== null && wardPart(String(s.ward)) === wardPart(lastWard)) {
        panchayat = s.panchayat.trim();
      }
    } catch (err) {
      log('stored seat could not be read', err);
    }
    if (panchayat) return seatLabel({ seatType: 'ward', panchayat, ward: route.ward }, strings || {});
    return `${text('seat_header_ward')}: ${route.ward}`;
  }

  function setState(next, nodes) {
    state = next;
    root.setAttribute('data-state', next);
    if (next === 'loading') root.setAttribute('aria-busy', 'true');
    else root.removeAttribute('aria-busy');
    body.replaceChildren(...nodes);
  }

  function renderLoading() {
    const progress = el(doc, 'div', 'progress');
    progress.setAttribute('role', 'progressbar');
    progress.setAttribute('aria-label', text('roll_progress_label'));
    progress.appendChild(el(doc, 'span', 'progress-bar'));
    return [progress, notice('voter_route_loading', 'info', 'status')];
  }

  function renderEmpty() {
    return [notice('voter_route_empty', 'info', 'status'), contact('voter_route_empty_contact')];
  }

  function renderError(route) {
    const retry = el(doc, 'button', 'btn-secondary voter-route-retry', text('roll_retry'));
    retry.setAttribute('type', 'button');
    retry.addEventListener('click', () => { open(route); });
    return [notice('voter_route_error', 'error', 'alert'), contact('voter_route_error_contact'), retry];
  }

  async function run(route, token) {
    where.textContent = seatLine(route, null);
    if (!route) {
      setState('empty', renderEmpty());
      return state;
    }
    setState('loading', renderLoading());
    let found;
    try {
      found = await lookupVoter(store, route);
    } catch (err) {
      if (token !== current) return latest;
      log('voter could not be read from the stored roll', err);
      setState('error', renderError(route));
      return state;
    }
    if (token !== current) return latest;
    where.textContent = seatLine(route, found.lastKey);
    if (found.entry) {
      // The booth is not stored with the roll yet, so its fields read "—".
      setState('card', [renderVoterCard(found.entry, route.ward, null, doc)]);
    } else {
      setState('empty', renderEmpty());
    }
    return state;
  }

  /** Show `route` (null: empty). Resolves to the newest call's final state. */
  function open(route) {
    const token = ++current;
    latest = run(route, token);
    return latest;
  }

  /** The whom-to-call line of the empty and error states; blank keeps the coordinator line. */
  function setSupport(value) {
    support = typeof value === 'string' ? value.trim() : '';
  }
  setSupport(opts.support);

  return {
    get state() { return state; },
    root,
    open,
    setSupport,
  };
}

/**
 * Follow the hash: on a voter address show the screen and set
 * data-route="voter" on opts.main. Back uses history.back() only when the app
 * itself moved to the address; else it drops the hash with replaceState.
 */
export function startVoterRoute(container, strings, opts) {
  const win = opts.window;
  const main = opts.main || null;
  // Whether the route was entered from another screen of this app.
  let enteredInApp = false;
  const screen = createVoterRouteScreen(container, strings, {
    store: opts.store,
    seat: opts.seat,
    log: opts.log,
    onBack() {
      const history = win.history;
      if (enteredInApp && history && typeof history.back === 'function') {
        history.back();
      } else if (history && typeof history.replaceState === 'function') {
        // No bare "#" left behind; replaceState fires no hashchange, so sync here.
        history.replaceState(null, '', `${win.location.pathname || ''}${win.location.search || ''}`);
        settled = sync();
      } else {
        win.location.hash = '';
      }
    },
  });

  const currentHash = () => (win.location && win.location.hash) || '';
  let lastHash = currentHash();

  function sync() {
    const hash = currentHash();
    lastHash = hash;
    const shown = isVoterHash(hash);
    container.hidden = !shown;
    if (main) {
      if (shown) main.setAttribute('data-route', 'voter');
      else main.removeAttribute('data-route');
    }
    if (!shown) {
      enteredInApp = false;
      return Promise.resolve(null);
    }
    if (typeof container.scrollIntoView === 'function') container.scrollIntoView();
    return screen.open(parseVoterRoute(hash));
  }

  let settled = sync();
  win.addEventListener('hashchange', () => {
    // Moving from one of the app's screens onto a voter: back can return there.
    if (!isVoterHash(lastHash) && isVoterHash(currentHash())) enteredInApp = true;
    settled = sync();
  });
  return { screen, sync, get settled() { return settled; } };
}
