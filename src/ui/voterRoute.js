// The voter route (issue #139): `#/voter/<ward>/<serial>` shows one voter's
// card, the same card wherever the voter is opened from. js/app.js starts it;
// it is the only caller of renderVoterCard() (src/card/voterCard.js).
//
// The ward is one of the loaded panchayat's: the last stored ward key
// ("district/samiti/panchayat/ward", src/roll/rollStore.js) with the route's
// ward swapped in. Entries come from the encrypted store on the phone, so it
// works offline with no network request, and it writes nothing.
//
// One `state` at a time (DESIGN.md): loading (progress bar, info notice),
// empty (not stored: go back to search, call the coordinator), error (read or
// decryption failed: what to do, whom to call, retry) or card. Every state has
// a back button and a panchayat and ward line; the seat header and SEC footer
// sit outside #app and stay.

import { el, textFrom } from './dom.js';
import { renderVoterCard } from '../card/voterCard.js';
import { loadStored, lastWardKey } from '../roll/rollStore.js';
import { loadSeat } from './seatHeader.js';

export const VOTER_ROUTE_STATES = Object.freeze(['loading', 'empty', 'error', 'card']);

// Copies of src/strings.hi.json entries, for when no table is passed.
export const FALLBACK_TEXT = {
  voter_route_loading: 'मतदाता की जानकारी खोली जा रही है…',
  voter_route_empty: 'यह मतदाता इस फ़ोन पर लोड सूची में नहीं है। खोज पर वापस जाएँ और वार्ड व क्रम संख्या जाँचें।',
  voter_route_empty_contact: 'फिर भी न मिले तो अपनी टीम के समन्वयक को फ़ोन करें।',
  voter_route_error: 'मतदाता की जानकारी इस फ़ोन पर पढ़ी नहीं जा सकी। फिर से कोशिश करें या खोज पर वापस जाएँ।',
  voter_route_error_contact: 'फिर भी न खुले तो अपनी टीम के समन्वयक को फ़ोन करें।',
  voter_route_back: 'वापस जाएँ',
  voter_route_panchayat: 'पंचायत',
  voter_route_ward: 'वार्ड',
  roll_progress_label: 'मतदाता सूची लोड हो रही है',
  roll_retry: 'फिर से कोशिश करें',
};

const ROUTE = /^#\/voter\/([^/]+)\/(\d+)\/?$/;

// "03" and "3" are the same ward; the catalogue's ward ids are unpadded.
const wardPart = (value) => (/^\d+$/.test(value) ? String(Number(value)) : value);

/**
 * Parse a location hash: "#/voter/3/145" gives { ward: '3', serial: 145 }.
 * Anything else (another route, a missing or non-numeric serial) gives null.
 */
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
  return `#/voter/${encodeURIComponent(wardPart(String(ward).trim()))}/${Number(serial)}`;
}

/**
 * The ward key of `ward` in the panchayat of the last stored ward key, or null
 * when no roll is stored.
 */
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

/**
 * Read one voter from the store: { entry } when found, { entry: null } when
 * the ward or serial is not stored. A failed read or decryption rejects.
 * @param {{loadStored: Function, lastWardKey: Function}} store
 */
export async function lookupVoter(store, route) {
  const wardKey = resolveWardKey(await store.lastWardKey(), route.ward);
  if (!wardKey) return { entry: null };
  return { entry: findEntry(await store.loadStored(wardKey), route.serial) };
}

/**
 * The voter screen, rendered into container.
 * @param {Element} container the #voter-route section
 * @param {Record<string,string>|null} strings the Hindi string table
 * @param {{store?: {loadStored, lastWardKey}, seat?: () => object|null,
 *   onBack?: () => void, support?: string, log?: Function}} [opts]
 * @returns {{state: string|null, root: Element, open: (route: {ward: string, serial: number}) => Promise<string>,
 *   setSupport: (text: string) => void}}
 */
export function createVoterRouteScreen(container, strings, opts = {}) {
  const doc = container.ownerDocument;
  const text = textFrom(strings, FALLBACK_TEXT);
  const store = opts.store || { loadStored, lastWardKey };
  const seat = opts.seat || (() => loadSeat().seat);
  const log = opts.log || ((...args) => console.error(...args));
  let state = null;
  let support = '';
  // Only the newest open() renders.
  let current = 0;

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

  // "पंचायत: बडली · वार्ड: 3": the loaded panchayat and the route's ward.
  function seatLine(route) {
    let panchayat = '';
    try {
      const s = seat();
      if (s && typeof s.panchayat === 'string') panchayat = s.panchayat.trim();
    } catch (err) {
      log('stored seat could not be read', err);
    }
    const ward = `${text('voter_route_ward')}: ${route.ward}`;
    return panchayat ? `${text('voter_route_panchayat')}: ${panchayat} · ${ward}` : ward;
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

  function renderError(route) {
    const retry = el(doc, 'button', 'btn-secondary voter-route-retry', text('roll_retry'));
    retry.setAttribute('type', 'button');
    retry.addEventListener('click', () => { open(route); });
    return [notice('voter_route_error', 'error', 'alert'), contact('voter_route_error_contact'), retry];
  }

  /** Show the voter `route` names: loading, then card, empty or error. Resolves to the final state. */
  async function open(route) {
    const token = ++current;
    where.textContent = seatLine(route);
    setState('loading', renderLoading());
    let found;
    try {
      found = await lookupVoter(store, route);
    } catch (err) {
      if (token !== current) return state;
      log('voter could not be read from the stored roll', err);
      setState('error', renderError(route));
      return state;
    }
    if (token !== current) return state;
    if (found.entry) {
      // The booth is not stored with the roll yet, so its fields read "—".
      setState('card', [renderVoterCard(found.entry, route.ward, null, doc)]);
    } else {
      setState('empty', [notice('voter_route_empty', 'info', 'status'), contact('voter_route_empty_contact')]);
    }
    return state;
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
 * Follow the location hash: while it is a voter route, show the screen in
 * container and mark opts.main (#app) with data-route="voter" so styles.css
 * hides the other screens; any other hash hides it again and leaves the other
 * screens as they were. Back goes to the screen the voter was opened from
 * (history.back()); with no history it clears the hash.
 * @param {Element} container the #voter-route section
 * @param {Record<string,string>|null} strings
 * @param {{window: Window, main?: Element, store?: object, seat?: Function, log?: Function}} opts
 * @returns {{screen: object, sync: () => Promise<string|null>, settled: Promise<string|null>}}
 *   settled resolves to the state the latest hash ended in (null off the route)
 */
export function startVoterRoute(container, strings, opts) {
  const win = opts.window;
  const main = opts.main || null;
  const screen = createVoterRouteScreen(container, strings, {
    store: opts.store,
    seat: opts.seat,
    log: opts.log,
    onBack() {
      const history = win.history;
      if (history && history.length > 1 && typeof history.back === 'function') history.back();
      else win.location.hash = '';
    },
  });

  function sync() {
    const route = parseVoterRoute(win.location && win.location.hash);
    container.hidden = !route;
    if (main) {
      if (route) main.setAttribute('data-route', 'voter');
      else main.removeAttribute('data-route');
    }
    if (!route) return Promise.resolve(null);
    if (typeof container.scrollIntoView === 'function') container.scrollIntoView();
    return screen.open(route);
  }

  let settled = sync();
  win.addEventListener('hashchange', () => { settled = sync(); });
  return { screen, sync, get settled() { return settled; } };
}
