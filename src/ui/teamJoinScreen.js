// Team join screen (issue #48): shown while the device holds no team
// credentials. A candidate code field and a team passphrase field; all text
// comes from the strings table handed in. Joining itself is
// src/sync/teamAuth.js. The passphrase is cleared from its field after a
// successful join and after a rejected one (wrong passphrase); it is kept
// when only the candidate code needs fixing or the network failed, so the
// user does not have to retype it.

import { CANDIDATE_ID_PATTERN } from '../sync/teamAuth.js';
import { setNotice } from './dom.js';

const MESSAGE_FOR_CODE = {
  'invalid-code': 'team_join_bad_code',
  invalid: 'team_join_invalid',
  unauthorized: 'team_join_wrong',
};

function el(doc, tag, className, text) {
  const node = doc.createElement(tag);
  if (className) node.setAttribute('class', className);
  if (text != null) node.textContent = String(text);
  return node;
}

function field(doc, id, labelText, type) {
  const row = el(doc, 'div', 'picker-field');
  const label = el(doc, 'label', 'picker-label', labelText);
  label.setAttribute('for', id);
  const input = el(doc, 'input', 'picker-select');
  input.setAttribute('id', id);
  input.setAttribute('type', type);
  input.setAttribute('autocomplete', 'off');
  input.setAttribute('autocapitalize', 'off');
  input.setAttribute('spellcheck', 'false');
  row.appendChild(label);
  row.appendChild(input);
  return { row, input };
}

/**
 * @param {Element} container
 * @param {Record<string, string>} strings
 * @param {{joinTeam: (candidateId: string, passphrase: string) => Promise<object>,
 *   onJoined?: (auth: object) => void}} opts
 */
export function mountTeamJoin(container, strings, opts) {
  const doc = container.ownerDocument;
  const text = (key) => (strings && Object.prototype.hasOwnProperty.call(strings, key) ? strings[key] : '');

  const form = el(doc, 'form', 'team-join-form');
  form.setAttribute('novalidate', '');
  form.appendChild(el(doc, 'h2', 'team-join-title', text('team_join_title')));
  form.appendChild(el(doc, 'p', 'team-join-body', text('team_join_body')));
  const candidate = field(doc, 'team-candidate', text('team_candidate_code'), 'text');
  candidate.input.setAttribute('maxlength', '64');
  const passphrase = field(doc, 'team-passphrase', text('team_passphrase'), 'password');
  form.appendChild(candidate.row);
  form.appendChild(passphrase.row);
  const button = el(doc, 'button', 'btn-primary', text('team_join_action'));
  button.setAttribute('type', 'submit');
  form.appendChild(button);
  const message = el(doc, 'p', 'notice');
  message.setAttribute('aria-live', 'polite');
  form.appendChild(message);
  container.replaceChildren(form);

  let busy = false;

  async function submit() {
    if (busy) return;
    const candidateId = String(candidate.input.value || '').trim();
    const secret = String(passphrase.input.value || '');
    if (!candidateId || !secret.trim()) {
      setNotice(message, text('team_join_invalid'), 'error');
      return;
    }
    // Caught here, before any work, with a message that says what a code
    // may contain; the typed passphrase stays in its field.
    if (!CANDIDATE_ID_PATTERN.test(candidateId)) {
      setNotice(message, text('team_join_bad_code'), 'error');
      return;
    }
    busy = true;
    button.setAttribute('disabled', '');
    setNotice(message, text('team_join_pending'));
    try {
      const auth = await opts.joinTeam(candidateId, secret);
      passphrase.input.value = '';
      setNotice(message, '');
      if (typeof opts.onJoined === 'function') opts.onJoined(auth);
    } catch (err) {
      const code = err && err.code;
      if (code === 'unauthorized') passphrase.input.value = '';
      setNotice(message, text(MESSAGE_FOR_CODE[code] || 'team_join_failed'), 'error');
    } finally {
      busy = false;
      button.removeAttribute('disabled');
    }
  }

  form.addEventListener('submit', (event) => {
    if (event && typeof event.preventDefault === 'function') event.preventDefault();
    submit();
  });

  return {
    form,
    candidateInput: candidate.input,
    passphraseInput: passphrase.input,
    button,
    message,
    submit,
  };
}
