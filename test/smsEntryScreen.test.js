// Coordinator's SMS entry screen (issue #85): Hindi textarea and Add button,
// new/duplicate counts, Hindi rejection reasons, and no network use.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { webcrypto } from 'node:crypto';

import { mountSmsEntryScreen, FALLBACK_TEXT, resultText as formatResult } from '../src/ui/smsEntryScreen.js';
import { createSmsInbox } from '../src/tally/smsInbox.js';
import { encodeTallySms } from '../src/tally/smsCodec.js';
import { createDocument } from './helpers/fakeDom.js';
import { createFakeIndexedDB } from './helpers/fakeIndexedDB.js';

const read = (rel) => readFileSync(new URL('../' + rel, import.meta.url), 'utf8');
const strings = JSON.parse(read('src/strings.hi.json'));
const TEAM = 'cand-17';
const DEVANAGARI = /[ऀ-ॿ]/;
const sms = (serials, teamTag = TEAM) => encodeTallySms({ teamTag, workerId: 'w3', serials })[0];

function mount(opts = {}) {
  const doc = createDocument();
  const inbox = createSmsInbox({ indexedDB: createFakeIndexedDB(), crypto: webcrypto, log: () => {} });
  const view = mountSmsEntryScreen(doc.body, strings, { teamTag: TEAM, apply: inbox.applyTallySms, log: () => {}, ...opts });
  return { ...view, doc, inbox };
}

const resultText = (fresh, dup) => formatResult((key) => strings[key], fresh, dup);

test('the result names both counts in Hindi', () => {
  assert.equal(resultText(3, 2), `${strings['tally.smsEntryNewCount']} 3, ${strings['tally.smsEntryDuplicateCount']} 2`);
});

test('the tally.smsEntry* strings exist and are Hindi', () => {
  const keys = Object.keys(strings).filter((k) => k.startsWith('tally.smsEntry'));
  assert.ok(keys.length >= 6);
  for (const key of keys) assert.match(strings[key], DEVANAGARI, key);
  assert.deepEqual(Object.keys(FALLBACK_TEXT).sort(), keys.sort());
});

test('fallback copies match src/strings.hi.json', () => {
  for (const [key, value] of Object.entries(FALLBACK_TEXT)) assert.equal(value, strings[key], key);
});

test('renders a labelled textarea and an Add button in Hindi', () => {
  const view = mount();
  assert.equal(view.doc.body.querySelector('textarea'), view.textarea);
  assert.equal(view.doc.body.querySelector('button.sms-entry-add'), view.button);
  assert.equal(view.button.textContent, strings['tally.smsEntryAdd']);
  assert.equal(view.textarea.getAttribute('aria-label'), strings['tally.smsEntryLabel']);
  assert.equal(view.doc.body.querySelector('label').textContent, strings['tally.smsEntryLabel']);
  assert.equal(view.root.getAttribute('lang'), 'hi');
});

test('without a string table the screen shows the same Hindi text', () => {
  const doc = createDocument();
  const view = mountSmsEntryScreen(doc.body, null, { teamTag: TEAM, apply: async () => ({ ok: false, reason: 'team' }) });
  assert.equal(view.button.textContent, strings['tally.smsEntryAdd']);
});

test('submitting shows how many serials were new and how many duplicates', async () => {
  const view = mount();
  view.textarea.value = sms([1, 2, 3]);
  await view.submit();
  assert.equal(view.message.textContent, resultText(3, 0));
  view.textarea.value = sms([2, 3, 4, 5]);
  await view.submit();
  assert.equal(view.message.textContent, resultText(2, 2));
  view.textarea.value = sms([2, 3, 4, 5]);
  await view.submit();
  assert.equal(view.message.textContent, resultText(0, 4));
  assert.deepEqual(await view.inbox.listAppliedSerials(), [1, 2, 3, 4, 5]);
});

test('the Add button submits the pasted text', async () => {
  const calls = [];
  const view = mount({ apply: async (text, opts) => { calls.push([text, opts]); return { ok: true, workerId: 'w3', newSerials: [1], duplicateSerials: [] }; } });
  view.textarea.value = '  PT1 x  ';
  view.button.dispatchEvent({ type: 'click' });
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(calls, [['PT1 x', { teamTag: TEAM }]]);
  assert.equal(view.message.textContent, resultText(1, 0));
});

test('rejections show the Hindi reason and store nothing', async () => {
  const view = mount();
  view.textarea.value = sms([1, 2], 'cand-99');
  await view.submit();
  assert.equal(view.message.textContent, strings['tally.smsEntryRejectedTeam']);

  const good = sms([1, 2]);
  view.textarea.value = good.slice(0, -4) + (good.endsWith('0000') ? '1111' : '0000');
  await view.submit();
  assert.equal(view.message.textContent, strings['tally.smsEntryRejectedChecksum']);

  view.textarea.value = 'नमस्ते';
  await view.submit();
  assert.equal(view.message.textContent, strings['tally.smsEntryRejectedFormat']);
  assert.deepEqual(await view.inbox.listAppliedSerials(), []);
});

test('an empty paste asks for the SMS; a storage failure says so', async () => {
  const view = mount({ apply: async () => { throw new Error('disk'); } });
  await view.submit();
  assert.equal(view.message.textContent, strings['tally.smsEntryEmpty']);
  view.textarea.value = sms([1]);
  await view.submit();
  assert.equal(view.message.textContent, strings['tally.smsEntryFailed']);
  assert.equal(view.button.hasAttribute('disabled'), false);
});

test('works with no network', async () => {
  const savedFetch = globalThis.fetch;
  globalThis.fetch = undefined;
  try {
    const view = mount();
    view.textarea.value = sms([7]);
    await view.submit();
    assert.equal(view.message.textContent, resultText(1, 0));
  } finally {
    globalThis.fetch = savedFetch;
  }
  const code = read('src/ui/smsEntryScreen.js').replace(/\/\/.*$/gm, '');
  assert.ok(!/\bfetch\b|XMLHttpRequest|WebSocket|sendBeacon/.test(code));
});
