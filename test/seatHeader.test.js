// Seat header (issue #130): one line above every screen naming the loaded
// panchayat and ward, an empty state linking to the picker, a schema-versioned
// stored seat restored at startup by js/app.js, precached for offline use and
// styled from DESIGN.md tokens.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

import {
  renderSeatHeader, seatFromPick, saveSeat, loadSeat, SEAT_STORAGE_KEY, SEAT_SCHEMA_VERSION,
} from '../src/ui/seatHeader.js';
import { createDocument } from './helpers/fakeDom.js';

const appUrl = new URL('../js/app.js', import.meta.url);
const read = (rel) => readFileSync(new URL('../' + rel, import.meta.url), 'utf8');
const table = JSON.parse(read('src/strings.hi.json'));
const css = read('styles.css');
const EMPTY = 'कोई वार्ड लोड नहीं — ऊपर पंचायत और वार्ड चुनें';

function memoryStorage(initial = {}) {
  const map = new Map(Object.entries(initial));
  const storage = {
    map,
    reads: 0,
    getItem: (k) => { storage.reads += 1; return map.has(k) ? map.get(k) : null; },
    setItem: (k, v) => { map.set(k, String(v)); },
    removeItem: (k) => { map.delete(k); },
  };
  return storage;
}

function mount() {
  const doc = createDocument();
  const root = doc.createElement('div');
  doc.body.appendChild(root);
  return root;
}

test('a ward panch seat renders one line with the panchayat name and ward number', () => {
  const root = mount();
  renderSeatHeader(root, { seatType: 'ward', panchayat: 'बडली', ward: '3' });
  assert.equal(root.children.length, 1);
  assert.equal(root.textContent, 'पंचायत: बडली · वार्ड: 3');
  assert.equal(root.children[0].className, 'seat-header-text');
  assert.equal(root.getAttribute('data-state'), 'loaded');
});

test('a sarpanch seat renders the panchayat and every ward', () => {
  const root = mount();
  renderSeatHeader(root, { seatType: 'sarpanch', panchayat: 'बडली' });
  assert.equal(root.children.length, 1);
  assert.equal(root.textContent, 'पंचायत: बडली · सभी वार्ड');
});

test('with no seat the header is the empty state, a link to the picker', () => {
  for (const seat of [null, undefined, {}, { seatType: 'ward', panchayat: 'बडली' }, { seatType: 'zila', panchayat: 'बडली', ward: '1' }]) {
    const root = mount();
    renderSeatHeader(root, seat);
    assert.equal(root.children.length, 1);
    const link = root.children[0];
    assert.equal(link.tagName, 'A');
    assert.equal(link.className, 'seat-header-link');
    assert.equal(link.getAttribute('href'), '#ward-picker');
    assert.equal(link.textContent, EMPTY);
    assert.equal(root.getAttribute('data-state'), 'empty');
  }
});

test('re-rendering replaces the line: a new seat shows without a reload', () => {
  const root = mount();
  renderSeatHeader(root, null);
  renderSeatHeader(root, { seatType: 'ward', panchayat: 'बडली', ward: '1' });
  renderSeatHeader(root, { seatType: 'ward', panchayat: 'बडली', ward: '2' });
  assert.equal(root.children.length, 1);
  assert.equal(root.textContent, 'पंचायत: बडली · वार्ड: 2');
});

test('the header text comes from the string table, and its built-in copies match it', () => {
  assert.equal(table.seat_header_panchayat, 'पंचायत');
  assert.equal(table.seat_header_ward, 'वार्ड');
  assert.equal(table.seat_header_all_wards, 'सभी वार्ड');
  assert.equal(table.seat_header_empty, EMPTY);
  const source = read('src/ui/seatHeader.js');
  for (const key of ['seat_header_panchayat', 'seat_header_ward', 'seat_header_all_wards', 'seat_header_empty']) {
    const copy = source.match(new RegExp(`${key}: '([^']*)'`));
    assert.ok(copy, `seatHeader.js has no copy of ${key}`);
    assert.equal(copy[1], table[key], key);
  }
  const root = mount();
  renderSeatHeader(root, { seatType: 'ward', panchayat: 'बडली', ward: '1' }, { ...table, seat_header_ward: 'वार्ड नं.' });
  assert.equal(root.textContent, 'पंचायत: बडली · वार्ड नं.: 1');
});

