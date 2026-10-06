import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const read = (rel) => readFileSync(new URL('../' + rel, import.meta.url), 'utf8');
const table = JSON.parse(read('src/strings.hi.json'));
const html = read('index.html');

test('string table is flat Hindi text with no Latin letters', () => {
  assert.ok(Object.keys(table).length > 0);
  for (const [key, value] of Object.entries(table)) {
    assert.equal(typeof value, 'string', key);
    assert.match(value, /[ऀ-ॿ]/, key);
    assert.doesNotMatch(value, /[A-Za-z]/, key);
  }
});

test('every data-i18n key in index.html is in the table', () => {
  const keys = [...html.matchAll(/data-i18n="([^"]+)"/g)].map((m) => m[1]);
  for (const key of ['app_title', 'empty_title', 'empty_body', 'primary_action']) {
    assert.ok(keys.includes(key), key);
  }
  for (const key of keys) {
    assert.ok(Object.hasOwn(table, key), key);
  }
});

function element(attrs = {}) {
  const listeners = {};
  return {
    textContent: '',
    getAttribute: (name) => attrs[name] ?? null,
    addEventListener: (type, fn) => { listeners[type] = fn; },
    fire: (type) => listeners[type](),
  };
}

test('app.js fills the shell from the table at startup', async () => {
  const keys = [...html.matchAll(/data-i18n="([^"]+)"/g)].map((m) => m[1]);
  const nodes = keys.map((key) => element({ 'data-i18n': key }));
  const status = element();
  const button = element();
  const requested = [];
  const document = {
    title: '',
    querySelectorAll: (sel) => (sel === '[data-i18n]' ? nodes : []),
    getElementById: (id) => ({ status, 'primary-action': button })[id] ?? null,
  };
  const fetch = async (url) => {
    requested.push(url);
    return { ok: true, status: 200, json: async () => table };
  };
  const ctx = vm.createContext({ document, fetch, navigator: {}, window: {}, console });
  vm.runInContext(read('js/app.js'), ctx);
  await ctx.stringsReady;

  assert.deepEqual(requested, ['src/strings.hi.json']);
  keys.forEach((key, i) => assert.equal(nodes[i].textContent, table[key], key));
  assert.equal(document.title, table.app_title);

  button.fire('click');
  await ctx.stringsReady;
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(status.textContent, table.action_pending);
});
