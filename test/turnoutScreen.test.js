// Polling-day turnout screen (issue #88), run by `npm test`.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { webcrypto } from 'node:crypto';

import { renderTurnoutScreen, FALLBACK_TEXT } from '../src/ui/turnoutScreen.js';
import { createTurnoutStore } from '../src/tally/turnoutStore.js';
import { createDocument, type } from './helpers/fakeDom.js';
import { createFakeIndexedDB } from './helpers/fakeIndexedDB.js';

const read = (rel) => readFileSync(new URL('../' + rel, import.meta.url), 'utf8');
const strings = JSON.parse(read('src/strings.hi.json'));
const WARD = 'badli-1';

function render({ idb = createFakeIndexedDB(), store, getSupporterCount = async () => 187, ...rest } = {}) {
  const doc = createDocument();
  const container = doc.createElement('div');
  const logged = [];
  const view = renderTurnoutScreen(container, {
    ward: WARD,
    getSupporterCount,
    strings,
    store: store || createTurnoutStore({ indexedDB: idb, crypto: webcrypto }),
    log: (...args) => logged.push(args),
    ...rest,
  });
  return { ...view, container, idb, logged };
}

const submit = (view) => view.root.dispatchEvent({ type: 'submit', preventDefault() {} });
const settle = () => new Promise((resolve) => setImmediate(resolve));

// Every text node under node, trimmed and non-empty.
function texts(node) {
  if (!node.tagName) return node.textContent.trim() ? [node.textContent.trim()] : [];
  return node.childNodes.flatMap(texts);
}

// Runs fn with fetch replaced by one that fails the test if it is ever called.
async function withoutNetwork(fn) {
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    throw new TypeError('Failed to fetch');
  };
  try {
    return await fn();
  } finally {
    globalThis.fetch = original;
    assert.equal(calls, 0, 'no network call is made');
  }
}

test('the turnout.* fallback copies match src/strings.hi.json', () => {
  const keys = Object.keys(strings).filter((k) => k.startsWith('turnout.'));
  assert.deepEqual(Object.keys(FALLBACK_TEXT).sort(), keys.sort());
  for (const [key, value] of Object.entries(FALLBACK_TEXT)) assert.equal(value, strings[key], key);
});

test('renders a labelled numeric input, a save button and two figures side by side', async () => {
  const view = render();
  await view.ready;
  assert.equal(view.container.firstChild, view.root);
  assert.equal(view.root.getAttribute('lang'), 'hi');
  assert.equal(view.input.tagName, 'INPUT');
  assert.equal(view.input.getAttribute('inputmode'), 'numeric');
  const label = view.root.querySelector('label');
  assert.equal(label.textContent, strings['turnout.inputLabel']);
  assert.equal(label.getAttribute('for'), view.input.getAttribute('id'));
  assert.equal(view.button.tagName, 'BUTTON');
  assert.equal(view.button.textContent, strings['turnout.save']);

  const figures = view.root.querySelector('.turnout-figures');
  const blocks = figures.querySelectorAll('.turnout-figure');
  assert.equal(blocks.length, 2);
  assert.equal(blocks[0].querySelector('.turnout-value'), view.turnoutValue);
  assert.equal(blocks[1].querySelector('.turnout-value'), view.supporterValue);
  assert.equal(blocks[0].querySelector('.turnout-caption').textContent, strings['turnout.officialCaption']);
  assert.equal(blocks[1].querySelector('.turnout-caption').textContent, strings['turnout.supporterCaption']);
});

test('before any save the turnout slot shows the Hindi placeholder and the count is shown', async () => {
  const view = render();
  await view.ready;
  assert.equal(view.turnoutValue.textContent, strings['turnout.notEntered']);
  assert.notEqual(view.turnoutValue.textContent, '0');
  assert.ok(view.turnoutValue.classList.contains('turnout-value-empty'));
  assert.equal(view.supporterValue.textContent, '187');
  assert.equal(view.supporterValue.classList.contains('turnout-value-empty'), false);
});

test('after a valid save both numbers are on the same screen', async () => {
  const view = render();
  await view.ready;
  type(view.input, '412');
  await view.save();
  assert.equal(view.turnoutValue.textContent, '412');
  assert.equal(view.supporterValue.textContent, '187');
  assert.equal(view.message.textContent, strings['turnout.saved']);
  const shown = texts(view.root);
  assert.ok(shown.includes('412'));
  assert.ok(shown.includes('187'));
});

