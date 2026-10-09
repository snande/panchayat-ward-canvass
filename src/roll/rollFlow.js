// Ward pick -> roll on screen.
//
// open(selection): show the encrypted on-device copy if this ward is stored;
// otherwise download the PDF (fetchRoll), decode it on the text layer with
// the decoder's decodeRoll, store the minimised entries encrypted, and render
// them. Any failure shows a Hindi message with a retry button; nothing throws
// to the caller.
//
// restore(): at startup, show the last stored ward with no network request,
// so the app opens offline once a roll has been fetched. A stored copy of an
// older record version is not read: restore() opens that ward again (fetch,
// decode, store), using deps.resolveSelection to turn its ward key back into
// a selection with its pdfUrl.

import { fetchRoll as defaultFetchRoll, RollFetchError } from './fetchRoll.js';
import { createRollStore, minimiseEntries, RollRecordVersionError, wardKeyFor } from './rollStore.js';
import { el } from '../ui/dom.js';
import { mountRollWithSearch } from '../ui/rollSearch.js';

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
 *   readStored or loadStored, lastWardKey}), mountList, onShow (called when a list shows),
 *   listOptions (passed to mountList, with the ward key added as wardKey), log,
 *   resolveSelection (ward key -> selection or null, may be async; lets
 *   restore() decode again a ward whose stored copy is of an older version)
 */
export function createRollFlow(container, strings, deps = {}) {
  const doc = container.ownerDocument;
  const text = (key) => (strings && Object.prototype.hasOwnProperty.call(strings, key) ? strings[key] : '');
  const fetchRoll = deps.fetchRoll || defaultFetchRoll;
  const decode = deps.decode || decodeWithTable;
  const mountList = deps.mountList || mountRollWithSearch;
  const log = deps.log || ((...args) => console.error(...args));
  let store = deps.store || null;
  let generation = 0;
  let list = null;

  function getStore() {
    if (!store) store = createRollStore();
    return store;
  }

  function unmountList() {
    if (list && typeof list.destroy === 'function') list.destroy();
    list = null;
  }

  function show(...nodes) {
    unmountList();
    container.replaceChildren(...nodes);
    container.removeAttribute('hidden');
  }

  function showMessage(key, role) {
    const p = el(doc, 'p', 'roll-message', text(key));
    p.setAttribute('role', role);
    return p;
  }

  // The ward key goes to the list so a voter's consent is stored per ward.
  function showList(entries, wardKey) {
    unmountList();
    list = mountList(container, entries, strings, { ...deps.listOptions, wardKey });
    container.removeAttribute('hidden');
    if (typeof deps.onShow === 'function') deps.onShow(entries);
    return list;
  }

  function showError(err, selection) {
    const box = el(doc, 'div', 'roll-error');
    box.appendChild(showMessage(err instanceof RollFetchError ? 'roll_fetch_failed' : 'roll_failed', 'alert'));
    const retry = el(doc, 'button', 'btn-primary roll-retry', text('roll_retry'));
    retry.setAttribute('type', 'button');
    retry.addEventListener('click', () => open(selection));
    box.appendChild(retry);
    show(box);
  }

  /**
   * The stored copy of a ward, in one read: {entries, stale, unknown}.
   * entries is null when there is nothing readable. stale: the copy is of an
   * older record version (never read; the ward is decoded again). unknown:
   * the copy is of a record version this build does not know (reported,
   * never read, and kept: a newer build may have written it).
   */
  async function storedCopy(wardKey) {
    const s = getStore();
    try {
      if (typeof s.readStored === 'function') {
        const { entries, stale } = await s.readStored(wardKey);
        return { entries, stale: stale === true, unknown: false };
      }
      return { entries: await s.loadStored(wardKey), stale: false, unknown: false };
    } catch (err) {
      if (err instanceof RollRecordVersionError) {
        log('stored roll has an unknown record version; it is kept, not read or replaced', err);
        return { entries: null, stale: false, unknown: true };
      }
      // An unreadable copy (e.g. storage cleared under us) is refetched.
      log('stored roll could not be read', err);
      return { entries: null, stale: false, unknown: false };
    }
  }

  async function open(selection) {
    const mine = ++generation;
    const current = () => mine === generation;
    try {
      const wardKey = wardKeyFor(selection);
      show(showMessage('roll_loading', 'status'));
      const stored = await storedCopy(wardKey);
      if (!current()) return null;
      if (stored.entries) return showList(stored.entries, wardKey);

      const bytes = await fetchRoll(selection);
      if (!current()) return null;
      const decoded = await decode(bytes);
      if (!current()) return null;
      // A PDF that decodes to nothing is not a roll: fail so the user can retry.
      // A roll whose entries are all struck off still prints them, so it is
      // shown (every row struck through) and stored like any other roll.
      if (minimiseEntries(decoded).length === 0) throw new Error('decoder returned no entries');
      let entries;
      try {
        // A copy of an unknown (possibly newer) version is not overwritten:
        // the roll is shown, but only from this download.
        entries = stored.unknown ? minimiseEntries(decoded) : await getStore().encryptAndStore(wardKey, decoded);
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
      const stored = await storedCopy(wardKey);
      // A ward picked meanwhile wins over the restored one.
      if (mine !== generation) return null;
      if (stored.entries) return showList(stored.entries, wardKey);
      // A copy of an older record version: decode the ward again. If that
      // fails (offline), open() shows the error with its retry button; the
      // old copy is never shown, and the next startup tries again.
      if (!stored.stale || typeof deps.resolveSelection !== 'function') return null;
      const selection = await deps.resolveSelection(wardKey);
      if (!selection || mine !== generation) return null;
      return open(selection);
    } catch (err) {
      log('stored roll could not be restored', err);
      return null;
    }
  }

  return { open, restore };
}
