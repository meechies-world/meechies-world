/* MW TV — VIDEO ON DEMAND (Malik, 2026-11-06: "Lets start a video on
 * demand on mwtv"; launch scope A = the whole shelf, his pick 20:01 EST).
 *
 * A viewer-pick shelf in its own SPA view (#v-vod). It reads ONE static
 * file — /vod/catalog.json — exactly once per session and never calls
 * /api/* (Cloudflare minimal-use law: no D1, no keeper, no session).
 * It never touches the channel machinery in js/dj.js (TV_SURFS,
 * tvWatchdogTick, the sound claim): the live MW TV view plays only the
 * keeper lineup, and this view plays only what the viewer taps.
 *
 * Sound law: nothing autoplays and nothing preloads with sound. Every
 * playback starts inside the viewer's own tap on a title card, so
 * sound-on is the viewer's act (entry-sound law satisfied by
 * construction). Leaving the view stops everything: a MutationObserver
 * on the section's hidden flag pauses the file player and destroys
 * the YouTube player, so the shelf can never sound over another view.
 *
 * Playback shapes mirror the house patterns:
 *  - file items: a plain <video controls playsinline>; multi-part
 *    episodes chain on "ended" with the next part preloaded in a
 *    hidden warmer <video> (the empire.html playPart() pattern).
 *  - YouTube items: the IFrame API loaded the way js/dj.js loads it
 *    (promise-cached dynamic script tag), one YT.Player per pick,
 *    destroyed on the next pick and on leaving the view. Posters are
 *    the static i.ytimg.com thumbnails — no API key, no quota.
 *  - catalog entries with status "gap" (MY EMPIRE Ep1 — no public
 *    file exists yet) render as "Coming soon" cards with NO player
 *    hookup: they carry no url/parts/yt, so nothing can play them. */
