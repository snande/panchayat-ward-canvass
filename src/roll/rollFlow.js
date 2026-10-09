// Ward pick -> roll on screen.
//
// open(selection): show the encrypted on-device copy if this ward has one;
// else download (fetchRoll), decode (decodeRoll), store encrypted and render.
// A failure shows a Hindi message with a retry; nothing throws to the caller.
// What shows is the ward-roll screen's state (src/ui/wardRollScreen.js):
// loading, filled or error. deps.screen passes the screen; by default the
// flow makes its own over the container.
//
// restore(): show the last stored ward with no network request, so the app
// opens offline once a roll has been fetched.
//
// Supplementary rolls (selection.supplementPdfUrls) are downloaded through the
// same relay GET (fetchSupplements), decoded by the same decoder and merged
// onto the roll (src/roll/applySupplements.js) before it is stored, with the
// URLs merged so far. Opening a stored ward fetches only the listed
// supplementary rolls not merged yet: one that failed, or one the catalogue
// lists since. One that fails leaves the roll showing, with the deletions
// toggle's error state and its retry. The deletions toggle
// (src/ui/deletionsToggle.js) sits above the list: supplementary deletions
// are hidden until it is on, and its state is kept in the roll settings
// (src/roll/rollSettings.js). It only hides and shows rows.

import {
  fetchRoll as defaultFetchRoll, fetchSupplements as defaultFetchSupplements, RollFetchError, supplementUrls,
} from './fetchRoll.js';
import { loadRollSettings, saveRollSettings } from './rollSettings.js';
import { createRollStore, minimiseEntries, wardKeyFor } from './rollStore.js';
import { mountDeletionsToggle } from '../ui/deletionsToggle.js';
import { el } from '../ui/dom.js';
import { mountRollWithSearch } from '../ui/rollSearch.js';
import { createWardRollScreen } from '../ui/wardRollScreen.js';

const TOGGLE_STATE = { none: 'empty', merged: 'filled', failed: 'error' };
const isSupplementDeletion = (entry) => Boolean(entry) && entry.supplement === 'deletion';

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
 * @param {object} [deps] fetchRoll, fetchSupplements, decode, store
 *   ({encryptAndStore, loadStored, supplementState?, lastWardKey}), mountList,
 *   screen (a ward-roll screen over container), onShow (called with the
 *   entries, supplementary deletions included, and the ward key when a list
 *   shows), settings ({load, save}: the roll settings, localStorage by
 *   default), selectionFor (wardKey => the ward's selection or null, so the
 *   supplement retry works on a restored roll), listOptions (passed to
 *   mountList, with the ward key added as wardKey), log
 */
