import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const read = (rel) => readFileSync(new URL('../' + rel, import.meta.url), 'utf8');
const table = JSON.parse(read('src/strings.hi.json'));
const html = read('index.html');
// [key, fallback text] for every data-i18n element in index.html.
const i18n = [...html.matchAll(/<(\w+)\b[^>]*\bdata-i18n="([^"]+)"[^>]*>(.*?)<\/\1>/gs)]
  .map((m) => [m[2], m[3].trim()]);

test('string table is flat Hindi text with no Latin letters', () => {
  assert.ok(Object.keys(table).length > 0);
  for (const [key, value] of Object.entries(table)) {
    assert.equal(typeof value, 'string', key);
    assert.match(value, /[ऀ-ॿ]/, key);
    assert.doesNotMatch(value, /[A-Za-z]/, key);
  }
});

test('home screen has the title, empty state and primary action from the table', () => {
  const keys = i18n.map(([key]) => key);
  for (const key of ['app_title', 'empty_title', 'empty_body', 'primary_action']) {
    assert.ok(keys.includes(key), key);
  }
  for (const [key, fallback] of i18n) {
    assert.equal(fallback, table[key], key);
  }
});

function element(attrs = {}, text = '') {
  const listeners = {};
  return {
    textContent: text,
    getAttribute: (name) => attrs[name] ?? null,
    addEventListener: (type, fn) => { listeners[type] = fn; },
    fire: (type) => listeners[type](),
  };
}

function runApp(fetch, navigator = {}) {
  const nodes = i18n.map(([key, fallback]) => element({ 'data-i18n': key }, fallback));
  const status = element();
  const button = element();
  const window = element();
  const document = {
    title: '',
    querySelectorAll: (sel) => (sel === '[data-i18n]' ? nodes : []),
    getElementById: (id) => ({ status, 'primary-action': button })[id] ?? null,
  };
  const errors = [];
  const ctx = vm.createContext({
    document, fetch, navigator, window, console: { error: (...a) => errors.push(a) },
  });
  vm.runInContext(read('js/app.js'), ctx);
  return { ctx, nodes, status, button, window, document, errors };
}

const settle = () => new Promise((resolve) => setImmediate(resolve));

test('app.js fills the shell from the table at startup', async () => {
  const requested = [];
  const changed = { ...table, empty_title: 'नया शीर्षक', action_pending: 'नई स्थिति' };
  const app = runApp(async (url) => {
    requested.push(url);
    return { ok: true, status: 200, json: async () => changed };
  });
  await app.ctx.stringsReady;

  assert.deepEqual(requested, ['src/strings.hi.json']);
  i18n.forEach(([key], i) => assert.equal(app.nodes[i].textContent, changed[key], key));
  assert.equal(app.document.title, table.app_title);

  app.button.fire('click');
  await settle();
  assert.equal(app.status.textContent, 'नई स्थिति', 'the loaded table wins over the fallback copy');
});

for (const [name, fetch] of [
  ['a non-OK response', async () => ({ ok: false, status: 404, json: async () => ({}) })],
  ['a network or cache miss', async () => { throw new TypeError('Failed to fetch'); }],
]) {
  test(`app.js keeps Hindi text on screen after ${name}`, async () => {
    const serviceWorker = { register: async () => ({}), ready: Promise.resolve() };
    const app = runApp(fetch, { serviceWorker });
    await app.ctx.stringsReady;
    i18n.forEach(([key, fallback], i) => {
      assert.equal(app.nodes[i].textContent, fallback, key);
      assert.ok(fallback.length > 0, key);
    });
    assert.equal(app.errors.length, 1);

    app.button.fire('click');
    await settle();
    assert.equal(app.status.textContent, table.action_pending, 'button feedback falls back to Hindi');

    app.window.fire('load');
    await settle();
    await settle();
    assert.equal(app.status.textContent, table.status_offline_ready);
  });
}
