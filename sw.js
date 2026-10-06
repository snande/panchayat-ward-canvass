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
    // Network first; when offline fall back to the cached shell.
    event.respondWith(
      fetch(request).catch(function () {
        return caches.match("index.html");
      })
    );
    return;
  }

  // Cache first for shell assets.
  event.respondWith(
    caches.match(request).then(function (cached) {
      return cached || fetch(request);
    })
  );
});
