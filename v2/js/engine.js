/* ============================================================================
   v2 PLAYER ENGINE — the ONE player (MAP §4.3 player-engine).

   Every viewer surface — the radio station stage, MW TV, Watch the
   Setup, the MASTER BAND (kind "mini" — the engine's name for the
   band screen), the master-screen share leg, and the HLS
   stream screen — renders through this module and no other. A surface
   owns markup and paint; it never owns player logic. That fork is the
   documented root of the live site's mini bug family, and it does not
   reappear here.

   Ported behavior-for-behavior from the live viewer leg (dj.js at main
   1be5b8fe, PRs #404/#408/#410 included):
   - one broadcast clock (bcastPos, server-corrected via the feed);
   - the sync lock: 0.12 s deadband, rate nudge, snap past 0.35 s
     (thresholds ×3 for Dailymotion/Vimeo) — worked around by the
     masking code, never retuned;
   - NO-SKIP (Law 3): the HLS cushion as named constants below, warm
     pre-buffering that ROLLS muted on viewer screens, stall masking
     with the flap-tolerant lift, split heal counters that reset only
     after 10 s of unmasked clean play, and an honest status chip
     (a masked slot is opacity-covered so the poster/slate shows —
     never a black iframe over the poster);
   - quality caps per surface (stage/mini 480 "large", TV/Watch 720);
   - one sounding mix screen at a time (MW TV > Watch > the master
     BAND > station stage); the booth (in the booth phase) never
     sounds. The band is the cemented in-flow master screen (owner,
     2026-10-30 12:46): static shell markup, always present, the
     sounding master surface at every width whenever it is shown;
   - the share leg: the RealtimeKit watcher sweep (1 s polling grab,
     stage-join for LIVESTREAM rooms, room HLS fallback), the capture's
     own sound as the only sound while a share holds the master
     (takeover, Law 2), viewer pause = local mute only, and the TV
     status line that says where a watch stopped, in plain words.

   READ PATH: this module never writes radio/dj. Its only network
   calls besides the gateway are the live site's own viewer calls:
   POST /api/streams (live_mint, role "watch") and the provider APIs.
   ============================================================================ */

import { DECKS, PAIR, vmixTargets, stageGain, boostMk, bcastPos, vsBroadcast } from "./station.js";
import { getFeed } from "./station.js";

/* ---- NO-SKIP cushion (Law 3, PR #404 — the values, as named constants).
   Both live construction sites (dj.js vsShowHls, obs.js attachHls) run
   exactly this object; the engine owns it now, once. ---- */
export const HLS_CUSHION = Object.freeze({
  maxBufferLength: 90, maxMaxBufferLength: 120, backBufferLength: 60,
  liveSyncDurationCount: 8, liveMaxLatencyDurationCount: 24,
  maxLiveSyncPlaybackRate: 1.5,
  fragLoadingMaxRetry: 6, fragLoadingRetryDelay: 1000,
  levelLoadingMaxRetry: 6, levelLoadingRetryDelay: 1000,
  manifestLoadingMaxRetry: 6, manifestLoadingRetryDelay: 1000,
});
const VS_SDK_URL = "https://cdn.jsdelivr.net/npm/@cloudflare/realtimekit@2.0.4/dist/browser.js";
const HLS_JS_URL = "https://cdn.jsdelivr.net/npm/hls.js@1.5.13/dist/hls.min.js";

/* ---- sync lock constants (booth law — never retuned) ---- */
export const SYNC_DEAD = 0.12, SYNC_SNAP = 0.35;
export function syncLockCalc(drift, mul) {
  const m = mul || 1, ad = Math.abs(drift || 0);
  if (!(ad > SYNC_DEAD * m)) return { act: "none", rate: 1 };
  if (ad <= SYNC_SNAP * m) return { act: "nudge", rate: drift > 0 ? 0.95 : 1.05 };
  return { act: "snap", rate: 1 };
}

export const vparseTok = (tok) => { tok = String(tok || ""); if (tok.indexOf("dm:") === 0) return { p: "dm", id: tok.slice(3) }; if (tok.indexOf("vm:") === 0) return { p: "vm", id: tok.slice(3) }; return { p: "yt", id: tok }; };

/* ---- stall masking for one slot (live bufStep, verbatim logic).
   Fed the player state, its clock, the broadcast want and the deck's
   playing flag on every render pass. BUFFERING masks at once; any
   other stall masks once the clock has not advanced for over 1.2 s;
   the mask lifts after 800 ms of clean playing WITH the clock
   advancing, accumulated flap-tolerantly (a dirty stretch wipes the
   accumulation only after >400 ms continuous). While masked, exactly
   one invisible re-lock snap is allowed, only when drift > 2 s. ---- */
export function bufStep(sl, stt, cur, want, playing, now) {
  sl._maskSnap = false;
  if (!playing) { sl._bMask = false; sl._bufSince = 0; sl._bStateAt = 0; sl._bCleanAcc = 0; sl._bDirtySince = 0; sl._bPrevAt = 0; sl._bPrevClean = false; sl._bLastCur = null; sl._bAdvAt = 0; sl._maskSnapAt = 0; return sl; }
  if (sl._bLastCur == null) { sl._bLastCur = cur; sl._bAdvAt = now; }
  const adv = Math.abs(cur - sl._bLastCur) > 0.02;
  if (adv) { sl._bLastCur = cur; sl._bAdvAt = now; }
  if (stt === 3) { if (!sl._bStateAt) sl._bStateAt = now; }
  else if (stt !== 3) sl._bStateAt = 0;
  const clean = stt === 1 && adv;
  if (clean) {
    if (sl._bDirtySince && now - sl._bDirtySince > 400) sl._bCleanAcc = 0;
    else if (sl._bPrevClean && sl._bPrevAt) sl._bCleanAcc = (sl._bCleanAcc || 0) + (now - sl._bPrevAt);
    sl._bDirtySince = 0;
    if (sl._bMask && (sl._bCleanAcc || 0) >= 800) { sl._bMask = false; sl._bStateAt = 0; sl._bufSince = 0; sl._maskSnapAt = 0; sl._bCleanAcc = 0; }
  } else {
    if (!sl._bDirtySince) sl._bDirtySince = now;
    if (now - sl._bDirtySince > 400) sl._bCleanAcc = 0;
  }
  sl._bPrevClean = clean; sl._bPrevAt = now;
  if (!sl._bMask) {
    if (sl._bStateAt) { sl._bMask = true; sl._bufSince = sl._bStateAt; }
    else if (sl._bAdvAt && now - sl._bAdvAt > 1200) { sl._bMask = true; sl._bufSince = sl._bAdvAt; }
  }
  if (sl._bMask && Math.abs(cur - want) > 2 && !sl._maskSnapAt) { sl._maskSnap = true; sl._maskSnapAt = now; }
  return sl;
}

/* ---- provider API loaders (lazy, once — the live loaders verbatim) ---- */
let ytApiP = null, dmApiP = null, vmApiP = null;
function ytApi() { if (window.YT && YT.Player) return Promise.resolve(); if (ytApiP) return ytApiP; ytApiP = new Promise((res) => { const tag = document.createElement("script"); tag.src = "https://www.youtube.com/iframe_api"; document.head.appendChild(tag); const prev = window.onYouTubeIframeAPIReady; window.onYouTubeIframeAPIReady = () => { try { prev && prev(); } catch (_) {} res(); }; setTimeout(res, 7000); }); return ytApiP; }
function dmApi() { if (window.DM && DM.player) return Promise.resolve(); if (dmApiP) return dmApiP; dmApiP = new Promise((res) => { const tag = document.createElement("script"); tag.src = "https://api.dmcdn.net/all.js"; tag.onload = () => res(); tag.onerror = () => res(); document.head.appendChild(tag); setTimeout(res, 7000); }); return dmApiP; }
function vmApi() { if (window.Vimeo && Vimeo.Player) return Promise.resolve(); if (vmApiP) return vmApiP; vmApiP = new Promise((res) => { const tag = document.createElement("script"); tag.src = "https://player.vimeo.com/api/player.js"; tag.onload = () => res(); tag.onerror = () => res(); document.head.appendChild(tag); setTimeout(res, 7000); }); return vmApiP; }
let hlsP = null;
function loadHls() {
  if (window.Hls) return Promise.resolve(true);
  if (!hlsP) hlsP = new Promise((res) => { const s = document.createElement("script"); let done = false; const fin = (ok) => { if (done) return; done = true; if (!ok) hlsP = null; res(ok); }; s.src = HLS_JS_URL; s.onload = () => fin(!!window.Hls); s.onerror = () => fin(false); document.head.appendChild(s); setTimeout(() => fin(!!window.Hls), 12000); });
  return hlsP;
}

