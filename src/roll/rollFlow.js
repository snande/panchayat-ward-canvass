// Ward pick -> roll on screen.
//
// open(selection): show the encrypted on-device copy if this ward is stored;
// otherwise download the PDF (fetchRoll), decode it on the text layer with
// the decoder's decodeRoll, store the minimised entries encrypted, and render
// them. Any failure shows a Hindi message with a retry button; nothing throws
// to the caller.
//
// What shows is the ward-roll screen's state (src/ui/wardRollScreen.js):
// loading while the stored copy is opened, downloaded or decoded, filled once
// a list shows, error on a failure. deps.screen passes the screen; by default
// the flow makes its own over the container.
//
// restore(): at startup, show the last stored ward with no network request,
// so the app opens offline once a roll has been fetched.

import { fetchRoll as defaultFetchRoll, RollFetchError } from './fetchRoll.js';
import { createRollStore, minimiseEntries, wardKeyFor } from './rollStore.js';
import { mountRollWithSearch } from '../ui/rollSearch.js';
import { createWardRollScreen } from '../ui/wardRollScreen.js';

/** decodeRoll with the master glyph table, loaded only when a PDF needs it. */
export async function decodeWithTable(pdfBytes) {
  const [{ decodeRoll }, { loadMasterTable }] = await Promise.all([
    import('../decoder/decodeRoll.js'),
    import('../decoder/glyphMap.js'),
  ]);
  const table = await loadMasterTable();
  return decodeRoll(new Uint8Array(pdfBytes), { table });
}

/**
 * @param {Element} container where the loading line, error or list goes
 * @param {Record<string,string>} strings the Hindi string table
 * @param {object} [deps] fetchRoll, decode, store ({encryptAndStore,
 *   loadStored, lastWardKey}), mountList, screen (a ward-roll screen over
 *   container), onShow (called with the entries and the ward key when a list
 *   shows),
 *   listOptions (passed to mountList, with the ward key added as wardKey), log
 */
export function createRollFlow(container, strings, deps = {}) {
  const fetchRoll = deps.fetchRoll || defaultFetchRoll;
  const decode = deps.decode || decodeWithTable;
  const mountList = deps.mountList || mountRollWithSearch;
  const log = deps.log || ((...args) => console.error(...args));
  const screen = deps.screen || createWardRollScreen(container, strings);
  let store = deps.store || null;
  let generation = 0;

  function getStore() {
    if (!store) store = createRollStore();
    return store;
  }

  // The ward key goes to the list so a voter's consent is stored per ward.
  function showList(entries, wardKey) {
    const list = screen.setState('filled', {
      render: (target) => mountList(target, entries, strings, { ...deps.listOptions, wardKey }),
    });
    if (typeof deps.onShow === 'function') deps.onShow(entries, wardKey);
    return list;
  }

  function showError(err, selection) {
    screen.setState('error', {
      fetchFailed: err instanceof RollFetchError,
      retry: () => open(selection),
    });
  }

  async function storedEntries(wardKey) {
    try {
      return await getStore().loadStored(wardKey);
    } catch (err) {
      // An unreadable copy (e.g. storage cleared under us) is refetched.
      log('stored roll could not be read', err);
      return null;
    }
  }

  async function open(selection) {
    const mine = ++generation;
    const current = () => mine === generation;
    try {
      const wardKey = wardKeyFor(selection);
      screen.setState('loading', { phase: 'open' });
      const stored = await storedEntries(wardKey);
      if (!current()) return null;
      if (stored) return showList(stored, wardKey);

      screen.setState('loading', { phase: 'download' });
      const bytes = await fetchRoll(selection);
      if (!current()) return null;
      screen.setState('loading', { phase: 'decode' });
      const decoded = await decode(bytes);
      if (!current()) return null;
      // A PDF that decodes to nothing is not a roll: fail so the user can retry.
      if (minimiseEntries(decoded).length === 0) throw new Error('decoder returned no entries');
      let entries;
      try {
        entries = await getStore().encryptAndStore(wardKey, decoded);
      } catch (err) {
        // Still show the roll; it just will not be there offline next time.
        log('roll could not be stored on the device', err);
        entries = minimiseEntries(decoded);
      }
      if (!current()) return null;
      return showList(entries, wardKey);
    } catch (err) {
      log('roll could not be loaded', err);
      if (current()) showError(err, selection);
      return null;
    }
  }

  async function restore() {
    const mine = generation;
    try {
      const wardKey = await getStore().lastWardKey();
      if (!wardKey) return null;
      const stored = await storedEntries(wardKey);
      // A ward picked meanwhile wins over the restored one.
      if (!stored || mine !== generation) return null;
      return showList(stored, wardKey);
    } catch (err) {
      log('stored roll could not be restored', err);
      return null;
    }
  }

  return { open, restore, screen };
}
