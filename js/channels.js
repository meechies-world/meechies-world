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
 * so a genre channel cannot fight the live radio. The listener's
 * LAST explicit choice owns this tab's sound: taking a genre
 * channel silences this tab's station follow — never the station
 * itself — and the pick then defends itself against the follow's
 * auto-resume paths (which cannot know a channel is playing).
 * Only an explicit station door (Tune In, the player bar, the
 * booth listen button, a live alert) hands the sound back to the
 * station; see the reconciliation tick. The player is created
 * WITHOUT a video, so it can only ever play what this file's
 * state machine currently wants — no orphaned autoplay.
 *
 * Picks ride the same doors as booth search: the /api/ytsearch
 * relay (which server-side drops banned/unplayable videos) plus
 * this device's shared age-lock list (localStorage
 * "mw-dj-ageskip" — the playability filter the booth keeps).
 * A video that still dies on YouTube's wall here is added to that
 * same list and the channel rolls on — no dead air, no skips.
 *
 * BACKEND DOWN (owner order, 2026-11-04: "Those buttons play my
 * music — I want it to play others"): when the relay cannot fill
 * a genre channel, the channel plays from its baked pool in
 * /lifeline/channel-pools.json — OTHER artists' music, official
 * uploads only, every id verified US-embeddable before it went
 * in, titles/artists baked in so the labels paint with no
 * backend at all. The relay is retried first on every fill, so
 * a recovered relay takes each channel back on its own. (This
 * replaces the emergency design from earlier the same day that
 * filled TRAP LOVE and WEED WAKE-UP from the owner's own
 * catalog; his station — the LIVE channel and the main radio
 * lifeline — is untouched by it.)
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
      { id: "country", num: 6, name: "COUNTRY", tag: "Country hits and modern country", seeds: ["country music hits", "top country songs", "country hits 2025", "modern country mix", "country hits mix"] },
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
      if (r.live) continue; // a live stream never ends — channels roll finite picks
      if (bannedSet && bannedSet.has(r.id)) continue;
      if (seenSet && seenSet.has(r.id)) continue;
      const dur = +r.dur || 0;
      // A channel is a stream, not a song pick: long mixes are
      // legitimate channel fare (the old 40-minute cap starved
      // COUNTRY — its lead seed's results are all long mixes).
      if (dur > 0 && (dur < 30 || dur > 7200)) continue;
      inList.add(r.id);
      // The live relay speaks { t: title } (its compact shape); the
      // repo relay speaks { title }. Take either — reading only
      // `title` left every pick named "YouTube video" on the tuner.
      out.push({ id: r.id, title: r.title || r.t || "YouTube video", dur, thumb: r.thumb || ("https://i.ytimg.com/vi/" + r.id + "/hqdefault.jpg") });
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
      // Relay dry (or down): the channel falls back to its baked
      // pool of other artists' music, so it still plays with no
      // backend at all. The relay is retried first on every fill,
      // so a recovered relay takes the channel back on its own.
      if (q.list.length < (min || 4)) {
        let want = (min || 4) - q.list.length;
        while (want-- > 0) {
          const it = await poolNext(def);
          if (!it) break;
          q.list.push(it);
        }
      }
    } catch (_) {}
    q.loading = false;
    return q;
  }

  /* ---------- baked pools: other artists' music, no backend ----------
   * Malik's law: radio listening must not depend on the backend —
   * channels are radio. And his order (2026-11-04): the genre
   * channels play OTHER artists, not his own catalog. Each genre's
   * pool is baked into /lifeline/channel-pools.json — official
   * uploads only, every id verified US-embeddable before it went
   * in, title/artist/duration baked in so the tuner name, the
   * track line and the guide "Now:" paint with no backend at all.
   * A pool plays through this file's YouTube player in a shuffled
   * rotation — a fresh shuffle each pass through the pool, never
   * the same song twice in a row — so the channel feels endless.
   * Pool picks are YouTube videos, never files: they are never
   * handed to the file player below (that element only ever plays
   * picks that carry a src, and pool picks never do). A pool id
   * this device has seen die on YouTube's wall (the shared
   * age-lock list) is skipped at fill time, and the player error
   * path bans a dying pool pick exactly like a relay pick. */
  let poolsCache = null, poolsTried = false;
  async function poolsData() {
    if (poolsCache) return poolsCache;
    if (poolsTried) return null;
    poolsTried = true;
    try { const r = await fetch("/lifeline/channel-pools.json", { cache: "no-store" }); poolsCache = r.ok ? await r.json() : null; } catch (_) { poolsCache = null; }
    return poolsCache;
  }
  function shuffledPool(list, lastId) {
    const a = list.slice();
    for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); const t = a[i]; a[i] = a[j]; a[j] = t; }
    if (a.length > 1 && lastId && a[0] && a[0].id === lastId) { const t = a[0]; a[0] = a[1]; a[1] = t; }
    return a;
  }
  /* Next pool pick for a channel: walks the channel's shuffled
   * deck, reshuffling the whole pool when the deck runs out.
   * Returns null when the pool is missing or every entry in it is
   * on this device's ban list — the caller then digs as before. */
  async function poolNext(def) {
    const data = await poolsData();
    const pool = (data && data.pools && data.pools[def.id]) || [];
    if (!pool.length) return null;
    const q = queueOf(def);
    if (!q.poolDeck || !q.poolDeck.length) q.poolDeck = shuffledPool(pool, q.poolLast || null);
    const banned = chanBanned();
    let guard = pool.length * 2;
    while (guard-- > 0) {
      if (!q.poolDeck.length) q.poolDeck = shuffledPool(pool, q.poolLast || null);
      const e = q.poolDeck.shift();
      if (!e || !e.id) continue;
      if (banned.has(e.id)) continue;
      q.poolLast = e.id;
      return { id: e.id, title: e.artist ? e.artist + " — " + e.title : e.title, dur: e.dur || 0, thumb: "https://i.ytimg.com/vi/" + e.id + "/hqdefault.jpg" };
    }
    return null;
  }
  /* File picks (a pick carrying a src) play on this file's own audio
   * element, driven by the same state machine (curItem / sounding /
   * advance). No current feed produces file picks — relay and pool
   * picks are both YouTube videos — but the door stays wired so the
   * state machine keeps one shape for every kind of pick. */
  let filePlayer = null, fileErrN = 0;
  function ensureFilePlayer() {
    if (filePlayer) return filePlayer;
    const fp = new Audio();
    fp.preload = "auto";
    try { fp.setAttribute("playsinline", ""); } catch (_) {}
    fp.addEventListener("playing", () => { fileErrN = 0; sounding = true; stallAt = 0; paint(); mediaSessionPaint(); });
    fp.addEventListener("pause", () => { sounding = false; paint(); });
    fp.addEventListener("waiting", () => { if (!stallAt) stallAt = Date.now(); });
    fp.addEventListener("ended", () => { sounding = false; advance(); });
    fp.addEventListener("error", () => {
      sounding = false;
      fileErrN++;
      const def = curChan; if (!def || !wantPlay) return;
      if (fileErrN >= 3) { // the files themselves are unreachable: say so, and slow-dig like a dry well
        fileErrN = 0; dryN = Math.max(dryN, 2);
        paint(def.name + " is quiet right now — no playable picks are coming up. Staying on this channel and still digging.");
        setTimeout(() => { if (curChan === def && wantPlay) advance(); }, 20000);
      } else advance();
    });
    filePlayer = fp;
    return fp;
  }
  const curIsFile = () => !!(curItem && curItem.src);
  function playActive() { try { if (curIsFile()) { if (filePlayer) { const p = filePlayer.play(); if (p && p.catch) p.catch(() => {}); } } else if (player) player.playVideo(); } catch (_) {} }
  function pauseActive() { try { if (curIsFile()) { if (filePlayer) filePlayer.pause(); } else if (player) player.pauseVideo(); } catch (_) {} }
  function seekActive(t) { try { if (curIsFile()) { if (filePlayer) filePlayer.currentTime = t; } else if (player) player.seekTo(t, true); } catch (_) {} }
  function activeTime() { try { if (curIsFile()) return filePlayer ? filePlayer.currentTime || 0 : 0; return player && player.getCurrentTime ? player.getCurrentTime() : 0; } catch (_) { return 0; } }

  /* ---------- the one genre player (this file's own) ---------- */
  let player = null, playerReady = false, ytP = null;
  let curChan = null;        // genre def currently loaded, or null
  let curItem = null;        // {id,title,dur,thumb}
  let wantPlay = false;      // this listener asked for sound
  let sounding = false;      // the player is actually making sound
  let stallAt = 0;           // buffering watchdog stamp
  let selected = null;       // channel id the tuner shows as chosen
  let doorAt = 0;            // stamp of the last explicit station-door click
  let fightN = 0;            // consecutive station re-sounds defended against
  let dryN = 0;              // consecutive dry digs for the current channel

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
  function ensurePlayer() {
    if (player) return;
    const host = document.getElementById("chan-yt");
    if (!host) return;
    // No videoId here on purpose: a constructor video autoplays on
    // ready even after the state machine has moved on, which left
    // genre video sounding under a tuner that said LIVE. The
    // player now loads only from playItem / onReady, always the
    // item the state machine currently wants.
    player = new YT.Player("chan-yt", {
      playerVars: { autoplay: 1, controls: 1, rel: 0, playsinline: 1, modestbranding: 1 },
      events: {
        onReady: () => { playerReady = true; if (wantPlay && curItem && !curItem.src) { try { player.loadVideoById(curItem.id); } catch (_) {} } },
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
    if (curItem && curItem.src) return; // a file pick owns the sound right now; this error is not its
    // YouTube's wall (embed-restricted / age-locked / gone): mark it
    // in the shared ban list so no surface picks it again, roll on.
    if (curItem) chanBanId(curItem.id);
    sounding = false;
    advance();
  }
  async function playItem(def, item) {
    curItem = item;
    dryN = 0; fightN = 0;
    const q = queueOf(def);
    q.hist.push(item); if (q.hist.length > 24) q.hist.shift();
    wantPlay = true; // set before the player exists, so a fast onReady loads this item
    if (item.src) { // file pick: this file's audio element plays it; the video player stands down
      if (player) { try { player.stopVideo(); } catch (_) {} }
      const fp = ensureFilePlayer();
      try { fp.src = item.src; const p = fp.play(); if (p && p.catch) p.catch(() => {}); } catch (_) {}
      paint();
      ensureQueue(def, 4);
      return;
    }
    if (filePlayer) { try { filePlayer.pause(); } catch (_) {} }
    await ytApi();
    if (curChan !== def) return; // listener changed their mind mid-tune
    ensurePlayer();
    if (player && playerReady) { try { player.loadVideoById(item.id); } catch (_) {} }
    paint();
    ensureQueue(def, 4); // keep the channel deep behind the current song
  }
  async function advance() {
    const def = curChan; if (!def) return;
    const q = await ensureQueue(def, 1);
    const next = q.list.shift();
    if (next) { playItem(def, next); return; }
    // Dry well: keep digging on THIS channel — never a silent
    // revert to LIVE. After two dry digs in a row the tuner says
    // so plainly on the card, and the digging slows down but
    // never stops, so the channel recovers on its own.
    dryN++;
    if (dryN >= 2) paint(def.name + " is quiet right now — no playable picks are coming up. Staying on this channel and still digging.");
    else paint("Tuning… the picks are reloading.");
    setTimeout(() => { if (curChan === def && wantPlay) advance(); }, dryN >= 3 ? 20000 : 4000);
  }
  function stopGenre() {
    wantPlay = false; sounding = false; stallAt = 0;
    if (player) { try { player.stopVideo(); } catch (_) {} }
    if (filePlayer) { try { filePlayer.pause(); } catch (_) {} }
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
    curChan = null; selected = "live"; fightN = 0; dryN = 0;
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
    // The tap IS the intent to hear this channel: wantPlay goes on
    // now, not when the first pick lands — otherwise a slow or dry
    // first fill left the retry loop disarmed and the tuner sat
    // mute on "Tuning…" with the pick liable to be reverted.
    wantPlay = true; dryN = 0; fightN = 0;
    try { localStorage.setItem("mw-chan-last", def.id); } catch (_) {}
    silenceStationHere();
    // The pick owns this tab's sound: whatever genre player was sounding
    // stands down now, even if the new channel's first fill comes up dry.
    if (player) { try { player.stopVideo(); } catch (_) {} }
    if (filePlayer) { try { filePlayer.pause(); } catch (_) {} }
    sounding = false;
    paint("Tuning " + def.name + "…");
    (async () => {
      const q = await ensureQueue(def, 4);
      if (curChan !== def) return;
      const first = q.list.shift();
      if (first) playItem(def, first);
      else advance(); // dry first fill: advance owns the note + the digging
    })();
  }
  function toggleCurrent() {
    if (selected === "live" || (!selected && !curChan)) {
      if (stationSounding()) { silenceStationHere(); selected = "live"; paint(); }
      else startLive();
      return;
    }
    if (curChan) {
      if (sounding || wantPlay) { wantPlay = false; pauseActive(); sounding = false; paint(); }
      else if (curItem && (player || filePlayer)) { wantPlay = true; playActive(); paint(); }
      else selectGenre(curChan);
    }
  }
  function nextCurrent() {
    if (curChan && curItem) { wantPlay = true; advance(); }
  }
  function prevCurrent() {
    if (!curChan || (!player && !filePlayer)) return;
    try {
      const t = activeTime();
      const q = queueOf(curChan);
      if (t < 4 && q.hist.length > 1) { const prev = q.hist[q.hist.length - 2]; q.hist = q.hist.slice(0, -1); playItem(curChan, prev); return; }
      seekActive(0); if (wantPlay) playActive();
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
      H("play", () => { if (curChan) { wantPlay = true; playActive(); } });
      H("pause", () => { if (curChan) { wantPlay = false; pauseActive(); } });
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
    if (noteEl) {
      if (typeof note === "string") noteEl.textContent = note;
      /* A "Tuning…" note is only honest while actually tuning: once the
       * channel is sounding with a current item, the note is stale and
       * clears, so the card shows its real state. Both players set
       * sounding=true and call paint() the moment sound starts (the
       * file player's "playing" handler on a file pick, the YT
       * player's PLAYING state on the primary path), so both paths
       * drive this transition identically. */
      else if (sounding && curItem && (noteEl.textContent || "").indexOf("Tuning") === 0) noteEl.textContent = "";
    }
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

  /* ---------- reconciliation: one sound per tab, always ----------
   * The listener's last explicit choice owns this tab's sound.
   * (The shipped version yielded the channel the first tick the
   * station probed as sounding — but the station follow has
   * auto-resume paths that fire without any listener choice, so
   * picks flipped back to LIVE within seconds while the tuner,
   * the ON AIR pills and the actual sound disagreed. A pick now
   * defends itself; only a real door hands the sound back.) */
  setInterval(() => {
    try {
      if (curChan && wantPlay) {
        // MW TV's own rule: entering its screen, the TV sound is on
        // and other sound is cut on that screen. Going to that
        // screen is the listener's own move, so the channel yields
        // at once, exactly as before.
        if (document.body && document.body.dataset && document.body.dataset.view === "mwtv") {
          stopGenre();
          selected = null; curChan = null;
          paint("MW TV has the sound on its screen — your channel waits here.");
          return;
        }
        if (stationSounding()) {
          // An explicit station door in the last moments means the
          // listener just chose the station: hand the sound over.
          // A determined re-sounder (four defended re-sounds) also
          // wins — but the tuner says what happened either way;
          // the pick never reverts silently or by surprise.
          if (Date.now() - doorAt < 2500 || fightN >= 4) {
            stopGenre();
            selected = "live"; curChan = null; fightN = 0;
            paint("You're on the live station — your channel waits here whenever you want it.");
            return;
          }
          // No door was touched: this is the follow machinery
          // re-asserting itself. Re-silence THIS TAB's follow and
          // keep the channel — one sound, the chosen one.
          fightN++;
          silenceStationHere();
          paint();
          return;
        }
        fightN = 0;
        // Buffering stall: roll to the next pick, never sit silent.
        if (stallAt && Date.now() - stallAt > 15000) { stallAt = 0; advance(); return; }
      }
      // Keep the LIVE guide row honest as the station's song changes.
      if (lastLiveTitle !== stationNowTitle()) paint();
    } catch (_) {}
  }, 1000);

  /* ---------- wire up ---------- */
  // Explicit station doors, stamped in the capture phase so the
  // reconciliation tick can tell "the listener chose the station"
  // apart from the follow machinery re-asserting itself.
  const DOOR_SEL = "#tune-in, #pb-play, #dj-listen, #la-tune, #la-watch, #wb-sound, #tw-watch, #st-watch, [data-bobtn], [data-bubbtn], [data-play]";
  document.addEventListener("click", (e) => { try { if (e.target && e.target.closest && e.target.closest(DOOR_SEL)) doorAt = Date.now(); } catch (_) {} }, true);
  if (toggleBtn) toggleBtn.addEventListener("click", toggleCurrent);
  if (nextBtn) nextBtn.addEventListener("click", nextCurrent);
  if (prevBtn) prevBtn.addEventListener("click", prevCurrent);
  if (resumeBtn) resumeBtn.addEventListener("click", () => { wantPlay = true; playActive(); paint(); });
  buildGuide();
  try { const last = localStorage.getItem("mw-chan-last"); if (last && defOf(last)) { selected = last; curChan = defOf(last); } } catch (_) {}
  if (!selected) selected = "live";
  paint();

  /* The update guardians (dj.js + the shell checker) ask this so a
   * build refresh never cuts a genre channel mid-song — the
   * no-skip law covers personal channels too. The MW TV channel
   * (js/dj.js) composes in via MW_TV_PLAYING so a TV viewer is
   * never cut mid-watch either. */
  window.MW_CHAN = {
    playing: () => !!((curChan && wantPlay && sounding) || (window.MW_TV_PLAYING && window.MW_TV_PLAYING())),
    active: () => !!(curChan && wantPlay),
    channel: () => selected,
  };
})();
