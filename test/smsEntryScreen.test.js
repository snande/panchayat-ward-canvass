// Coordinator's SMS entry screen (issue #85), run by `npm test`.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { webcrypto } from 'node:crypto';

import { renderSmsEntryScreen, FALLBACK_TEXT } from '../src/ui/smsEntryScreen.js';
import { createSmsInbox } from '../src/tally/smsInbox.js';
import { encodeTallySms } from '../src/tally/smsCodec.js';
import { createDocument, type } from './helpers/fakeDom.js';
import { createFakeIndexedDB } from './helpers/fakeIndexedDB.js';

const read = (rel) => readFileSync(new URL('../' + rel, import.meta.url), 'utf8');
const strings = JSON.parse(read('src/strings.hi.json'));
const css = read('styles.css');
const TEAM = 'cand-17';
const sms = (workerId, serials, teamTag = TEAM) => encodeTallySms({ teamTag, workerId, serials })[0];

function render({ inbox, teamTag = TEAM, ...rest } = {}) {
  const doc = createDocument();
  const container = doc.createElement('div');
  const logged = [];
  const own = inbox || createSmsInbox({ indexedDB: createFakeIndexedDB(), crypto: webcrypto });
  const view = renderSmsEntryScreen(container, {
    teamTag,
    strings,
    applyTallySms: own.applyTallySms,
    log: (...args) => logged.push(args),
    ...rest,
  });
  return { ...view, container, inbox: own, logged };
}

const submitEvent = (view) => view.root.dispatchEvent({ type: 'submit', preventDefault() {} });

async function waitFor(cond, ms = 5000) {
  const until = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > until) throw new Error('timed out');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

