"use strict";

// Bump CACHE_VERSION whenever any precached asset changes.
const CACHE_VERSION = "v1";
const CACHE_PREFIX = "ward-canvass-shell-";
const CACHE_NAME = CACHE_PREFIX + CACHE_VERSION;

// Every shell asset (HTML, manifest, icons, CSS, JS, fonts). No fonts are
// bundled yet; add them here when they are.
const PRECACHE = [
  "./",
  "index.html",
  "manifest.webmanifest",
  "css/app.css",
  "js/app.js",
  "icons/icon-192.png",
  "icons/icon-512.png",
  "icons/icon-maskable-512.png",
];

const OFFLINE_HTML =
  '<!DOCTYPE html><html lang="hi"><meta charset="utf-8">' +
  '<meta name="viewport" content="width=device-width, initial-scale=1">' +
  "<title>ऑफ़लाइन</title><p>इंटरनेट उपलब्ध नहीं है। कृपया बाद में पुनः प्रयास करें।</p></html>";

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