test('the submit event saves, and Devanagari digits are shown as the stored figure', async () => {
  const real = createTurnoutStore({ indexedDB: createFakeIndexedDB(), crypto: webcrypto });
  let pending = null;
  const store = {
    loadOfficialTurnout: real.loadOfficialTurnout,
    saveOfficialTurnout: (...args) => (pending = real.saveOfficialTurnout(...args)),
  };
  const view = render({ store });
  await view.ready;
  type(view.input, '४१२');
  submit(view);
  assert.ok(pending, 'submitting the form starts a save');
  assert.equal(await pending, 412);
  await settle();
  assert.equal(view.message.textContent, strings['turnout.saved']);
  assert.equal(view.turnoutValue.textContent, '412');
});

test('a re-render shows the previously saved turnout, offline', async () => {
  const idb = createFakeIndexedDB();
  const first = render({ idb });
  await first.ready;
  type(first.input, '412');
  await first.save();

  await withoutNetwork(async () => {
    const again = render({ idb, getSupporterCount: () => 190 });
    await again.ready;
    assert.equal(again.turnoutValue.textContent, '412');
    assert.equal(again.supporterValue.textContent, '190');
  });
});

test('an invalid entry shows the Hindi error and leaves the displayed turnout unchanged', async () => {
  const view = render();
  await view.ready;
  for (const bad of ['abc', '-1', '', '   ', '1.5', '41a']) {
    type(view.input, bad);
    await view.save();
    assert.equal(view.message.textContent, strings['turnout.invalid'], bad);
    assert.equal(view.turnoutValue.textContent, strings['turnout.notEntered'], bad);
  }

  type(view.input, '412');
  await view.save();
  type(view.input, 'चार सौ');
  await view.save();
  assert.equal(view.message.textContent, strings['turnout.invalid']);
  assert.equal(view.turnoutValue.textContent, '412');
  assert.match(strings['turnout.invalid'], /[ऀ-ॿ]/);
});

test('a failed save shows an error and keeps the displayed turnout', async () => {
  const store = {
    loadOfficialTurnout: async () => 300,
    saveOfficialTurnout: async () => { throw new Error('quota'); },
  };
  const view = render({ store });
  await view.ready;
  assert.equal(view.turnoutValue.textContent, '300');
  type(view.input, '412');
  await view.save();
  assert.equal(view.message.textContent, strings['turnout.saveFailed']);
  assert.equal(view.turnoutValue.textContent, '300');
  assert.equal(view.button.hasAttribute('disabled'), false);
  assert.equal(view.logged.length, 1);
});

test('a count that cannot be read shows Hindi text, not a made-up figure', async () => {
  const view = render({ getSupporterCount: async () => { throw new Error('no tally'); } });
  await view.ready;
  assert.equal(view.supporterValue.textContent, strings['turnout.countUnavailable']);
  const broken = render({ getSupporterCount: async () => 'many' });
  await broken.ready;
  assert.equal(broken.supporterValue.textContent, strings['turnout.countUnavailable']);
});

test('the supporter count is only what getSupporterCount returns', async () => {
  let calls = 0;
  const counts = [187, 191];
  const view = render({ getSupporterCount: async () => counts[Math.min(calls++, counts.length - 1)] });
  await view.ready;
  assert.equal(calls, 1);
  assert.equal(view.supporterValue.textContent, '187');
  type(view.input, '412');
  await view.save();
  assert.equal(calls, 2, 'the count is read again after the save, not recomputed');
  assert.equal(view.supporterValue.textContent, '191');

  const source = read('src/ui/turnoutScreen.js');
  assert.doesNotMatch(source, /seenVoting|smsCodec|decodeTally/);
});

test('every rendered text is from the Hindi table or a figure', async () => {
  const allowed = new Set(Object.entries(strings).filter(([k]) => k.startsWith('turnout.')).map(([, v]) => v));
  for (const view of [render(), render({ strings: undefined })]) {
    await view.ready;
    type(view.input, 'abc');
    await view.save();
    for (const t of texts(view.root)) assert.ok(allowed.has(t) || /^\d+$/.test(t), t);
    type(view.input, '412');
    await view.save();
    for (const t of texts(view.root)) {
      assert.ok(allowed.has(t) || /^\d+$/.test(t), t);
      assert.doesNotMatch(t, /[A-Za-z]/, t);
    }
  }
});

test('a save that finishes before the stored figure loads is not overwritten by it', async () => {
  let releaseLoad;
  const store = {
    loadOfficialTurnout: () => new Promise((resolve) => { releaseLoad = () => resolve(100); }),
    saveOfficialTurnout: async (ward, value) => Number(value),
  };
  const view = render({ store });
  type(view.input, '412');
  await view.save();
  releaseLoad();
  await view.ready;
  assert.equal(view.turnoutValue.textContent, '412');
});

test('ward and getSupporterCount are required', () => {
  const container = createDocument().createElement('div');
  assert.throws(() => renderTurnoutScreen(container, { getSupporterCount: () => 1 }), TypeError);
  assert.throws(() => renderTurnoutScreen(container, { ward: WARD }), TypeError);
});