/* ---- the shared HLS primitive: attach a live HLS stream to a <video>
   with the NO-SKIP cushion. Used by the share leg today and by the
   OBS Live surface when it lands (MAP Phase 4) — one construction
   site, never a per-surface copy. Returns the hls.js instance or
   null (native HLS / unsupported). ---- */
export function attachHls(v, url) {
  detachHls(v);
  try { v.srcObject = null; } catch (_) {}
  v._vsHlsUrl = url;
  if (v.canPlayType && v.canPlayType("application/vnd.apple.mpegurl")) { v.src = url; return null; }
  if (window.Hls && window.Hls.isSupported && window.Hls.isSupported()) {
    const h = new window.Hls({ ...HLS_CUSHION });
    h.loadSource(url); h.attachMedia(v); v._vsHls = h; return h;
  }
  loadHls().then((ok) => { if (ok && v._vsHlsUrl === url && !v._vsHls) attachHls(v, url); });
  return null;
}
export function detachHls(v) {
  if (!v) return;
  if (v._vsHls) { try { v._vsHls.destroy(); } catch (_) {} v._vsHls = null; }
  if (v._vsHlsUrl) { v._vsHlsUrl = ""; try { v.pause(); v.removeAttribute("src"); v.load(); } catch (_) {} }
}

/* ---- VFX pulses ride the broadcast (live watchVfx) ---- */
const VFX_DUR = { flash: 330, strobe: 700, glitch: 430, blurp: 730, zoomp: 580, mono: 2000, invert: 900, hue: 1250 };

let _engine = null;
export function getEngine(ctx) { if (!_engine) _engine = createEngine(ctx); return _engine; }

