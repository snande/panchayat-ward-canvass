"use strict";

if ("serviceWorker" in navigator) {
  window.addEventListener("load", function () {
    navigator.serviceWorker.register("sw.js", { scope: "/" }).catch(function (err) {
      var status = document.getElementById("status");
      if (status) {
        status.textContent = "ऑफ़लाइन सुविधा चालू नहीं हो सकी।";
      }
      console.error("service worker registration failed", err);
    });
  });
}