// Every text node under node that is shown, trimmed and non-empty.
function texts(node) {
  if (!node.tagName) return node.textContent.trim() ? [node.textContent.trim()] : [];
  if (node.hidden) return [];
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

test('the tally.smsEntry* fallback copies match src/strings.hi.json', () => {
  const keys = Object.keys(strings).filter((k) => k.startsWith('tally.smsEntry'));
  assert.deepEqual(Object.keys(FALLBACK_TEXT).sort(), keys.sort());
  for (const [key, value] of Object.entries(FALLBACK_TEXT)) {
    assert.equal(value, strings[key], key);
    assert.match(value, /[ऀ-ॿ]/, key);
  }
});

test('renders a labelled textarea and a Hindi add button, with nothing to report yet', () => {
  const view = render();
  assert.equal(view.container.firstChild, view.root);
  assert.equal(view.root.getAttribute('lang'), 'hi');
  assert.ok(view.root.classList.contains('panel'));
  assert.equal(view.input.tagName, 'TEXTAREA');
  const label = view.root.querySelector('label');
  assert.equal(label.textContent, strings['tally.smsEntryLabel']);
  assert.equal(label.getAttribute('for'), view.input.getAttribute('id'));
  assert.equal(view.root.querySelector('.sms-entry-title').textContent, strings['tally.smsEntryTitle']);
  assert.equal(view.root.querySelector('.sms-entry-help').textContent, strings['tally.smsEntryHelp']);
  assert.equal(view.button.tagName, 'BUTTON');
  assert.equal(view.button.getAttribute('type'), 'submit');
  assert.ok(view.button.classList.contains('btn-primary'));
  assert.equal(view.button.textContent, strings['tally.smsEntryAdd']);
  assert.equal(view.result.hidden, true);
  assert.equal(view.message.textContent, '');
  assert.equal(view.message.hasAttribute('data-tone'), false);
});

test('submitting shows how many serials were new and how many were already counted', async () => {
  const view = render();
  type(view.input, sms('w3', [1, 2, 3]));
  submitEvent(view);
  await waitFor(() => view.message.textContent);
  assert.equal(view.result.hidden, false);
  assert.equal(view.newValue.textContent, '3');
  assert.equal(view.duplicateValue.textContent, '0');
  assert.equal(view.message.textContent, strings['tally.smsEntryAdded']);
  assert.equal(view.message.getAttribute('data-tone'), 'success');
  assert.equal(view.input.value, '', 'the field is cleared for the next message');

  type(view.input, sms('w9', [2, 3, 4, 5]));
  await view.submit();
  assert.equal(view.newValue.textContent, '2');
  assert.equal(view.duplicateValue.textContent, '2');
  assert.deepEqual(await view.inbox.loadAppliedSerials(TEAM), [1, 2, 3, 4, 5]);
});

test('pasting the same message again adds nothing and says so', async () => {
  const view = render();
  const text = sms('w3', [7, 8]);
  type(view.input, text);
  await view.submit();
  type(view.input, text);
  await view.submit();
  assert.equal(view.newValue.textContent, '0');
  assert.equal(view.duplicateValue.textContent, '2');
  assert.equal(view.message.textContent, strings['tally.smsEntryNothingNew']);
  assert.equal(view.message.getAttribute('data-tone'), 'info');
  assert.deepEqual(await view.inbox.loadAppliedSerials(TEAM), [7, 8]);
});

test('each rejection shows its Hindi reason, keeps the pasted text and stores nothing', async () => {
  const good = sms('w3', [12, 13]);
  const cases = [
    [good.replace(' c.d ', ' c.e '), 'tally.smsEntryRejectedChecksum'],
    [sms('w3', [12, 13], 'cand-99'), 'tally.smsEntryRejectedTeam'],
    ['कल मिलते हैं', 'tally.smsEntryRejectedPrefix'],
    ['PT1 cand-17 w3', 'tally.smsEntryRejectedFormat'],
    ['   ', 'tally.smsEntryEmpty'],
  ];
  const view = render();
  type(view.input, sms('w1', [1]));
  await view.submit();
  for (const [text, key] of cases) {
    type(view.input, text);
    await view.submit();
    assert.equal(view.message.textContent, strings[key], text);
    assert.equal(view.message.getAttribute('data-tone'), 'error', text);
    assert.equal(view.result.hidden, true, 'only one state is shown at a time');
    assert.equal(view.input.value, text, 'the pasted text stays');
  }
  assert.deepEqual(await view.inbox.loadAppliedSerials(TEAM), [1]);
});

test('a store failure shows an error, keeps the text and lets the coordinator retry', async () => {
  let calls = 0;
  const flaky = async () => {
    calls += 1;
    if (calls === 1) throw new Error('quota');
    return { ok: true, workerId: 'w3', newSerials: [1], duplicateSerials: [] };
  };
  const view = render({ applyTallySms: flaky });
  type(view.input, sms('w3', [1]));
  await view.submit();
  assert.equal(view.message.textContent, strings['tally.smsEntryFailed']);
  assert.equal(view.message.getAttribute('data-tone'), 'error');
  assert.notEqual(view.input.value, '');
  assert.equal(view.button.hasAttribute('disabled'), false);
  assert.equal(view.logged.length, 1);
  await view.submit();
  assert.equal(view.message.textContent, strings['tally.smsEntryAdded']);
});

test('while a message is being added the panel is busy and a second tap is ignored', async () => {
  let release;
  let calls = 0;
  const slow = () => {
    calls += 1;
    return new Promise((resolve) => { release = () => resolve({ ok: true, workerId: 'w3', newSerials: [1], duplicateSerials: [] }); });
  };
  const view = render({ applyTallySms: slow });
  type(view.input, sms('w3', [1]));
  const first = view.submit();
  assert.equal(view.root.getAttribute('aria-busy'), 'true');
  assert.equal(view.button.hasAttribute('disabled'), true);
  await view.submit();
  assert.equal(calls, 1);
  release();
  await first;
  assert.equal(view.root.hasAttribute('aria-busy'), false);
  assert.equal(view.button.hasAttribute('disabled'), false);
});

test('without a teamTag the field and button are disabled and say why', async () => {
  let calls = 0;
  const view = render({ teamTag: '', applyTallySms: async () => { calls += 1; } });
  assert.equal(view.input.hasAttribute('disabled'), true);
  assert.equal(view.button.hasAttribute('disabled'), true);
  assert.equal(view.message.textContent, strings['tally.smsEntryTeamMissing']);
  await view.submit();
  assert.equal(calls, 0);
});

test('adding works with no network and survives a re-render', async () => {
  const inbox = createSmsInbox({ indexedDB: createFakeIndexedDB(), crypto: webcrypto });
  await withoutNetwork(async () => {
    const first = render({ inbox });
    type(first.input, sms('w3', [4, 5]));
    await first.submit();
    const again = render({ inbox });
    type(again.input, sms('w4', [5, 6]));
    await again.submit();
    assert.equal(again.newValue.textContent, '1');
    assert.equal(again.duplicateValue.textContent, '1');
  });
});

test('every shown text is Hindi from the table or a figure, with or without a string table', async () => {
  const allowed = new Set(Object.values(FALLBACK_TEXT));
  for (const opts of [{}, { strings: undefined }]) {
    const view = render(opts);
    type(view.input, 'not a tally');
    await view.submit();
    for (const t of texts(view.root)) assert.ok(allowed.has(t) || /^\d+$/.test(t), t);
    type(view.input, sms('w3', [1, 2]));
    await view.submit();
    for (const t of texts(view.root)) {
      assert.ok(allowed.has(t) || /^\d+$/.test(t), t);
      assert.doesNotMatch(t, /[A-Za-z]/, t);
    }
  }
});

test('the screen styles take their values from tokens, apart from 1 px hairlines', () => {
  const block = css.slice(css.indexOf('.sms-entry-title {'));
  assert.ok(block.length > 0);
  assert.doesNotMatch(block, /#[0-9a-f]{3,6}\b|rgb\(/i);
  assert.deepEqual([...block.matchAll(/\b(\d+)px\b/g)].map((m) => m[1]).filter((n) => n !== '1'), []);
  for (const sel of ['.sms-entry-input', '.sms-entry-result', '.sms-entry-figure', '.sms-entry-value']) {
    assert.ok(css.includes(`${sel} {`), sel);
  }
});

test('the screen and its inbox are precached, so they open offline', () => {
  const sw = read('sw.js');
  for (const file of ['src/tally/smsInbox.js', 'src/ui/smsEntryScreen.js', 'src/tally/smsCodec.js', 'src/decoder/sha256.js']) {
    assert.ok(sw.includes(`"${file}"`), file);
  }
});
