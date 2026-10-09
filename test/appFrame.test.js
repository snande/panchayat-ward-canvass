// The navigation frame (issue #110): index.html has the header slot, main
// region, bottom navigation bar and footer slot; the nav bar has one entry per
// existing screen, the call list included, built from shared controls; and
// every asset the shell loads is precached by sw.js so the installed app opens
// with no network.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { mountAppFrame, FALLBACK_TEXT, FRAME_SLOTS, SCREENS, DEFAULT_SCREEN } from '../src/ui/appFrame.js';
import { createDocument } from './helpers/fakeDom.js';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const read = (rel) => readFileSync(new URL('../' + rel, import.meta.url), 'utf8');
const strings = JSON.parse(read('src/strings.hi.json'));
const html = read('index.html');
const css = read('styles.css');

const SHARED_CONTROLS = ['btn-primary', 'btn-secondary', 'btn-quiet', 'btn-quiet-danger', 'btn-danger',
  'field-input', 'field-select', 'picker-select', 'choice-input', 'nav-item'];

function mount(onNavigate) {
  const doc = createDocument();
  const nav = doc.createElement('nav');
  doc.body.appendChild(nav);
  const frame = mountAppFrame(nav, strings, { onNavigate });
  return { doc, nav, frame };
}

test('the fallback copies match the string table', () => {
  for (const [key, value] of Object.entries(FALLBACK_TEXT)) assert.equal(value, strings[key], key);
  for (const screen of SCREENS) assert.ok(strings[screen.key], screen.key);
});

test('index.html has the header slot, main region, bottom nav bar and footer slot, in that order', () => {
  const at = (id) => html.indexOf(`id="${id}"`);
  for (const id of Object.values(FRAME_SLOTS)) assert.equal(html.split(`id="${id}"`).length - 1, 1, id);
  assert.ok(at(FRAME_SLOTS.header) < at(FRAME_SLOTS.main), 'header slot above main');
  assert.ok(at(FRAME_SLOTS.main) < at(FRAME_SLOTS.footer), 'footer slot below main');
  assert.match(html, /<main id="app">/);
  assert.match(html, /<nav id="nav-bar" class="nav-bar"><\/nav>/);
  // The slots this issue does not fill stay empty containers.
  assert.match(html, /<div id="seat-header" class="seat-header" data-state="pending" aria-live="polite"><\/div>/);
  assert.match(html, /<footer id="sec-footer" class="sec-footer"><\/footer>/);
  // The ward-roll screen lives in the main region.
  assert.ok(at('roll') > at(FRAME_SLOTS.main) && at('roll') < html.indexOf('</main>'));
});

test('the nav bar is fixed to the bottom at phone width and the page leaves room for it', () => {
  const rule = (sel) => (css.match(new RegExp(`(?:^|\\n)${sel.replace(/[.[\]"=:()>]/g, '\\$&')}\\s*\\{([^}]*)\\}`)) || [])[1];
  assert.match(rule('.nav-bar'), /position:\s*fixed/);
  assert.match(rule('.nav-bar'), /bottom:\s*0/);
  assert.match(rule('body'), /padding-bottom:\s*calc\(var\(--touch-target\)/);
  assert.match(html, /<meta name="viewport" content="width=device-width, initial-scale=1">/);
});

test('one nav entry per existing screen, the call list included, the ward roll current by default', () => {
  const { nav, frame } = mount();
  const items = nav.querySelectorAll('button.nav-item');
  assert.deepEqual(items.map((b) => b.getAttribute('data-screen')), ['roll', 'calls', 'turnout', 'sms']);
  assert.deepEqual(items.map((b) => b.textContent), SCREENS.map((s) => strings[s.key]));
  assert.ok(items.some((b) => b.textContent === strings.nav_calls), 'the call list is reachable');
  assert.equal(nav.getAttribute('aria-label'), strings.nav_label);
  assert.equal(DEFAULT_SCREEN, 'roll');
  assert.equal(frame.current(), 'roll');
  assert.deepEqual(items.map((b) => b.getAttribute('aria-current')), ['page', null, null, null]);
  for (const item of items) assert.equal(item.getAttribute('type'), 'button');
});

test('tapping an entry navigates; an entry the app could not open stays not current', () => {
  const asked = [];
  const { nav, frame } = mount((id) => {
    asked.push(id);
    return id !== 'turnout';
  });
  const item = (id) => nav.querySelectorAll('button.nav-item').find((b) => b.getAttribute('data-screen') === id);
  item('calls').dispatchEvent({ type: 'click' });
  assert.equal(frame.current(), 'calls');
  assert.equal(item('calls').getAttribute('aria-current'), 'page');
  assert.equal(item('roll').getAttribute('aria-current'), null);
  item('turnout').dispatchEvent({ type: 'click' });
  assert.equal(frame.current(), 'calls');
  assert.deepEqual(asked, ['calls', 'turnout']);
});

test('no native control in index.html or the frame lacks a shared control class', () => {
  for (const m of html.matchAll(/<(button|input|select|textarea)\b([^>]*)>/g)) {
    const cls = (m[2].match(/class="([^"]*)"/) || [])[1] || '';
    assert.ok(SHARED_CONTROLS.some((c) => cls.split(/\s+/).includes(c)), m[0]);
  }
  const { nav } = mount();
  for (const tag of ['button', 'input', 'select', 'textarea']) {
    for (const node of nav.querySelectorAll(tag)) {
      assert.ok(SHARED_CONTROLS.some((c) => node.className.split(/\s+/).includes(c)), node.className);
    }
  }
});

// Every module the shell loads at startup: js/picker.js and everything it
// statically imports, and the modules js/app.js imports.
function startupModules() {
  const statics = (rel) => [...read(rel).matchAll(/^(?:import|export)\s[^;]*?from\s+['"]([^'"]+)['"]/gm)].map((m) => m[1]);
  const toRepo = (from, spec) => relative(repoRoot, fileURLToPath(new URL(spec, new URL('../' + from, import.meta.url))))
    .split(sep).join('/');
  const seen = new Set();
  const walk = (rel) => {
    if (seen.has(rel)) return;
    seen.add(rel);
    for (const spec of statics(rel)) walk(toRepo(rel, spec));
  };
  walk('js/picker.js');
  for (const m of read('js/app.js').matchAll(/import\("([^"]+)"\)/g)) walk(toRepo('js/app.js', m[1]));
  return seen;
}

test('sw.js precaches every shell asset: the page, its links and scripts, and every startup module', () => {
  const sw = read('sw.js');
  const precache = sw.slice(sw.indexOf('PRECACHE = ['), sw.indexOf('];', sw.indexOf('PRECACHE = [')));
  const listed = new Set([...precache.matchAll(/"([^"]+)"/g)].map((m) => m[1]));
  const assets = new Set(['index.html', 'js/app.js']);
  for (const m of html.matchAll(/<(?:link|script)\b[^>]*\b(?:href|src)="([^"]+)"/g)) assets.add(m[1]);
  for (const module of startupModules()) assets.add(module);
  assert.ok(assets.has('src/ui/appFrame.js') && assets.has('src/ui/wardRollScreen.js'));
  for (const asset of assets) assert.ok(listed.has(asset), `sw.js does not precache ${asset}`);
});
