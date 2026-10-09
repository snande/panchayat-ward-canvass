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
// Supplementary rolls (selection.supplementPdfUrls) are fetched by the same
// relay GET, decoded and merged in publication order (applySupplements.js),
// and stored with the URLs merged. The first failure stops the merge, so an
// earlier supplement is never merged over a later one; the roll still shows,
// with the deletions toggle's error and retry. A stored ward merges the
// listed supplements after its merged ones; if a merged one is no longer
// listed first, the roll is downloaded and merged again (offline, the stored
// roll shows). The toggle (src/ui/deletionsToggle.js, setting in
// rollSettings.js) only hides and shows supplementary deletions.

import {
  fetchRoll as defaultFetchRoll, fetchSupplements as defaultFetchSupplements, RollFetchError, supplementUrls,
} from './fetchRoll.js';
import { loadRollSettings, saveRollSettings } from './rollSettings.js';
import { createRollStore, minimiseEntries, wardKeyFor } from './rollStore.js';
import { isSupplementDeletion } from './supplementTags.js';
import { mountDeletionsToggle } from '../ui/deletionsToggle.js';
import { el } from '../ui/dom.js';
import { mountRollWithSearch } from '../ui/rollSearch.js';
import { createWardRollScreen } from '../ui/wardRollScreen.js';

const TOGGLE_STATE = { none: 'empty', merged: 'filled', failed: 'error' };

/** Whether `merged` is the start of `listed`, in the same order. */
const isPrefix = (merged, listed) => merged.length <= listed.length && merged.every((url, i) => listed[i] === url);

/** 'failed' if one failed, else 'merged' once any is merged, else 'none'. */
const supplementStateOf = ({ urls, failed }) => (failed ? 'failed' : urls.length ? 'merged' : 'none');

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
 *   screen (a ward-roll screen over container), onShow (entries, deletions
 *   included, and ward key when a list shows), settings ({load, save}),
 *   selectionFor (wardKey => selection, for a restored roll's retry),
 *   listOptions (passed to mountList with wardKey), log
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

  // The toggle over the list; a flip remounts the list, keeping a typed
  // query. The handle stands for the mounted list (screen.list).
  function renderRoll(target, entries, wardKey, supplementState, selection) {
    const doc = target.ownerDocument;
    const toggleHost = el(doc, 'div', 'roll-supplement-host');
    const listHost = el(doc, 'div', 'roll-list-host');
    target.replaceChildren(toggleHost, listHost);
    let showDeletions = showDeletionsSetting();
    let inner = null;
    const deletions = entries.filter(isSupplementDeletion).length;
    const searchInput = () => (inner && inner.search && inner.search.input) || null;

    function mountInner() {
      const query = searchInput() ? searchInput().value : '';
      if (inner && typeof inner.destroy === 'function') inner.destroy();
      const shown = showDeletions ? entries : entries.filter((e) => !isSupplementDeletion(e));
      inner = mountList(listHost, shown, strings, { ...deps.listOptions, wardKey }) || null;
      const input = searchInput();
      if (query && input) {
        input.value = query;
        const Event = doc.defaultView && doc.defaultView.Event;
        input.dispatchEvent(Event ? new Event('input') : { type: 'input' });
      }
    }

    mountDeletionsToggle(toggleHost, strings, {
      state: TOGGLE_STATE[supplementState] || 'empty',
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

  /** The listed supplements after `merged`, in order (applySupplements.js, loaded only now). */
  async function loadSupplements(selection, merged = []) {
    let load;
    try {
      ({ loadSupplements: load } = await import('./applySupplements.js'));
    } catch (err) {
      // Offline, the module is not cached: the supplements wait for a retry.
      log('supplementary roll could not be loaded', err);
      return { lists: [], urls: [...merged], failed: true };
    }
    return load(selection, merged, { fetchSupplements, decode, log });
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

  /** Merge, store and show; the roll shows even if storing fails. */
  async function mergeStoreAndShow(base, supplements, wardKey, selection, current) {
    const merged = supplements.lists.length
      ? (await import('./applySupplements.js')).applySupplements(base, supplements.lists) : base;
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
      // Merged supplements no longer listed first: merge again from a download.
      let outdated = null;
      if (stored) {
        const saved = await storedSupplementState(wardKey);
        if (!current()) return null;
        const listed = supplementUrls(selection);
        if (isPrefix(saved.urls, listed)) {
          if (saved.urls.length === listed.length) {
            return showList(stored, wardKey, supplementStateOf({ urls: saved.urls, failed: false }), selection);
          }
          // The rest, in order: one that failed, or one listed since.
          screen.setState('loading', { phase: 'download' });
          const supplements = await loadSupplements(selection, saved.urls);
          if (!current()) return null;
          return mergeStoreAndShow(stored, supplements, wardKey, selection, current);
        }
        outdated = { stored, state: saved.state };
      }

      let decoded;
      try {
        screen.setState('loading', { phase: 'download' });
        const bytes = await fetchRoll(selection);
        if (!current()) return null;
        screen.setState('loading', { phase: 'decode' });
        decoded = await decode(bytes);
        if (!current()) return null;
        // A PDF that decodes to nothing is not a roll: fail so the user can retry.
        if (minimiseEntries(decoded).length === 0) throw new Error('decoder returned no entries');
      } catch (err) {
        if (!outdated) throw err;
        log('roll could not be downloaded again to merge its listed supplements', err);
        if (!current()) return null;
        return showList(outdated.stored, wardKey, outdated.state, selection);
      }
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
      // No network: a failed supplement waits for the retry or a pick.
      return showList(stored, wardKey, saved.state);
    } catch (err) {
      log('stored roll could not be restored', err);
      return null;
    }
  }

  return { open, restore, screen };
}
