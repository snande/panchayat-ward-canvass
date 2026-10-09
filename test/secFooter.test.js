// SEC disclaimer footer (issue #131): three static Hindi lines below every
// screen (data source, not an official SEC app, the printed roll prevails),
// rendered by js/app.js at startup, precached for offline use, storing
// nothing and styled from DESIGN.md tokens.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

import {
  renderSecFooter, SEC_FOOTER_LINES, SEC_FOOTER_SOURCE, SEC_FOOTER_NOT_OFFICIAL, SEC_FOOTER_PRINTED_PREVAILS,
} from '../src/ui/secFooter.js';
import { createDocument } from './helpers/fakeDom.js';

const appUrl = new URL('../js/app.js', import.meta.url);
const read = (rel) => readFileSync(new URL('../' + rel, import.meta.url), 'utf8');
const table = JSON.parse(read('src/strings.hi.json'));
const css = read('styles.css');

const SOURCE = 'स्रोत: राज्य निर्वाचन आयोग, राजस्थान की प्रकाशित मतदाता सूची';
const NOT_OFFICIAL = 'यह राज्य निर्वाचन आयोग का आधिकारिक ऐप नहीं है';
const PRINTED_PREVAILS = 'मुद्रित मतदाता सूची ही मान्य है';

function mount() {
  const doc = createDocument();
  const root = doc.createElement('footer');
  doc.body.appendChild(root);
  return root;
}

test('the footer copy is the three exact Hindi statements, in order', () => {
  assert.equal(SEC_FOOTER_SOURCE, SOURCE);
  assert.equal(SEC_FOOTER_NOT_OFFICIAL, NOT_OFFICIAL);
  assert.equal(SEC_FOOTER_PRINTED_PREVAILS, PRINTED_PREVAILS);
  assert.deepEqual([...SEC_FOOTER_LINES], [SOURCE, NOT_OFFICIAL, PRINTED_PREVAILS]);
  assert.ok(Object.isFrozen(SEC_FOOTER_LINES));
});

test('renderSecFooter renders the three statements as footer lines', () => {
  const root = mount();
  renderSecFooter(root);
  assert.equal(root.children.length, 3);
  assert.deepEqual(root.children.map((c) => c.textContent), [SOURCE, NOT_OFFICIAL, PRINTED_PREVAILS]);
  for (const line of root.children) {
    assert.equal(line.tagName, 'P');
    assert.equal(line.className, 'sec-footer-text');
  }
});

test('re-rendering replaces the lines instead of duplicating them; a missing root is a no-op', () => {
  const root = mount();
  renderSecFooter(root);
  renderSecFooter(root);
  assert.equal(root.children.length, 3);
  assert.equal(renderSecFooter(null), null);
});