export function createRollFlow(container, strings, deps = {}) {
  const fetchRoll = deps.fetchRoll || defaultFetchRoll;
  const fetchSupplements = deps.fetchSupplements || defaultFetchSupplements;
  const decode = deps.decode || decodeWithTable;
  const mountList = deps.mountList || mountRollWithSearch;
  const log = deps.log || ((...args) => console.error(...args));
  const settings = deps.settings || {
    load() {
      const { settings: read, error, version } = loadRollSettings();
      // An unknown version or a corrupt record is reported; the defaults apply.
      if (error) log('roll settings could not be read', error, version);
      return read;
    },
    save: saveRollSettings,
  };
  const screen = deps.screen || createWardRollScreen(container, strings);
  let store = deps.store || null;
  let generation = 0;

  function getStore() {
    if (!store) store = createRollStore();
    return store;
  }

  function showDeletionsSetting() {
    try {
      return Boolean(settings.load().showDeletions);
    } catch (err) {
      log('roll settings could not be read', err);
      return false;
    }
  }

  // The deletions toggle over the list. Flipping it mounts the list again
  // with or without the supplementary deletions; the returned handle stands
  // for whichever list is mounted, so screen.list keeps working.
  function renderRoll(target, entries, wardKey, supplementState, selection) {
    const doc = target.ownerDocument;
    const toggleHost = el(doc, 'div', 'roll-supplement-host');
    const listHost = el(doc, 'div', 'roll-list-host');
    target.replaceChildren(toggleHost, listHost);
    let showDeletions = showDeletionsSetting();
    let inner = null;
    const deletions = entries.filter(isSupplementDeletion).length;

    function mountInner() {
      if (inner && typeof inner.destroy === 'function') inner.destroy();
      const shown = showDeletions ? entries : entries.filter((e) => !isSupplementDeletion(e));
      inner = mountList(listHost, shown, strings, { ...deps.listOptions, wardKey }) || null;
    }

    const state = supplementState === 'none' && deletions > 0 ? 'merged' : supplementState;
    mountDeletionsToggle(toggleHost, strings, {
      state: TOGGLE_STATE[state] || 'empty',
      deletions,
      checked: showDeletions,
      support: screen.support,
      onChange: (checked) => {
        showDeletions = checked;
        if (!settings.save({ showDeletions })) log('roll settings could not be stored');
        mountInner();
      },
      onRetry: () => {
        const again = selection || (typeof deps.selectionFor === 'function' ? deps.selectionFor(wardKey) : null);
        if (again) open(again);
        else log('no ward selection to retry the supplementary roll with', wardKey);
      },
    });
    mountInner();

    return new Proxy({}, {
      get(_, key) {
        if (key === 'destroy') return () => { if (inner && typeof inner.destroy === 'function') inner.destroy(); };
        if (key === 'deletionsToggle') return toggleHost.firstChild;
        const value = inner ? inner[key] : undefined;
        return typeof value === 'function' ? value.bind(inner) : value;
      },
      has: (_, key) => Boolean(inner) && key in inner,
    });
  }

  // The ward key goes to the list so a voter's consent is stored per ward.
  function showList(entries, wardKey, supplementState = 'none', selection = null) {
    const list = screen.setState('filled', {
      render: (target) => renderRoll(target, entries, wardKey, supplementState, selection),
    });
    if (typeof deps.onShow === 'function') deps.onShow(entries, wardKey);
    return list;
  }

  /** The listed supplementary roll URLs not in `merged`. */
  function pendingSupplements(selection, merged) {
    return supplementUrls(selection).filter((url) => !merged.includes(url));
  }

  /** 'failed' if one failed, else 'merged' once any is merged, else 'none'. */
  const supplementStateOf = ({ urls, failed }) => (failed ? 'failed' : urls.length ? 'merged' : 'none');

  /**
   * Download and decode the selection's supplementary rolls not in `merged`.
   * @returns {Promise<{lists: object[][], urls: string[], failed: boolean}>}
   *   the decoded rolls, every URL merged once these are (merged first), and
   *   whether one failed
   */
  async function loadSupplements(selection, merged = []) {
    const pending = pendingSupplements(selection, merged);
    const lists = [];
    const urls = [...merged];
    let failed = false;
    if (pending.length === 0) return { lists, urls, failed };
    for (const result of await fetchSupplements({ ...selection, supplementPdfUrls: pending })) {
      if (!result.ok) {
        log('supplementary roll could not be downloaded', result.url, result.error);
        failed = true;
        continue;
      }
      try {
        const decoded = await decode(result.buffer);
        if (!Array.isArray(decoded) || decoded.length === 0) throw new Error('decoder returned no entries');
        lists.push(decoded);
        urls.push(result.url);
      } catch (err) {
        log('supplementary roll could not be decoded', result.url, err);
        failed = true;
      }
    }
    return { lists, urls, failed };
  }

  /** The stored supplement state {state, urls}; unreadable reads as failed, nothing merged. */
  async function storedSupplementState(wardKey) {
    if (typeof getStore().supplementState !== 'function') return { state: 'none', urls: [] };
    try {
      return (await getStore().supplementState(wardKey)) || { state: 'none', urls: [] };
    } catch (err) {
      log('stored supplement state could not be read', err);
      return { state: 'failed', urls: [] };
    }
  }

  /**
   * Merge, store encrypted and show; the roll shows even if storing fails.
   * The merge is loaded only here, after a download, like the decoder.
   */
  async function mergeStoreAndShow(base, supplements, wardKey, selection, current) {
    const { applySupplements } = await import('./applySupplements.js');
    const merged = applySupplements(base, supplements.lists);
    const state = supplementStateOf(supplements);
    let entries;
    try {
      entries = await getStore().encryptAndStore(wardKey, merged, { supplement: state, supplementUrls: supplements.urls });
    } catch (err) {
      // Still show the roll; it just will not be there offline next time.
      log('roll could not be stored on the device', err);
      entries = minimiseEntries(merged);
    }
    if (!current()) return null;
    return showList(entries, wardKey, state, selection);
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
      // An unreadable copy (storage cleared, unknown version) is refetched.
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
      if (stored) {
        const saved = await storedSupplementState(wardKey);
        if (!current()) return null;
        // Supplements that failed, or were listed since, are fetched; merged ones are not.
        if (pendingSupplements(selection, saved.urls).length === 0) {
          return showList(stored, wardKey, supplementStateOf({ urls: saved.urls, failed: false }), selection);
        }
        screen.setState('loading', { phase: 'download' });
        const supplements = await loadSupplements(selection, saved.urls);
        if (!current()) return null;
        return mergeStoreAndShow(stored, supplements, wardKey, selection, current);
      }

      screen.setState('loading', { phase: 'download' });
      const bytes = await fetchRoll(selection);
      if (!current()) return null;
      screen.setState('loading', { phase: 'decode' });
      const decoded = await decode(bytes);
      if (!current()) return null;
      // A PDF that decodes to nothing is not a roll: fail so the user can retry.
      if (minimiseEntries(decoded).length === 0) throw new Error('decoder returned no entries');
      // A supplement that fails leaves the roll itself showing.
      const supplements = await loadSupplements(selection);
      if (!current()) return null;
      return mergeStoreAndShow(decoded, supplements, wardKey, selection, current);
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
      const saved = await storedSupplementState(wardKey);
      if (mine !== generation) return null;
      // No network here: a failed supplement is retried from the toggle's
      // retry (deps.selectionFor) or when the ward is picked.
      return showList(stored, wardKey, saved.state);
    } catch (err) {
      log('stored roll could not be restored', err);
      return null;
    }
  }

  return { open, restore, screen };
}
