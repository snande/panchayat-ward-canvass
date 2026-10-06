// Acceptance tests for the search screen (issue #19), run by `npm test`.
//
// The DOM here is the in-process fake from ./helpers/fakeDom.js, not jsdom or
// a browser: the timing bound and the lang/inputmode attributes are asserted
// against that test DOM environment, not against Android Chrome.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';

import {
  mountSearchScreen,
  DEBOUNCE_MS,
  PLACEHOLDER,
  NO_RESULTS_MESSAGE,
} from '../src/ui/searchScreen.js';
import { buildIndex, search } from '../src/search/hindiSearch.js';
import { createDocument, type } from './helpers/fakeDom.js';

const MODULE_PATH = fileURLToPath(new URL('../src/ui/searchScreen.js', import.meta.url));

const FIRST = [
  'राम', 'श्याम', 'सीता', 'गीता', 'मोहन', 'सोहन', 'राधा', 'कृष्ण', 'लक्ष्मी', 'सरस्वती',
  'अनिल', 'सुनील', 'रमेश', 'सुरेश', 'महेश', 'दिनेश', 'पूजा', 'रेखा', 'सविता', 'कमला',
  'विजय', 'अजय', 'संजय', 'राजेश', 'मुकेश', 'प्रकाश', 'अशोक', 'विनोद', 'मनोज', 'सुभाष',
  'उषा', 'आशा', 'निर्मला', 'शांति', 'सुमन', 'किरण', 'ममता', 'अंजू', 'मीना', 'रानी',
];
const LAST = [
  'कुमार', 'शर्मा', 'वर्मा', 'सिंह', 'यादव', 'गुप्ता', 'जैन', 'देवी', 'चौधरी', 'मलिक',
  'राठी', 'दहिया', 'सहरावत', 'नैन', 'पूनिया', 'ढिल्लों', 'गहलोत', 'सैनी', 'कादियान', 'हुड्डा',
  'बल्हारा', 'छिकारा', 'राणा', 'तोमर', 'चौहान', 'बिश्नोई', 'जाखड़', 'सांगवान', 'फोगाट', 'ग्रेवाल',
  'खत्री', 'अरोड़ा', 'बंसल', 'गर्ग', 'मित्तल', 'सिंगला', 'गोयल', 'अग्रवाल', 'कंसल', 'जिंदल',
  'पाल', 'प्रजापति', 'वाल्मीकि', 'धानक', 'कश्यप', 'नाई', 'लोहार', 'खाती', 'सुनार', 'माली',
];

function makeRoll(n) {
  const roll = [];
  for (let i = 0; i < n; i += 1) {
    const serial = i + 1;
    roll.push({
      id: `v${serial}`,
      serial,
      name: `${FIRST[i % FIRST.length]} ${LAST[Math.floor(i / FIRST.length) % LAST.length]}`,
      relativeName: `पिता-${serial}`,
      houseNo: `H-${(serial % 400) + 1}`,
    });
  }
  return roll;
}

const voters2000 = makeRoll(2000);
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function mount(voters = voters2000) {
  const doc = createDocument();
  let resolveNext = null;
  const renders = [];
  const screen = mountSearchScreen(doc.body, voters, {
    onRender(results) {
      renders.push({ at: performance.now(), results });
      if (resolveNext) {
        const r = resolveNext;
        resolveNext = null;
        r(results);
      }
    },
  });
  const nextRender = () => new Promise((resolve) => (resolveNext = resolve));
  const rows = () => screen.list.querySelectorAll('li');
  return { doc, screen, renders, nextRender, rows };
}

test('exports mountSearchScreen and renders one Hindi input plus a results list', () => {
  assert.equal(typeof mountSearchScreen, 'function');
  const { doc, screen } = mount();
  const inputs = doc.body.querySelectorAll('input');
  assert.equal(inputs.length, 1);
  assert.equal(inputs[0], screen.input);
  assert.equal(screen.input.getAttribute('placeholder'), 'नाम खोजें');
  assert.equal(PLACEHOLDER, 'नाम खोजें');
  assert.equal(doc.body.querySelectorAll('ul').length, 1);
  assert.equal(doc.body.querySelector('ul'), screen.list);
  assert.equal(screen.list.children.length, 0);
  screen.destroy();
});

test('input uses lang="hi" and inputmode="text" for the Hindi keyboard', () => {
  const { screen } = mount();
  assert.equal(screen.input.getAttribute('lang'), 'hi');
  assert.equal(screen.input.getAttribute('inputmode'), 'text');
  screen.destroy();
});

