"use strict";

// All visible shell text lives in src/strings.hi.json; elements name their
// string with data-i18n="<key>". sw.js precaches the table so this works offline.
// index.html carries the same strings as a fallback, so if the table fails to
// load the page keeps its Hindi text instead of going blank.
var STRINGS_URL = "src/strings.hi.json";
var strings = {};

// Status lines have no element in index.html to hold a fallback, so these are
// copies of their src/strings.hi.json entries, used only if the table fails to
// load. repo-ci fails if a copy drifts from the table.
var FALLBACK_STRINGS = {
  action_pending: "नीचे अपना वार्ड चुनें।",
  status_offline_ready: "ऑफ़लाइन उपयोग के लिए तैयार।",
  status_offline_failed: "ऑफ़लाइन सुविधा चालू नहीं हो सकी। इंटरनेट जाँचें और फिर से कोशिश करें।",
};

function lookup(table, key) {
  return Object.prototype.hasOwnProperty.call(table, key) ? table[key] : "";
}

function t(key) {
  return lookup(strings, key) || lookup(FALLBACK_STRINGS, key);
}

function applyStrings(root) {
  var nodes = root.querySelectorAll("[data-i18n]");
  for (var i = 0; i < nodes.length; i++) {
    var text = t(nodes[i].getAttribute("data-i18n"));
    if (text) {
      nodes[i].textContent = text;
    }
  }
  if (t("app_title")) {
    document.title = t("app_title");
  }
}

var stringsReady = fetch(STRINGS_URL)
  .then(function (response) {
    if (!response.ok) {
      throw new Error("HTTP " + response.status);
    }
    return response.json();
  })
  .then(function (table) {
    strings = table || {};
    applyStrings(document);
  })
  .catch(function (err) {
    console.error("string table failed to load", err);
  });

// The status line is a notice (DESIGN.md): tone is info, success or error.
function setStatus(key, tone) {
  return stringsReady.then(function () {
    var status = document.getElementById("status");
    if (status) {
      status.textContent = t(key);
      if (typeof status.setAttribute === "function") {
        status.setAttribute("data-tone", tone || "info");
      }
    }
  });
}

function showRetry(shown) {
  var retry = document.getElementById("status-retry");
  if (retry) {
    retry.hidden = !shown;
  }
}

// The seat header above every screen names the last loaded panchayat and ward
// (src/ui/seatHeader.js, restored from local storage, so it shows offline);
// js/picker.js re-renders it whenever a roll shows. It starts pending, so the
// "nothing loaded" link appears only once no stored seat is found. This is a
// classic script, so the module comes in through import().
var seatHeader = document.getElementById("seat-header");
if (seatHeader) {
  import("../src/ui/seatHeader.js")
    .then(function (header) {
      var stored = header.loadSeat();
      if (stored.error) {
        console.error("stored seat ignored: " + stored.error, stored.version);
      }
      // A roll shown meanwhile has already named its seat; it wins.
      if (seatHeader.getAttribute("data-state") === "pending") {
        header.renderSeatHeader(seatHeader, stored.seat);
      }
    })
    .catch(function (err) {
      console.error("seat header failed to load", err);
    });
}

// The SEC disclaimer footer below every screen (src/ui/secFooter.js): data
// source, not an official SEC app, the printed roll prevails. Static text,
// precached by sw.js, so it shows offline.
var secFooter = document.getElementById("sec-footer");
if (secFooter) {
  import("../src/ui/secFooter.js")
    .then(function (footer) {
      footer.renderSecFooter(secFooter);
    })
    .catch(function (err) {
      console.error("SEC footer failed to load", err);
    });
}

// The voter route "#/voter/<ward>/<serial>" (src/ui/voterRoute.js): one
// voter's card from the roll stored on the phone, with loading, empty and
// error states, and a back button that goes to the screen it was opened from.
// It is the only place the app shows the voter card, and it makes no network
// request: the module is precached and the roll is read from the encrypted
// store. While it is open, #app carries data-route="voter" and styles.css
// hides the other screens; the seat header and SEC footer stay.
// Its first look at location.hash happens once it has loaded, so an app
// opened at (or moved to) a voter address before then still opens it.
var voterRoute = document.getElementById("voter-route");
if (voterRoute) {
  import("../src/ui/voterRoute.js")
    .then(function (route) {
      return stringsReady.then(function () {
        route.startVoterRoute(voterRoute, strings, {
          window: window,
          main: document.getElementById("app"),
        });
      });
    })
    .catch(function (err) {
      console.error("voter route failed to load", err);
    });
}

var primaryAction = document.getElementById("primary-action");
if (primaryAction) {
  // The roll is loaded by picking a ward below (js/picker.js); the button
  // points there and moves focus to the first dropdown.
  primaryAction.addEventListener("click", function () {
    setStatus("action_pending");
    var first = document.getElementById("picker-district");
    if (first && typeof first.focus === "function") {
      first.focus();
    }
  });
}

// A failed registration shows an error notice and a retry button. Only one
// attempt runs at a time, so a double tap on retry registers once.
var registering = null;
function registerWorker() {
  if (registering) {
    return registering;
  }
  showRetry(false);
  // No explicit scope: it defaults to the directory sw.js is served from.
  registering = navigator.serviceWorker
    .register("sw.js")
    .then(function () {
      return navigator.serviceWorker.ready;
    })
    .then(function () {
      setStatus("status_offline_ready", "success");
    })
    .catch(function (err) {
      setStatus("status_offline_failed", "error");
      showRetry(true);
      console.error("service worker registration failed", err);
    })
    .then(function () {
      registering = null;
    });
  return registering;
}

if ("serviceWorker" in navigator) {
  window.addEventListener("load", registerWorker);
  var statusRetry = document.getElementById("status-retry");
  if (statusRetry) {
    statusRetry.addEventListener("click", registerWorker);
  }
}
