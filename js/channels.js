/* ================================================================
 * CHANNELS — Meechie's World satellite-style listener radio
 * (owner order, 2026-11-03: "make it like satellite radio").
 *
 * A listener gets the master screen (the permanent band up top —
 * it never leaves) PLUS this channel setup in the Radio view:
 *   - LIVE: the live station itself, through the exact Tune In
 *     doors every listener already uses (MW_DJ / tuneIn).
 *   - Genre channels from the daypart lanes (functions/api/
 *     station.js aiDjDefaultDayparts, PR #604): each one is an
 *     endless auto-picked stream FOR THIS LISTENER ONLY.
 *
 * SEPARATION / CONTROL LAW: a channel pick is personal listening.
 * This file NEVER writes shared station state — no station doc,
 * no database handle, no save call, no POST. Its only station
 * interactions are
 * the read/listen doors: MW_DJ.listening(), MW_DJ.start(),
 * MW_DJ.stop(), the global tuneIn(), and pausing this tab's own
 * station element when a genre channel takes this tab's sound.
 * Genre playback lives in ONE YouTube player owned by this file,
 * so a genre channel cannot fight the live radio: the moment the
 * station sounds on this tab by any door, the genre player yields
 * (see the reconciliation tick), and taking a genre channel first
 * silences this tab's station follow — never the station itself.
 *
 * Picks ride the same doors as booth search: the /api/ytsearch
 * relay (which server-side drops banned/unplayable videos) plus
 * this device's shared age-lock list (localStorage
 * "mw-dj-ageskip" — the playability filter the booth keeps).
 * A video that still dies on YouTube's wall here is added to that
 * same list and the channel rolls on — no dead air, no skips.
 * ================================================================ */
