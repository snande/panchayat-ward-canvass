"use strict";

if ("serviceWorker" in navigator) {
  window.addEventListener("load", function () {
    // No explicit scope: it defaults to the directory sw.js is served from.
    navigator.serviceWorker
      .register("sw.js")
      .then(function () {
        return navigator.serviceWorker.ready;
      })
      .then(function () {
        setStatus("ऑफ़लाइन उपयोग के लिए तैयार।");
      })
      .catch(function (err) {
        setStatus("ऑफ़लाइन सुविधा चालू नहीं हो सकी।");
        console.error("service worker registration failed", err);
      });
  });
}

function setStatus(text) {
  var status = document.getElementById("status");
  if (status) {
    status.textContent = text;
  }
}
