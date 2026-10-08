// The number recording panels and the screens around them follow DESIGN.md:
// shared panel header with the close action, consent badge, toned notices, a
// quiet revoke, a red confirm and a busy state. Also checks DESIGN.md and
// styles.css agree on tokens and controls, and that the home screen shows one
// state at a time.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { webcrypto } from 'node:crypto';
import vm from 'node:vm';

import { mountContactPanel } from '../src/ui/contactPanel.js';
import { mountVoterCard } from '../src/ui/voterCard.js';
import { mountCallListFlow } from '../src/ui/callListFlow.js';
import { mountSeenVotingMark } from '../src/ui/seenVotingMark.js';
import { mountTeamJoin } from '../src/ui/teamJoinScreen.js';
import { renderTurnoutScreen } from '../src/ui/turnoutScreen.js';
import { setNotice } from '../src/ui/dom.js';
import { createContactStore } from '../src/contacts/contactStore.js';
import { createDocument, type } from './helpers/fakeDom.js';
import { createFakeIndexedDB } from './helpers/fakeIndexedDB.js';

const read = (rel) => readFileSync(new URL('../' + rel, import.meta.url), 'utf8');
const strings = JSON.parse(read('src/strings.hi.json'));
const css = read('styles.css');
const design = read('DESIGN.md');
const WARD = '17/125/6313/1';
const ENTRY = { serial: 7, name: 'सुनीता देवी', relative: 'रामलाल', age: 41, gender: 'स्त्री', house: '12' };

async function waitFor(cond, ms = 5000) {
  const until = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > until) throw new Error('timed out');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

const newStore = () => createContactStore({ indexedDB: createFakeIndexedDB(), crypto: webcrypto, storage: null });
const classes = (node) => node.className.split(/\s+/);
const tone = (node) => node.getAttribute('data-tone');
const submitOf = (node) => node.dispatchEvent({ type: 'submit', preventDefault() {} });
const ruleFor = (selector) => {
  const m = css.match(new RegExp(`(?:^|\\n)${selector.replace(/[.[\]"=:()>]/g, '\\$&')}\\s*\\{([^}]*)\\}`));
  return m ? m[1] : null;
};
const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
};

test('src/ui/dom.js declares each shared helper once', () => {
  const source = read('src/ui/dom.js');
  for (const name of ['el', 'setNotice', 'panelHeader', 'voterMeta']) {
    const count = source.split(`export function ${name}(`).length - 1;
    assert.equal(count, 1, name);
  }
});

test('DESIGN.md names every :root token and styles.css defines every one it names', () => {
  const root = css.match(/:root\s*\{([^}]*)\}/)[1];
  const defined = new Set([...root.matchAll(/(--[\w-]+)\s*:/g)].map((m) => m[1]));
  const named = new Set([...design.matchAll(/`(--[\w-]+)`/g)].map((m) => m[1]));
  for (const token of defined) assert.ok(named.has(token), `DESIGN.md lacks ${token}`);
  for (const token of named) assert.ok(defined.has(token), `styles.css lacks ${token}`);
});

test('every shared control DESIGN.md names has a rule in styles.css', () => {
  const table = design.slice(design.indexOf('## Shared controls'), design.indexOf('## States'));
  const names = [...table.matchAll(/`\.([\w-]+)`/g)].map((m) => m[1]);
  assert.ok(names.length >= 10);
  const selectors = [...css.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/([^{}]+)\{/g)]
    .flatMap((m) => m[1].split(',').map((sel) => sel.trim()));
  for (const name of names) assert.ok(selectors.includes(`.${name}`), `styles.css has no .${name} rule`);
});