test('debounce is at most 150 ms and search runs only after it', async () => {
  assert.ok(DEBOUNCE_MS > 0 && DEBOUNCE_MS <= 150, `debounce ${DEBOUNCE_MS} ms`);
  const { screen, renders, nextRender, rows } = mount();
  const rendered = nextRender();
  type(screen.input, 'राम');
  assert.equal(renders.length, 0, 'no render before the debounce elapses');
  assert.equal(rows().length, 0);
  await rendered;
  assert.equal(renders.length, 1);
  assert.ok(rows().length > 0);
  screen.destroy();
});

test('rendered results are exactly what search from src/search/hindiSearch.js returns', async () => {
  const { screen, nextRender } = mount();
  const index = buildIndex(voters2000);
  for (const q of ['राम', 'सीता देवी', 'कुमार']) {
    const rendered = nextRender();
    type(screen.input, q);
    const results = await rendered;
    assert.deepEqual(results, search(index, q, { limit: 50 }), `query ${q}`);
  }
  screen.destroy();
});

test('renders at most 50 rows, each with name, relative, serial and house number', async () => {
  const { screen, nextRender, rows } = mount();
  const rendered = nextRender();
  // The vowel sign ा occurs in far more than 50 names.
  type(screen.input, 'ा');
  const results = await rendered;
  assert.ok(results.length === 50, `expected 50 results, got ${results.length}`);
  const items = rows();
  assert.equal(items.length, 50);
  items.forEach((li, i) => {
    const v = results[i];
    assert.equal(li.querySelector('.pwc-search__name').textContent, v.name);
    assert.equal(li.querySelector('.pwc-search__relative').textContent, v.relativeName);
    assert.ok(li.querySelector('.pwc-search__serial').textContent.includes(String(v.serial)));
    assert.ok(li.querySelector('.pwc-search__house').textContent.includes(v.houseNo));
  });

  const again = nextRender();
  type(screen.input, 'राम');
  const ramResults = await again;
  assert.ok(ramResults.length > 0 && ramResults.length <= 50);
  assert.equal(rows().length, ramResults.length);
  for (const li of rows()) assert.ok(li.textContent.includes('राम'));
  screen.destroy();
});

test('an exact full-name query renders that voter as the first list item', async () => {
  const roll = [
    // Lower-serial prefix and substring matches that must rank below the exact name.
    { id: 'a', serial: 1, name: 'राम कुमार शर्मा पाल', relativeName: 'हरि', houseNo: '1' },
    { id: 'b', serial: 2, name: 'सीताराम कुमार शर्मा', relativeName: 'गोपाल', houseNo: '2' },
    ...makeRoll(2000).map((v) => ({ ...v, serial: v.serial + 2 })),
    { id: 'exact', serial: 9999, name: 'राम कुमार शर्मा', relativeName: 'दशरथ', houseNo: '77' },
  ];
  const { screen, nextRender, rows } = mount(roll);
  const rendered = nextRender();
  type(screen.input, 'राम कुमार शर्मा');
  await rendered;
  assert.ok(rows().length >= 3);
  const first = rows()[0];
  assert.equal(first.querySelector('.pwc-search__name').textContent, 'राम कुमार शर्मा');
  assert.equal(first.querySelector('.pwc-search__relative').textContent, 'दशरथ');
  assert.ok(first.querySelector('.pwc-search__house').textContent.includes('77'));
  screen.destroy();
});

test('no matches shows the Hindi message; an empty query renders no results', async () => {
  const { screen, nextRender, rows } = mount();
  assert.ok(screen.message.hidden, 'message hidden on mount');

  let rendered = nextRender();
  type(screen.input, 'ज़ज़ज़');
  await rendered;
  assert.equal(rows().length, 0);
  assert.equal(screen.message.hidden, false);
  assert.equal(screen.message.textContent, 'कोई मतदाता नहीं मिला');
  assert.equal(NO_RESULTS_MESSAGE, 'कोई मतदाता नहीं मिला');

  rendered = nextRender();
  type(screen.input, 'राम');
  await rendered;
  assert.ok(rows().length > 0);
  assert.ok(screen.message.hidden, 'message hidden when there are results');

  rendered = nextRender();
  type(screen.input, '');
  await rendered;
  assert.equal(rows().length, 0);
  assert.ok(screen.message.hidden, 'no message for an empty query');

  rendered = nextRender();
  type(screen.input, '   ');
  await rendered;
  assert.equal(rows().length, 0);
  assert.ok(screen.message.hidden);
  screen.destroy();
});

test('results replace the list children in a single batch', async () => {
  const { screen, nextRender, rows } = mount();
  let rendered = nextRender();
  type(screen.input, 'राम');
  await rendered;
  const listBefore = screen.list;
  const batchesBefore = screen.list.replaceCount;
  rendered = nextRender();
  type(screen.input, 'सीता');
  await rendered;
  assert.equal(screen.list, listBefore, 'list container is reused');
  assert.equal(screen.list.replaceCount - batchesBefore, 1, 'one replaceChildren per render');
  for (const li of rows()) assert.ok(li.textContent.includes('सीता'));
  screen.destroy();
});

