// The navigation frame around every screen (DESIGN.md "Navigation bar").
//
// index.html holds the frame's four slots, found by id (FRAME_SLOTS):
//   header  #seat-header, filled by src/ui/seatHeader.js, not by the frame
//   main    #app, where the screens render
//   nav     #nav-bar, the bottom navigation bar this module renders
//   footer  #sec-footer, filled by src/ui/secFooter.js, not by the frame
// The nav bar has one .nav-item button per screen (SCREENS); the ward roll is
// the default screen. Tapping an entry calls opts.onNavigate(id); the entry
// becomes the current one (aria-current="page") unless onNavigate returns
// false, e.g. because the screen needs a loaded roll and the user was sent to
// the ward picker instead.

import { el } from './dom.js';

export const FRAME_SLOTS = Object.freeze({ header: 'seat-header', main: 'app', nav: 'nav-bar', footer: 'sec-footer' });

// Every existing screen: the ward roll, and the call list, polling-day count
// and SMS tally that open over a loaded roll (src/ui/rollSearch.js).
export const SCREENS = Object.freeze([
  { id: 'roll', key: 'nav_roll' },
  { id: 'calls', key: 'nav_calls' },
  { id: 'turnout', key: 'nav_turnout' },
  { id: 'sms', key: 'nav_sms' },
]);
export const DEFAULT_SCREEN = 'roll';

// Copies of src/strings.hi.json entries, used when the caller passes no string
// table; test/appFrame.test.js fails if they drift.
export const FALLBACK_TEXT = {
  nav_label: 'मुख्य मेनू',
  nav_roll: 'मतदाता सूची',
  nav_calls: 'कॉल सूची',
  nav_turnout: 'मतदान दिवस',
  nav_sms: 'एसएमएस गिनती',
};

/**
 * Render the nav bar into its slot (replacing its content).
 * @param {Element} nav the #nav-bar slot
 * @param {Record<string,string>|null} strings the Hindi string table
 * @param {{onNavigate?: (id: string) => boolean|void}} [opts]
 * @returns {{nav: Element, items: Map<string, Element>, current: () => string, select: (id: string) => void}}
 */
export function mountAppFrame(nav, strings, opts = {}) {
  const doc = nav.ownerDocument;
  const has = (key) => Boolean(strings) && Object.prototype.hasOwnProperty.call(strings, key) && strings[key];
  const text = (key) => (has(key) ? strings[key] : FALLBACK_TEXT[key]);
  const items = new Map();
  let current = DEFAULT_SCREEN;

  nav.setAttribute('aria-label', text('nav_label'));
  const list = el(doc, 'div', 'nav-bar-items');
  for (const screen of SCREENS) {
    const item = el(doc, 'button', 'nav-item', text(screen.key));
    item.setAttribute('type', 'button');
    item.setAttribute('data-screen', screen.id);
    item.addEventListener('click', () => {
      const moved = typeof opts.onNavigate === 'function' ? opts.onNavigate(screen.id) : true;
      if (moved !== false) select(screen.id);
    });
    items.set(screen.id, item);
    list.appendChild(item);
  }
  nav.replaceChildren(list);

  function select(id) {
    if (!items.has(id)) return;
    current = id;
    for (const [itemId, item] of items) {
      if (itemId === id) item.setAttribute('aria-current', 'page');
      else item.removeAttribute('aria-current');
    }
  }
  select(DEFAULT_SCREEN);

  return { nav, items, current: () => current, select };
}
