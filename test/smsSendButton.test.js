// "Send by SMS" button (issue #84): Hindi label, the sms: URI with the first
// message, next-part buttons, the missing-number state, and no network use.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { renderSmsSendButton, FALLBACK_TEXT } from '../src/ui/smsSendButton.js';
import { encodeTallySms, decodeTallySms } from '../src/tally/smsCodec.js';
import { createDocument } from './helpers/fakeDom.js';

const read = (rel) => readFileSync(new URL('../' + rel, import.meta.url), 'utf8');
const strings = JSON.parse(read('src/strings.hi.json'));
const CONFIG = { teamSmsNumber: '+919876543210', teamTag: 'cand-17', workerId: 'w3' };
const click = (node) => node.dispatchEvent({ type: 'click' });

function render(opts) {
  const doc = createDocument();
  const location = { href: '' };
  const view = renderSmsSendButton(doc.body, { location, strings, log: () => {}, ...opts });
  return { ...view, location, doc };
}

test('the button is labelled with tally.sendBySms', () => {
  assert.match(strings['tally.sendBySms'], /[ऀ-ॿ]/);
  const view = render({ getSerials: () => [1], config: CONFIG });
  assert.equal(view.button.textContent, strings['tally.sendBySms']);
  assert.equal(view.button.hasAttribute('disabled'), false);
  assert.equal(view.doc.body.querySelector('button.sms-send-button'), view.button);
});

test('without a string table the button still shows the same Hindi text', () => {
  const doc = createDocument();
  const view = renderSmsSendButton(doc.body, { getSerials: () => [1], config: {} });
  assert.equal(view.button.textContent, strings['tally.sendBySms']);
  assert.equal(view.message.textContent, strings['tally.smsNumberMissing']);
});

test('fallback copies match src/strings.hi.json', () => {
  for (const [key, value] of Object.entries(FALLBACK_TEXT)) assert.equal(value, strings[key], key);
});

test('pressing opens the SMS app with the first message for the team number', () => {
  const view = render({ getSerials: () => [12, 5, 40], config: CONFIG });
  assert.equal(view.location.href, '');
  click(view.button);
  const [first] = encodeTallySms({ teamTag: 'cand-17', workerId: 'w3', serials: [12, 5, 40] });
  assert.equal(view.location.href, `sms:+919876543210?body=${encodeURIComponent(first)}`);
  assert.ok(view.location.href.startsWith('sms:+919876543210?body=PT1%20cand-17%20w3%20'));
  assert.equal(view.partButtons.length, 0);
  assert.equal(view.partsBox.hidden, true);
});

test('getSerials is read on each press', () => {
  let serials = [1];
  const view = render({ getSerials: () => serials, config: CONFIG });
  serials = [7, 8];
  click(view.button);
  const body = decodeURIComponent(view.location.href.split('?body=')[1]);
  assert.deepEqual(decodeTallySms(body, 'cand-17').serials, [7, 8]);
});

test('a multi-part tally shows a next-part button for each remaining part', () => {
  const serials = Array.from({ length: 400 }, (_, i) => i + 1);
  const parts = encodeTallySms({ teamTag: 'cand-17', workerId: 'w3', serials });
  assert.ok(parts.length > 2);
  const view = render({ getSerials: () => serials, config: CONFIG });
  click(view.button);
  assert.equal(view.location.href, `sms:+919876543210?body=${encodeURIComponent(parts[0])}`);
  assert.equal(view.partsBox.hidden, false);
  assert.equal(view.partButtons.length, parts.length - 1);
  view.partButtons.forEach((next, i) => {
    assert.ok(next.textContent.startsWith(strings['tally.sendNextPart']));
    assert.ok(next.textContent.endsWith(`${i + 2}/${parts.length}`));
    click(next);
    assert.equal(view.location.href, `sms:+919876543210?body=${encodeURIComponent(parts[i + 1])}`);
  });
  // A second press starts over rather than piling up buttons.
  click(view.button);
  assert.equal(view.partsBox.querySelectorAll('button').length, parts.length - 1);
});

test('a missing teamSmsNumber disables the button and says so', () => {
  for (const config of [{ teamTag: 'cand-17', workerId: 'w3' }, { ...CONFIG, teamSmsNumber: '  ' }]) {
    const view = render({ getSerials: () => [1], config });
    assert.equal(view.button.hasAttribute('disabled'), true);
    assert.equal(view.message.textContent, strings['tally.smsNumberMissing']);
    click(view.button);
    assert.equal(view.location.href, '');
  }
});

test('the committed constituency config has no real team number yet', () => {
  const config = JSON.parse(read('config/constituency.json'));
  const view = render({ getSerials: () => [1], config: { ...CONFIG, teamSmsNumber: config.teamSmsNumber } });
  assert.equal(view.button.hasAttribute('disabled'), !config.teamSmsNumber);
});

test('an empty tally opens nothing and says there is nothing to send', () => {
  const view = render({ getSerials: () => [], config: CONFIG });
  click(view.button);
  assert.equal(view.location.href, '');
  assert.equal(view.message.textContent, strings['tally.nothingToSend']);
});

test('a tally that cannot be encoded shows the Hindi failure message', () => {
  const view = render({ getSerials: () => [1], config: { teamSmsNumber: '+919876543210' } });
  click(view.button);
  assert.equal(view.location.href, '');
  assert.equal(view.message.textContent, strings['tally.smsFailed']);
});

test('no fetch or XHR call on render or press', () => {
  const realFetch = globalThis.fetch;
  const realXhr = globalThis.XMLHttpRequest;
  globalThis.fetch = () => { throw new Error('network used'); };
  globalThis.XMLHttpRequest = function XMLHttpRequest() { throw new Error('network used'); };
  try {
    const serials = Array.from({ length: 400 }, (_, i) => i + 1);
    const view = render({ getSerials: () => serials, config: CONFIG });
    click(view.button);
    for (const next of view.partButtons) click(next);
    assert.ok(view.location.href.startsWith('sms:'));
  } finally {
    globalThis.fetch = realFetch;
    if (realXhr === undefined) delete globalThis.XMLHttpRequest;
    else globalThis.XMLHttpRequest = realXhr;
  }
  for (const rel of ['src/ui/smsSendButton.js', 'src/tally/smsCodec.js', 'src/decoder/sha256.js']) {
    const src = read(rel);
    assert.doesNotMatch(src, /\bfetch\s*\(|XMLHttpRequest|sendBeacon|WebSocket/, rel);
  }
});