const GUARDED = ['fetch', 'XMLHttpRequest', 'localStorage', 'sessionStorage', 'indexedDB'];

function installSpies() {
  const saved = new Map();
  for (const key of GUARDED) saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
  const calls = { fetch: 0, xhr: 0, storageWrites: 0, idbOpen: 0 };

  const makeStorage = () => {
    const data = new Map();
    return {
      get length() {
        return data.size;
      },
      getItem: (k) => (data.has(k) ? data.get(k) : null),
      setItem(k, v) {
        calls.storageWrites += 1;
        data.set(String(k), String(v));
      },
      removeItem: (k) => data.delete(k),
      clear: () => data.clear(),
      key: (i) => [...data.keys()][i] ?? null,
    };
  };
  const local = makeStorage();
  const session = makeStorage();

  function FakeXHR() {
    calls.xhr += 1;
  }
  FakeXHR.prototype.open = () => {
    calls.xhr += 1;
  };
  FakeXHR.prototype.send = () => {
    calls.xhr += 1;
  };

  const values = {
    fetch: (...args) => {
      calls.fetch += 1;
      return Promise.reject(new Error(`offline: fetch(${args[0]})`));
    },
    XMLHttpRequest: FakeXHR,
    localStorage: local,
    sessionStorage: session,
    indexedDB: {
      open: () => {
        calls.idbOpen += 1;
        throw new Error('offline: indexedDB.open');
      },
    },
  };
  for (const key of GUARDED) {
    Object.defineProperty(globalThis, key, {
      value: values[key],
      configurable: true,
      writable: true,
    });
  }

  return {
    calls,
    local,
    session,
    restore() {
      for (const key of GUARDED) {
        const d = saved.get(key);
        if (d) Object.defineProperty(globalThis, key, d);
        else delete globalThis[key];
      }
    },
  };
}

test('typing and searching make zero network requests and no storage writes', async () => {
  const spies = installSpies();
  try {
    const { screen, nextRender, rows } = mount();
    for (const q of ['र', 'रा', 'राम', 'राम कुमार', 'ज़ज़ज़', '', 'सीता']) {
      const rendered = nextRender();
      type(screen.input, q);
      await rendered;
    }
    assert.ok(rows().length > 0);
    screen.destroy();

    assert.equal(spies.calls.fetch, 0, 'fetch calls');
    assert.equal(spies.calls.xhr, 0, 'XMLHttpRequest calls');
    assert.equal(spies.calls.storageWrites, 0, 'localStorage/sessionStorage writes');
    assert.equal(spies.calls.idbOpen, 0, 'indexedDB opens');
    assert.equal(spies.local.length, 0);
    assert.equal(spies.session.length, 0);
  } finally {
    spies.restore();
  }
});

test('the screen module never references network or persistent storage APIs', () => {
  const src = readFileSync(MODULE_PATH, 'utf8');
  for (const word of GUARDED) {
    assert.ok(!src.includes(word), `searchScreen.js must not reference ${word}`);
  }
  assert.ok(!/\bimport\s*\(/.test(src), 'no dynamic imports');
  const imports = [...src.matchAll(/from\s+['"]([^'"]+)['"]/g)].map((m) => m[1]);
  assert.deepEqual(imports, ['../search/hindiSearch.js']);
});

test('2000-voter roll: last keystroke to rendered results within debounce + 100 ms', async () => {
  const { screen, renders, nextRender, rows } = mount();
  // Warm-up render so first-call JIT costs are not counted.
  let rendered = nextRender();
  type(screen.input, 'क');
  await rendered;

  for (const q of ['र', 'रा', 'राम', 'राम कुमार']) {
    const before = renders.length;
    rendered = nextRender();
    // Rapid typing: each keystroke resets the debounce; only the last renders.
    let partial = '';
    for (const k of [...q]) {
      partial += k;
      type(screen.input, partial);
    }
    const lastKeystroke = performance.now();
    const results = await rendered;
    const elapsed = renders[renders.length - 1].at - lastKeystroke;
    assert.equal(renders.length - before, 1, 'one render per burst of keystrokes');
    assert.ok(
      elapsed <= DEBOUNCE_MS + 100,
      `query ${q}: ${elapsed.toFixed(1)} ms > ${DEBOUNCE_MS + 100} ms`,
    );
    assert.ok(results.length > 0);
    assert.equal(rows().length, results.length);
  }
  screen.destroy();
});

test('destroy cancels a pending search and removes the screen', async () => {
  const { doc, screen, renders } = mount();
  type(screen.input, 'राम');
  screen.destroy();
  await wait(DEBOUNCE_MS + 30);
  assert.equal(renders.length, 0);
  assert.equal(doc.body.children.length, 0);
});
