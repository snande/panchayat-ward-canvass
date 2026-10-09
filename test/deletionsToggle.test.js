// The supplementary-deletions toggle (issue #127), run by `npm test` on the
// fake DOM: its three states, its DESIGN.md control and its tap target.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { mountDeletionsToggle, FALLBACK_TEXT, TOGGLE_STATES } from '../src/ui/deletionsToggle.js';
import { createDocument } from './helpers/fakeDom.js';

const read = (rel) => readFileSync(new URL('../' + rel, import.meta.url), 'utf8');
const strings = JSON.parse(read('src/strings.hi.json'));
const css = read('styles.css');
const design = read('DESIGN.md');

function host() {
  const doc = createDocument();
  const container = doc.createElement('div');
  doc.body.appendChild(container);
  return container;
}

/** Declarations of the rule whose selector list is exactly `selector`. */
function ruleFor(selector) {
  const re = new RegExp(`(^|\\n)${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{([^}]*)\\}`);
  const m = css.match(re);
  if (!m) return null;
  return Object.fromEntries(m[2].split(';').map((d) => d.trim()).filter(Boolean)
    .map((d) => [d.slice(0, d.indexOf(':')).trim(), d.slice(d.indexOf(':') + 1).trim()]));
}

test('the string table and the fallback copies agree', () => {
  for (const [key, value] of Object.entries(FALLBACK_TEXT)) assert.equal(strings[key], value, key);
  assert.deepEqual(TOGGLE_STATES, ['filled', 'empty', 'error']);
});

test('filled: a DESIGN.md checkbox/toggle row, off unless the setting says on; a flip reports the new state', () => {
  const container = host();
  const flips = [];
  const t = mountDeletionsToggle(container, strings, { state: 'filled', deletions: 1, checked: false, onChange: (c) => flips.push(c) });
  const row = container.querySelector('label.choice');
  assert.ok(row, 'built from the .choice control');
  assert.ok(row.classList.contains('roll-deletions-toggle'));
  assert.equal(t.input.getAttribute('class'), 'choice-input');
  assert.equal(t.input.getAttribute('type'), 'checkbox');
  assert.equal(t.input.checked, false);
  assert.equal(row.textContent, `${strings.supp_show_deletions} (1)`);
  t.input.checked = true;
  t.input.dispatchEvent({ type: 'change' });
  t.input.checked = false;
  t.input.dispatchEvent({ type: 'change' });
  assert.deepEqual(flips, [true, false]);
  assert.equal(mountDeletionsToggle(host(), strings, { state: 'filled', checked: true }).input.checked, true);
});

test('the toggle row and its checkbox are at least 48 px high and wide, with no unstyled native control', () => {
  assert.match(css, /--touch-target:\s*48px;/);
  for (const selector of ['.choice', '.choice-input']) {
    const rule = ruleFor(selector);
    assert.ok(rule, selector);
    assert.equal(rule['min-height'], 'var(--touch-target)', `${selector} min-height`);
    assert.equal(rule['min-width'], 'var(--touch-target)', `${selector} min-width`);
    assert.equal(rule.appearance, 'none', `${selector} appearance`);
  }
  // The toggle's own rules never shrink the control.
  const own = ruleFor('.roll-deletions-toggle');
  assert.ok(own);
  for (const prop of ['min-height', 'min-width', 'height', 'width', 'max-height', 'max-width']) assert.ok(!(prop in own), prop);
  assert.match(design, /Checkbox \/ toggle \| `\.choice`, `\.choice-input`/);
});

test('empty: no supplementary roll is an info line in Hindi, not an error', () => {
  const container = host();
  const t = mountDeletionsToggle(container, strings, { state: 'empty' });
  const p = container.querySelector('p.notice');
  assert.equal(p.textContent, strings.supp_no_deletions);
  assert.equal(p.getAttribute('data-tone'), 'info');
  assert.equal(p.getAttribute('role'), 'status');
  assert.equal(t.input, null);
  assert.equal(container.querySelector('button'), null);
  assert.equal(container.querySelector('input'), null);
});

test('error: a failed supplement says to retry and whom to call, and the retry is a secondary button', () => {
  const container = host();
  let retries = 0;
  mountDeletionsToggle(container, strings, { state: 'error', onRetry: () => { retries += 1; }, support: ' समन्वयक: 98290 00000 ' });
  const p = container.querySelector('p.notice');
  assert.equal(p.textContent, strings.supp_failed);
  assert.equal(p.getAttribute('data-tone'), 'error');
  assert.equal(p.getAttribute('role'), 'alert');
  assert.equal(container.querySelector('p.roll-contact').textContent, 'समन्वयक: 98290 00000');
  const retry = container.querySelector('button.btn-secondary');
  assert.equal(retry.textContent, strings.roll_retry);
  assert.equal(retry.getAttribute('type'), 'button');
  retry.dispatchEvent({ type: 'click' });
  assert.equal(retries, 1);

  // With no support line set, the neutral "contact your coordinator" line shows.
  const plain = host();
  mountDeletionsToggle(plain, null, { state: 'error' });
  assert.equal(plain.querySelector('p.roll-contact').textContent, FALLBACK_TEXT.roll_error_contact);
  assert.throws(() => mountDeletionsToggle(host(), strings, { state: 'busy' }), TypeError);
});