test('feedback colours come from tokens, and the danger and quiet buttons are tap-sized', () => {
  for (const sel of ['.notice', '.notice[data-tone="success"]', '.notice[data-tone="error"]', '.badge',
    '.alert[data-tone="error"]', '.btn-danger', '.btn-quiet-danger', '.panel', '.choice']) {
    const body = ruleFor(sel);
    assert.ok(body, sel);
    assert.doesNotMatch(body, /#[0-9a-f]{3,8}\b|rgba?\(/i, sel);
  }
  assert.match(ruleFor('.btn-danger'), /min-height:\s*var\(--touch-target\)/);
  assert.match(css, /\.btn-quiet,\n\.btn-quiet-danger\s*\{[^}]*min-height:\s*var\(--touch-target\)/);
  assert.match(css, /\.notice:empty,\n\.notice\[hidden\]\s*\{[^}]*display:\s*none/);
  // The Devanagari face has one weight; titles must not be synthesised bold.
  assert.match(ruleFor('.panel-title'), /font-weight:\s*400/);
  assert.match(ruleFor('.empty-state h2'), /font-weight:\s*400/);
});

test('the string table carries no tick glyph; the success badge draws it in CSS', () => {
  assert.doesNotMatch(strings.contact_consent_on_record, /[✓✔]/);
  assert.match(ruleFor('.badge[data-tone="success"]::before'), /border-width/);
});

test('setNotice sets the text and tone, and clearing it drops the tone', () => {
  const p = createDocument().createElement('p');
  setNotice(p, 'ठीक', 'success');
  assert.equal(p.textContent, 'ठीक');
  assert.equal(tone(p), 'success');
  setNotice(p, '');
  assert.equal(p.textContent, '');
  assert.equal(tone(p), null);
  setNotice(p, 'खुल रहा है');
  assert.equal(tone(p), 'info');
});

test('contact panel: panel header with details and close, badge once consented, toned notices', async () => {
  const doc = createDocument();
  const panel = mountContactPanel(doc.body, strings, { contacts: newStore(), wardId: WARD, entry: ENTRY, log: () => {} });
  assert.ok(classes(panel.root).includes('panel'));
  assert.equal(tone(panel.message), 'info');
  assert.equal(panel.message.textContent, strings.contact_loading);
  await panel.ready;

  const header = panel.root.children[0];
  assert.ok(classes(header).includes('panel-header'));
  assert.equal(panel.closeButton.parentNode, header);
  assert.ok(classes(panel.closeButton).includes('btn-quiet'));
  assert.equal(header.querySelector('p.panel-subtitle').textContent, 'रामलाल · उम्र 41 · मकान नं. 12');
  assert.equal(panel.badge.hidden, true);

  panel.consentButton.dispatchEvent({ type: 'click' });
  await waitFor(() => panel.message.textContent === strings.contact_consent_done);
  assert.equal(tone(panel.message), 'success');
  assert.equal(panel.badge.hidden, false);
  assert.equal(panel.badge.textContent, strings.contact_consent_on_record);
  assert.ok(classes(panel.phoneInput).includes('field-phone'));

  type(panel.phoneInput, '123');
  submitOf(panel.saveButton.parentNode);
  assert.equal(panel.message.textContent, strings.contact_phone_invalid);
  assert.equal(tone(panel.message), 'error');

  assert.ok(classes(panel.revokeButton).includes('btn-quiet-danger'));
  panel.revokeButton.dispatchEvent({ type: 'click' });
  assert.ok(classes(panel.confirmBox).includes('alert'));
  assert.equal(tone(panel.confirmBox), 'error');
  assert.ok(classes(panel.confirmRevokeButton).includes('btn-danger'));
  assert.equal(panel.message.textContent, '');
  assert.equal(tone(panel.message), null);
});

test('contact panel: a failed read shows an error and a retry that reads again', async () => {
  let fail = true;
  const contacts = {
    getContact: async () => {
      if (fail) throw new Error('locked');
      return { wardId: WARD, serial: 7, phone: '9876543210', consentAt: 'x' };
    },
  };
  const doc = createDocument();
  const panel = mountContactPanel(doc.body, strings, { contacts, wardId: WARD, entry: ENTRY, log: () => {} });
  await panel.ready;
  assert.equal(panel.message.textContent, strings.contact_failed);
  assert.equal(tone(panel.message), 'error');
  assert.equal(panel.retryButton.hidden, false);
  assert.ok(classes(panel.retryButton).includes('btn-secondary'));
  assert.equal(panel.consentButton.hidden, true);
  assert.equal(panel.saveButton.parentNode.hidden, true);

  fail = false;
  panel.retryButton.dispatchEvent({ type: 'click' });
  await waitFor(() => panel.phoneInput.value === '9876543210');
  assert.equal(panel.retryButton.hidden, true);
  assert.equal(panel.message.textContent, '');
  assert.equal(panel.saveButton.parentNode.hidden, false);
});

test('contact panel is busy while a save is in flight', async () => {
  const pending = deferred();
  const contacts = { getContact: async () => null, recordConsent: () => pending.promise };
  const doc = createDocument();
  const panel = mountContactPanel(doc.body, strings, { contacts, wardId: WARD, entry: ENTRY, log: () => {} });
  await panel.ready;
  panel.consentButton.dispatchEvent({ type: 'click' });
  assert.equal(panel.root.getAttribute('aria-busy'), 'true');
  pending.resolve({ wardId: WARD, serial: 7, phone: null, consentAt: 'x' });
  await waitFor(() => panel.message.textContent === strings.contact_consent_done);
  assert.equal(panel.root.getAttribute('aria-busy'), null);
});

test('voter card: same panel header, consent as a choice row, toned failure', async () => {
  const doc = createDocument();
  const contacts = {
    getContact: async () => null,
    recordConsent: async () => { throw new Error('disk full'); },
  };
  const card = mountVoterCard(doc.body, strings, { contacts, wardId: WARD, entry: ENTRY, log: () => {} });
  await card.ready;
  assert.ok(classes(card.root).includes('panel'));
  assert.ok(classes(card.closeButton).includes('btn-quiet'));
  assert.ok(classes(card.closeButton.parentNode).includes('panel-header'));
  assert.ok(classes(card.consentInput.parentNode).includes('choice'));
  assert.ok(classes(card.confirmRevokeButton).includes('btn-danger'));
  card.consentInput.checked = true;
  card.consentInput.dispatchEvent({ type: 'change' });
  await waitFor(() => card.message.textContent === strings.contact_failed);
  assert.equal(tone(card.message), 'error');
});

test('voter card is busy while a save is in flight, and a bad number is an error that refocuses the field', async () => {
  const pending = deferred();
  const contacts = { getContact: async () => null, recordConsent: () => pending.promise };
  const doc = createDocument();
  const card = mountVoterCard(doc.body, strings, { contacts, wardId: WARD, entry: ENTRY, log: () => {} });
  await card.ready;
  card.consentInput.checked = true;
  card.consentInput.dispatchEvent({ type: 'change' });
  assert.equal(card.root.getAttribute('aria-busy'), 'true');
  pending.resolve({ wardId: WARD, serial: 7, phone: null, consentAt: 'x' });
  await waitFor(() => card.message.textContent === strings.contact_consent_done);
  assert.equal(card.root.getAttribute('aria-busy'), null);
  assert.equal(tone(card.message), 'success');

  let focused = 0;
  card.phoneInput.focus = () => { focused += 1; };
  type(card.phoneInput, '123');
  submitOf(card.saveButton.parentNode);
  assert.equal(card.message.textContent, strings.contact_phone_invalid);
  assert.equal(tone(card.message), 'error');
  assert.equal(focused, 1);
});

test('call list: same panel with close in the header and an info empty state', async () => {
  const doc = createDocument();
  const screen = mountCallListFlow(doc.body, strings, {
    contacts: { listConsented: async () => [] }, wardId: WARD, entries: [ENTRY],
    assignments: { loadAssignments: async () => [], assignVoter: async () => {} },
    roster: { listWorkers: async () => [], addWorker: async () => {} },
    log: () => {},
  });
  await screen.ready;
  assert.ok(classes(screen.root).includes('panel'));
  assert.ok(classes(screen.closeButton.parentNode).includes('panel-header'));
  assert.equal(screen.message.textContent, strings.call_list_empty);
  assert.equal(tone(screen.message), 'info');
});

test('call list: adding a worker is a success notice; a failed assignment is an error after the reload', async () => {
  const workers = [];
  const doc = createDocument();
  const screen = mountCallListFlow(doc.body, strings, {
    contacts: { listConsented: async () => [{ serial: 7, phone: '9876543210' }] }, wardId: WARD, entries: [ENTRY],
    assignments: { loadAssignments: async () => [], assignVoter: async () => { throw new Error('disk full'); } },
    roster: {
      listWorkers: async () => [...workers],
      addWorker: async (name) => { workers.push({ workerId: 'w1', workerName: name }); },
    },
    log: () => {},
  });
  await screen.ready;
  assert.equal(screen.message.textContent, '');

  type(screen.nameInput, 'रमेश');
  submitOf(screen.addButton.parentNode);
  await waitFor(() => screen.message.textContent === strings.call_worker_added);
  assert.equal(tone(screen.message), 'success');

  const select = screen.root.querySelector('select.call-assign');
  select.value = 'w1';
  select.dispatchEvent({ type: 'change' });
  await waitFor(() => screen.message.textContent === strings.call_assign_failed);
  assert.equal(tone(screen.message), 'error');
});

test('seen-voting control: info while loading, error on a failed read, success once marked, none when unmarked', async () => {
  const doc = createDocument();
  const firstRead = deferred();
  const view = mountSeenVotingMark(doc.body, strings, {
    marks: { getMark: () => firstRead.promise, markSeen: async (wardId, serial, workerId) => ({ wardId, serial, workerId, markedAt: 't' }) },
    wardId: WARD, entry: ENTRY, log: () => {},
  });
  assert.ok(classes(view.root).includes('panel'));
  assert.equal(view.status.textContent, strings.seen_mark_loading);
  assert.equal(tone(view.status), 'info');
  firstRead.resolve(null);
  await view.ready;
  // Unmarked: the status line is empty and carries no tone.
  assert.equal(view.status.textContent, '');
  assert.equal(tone(view.status), null);

  await view.mark();
  // Marked: a success badge replaces the button, and the status line is empty.
  assert.equal(view.button.hidden, true);
  assert.equal(view.badge.hidden, false);
  assert.ok(classes(view.badge).includes('badge'));
  assert.equal(view.badge.textContent, strings.seen_marked);
  assert.equal(tone(view.badge), 'success');
  assert.equal(view.status.textContent, '');
  assert.equal(view.message.textContent, strings.seen_mark_saved);
  assert.equal(tone(view.message), 'success');

  const failed = mountSeenVotingMark(createDocument().body, strings, {
    marks: { getMark: async () => { throw new Error('locked'); }, markSeen: async () => { throw new Error('x'); } },
    wardId: WARD, entry: ENTRY, log: () => {},
  });
  await failed.ready;
  assert.equal(failed.status.textContent, strings.seen_mark_read_failed);
  assert.equal(tone(failed.status), 'error');
  await failed.mark();
  assert.equal(failed.message.textContent, strings.seen_mark_failed);
  assert.equal(tone(failed.message), 'error');
});

test('team join: errors for a missing or bad code and a refused join, info while pending', async () => {
  const doc = createDocument();
  const pending = deferred();
  const screen = mountTeamJoin(doc.body, strings, { joinTeam: () => pending.promise });

  await screen.submit();
  assert.equal(screen.message.textContent, strings.team_join_invalid);
  assert.equal(tone(screen.message), 'error');

  type(screen.candidateInput, 'bad code!');
  type(screen.passphraseInput, 'secret words');
  await screen.submit();
  assert.equal(screen.message.textContent, strings.team_join_bad_code);
  assert.equal(tone(screen.message), 'error');

  type(screen.candidateInput, 'cand-1');
  const joining = screen.submit();
  assert.equal(screen.message.textContent, strings.team_join_pending);
  assert.equal(tone(screen.message), 'info');
  pending.reject(Object.assign(new Error('no'), { code: 'unauthorized' }));
  await joining;
  assert.equal(screen.message.textContent, strings.team_join_wrong);
  assert.equal(tone(screen.message), 'error');
});

test('turnout screen: errors for invalid input and a failed save, success after a save', async () => {
  let fail = false;
  const store = {
    loadOfficialTurnout: async () => null,
    saveOfficialTurnout: async (ward, value) => {
      if (fail) throw new Error('disk full');
      return Number(value);
    },
  };
  const doc = createDocument();
  const container = doc.createElement('div');
  const view = renderTurnoutScreen(container, {
    ward: 'badli-1', getSupporterCount: async () => 3, strings, store, log: () => {},
  });
  await view.ready;

  type(view.input, 'abc');
  await view.save();
  assert.equal(view.message.textContent, strings['turnout.invalid']);
  assert.equal(tone(view.message), 'error');

  type(view.input, '412');
  await view.save();
  assert.equal(view.message.textContent, strings['turnout.saved']);
  assert.equal(tone(view.message), 'success');

  fail = true;
  type(view.input, '413');
  await view.save();
  assert.equal(view.message.textContent, strings['turnout.saveFailed']);
  assert.equal(tone(view.message), 'error');
});

test('home screen shows one state at a time: loading notice, button hidden until the picker is up', () => {
  const html = read('index.html');
  assert.match(html, /<button[^>]*id="primary-action"[^>]*\bhidden\b/);
  assert.match(html, /<p class="notice" data-tone="info" data-i18n="picker_loading">/);
  assert.match(html, /<button[^>]*class="btn-secondary status-retry"[^>]*data-i18n="roll_retry"[^>]*hidden/);
  assert.match(ruleFor('.picker:has(> .notice:only-child)'), /border:\s*0/);
  assert.match(ruleFor('.status-retry'), /margin-top:\s*var\(--space-3\)/);
  assert.match(read('js/picker.js'), /getElementById\('primary-action'\)[\s\S]*action\.hidden = false/);
});

test('a failed offline set-up is an error notice with a retry that registers again, once per tap burst', async () => {
  const node = () => {
    const attrs = {};
    const listeners = {};
    return {
      textContent: '', hidden: true,
      setAttribute(name, value) { attrs[name] = String(value); },
      getAttribute: (name) => attrs[name] ?? null,
      addEventListener: (type, fn) => { listeners[type] = fn; },
      fire: (type) => listeners[type](),
    };
  };
  const status = node();
  const retry = node();
  const window = node();
  let attempts = 0;
  const second = deferred();
  const serviceWorker = {
    register: () => {
      attempts += 1;
      return attempts === 1 ? Promise.reject(new Error('blocked')) : second.promise;
    },
    ready: Promise.resolve(),
  };
  const ctx = vm.createContext({
    document: {
      title: '',
      querySelectorAll: () => [],
      getElementById: (id) => ({ status, 'status-retry': retry })[id] ?? null,
    },
    fetch: async () => ({ ok: true, status: 200, json: async () => strings }),
    navigator: { serviceWorker }, window, console: { error() {} },
  });
  vm.runInContext(read('js/app.js'), ctx);
  window.fire('load');
  await waitFor(() => status.textContent === strings.status_offline_failed);
  assert.equal(status.getAttribute('data-tone'), 'error');
  await waitFor(() => retry.hidden === false);

  // A double tap while the second attempt is in flight registers once.
  retry.fire('click');
  retry.fire('click');
  assert.equal(retry.hidden, true);
  assert.equal(attempts, 2);
  second.resolve({});
  await waitFor(() => status.textContent === strings.status_offline_ready);
  assert.equal(status.getAttribute('data-tone'), 'success');
  assert.equal(attempts, 2);
});
