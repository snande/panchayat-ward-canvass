"use strict";

// Bump CACHE_VERSION whenever any precached asset changes.
const CACHE_VERSION = "v26";
const CACHE_PREFIX = "ward-canvass-shell-";
const CACHE_NAME = CACHE_PREFIX + CACHE_VERSION;

// Every shell asset (HTML, manifest, icons, CSS, JS, string table, fonts).
// The font must be here so Hindi renders with correct conjuncts offline.
// scripts/check_startup_budget.mjs (npm test) fails if the page, stylesheet,
// manifest, font or any module statically imported by index.html's scripts
// is missing here.
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
  // The navigation frame and its default screen, the ward roll.
  "src/ui/appFrame.js",
  "src/ui/wardRollScreen.js",
  // The seat header above every screen: the loaded panchayat and ward.
  "src/ui/seatHeader.js",
  // The SEC disclaimer footer below every screen: static, so it shows offline.
  "src/ui/secFooter.js",
  // Roll flow: enough to reopen a stored roll offline. The decoder is
  // fetched only when a new PDF is downloaded, which needs the network anyway.
  "src/roll/fetchRoll.js",
  "src/roll/rollStore.js",
  "src/roll/rollFlow.js",
  // The supplementary-deletions toggle and its setting. The merge
  // (src/roll/applySupplements.js) is fetched, like the decoder, only after a
  // supplementary roll is downloaded.
  "src/roll/rollSettings.js",
  "src/ui/deletionsToggle.js",
  // The device database and key shared by the roll, contact and assignment stores.
  "src/storage/deviceDb.js",
  "src/crypto/deviceKey.js",
  "src/contacts/contactStore.js",
  "src/contacts/contactSync.js",
  "src/calls/assignmentStore.js",
  "src/calls/callList.js",
  "src/calls/workerRoster.js",
  "src/ui/rollList.js",
  "src/ui/rollSearch.js",
  "src/ui/searchScreen.js",
  "src/ui/contactPanel.js",
  // Team join: the join screen and the stored sync credentials.
  "src/sync/teamAuth.js",
  "src/sync/syncEngine.js",
  "src/ui/teamJoinScreen.js",
  "src/search/hindiSearch.js",
  // The search screen and its engine, so search works in airplane mode.
  "src/search/voterSearch.js",
  "src/ui/voterSearchScreen.js",
  "src/households/householdIndex.js",
  "src/households/householdCard.js",
  // The voter route and its card: opens a stored voter offline.
  "src/ui/voterRoute.js",
  "src/card/voterCard.js",
  "src/ui/callListScreen.js",
  "src/ui/callListFlow.js",
  // Tally by SMS: works with mobile data off.
  "src/decoder/sha256.js",
  "src/tally/smsCodec.js",
  "src/ui/smsSendButton.js",
  // Coordinator's SMS entry: pasted tally SMS merge into the team tally.
  "src/tally/smsInbox.js",
  "src/ui/smsEntryScreen.js",
  // SMS tally in the ward roll: pasted SMS become seen-voting marks.
  "src/tally/smsMarks.js",
  "src/ui/smsTallyView.js",
  // The team's SMS number: an encrypted, synced team record.
  "src/team/teamSmsNumber.js",
  // Seen-voting marks and the polling-day count beside the official turnout.
  "src/tally/seenVotingStore.js",
  "src/tally/turnoutStore.js",
  "src/ui/seenVotingMark.js",
  "src/ui/turnoutScreen.js",
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

// Cloudflare Pages serves index.html as a 308 redirect to "/", so a fetched
// copy of it arrives with response.redirected set. Chrome refuses a
// redirected response for a navigation and shows its no-internet page
// instead, so every cached copy is rebuilt as a plain, non-redirected one.
function cleanResponse(response) {
  if (!response.redirected) {
    return Promise.resolve(response);
  }
  return response.arrayBuffer().then(function (body) {
    return new Response(body, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  });
}

// The shell is the root entry; index.html is a fallback for caches that
// lack it.
function cachedShell() {
  return caches
    .match("./", { cacheName: CACHE_NAME })
    .then(function (shell) {
      return shell || caches.match("index.html", { cacheName: CACHE_NAME });
    })
    .then(function (shell) {
      return shell
        ? cleanResponse(shell)
        : new Response(OFFLINE_HTML, {
            status: 503,
            headers: { "Content-Type": "text/html; charset=utf-8" },
          });
    });
}

// Like cache.addAll, but stores redirect-free copies. Everything is fetched
// before anything is stored, and any failure rejects, so install stays
// all-or-nothing.
function precacheAll(cache) {
  return Promise.all(
    PRECACHE.map(function (url) {
      return fetch(url).then(function (response) {
        if (!response.ok) {
          throw new Error("precache " + url + ": HTTP " + response.status);
        }
        return cleanResponse(response);
      });
    })
  ).then(function (responses) {
    return Promise.all(
      responses.map(function (response, i) {
        return cache.put(PRECACHE[i], response);
      })
    );
  });
}

self.addEventListener("install", function (event) {
  event.waitUntil(
    caches
      .open(CACHE_NAME)
      .then(precacheAll)
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
  // The sync API is network-only: a cached pull would hand back stale
  // records and a stale cursor.
  if (url.pathname.indexOf("/sync/") === 0) {
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
