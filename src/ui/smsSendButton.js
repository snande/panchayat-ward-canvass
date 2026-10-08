// "Send by SMS" button (issue #84): hands the worker's tally to the phone's
// SMS app, pre-filled to the team number, so it can be sent with mobile data
// off. Nothing here touches the network; the SMS app does the sending.
//
// The tally is encoded with src/tally/smsCodec.js. Pressing the button opens
// `sms:<teamSmsNumber>?body=<first message>`; when the tally needs more than
// one message, a "next part" button appears for each remaining part. With no
// teamSmsNumber configured the button stays disabled and says so.

import { encodeTallySms } from '../tally/smsCodec.js';
import { el } from './dom.js';

// Copies of the tally.* entries in src/strings.hi.json, used when the caller
// passes no string table; test/smsSendButton.test.js fails if they drift.
export const FALLBACK_TEXT = {
  'tally.sendBySms': 'एसएमएस से भेजें',
  'tally.sendNextPart': 'अगला भाग भेजें',
  'tally.smsNumberMissing': 'टीम का एसएमएस नंबर सेट नहीं है। अपने उम्मीदवार की टीम से पूछें।',
  'tally.nothingToSend': 'भेजने के लिए अभी कोई निशान नहीं है।',
  'tally.smsFailed': 'एसएमएस तैयार नहीं हो सका। फिर से कोशिश करें।',
};

/** The URI Android Chrome hands to the default SMS app. */
export function smsUri(number, body) {
  return `sms:${number}?body=${encodeURIComponent(body)}`;
}

/**
 * @param {Element} container replaced with the button block
 * @param {{
 *   getSerials: () => Iterable<number>,
 *   config: {teamSmsNumber?: string, teamTag: string, workerId: string},
 *   strings?: Record<string, string>, location?: {href: string}, log?: Function,
 * }} opts
 * @returns {{root, button, message, partsBox, partButtons: Element[]}}
 */
export function renderSmsSendButton(container, opts) {
  const doc = container.ownerDocument;
  const { getSerials, strings } = opts;
  const config = opts.config || {};
  const log = opts.log || ((...args) => console.error(...args));
  const text = (key) => (strings && Object.prototype.hasOwnProperty.call(strings, key) ? strings[key] : FALLBACK_TEXT[key]);
  const target = () => opts.location || globalThis.location;
  const number = typeof config.teamSmsNumber === 'string' ? config.teamSmsNumber.trim() : '';

  const root = el(doc, 'div', 'sms-send');
  root.setAttribute('lang', 'hi');
  const button = el(doc, 'button', 'btn-primary sms-send-button', text('tally.sendBySms'));
  button.setAttribute('type', 'button');
  const message = el(doc, 'p', 'picker-message sms-send-message');
  message.setAttribute('aria-live', 'polite');
  const partsBox = el(doc, 'div', 'sms-send-parts');
  partsBox.hidden = true;
  const partButtons = [];

  root.appendChild(button);
  root.appendChild(partsBox);
  root.appendChild(message);
  container.replaceChildren(root);

  if (!number) {
    button.setAttribute('disabled', '');
    message.textContent = text('tally.smsNumberMissing');
    return { root, button, message, partsBox, partButtons };
  }

  const open = (body) => { target().href = smsUri(number, body); };

  button.addEventListener('click', () => {
    partButtons.length = 0;
    partsBox.replaceChildren();
    partsBox.hidden = true;
    message.textContent = '';
    let parts;
    try {
      parts = encodeTallySms({ teamTag: config.teamTag, workerId: config.workerId, serials: getSerials() });
    } catch (err) {
      log('tally SMS could not be built', err);
      message.textContent = text('tally.smsFailed');
      return;
    }
    if (!parts.length) {
      message.textContent = text('tally.nothingToSend');
      return;
    }
    open(parts[0]);
    for (let i = 1; i < parts.length; i++) {
      const next = el(doc, 'button', 'btn-secondary sms-send-next', `${text('tally.sendNextPart')} ${i + 1}/${parts.length}`);
      next.setAttribute('type', 'button');
      next.addEventListener('click', () => open(parts[i]));
      partsBox.appendChild(next);
      partButtons.push(next);
    }
    partsBox.hidden = partButtons.length === 0;
  });

  return { root, button, message, partsBox, partButtons };
}