(function () {
  "use strict";

  var SHELVES = ["His Shows", "Music Videos", "Islamic", "Extras"];
  var section = document.getElementById("v-vod");
  if (!section) return;
  var shelvesEl = document.getElementById("vod-shelves");
  var nowEl = document.getElementById("vod-now");
  var partEl = document.getElementById("vod-partline");
  var idleEl = document.getElementById("vod-idle");
  var videoEl = document.getElementById("vod-video");
  var warmEl = document.getElementById("vod-warmer");
  var ytBox = document.getElementById("vod-yt");
  if (!shelvesEl || !videoEl || !ytBox) return;

  var catalog = null;      // parsed catalog.json, fetched once
  var loading = false;     // a catalog fetch is in flight
  var loadFailed = false;  // last fetch failed — re-opening retries
  var curParts = [];       // file urls of the current pick, in order
  var curPart = 0;         // which part is on the player
  var ytPlayer = null;     // the live YT.Player, if any
  var activeCard = null;   // the highlighted card element

  function fmt(s) {
    if (s == null || isNaN(s)) return "";
    s = Math.max(0, Math.round(s));
    var h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), ss = s % 60;
    return (h ? h + ":" + String(m).padStart(2, "0") : m) + ":" + String(ss).padStart(2, "0");
  }
  function esc(t) {
    return String(t == null ? "" : t).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  function isOpen() { return !section.hidden; }

  /* ---------- playback control ---------- */

  function clearActive() {
    if (activeCard) { activeCard.classList.remove("on"); activeCard = null; }
  }
  function killYt() {
    if (ytPlayer) { try { ytPlayer.destroy(); } catch (e) {} ytPlayer = null; }
    ytBox.innerHTML = '<div id="vod-ytmount"></div>';
    ytBox.hidden = true;
  }
  function stopAll() {
    try { videoEl.pause(); } catch (e) {}
    videoEl.removeAttribute("src");
    try { videoEl.load(); } catch (e) {}
    videoEl.hidden = true;
    warmEl.removeAttribute("src");
    try { warmEl.load(); } catch (e) {}
    killYt();
    curParts = []; curPart = 0;
    if (partEl) partEl.textContent = "";
    if (idleEl) idleEl.hidden = false;
    clearActive();
  }
  function setNow(item, note) {
    if (!nowEl) return;
    nowEl.innerHTML = "<strong>Now playing:</strong> " + esc(item.title) +
      (item.group && item.group !== item.title ? ' <span class="vod-now-g">' + esc(item.group) + "</span>" : "") +
      (note ? ' <span class="vod-now-g">' + esc(note) + "</span>" : "");
  }

  /* File items — empire.html playPart() in miniature. */
  function playPart(n) {
    curPart = n;
    videoEl.src = curParts[n];
    if (partEl) partEl.textContent = curParts.length > 1
      ? "Part " + (n + 1) + " of " + curParts.length + " — the parts chain on their own."
      : "";
    var p = videoEl.play(); if (p && p.catch) p.catch(function () {});
    if (curParts[n + 1]) warmEl.src = curParts[n + 1];
  }
  videoEl.addEventListener("ended", function () {
    if (curPart + 1 < curParts.length) playPart(curPart + 1);
    else if (partEl) partEl.textContent = "Finished — tap another title any time.";
  });

  /* YouTube items — the dj.js ytApi() loader shape, this bundle's own
   * promise cache (lazy bundles never share code with dj.js). */
  var ytApiP = null;
  function ytApi() {
    if (window.YT && YT.Player) return Promise.resolve(true);
    if (ytApiP) return ytApiP;
    ytApiP = new Promise(function (res) {
      var tag = document.createElement("script");
      tag.src = "https://www.youtube.com/iframe_api";
      tag.onerror = function () { ytApiP = null; res(false); };
      document.head.appendChild(tag);
      var prev = window.onYouTubeIframeAPIReady;
      window.onYouTubeIframeAPIReady = function () {
        try { if (prev) prev(); } catch (e) {}
        res(!!(window.YT && YT.Player));
      };
      setTimeout(function () {
        if (!window.YT || !YT.Player) { ytApiP = null; res(false); }
      }, 7000);
    });
    return ytApiP;
  }
  function playYt(item) {
    ytApi().then(function (ok) {
      if (!isOpen()) return;                     // viewer already left
      if (!ok || !window.YT || !YT.Player) {
        if (partEl) partEl.textContent = "YouTube didn't load just now — tap the title again.";
        return;
      }
      killYt();
      ytBox.hidden = false;
      ytPlayer = new YT.Player("vod-ytmount", {
        width: "100%", height: "100%",
        videoId: item.yt,
        playerVars: { autoplay: 1, playsinline: 1, rel: 0 },
        events: {
          onReady: function (ev) { try { ev.target.playVideo(); } catch (e) {} }
        }
      });
    });
  }

  function pick(item, card) {
    stopAll();
    activeCard = card; if (card) card.classList.add("on");
    if (idleEl) idleEl.hidden = true;
    setNow(item, "");
    if (item.kind === "yt" && item.yt) {
      playYt(item);
    } else {
      curParts = (item.parts && item.parts.length)
        ? item.parts.map(function (p) { return p.url; })
        : (item.url ? [item.url] : []);
      if (!curParts.length) { stopAll(); return; }
      videoEl.hidden = false;
      playPart(0);
    }
    var stage = document.getElementById("vod-stagebox");
    if (stage && stage.scrollIntoView) stage.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  /* ---------- shelf rendering ---------- */

  function cardFor(item) {
    var playable = item.status === "ready" &&
      ((item.kind === "yt" && !!item.yt) || !!item.url || (item.parts && item.parts.length > 0));
    var card = document.createElement("button");
    card.type = "button";
    card.className = "vod-card" + (playable ? "" : " soon");
    var meta = [item.group, fmt(item.dur)].filter(Boolean).join(" · ");
    if (item.kind === "yt" && item.yt) {
      card.innerHTML =
        '<span class="vod-thumb"><img loading="lazy" alt="" src="https://i.ytimg.com/vi/' +
        esc(item.yt) + '/hqdefault.jpg"></span>' +
        '<span class="vod-t">' + esc(item.title) + "</span>" +
        (meta ? '<span class="vod-m">' + esc(meta) + "</span>" : "");
    } else {
      card.innerHTML =
        '<span class="vod-art"><span class="vod-art-g">' + esc(item.group || item.shelf) + "</span>" +
        '<span class="vod-art-t">' + esc(item.title) + "</span></span>" +
        '<span class="vod-t">' + esc(item.title) + "</span>" +
        (meta ? '<span class="vod-m">' + esc(meta) + "</span>" : "");
    }
    if (!playable) {
      var tag = document.createElement("span");
      tag.className = "vod-soon-tag";
      tag.textContent = "Coming soon";
      card.appendChild(tag);
      card.disabled = true;
      card.setAttribute("aria-disabled", "true");
      return card;
    }
    card.addEventListener("click", function () { pick(item, card); });
    return card;
  }

  function render() {
    if (!catalog || !Array.isArray(catalog.items)) return;
    shelvesEl.innerHTML = "";
    SHELVES.forEach(function (shelf) {
      var items = catalog.items.filter(function (i) { return i.shelf === shelf; });
      if (!items.length) return;
      var block = document.createElement("div");
      block.className = "vod-shelf";
      var head = document.createElement("h3");
      head.className = "vod-shelf-h";
      head.textContent = shelf;
      block.appendChild(head);
      /* Groups keep the big Music Videos shelf browsable, in the
       * catalog's own first-appearance order. */
      var groups = [];
      items.forEach(function (i) { if (groups.indexOf(i.group) < 0) groups.push(i.group); });
      groups.forEach(function (g) {
        var gItems = items.filter(function (i) { return i.group === g; });
        if (groups.length > 1) {
          var gh = document.createElement("h4");
          gh.className = "vod-group-h";
          gh.textContent = g + " · " + gItems.length;
          block.appendChild(gh);
        }
        var grid = document.createElement("div");
        grid.className = "vod-grid";
        gItems.forEach(function (i) { grid.appendChild(cardFor(i)); });
        block.appendChild(grid);
      });
      shelvesEl.appendChild(block);
    });
    if (!shelvesEl.children.length) {
      shelvesEl.innerHTML = '<p class="muted">The shelf is empty right now.</p>';
    }
  }

  /* ---------- catalog: one static fetch per session, zero /api ---------- */

  function load() {
    if (catalog || loading) { if (catalog) render(); return; }
    loading = true;
    fetch("/vod/catalog.json", { cache: "no-store" })
      .then(function (r) { if (!r.ok) throw new Error("catalog " + r.status); return r.json(); })
      .then(function (j) {
        catalog = j; loading = false; loadFailed = false;
        if (isOpen()) render();
      })
      .catch(function () {
        loading = false; loadFailed = true;
        shelvesEl.innerHTML = '<p class="muted">The shelf didn\'t load just now — leave this page and come back, and it will try again.</p>';
      });
  }

  /* ---------- view lifecycle ---------- */

  function onOpen() { load(); }
  function onClose() { stopAll(); }

  if (window.MutationObserver) {
    var wasOpen = isOpen();
    new MutationObserver(function () {
      var open = isOpen();
      if (open && !wasOpen) onOpen();
      if (!open && wasOpen) onClose();
      wasOpen = open;
    }).observe(section, { attributes: true, attributeFilter: ["hidden"] });
  }
  if (isOpen()) onOpen();
})();