export function createEngine(ctx) {
  const feed = getFeed(ctx);
  const session = ctx.session;
  const S = () => feed.S;
  const slotWant = (k) => bcastPos(feed.S, k, feed.nowBcast());

  let cssDone = false;
  function ensureCss() {
    if (cssDone) return; cssDone = true;
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = new URL("../css/engine.css", import.meta.url).href;
    document.head.appendChild(link);
  }

  /* ---------------- listening (the viewer's own TUNE IN) ----------------
     Gates the one sounding mix screen, exactly like the live site:
     before tune-in every screen renders muted; the picture is alive
     for everyone, the sound waits for the tap. */
  let listening = false;
  const listenSubs = new Set();
  function setListening(on) {
    /* the shell's presence ping carries l=1 while this seat listens
       (Phase 5 — the live dj.js stationPing rule), so the station's
       listening count includes v2 seats */
    if (ctx.presence && ctx.presence.setListening) { try { ctx.presence.setListening(on); } catch (_) {} }
    on = !!on;
    if (on === listening) return;
    listening = on;
    listenSubs.forEach((fn) => { try { fn(listening); } catch (_) {} });
  }

  /* ---------------- screens ---------------- */
  const CAPS = { stage: "large", mini: "large", tv: "hd720", watch: "hd720" };
  const screens = new Set();
  const shareStages = new Set();   // stage elements the share leg paints onto
  let stageScr = null, tvScr = null, watchScr = null, miniScr = null;
  const flags = { tv: false, watch: false, mini: false };
  /* the BAND's shown fact (CEMENT LAW, owner 2026-10-30 12:46): the
     band module owns the band's presence (present on every view
     except MW TV / the booth / the Playground) and reports it every
     tick; a shown band is the sounding master surface at EVERY
     width — the old floating-mini / phone-dock split is gone. */
  let bandShown = false;
  function setBandShown(on) { bandShown = !!on; }

  function createScreen(cfg) {
    ensureCss();
    const scr = {
      kind: cfg.kind, cap: CAPS[cfg.kind] || null, isMini: cfg.kind === "mini",
      stageEl: cfg.stageEl, slotEls: cfg.slotEls,
      standbyEl: cfg.standbyEl || null, chipEl: cfg.chipEl || null, posterEl: cfg.posterEl || null,
      slots: [{ deck: "", vid: "", p: null }, { deck: "", vid: "", p: null }],
      _vAt: null, _vTop: "", _bufK: "", _healK: "", _startK: "",
      onFeaturedPlay: null,   // a surface's featured-play hook (the band's state tracker)
    };
    screens.add(scr);
    if (cfg.stageEl) { shareStages.add(cfg.stageEl); stageKind.set(cfg.stageEl, cfg.kind); }
    if (cfg.kind === "stage") stageScr = scr;
    if (cfg.kind === "mini") { miniScr = scr; flags.mini = true; }
    if (cfg.kind === "tv") { tvScr = scr; flags.tv = true; }
    if (cfg.kind === "watch") { watchScr = scr; flags.watch = true; }
    return scr;
  }
  function destroyScreen(scr) {
    if (!scr) return;
    scr.slots.forEach((sl) => { if (sl.p) { try { sl.p.destroy(); } catch (_) {} sl.p = null; } sl.deck = ""; });
    screens.delete(scr);
    if (scr.stageEl) { shareStages.delete(scr.stageEl); stageKind.delete(scr.stageEl); }
    if (scr === stageScr) stageScr = null;
    if (scr === tvScr) { tvScr = null; flags.tv = false; }
    if (scr === watchScr) { watchScr = null; flags.watch = false; }
    if (scr === miniScr) { miniScr = null; flags.mini = false; bandShown = false; }
  }
  /* ONE SOUNDING SCREEN (live vmixSndScr): MW TV when the channel is
     open, else Watch when it is open, else THE BAND, else the station
     stage. While a live share holds the master, NO mix screen sounds
     — the capture carries its own audio (takeover). The band sounds
     at every width whenever it is shown (CEMENT LAW: it is the
     master picture, the radio is the master sound) — still exactly
     one sounding screen: TV > Watch > band > stage. */
  function soundingScreen() {
    if (!listening) return null;
    if (vsBroadcast(S()) && !(S().vstream || {}).hidden) return null;
    if (flags.tv && tvScr) return tvScr;
    if (flags.watch && watchScr) return watchScr;
    if (bandShown && miniScr) return miniScr;
    return stageScr;
  }

  /* one screen player for any video platform: the wrapper speaks the
     YT-ish surface renderScreen uses, whatever player is underneath
     (live mkVidPlayer, verbatim) */
  function mkVidPlayer(mountEl, tok, muted, deckK, warm, vopt) {
    const vp = vparseTok(tok);
    const w = { _raw: null, _st: -1, _cur: 0,
      playVideo() { try { if (!w._raw) return; if (vp.p === "yt") w._raw.playVideo(); else if (vp.p === "dm") w._raw.play(); else { const r = w._raw.play(); if (r && r.catch) r.catch(() => {}); } } catch (_) {} },
      pauseVideo() { try { if (!w._raw) return; if (vp.p === "yt") w._raw.pauseVideo(); else if (vp.p === "dm") w._raw.pause(); else w._raw.pause(); } catch (_) {} },
      seekTo(t) { try { if (!w._raw) return; if (vp.p === "yt") w._raw.seekTo(t, true); else if (vp.p === "dm") w._raw.seek(t); else { const r = w._raw.setCurrentTime(t); if (r && r.catch) r.catch(() => {}); } w._cur = t; } catch (_) {} },
      getCurrentTime() { try { if (vp.p === "yt" && w._raw) return w._raw.getCurrentTime() || 0; } catch (_) {} return w._cur || 0; },
      getPlayerState() { try { if (vp.p === "yt" && w._raw) return w._raw.getPlayerState(); } catch (_) {} return w._st; },
      setVolume(v) { try { if (!w._raw) return; if (vp.p === "yt") w._raw.setVolume(v); else w._raw.setVolume(Math.max(0, Math.min(1, v / 100))); } catch (_) {} },
      setPlaybackRate(r) { try { if (!w._raw) return; if (vp.p === "yt") w._raw.setPlaybackRate(r); else if (vp.p === "dm") { if (w._raw.setPlaybackRate) w._raw.setPlaybackRate(r); } else { const q = w._raw.setPlaybackRate(r); if (q && q.catch) q.catch(() => {}); } } catch (_) {} },
      rateOk() { try { if (!w._raw) return false; if (vp.p === "yt") { const av = w._raw.getAvailablePlaybackRates ? (w._raw.getAvailablePlaybackRates() || []) : []; return av.some((x) => Math.abs(x - 0.95) < 0.03 || Math.abs(x - 1.05) < 0.03); } if (vp.p === "dm") return !!(w._raw && w._raw.setPlaybackRate); return true; } catch (_) { return false; } },
      setQuality(q) { try { if (!w._raw || vp.p !== "yt") return; if (w._raw.setPlaybackQualityRange) w._raw.setPlaybackQualityRange(q, q); if (w._raw.setPlaybackQuality) w._raw.setPlaybackQuality(q); } catch (_) {} },
      mute() { try { if (!w._raw) return; if (vp.p === "yt") w._raw.mute(); else w._raw.setVolume(0); } catch (_) {} },
      unMute() { try { if (vp.p === "yt" && w._raw) w._raw.unMute(); } catch (_) {} },
      loadVideoById(tok2, t) { const v2 = vparseTok(tok2); try { if (!w._raw) return; if (vp.p === "yt") w._raw.loadVideoById(v2.id, t); else if (vp.p === "dm") { if (w._raw.load) w._raw.load(v2.id); if (t) setTimeout(() => w.seekTo(t), 900); } else { const r = w._raw.loadVideo(v2.id); if (r && r.then) r.then(() => { if (t) w.seekTo(t); w.playVideo(); }); } } catch (_) {} },
      destroy() { try { if (w._raw && vp.p !== "dm") w._raw.destroy(); } catch (_) {} w._raw = null; } };
    const ready = () => { try { if (muted || warm) w.mute(); try { const wd = mountEl && mountEl.clientWidth ? mountEl.clientWidth : 640; let q = wd >= 1100 ? "hd720" : wd >= 560 ? "large" : "medium"; if (!muted && q === "medium") q = "large"; if (vopt && vopt.cap) { const qr = { small: 0, medium: 1, large: 2, hd720: 3, hd1080: 4 }; if ((qr[q] || 0) > (qr[vopt.cap] || 0)) q = vopt.cap; } w.setQuality(q); } catch (_) {} w.seekTo(Math.max(0, slotWant(deckK))); if (warm) { if (vopt && vopt.roll) { try { w.mute(); } catch (_) {} w.playVideo(); } else w.pauseVideo(); } else w.playVideo(); } catch (_) {} };
    try {
      if (vp.p === "yt") {
        w._raw = new YT.Player(mountEl, { videoId: vp.id, width: "100%", height: "100%", playerVars: { playsinline: 1, rel: 0, controls: 0 }, events: { onReady: () => ready(), onStateChange: (e) => { w._st = e.data; }, onError: (e) => { w._err = (e && e.data) || 1; } } });
      } else if (vp.p === "dm") {
        const p = DM.player(mountEl, { video: vp.id, width: "100%", height: "100%", params: { autoplay: false, controls: false, "endscreen-enable": false } });
        w._raw = p;
        const on = (ev, fn) => { try { p.addEventListener(ev, fn); } catch (_) {} };
        on("apiready", () => ready());
        on("error", () => { w._err = 1; });
        on("timeupdate", (e) => { try { if (e && typeof e.time === "number") w._cur = e.time; } catch (_) {} });
        on("play", () => { w._st = 1; }); on("pause", () => { if (w._st !== 0) w._st = 2; }); on("ended", () => { w._st = 0; });
      } else {
        const p = new Vimeo.Player(mountEl, { id: vp.id, width: "100%", height: "100%", controls: false, title: false, byline: false, portrait: false });
        w._raw = p;
        p.ready().then(() => ready()).catch(() => {});
        p.on("error", () => { w._err = 1; });
        p.on("timeupdate", (e) => { try { if (e && typeof e.seconds === "number") w._cur = e.seconds; } catch (_) {} });
        p.on("play", () => { w._st = 1; }); p.on("pause", () => { if (w._st !== 0) w._st = 2; }); p.on("ended", () => { w._st = 0; });
      }
    } catch (_) {}
    return w;
  }

  /* animate one slot with the chosen transition, then lock it to the
     broadcast (live vtrSlot) */
  function vtrSlot(scr, k, tr, ms) {
    const i = scr.slots.findIndex((sl) => sl.deck === k); if (i < 0) return;
    const el = scr.slotEls[i]; if (!el) return;
    const cls = "vtr-" + tr;
    ["vtr-fade", "vtr-wipe", "vtr-slide", "vtr-zoom", "vtr-blur", "vtr-flash", "vtr-glitch"].forEach((c) => el.classList.remove(c));
    void el.offsetWidth;
    el.style.setProperty("--vtrd", (ms || 650) + "ms");
    el.classList.add(cls);
    setTimeout(() => el.classList.remove(cls), (ms || 650) + 600);
    const sl = scr.slots[i];
    if (sl.p) { try { const want = slotWant(k), cur = sl.p.getCurrentTime ? sl.p.getCurrentTime() : want, stt = sl.p.getPlayerState ? sl.p.getPlayerState() : -1; if (Math.abs(cur - want) > SYNC_SNAP && stt !== 3) { sl.p.seekTo(want, true); sl.seekAt = Date.now(); } } catch (_) {} }
  }

  /* ---------------- renderScreen — the live renderer, ported --------------
     A true dissolve: the weaker picture sits underneath at full
     strength and the stronger fades in over it by its share. Departing
     slots become warm; viewer warm slots ROLL muted so a real buffer
     accumulates ahead of the flip. Masking, healing, the sync lock and
     the chip all run here, once, for every surface. */
  async function renderScreen(scr, muted, mix, duck) {
    const st = S();
    const tg = vmixTargets(st);
    const srt = tg.slice().sort((a, b) => a.op - b.op), disp = {};
    if (srt.length === 2) { disp[srt[0].k] = 1; disp[srt[1].k] = srt[1].op; } else if (srt.length === 1) disp[srt[0].k] = 1;
    scr.slots.forEach((sl, i) => { if (sl.deck && !tg.some((x) => x.k === sl.deck)) { sl.warmK = sl.deck; sl.deck = ""; const el = scr.slotEls[i]; if (el) el.style.opacity = 0; if (sl.p) { try { sl.p.pauseVideo(); } catch (_) {} } } });
    const stb = scr.standbyEl; if (stb && !tg.length) stb.style.display = "grid";
    const pst = scr.posterEl; if (pst && !tg.length) pst.style.display = "block";
    const chip = scr.chipEl;
    if (!tg.length) { scr._vTop = ""; if (chip) chip.hidden = true; scr._bufK = ""; return; }
    let picLive = false;
    const provs = new Set(tg.map((t) => vparseTok(st[t.k].yt).p));
    if (provs.has("yt")) await ytApi();
    if (provs.has("dm")) await dmApi();
    if (provs.has("vm")) await vmApi();
    for (const t of tg) {
      let i = scr.slots.findIndex((sl) => sl.deck === t.k);
      if (i < 0) {
        // a free slot already holding this deck's video warm is promoted in place
        const wi = scr.slots.findIndex((sl) => !sl.deck && sl.warmK === t.k && sl.p && sl.vid === st[t.k].yt);
        if (wi >= 0) { i = wi; const sl = scr.slots[i], el = scr.slotEls[i]; sl.deck = t.k; sl.warmK = ""; if (el) { el.style.opacity = (disp[t.k] != null ? disp[t.k] : t.op).toFixed(2); el.style.zIndex = srt.length === 2 && srt[0].k === t.k ? 1 : 2; } }
      }
      if (i < 0) {
        i = scr.slots.findIndex((sl) => !sl.deck); if (i < 0) continue;
        const sl = scr.slots[i], mount = scr.slotEls[i]; if (!mount) continue;
        if (sl.p) { try { sl.p.destroy(); } catch (_) {} }
        sl.deck = t.k; sl.vid = st[t.k].yt; sl.p = null; sl.warmK = ""; sl._hadFrame = false; sl._noFrameAt = 0; sl._healN = 0; sl._bMask = false; sl._bufSince = 0; sl._bStateAt = 0; sl._bLastCur = null; sl._maskSnapAt = 0; sl._lastHealAt = 0; sl._bufHealN = 0; sl._cleanPlayAt = 0; sl._sawPlay = false; sl._frameAt = 0; sl._maskCov = false; sl._bCleanAcc = 0; sl._bDirtySince = 0; sl._bPrevAt = 0; sl._bPrevClean = false; mount.innerHTML = "<div></div>";
        mount.style.opacity = (disp[t.k] != null ? disp[t.k] : t.op).toFixed(2); mount.style.zIndex = srt.length === 2 && srt[0].k === t.k ? 1 : 2;
        const prov = vparseTok(sl.vid).p;
        if ((prov === "yt" && (!window.YT || !YT.Player)) || (prov === "dm" && (!window.DM || !DM.player)) || (prov === "vm" && (!window.Vimeo || !Vimeo.Player))) { sl.deck = ""; continue; }
        sl.p = mkVidPlayer(mount.firstChild, sl.vid, muted, t.k, false, { cap: scr.cap });
        continue;
      }
      const sl = scr.slots[i];
      if (sl.vid !== st[t.k].yt) { sl.vid = st[t.k].yt; sl._hadFrame = false; sl._noFrameAt = 0; sl._healN = 0; sl._bMask = false; sl._bufSince = 0; sl._bStateAt = 0; sl._bLastCur = null; sl._maskSnapAt = 0; sl._bufHealN = 0; sl._cleanPlayAt = 0; sl._sawPlay = false; sl._frameAt = 0; sl._maskCov = false; sl._bCleanAcc = 0; sl._bDirtySince = 0; sl._bPrevAt = 0; sl._bPrevClean = false; if (sl.p) { try { sl.p.loadVideoById(sl.vid, Math.max(0, slotWant(t.k))); } catch (_) {} } }
      const el = scr.slotEls[i]; if (el) { el.style.opacity = (disp[t.k] != null ? disp[t.k] : t.op).toFixed(2); el.style.zIndex = srt.length === 2 && srt[0].k === t.k ? 1 : 2; }
      if (sl.p) { try {
        const want = slotWant(t.k), cur = sl.p.getCurrentTime ? sl.p.getCurrentTime() : 0;
        const stt = sl.p.getPlayerState ? sl.p.getPlayerState() : -1;
        if (stt === 1 || stt === 2 || stt === 5) sl._hadFrame = true;
        if (stt === 1) sl._sawPlay = true;
        /* SLATE HYSTERESIS stamp (#443): the last moment this slot
           truly presented a moving frame (state playing WITH its
           clock advancing — a frozen-clock player earns no stamp);
           the slate/cover gates below measure dips against it */
        if (stt === 1 && (sl._bLastCur == null || Math.abs(cur - sl._bLastCur) > 0.02)) sl._frameAt = Date.now();
        if (stt === 1 && scr.isMini && srt.length && t.k === srt[srt.length - 1].k && scr.onFeaturedPlay) scr.onFeaturedPlay(sl.vid);
        if (sl._hadFrame) picLive = true;
        bufStep(sl, stt, cur, want, !!st[t.k].playing, Date.now());
        /* heal counters reset only after 10 s of unmasked continuous clean play */
        if (stt === 1 && !sl._bMask) { const nowC = Date.now(); if (!sl._cleanPlayAt) sl._cleanPlayAt = nowC; else if (nowC - sl._cleanPlayAt >= 10000) { sl._healN = 0; sl._bufHealN = 0; } } else sl._cleanPlayAt = 0;
        /* the sync lock: deadband / rate nudge / snap (≤1 per 3 s per
           slot, never while buffering, never in the last 5 s) */
        if (st[t.k].playing && stt === 1) {
          const durL = +st[t.k].dur || 0, provL = vparseTok(sl.vid).p, mulL = (provL === "dm" || provL === "vm") ? 3 : 1;
          if (!(durL > 0 && durL - want <= 5)) {
            const dec = syncLockCalc(cur - want, mulL);
            if (dec.act === "snap") { if (sl._bMask) { if (sl._maskSnap) { sl.p.seekTo(want, true); sl.seekAt = Date.now(); if (sl.rateCur && sl.rateCur !== 1 && sl.p.setPlaybackRate) { sl.p.setPlaybackRate(1); sl.rateCur = 1; } } } else if (Date.now() - (sl.seekAt || 0) >= 3000) { sl.p.seekTo(want, true); sl.seekAt = Date.now(); if (sl.rateCur && sl.rateCur !== 1 && sl.p.setPlaybackRate) { sl.p.setPlaybackRate(1); sl.rateCur = 1; } } }
            else if (dec.act === "nudge") {
              if (sl.p.rateOk && sl.p.rateOk()) { if (sl.rateCur !== dec.rate && sl.p.setPlaybackRate) { sl.p.setPlaybackRate(dec.rate); sl.rateCur = dec.rate; } }
              else if (cur > want) { if (Date.now() - (sl.holdAt || 0) >= 4000) { sl.holdAt = Date.now(); const pHold = sl.p, kHold = t.k, msHold = Math.max(60, Math.min(340, Math.round((cur - want) * 1000))); sl.holdUntil = Date.now() + msHold; pHold.pauseVideo(); setTimeout(() => { try { if (S()[kHold].playing) pHold.playVideo(); } catch (_) {} }, msHold); } }
              else if (Date.now() - (sl.seekAt || 0) >= 3000) { sl.p.seekTo(want, true); sl.seekAt = Date.now(); }
            }
            else if (sl.rateCur && sl.rateCur !== 1 && sl.p.setPlaybackRate) { sl.p.setPlaybackRate(1); sl.rateCur = 1; }
          }
        }
        if (stt !== 1 && st[t.k].playing && !(sl.holdUntil && Date.now() < sl.holdUntil)) sl.p.playVideo();
        if (stt === 1 && !st[t.k].playing) { sl.p.pauseVideo(); if (sl.rateCur && sl.rateCur !== 1 && sl.p.setPlaybackRate) { sl.p.setPlaybackRate(1); sl.rateCur = 1; } }
        if (!muted) { if (sl.p.unMute) sl.p.unMute(); sl.p.setVolume(Math.round(Math.max(0, Math.min(1, stageGain(st, t.k) * (duck || 1) * (mix || 1) * boostMk(st))) * 100)); }
        else if (sl.p.mute) sl.p.mute();
      } catch (_) {} }
    }
    /* mwScreenHeal — the viewer screens' self-heal: a slot buffering
       continuously >6 s rebuilds on the buffering ladder (own counter,
       24 s backoff, then rest masked on the slate); a slot with no
       frame for 12 s rebuilds once, a second failure waits 24 s, then
       rests.
       #443 COLD-START CURE (ported from the live cold-start build —
       these lessons now live in the ONE engine, for every surface
       including the band):
       - a never-framed slot gets its full first-frame patience: the
         buffering ladder may not rebuild it before ~12 s from its
         first heal sight (_noFrameAt) — a cold player's _bufSince is
         back-stamped to its infancy, so the 6 s fuse alone destroyed
         first players ~7 s after birth and discarded their buffer;
       - CHIP HONESTY: _healK paints " · retrying…", which is only
         true once a rebuild has actually fired for the slot. Before
         that the slot is simply starting and the chip says so via
         _startK (" · starting…") — a normal cold start is not a
         retry. healFlag routes the flag by whether either ladder has
         spent a rebuild yet; once a ladder is exhausted the chip
         stops claiming a retry that will never come. */
    {
      const nowH = Date.now();
      scr._healK = "";
      scr._startK = "";
      const healFlag = (hsl, hk) => { if ((hsl._healN || 0) === 0 && (hsl._bufHealN || 0) === 0) scr._startK = hk; else scr._healK = hk; };
      tg.forEach((t) => {
        const si = scr.slots.findIndex((x) => x.deck === t.k); if (si < 0) return;
        const sl = scr.slots[si];
        if (sl._bufSince && st[t.k].playing && nowH - sl._bufSince > 6000 && (sl._hadFrame || (sl._noFrameAt && nowH - sl._noFrameAt > 12000))) {
          if ((sl._bufHealN || 0) >= 2) return;
          healFlag(sl, t.k);
          if ((sl._bufHealN || 0) === 1 && sl._lastHealAt && nowH - sl._lastHealAt < 24000) return;
          const mountB = scr.slotEls[si]; if (!mountB) return;
          if (sl.p) { try { sl.p.destroy(); } catch (_) {} }
          sl.p = null; mountB.innerHTML = "<div></div>";
          sl._bufHealN = (sl._bufHealN || 0) + 1; sl._lastHealAt = nowH; sl._noFrameAt = nowH; sl._hadFrame = false; sl._sawPlay = false; sl._cleanPlayAt = 0;
          sl._bufSince = nowH; sl._bMask = true; sl._bStateAt = 0; sl._bLastCur = null; sl._bAdvAt = 0; sl._bCleanAcc = 0; sl._bDirtySince = 0; sl._bPrevAt = 0; sl._bPrevClean = false; sl._maskSnapAt = 0;
          sl.p = mkVidPlayer(mountB.firstChild, sl.vid, muted, t.k, false, { cap: scr.cap });
          return;
        }
        if (sl._hadFrame) { sl._noFrameAt = 0; return; }
        if (!sl.p) return;
        if (!sl._noFrameAt) { sl._noFrameAt = nowH; healFlag(sl, t.k); return; }
        if ((sl._healN || 0) < 2) healFlag(sl, t.k);
        const wait = sl._healN === 0 ? 12000 : sl._healN === 1 ? 24000 : Infinity;
        if (nowH - sl._noFrameAt < wait) return;
        const mount = scr.slotEls[si]; if (!mount) return;
        try { sl.p.destroy(); } catch (_) {}
        sl.p = null; mount.innerHTML = "<div></div>";
        sl._healN = (sl._healN || 0) + 1; sl._noFrameAt = nowH; sl._lastHealAt = nowH; sl._sawPlay = false; sl._cleanPlayAt = 0;
        sl.p = mkVidPlayer(mount.firstChild, sl.vid, muted, t.k, false, { cap: scr.cap });
      });
    }
    const top = tg.slice().sort((a, b) => b.op - a.op)[0];
    /* the screen-level mask: the featured slot is stalling and no other
       target is cleanly showing, so the viewer watches the slate/poster
       (the chip says "buffering") instead of the skip itself.
       SLATE HYSTERESIS (#443, poster-flash cure): bufScr still drives
       the chip's " · buffering…" the moment a dip starts, but the
       slate/poster may only COVER the picture on a SUSTAINED stall —
       bufHard is bufScr gated on the featured slot having presented
       no moving frame for ~4 s (its _frameAt stamp). A player
       oscillating in and out of buffering on a weak connection used
       to re-slate the screen on every dip; brief dips now hold the
       last presented frame. */
    let bufScr = false, bufHard = false;
    if (top) { const fsl = scr.slots.find((x) => x.deck === top.k); const otherClean = tg.some((t) => { if (t.k === top.k) return false; const os = scr.slots.find((x) => x.deck === t.k); return !!(os && os._hadFrame && !os._bMask); }); bufScr = !!(fsl && fsl._bMask && st[top.k].playing && !otherClean); bufHard = !!(bufScr && (Date.now() - (fsl._frameAt || 0) > 4000)); }
    scr._bufK = bufScr && top ? top.k : "";
    /* the mask COVERS the player (viewer-leg fix 1): a masked slot is
       opacity-covered itself, so the slate/poster underneath is the
       visible surface; restored from disp the moment it unmasks. The
       cover obeys the same ~4 s sustained-stall gate as bufHard —
       a transient dip never covers the last presented frame (#443). */
    scr.slots.forEach((csl, csxi) => {
      if (!csl.deck) { csl._maskCov = false; return; }
        const ctt = tg.find((x) => x.k === csl.deck); if (!ctt) { csl._maskCov = false; return; }
      const cel = scr.slotEls[csxi]; if (!cel) return;
      const otherClean = tg.some((x) => { if (x.k === csl.deck) return false; const os = scr.slots.find((y) => y.deck === x.k); return !!(os && os._hadFrame && !os._bMask); });
      const covered = !!(csl._bMask && st[csl.deck].playing && !otherClean && (Date.now() - (csl._frameAt || 0) > 4000));
      if (covered) { cel.style.opacity = "0"; csl._maskCov = true; }
      else if (csl._maskCov) { cel.style.opacity = (disp[csl.deck] != null ? disp[csl.deck] : ctt.op).toFixed(2); csl._maskCov = false; }
    });
    /* video transitions on discrete dominant-deck switches only */
    const vmNow = st.vmix || {}, vTop = top ? top.k : "";
    if (scr._vAt == null) { scr._vAt = vmNow.at || 0; scr._vTop = vTop; }
    else if (vmNow.b) { scr._vAt = vmNow.at || 0; scr._vTop = vTop; }
    else if (vTop && vTop !== scr._vTop) {
      const stamped = (vmNow.at || 0) !== scr._vAt, hardSwap = !!scr._vTop && !tg.some((x) => x.k === scr._vTop);
      if (stamped || hardSwap) { const tr2 = vmNow.tr || "fade"; if (tr2 !== "cut") vtrSlot(scr, vTop, tr2, vmNow.trMs || 650); }
      scr._vAt = vmNow.at || 0; scr._vTop = vTop;
    } else if (vTop) { scr._vAt = vmNow.at || 0; scr._vTop = vTop; }
    if (chip && top) { chip.hidden = false; chip.textContent = "▶ DECK " + top.k + (st[top.k].title ? " — " + st[top.k].title : "") + (scr._healK === top.k ? " · retrying…" : "") + (scr._startK === top.k ? " · starting…" : "") + (scr._bufK === top.k ? " · buffering…" : ""); }
    /* the standby slate and poster stay up until a target slot has
       really framed (picLive) and the screen is not HARD-masked —
       a transient buffering dip holds the last frame (#443) */
    if (tg.length) { if (stb) stb.style.display = (picLive && !bufHard) ? "none" : "grid"; if (pst) pst.style.display = (picLive && !bufHard) ? "none" : "block"; }
    /* warm the next picture: the featured deck's pair first, then any
       deck the shared vmix record names — viewer warm players ROLL
       muted and are held near the broadcast position */
    try {
      scr.slots.forEach((sl) => { if (!sl.deck && sl.warmK && (!st[sl.warmK] || st[sl.warmK].yt !== sl.vid)) { if (sl.p) { try { sl.p.destroy(); } catch (_) {} sl.p = null; } sl.warmK = ""; sl.vid = ""; sl._hadFrame = false; } });
      scr.slots.forEach((sl) => { if (!sl.deck && sl.warmK && sl.p) { try { sl.p.mute(); const wk = sl.warmK, stw = sl.p.getPlayerState ? sl.p.getPlayerState() : -1, cw = sl.p.getCurrentTime ? sl.p.getCurrentTime() : 0, ww = slotWant(wk); if (st[wk] && st[wk].playing) { if (stw !== 1) sl.p.playVideo(); if (cw > 0 && Math.abs(cw - ww) > 3) sl.p.seekTo(ww, true); } else if (stw === 1 && cw - ww > 3) sl.p.pauseVideo(); } catch (_) {} } });
      let candList = [];
      if (top) candList.push(PAIR[top.k]); const vm2 = st.vmix || {}; if (vm2.a) candList.push(vm2.a); if (vm2.b) candList.push(vm2.b);
      candList = candList.filter((c, ix) => c && candList.indexOf(c) === ix && c !== (top ? top.k : "") && st[c] && st[c].yt && !tg.some((x) => x.k === c));
      if (candList.length) {
        const cand = ((scr.slots.find((sl) => !sl.deck && sl.warmK && candList.indexOf(sl.warmK) >= 0) || {}).warmK) || candList[0];
        if (cand && cand !== (top ? top.k : "") && st[cand] && st[cand].yt && !tg.some((x) => x.k === cand)) {
          const fi = scr.slots.findIndex((sl) => !sl.deck);
          if (fi >= 0) { const sl = scr.slots[fi]; if (!(sl.warmK === cand && sl.p && sl.vid === st[cand].yt)) { const mount = scr.slotEls[fi]; if (mount) { const provW = vparseTok(st[cand].yt).p; if (provW === "yt") await ytApi(); else if (provW === "dm") await dmApi(); else if (provW === "vm") await vmApi(); if ((provW === "yt" && window.YT && YT.Player) || (provW === "dm" && window.DM && DM.player) || (provW === "vm" && window.Vimeo && Vimeo.Player)) { if (sl.p) { try { sl.p.destroy(); } catch (_) {} sl.p = null; } mount.innerHTML = "<div></div>"; mount.style.opacity = 0; sl.vid = st[cand].yt; sl.warmK = cand; sl._hadFrame = false; sl._bMask = false; sl._bufSince = 0; sl._bLastCur = null; sl.p = mkVidPlayer(mount.firstChild, sl.vid, true, cand, true, { cap: scr.cap, roll: true }); } } } }
        }
      }
    } catch (_) {}
  }

  /* ==========================================================================
     THE SHARE LEG — the master screen as a takeover source (Law 2).
     The viewer half of the live vs* system, ported: the watcher sweep,
     stage-join + room-HLS fallback for LIVESTREAM rooms, the capture's
     own sound as the only sound while the share is up, viewer pause as
     a purely local mute, and the plain-words TV status line. The
     publisher half is the booth's (Phase 3) and is not here.
     ========================================================================== */
  let vsShown = { track: null, stream: null, hls: null, atrack: null };
  let vsWatchErr = "";
  let vsStatusTxt = null;
  let vsPauseSig = "";
  let vsWatch = null, vsWatchBusy = false;
  let vsWatchRetryMid = "", vsWatchRetryAt = 0;
  let vsSndBlocked = false;
  let vsHlsSndEl = null;
  let vsLocalPause = false, vsPauseWasListening = false;
  let vsAvSnapAt = 0, vsAvRateEl = null;
  let vsSdkP = null;

  const KIND_RANK = { stage: 0, mini: 1, tv: 2, watch: 3 };
  const stageKind = new Map();
  function vsStageEls() {
    return [...shareStages].filter((el) => el.isConnected)
      .sort((a, b) => (KIND_RANK[stageKind.get(a)] ?? 9) - (KIND_RANK[stageKind.get(b)] ?? 9));
  }
  function vsVid(stage) { let v = stage.querySelector("video.vslive"); if (!v) { v = document.createElement("video"); v.className = "vslive"; v.autoplay = true; v.muted = true; v.playsInline = true; stage.appendChild(v); } return v; }
  function vsNoteErr(e) { try { const m = (e && e.message) ? String(e.message) : String(e || ""); if (m) vsWatchErr = m.slice(0, 42); } catch (_) {} }
  const vsShareDown = () => { const vs = S().vstream || {}; const st = vs.diag && vs.diag.stage; return !!vs.on && (st === "repairing" || st === "source-gone"); };
  function vsLoadSdk() {
    if (window.RealtimeKitClient) return Promise.resolve(true);
    if (!vsSdkP) vsSdkP = new Promise((res) => { const s = document.createElement("script"); let done = false; const fin = (ok) => { if (done) return; done = true; if (!ok) vsSdkP = null; res(ok); }; s.src = VS_SDK_URL; s.onload = () => fin(!!window.RealtimeKitClient); s.onerror = () => fin(false); document.head.appendChild(s); setTimeout(() => fin(!!window.RealtimeKitClient), 12000); });
    return vsSdkP;
  }
  async function vsApi(body) {
    const ses = session && session.get ? session.get() : null;
    const h = { "content-type": "application/json" };
    if (ses && ses.access_token) h.authorization = "Bearer " + ses.access_token;
    try { const ctl = (typeof AbortController !== "undefined") ? new AbortController() : null; const to = ctl ? setTimeout(() => { try { ctl.abort(); } catch (_) {} }, 12000) : 0; const r = await fetch("/api/streams", { method: "POST", headers: h, body: JSON.stringify(body), signal: ctl ? ctl.signal : undefined }); if (to) clearTimeout(to); return await r.json().catch(() => null); } catch (_) { return null; }
  }
  function vsAttach(stream) { vsStageEls().forEach((st) => { const v = vsVid(st); try { detachHls(v); v.muted = true; if (v.srcObject !== stream) { v.srcObject = stream; const p = v.play(); if (p && p.catch) p.catch(() => {}); } } catch (_) {} st.classList.add("vs-on"); }); }
  function vsDetach() { vsShown = { track: null, stream: null, hls: null, atrack: null }; try { vsAudioStop(); } catch (_) {} vsHlsSndEl = null; vsStageEls().forEach((st) => { st.classList.remove("vs-on"); const v = st.querySelector("video.vslive"); if (v) { try { detachHls(v); v.pause(); v.srcObject = null; } catch (_) {} } }); }
  function vsShowTrack(track, atrack) {
    if (!track || track.readyState === "ended") { if (vsShown.track) vsDetach(); return; }
    if (vsShown.track !== track || vsShown.atrack !== (atrack || null)) vsShown = { track, stream: new MediaStream([track]), hls: null, atrack: atrack || null };
    vsAttach(vsShown.stream);
    vsAudioPlay(atrack || null);
  }
  /* the capture's sound, viewer side: ONE body-level audio element on
     the WebRTC path (stage videos stay muted — three surfaces showing
     one picture must never echo it); on the HLS path the sound rides
     the stage element itself (vsHlsPickSound) */
  function vsAudioEl() { let a = document.getElementById("vs-audio"); if (!a) { a = document.createElement("audio"); a.id = "vs-audio"; a.autoplay = true; a.style.display = "none"; document.body.appendChild(a); } return a; }
  function vsAudioPlay(atrack) {
    try {
      if (!atrack || atrack.readyState !== "live") { const a0 = document.getElementById("vs-audio"); if (a0 && a0.srcObject) { try { a0.pause(); } catch (_) {} a0.srcObject = null; } return; }
      const a = vsAudioEl();
      const cur = a.srcObject && a.srcObject.getAudioTracks()[0];
      if (cur !== atrack) a.srcObject = new MediaStream([atrack]);
      vsSndBlocked = false;
      const p = a.play(); if (p && p.catch) p.catch(() => { vsSndBlocked = true; });
    } catch (_) {}
  }
  function vsAudioStop() { try { const a = document.getElementById("vs-audio"); if (a) { try { a.pause(); } catch (_) {} a.srcObject = null; } } catch (_) {} }
  function vsShowHls(url) {
    if (!url) return;
    if (vsShown.hls !== url) vsShown = { track: null, stream: null, hls: url };
    vsStageEls().forEach((st) => { const v = vsVid(st); try {
      if (v._vsHlsUrl !== url) { try { v.srcObject = null; } catch (_) {} attachHls(v, url); }
      const p = v.play(); if (p && p.catch) p.catch(() => {});
    } catch (_) {} st.classList.add("vs-on"); });
    vsHlsPickSound(false);
  }
  function vsHlsPickSound(force) {
    try {
      if (!vsShown.hls) { if (vsHlsSndEl) { try { vsHlsSndEl.muted = true; } catch (_) {} vsHlsSndEl = null; } return; }
      const rank = { tv: 0, stage: 1, mini: 2, watch: 3 };
      const els = vsStageEls().slice().sort((a, b) => (rank[stageKind.get(a)] ?? 9) - (rank[stageKind.get(b)] ?? 9));
      let pick = null;
      for (const st of els) { if (!st.classList.contains("vs-on")) continue; const v = st.querySelector("video.vslive"); if (v && st.getClientRects().length) { pick = v; break; } }
      if (!pick) { const st0 = els.find((el) => stageKind.get(el) === "mini"); if (st0) pick = st0.querySelector("video.vslive"); }
      if (pick === vsHlsSndEl && !force) return;
      vsStageEls().forEach((st) => { const v = st.querySelector("video.vslive"); if (v && v !== pick) { try { v.muted = true; } catch (_) {} } });
      vsHlsSndEl = pick;
      if (pick) { try { pick.muted = false; const p = pick.play(); if (p && p.catch) p.catch(() => { try { pick.muted = true; } catch (_) {} if (vsHlsSndEl === pick) vsHlsSndEl = null; vsSndBlocked = true; }); } catch (_) {} }
    } catch (_) {}
  }
  /* the share sync lock (live vsAvSyncLock): picture and sound arrive
     as separate elements with no shared clock; this 2 s lock corrects
     with the sync lock's own hysteresis. The HLS live-edge trim is a
     stall rescue only — 30 s behind, never at the cushion itself. */
  function vsAvSyncLock() {
    try {
      if (vsLocalPause) return;
      if (!vsBroadcast(S()) || (S().vstream || {}).hidden || vsShareDown()) return;
      const now = Date.now();
      if (vsShown.hls) {
        const ref = vsHlsSndEl;
        vsStageEls().forEach((st) => { const v = st.querySelector("video.vslive"); if (!v) return;
          try { if ((v === ref || !ref) && v.seekable && v.seekable.length) { const end = v.seekable.end(v.seekable.length - 1); if (isFinite(end) && end - (v.currentTime || 0) > 30 && now - (v._avEdge || 0) >= 10000) { v.currentTime = Math.max(0, end - 2); v._avEdge = now; } } } catch (_) {}
          if (!ref || v === ref) return;
          if (!isFinite(v.currentTime) || !isFinite(ref.currentTime)) return;
          const dec = syncLockCalc(v.currentTime - ref.currentTime, 1);
          if (dec.act === "snap") { if (now - (v._avAt || 0) >= 3000) { try { v.currentTime = Math.max(0, ref.currentTime); } catch (_) {} v._avAt = now; try { v.playbackRate = 1; } catch (_) {} } }
          else if (dec.act === "nudge") { try { v.playbackRate = v.currentTime > ref.currentTime ? 0.95 : 1.05; } catch (_) {} }
          else { try { if (v.playbackRate !== 1) v.playbackRate = 1; } catch (_) {} }
        });
        return;
      }
      if (!vsShown.track || vsShown.track.readyState !== "live") return;
      let pic = null;
      vsStageEls().forEach((st) => { if (pic) return; const v = st.querySelector("video.vslive"); if (v && st.classList.contains("vs-on") && st.getClientRects().length) pic = v; });
      if (!pic) return;
      const a = document.getElementById("vs-audio");
      if (!a || !a.srcObject) { if (vsAvRateEl) { try { vsAvRateEl.playbackRate = 1; } catch (_) {} vsAvRateEl = null; } return; }
      if (!(pic.currentTime > 0) || !(a.currentTime > 0)) return;
      const drift = pic.currentTime - a.currentTime;
      const dec = syncLockCalc(drift, 1);
      if (dec.act === "none") { if (vsAvRateEl) { try { vsAvRateEl.playbackRate = 1; } catch (_) {} vsAvRateEl = null; } return; }
      if (dec.act === "nudge") { const lag = drift > 0 ? a : pic; try { lag.playbackRate = 1.05; } catch (_) {} if (vsAvRateEl && vsAvRateEl !== lag) { try { vsAvRateEl.playbackRate = 1; } catch (_) {} } vsAvRateEl = lag; return; }
      if (now - vsAvSnapAt < 4000) return; vsAvSnapAt = now;
      if (vsAvRateEl) { try { vsAvRateEl.playbackRate = 1; } catch (_) {} vsAvRateEl = null; }
      if (drift > 0) { try { a.pause(); const p = a.play(); if (p && p.catch) p.catch(() => {}); } catch (_) {} }
      else { vsStageEls().forEach((st) => { const v = st.querySelector("video.vslive"); if (v && st.classList.contains("vs-on")) { try { v.pause(); const p = v.play(); if (p && p.catch) p.catch(() => {}); } catch (_) {} } }); }
    } catch (_) {}
  }
  /* the TV status line: plain words in the corner of the big screens,
     present only while a share is on — every watcher step reflected */
  function vsSetStatus(txt) {
    if (txt === vsStatusTxt) return; vsStatusTxt = txt;
    vsStageEls().filter((st) => ["stage", "tv", "watch"].includes(stageKind.get(st))).forEach((h) => { let el = h.querySelector(".vstatus"); if (!el) { el = document.createElement("div"); el.className = "vstatus"; h.appendChild(el); } el.hidden = !txt; if (txt && el.textContent !== txt) el.textContent = txt; });
  }
  function vsStatusFor() {
    const vs = S().vstream || {};
    if (!vs.on || !vs.meeting) return "";
    if (vsShareDown()) return "TV: reconnecting…";
    if (vs.hidden) return "TV: hidden by Meechie";
    if ((vsShown.track && vsShown.track.readyState === "live") || vsShown.hls) {
      if ((vs.diag || {}).stage === "publishing" && Date.now() - (vs.at || 0) > 75000) return "TV: reconnecting…";
      return "TV: live";
    }
    if (vsWatch) return "TV: joined — waiting for picture";
    if (vsWatchRetryMid === vs.meeting && vsWatchErr) return "TV: retrying (" + vsWatchErr + ")";
    return "TV: connecting…";
  }
  /* viewer pause = local mute only: pauses the picture on THIS screen
     (surfaces fall back to the mix) and mutes this viewer's sound —
     writes no shared state, never touches the broadcast */
  function vsLocalDetach() {
    vsStageEls().forEach((st) => { st.classList.remove("vs-on"); const v = st.querySelector("video.vslive"); if (v) { try { detachHls(v); } catch (_) {} try { v.pause(); } catch (_) {} } });
    try { const a = document.getElementById("vs-audio"); if (a) a.pause(); } catch (_) {}
    if (vsHlsSndEl) { try { vsHlsSndEl.muted = true; } catch (_) {} vsHlsSndEl = null; }
  }
  function vsToggleLocalPause() {
    if (!vsLocalPause) {
      vsLocalPause = true;
      vsPauseWasListening = listening;
      vsLocalDetach();
      if (listening) setListening(false);
    } else {
      vsLocalPause = false;
      if (vsPauseWasListening && !listening) setListening(true);
      vsPauseWasListening = false;
      try { if (vsShown.hls) vsShowHls(vsShown.hls); else vsWatchGrab(); } catch (_) {}
      vsStageEls().forEach((st) => { const v = st.querySelector("video.vslive"); if (v && st.classList.contains("vs-on")) { try { const p = v.play(); if (p && p.catch) p.catch(() => {}); } catch (_) {} } });
      try { if (vsShown.atrack) vsAudioPlay(vsShown.atrack); } catch (_) {}
    }
    vsPauseSig = ""; vsPaintPause();
  }
  function vsPaintPause() {
    try {
      const on = vsBroadcast(S()) && !(S().vstream || {}).hidden;
      const hosts = vsStageEls();
      const sig = (on ? "1" : "0") + "|" + (vsLocalPause ? "p" : "") + "|" + hosts.map((h) => h.classList.contains("vs-on") ? "1" : "0").join("");
      if (sig === vsPauseSig) return; vsPauseSig = sig;
      hosts.forEach((h) => { let b = h.querySelector(".vspause"); if (!b) { b = document.createElement("button"); b.type = "button"; b.className = "vspause"; b.title = "Pause the live picture and sound just for you — the broadcast keeps going for everyone else"; b.addEventListener("click", () => vsToggleLocalPause()); h.appendChild(b); } const show = on && (vsLocalPause || h.classList.contains("vs-on")); b.hidden = !show; const lab = vsLocalPause ? "▶ Back to live" : "⏸ Pause for me"; if (b.textContent !== lab) b.textContent = lab; });
    } catch (_) {}
  }
  /* ---------- the watcher sweep (live vsWatchGrab, verbatim logic) ----
     A 1 s polling sweep: walks EVERY participant collection, reads both
     track channels off every peer, attaches the first live track. In a
     LIVESTREAM room it also tries the stage join and the room's own
     HLS playback. Every failure lands on the TV status line. */
  function vsPeers(meeting) {
    const out = [];
    const eat = (coll) => {
      if (!coll) return;
      try { if (typeof coll.forEach === "function") { coll.forEach((p) => { if (p) out.push(p); }); return; } } catch (_) {}
      try { if (typeof coll.toArray === "function") { coll.toArray().forEach((p) => { if (p) out.push(p); }); return; } } catch (_) {}
      try { Object.keys(coll).forEach((k) => { const p = coll[k]; if (p && typeof p === "object" && (p.videoTrack !== undefined || p.screenShareTracks !== undefined)) out.push(p); }); } catch (_) {}
    };
    try { eat(meeting.participants && meeting.participants.active); } catch (_) {}
    try { eat(meeting.participants && meeting.participants.joined); } catch (_) {}
    try { eat(meeting.participants && meeting.participants.pinned); } catch (_) {}
    try { eat(meeting.participants && meeting.participants.waitlisted); } catch (_) {}
    try { eat(meeting.participants && meeting.participants.all); } catch (_) {}
    const selfId = (meeting.self && meeting.self.id) || "";
    const seen = new Set();
    return out.filter((p) => { if (!p || typeof p !== "object") return false; const id = p.id || ""; if (id && selfId && id === selfId) return false; if (id) { if (seen.has(id)) return false; seen.add(id); } return true; });
  }
  function vsTrackOf(p, key) { try { return key === "ss" ? (p.screenShareTracks && p.screenShareTracks.video) : key === "at" ? p.audioTrack : p.videoTrack; } catch (_) { return null; } }
  function vsSubAll(meeting) {
    try {
      const ps = meeting && meeting.participants; if (!ps || !ps.joined) return;
      try { if (ps.viewMode !== "MANUAL" && typeof ps.setViewMode === "function") ps.setViewMode("MANUAL"); } catch (_) {}
      if (typeof ps.subscribe !== "function") return;
      const ids = [];
      try { ps.joined.forEach((pp) => { if (pp && pp.id) ids.push(pp.id); }); } catch (_) {}
      if (!ids.length) return;
      try { const pr = ps.subscribe(ids); if (pr && pr.catch) pr.catch((e) => vsNoteErr(e)); } catch (e) { vsNoteErr(e); }
    } catch (_) {}
  }
  function vsHookPeer(pp) {
    if (!pp || pp._vsHooked || typeof pp.on !== "function") return;
    pp._vsHooked = true;
    try { pp.on("videoUpdate", () => vsWatchGrab()); } catch (_) {}
    try { pp.on("screenShareUpdate", () => vsWatchGrab()); } catch (_) {}
  }
  function vsEnsureEls() { vsStageEls().forEach((st) => { try { vsVid(st); } catch (_) {} }); }
  function vsLiveUrl(meeting) {
    try { const ls = meeting && meeting.livestream; if (!ls) return "";
      if (ls.playbackUrl) return String(ls.playbackUrl);
      if (typeof ls.fetchInitialLivestreamingState === "function" && !ls._vsFetched) { ls._vsFetched = 1; const pr = ls.fetchInitialLivestreamingState(); if (pr && pr.catch) pr.catch(() => {}); }
    } catch (_) {}
    return "";
  }
  function vsTryStage(w) {
    try {
      const self = w.meeting.self;
      if (self && self.stageStatus === "ON_STAGE") return;
      const st = w.meeting.stage;
      if (st && typeof st.join === "function") { const pr = st.join(); if (pr && pr.catch) pr.catch((e) => vsNoteErr(e)); return; }
      if (self && typeof self.joinStage === "function") { const pr2 = self.joinStage(); if (pr2 && pr2.catch) pr2.catch((e) => vsNoteErr(e)); }
    } catch (e) { vsNoteErr(e); }
  }
  function vsWatchGrab() {
    const w = vsWatch; if (!w || !w.meeting) return;
    try {
      vsSubAll(w.meeting);
      if ((S().vstream || {}).hidden) { vsDetach(); return; }
      if (vsShareDown()) { vsDetach(); return; }
      if (vsLocalPause) return;
      const kind = (S().vstream || {}).kind;
      const order = kind === "screen" ? ["ss", "vt"] : ["vt", "ss"];
      const peers = vsPeers(w.meeting);
      let best = null, bestP = null;
      peers.forEach((p) => { if (!p || best) return; for (const key of order) { const t = vsTrackOf(p, key); if (t && t.readyState === "live") { best = t; bestP = p; break; } } });
      try { w.stageStatus = (w.meeting.self && w.meeting.self.stageStatus) || w.stageStatus || ""; } catch (_) {}
      if (best) { w.got = Date.now(); if (vsShown.hls) vsDetach(); const at2 = bestP ? vsTrackOf(bestP, "at") : null; vsShowTrack(best, at2 && at2.readyState === "live" ? at2 : null); return; }
      if (vsShown.hls) {
        if (w.viewType === "LIVESTREAM" && Date.now() - (w.stageRetryAt || w.stageTried || 0) > 30000) { w.stageRetryAt = Date.now(); w.stageTried = Date.now(); vsTryStage(w); }
        return;
      }
      if (w.got && vsShown.track && vsShown.track.readyState === "ended") { vsWatchStop(); vsDetach(); return; }
      if (w.viewType === "LIVESTREAM" && !w.stageTried) { w.stageTried = Date.now(); vsTryStage(w); }
      if (w.viewType === "LIVESTREAM" || Date.now() - w.triedAt > 12000) { const lu = vsLiveUrl(w.meeting); if (lu) { w.got = Date.now(); vsShowHls(lu); } }
    } catch (e) { vsNoteErr(e); }
  }
  async function vsWatchStop() {
    const w = vsWatch; vsWatch = null;
    if (!w) return;
    if (w.iv) { try { clearInterval(w.iv); } catch (_) {} }
    if (w.meeting) { try { await w.meeting.leave(); } catch (_) {} }
  }
  function vsWatchRetry(mid) { vsWatchRetryMid = mid; vsWatchRetryAt = Date.now() + 20000; }
  async function vsWatchStart(mid) {
    if (vsWatchBusy || (vsWatch && vsWatch.mid === mid)) return;
    vsWatchBusy = true; vsWatchErr = "";
    let meeting = null;
    try {
      const mint = await vsApi({ action: "live_mint", role: "watch", meeting: mid });
      if (!mint || !mint.token) { vsNoteErr((mint && mint.message) || "the streaming service did not answer"); vsWatchRetry(mid); return; }
      if (!(await vsLoadSdk())) { vsNoteErr("the video engine did not load"); vsWatchRetry(mid); return; }
      meeting = await RealtimeKitClient.init({ authToken: mint.token, defaults: { audio: false, video: false } });
      try { meeting.participants.setViewMode("MANUAL"); } catch (_) {}
      try { const jn = meeting.participants.joined, cb = (pp) => { vsHookPeer(pp); vsWatchGrab(); }; if (typeof jn.on === "function") { jn.on("participantJoined", cb); jn.on("participantLeft", () => vsWatchGrab()); } else if (typeof jn.addListener === "function") { jn.addListener("participantJoined", cb); jn.addListener("participantLeft", () => vsWatchGrab()); } } catch (_) {}
      try { const ac = meeting.participants.active; if (ac && typeof ac.on === "function") ac.on("participantJoined", () => vsWatchGrab()); } catch (_) {}
      let joinedOk = false;
      await Promise.race([meeting.join().then(() => { joinedOk = true; }), new Promise((res) => setTimeout(res, 15000))]);
      if (!joinedOk) throw new Error("join timeout");
      const w = { meeting, mid, got: 0, triedAt: Date.now(), iv: null, viewType: "", stageStatus: "", stageTried: 0 };
      try { w.viewType = (meeting.meta && meeting.meta.viewType) || (meeting.self && meeting.self.config && meeting.self.config.viewType) || ""; } catch (_) {}
      try { w.stageStatus = (meeting.self && meeting.self.stageStatus) || ""; } catch (_) {}
      vsWatch = w;
      vsWatchRetryMid = ""; vsWatchRetryAt = 0;
      vsSubAll(meeting);
      vsPeers(meeting).forEach((pp) => vsHookPeer(pp));
      vsEnsureEls();
      vsWatchGrab();
      w.iv = setInterval(() => { try { vsWatchGrab(); } catch (_) {} }, 1000);
    } catch (e) {
      vsNoteErr(e);
      if (meeting) { try { await meeting.leave(); } catch (_) {} }
      if (vsWatch && vsWatch.mid === mid) { const w2 = vsWatch; vsWatch = null; if (w2.iv) { try { clearInterval(w2.iv); } catch (_) {} } }
      vsWatchRetry(mid);
    }
    finally { vsWatchBusy = false; }
  }
  /* the master switch, viewer half (live vsSync): join whenever the
     switch is on — a stale stamp never keeps a viewer out — and retry
     a failed join about every 20 s for as long as the switch stays on */
  function shareSync() {
    try {
      try { vsSetStatus(vsStatusFor()); } catch (_) {}
      vsPaintPause();
      const vs = S().vstream || {};
      if (!vs.on || !vs.meeting) { if (vsLocalPause) { vsLocalPause = false; vsPauseWasListening = false; vsPauseSig = ""; } if (vsWatch) vsWatchStop(); vsDetach(); return; }
      if (vsWatch && vsWatch.mid !== vs.meeting) { vsWatchStop(); vsDetach(); }
      if (!vsWatch) { if (vsWatchRetryMid === vs.meeting && Date.now() < vsWatchRetryAt) return; vsWatchStart(vs.meeting); return; }
      if (vs.hidden) { vsDetach(); return; }
      if (vsShareDown()) { vsDetach(); return; }
      try { if (vsShown.hls) vsHlsPickSound(false); } catch (_) {}
      vsWatchGrab();
    } catch (_) {}
  }
  /* the arrival pop-out gate (live vsPopReady): the greeting lands
     first — the v2 Enter screen is the greeting — then the mini may
     carry the share. A dismissal holds for THIS meeting only. */
  function popReady() {
    const e = document.getElementById("enter");
    if (e && !e.hidden) return false;
    if (Date.now() - (performance.timeOrigin || 0) < 6000) return false;
    try { if (sessionStorage.getItem("mw_vs_dismissed") === ((S().vstream || {}).meeting || "")) return false; } catch (_) {}
    return true;
  }
  function shareFlowing() { return !!((vsShown.track && vsShown.track.readyState === "live") || vsShown.hls); }
  function dismissSharePop() {
    try {
      const mini = vsStageEls().find((el) => stageKind.get(el) === "mini");
      if (mini && mini.classList.contains("vs-on")) { sessionStorage.setItem("mw_vs_dismissed", (S().vstream || {}).meeting || ""); sessionStorage.removeItem("mw_mini_off"); }
    } catch (_) {}
  }

  /* ---------------- VFX watcher ---------------- */
  let vfxHeard = 0, vfxInit = false;
  feed.subscribe(() => {
    const v = S() && S().vfx, t = +(v && v.at) || 0; if (!t) return;
    if (!vfxInit) { vfxInit = true; vfxHeard = t; return; }
    if (t === vfxHeard) return;
    vfxHeard = t;
    if (Date.now() - t > 15000) return;
    if (!VFX_DUR[v.kind]) return;
    document.querySelectorAll(".vstage").forEach((st) => { const cls = "vfx-" + v.kind; st.classList.remove(cls); void st.offsetWidth; st.classList.add(cls); setTimeout(() => st.classList.remove(cls), VFX_DUR[v.kind] + 80); });
  });

  /* a refused unmuted play retries on the viewer's first tap anywhere */
  document.addEventListener("pointerdown", () => { if (!vsSndBlocked) return; vsSndBlocked = false; try { if (vsShown.atrack) vsAudioPlay(vsShown.atrack); if (vsShown.hls) vsHlsPickSound(true); } catch (_) {} }, true);

  /* ---------------- the stage cadence ----------------
     Surfaces register a tick callback under a canonical name; the
     engine runs them in the live stageApply order (stage → mini →
     tv → watch) on the 700 ms cadence, then the share switch. The
     render loop is the surfaces' only clock. (Under the CEMENT LAW
     the band is never box-hidden except on its suppressed views,
     where its surface skips rendering entirely — players exist only
     in visible surfaces, #443.) */
  const surfaces = new Map();
  let tickBusy = false;
  async function tick() {
    if (tickBusy || document.hidden) return;
    tickBusy = true;
    try {
      for (const name of ["stage", "mini", "tv", "watch"]) {
        const fn = surfaces.get(name);
        if (fn) { try { await fn(); } catch (_) {} }
      }
      shareSync();
    } catch (_) {}
    tickBusy = false;
  }
  setInterval(tick, 700);
  setInterval(() => { try { shareSync(); } catch (_) {} }, 1000);
  setInterval(() => { try { vsAvSyncLock(); } catch (_) {} }, 2000);

  async function renderSurface(scr) {
    const snd = soundingScreen();
    await renderScreen(scr, snd !== scr, 1, S().duck ? 0.28 : 1);
  }

  return {
    feed,
    get listening() { return listening; },
    setListening,
    toggleListening: () => setListening(!listening),
    onListenChange(fn) { listenSubs.add(fn); return () => listenSubs.delete(fn); },
    createScreen, destroyScreen, soundingScreen, renderScreen, renderSurface,
    addSurface(name, fn) { surfaces.set(name, fn); },
    removeSurface(name) { surfaces.delete(name); },
    registerStageKind(el, kind) { stageKind.set(el, kind); },
    shareSync, popReady, shareFlowing, dismissSharePop,
    shareDown: vsShareDown,
    setBandShown,
    get localPause() { return vsLocalPause; },
    toggleLocalPause: vsToggleLocalPause,
  };
}