test('a catalogue pick names its seat: the Hindi panchayat name, and its ward for a ward panch', () => {
  const pick = (seatType, wards) => ({
    schemaVersion: 1, seatType, district: { id: '1', name: 'अजमेर' },
    panchayat: { id: '54', name: 'अजगरा', nameLatin: 'AJGARA', block: { id: '4', name: 'अराई' } }, wards,
  });
  const ward = (n) => ({ ward: n, pdfUrl: `https://example.invalid/${n}.pdf` });
  assert.deepEqual(seatFromPick(pick('ward-panch', [ward(3)])), { seatType: 'ward', panchayat: 'अजगरा', ward: '3' });
  assert.deepEqual(seatFromPick(pick('sarpanch', [ward(1), ward(2)])), { seatType: 'sarpanch', panchayat: 'अजगरा' });
  const root = mount();
  renderSeatHeader(root, seatFromPick(pick('sarpanch', [ward(1), ward(2)])));
  assert.equal(root.textContent, 'पंचायत: अजगरा · सभी वार्ड');
  for (const bad of [null, undefined, {}, pick('sarpanch', []), pick('ward-panch', [ward(1), ward(2)]), pick('zila', [ward(1)]),
    pick('ward-panch', [ward(null)]), pick('ward-panch', [ward(undefined)]), pick('ward-panch', [ward(0)]),
    pick('ward-panch', [ward('3')]), pick('ward-panch', [null]),
    { ...pick('sarpanch', [ward(1)]), panchayat: { id: '54', name: ' ' } }]) {
    assert.equal(seatFromPick(bad), null, JSON.stringify(bad));
  }
});

test('the stored seat holds only a schema version, seat type, panchayat and ward, and round-trips', () => {
  const storage = memoryStorage();
  assert.equal(saveSeat({ seatType: 'ward', panchayat: 'बडली', ward: '3', pdfUrl: 'x', voters: [1] }, storage), true);
  const record = JSON.parse(storage.map.get(SEAT_STORAGE_KEY));
  assert.deepEqual(Object.keys(record).sort(), ['panchayat', 'schemaVersion', 'seatType', 'ward']);
  assert.equal(record.schemaVersion, SEAT_SCHEMA_VERSION);
  assert.deepEqual(loadSeat(storage), { seat: { seatType: 'ward', panchayat: 'बडली', ward: '3' }, error: null });

  saveSeat({ seatType: 'sarpanch', panchayat: 'बडली' }, storage);
  assert.deepEqual(loadSeat(storage), { seat: { seatType: 'sarpanch', panchayat: 'बडली' }, error: null });

  assert.deepEqual(loadSeat(memoryStorage()), { seat: null, error: null });
  assert.deepEqual(loadSeat(null), { seat: null, error: null });
  assert.equal(saveSeat(null, storage), false);
});

test('a stored seat of an unknown version or shape is reported and falls back to the empty state', () => {
  const future = memoryStorage({ [SEAT_STORAGE_KEY]: JSON.stringify({ schemaVersion: 2, seat: 'बडली/3' }) });
  assert.deepEqual(loadSeat(future), { seat: null, error: 'unknown-version', version: 2 });
  const unversioned = memoryStorage({ [SEAT_STORAGE_KEY]: JSON.stringify({ seatType: 'ward', panchayat: 'बडली', ward: '3' }) });
  assert.equal(loadSeat(unversioned).error, 'unknown-version');
  assert.equal(loadSeat(memoryStorage({ [SEAT_STORAGE_KEY]: '{not json' })).error, 'corrupt');
  assert.equal(loadSeat(memoryStorage({ [SEAT_STORAGE_KEY]: JSON.stringify({ schemaVersion: 1, seatType: 'ward' }) })).error, 'corrupt');
  const throwing = { getItem() { throw new Error('denied'); } };
  assert.equal(loadSeat(throwing).error, 'unreadable');

  const root = mount();
  renderSeatHeader(root, loadSeat(future).seat);
  assert.equal(root.textContent, EMPTY);
});

test('index.html has one seat header, outside every screen container, pending until the stored seat is read', () => {
  const html = read('index.html');
  assert.equal(html.split('id="seat-header"').length - 1, 1);
  const at = html.indexOf('id="seat-header"');
  assert.ok(at > html.indexOf('</header>') && at < html.indexOf('<main'), 'the seat header sits between the app header and <main>');
  // No false "nothing loaded" before js/app.js has read the stored seat.
  assert.match(html, /<div id="seat-header" class="seat-header" data-state="pending" aria-live="polite"><\/div>/);
  assert.match(html, /id="ward-picker"/, 'the empty state links to the picker');
});

test('sw.js precaches the seat header so it renders offline', () => {
  const sw = read('sw.js');
  const precache = sw.slice(sw.indexOf('PRECACHE = ['), sw.indexOf('];', sw.indexOf('PRECACHE = [')));
  assert.match(precache, /"src\/ui\/seatHeader\.js"/);
  assert.match(precache, /"src\/ui\/dom\.js"/, 'its one import is precached too');
});

// vm.constants.USE_MAIN_CONTEXT_DEFAULT_LOADER arrived in Node 20.12 and 21.7.
const canImport = Boolean(vm.constants && vm.constants.USE_MAIN_CONTEXT_DEFAULT_LOADER);
const skip = !canImport && 'no vm dynamic import';

async function waitFor(cond, ms = 5000) {
  const until = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > until) throw new Error('timed out');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

