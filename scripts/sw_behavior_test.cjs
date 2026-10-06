"use strict";
// Runs sw.js in a vm sandbox against stubbed self/caches/fetch/Response and
// asserts install, activate and fetch behaviour. Usage: node sw_behavior_test.cjs [path/to/sw.js]
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const swPath = path.resolve(process.argv[2] || path.join(__dirname, "..", "sw.js"));
const ORIGIN = "https://shell.test";

class FakeResponse {
  constructor(body, init) {
    init = init || {};
    this.body = body;
    this.status = init.status === undefined ? 200 : init.status;
  }
  get ok() {
    return this.status >= 200 && this.status < 300;
  }
}

function makeSandbox() {
  const store = new Map(); // cache name -> Map(url -> response)
  const calls = { skipWaiting: 0, claim: 0, fetch: 0 };
  const handlers = {};
  const net = { mode: "online", status: 200 };
  const abs = (r) => new URL(typeof r === "string" ? r : r.url, ORIGIN + "/").href;

  const caches = {
    open: async (name) => {
      if (!store.has(name)) store.set(name, new Map());
      const cache = store.get(name);
      return {
        addAll: async (list) =>
          list.forEach((u) => cache.set(abs(u), new FakeResponse("body:" + abs(u)))),
      };
    },
    keys: async () => [...store.keys()],
    delete: async (name) => store.delete(name),
    match: async (req, opts) => {
      const names = opts && opts.cacheName ? [opts.cacheName] : [...store.keys()];
      for (const n of names) {
        const hit = store.has(n) && store.get(n).get(abs(req));
        if (hit) return hit;
      }
      return undefined;
    },
  };
  const self = {
    location: { origin: ORIGIN },
    addEventListener: (type, fn) => (handlers[type] = fn),
    skipWaiting: async () => void calls.skipWaiting++,
    clients: { claim: async () => void calls.claim++ },
  };
  const fetchStub = async () => {
    calls.fetch++;
    if (net.mode === "offline") throw new TypeError("Failed to fetch");
    return new FakeResponse("network", { status: net.status });
  };
  const ctx = vm.createContext({
    self, caches, fetch: fetchStub, Response: FakeResponse, URL, Promise, console,
  });
  vm.runInContext(fs.readFileSync(swPath, "utf8"), ctx, { filename: swPath });
  return { ctx, store, calls, handlers, net };
}

async function dispatch(sb, type, extra) {
  const event = Object.assign({ promise: null }, extra, {
    waitUntil(p) { this.promise = p; },
    respondWith(p) { this.promise = Promise.resolve(p); },
  });
  assert.ok(sb.handlers[type], "sw.js registers a " + type + " handler");
  sb.handlers[type](event);
  return event.promise ? await event.promise : undefined;
}

const req = (url, mode, method) => ({ url: ORIGIN + url, mode: mode || "no-cors", method: method || "GET" });

const tests = {
  async "install precaches every PRECACHE entry and skips waiting"() {
    const sb = makeSandbox();
    await dispatch(sb, "install");
    const name = vm.runInContext("CACHE_NAME", sb.ctx);
    const precache = vm.runInContext("PRECACHE", sb.ctx);
    const cached = sb.store.get(name);
    assert.ok(cached, "versioned cache created");
    for (const entry of precache) {
      assert.ok(cached.has(new URL(entry, ORIGIN + "/").href), "precached " + entry);
    }
    for (const need of ["index.html", "manifest.webmanifest", "styles.css", "js/app.js", "icons/icon-192.png", "icons/icon-512.png"]) {
      assert.ok(cached.has(ORIGIN + "/" + need), "shell asset " + need);
    }
    assert.strictEqual(sb.calls.skipWaiting, 1);
  },

  async "activate deletes older versioned caches only"() {
    const sb = makeSandbox();
    await dispatch(sb, "install");
    const name = vm.runInContext("CACHE_NAME", sb.ctx);
    await sb.ctx.caches.open("ward-canvass-shell-v0");
    await sb.ctx.caches.open("unrelated");
    await dispatch(sb, "activate");
    assert.ok(!sb.store.has("ward-canvass-shell-v0"), "old cache deleted");
    assert.ok(sb.store.has(name), "current cache kept");
    assert.ok(sb.store.has("unrelated"), "foreign cache untouched");
    assert.strictEqual(sb.calls.claim, 1);
  },

  async "online navigation returns the network response"() {
    const sb = makeSandbox();
    await dispatch(sb, "install");
    const res = await dispatch(sb, "fetch", { request: req("/", "navigate") });
    assert.strictEqual(res.body, "network");
  },

  async "offline navigation renders the cached shell"() {
    const sb = makeSandbox();
    await dispatch(sb, "install");
    sb.net.mode = "offline";
    const res = await dispatch(sb, "fetch", { request: req("/some/page?utm=x", "navigate") });
    assert.strictEqual(res.body, "body:" + ORIGIN + "/index.html");
  },

  async "non-OK navigation response falls back to the shell"() {
    const sb = makeSandbox();
    await dispatch(sb, "install");
    sb.net.status = 502;
    const res = await dispatch(sb, "fetch", { request: req("/", "navigate") });
    assert.strictEqual(res.body, "body:" + ORIGIN + "/index.html");
  },

  async "offline navigation ignores stale caches and shows a Hindi page"() {
    const sb = makeSandbox();
    const old = await sb.ctx.caches.open("ward-canvass-shell-v0");
    await old.addAll(["index.html"]);
    sb.net.mode = "offline";
    const res = await dispatch(sb, "fetch", { request: req("/", "navigate") });
    assert.strictEqual(res.status, 503);
    assert.ok(/[ऀ-ॿ]/.test(res.body), "Hindi text in offline page");
  },

  async "assets are cache-first and offline misses yield 503"() {
    const sb = makeSandbox();
    await dispatch(sb, "install");
    const hit = await dispatch(sb, "fetch", { request: req("/styles.css") });
    assert.strictEqual(hit.body, "body:" + ORIGIN + "/styles.css");
    assert.strictEqual(sb.calls.fetch, 0, "cache hit does not touch the network");
    sb.net.mode = "offline";
    const miss = await dispatch(sb, "fetch", { request: req("/missing.js") });
    assert.strictEqual(miss.status, 503);
  },

  async "cross-origin and non-GET requests are not intercepted"() {
    const sb = makeSandbox();
    await dispatch(sb, "install");
    const foreign = await dispatch(sb, "fetch", { request: { url: "https://other.test/x.js", mode: "no-cors", method: "GET" } });
    const post = await dispatch(sb, "fetch", { request: req("/api", "no-cors", "POST") });
    assert.strictEqual(foreign, undefined);
    assert.strictEqual(post, undefined);
  },
};

(async () => {
  let failed = 0;
  for (const [name, fn] of Object.entries(tests)) {
    try {
      await fn();
      console.log("ok - " + name);
    } catch (err) {
      failed++;
      console.log("not ok - " + name + "\n  " + (err && err.message));
    }
  }
  process.exit(failed ? 1 : 0);
})();