(() => {
  "use strict";
  const card = document.getElementById("chan-card");
  if (!card || window.MW_CHAN) return;

  const $ = (s) => card.querySelector(s);
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const fmt = (sec) => { sec = Math.max(0, Math.round(+sec || 0)); const m = Math.floor(sec / 60), s = sec % 60; return m + ":" + String(s).padStart(2, "0"); };

  /* ---------- channel definitions (lanes from the daypart grid) ---------- */
  function chanDefs() {
    return [
      { id: "live", num: 1, name: "LIVE — MWR 24/7", tag: "The live station: Meechie's booth & Auto-DJ — the same thing everybody hears" },
      { id: "traplove", num: 2, name: "TRAP LOVE", tag: "The trap love-making lane — trap first, sexy R&B woven in", seeds: ["trap love songs mix", "trap music mix", "female rappers mix", "sexy r&b slow jams", "r&b love songs mix"] },
      { id: "weed", num: 3, name: "WEED WAKE-UP", tag: "Weed-smoking wake-up music — wake & bake, chill and lifted", seeds: ["weed smoking music mix", "wake and bake music mix", "stoner music mix", "chill hip hop mix"] },
      { id: "oldschool", num: 4, name: "OLD SCHOOL", tag: "Old school hip hop and the classics", seeds: ["old school hip hop mix", "old school hip hop classics", "90s hip hop mix"] },
      { id: "pop", num: 5, name: "POP", tag: "Pop hits, all day", seeds: ["pop hits mix", "pop hits 2025 mix", "top pop songs mix"] },
      { id: "country", num: 6, name: "COUNTRY", tag: "Country hits and modern country", seeds: ["country hits mix", "country music hits", "modern country mix"] },
      { id: "rock", num: 7, name: "ROCK", tag: "Rock hits and classic rock", seeds: ["rock hits mix", "classic rock mix", "rock music mix"] },
      { id: "edm", num: 8, name: "EDM", tag: "EDM and dance — festival energy", seeds: ["edm mix", "edm festival mix", "dance music mix"] },
    ];
  }
  const DEFS = chanDefs();
  const defOf = (id) => DEFS.find((d) => d.id === id) || null;

  /* ---------- the playability filter (shared with the booth) ---------- */
  const AGE_KEY = "mw-dj-ageskip";
  function chanBanned() { try { return new Set(JSON.parse(localStorage.getItem(AGE_KEY) || "[]")); } catch (_) { return new Set(); } }
  function chanBanId(id) {
    if (!id) return;
    try { const a = JSON.parse(localStorage.getItem(AGE_KEY) || "[]"); if (!a.includes(id)) { a.push(id); localStorage.setItem(AGE_KEY, JSON.stringify(a.slice(-400))); } } catch (_) {}
  }
  /* Pure pick filter: relay results in, playable queue items out.
   * Drops banned (age-locked/unplayable), already-seen, duplicates,
   * and runtimes that cannot carry a channel (unknown = allowed). */
  function chanFilterPicks(results, bannedSet, seenSet) {
    const out = [], inList = new Set();
    for (const r of Array.isArray(results) ? results : []) {
      if (!r || !r.id || inList.has(r.id)) continue;
      if (bannedSet && bannedSet.has(r.id)) continue;
      if (seenSet && seenSet.has(r.id)) continue;
      const dur = +r.dur || 0;
      if (dur > 0 && (dur < 30 || dur > 2400)) continue;
      inList.add(r.id);
      out.push({ id: r.id, title: r.title || "YouTube video", dur, thumb: r.thumb || ("https://i.ytimg.com/vi/" + r.id + "/hqdefault.jpg") });
    }
    return out;
  }
  /* Seed rotation: walk the lane's seeds, then walk deeper pages. */
  function chanSeedAt(def, n) {
    const seeds = (def && def.seeds) || [];
    if (!seeds.length) return { q: "", page: 1 };
    return { q: seeds[n % seeds.length], page: 1 + (Math.floor(n / seeds.length) % 3) };
  }

  /* ---------- per-channel queues (this listener only) ---------- */
  const queues = {}; // id -> { list:[], seen:Set, seedN:0, loading:false, hist:[] }
  function queueOf(def) {
    if (!queues[def.id]) queues[def.id] = { list: [], seen: new Set(), seedN: 0, loading: false, hist: [] };
    return queues[def.id];
  }
  async function chanFetch(def, q) {
    try {
      const ctl = typeof AbortSignal !== "undefined" && AbortSignal.timeout ? { signal: AbortSignal.timeout(9000) } : {};
      const r = await fetch("/api/ytsearch?q=" + encodeURIComponent(q.q) + "&page=" + q.page, ctl);
      if (!r.ok) return [];
      const j = await r.json();
      if (!j || !j.ok || !Array.isArray(j.results)) return [];
      return chanFilterPicks(j.results, chanBanned(), q.seen);
    } catch (_) { return []; }
  }
  async function ensureQueue(def, min) {
    const q = queueOf(def);
    if (q.loading) return q;
    q.loading = true;
    try {
      let tries = 0;
      while (q.list.length < (min || 4) && tries < 4) {
        const seed = chanSeedAt(def, q.seedN++);
        const got = await chanFetch(def, { q: seed.q, page: seed.page, seen: q.seen });
        for (const it of got) { q.seen.add(it.id); q.list.push(it); }
        if (!got.length) tries++; // a dry well costs a try; a wet one refills free
      }
    } catch (_) {}
    q.loading = false;
    return q;
  }

  /* ---------- the one genre player (this file's own) ---------- */
  let player = null, playerReady = false, ytP = null;
  let curChan = null;        // genre def currently loaded, or null
  let curItem = null;        // {id,title,dur,thumb}
  let wantPlay = false;      // this listener asked for sound
  let sounding = false;      // the player is actually making sound
  let stallAt = 0;           // buffering watchdog stamp
  let selected = null;       // channel id the tuner shows as chosen

  function ytApi() {
    if (window.YT && YT.Player) return Promise.resolve();
    if (ytP) return ytP;
    ytP = new Promise((res) => {
      const tag = document.createElement("script");
      tag.src = "https://www.youtube.com/iframe_api";
      document.head.appendChild(tag);
      const prev = window.onYouTubeIframeAPIReady;
      window.onYouTubeIframeAPIReady = () => { try { prev && prev(); } catch (_) {} res(); };
      setTimeout(res, 7000);
    });
    return ytP;
  }
  function ensurePlayer(firstId) {
    if (player) return;
    const host = document.getElementById("chan-yt");
    if (!host) return;
    player = new YT.Player("chan-yt", {
      videoId: firstId || undefined,
      playerVars: { autoplay: 1, controls: 1, rel: 0, playsinline: 1, modestbranding: 1 },
      events: {
        onReady: () => { playerReady = true; if (wantPlay && curItem) { try { player.loadVideoById(curItem.id); } catch (_) {} } },
        onStateChange: onPlayerState,
        onError: onPlayerError,
      },
    });
  }
  function onPlayerState(e) {
    const YTS = (window.YT && YT.PlayerState) || {};
    if (e.data === YTS.PLAYING) {
      sounding = true; stallAt = 0;
      paint(); mediaSessionPaint();
    } else if (e.data === YTS.BUFFERING) {
      if (!stallAt) stallAt = Date.now();
    } else if (e.data === YTS.PAUSED) {
      sounding = false; paint();
    } else if (e.data === YTS.ENDED) {
      sounding = false; advance();
    }
  }
  function onPlayerError() {
    // YouTube's wall (embed-restricted / age-locked / gone): mark it
    // in the shared ban list so no surface picks it again, roll on.
    if (curItem) chanBanId(curItem.id);
    sounding = false;
    advance();
  }
  async function playItem(def, item) {
    curItem = item;
    const q = queueOf(def);
    q.hist.push(item); if (q.hist.length > 24) q.hist.shift();
    await ytApi();
    if (curChan !== def) return; // listener changed their mind mid-tune
    ensurePlayer(item.id);
    if (player && playerReady) { try { player.loadVideoById(item.id); } catch (_) {} }
    wantPlay = true;
    paint();
    ensureQueue(def, 4); // keep the channel deep behind the current song
  }
  async function advance() {
    const def = curChan; if (!def) return;
    const q = await ensureQueue(def, 1);
    const next = q.list.shift();
    if (next) { playItem(def, next); return; }
    // Dry well (relay unreachable): wait, then dig again — never dead air by choice.
    paint("Tuning… the picks are reloading.");
    setTimeout(() => { if (curChan === def && wantPlay) advance(); }, 4000);
  }
  function stopGenre() {
    wantPlay = false; sounding = false; stallAt = 0;
    if (player) { try { player.stopVideo(); } catch (_) {} }
    curItem = null;
    paint();
  }

  /* ---------- the station doors (read/listen only — never writes) ---------- */
  function djListening() { try { return !!(window.MW_DJ && typeof MW_DJ.listening === "function" && MW_DJ.listening()); } catch (_) { return false; } }
  function mediaSounding() {
    try { return typeof media !== "undefined" && !!media && !media.paused && !media.ended; } catch (_) { return false; }
  }
  function stationSounding() { return djListening() || mediaSounding(); }
  function silenceStationHere() {
    // Stop THIS tab's station follow only — the station itself,
    // and every other listener, are untouched.
    try { if (djListening() && window.MW_DJ) MW_DJ.stop(); } catch (_) {}
    try {
      if (typeof media !== "undefined" && media && !media.paused) {
        media.pause();
        try { if (typeof room !== "undefined" && room) room.presence({ radio: null }); } catch (_) {}
      }
    } catch (_) {}
    const ti = document.getElementById("tune-in");
    if (ti && !stationSounding()) ti.textContent = "▶ Tune in";
  }
  function startLive() {
    stopGenre();
    curChan = null; selected = "live";
    try { localStorage.removeItem("mw-chan-last"); } catch (_) {}
    if (window.MW_DJ_LIVE && window.MW_DJ_LIVE()) { try { window.MW_DJ.start(); } catch (_) {} }
    else if (typeof tuneIn === "function") { try { tuneIn(); } catch (_) {} }
    paint();
  }
  function stationNowTitle() {
    try { const a = window.MW_AIRNOW && MW_AIRNOW(); if (a && a.title) return a.title; } catch (_) {}
    const el = document.getElementById("air-title");
    return (el && el.textContent || "").trim() || "Meechie's World Radio";
  }

  /* ---------- channel selection ---------- */
  function selectGenre(def) {
    selected = def.id; curChan = def;
    try { localStorage.setItem("mw-chan-last", def.id); } catch (_) {}
    silenceStationHere();
    paint("Tuning " + def.name + "…");
    (async () => {
      const q = await ensureQueue(def, 4);
      if (curChan !== def) return;
      const first = q.list.shift();
      if (first) playItem(def, first);
      else { paint("Tuning… the picks are reloading."); setTimeout(() => { if (curChan === def) advance(); }, 2500); }
    })();
  }
  function toggleCurrent() {
    if (selected === "live" || (!selected && !curChan)) {
      if (stationSounding()) { silenceStationHere(); selected = "live"; paint(); }
      else startLive();
      return;
    }
    if (curChan) {
      if (sounding || wantPlay) { wantPlay = false; try { player && player.pauseVideo(); } catch (_) {} sounding = false; paint(); }
      else if (curItem && player) { wantPlay = true; try { player.playVideo(); } catch (_) {} paint(); }
      else selectGenre(curChan);
    }
  }
  function nextCurrent() {
    if (curChan && curItem) { wantPlay = true; advance(); }
  }
  function prevCurrent() {
    if (!curChan || !player) return;
    try {
      const t = player.getCurrentTime ? player.getCurrentTime() : 0;
      const q = queueOf(curChan);
      if (t < 4 && q.hist.length > 1) { const prev = q.hist[q.hist.length - 2]; q.hist = q.hist.slice(0, -1); playItem(curChan, prev); return; }
      player.seekTo(0, true); if (wantPlay) player.playVideo();
    } catch (_) {}
  }

  /* ---------- media session (lock-screen controls follow the channel) ---------- */
  function mediaSessionPaint() {
    try {
      if (!("mediaSession" in navigator) || !curChan || !curItem) return;
      navigator.mediaSession.metadata = new MediaMetadata({
        title: curItem.title,
        artist: curChan.name + " · Meechie's World Channels",
        album: "Meechie's World Radio",
        artwork: [{ src: location.origin + "/img/icon-512.png", sizes: "512x512", type: "image/png" }],
      });
      navigator.mediaSession.playbackState = sounding ? "playing" : "paused";
      const H = (a, f) => { try { navigator.mediaSession.setActionHandler(a, f); } catch (_) {} };
      H("play", () => { if (curChan) { wantPlay = true; try { player && player.playVideo(); } catch (_) {} } });
      H("pause", () => { if (curChan) { wantPlay = false; try { player && player.pauseVideo(); } catch (_) {} } });
      H("nexttrack", () => { if (curChan) nextCurrent(); });
      H("previoustrack", () => { if (curChan) prevCurrent(); });
    } catch (_) {}
  }

  /* ---------- painting ---------- */
  const guideEl = $("#chan-guide"), tunerName = $("#chan-tname"), tunerTrack = $("#chan-ttrack"),
    toggleBtn = $("#chan-toggle"), nextBtn = $("#chan-next"), prevBtn = $("#chan-prev"),
    noteEl = $("#chan-note"), resumeBtn = $("#chan-resume"), posterEl = $("#chan-poster");
  let lastLiveTitle = "";
  function buildGuide() {
    if (!guideEl) return;
    guideEl.innerHTML = DEFS.map((d) =>
      `<button type="button" class="chan-row" data-chan="${d.id}" role="listitem" aria-label="Channel ${d.num}: ${esc(d.name)}">
        <span class="chan-num">${d.num}</span>
        <span class="chan-meta"><b>${esc(d.name)}</b><small data-chan-now="${d.id}">${esc(d.tag)}</small></span>
        <span class="chan-on" data-chan-on="${d.id}" hidden>ON AIR</span>
      </button>`).join("");
    guideEl.querySelectorAll("[data-chan]").forEach((b) => b.addEventListener("click", () => {
      const d = defOf(b.dataset.chan);
      if (!d) return;
      if (d.id === "live") startLive();
      else if (curChan === d && (sounding || wantPlay)) { /* already your channel — the tuner buttons drive it */ paint(); }
      else selectGenre(d);
    }));
  }
  function paint(note) {
    const live = selected === "live";
    const def = curChan;
    if (tunerName) tunerName.textContent = live ? "LIVE — MWR 24/7" : def ? def.name : "CHANNELS";
    if (tunerTrack) {
      tunerTrack.textContent = live ? stationNowTitle()
        : def ? (curItem ? curItem.title + (curItem.dur ? " · " + fmt(curItem.dur) : "") : "Tuning…")
        : "Pick a channel — or ride the live station.";
    }
    if (toggleBtn) toggleBtn.textContent = (live ? stationSounding() : sounding || wantPlay) ? "❚❚" : "▶";
    if (nextBtn) nextBtn.disabled = !def;
    if (prevBtn) prevBtn.disabled = !def;
    if (resumeBtn) resumeBtn.hidden = !(def && wantPlay && !sounding && curItem);
    if (posterEl) posterEl.style.display = def ? "none" : "";
    if (noteEl && typeof note === "string") noteEl.textContent = note;
    DEFS.forEach((d) => {
      const on = card.querySelector(`[data-chan-on="${d.id}"]`);
      const row = card.querySelector(`[data-chan="${d.id}"]`);
      const isOn = (d.id === "live" && live && stationSounding()) || (def && d.id === def.id && (sounding || wantPlay));
      if (on) on.hidden = !isOn;
      if (row) row.classList.toggle("chan-sel", selected === d.id);
      const now = card.querySelector(`[data-chan-now="${d.id}"]`);
      if (now) {
        if (d.id === "live") { const t = stationNowTitle(); if (t !== lastLiveTitle) { lastLiveTitle = t; now.textContent = "Now: " + t; } }
        else if (def && d.id === def.id && curItem) now.textContent = "Now: " + curItem.title;
        else if (now.dataset.tag) now.textContent = now.dataset.tag;
        if (!now.dataset.tag) now.dataset.tag = d.tag;
      }
    });
  }

  /* ---------- reconciliation: one sound per tab, always ---------- */
  setInterval(() => {
    try {
      if (curChan && wantPlay) {
        // The station took this tab's sound back through any door
        // (Tune In, the bubble, the player bar, a live alert): the
        // live radio wins and the genre channel yields.
        if (stationSounding()) {
          stopGenre();
          selected = "live"; curChan = null;
          paint("You're on the live station — your channel waits here whenever you want it.");
          return;
        }
        // MW TV's own rule: entering its screen, the TV sound is on
        // and other sound is cut on that screen.
        if (document.body && document.body.dataset && document.body.dataset.view === "mwtv") {
          stopGenre();
          selected = null; curChan = null;
          paint("MW TV has the sound on its screen — your channel waits here.");
          return;
        }
        // Buffering stall: roll to the next pick, never sit silent.
        if (stallAt && Date.now() - stallAt > 15000) { stallAt = 0; advance(); return; }
      }
      // Keep the LIVE guide row honest as the station's song changes.
      if (lastLiveTitle !== stationNowTitle()) paint();
    } catch (_) {}
  }, 1000);

  /* ---------- wire up ---------- */
  if (toggleBtn) toggleBtn.addEventListener("click", toggleCurrent);
  if (nextBtn) nextBtn.addEventListener("click", nextCurrent);
  if (prevBtn) prevBtn.addEventListener("click", prevCurrent);
  if (resumeBtn) resumeBtn.addEventListener("click", () => { wantPlay = true; try { player && player.playVideo(); } catch (_) {} paint(); });
  buildGuide();
  try { const last = localStorage.getItem("mw-chan-last"); if (last && defOf(last)) { selected = last; curChan = defOf(last); } } catch (_) {}
  if (!selected) selected = "live";
  paint();

  /* The update guardians (dj.js + the shell checker) ask this so a
   * build refresh never cuts a genre channel mid-song — the
   * no-skip law covers personal channels too. */
  window.MW_CHAN = {
    playing: () => !!(curChan && wantPlay && sounding),
    active: () => !!(curChan && wantPlay),
    channel: () => selected,
  };
})();