test('the footer is static: no network, no storage, no party, symbol or candidate branding', () => {
  const source = read('src/ui/secFooter.js').replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
  for (const api of [/fetch\s*\(/, /XMLHttpRequest/, /localStorage/, /sessionStorage/, /indexedDB/, /caches\./, /deviceDb/]) {
    assert.doesNotMatch(source, api, String(api));
  }
  const text = SEC_FOOTER_LINES.join(' ');
  for (const brand of [/पार्टी/, /(^|\s)दल(\s|$)/, /भाजपा/, /कांग्रेस/, /प्रत्याशी/, /उम्मीदवार/, /चिह्न/, /चिन्ह/, /प्रतीक/,
    /party/i, /symbol/i, /candidate/i, /BJP/i, /congress/i]) {
    assert.doesNotMatch(text, brand, String(brand));
  }
});

test('index.html has one footer container, after <main> and outside every screen container', () => {
  const html = read('index.html');
  assert.equal(html.split('id="sec-footer"').length - 1, 1);
  const at = html.indexOf('id="sec-footer"');
  assert.ok(at > html.indexOf('</main>'), 'the footer sits below <main>, so below every screen');
  const before = html.slice(0, at);
  assert.equal((before.match(/<section\b/g) || []).length, (before.match(/<\/section>/g) || []).length, 'not inside a section');
  assert.match(html, /<footer id="sec-footer" class="sec-footer"><\/footer>/);
  assert.ok(at < html.indexOf('</body>'));
});

test('sw.js precaches the footer so it renders offline', () => {
  const sw = read('sw.js');
  const precache = sw.slice(sw.indexOf('PRECACHE = ['), sw.indexOf('];', sw.indexOf('PRECACHE = [')));
  assert.match(precache, /"src\/ui\/secFooter\.js"/);
  assert.match(precache, /"src\/ui\/dom\.js"/, 'its one import is precached too');
  assert.match(precache, /"js\/app\.js"/);
});

// vm.constants.USE_MAIN_CONTEXT_DEFAULT_LOADER arrived in Node 20.12 and 21.7.
const canImport = Boolean(vm.constants && vm.constants.USE_MAIN_CONTEXT_DEFAULT_LOADER);
const skip = !canImport && 'no vm dynamic import';

async function waitFor(cond, ms = 5000) {
  const until = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > until) throw new Error('timed out');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

test('at startup js/app.js renders the footer', { skip }, async () => {
  assert.match(read('js/app.js'), /renderSecFooter\(secFooter\)/);
  const footer = mount();
  const errors = [];
  const ctx = vm.createContext({
    document: {
      title: '',
      querySelectorAll: () => [],
      getElementById: (id) => (id === 'sec-footer' ? footer : null),
    },
    fetch: async () => ({ ok: true, status: 200, json: async () => table }),
    navigator: {},
    window: { addEventListener() {} },
    console: { error: (...a) => errors.push(a) },
  });
  // app.js is a classic script: its import() resolves against its own path.
  const script = new vm.Script(read('js/app.js'), {
    filename: fileURLToPath(appUrl),
    importModuleDynamically: vm.constants.USE_MAIN_CONTEXT_DEFAULT_LOADER,
  });
  script.runInContext(ctx);
  await waitFor(() => footer.children.length > 0 || errors.length > 0);
  assert.deepEqual(errors, []);
  assert.deepEqual(footer.children.map((c) => c.textContent), [SOURCE, NOT_OFFICIAL, PRINTED_PREVAILS]);
});

// The innermost `selector { body }` rules naming a selector, merged.
function ruleFor(selector) {
  const out = {};
  for (const m of css.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if (!m[1].split(',').map((s) => s.trim()).includes(selector)) continue;
    for (const decl of m[2].split(';')) {
      const i = decl.indexOf(':');
      if (i > 0) out[decl.slice(0, i).trim()] = decl.slice(i + 1).trim();
    }
  }
  return out;
}
const rootTokens = ruleFor(':root');
const hex = (token) => rootTokens[token.match(/var\((--[\w-]+)\)/)[1]];
const luminance = (h) => {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255)
    .map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const contrast = (a, b) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};

test('the footer follows DESIGN.md: token colours and spacing, text at least 16 px, light contrast at least 7:1', () => {
  assert.match(read('DESIGN.md'), /\| SEC footer \| `\.sec-footer`, `\.sec-footer-text` \|/);
  const strip = ruleFor('.sec-footer');
  const text = ruleFor('.sec-footer-text');
  for (const value of [strip.background, strip.color, text.color, text['font-size'], strip.padding, strip['margin-top']]) {
    assert.match(value, /^var\(--[\w-]+\)$/, value);
  }
  const px = (v) => Number(v.replace('rem', '')) * (v.endsWith('rem') ? 16 : 1);
  assert.ok(px(rootTokens[text['font-size'].slice(4, -1)]) >= 16, 'font size');
  assert.ok(contrast(hex(text.color), hex(strip.background)) >= 7, 'footer text contrast');
  assert.ok(contrast(hex(strip.color), hex(strip.background)) >= 7, 'footer strip contrast');
});
