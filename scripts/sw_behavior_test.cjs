"use strict";
// Runs sw.js in a vm sandbox against stubbed self/caches/fetch/Response and
// asserts install, activate and fetch behaviour. Usage: node sw_behavior_test.cjs [path/to/sw.js]
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const os = require("os");
const { pathToFileURL } = require("url");

const swPath = path.resolve(process.argv[2] || path.join(__dirname, "..", "sw.js"));
const ORIGIN = "https://shell.test";
const REPO = path.join(__dirname, "..");

class FakeResponse {
  constructor(body, init) {
    init = init || {};
    this.body = body;
    this.status = init.status === undefined ? 200 : init.status;
    this.statusText = init.statusText || "";
    this.headers = init.headers || {};
    this.redirected = false;
  }
  async arrayBuffer() {
    return this.body;
  }
  get ok() {
    return this.status >= 200 && this.status < 300;
  }
}

function makeSandbox() {
  const store = new Map(); // cache name -> Map(url -> response)
  const calls = { skipWaiting: 0, claim: 0, fetch: 0 };
  const handlers = {};
  // prettyUrls mimics Cloudflare Pages: /index.html is a 308 to "/", so the
  // fetched copy is the root page with redirected set. body overrides the
  // response body. files serves the repo's real files instead of placeholders.
  const net = { mode: "online", status: 200, prettyUrls: true, body: null, files: false };
  const abs = (r) => new URL(typeof r === "string" ? r : r.url, ORIGIN + "/").href;

  const caches = {
    open: async (name) => {
      if (!store.has(name)) store.set(name, new Map());
      const cache = store.get(name);
      return {
        addAll: async (list) =>
          list.forEach((u) => cache.set(abs(u), new FakeResponse("body:" + abs(u)))),
        put: async (u, response) => void cache.set(abs(u), response),
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
  const fetchStub = async (r) => {
    calls.fetch++;
    if (net.mode === "offline") throw new TypeError("Failed to fetch");
    let url = abs(r);
    const redirected = net.prettyUrls && url === ORIGIN + "/index.html";
    if (redirected) url = ORIGIN + "/";
    let body = net.body || "body:" + url;
    if (net.files) {
      const rel = new URL(url).pathname.slice(1) || "index.html";
      body = fs.readFileSync(path.join(REPO, rel), "utf8");
    }
    const response = new FakeResponse(body, { status: net.status });
    response.redirected = redirected;
    return response;
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

  async "install stores no redirected responses"() {
    const sb = makeSandbox();
    await dispatch(sb, "install");
    const cached = sb.store.get(vm.runInContext("CACHE_NAME", sb.ctx));
    for (const [url, response] of cached) {
      assert.ok(!response.redirected, "redirected copy cached for " + url);
    }
    assert.strictEqual(cached.get(ORIGIN + "/index.html").body, "body:" + ORIGIN + "/");
  },

  async "install fails if any precache fetch fails"() {
    const sb = makeSandbox();
    sb.net.status = 404;
    await assert.rejects(dispatch(sb, "install"));
    assert.strictEqual(sb.calls.skipWaiting, 0);
  },

  async "online navigation returns the network response"() {
    const sb = makeSandbox();
    await dispatch(sb, "install");
    sb.net.body = "network";
    const res = await dispatch(sb, "fetch", { request: req("/", "navigate") });
    assert.strictEqual(res.body, "network");
  },

  async "offline navigation renders the cached shell"() {
    const sb = makeSandbox();
    await dispatch(sb, "install");
    sb.net.mode = "offline";
    const res = await dispatch(sb, "fetch", { request: req("/some/page?utm=x", "navigate") });
    assert.strictEqual(res.body, "body:" + ORIGIN + "/");
    assert.strictEqual(res.status, 200);
    assert.ok(!res.redirected, "navigation must not get a redirected response");
  },

  async "offline navigation strips a redirect from a cached shell"() {
    // A cache filled by cache.addAll under Cloudflare Pages: no "./" entry
    // and index.html stored with redirected set.
    const sb = makeSandbox();
    const cache = await sb.ctx.caches.open(vm.runInContext("CACHE_NAME", sb.ctx));
    const shell = new FakeResponse("shell", { status: 200 });
    shell.redirected = true;
    await cache.put("index.html", shell);
    sb.net.mode = "offline";
    const res = await dispatch(sb, "fetch", { request: req("/", "navigate") });
    assert.strictEqual(res.body, "shell");
    assert.strictEqual(res.status, 200);
    assert.ok(!res.redirected, "navigation must not get a redirected response");
  },

  async "non-OK navigation response falls back to the shell"() {
    const sb = makeSandbox();
    await dispatch(sb, "install");
    sb.net.status = 502;
    const res = await dispatch(sb, "fetch", { request: req("/", "navigate") });
    assert.strictEqual(res.body, "body:" + ORIGIN + "/");
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
    const before = sb.calls.fetch;
    const hit = await dispatch(sb, "fetch", { request: req("/styles.css") });
    assert.strictEqual(hit.body, "body:" + ORIGIN + "/styles.css");
    assert.strictEqual(sb.calls.fetch, before, "cache hit does not touch the network");
    sb.net.mode = "offline";
    const miss = await dispatch(sb, "fetch", { request: req("/missing.js") });
    assert.strictEqual(miss.status, 503);
  },

  async "offline after a roll is loaded, the precached search screen still returns results"() {
    // Install against the real files, cut the network, then load the search
    // screen and every module it imports through the worker only: a module
    // missing from PRECACHE comes back 503 and fails here.
    const sb = makeSandbox();
    sb.net.files = true;
    sb.net.prettyUrls = false;
    await dispatch(sb, "install");
    sb.net.mode = "offline";
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sw-offline-search-"));
    try {
      fs.writeFileSync(path.join(dir, "package.json"), '{"type":"module"}');
      const queue = ["src/ui/voterSearchScreen.js"];
      const seen = new Set();
      while (queue.length) {
        const rel = queue.shift();
        if (seen.has(rel)) continue;
        seen.add(rel);
        const res = await dispatch(sb, "fetch", { request: req("/" + rel) });
        assert.strictEqual(res.status, 200, "offline copy of " + rel);
        fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
        fs.writeFileSync(path.join(dir, rel), res.body);
        for (const m of String(res.body).matchAll(/^import[^;]*?from\s+['"]([^'"]+)['"]/gm)) {
          queue.push(path.posix.normalize(path.posix.join(path.posix.dirname(rel), m[1])));
        }
      }
      for (const need of ["src/search/voterSearch.js", "src/search/hindiSearch.js"]) {
        assert.ok(seen.has(need), "search screen loads " + need);
      }
      const { createVoterSearchScreen, DEBOUNCE_MS } = await import(pathToFileURL(path.join(dir, "src/ui/voterSearchScreen.js")).href);
      const { createDocument, type } = await import(pathToFileURL(path.join(REPO, "test/helpers/fakeDom.js")).href);
      const doc = createDocument();
      const host = doc.createElement("section");
      const screen = createVoterSearchScreen(host, null, { log: () => {} });
      await screen.setRolls(new Map([["17/125/6313/3", [
        { serial: 145, name: "रमेश कुमार", relative: "सुरेश", age: 42, gender: "पुरुष", house: "12" },
        { serial: 146, name: "सीता देवी", relative: "मोहन", age: 38, gender: "स्त्री", house: "12" },
      ]]]));
      type(screen.input, "रमेश");
      await new Promise((resolve) => setTimeout(resolve, DEBOUNCE_MS + 20));
      assert.strictEqual(screen.state, "filled");
      assert.deepStrictEqual(screen.results.map((r) => r.key), ["3:145"]);
      assert.ok(screen.list.querySelector("mark"), "match highlighted offline");
      type(screen.input, "3/146");
      await new Promise((resolve) => setTimeout(resolve, DEBOUNCE_MS + 20));
      assert.strictEqual(screen.results[0].key, "3:146");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
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
