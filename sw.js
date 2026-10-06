"use strict";

// Bump CACHE_VERSION whenever any precached asset changes.
const CACHE_VERSION = "v4";
const CACHE_PREFIX = "ward-canvass-shell-";
const CACHE_NAME = CACHE_PREFIX + CACHE_VERSION;

// Every shell asset (HTML, manifest, icons, CSS, JS, string table, fonts).
// The font must be here so Hindi renders with correct conjuncts offline.
const PRECACHE = [
  "./",
  "index.html",
  "manifest.webmanifest",
  "styles.css",
  "js/app.js",
  "js/picker.js",
  "config/constituency.json",
  "src/picker/wardPicker.js",
  "src/ui/wardPickerScreen.js",
  // Roll flow: enough to reopen a stored roll offline. The decoder is
  // fetched only when a new PDF is downloaded, which needs the network anyway.
  "src/roll/fetchRoll.js",
  "src/roll/rollStore.js",
  "src/roll/rollFlow.js",
  "src/ui/rollList.js",
  "src/ui/dom.js",
  "src/strings.hi.json",
  "fonts/noto-sans-devanagari-subset.woff2",
  "icons/icon-192.png",
  "icons/icon-512.png",
  "icons/icon-maskable-512.png",
];

// Last-resort page when the shell itself is missing from the cache, so the
// string table may be missing too. These are copies of offline_title and
// offline_body in src/strings.hi.json; repo-ci fails if they drift.
const OFFLINE_TEXT = {
  offline_title: "ऑफ़लाइन",
  offline_body: "इंटरनेट उपलब्ध नहीं है। कृपया बाद में पुनः प्रयास करें।",
};
const OFFLINE_HTML = [
  '<!DOCTYPE html><html lang="hi"><meta charset="utf-8">',
  '<meta name="viewport" content="width=device-width, initial-scale=1">',
  "<title>" + OFFLINE_TEXT.offline_title + "</title>",
  "<p>" + OFFLINE_TEXT.offline_body + "</p></html>",
].join("");

function cachedShell() {
  return caches.match("index.html", { cacheName: CACHE_NAME }).then(function (shell) {
    return (
      shell ||
      new Response(OFFLINE_HTML, {
        status: 503,
        headers: { "Content-Type": "text/html; charset=utf-8" },
      })
    );
  });
}

self.addEventListener("install", function (event) {
  event.waitUntil(
    caches
      .open(CACHE_NAME)
      .then(function (cache) {
        return cache.addAll(PRECACHE);
      })
      .then(function () {
        return self.skipWaiting();
      })
  );
});

self.addEventListener("activate", function (event) {
  event.waitUntil(
    caches
      .keys()
      .then(function (keys) {
        return Promise.all(
          keys
            .filter(function (key) {
              return key.indexOf(CACHE_PREFIX) === 0 && key !== CACHE_NAME;
            })
            .map(function (key) {
              return caches.delete(key);
            })
        );
      })
      .then(function () {
        return self.clients.claim();
      })
  );
});

self.addEventListener("fetch", function (event) {
  const request = event.request;
  if (request.method !== "GET") {
    return;
  }
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) {
    return;
  }

  if (request.mode === "navigate") {
    // Network first; on failure or a non-OK response (e.g. a captive portal)
    // fall back to the cached shell.
    event.respondWith(
      fetch(request)
        .then(function (response) {
          return response.ok ? response : cachedShell();
        })
        .catch(cachedShell)
    );
    return;
  }

  // Cache first for shell assets; an uncached asset while offline yields a
  // plain 503 instead of a rejected promise.
  event.respondWith(
    caches.match(request, { cacheName: CACHE_NAME }).then(function (cached) {
      return (
        cached ||
        fetch(request).catch(function () {
          return new Response("", { status: 503, statusText: "Offline" });
        })
      );
    })
  );
});
