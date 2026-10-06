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
  action_pending: "वार्ड सूची लोड करने की सुविधा जल्द उपलब्ध होगी।",
  status_offline_ready: "ऑफ़लाइन उपयोग के लिए तैयार।",
  status_offline_failed: "ऑफ़लाइन सुविधा चालू नहीं हो सकी।",
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

function setStatus(key) {
  return stringsReady.then(function () {
    var status = document.getElementById("status");
    if (status) {
      status.textContent = t(key);
    }
  });
}

var primaryAction = document.getElementById("primary-action");
if (primaryAction) {
  // The ward picker is a later deliverable; until then the button says so.
  primaryAction.addEventListener("click", function () {
    setStatus("action_pending");
  });
}

if ("serviceWorker" in navigator) {
  window.addEventListener("load", function () {
    // No explicit scope: it defaults to the directory sw.js is served from.
    navigator.serviceWorker
      .register("sw.js")
      .then(function () {
        return navigator.serviceWorker.ready;
      })
      .then(function () {
        setStatus("status_offline_ready");
      })
      .catch(function (err) {
        setStatus("status_offline_failed");
        console.error("service worker registration failed", err);
      });
  });
}