// Runs js/app.js as the classic script it is, with a pending seat header.
// beforeImport runs right after the script, before its import() resolves.
async function bootApp(storage, { beforeImport } = {}) {
  const header = mount();
  header.setAttribute('data-state', 'pending');
  const errors = [];
  const ctx = vm.createContext({
    document: {
      title: '',
      querySelectorAll: () => [],
      getElementById: (id) => (id === 'seat-header' ? header : null),
    },
    fetch: async () => ({ ok: true, status: 200, json: async () => table }),
    navigator: {},
    window: { addEventListener() {} },
    console: { error: (...a) => errors.push(a) },
  });
  const saved = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'localStorage', { value: storage, configurable: true, writable: true });
  try {
    // app.js is a classic script: its import() resolves against its own path.
    const script = new vm.Script(read('js/app.js'), {
      filename: fileURLToPath(appUrl),
      importModuleDynamically: vm.constants.USE_MAIN_CONTEXT_DEFAULT_LOADER,
    });
    script.runInContext(ctx);
    if (beforeImport) beforeImport(header);
    await waitFor(() => storage.reads > 0 || errors.length > 0);
    await new Promise((resolve) => setTimeout(resolve, 5));
  } finally {
    if (saved) Object.defineProperty(globalThis, 'localStorage', saved);
    else delete globalThis.localStorage;
  }
  return { header, errors };
}

test('at startup js/app.js restores the last seat from local storage', { skip }, async () => {
  assert.match(read('js/app.js'), /renderSeatHeader\(seatHeader, stored\.seat\)/);
  const storage = memoryStorage();
  saveSeat({ seatType: 'ward', panchayat: 'बडली', ward: '4' }, storage);
  const { header, errors } = await bootApp(storage);
  assert.deepEqual(errors, []);
  assert.equal(header.textContent, 'पंचायत: बडली · वार्ड: 4');
});

test('at startup with nothing stored the pending header becomes the empty state', { skip }, async () => {
  const { header, errors } = await bootApp(memoryStorage());
  assert.deepEqual(errors, []);
  assert.equal(header.getAttribute('data-state'), 'empty');
  assert.equal(header.textContent, EMPTY);
});

test('at startup an unknown stored version is reported and the header shows the empty state', { skip }, async () => {
  const { header, errors } = await bootApp(memoryStorage({ [SEAT_STORAGE_KEY]: JSON.stringify({ schemaVersion: 99 }) }));
  assert.equal(header.textContent, EMPTY);
  assert.equal(errors.length, 1);
  assert.match(String(errors[0][0]), /unknown-version/);
});

test('at startup a seat shown before the stored one is read is not overwritten', { skip }, async () => {
  const storage = memoryStorage();
  saveSeat({ seatType: 'ward', panchayat: 'बडली', ward: '4' }, storage);
  const { header, errors } = await bootApp(storage, {
    beforeImport: (root) => renderSeatHeader(root, { seatType: 'ward', panchayat: 'बडली', ward: '7' }),
  });
  assert.deepEqual(errors, []);
  assert.ok(storage.reads > 0, 'the stored seat was read');
  assert.equal(header.textContent, 'पंचायत: बडली · वार्ड: 7');
});

// The innermost `selector { body }` rules naming a selector, merged.
function ruleFor(selector) {
  const out = {};
  for (const m of css.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if (!m[1].split(',').map((s) => s.trim()).includes(selector)) continue;
    for (const decl of m[2].split(';')) {
      const i = decl.indexOf(':');
      if (i > 0) out[decl.slice(0, i).trim()] = decl.slice(i + 1).trim();
    }
  }
  return out;
}
const rootTokens = ruleFor(':root');
const hex = (token) => rootTokens[token.match(/var\((--[\w-]+)\)/)[1]];
const luminance = (h) => {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255)
    .map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const contrast = (a, b) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};

test('the header follows DESIGN.md: token colours, text at least 16 px, light contrast at least 7:1, a 48 px link', () => {
  assert.match(read('DESIGN.md'), /\| Seat header \| `\.seat-header`, `\.seat-header-text`, `\.seat-header-link` \|/);
  const strip = ruleFor('.seat-header');
  const empty = ruleFor('.seat-header[data-state="empty"]');
  const text = ruleFor('.seat-header-text');
  const link = ruleFor('.seat-header-link');
  for (const value of [strip.background, strip.color, empty.background, text.color, link.color, text['font-size']]) {
    assert.match(value, /^var\(--[\w-]+\)$/, value);
  }
  const px = (v) => Number(v.replace('rem', '')) * (v.endsWith('rem') ? 16 : 1);
  assert.ok(px(rootTokens[text['font-size'].slice(4, -1)]) >= 16, 'font size');
  assert.ok(contrast(hex(text.color), hex(strip.background)) >= 7, 'seat line contrast');
  assert.ok(contrast(hex(link.color), hex(empty.background)) >= 7, 'empty link contrast');
  assert.equal(rootTokens['--touch-target'], '48px');
  // The pending strip keeps the loaded strip's height, so nothing jumps.
  assert.equal(strip['min-height'], 'var(--touch-target)');
  assert.equal(link['min-height'], 'var(--touch-target)');
  assert.equal(link['min-width'], 'var(--touch-target)');
  assert.equal(link.width, '100%', 'the whole strip is the tap target');
  assert.equal(link.appearance, 'none');
  assert.match(ruleFor('.seat-header-link:focus-visible').outline, /var\(--color-focus\)/);
});
