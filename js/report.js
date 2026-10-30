/* Meechie's World — problem reporter (owner directive, 2026-10-29).
 * Manual: the "Report a problem" button in the footer opens #report-dialog;
 * sending posts one report to /api/report. Auto: uncaught errors, rejected
 * promises and failed script/style loads report themselves, deduped by a
 * signature and capped at 5 per page session, so a broken page phones home
 * instead of just sitting there. This file must never throw: every block is
 * wrapped, and errors from this file itself are never reported. */
(function () {
  "use strict";

  /* Boot flag: the boot-heal script in index.html reads this on the next
   * load as proof that a previous load in this tab ran the full script
   * chain, which refreshes the one-shot heal budget. */
  try { sessionStorage.setItem("mw-boot-ok", "1"); } catch (_) {}

  var MAX_AUTO = 5;
  var autoSent = 0;
  var seen = {};

  function hash(s) {
    var h = 5381;
    for (var i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
    return ("0000000" + (h >>> 0).toString(16)).slice(-8);
  }
  function cap(v, n) { return String(v == null ? "" : v).slice(0, n); }

  function sessionId() {
    try {
      var raw = localStorage.getItem("mw-cf-session");
      if (!raw) return "";
      try {
        var j = JSON.parse(raw);
        var v = j && (j.id || j.session_id || j.uid || j.sessionId);
        return typeof v === "string" ? v.slice(0, 64) : "";
      } catch (_) {
        return /^[A-Za-z0-9_-]{8,64}$/.test(raw) ? raw : "";
      }
    } catch (_) { return ""; }
  }

  function stationState() {
    try {
      var s = window.MW_station || (window.MW && window.MW.station);
      if (!s || typeof s !== "object") return {};
      var out = {};
      ["live", "mode", "by", "pausedAt"].forEach(function (k) {
        var v = s[k];
        if (typeof v === "boolean" || typeof v === "number" || typeof v === "string") out[k] = v;
      });
      return out;
    } catch (_) { return {}; }
  }

  function base(kind, category, text, sig) {
    return {
      kind: kind,
      category: category || "other",
      text: cap(text, 500),
      page: cap(location.pathname, 200),
      view: cap(location.hash || "", 100),
      ua: cap(navigator.userAgent || "", 200),
      session: sessionId(),
      sig: cap(sig || "", 64),
      state: stationState()
    };
  }

  function beacon(payload) {
    try {
      var body = JSON.stringify(payload);
      if (navigator.sendBeacon) {
        var blob = new Blob([body], { type: "application/json" });
        if (navigator.sendBeacon("/api/report", blob)) return;
      }
      fetch("/api/report", { method: "POST", headers: { "Content-Type": "application/json" }, body: body, keepalive: true }).catch(function () {});
    } catch (_) {}
  }

  function autoReport(category, text, sig) {
    try {
      if (!sig || seen[sig]) return;
      if (autoSent >= MAX_AUTO) return;
      seen[sig] = 1;
      autoSent++;
      beacon(base("auto", category, text, sig));
    } catch (_) {}
  }

  function fromSelf(src) { return typeof src === "string" && src.indexOf("report.js") !== -1; }

  window.addEventListener("error", function (e) {
    try {
      if (!e) return;
      var target = e.target;
      if (target && target !== window && (target.src || target.href)) {
        /* capture phase: a script, stylesheet or image failed to load */
        var res = target.src || target.href || "";
        if (fromSelf(res)) return;
        autoReport("broken", "Resource failed to load: " + cap(res.split("/").pop(), 120), "res:" + hash(res));
        return;
      }
      if (fromSelf(e.filename)) return;
      var msg = (e.message || "Unknown error");
      autoReport("bug", cap(msg, 300), "err:" + hash(String(msg) + "|" + (e.filename || "") + "|" + (e.lineno || 0)));
    } catch (_) {}
  }, true);

  window.addEventListener("unhandledrejection", function (e) {
    try {
      var r = e && e.reason;
      var msg = (r && (r.message || String(r))) || "Unhandled rejection";
      if (fromSelf(msg)) return;
      autoReport("bug", cap("Unhandled rejection: " + msg, 300), "rej:" + hash(String(msg)));
    } catch (_) {}
  });

  /* ---------------- manual dialog (markup lives in index.html) --------- */
  function wire() {
    try {
      var btn = document.getElementById("mw-report-btn");
      var dlg = document.getElementById("report-dialog");
      if (!btn || !dlg) return;
      var form = document.getElementById("report-form");
      var msg = document.getElementById("report-msg");
      btn.addEventListener("click", function () {
        try { if (typeof dlg.showModal === "function") dlg.showModal(); else dlg.setAttribute("open", ""); } catch (_) {}
      });
      if (!form) return;
      form.addEventListener("submit", function (ev) {
        try {
          ev.preventDefault();
          var cat = document.getElementById("report-cat");
          var txt = document.getElementById("report-text");
          var payload = base("manual", cat ? cat.value : "other", txt ? txt.value : "", "");
          if (msg) msg.textContent = "Sending…";
          fetch("/api/report", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) })
            .then(function (r) { return r.json().catch(function () { return {}; }); })
            .then(function (j) {
              if (j && j.ok) {
                if (msg) msg.textContent = "Thanks — your report was sent. We'll get it fixed.";
                if (txt) txt.value = "";
                setTimeout(function () { try { dlg.close(); } catch (_) {} }, 1600);
              } else if (msg) {
                msg.textContent = "Sorry — that did not send. Please try again.";
              }
            })
            .catch(function () { if (msg) msg.textContent = "Sorry — that did not send. Please try again."; });
        } catch (_) {
          if (msg) msg.textContent = "Sorry — that did not send. Please try again.";
        }
      });
    } catch (_) {}
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", wire);
  else wire();
})();
