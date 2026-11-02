/* SOUL S1 — "He Knows Your Name" (site-soul SPEC, 2026-11-02).
 * The host brain (PRs #500/#501) already remembers the house's members —
 * name, visits, favorite artists, the last song they heard, and now the
 * last song they requested — but until today that memory only spoke
 * inside the Meechie AI widget. This lazy pack carries the same summary
 * (GET /api/brain/me, the caller's OWN session, nobody else's) to the
 * surfaces a person actually lands on: the station card, the Watch
 * header and the top of Meechie's Book. One greeting line each, painted
 * as plain text — additive paint only: no layout moves, no deck, screen
 * or audio is ever touched.
 *
 * The rails, inherited whole from the host brain:
 * - A member's facts paint ONLY on that member's own seat (the summary
 *   comes from their own session; there is no way to ask for another's).
 * - The owner is never greeted — he is the host (the same rule as the
 *   arrival alerts). Checked before the fetch and again before paint.
 * - No memory yet (first visit, or the brain unreachable) paints NOTHING
 *   — the surfaces stay exactly as they were. The second visit is the
 *   one that changes.
 * - Guests get no name and no server memory at all: this device counts
 *   its own visits in localStorage and the line says exactly that —
 *   "this device remembers you" — never a name the house doesn't know.
 * - Names and titles are inserted as text nodes only, never markup. */
(function () {
  "use strict";

  /* The greeting line, composed from stored facts + templates only —
   * no AI call, no invention: every clause below is a fact the member's
   * own doc genuinely holds, or the line is not painted at all.
   * me: the /api/brain/me summary (or null); guestVisits: this device's
   * visit count for the guest lines. Returns the line, or null. */
  function soulLine(me, guestVisits) {
    if (me && me.has && me.name) {
      var name = String(me.name).slice(0, 60).trim();
      if (!name) return null;
      var clauses = [];
      if (me.lastHeard && me.lastHeard.artist) clauses.push("last time you were here, " + String(me.lastHeard.artist).slice(0, 80) + " was on the decks");
      else if (me.lastHeard && me.lastHeard.title) clauses.push("last time, “" + String(me.lastHeard.title).slice(0, 120) + "” was playing");
      if (me.lastRequest && me.lastRequest.title) clauses.push("your last request was “" + String(me.lastRequest.title).slice(0, 120) + "”");
      if (!clauses.length && me.favArtists && me.favArtists[0]) clauses.push("your favorite here is " + String(me.favArtists[0]).slice(0, 80));
      if (clauses.length || (me.visits | 0) >= 2) return "👋 Welcome back, " + name + (clauses.length ? " — " + clauses.join(" · ") : " — good to see you again") + ".";
      return null; // first visit with nothing remembered: stay silent, like the widget does
    }
    if (me) return null; // signed in but the brain has nothing (or could not be read): today's exact behavior
    if ((guestVisits | 0) >= 2) return "👋 Back again? Good to see you — this device remembers you. Sign in and the house will know your name too.";
    return "👋 Welcome to Meechie's World — the radio is live around the clock. Make yourself at home.";
  }

  if (typeof module !== "undefined" && module.exports) { module.exports = { soulLine: soulLine }; return; }
  if (typeof window === "undefined" || typeof document === "undefined") return;
  if (window.MW_SOUL_GREET) return; window.MW_SOUL_GREET = 1;

  var OWNER = function () { try { return (typeof isOwner !== "undefined" && !!isOwner) || !!window.MW_CF_ADMIN; } catch (_) { return false; } };

  /* guest visits: counted once per browser session, kept on this device
   * only — no identity, no server write, and the line says so. */
  var guestVisits = 0;
  try {
    guestVisits = parseInt(localStorage.getItem("mw-soul-visits") || "0", 10) || 0;
    if (!sessionStorage.getItem("mw-soul-counted")) { sessionStorage.setItem("mw-soul-counted", "1"); guestVisits += 1; localStorage.setItem("mw-soul-visits", String(guestVisits)); }
  } catch (_) {}

  var SLOTS = [
    { id: "soul-greet-st", anchor: function () { return document.getElementById("st-online"); } },
    { id: "soul-greet-wb", anchor: function () { return document.querySelector("#v-watch .section-head"); } },
    { id: "soul-greet-book", anchor: function () { return document.querySelector("#v-community .section-head"); } }
  ];
  var line = null, resolved = false;
  function paint() {
    if (!resolved || !line || OWNER()) return;
    for (var i = 0; i < SLOTS.length; i++) {
      var s = SLOTS[i], el = document.getElementById(s.id);
      if (el) { if (el.textContent !== line) el.textContent = line; continue; }
      var a = null; try { a = s.anchor(); } catch (_) {}
      if (!a || !a.parentNode) continue;
      el = document.createElement("div");
      el.id = s.id; el.className = "soul-greet";
      el.style.cssText = "font-size:13.5px;font-weight:600;margin:6px 0 2px";
      el.textContent = line;
      a.parentNode.insertBefore(el, a.nextSibling);
    }
  }

  var sess = null;
  try { sess = (window.MW && MW.session && MW.session()) || null; } catch (_) {}
  var signedIn = !!(sess && sess.access_token && sess.user);
  function finish(l) { line = l; resolved = true; paint(); }
  if (!signedIn) { finish(soulLine(null, guestVisits)); }
  else if (OWNER()) { finish(null); }
  else {
    var tried = 0;
    var fetchMe = function () {
      tried++;
      fetch("/api/brain/me", { headers: { authorization: "Bearer " + sess.access_token } })
        .then(function (r) { return r.json().catch(function () { return null; }); })
        .then(function (j) {
          if (j && j.ok && j.has) { finish(soulLine(j, guestVisits)); return; }
          /* the member's visit fold (the widget reports it on the same
           * load) may land a breath after this pack: one retry, then the
           * surfaces stay exactly as they were. */
          if (tried < 2) setTimeout(fetchMe, 5000); else finish(null);
        })
        .catch(function () { if (tried < 2) setTimeout(fetchMe, 5000); else finish(null); });
    };
    fetchMe();
  }
  /* surfaces build and rebuild on their own clocks (the station card is
   * dj.js markup, the views swap under the router): re-assert the line
   * on navigation and on a slow tick — three getElementById checks, no
   * scans, and only ever the same one line of text. */
  window.addEventListener("hashchange", paint);
  setInterval(paint, 10000);
})();
