/* DJ Station for Meechie's World Radio — a full radio-station board, all free, all in the browser.
 * Owner: two full decks (waveform, 3-band EQ, pitch + vinyl mode, sync, hot cues, loops, brake, scratch),
 *        a mixer with crossfader + master FX (filter, echo, reverb), a live mic with processing + auto-duck,
 *        a jingle/spot board (synth pads + your own recorded drops), listener requests + voice drops,
 *        Auto-DJ queue with auto-crossfade, a program log, a station ticker, show recording,
 *        and the Go Live switch that puts the mix on the station for everyone (doc radio/dj).
 * Listeners: when Meechie is live on the decks, the site plays the same mix in sync; they also get the
 *        station card (ticker, recently played, latest recorded show, request box, voice drops).
 * 24/7: functions/api/station.js is the station keeper — while the booth is open its saves stamp
 *        S.boothAt and the keeper stands down (Malik has the tables); once the booth closes, the
 *        keeper runs the Auto-DJ rotation in the same state, so the tables never go off air. */
(function () {
  "use strict";
  const root = document.getElementById("dj-root");
  if (!root) return;
  // The booth (#dj-owner) moves into its own DJ view (#dj-booth-root). All DJ events
  // delegate from <main>, scoped to the two DJ homes, so the move breaks nothing and
  // no other page element can trigger a DJ control.
  const mainEl = document.querySelector("main");
  const inDj = (e) => !e.target || !e.target.closest || !!e.target.closest("#dj-root,#dj-booth-root");
  const onMain = (type, fn, opts) => { if (mainEl) mainEl.addEventListener(type, (e) => { if (!inDj(e)) return; fn(e); }, opts); };
  const onMainRaw = (type, fn, opts) => { if (mainEl) mainEl.addEventListener(type, fn, opts); };
  const E = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const say = (t) => (typeof toast === "function" ? toast(t) : null);
  // the DJ Playground (?playdj=1): a sandbox copy of the booth that anyone can play
  // with. It runs the same code with a private state and never writes the radio —
  // every guard below keys off this one flag.
  const SANDBOX = (() => { try { return /[?&]playdj=1/.test(location.search); } catch (_) { return false; } })();
  const DB = () => (typeof db !== "undefined" ? db : null);
  const OWNER = () => SANDBOX || (typeof isOwner !== "undefined" && isOwner);
  let showOwnerUI = () => {}; // set by init(); the timers below call it (calling init's own show() from out here threw "show is not defined" every second)
  const TRACKS = () => (typeof tracks !== "undefined" ? tracks : []);
  const URLOF = (t) => (typeof trackUrl === "function" ? trackUrl(t) : "");
  const okUrl = (u) => /^https:\/\/[^\s"'<>]+$/i.test(u || "");
  const DEAD = (u) => typeof u === "string" && u.includes("supabase.co"); // old storage is shut off
  const DBF = () => DB(); // the Firestore-shaped db facade (same one radio/dj uses)
  const rid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
  const tabId = rid(); // this window's booth identity: saves are stamped with it, so two booth
  // windows (the main tab and the pop-out) can tell their own echoes from real commands

  /* ================= audio engine: decks -> EQ -> mixer -> FX -> master ================= */
  let ctx = null, masterIn = null, masterGain = null, analyser = null, recDest = null, limiter = null;
  let fxFilter = null, echoWet = null, verbWet = null, micGain = null, micMon = null, micAn = null;
  let echoFb = null, flaWet = null, gateOsc = null, gateDepth = null, gateGain = null, crushNode = null, crushBuilt = -1;
  let echoDly = null, flaLfo = null, phaWet = null, phaLfo = null, noiseWet = null, noiseBp = null;
  function actx() {
    if (!ctx) {
      try { ctx = new (window.AudioContext || window.webkitAudioContext)({ latencyHint: "playback" }); } catch (_) { try { ctx = new (window.AudioContext || window.webkitAudioContext)(); } catch (__) { ctx = null; } }
      if (ctx) {
        masterIn = ctx.createGain();
        fxFilter = ctx.createBiquadFilter(); fxFilter.type = "lowpass"; fxFilter.frequency.value = 18000; fxFilter.Q.value = 0.4;
        masterGain = ctx.createGain(); masterGain.gain.value = 0.95;
        limiter = ctx.createDynamicsCompressor(); limiter.threshold.value = -1.2; limiter.knee.value = 0; limiter.ratio.value = 20; limiter.attack.value = 0.001; limiter.release.value = 0.24;
        analyser = ctx.createAnalyser(); analyser.fftSize = 256;
        // transformer/gate chopper sits in the master path (depth 0 = open)
        gateGain = ctx.createGain(); gateGain.gain.value = 1;
        crushNode = ctx.createWaveShaper(); crushNode.oversample = "2x";
        // broadcast polish (always on): sub-rumble out, a bass shelf voiced for phone
        // speakers, a touch of presence for clarity, gentle glue compression and a soft
        // ceiling — the station comes out loud, clear and full in the low end
        const polHp = ctx.createBiquadFilter(); polHp.type = "highpass"; polHp.frequency.value = 30; polHp.Q.value = 0.5;
        const polBass = ctx.createBiquadFilter(); polBass.type = "lowshelf"; polBass.frequency.value = 110; polBass.gain.value = 4;
        const polPres = ctx.createBiquadFilter(); polPres.type = "peaking"; polPres.frequency.value = 3200; polPres.Q.value = 0.9; polPres.gain.value = 1.5;
        const polGlue = ctx.createDynamicsCompressor(); polGlue.threshold.value = -18; polGlue.knee.value = 18; polGlue.ratio.value = 2.5; polGlue.attack.value = 0.03; polGlue.release.value = 0.24;
        const polClip = ctx.createWaveShaper(); polClip.oversample = "4x"; { const n = 512, cv = new Float32Array(n), norm = Math.tanh(1.15); for (let i = 0; i < n; i++) { const x = (i / (n - 1)) * 2 - 1; cv[i] = Math.tanh(1.15 * x) / norm; } polClip.curve = cv; }
        masterIn.connect(gateGain); gateGain.connect(crushNode); crushNode.connect(fxFilter); fxFilter.connect(masterGain); masterGain.connect(polHp); polHp.connect(polBass); polBass.connect(polPres); polPres.connect(polGlue); polGlue.connect(polClip); polClip.connect(limiter); limiter.connect(analyser); analyser.connect(ctx.destination);
        gateOsc = ctx.createOscillator(); gateOsc.type = "square"; gateOsc.frequency.value = 4;
        const gateShaper = ctx.createWaveShaper(); gateShaper.curve = new Float32Array([-1, 1]);
        gateDepth = ctx.createGain(); gateDepth.gain.value = 0;
        gateOsc.connect(gateShaper); gateShaper.connect(gateDepth); gateDepth.connect(gateGain.gain); gateOsc.start();
        // echo send (feedback exposed as Echo Repeat)
        const dly = ctx.createDelay(1); dly.delayTime.value = 0.28; echoDly = dly; echoFb = ctx.createGain(); echoFb.gain.value = 0.34;
        const ef = ctx.createBiquadFilter(); ef.type = "lowpass"; ef.frequency.value = 1600; ef.Q.value = 0.4; // dub character: every repeat comes back darker
        const dw = ctx.createGain(); dw.gain.value = 0; dly.connect(echoFb); echoFb.connect(ef); ef.connect(dly); dly.connect(dw); dw.connect(masterGain);
        masterIn.connect(dly); echoWet = dw;
        // flanger send: short modulated delay with feedback
        const fd = ctx.createDelay(0.05); fd.delayTime.value = 0.004;
        const ffb = ctx.createGain(); ffb.gain.value = 0.45;
        const fw = ctx.createGain(); fw.gain.value = 0;
        const lfo = ctx.createOscillator(); lfo.frequency.value = 0.3; flaLfo = lfo; const lfoG = ctx.createGain(); lfoG.gain.value = 0.0016;
        lfo.connect(lfoG); lfoG.connect(fd.delayTime); lfo.start();
        fd.connect(ffb); ffb.connect(fd); fd.connect(fw); fw.connect(masterGain); masterIn.connect(fd); flaWet = fw;
        // phaser send: four allpass stages swept together, light feedback
        const aps = [0, 1, 2, 3].map(() => { const f = ctx.createBiquadFilter(); f.type = "allpass"; f.frequency.value = 800; f.Q.value = 0.8; return f; });
        const pfb = ctx.createGain(); pfb.gain.value = 0.25;
        const pw = ctx.createGain(); pw.gain.value = 0;
        const plfo = ctx.createOscillator(); plfo.frequency.value = 0.4; phaLfo = plfo; const plfoG = ctx.createGain(); plfoG.gain.value = 420;
        plfo.connect(plfoG); aps.forEach((f) => plfoG.connect(f.frequency)); plfo.start();
        masterIn.connect(aps[0]); aps[0].connect(aps[1]); aps[1].connect(aps[2]); aps[2].connect(aps[3]); aps[3].connect(pfb); pfb.connect(aps[0]); aps[3].connect(pw); pw.connect(masterGain); phaWet = pw;
        // noise color FX: a looping noise source through a bandpass — one knob
        // rides level and sweep together, the classic riser / wash
        const nbuf = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate), nd = nbuf.getChannelData(0); for (let i = 0; i < nd.length; i++) nd[i] = Math.random() * 2 - 1;
        const nsrc = ctx.createBufferSource(); nsrc.buffer = nbuf; nsrc.loop = true;
        const nbp = ctx.createBiquadFilter(); nbp.type = "bandpass"; nbp.frequency.value = 900; nbp.Q.value = 0.7;
        const nw = ctx.createGain(); nw.gain.value = 0;
        nsrc.connect(nbp); nbp.connect(nw); nw.connect(masterGain); nsrc.start(); noiseWet = nw; noiseBp = nbp;
        // reverb send (generated impulse — no files, always free)
        const verb = ctx.createConvolver(); verb.buffer = impulse(2.2, 2.4);
        const vw = ctx.createGain(); vw.gain.value = 0; masterIn.connect(verb); verb.connect(vw); vw.connect(masterGain); verbWet = vw;
        // recording tap (the whole mix + mic land here)
        recDest = ctx.createMediaStreamDestination(); limiter.connect(recDest);
        // mic chain: mic -> compressor -> record tap (+ optional speaker monitor, off by default)
        micGain = ctx.createGain(); micGain.gain.value = 0.9;
        micMon = ctx.createGain(); micMon.gain.value = 0; micGain.connect(micMon); micMon.connect(ctx.destination);
        micAn = ctx.createAnalyser(); micAn.fftSize = 512; micGain.connect(micAn); micGain.connect(recDest);
      }
    }
    if (ctx && ctx.state === "suspended") ctx.resume().catch(() => {});
    return ctx;
  }
  // Phones pause web audio when the screen locks, a call comes in or another app plays sound. The decks keep
  // "playing" but go silent until something resumes it, so the very next touch, key or return to the page
  // brings the sound back (owner, 2026-10-27: "there is no sound on my dj booth").
  function wakeAudio() { if (ctx && ctx.state !== "running" && ctx.state !== "closed") ctx.resume().catch(() => {}); }
  ["pointerdown", "touchend", "keydown"].forEach((t) => addEventListener(t, wakeAudio, { capture: true, passive: true }));
  document.addEventListener("visibilitychange", () => { if (!document.hidden) wakeAudio(); });
  let muteHintAt = 0;
  function impulse(dur, decay) {
    const rate = ctx.sampleRate, len = rate * dur, buf = ctx.createBuffer(2, len, rate);
    for (let ch = 0; ch < 2; ch++) { const d = buf.getChannelData(ch); for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, decay); }
    return buf;
  }

  /* ---------- a deck: one audio element with its own EQ + gain ---------- */
  function Deck() {
    const d = { el: new Audio(), gain: null, eq: null, flt: null, stem: null, src: "", level: 1, cors: true, peaks: null, rate: 1, vinyl: false, cues: [null, null, null], loop: null, loopBeats: 0, ytId: "", shim: null, _audioEl: null, letter: "" };
    d.el.preload = "auto"; d.el.playsInline = true; d.el.crossOrigin = "anonymous";
    // The end-of-song hook lives on the DECK, not on one element: a deck's sound
    // element gets replaced over its life (video shim in, shim out, CORS fallback
    // swap), and a listener bolted to one element dies with it — that is why the
    // turntables ran past the end of their song (owner, 2026-10-27).
    d.onEnded = null;
    d._hookEnd = (el) => { if (el && typeof el.addEventListener === "function" && !el._endHooked) { el._endHooked = true; el.addEventListener("ended", () => { if (d.el === el && d.onEnded) d.onEnded(); }); } };
    d._hookEnd(d.el);
    d.set = (src) => new Promise((res) => {
      if (d.shim) d.clearYt();
      if (d.src === src) return res(true);
      d.src = src; d.cors = true; d.el.crossOrigin = "anonymous"; d.el.src = src; d.peaks = null;
      const ok = () => { clean(); wire(); res(true); };
      const bad = () => { clean(); if (d.cors) { d.cors = false;
          if (d.gain) { const old = d.el; old.pause(); d.el = new Audio(); d.el.preload = "auto"; d.el.playsInline = true; d._hookEnd(d.el); d.gain = null; d.eq = null; d.flt = null; d.stem = null; d.onswap && d.onswap(old); }
          d.el.removeAttribute("crossorigin"); d.el.src = src; d.el.addEventListener("loadedmetadata", () => res(true), { once: true }); d.el.addEventListener("error", () => res(false), { once: true }); } else res(false); };
      const clean = () => { d.el.removeEventListener("loadedmetadata", ok); d.el.removeEventListener("error", bad); };
      d.el.addEventListener("loadedmetadata", ok); d.el.addEventListener("error", bad);
    });
    function wire() { if (!OWNER() && ((typeof IOS !== "undefined" && IOS) || (typeof TOUCH !== "undefined" && TOUCH))) return; const c = actx(); if (!c || d.gain || !d.cors) return; try {
        const s = c.createMediaElementSource(d.el);
        const lo = c.createBiquadFilter(); lo.type = "lowshelf"; lo.frequency.value = 120;
        const mid = c.createBiquadFilter(); mid.type = "peaking"; mid.frequency.value = 1000; mid.Q.value = 0.9;
        const hi = c.createBiquadFilter(); hi.type = "highshelf"; hi.frequency.value = 8000;
        const flt = c.createBiquadFilter(); flt.type = "lowpass"; flt.frequency.value = 18000; flt.Q.value = 1.1;
        // stem stage: a highpass (bass cut) + a center-cancel path (vocal cut) crossfaded by gain —
        // both paths always exist, so toggling never glitches the audio graph
        const hp = c.createBiquadFilter(); hp.type = "highpass"; hp.frequency.value = 10;
        const nrm = c.createGain(); const oop = c.createGain(); oop.gain.value = 0;
        const spl = c.createChannelSplitter(2), mrg = c.createChannelMerger(2);
        const mkv = (v) => { const g = c.createGain(); g.gain.value = v; return g; };
        const gl = mkv(0.5), gr = mkv(-0.5), gl2 = mkv(0.5), gr2 = mkv(-0.5);
        s.connect(nrm); nrm.connect(hp);
        s.connect(spl); spl.connect(gl, 0); spl.connect(gr, 1); gl.connect(mrg, 0, 0); gr.connect(mrg, 0, 0); spl.connect(gl2, 0); spl.connect(gr2, 1); gl2.connect(mrg, 0, 1); gr2.connect(mrg, 0, 1);
        mrg.connect(oop); oop.connect(hp);
        d.gain = c.createGain(); hp.connect(lo); lo.connect(mid); mid.connect(hi); hi.connect(flt); flt.connect(d.gain); d.gain.connect(masterIn);
        d.eq = { lo, mid, hi }; d.flt = flt; d.stem = { hp, nrm, oop };
      } catch (_) { d.gain = null; d.eq = null; } d.apply(); }
    d.vol = (v) => { d.level = Math.max(0, Math.min(1, v)); d.apply(); };
    d.apply = () => { if (d.shim) { try { d.shim._p && d.shim._p.setVolume(Math.round(Math.max(0, Math.min(1, d.level * boostMk())) * 100)); } catch (_) {} return; } if (d.gain) { d.gain.gain.value = d.level; d.el.volume = 1; } else d.el.volume = d.level; };
    d.stop = () => { try { d.el.pause(); } catch (_) {} };
    // a YouTube deck: the video plays in the deck's own frame and a shim stands in
    // for the audio element, so play / pause / seek / position all work as usual and
    // the deck's volume (the X fader included) rides the player's own volume. What
    // cannot work: EQ, effects, stems and the waveform — YouTube keeps its audio
    // locked inside its player, no site can touch it.
    d.setYt = async (tok) => {
      if (d.ytId === tok && d.shim) return true;
      d.clearYt(); d.ytId = tok; d.src = "yt:" + tok; d.peaks = null;
      const vp = vparseTok(tok);
      const wrap = document.getElementById("ytw-" + d.letter); if (!wrap) return false;
      wrap.hidden = false;
      let mount = document.getElementById("yt-" + d.letter);
      if (!mount) { wrap.innerHTML = '<div id="yt-' + d.letter + '"></div>'; mount = document.getElementById("yt-" + d.letter); }
      if (!d._audioEl) d._audioEl = d.el;
      const onT = (title, dur) => { if (OWNER() && S[d.letter] && S[d.letter].yt === tok) { let dirty = false; if (title && (!S[d.letter].title || /^(YouTube|Vimeo|Dailymotion) video$/.test(S[d.letter].title))) { S[d.letter].title = title; dirty = true; } if (dur && !S[d.letter].dur) { S[d.letter].dur = Math.round(dur); dirty = true; } if (dirty) { paintOwner(); save(); } } };
      let sh = null;
      if (vp.p === "dm") { await dmApi(); if (!window.DM || !DM.player) { d.ytId = ""; return false; } sh = dmShim(d, vp.id, onT); }
      else if (vp.p === "vm") { await vmApi(); if (!window.Vimeo || !Vimeo.Player) { d.ytId = ""; return false; } sh = vmShim(d, vp.id, onT); }
      else { await ytApi(); if (!window.YT || !YT.Player) { d.ytId = ""; return false; } sh = ytShim(d, vp.id, onT); }
      d.shim = sh; d.el = sh; d._hookEnd(sh);
      const okP = await sh._mount(mount); if (d.shim !== sh) return false;
      try { sh._p && sh._p.setVolume(Math.round(d.level * 100)); if (S[d.letter] && S[d.letter].playing) sh.play(); } catch (_) {}
      return okP;
    };
    d.clearYt = () => { if (d.shim) { try { d.shim._p && d.shim._p.destroy(); } catch (_) {} d.shim = null; if (d._audioEl) { d.el = d._audioEl; d._hookEnd(d.el); } } if (d.ytId) d.ytId = ""; const wrap = document.getElementById("ytw-" + d.letter); if (wrap) { wrap.hidden = true; wrap.innerHTML = '<div id="yt-' + d.letter + '"></div>'; } };
    return d;
  }
  /* ---------- YouTube decks: the official iframe player, driven like a deck ---------- */
  let ytApiP = null;
  function ytApi() { if (window.YT && YT.Player) return Promise.resolve(); if (ytApiP) return ytApiP; ytApiP = new Promise((res) => { const tag = document.createElement("script"); tag.src = "https://www.youtube.com/iframe_api"; document.head.appendChild(tag); const prev = window.onYouTubeIframeAPIReady; window.onYouTubeIframeAPIReady = () => { try { prev && prev(); } catch (_) {} res(); }; setTimeout(res, 7000); }); return ytApiP; }
  const ytParse = (v) => { v = String(v || "").trim(); const m = v.match(/(?:youtube\.com\/(?:watch\?[^#]*v=|shorts\/|live\/|embed\/)|youtu\.be\/)([A-Za-z0-9_-]{11})/) || v.match(/^([A-Za-z0-9_-]{11})$/); return m ? m[1] : ""; };
  const vparseTok = (tok) => { tok = String(tok || ""); if (tok.indexOf("dm:") === 0) return { p: "dm", id: tok.slice(3) }; if (tok.indexOf("vm:") === 0) return { p: "vm", id: tok.slice(3) }; return { p: "yt", id: tok }; };
  const vidParse = (v) => {
    v = String(v || "").trim(); if (!v) return null;
    const y = ytParse(v); if (y) return { yt: y, src: "", title: "YouTube video", cover: "https://i.ytimg.com/vi/" + y + "/hqdefault.jpg", dur: 0 };
    let m = v.match(/vimeo\.com\/(?:video\/)?(\d{6,})/); if (m) return { yt: "vm:" + m[1], src: "", title: "Vimeo video", cover: "https://vumbnail.com/" + m[1] + ".jpg", dur: 0 };
    m = v.match(/archive\.org\/details\/([A-Za-z0-9_.-]+)/); if (m) return { iaId: m[1], title: "Archive video" };
    return null;
  };
  /* Honest seeking on all three video shims (2026-10-28): a seek marks
   * the shim seeking=true (with its target kept in _skTo) until the player
   * settles — a state change on YouTube, a seeked event or a timeupdate
   * landing near the target on Dailymotion/Vimeo — with a 4 second timer
   * as the backstop so the flag can never stick. follow() and the sync
   * code already refuse to seek while an element reports seeking; until
   * now the shims hardcoded it false, so those guards were dead on video
   * decks and seeks could pile onto a player still landing the last one. */
  function ytShim(d, vid, onTitle) {
    const sh = { _p: null, _dur: 0, _rate: 1, _h: {}, seeking: false, readyState: 0 };
    Object.defineProperties(sh, {
      currentTime: { get() { try { return sh._p ? sh._p.getCurrentTime() || 0 : 0; } catch (_) { return 0; } }, set(t) { try { if (sh._p) { sh.seeking = true; sh._skTo = Math.max(0, +t || 0); clearTimeout(sh._skTm); sh._skTm = setTimeout(() => { sh.seeking = false; }, 4000); sh._p.seekTo(sh._skTo, true); } } catch (_) {} } },
      duration: { get() { try { return (sh._p && sh._p.getDuration()) || sh._dur || 0; } catch (_) { return sh._dur || 0; } } },
      paused: { get() { try { return !sh._p || sh._p.getPlayerState() !== 1; } catch (_) { return true; } } },
      playbackRate: { get() { return sh._rate; }, set(r) { sh._rate = +r || 1; try { if (sh._p) { const av = sh._p.getAvailablePlaybackRates() || [1]; let best = av[0]; av.forEach((x) => { if (Math.abs(x - sh._rate) < Math.abs(best - sh._rate)) best = x; }); sh._p.setPlaybackRate(best); } } catch (_) {} } },
      volume: { get() { return 1; }, set(_) {} },
      preservesPitch: { get() { return true; }, set(_) {} },
      src: { get() { return "yt:" + vid; }, set(_) {} },
    });
    sh.play = () => {
      try {
        if (!sh._p) return Promise.resolve();
        sh._p.playVideo();
        // some browsers refuse to start a video with sound until it has been
        // interacted with: if it is not rolling shortly, start it muted (always
        // allowed) and bring the sound up the moment it is actually playing.
        // The mute is a loan, never a gift: sh._rescued remembers that WE muted
        // it, and the PLAYING state change (see _mount) always pays the sound
        // back — even when a slow phone takes longer than this watch window.
        // (Owner, 2026-10-28: the radio plays until someone presses stop; the
        // mute only ever changes by a person's press, never by the site.)
        let muted = false; const t0 = Date.now();
        clearInterval(sh._iv); // a person's pause/stop ends the watch (see sh.pause)
        const iv = sh._iv = setInterval(() => {
          try {
            const st = sh._p.getPlayerState();
            if (st === 1) { if (muted) { sh._rescued = false; sh._p.unMute(); sh._p.setVolume(Math.round((d.level || 1) * 100)); } clearInterval(iv); return; }
            if (Date.now() - t0 > 4000) { clearInterval(iv); return; }
            if (!muted && st !== 3 && Date.now() - t0 > 800) { muted = true; sh._rescued = true; sh._p.mute(); sh._p.playVideo(); }
          } catch (_) { clearInterval(iv); }
        }, 250);
      } catch (_) {}
      return Promise.resolve();
    };
    sh.pause = () => { clearInterval(sh._iv); try { sh._p && sh._p.pauseVideo(); } catch (_) {} };
    sh.addEventListener = (ev, fn) => { (sh._h[ev] = sh._h[ev] || []).push(fn); };
    sh.removeEventListener = (ev, fn) => { if (sh._h[ev]) sh._h[ev] = sh._h[ev].filter((f) => f !== fn); };
    sh._fire = (ev) => (sh._h[ev] || []).slice().forEach((f) => { try { f(); } catch (_) {} });
    sh._mount = (mountEl) => new Promise((res) => {
      let done = false; const fin = (v) => { if (!done) { done = true; res(v); } };
      try {
        sh._p = new YT.Player(mountEl, { videoId: vid, width: "100%", height: "100%", playerVars: { playsinline: 1, rel: 0, controls: 1 }, events: {
          onReady: (e) => { sh.readyState = 4; try { sh._dur = e.target.getDuration() || 0; const vd = e.target.getVideoData && e.target.getVideoData(); if (vd && onTitle) onTitle(vd.title || "", sh._dur); } catch (_) {} fin(true); },
          onStateChange: (e) => { sh.seeking = false; if (e.data === 0) sh._fire("ended"); if (e.data === 1) { try { sh._dur = sh._p.getDuration() || sh._dur; } catch (_) {} if (sh._rescued) { sh._rescued = false; try { sh._p.unMute(); sh._p.setVolume(Math.round((d.level || 1) * 100)); } catch (_) {} } } },
          onError: (e) => { const code = e && e.data; sh._errCode = code; if (code === 100 || code === 101 || code === 150) { sh._locked = true; ageMarkLocked(vid); } fin(false); },
        } });
      } catch (_) { fin(false); }
      setTimeout(() => fin(!!sh._p), 6000);
    });
    return sh;
  }
  let dmApiP = null;
  function dmApi() { if (window.DM && DM.player) return Promise.resolve(); if (dmApiP) return dmApiP; dmApiP = new Promise((res) => { const tag = document.createElement("script"); tag.src = "https://api.dmcdn.net/all.js"; tag.onload = () => res(); tag.onerror = () => res(); document.head.appendChild(tag); setTimeout(res, 7000); }); return dmApiP; }
  let vmApiP = null;
  function vmApi() { if (window.Vimeo && Vimeo.Player) return Promise.resolve(); if (vmApiP) return vmApiP; vmApiP = new Promise((res) => { const tag = document.createElement("script"); tag.src = "https://player.vimeo.com/api/player.js"; tag.onload = () => res(); tag.onerror = () => res(); document.head.appendChild(tag); setTimeout(res, 7000); }); return vmApiP; }
  /* Dailymotion + Vimeo decks: same shim surface as ytShim — the players keep
   * their audio locked in just like YouTube, and position comes from their
   * timeupdate events because neither offers a synchronous clock. */
  function dmShim(d, vid, onTitle) {
    const sh = { _p: null, _dur: 0, _rate: 1, _h: {}, _cur: 0, _state: -1, seeking: false, readyState: 0 };
    const wrap = { _dm: null,
      setVolume(v100) { try { wrap._dm && wrap._dm.setVolume(Math.max(0, Math.min(1, v100 / 100))); } catch (_) {} },
      destroy() { try { const el = wrap._dm && (wrap._dm.iframe || wrap._dm.element); if (el && el.parentNode) el.parentNode.removeChild(el); } catch (_) {} wrap._dm = null; } };
    sh._p = wrap;
    Object.defineProperties(sh, {
      currentTime: { get() { return sh._cur || 0; }, set(t) { try { if (wrap._dm) { sh.seeking = true; sh._skTo = Math.max(0, +t || 0); clearTimeout(sh._skTm); sh._skTm = setTimeout(() => { sh.seeking = false; }, 4000); wrap._dm.seek(sh._skTo); } } catch (_) {} } },
      duration: { get() { return sh._dur || 0; } },
      paused: { get() { return sh._state !== 1; } },
      playbackRate: { get() { return sh._rate; }, set(r) { sh._rate = +r || 1; try { if (wrap._dm && wrap._dm.setPlaybackRate) wrap._dm.setPlaybackRate(sh._rate); } catch (_) {} } },
      volume: { get() { return 1; }, set(_) {} },
      preservesPitch: { get() { return true; }, set(_) {} },
      src: { get() { return "yt:dm:" + vid; }, set(_) {} },
    });
    sh.play = () => { try { wrap._dm && wrap._dm.play(); } catch (_) {} return Promise.resolve(); };
    sh.pause = () => { try { wrap._dm && wrap._dm.pause(); } catch (_) {} };
    sh.addEventListener = (ev, fn) => { (sh._h[ev] = sh._h[ev] || []).push(fn); };
    sh.removeEventListener = (ev, fn) => { if (sh._h[ev]) sh._h[ev] = sh._h[ev].filter((f) => f !== fn); };
    sh._fire = (ev) => (sh._h[ev] || []).slice().forEach((f) => { try { f(); } catch (_) {} });
    sh._mount = (mountEl) => new Promise((res) => {
      let done = false; const fin = (v) => { if (!done) { done = true; res(v); } };
      try {
        const p = DM.player(mountEl, { video: vid, width: "100%", height: "100%", params: { autoplay: false, controls: true, "endscreen-enable": false } });
        wrap._dm = p;
        const on = (ev, fn) => { try { p.addEventListener(ev, fn); } catch (_) {} };
        on("apiready", () => { sh.readyState = 4; fin(true); });
        on("loadedmetadata", (e) => { try { if (e && e.duration) sh._dur = e.duration; } catch (_) {} });
        on("durationchange", (e) => { try { if (e && e.duration) sh._dur = e.duration; } catch (_) {} });
        on("timeupdate", (e) => { try { if (e && typeof e.time === "number") sh._cur = e.time; if (e && typeof e.time === "number" && e.duration) sh._dur = e.duration; if (sh.seeking && Math.abs(sh._cur - (sh._skTo || 0)) < 2) sh.seeking = false; } catch (_) {} });
        on("seeked", () => { sh.seeking = false; });
        on("play", () => { sh._state = 1; });
        on("pause", () => { if (sh._state !== 0) sh._state = 2; });
        on("ended", () => { sh._state = 0; sh._fire("ended"); });
        on("error", () => fin(false));
        fetch("https://api.dailymotion.com/video/" + encodeURIComponent(vid) + "?fields=title,duration").then((r) => r.json()).then((j) => { if (j && onTitle) onTitle(j.title || "", j.duration || sh._dur); }).catch(() => {});
      } catch (_) { fin(false); }
      setTimeout(() => fin(!!wrap._dm), 6000);
    });
    return sh;
  }
  function vmShim(d, vid, onTitle) {
    const sh = { _p: null, _dur: 0, _rate: 1, _h: {}, _cur: 0, _state: -1, seeking: false, readyState: 0 };
    const wrap = { _vm: null,
      setVolume(v100) { try { wrap._vm && wrap._vm.setVolume(Math.max(0, Math.min(1, v100 / 100))); } catch (_) {} },
      destroy() { try { wrap._vm && wrap._vm.destroy(); } catch (_) {} wrap._vm = null; } };
    sh._p = wrap;
    Object.defineProperties(sh, {
      currentTime: { get() { return sh._cur || 0; }, set(t) { try { if (wrap._vm) { sh.seeking = true; sh._skTo = Math.max(0, +t || 0); clearTimeout(sh._skTm); sh._skTm = setTimeout(() => { sh.seeking = false; }, 4000); wrap._vm.setCurrentTime(sh._skTo).catch(() => {}); } } catch (_) {} } },
      duration: { get() { return sh._dur || 0; } },
      paused: { get() { return sh._state !== 1; } },
      playbackRate: { get() { return sh._rate; }, set(r) { sh._rate = +r || 1; try { wrap._vm && wrap._vm.setPlaybackRate(sh._rate).catch(() => {}); } catch (_) {} } },
      volume: { get() { return 1; }, set(_) {} },
      preservesPitch: { get() { return true; }, set(_) {} },
      src: { get() { return "yt:vm:" + vid; }, set(_) {} },
    });
    sh.play = () => { try { wrap._vm && wrap._vm.play().catch(() => {}); } catch (_) {} return Promise.resolve(); };
    sh.pause = () => { try { wrap._vm && wrap._vm.pause().catch(() => {}); } catch (_) {} };
    sh.addEventListener = (ev, fn) => { (sh._h[ev] = sh._h[ev] || []).push(fn); };
    sh.removeEventListener = (ev, fn) => { if (sh._h[ev]) sh._h[ev] = sh._h[ev].filter((f) => f !== fn); };
    sh._fire = (ev) => (sh._h[ev] || []).slice().forEach((f) => { try { f(); } catch (_) {} });
    sh._mount = (mountEl) => new Promise((res) => {
      let done = false; const fin = (v) => { if (!done) { done = true; res(v); } };
      try {
        const p = new Vimeo.Player(mountEl, { id: vid, width: "100%", height: "100%", controls: true, title: false, byline: false, portrait: false });
        wrap._vm = p;
        p.ready().then(() => { sh.readyState = 4; fin(true); p.getDuration().then((s) => { if (s) sh._dur = s; if (onTitle) p.getVideoTitle().then((t) => onTitle(t || "", sh._dur)).catch(() => {}); }).catch(() => {}); }).catch(() => fin(false));
        p.on("timeupdate", (e) => { try { if (e && typeof e.seconds === "number") sh._cur = e.seconds; if (sh.seeking && Math.abs(sh._cur - (sh._skTo || 0)) < 2) sh.seeking = false; } catch (_) {} });
        p.on("seeked", () => { sh.seeking = false; });
        p.on("play", () => { sh._state = 1; });
        p.on("pause", () => { if (sh._state !== 0) sh._state = 2; });
        p.on("ended", () => { sh._state = 0; sh._fire("ended"); });
        p.on("error", () => fin(false));
      } catch (_) { fin(false); }
      setTimeout(() => fin(!!wrap._vm), 6000);
    });
    return sh;
  }

  let XFCURVE = "smooth"; // crossfader curve, synced from S.xfCurve by paintXfPads
  // YouTube decks never enter the Web Audio graph, so the master BOOST knob used
  // to do nothing for them (owner: "boost the sound its too low", 2026-10-26 —
  // his boost was already at max 2 while a centered fader left a video deck near
  // 64%). Video volume now gets a makeup factor from the same boost setting.
  const boostMk = () => Math.min(1.5, Math.max(1, +(S.fx && S.fx.boost) || 1));
  const xfGain = (xf, side) => { const t = side === "A" ? xf : 1 - xf, c = Math.cos(t * Math.PI / 2); if (XFCURVE === "sharp") return Math.sqrt(Math.max(0, c)); if (XFCURVE === "cut") return t < 0.5 ? 1 : (t > 0.5 ? 0 : 0.7071); return c; }; // equal-power smooth by default; sharp = louder middle for scratch work; cut = instant switch at center
  // THE X LAW (owner, voice call 2026-10-29): the X (S.panX, 0..1) rides
  // BETWEEN THE PAIRS. Hard left (0): the A/B pair at 100%, C/D silent.
  // Hard right (1): C/D at 100%, A/B silent. Center (0.5, the home): both
  // pairs at 100%. Between, the far pair fades on a smooth cosine while
  // the near pair holds full — the pair factor multiplies the deck gains
  // alongside (never instead of) the deck volume knob and the pair faders
  // (S.xf / S.xf2), which keep their within-pair jobs, blends included.
  const pairXGain = (px, cd) => { const p = Math.min(1, Math.max(0, px == null ? 0.5 : px)); return cd ? (p >= 0.5 ? 1 : Math.cos((0.5 - p) * Math.PI)) : (p <= 0.5 ? 1 : Math.cos((p - 0.5) * Math.PI)); };

  /* ---------- shared station state (doc radio/dj) ---------- */
  const blank = () => ({ src: "", yt: "", title: "", cover: "", start: 0, pos: 0, playing: false, vol: 0.9, rate: 1, dur: 0 });
  const defFx = () => ({ mf: 100, echo: 0, fb: 0.34, verb: 0, fla: 0, pha: 0, noise: 0, ediv: 0.75, gate: 0, crush: 0, sync: true, boost: 1 });
  let S = { live: false, xf: 0.5, xf2: 0.5, panX: 0.5, xfCurve: "smooth", panY: 0, duck: false, quant: true, A: blank(), B: blank(), C: blank(), D: blank(), voice: null, updatedAt: 0, liveSince: 0, ticker: "", log: [], show: null, pads: [], autodj: true, fxHornAt: 0, hornOn: false, fx: defFx(), vmix: { mode: "auto", a: "", b: "", t: 0, tr: "fade", trMs: 650, at: 0 }, vfx: { kind: "", at: 0 }, battle: { on: false, id: "", p1: { uid: "", name: "" }, p2: { uid: "", name: "" }, round: 1, rounds: 3, turnSec: 90, turn: "", turnEndsAt: 0, phase: "off", winner: "", at: 0, lastWrite: 0 } };
  const posOf = (k) => { const s = S[k]; return s.playing ? Math.max(0, (Date.now() - s.start) / 1000) : (s.pos || 0); };
  let saveT = null;
  let guestPostAt = 0;
  function guestRelay() {
    let on = false; try { on = sessionStorage.getItem("mw-guestlive") === "1"; } catch (_) {}
    if (!on) return;
    const t = Date.now(); if (t - guestPostAt < 2500) return; guestPostAt = t;
    const ses = (window.MW && MW.session && MW.session()) || null; const tok = ses && ses.access_token; if (!tok) return;
    fetch("/api/station", { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer " + tok }, body: JSON.stringify({ kind: "guestdj", A: S.A, B: S.B, C: S.C, D: S.D, xf: S.xf, xf2: S.xf2, panX: S.panX ?? 0.5, panY: S.panY, fx: S.fx, hornOn: S.hornOn === true, voice: S.voice }) }).then((r) => r.json()).then((j) => { if (j && j.ok === false) { try { sessionStorage.removeItem("mw-guestlive"); } catch (_) {} say("Your live slot has ended — thanks for spinning 🎧"); } }).catch(() => {});
  }
  /* ---------- multi-screen lead claim (mwLeadLock client, 2026-10-28) ----------
   * The radio/dj doc can carry leadTab/leadAt: whichever booth screen
   * holds a fresh claim is the one whose deck and transport writes the
   * server stores; every other booth is a mirror of it — all screens
   * control the program together instead of fighting over it. Claims
   * ride ordinary saves as an _lead field {tab, base, take?}; base is
   * the updatedAt this tab last adopted, so a takeover must prove it has
   * seen the current state (a stale tab guessing gets refused). While
   * nobody has ever claimed, saves pass exactly as they always have. */
  let lastBaseAt = 0, leadTakeAt = 0, padSentAt = 0;
  const leadFresh = () => !!(S && S.leadTab && Date.now() - (S.leadAt || 0) < 20000);
  const serverMirror = () => leadFresh() && S.leadTab !== tabId;
  /* mwLeadLock CLIENT PHASE (2026-10-29): station automation answers to
   * the server claim, not to this windows local sound lease. While a claim
   * is fresh only the claim holder drives - auto-advance, the stall
   * watchdog, preload, handover, the schedule and brain capture - so two
   * open booths can never duel (the 21:14 skipping: two tabs advancing
   * the same set). With no claim on record the local lease decides,
   * exactly as before, and the drivers next save records the claim, so a
   * single booth never notices the lock at all. */
  const leadDrive = () => { if (!OWNER()) return false; if (SANDBOX) return true; if (leadFresh()) return S.leadTab === tabId; return boothLead; };
  function save(now) { if (!OWNER()) return; /* mwFlapFix: never serialize a deck this tab already knows is past its end; end or park it first so a save can never re-assert a corpse over a keeper rescue */ DECKS.forEach((k2) => { const sk = S[k2]; if (sk && sk.playing && +sk.dur > 0 && posOf(k2) > +sk.dur + 15) { if (!listening) deckEnded(k2); if (S[k2].playing) S[k2].playing = false; } }); if (SANDBOX) { S.updatedAt = Date.now(); S.boothAt = Date.now(); try { sessionStorage.setItem("mw-playdj", JSON.stringify(S)); } catch (_) {} guestRelay(); return; } clearTimeout(saveT); const run = () => { S.updatedAt = Date.now(); S.boothAt = Date.now(); S.by = tabId; /* GO LIVE STUDIO liveness is proof-based now (fix-studio5): saves never re-stamp vstream.at — only the publisher supervisor does, after verifying the capture chain end to end (see vsPubProof) */ const payload = JSON.parse(JSON.stringify(S)); const taking = leadTakeAt && Date.now() - leadTakeAt < 15000; if (serverMirror() && !taking) { if (S.padHit && (S.padHit.at || 0) > padSentAt) { padSentAt = S.padHit.at; lastBaseAt = S.updatedAt; DB()?.doc("radio/dj").set(payload).catch(() => {}); } return; } payload._lead = { tab: tabId, base: lastBaseAt || 0 }; if (taking) { payload._lead.take = true; leadTakeAt = 0; } lastBaseAt = S.updatedAt; DB()?.doc("radio/dj").set(payload).catch((e) => say(e.message || e.code)); }; if (now) run(); else saveT = setTimeout(run, 250); }
  function logPlay(title) { if (!title) return; S.log = [{ t: title, at: Date.now(), live: !!S.live }].concat((S.log || []).filter((x) => x.t !== title)).slice(0, 30); }

  /* ---------- styles ---------- */
  const css = document.createElement("style");
  css.textContent = `
.dj{margin-top:40px;border:1px solid var(--gold-lo);border-radius:20px;padding:26px;background:radial-gradient(ellipse at 50% 0,#2a2112 0,#100d08 60%);box-shadow:0 20px 50px rgba(0,0,0,.5);min-width:0}
#v-radio .wrap{max-width:1500px}
#dj-booth-root{width:100%;min-width:0}
.dj-top{display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap;margin-bottom:14px}
.dj-top h3{margin:0;font-size:32.5px}
.dj-live{display:flex;align-items:center;gap:8px;font-weight:700}
.dj-live input{width:20px;height:20px;accent-color:#e5484d}
/* REPORTS button badge (owner fix, 2026-10-30): the count pill on
 * the top-cluster REPORTS button; hidden whenever the count is 0 */
#dj-reports-btn .rp-badge{display:inline-block;min-width:20px;padding:1px 6px;margin-left:2px;border-radius:999px;background:#e5484d;color:#fff;font:800 15px var(--body);text-align:center}
#dj-reports-btn .rp-badge[hidden]{display:none}
.onair-lamp{display:inline-flex;align-items:center;gap:8px;font:800 13px var(--body);letter-spacing:.14em;padding:7px 12px;border-radius:999px;border:1px solid var(--line);color:var(--muted)}
.onair-lamp.on{color:#fff;background:#a3161c;border-color:#e5484d;box-shadow:0 0 18px rgba(229,72,77,.55)}
.onair-lamp .dot{width:9px;height:9px;border-radius:50%;background:#666}
.onair-lamp.on .dot{background:#ff5b60;animation:djpulse 1.2s infinite}
@keyframes djpulse{50%{opacity:.35}}
.dj-clock{font:700 16.5px ui-monospace,monospace;color:var(--gold-hi)}
.dj-decks{display:grid;grid-template-columns:minmax(0,1fr) 300px minmax(0,1fr);gap:16px;align-items:stretch}
/* DECK LOCK: every deck and mixer owns a fixed slot in the bank — content loading,
   sections folding or lists growing can never re-place them */
.dj-decks>.deck[data-deck="A"]{grid-column:1;grid-row:1}
.dj-decks>.deck[data-deck="B"]{grid-column:2;grid-row:1}
.dj-decks>.mixer.m1{grid-column:3;grid-row:1}
.dj-decks>.mixer.m2{grid-column:1;grid-row:2}
.dj-decks>.deck[data-deck="C"]{grid-column:2;grid-row:2}
.dj-decks>.deck[data-deck="D"]{grid-column:3;grid-row:2}
html{scrollbar-gutter:stable}

@media (min-width:1650px){#v-radio .wrap{max-width:1720px}}
.deck{background:#0c0a07;border:1px solid var(--line);border-radius:16px;padding:14px;display:grid;gap:10px;justify-items:center;text-align:center;min-width:0;align-content:start}
.deck h4{margin:0;font:800 13px var(--body);letter-spacing:.18em;color:var(--gold-hi)}
.platter{width:min(240px,100%);aspect-ratio:1;border-radius:50%;background:repeating-radial-gradient(circle,#111 0 2px,#1b1b1b 2px 4px);border:3px solid #2a2418;position:relative;box-shadow:inset 0 0 20px #000,0 8px 20px rgba(0,0,0,.6);cursor:grab;touch-action:none}
.platter::after{content:"";position:absolute;inset:34%;border-radius:50%;background:var(--gold) center/cover;box-shadow:0 0 0 3px #0c0a07}
.platter.has-cover::after{background-image:var(--cv)}
.platter.spin{animation:djspin 1.8s linear infinite}
@keyframes djspin{to{transform:rotate(360deg)}}
.deck canvas.wave{width:100%;height:84px;background:#070605;border:1px solid #241d10;border-radius:8px}
.deck .ttl{font-weight:700;font-size:17px;max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.deck .tm{font:600 12px ui-monospace,monospace;color:var(--muted)}
.deck .row{display:flex;gap:6px;justify-content:center;flex-wrap:wrap;width:100%}
.deck label.lab{width:100%;font-size:11px;color:var(--muted);text-align:left;display:grid;gap:2px}
.deck input[type=range],.mixer input[type=range],.dj-panel input[type=range]{width:100%;accent-color:var(--gold)}
.eqrow{display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px;width:100%}
.eqrow label{font-size:12.5px;color:var(--muted);letter-spacing:.08em;display:grid;gap:2px}
.cuebtn.on{background:var(--gold);color:#191104;border-color:var(--gold)}
.gatebtn.on,.pktab.on{background:var(--gold);color:#191104;border-color:var(--gold)}
.loopbtn.on{background:#a3161c;color:#fff;border-color:#e5484d}
.mixer{background:#0c0a07;border:1px solid var(--line);border-radius:16px;padding:14px 10px;display:grid;gap:12px;align-content:start;justify-items:center;text-align:center;min-width:0}
.mixer>*{max-width:100%}
.mixer label{white-space:normal}
.mixer small{overflow-wrap:break-word}
.mixer small{color:var(--muted);font-size:11px;letter-spacing:.12em}
.talk{width:120px;height:120px;border-radius:50%;border:3px solid #e5484d;background:#2a0f10;color:#fff;font:800 16.5px var(--body);cursor:pointer;touch-action:none;user-select:none;-webkit-user-select:none}
.talk.on{background:#e5484d;box-shadow:0 0 0 8px rgba(229,72,77,.25),0 0 30px #e5484d}
.micmeter{width:100%;height:8px;background:#1c1710;border-radius:99px;overflow:hidden}
.micmeter i{display:block;height:100%;width:0;background:linear-gradient(90deg,#45bd62,#f7b928,#e5484d);transition:width .08s}
.dj-grid2{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(430px,100%),1fr));gap:14px;margin-top:14px;grid-auto-flow:dense;align-items:start}
.dj-panel{background:#0c0a07;border:1px solid var(--line);border-radius:16px;padding:14px;display:grid;gap:10px;align-content:start;min-width:0}
#dj-door .door-row{display:flex;justify-content:space-between;align-items:center;gap:8px;padding:7px 0;border-bottom:1px solid #2a2418;font-size:17.5px;flex-wrap:wrap}
#dj-door .door-row.new{animation:doornew 1.6s ease-in-out 2}
@keyframes doornew{50%{background:rgba(240,207,120,.16)}}
#dj-door .door-row small{color:var(--muted);white-space:nowrap}
#dj-door .door-acts{display:flex;gap:6px;flex-wrap:wrap}
.dj-panel h4{margin:0;font:800 12px var(--body);letter-spacing:.16em;color:var(--gold-hi)}
.pads{display:grid;grid-template-columns:repeat(4,1fr);gap:8px}
.pad{padding:20px 8px;border-radius:12px;border:1px solid var(--gold-lo);background:#171208;color:var(--text);font:700 15px var(--body);cursor:pointer}
.pad:active{transform:scale(.96)}
.pad.custom{border-style:dashed}
.pad small{display:block;color:var(--muted);font-weight:600;font-size:12.5px;margin-top:3px}
.dj-list{display:grid;gap:6px;max-height:240px;overflow:auto;min-width:0}
.dj-item{display:flex;flex-wrap:wrap;gap:6px;align-items:center;padding:8px;border:1px solid var(--line);border-radius:10px;font-size:14px;min-width:0}
.dj-item>span{flex:1 1 130px;min-width:0}
.dj-item span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dj-search{display:flex;gap:8px}.dj-search input,.dj-panel input[type=text],.dj-panel textarea{flex:1;min-width:0;background:var(--ink);border:1px solid var(--line);border-radius:10px;padding:10px;color:var(--text);font:16px var(--body)}
.req{display:grid;gap:4px;padding:9px;border:1px solid var(--line);border-radius:10px;font-size:14px}
.req small{color:var(--muted)}
.loglist{display:grid;gap:4px;font-size:13px;max-height:180px;overflow:auto}
.loglist div{display:flex;justify-content:space-between;gap:10px;border-bottom:1px dashed #241d10;padding:3px 0}
.loglist span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.loglist time{color:var(--muted);font:600 11px ui-monospace,monospace;white-space:nowrap}
.dj-banner{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;margin-top:20px;padding:14px 16px;border-radius:14px;border:1px solid #e5484d;background:linear-gradient(90deg,#2a0f10,#15130f)}
.dj-banner b{color:#ff8b8f}
.station{margin-top:12px;border:1px solid var(--gold-lo);border-radius:16px;padding:16px;background:#0d0b08;display:grid;gap:12px}
.station h3{margin:0;font-size:20px}
.ticker{overflow:hidden;white-space:nowrap;border:1px solid #e5484d;border-radius:10px;padding:8px 0;background:#1c0b0c;color:#ffb3b6;font-weight:700}
.ticker span{display:inline-block;padding-left:100%;animation:djtick 18s linear infinite}
@keyframes djtick{to{transform:translateX(-100%)}}
.rec-on{color:#ff8b8f;font-weight:800}
#fb-left,#fb-right{transition:transform .35s ease,opacity .35s ease}
body.dj-past #fb-left,body.dj-on #fb-left{transform:translateX(-110%);opacity:0;pointer-events:none}
body.dj-past #fb-right,body.dj-on #fb-right{transform:translateX(110%);opacity:0;pointer-events:none}
body.dj-past #ai-fab,body.dj-past #mx-heads,body.dj-on #ai-fab,body.dj-on #mx-heads,body.dj-past #mw-fab,body.dj-past #mw-show,body.dj-past #mw-show-pill,body.dj-past #vz-pill,body.dj-on #mw-fab,body.dj-on #mw-show,body.dj-on #mw-show-pill,body.dj-on #vz-pill,body.dj-past #mx-fab,body.dj-on #mx-fab{opacity:0!important;pointer-events:none!important;transform:scale(.5)}
#fb-tabs,.player-bar{transition:transform .3s ease,opacity .3s ease}
body.dj-on .player-bar,body.dj-past .player-bar{opacity:0!important;pointer-events:none!important;transform:translateY(130%)}
#ai-fab,#mx-heads,#mx-fab{transition:opacity .3s ease,transform .3s ease}
/* EVERYTHING OFF while the tables are on (Malik, 2026-10-26): the site header, the
   Book top bar, the announcement bar and the phone tab bar join the cut-off set */
header.bar,#fb-top,.announce,.apptab{transition:transform .3s ease,opacity .3s ease}
body.dj-on #fb-top,body.dj-past #fb-top{opacity:0!important;pointer-events:none!important;transform:translateY(-130%)}
body.dj-on .announce,body.dj-past .announce{opacity:0!important;pointer-events:none!important;transform:translateY(-130%)}
body.dj-on .apptab,body.dj-past .apptab{opacity:0!important;pointer-events:none!important;transform:translateY(130%)}
/* NAV + TABS SLIDE AWAY TOO (owner, 2026-10-27: "make sure the site map and
   buttons slide out of their way"): the header and the Book icon tabs were
   pinned at the booth by an earlier call — this reverses that at the tables.
   They slide up out of the way while the booth is on screen and slide back
   the moment the visitor scrolls away from it. */
body.dj-on header.bar,body.dj-past header.bar{opacity:0!important;pointer-events:none!important;transform:translateY(-130%)}
body.dj-on #fb-tabs,body.dj-past #fb-tabs{opacity:0!important;pointer-events:none!important;transform:translateY(-320%)}
/* the DJ Station view is tables territory too: same chrome off; the header stays as the way out */
body[data-view="dj"] #fb-left{transform:translateX(-110%);opacity:0;pointer-events:none}
body[data-view="dj"] #fb-right{transform:translateX(110%);opacity:0;pointer-events:none}
body[data-view="dj"] #ai-fab,body[data-view="dj"] #mx-heads,body[data-view="dj"] #mw-fab,body[data-view="dj"] #mw-show,body[data-view="dj"] #mw-show-pill,body[data-view="dj"] #vz-pill,body[data-view="dj"] #mx-fab{opacity:0!important;pointer-events:none!important;transform:scale(.5)}
body[data-view="dj"] #fb-top,body[data-view="dj"] .announce{opacity:0!important;pointer-events:none!important;transform:translateY(-130%)}
body[data-view="dj"] .player-bar,body[data-view="dj"] .apptab{opacity:0!important;pointer-events:none!important;transform:translateY(130%)}
.swapbar{display:none}
@media (max-width:760px){
.dj-decks{display:grid;grid-template-columns:1fr 1fr;gap:8px}
/* DECK LOCK on the phone too: A|B on row 1, C|D on row 3 — fixed slots, no swapper,
   so a deck can never trade places or vanish behind a switch */
.dj-decks>.deck[data-deck="A"]{grid-column:1;grid-row:1}
.dj-decks>.deck[data-deck="B"]{grid-column:2;grid-row:1}
.dj-decks>.mixer.m1{grid-column:1/-1;grid-row:2}
.dj-decks>.swapbar{display:none!important}
.dj-decks>.deck[data-deck="C"]{grid-column:1;grid-row:3}
.dj-decks>.deck[data-deck="D"]{grid-column:2;grid-row:3}
.dj-decks>.mixer.m2{grid-column:1/-1;grid-row:4}
.dj-decks>.deck{padding:8px;gap:5px}
#dj-owner .dj-decks>.deck .platter{width:84px}
.dj-decks>.deck .wave{height:44px}
.dj-decks>.deck .btn{padding:6px 8px;font-size:12px}
.dj-decks>.deck .ttl{font-size:12px}
body.dj-on #dj-booth-root{padding-bottom:70px}
.dj-grid2{grid-template-columns:1fr}.pads{grid-template-columns:repeat(2,1fr)}
#dj-owner .btn{min-height:42px}
#dj-owner [data-play]{min-height:50px;font-size:20px}
#dj-owner .pad{min-height:52px}
#dj-owner input[type=range]{min-height:32px}
#dj-owner .platter{width:118px}
.deck{padding:10px;gap:6px;background:linear-gradient(180deg,#181310,#0c0a07)}
.deck h4{font-size:13px;letter-spacing:.16em;margin:0}
.deck .wave{height:52px}
.mixer{padding:10px 8px;gap:7px}
.dj-panel{padding:10px}
#dj-online{color:#45bd62;font-weight:800}
#dj-browser .dj-item{min-height:48px}
#dj-browser .dj-item .btn{min-height:42px;min-width:42px}
}
html.popdj header.bar,html.popdj #player-bar,html.popdj footer,html.popdj #fb-left,html.popdj #fb-right,html.popdj #ai-fab,html.popdj #mx-heads,html.popdj #fb-top,html.popdj #fb-tabs,html.popdj #fb-notes,html.popdj .announce,html.popdj .apptab,html.popdj #mx-fab,html.popdj #mw-fab,html.popdj #mw-show,html.popdj #mw-show-pill,html.popdj #vz-pill{display:none!important}
html.popdj main{margin:0!important;padding:10px!important}
html.popdj #v-radio .wrap{max-width:none!important;width:100%!important}
html.popdj #v-radio .wrap>*:not(#dj-booth-root){display:none!important}
html.popdj.popdj-guest #v-radio .wrap>#dj-root{display:block!important}
html.popdj.popdj-guest #v-radio .wrap>#dj-booth-root~.radio-top{display:grid!important}
html.playdj header.bar,html.playdj #player-bar,html.playdj footer,html.playdj #fb-left,html.playdj #fb-right,html.playdj #ai-fab,html.playdj #mx-heads,html.playdj #fb-top,html.playdj #fb-tabs,html.playdj #fb-notes,html.playdj .announce,html.playdj .apptab,html.playdj #mx-fab,html.playdj #mw-fab,html.playdj #mw-show,html.playdj #mw-show-pill,html.playdj #vz-pill{display:none!important}
html.playdj main{margin:0!important;padding:10px!important}
html.playdj #v-radio .wrap{max-width:none!important;width:100%!important}
html.playdj #v-radio .wrap>*:not(#dj-booth-root){display:none!important}
.pad{transition:filter .15s ease,transform .15s ease}
.pad.hit{filter:brightness(1.9);transform:scale(.93)}
#dj-ptabs{display:none}
@media (max-width:900px){
  html.popdj #dj-ptabs{display:flex;gap:6px;flex-wrap:wrap;margin:0 0 10px}
  html.popdj #dj-ptabs .btn.on{background:var(--gold);color:#15130f}
  html.popdj #dj-owner[data-ptab="decks"] .pg-studio,html.popdj #dj-owner[data-ptab="decks"] .pg-music{display:none}
  html.popdj #dj-owner[data-ptab="studio"] .pg-music{display:none}
  html.popdj #dj-owner[data-ptab="music"] .pg-studio{display:none}
  html.popdj #dj-owner .btn{min-height:44px}
  html.popdj #dj-owner .pad{min-height:58px}
  html.popdj #dj-owner [data-play]{min-height:52px;font-size:20px}
}
html.popdj #dj-booth-root{width:100%!important;margin:0!important;transform:none!important}
.popdj-hint{display:none}
.beatbox{display:flex;gap:8px;align-items:center;justify-content:center;flex-wrap:wrap;width:100%}
.bpmv{font:800 14px ui-monospace,monospace;color:var(--gold-hi)}
.keyv{font:800 11px var(--body);padding:3px 8px;border-radius:999px;border:1px solid var(--line);color:var(--muted)}
.keyv.compat{color:#0d2b12;background:#45bd62;border-color:#45bd62}
.bdots{display:inline-flex;gap:4px}
.bdots i{width:9px;height:9px;border-radius:50%;background:#2c2413;display:inline-block}
.bdots i.on{background:#f7b928;box-shadow:0 0 8px #f7b928}
.cutbtn.on{background:#7a4fd0;color:#fff;border-color:#7a4fd0}
.pairwave{width:100%;height:72px;background:#070605;border:1px solid #241d10;border-radius:8px}
.browtab.on{background:var(--gold);color:#191104;border-color:var(--gold)}
.online-chip{display:inline-flex;align-items:center;gap:5px;font:700 12px var(--body);color:var(--muted);border:1px solid var(--line);border-radius:999px;padding:5px 10px;white-space:nowrap;margin-left:10px;flex:none}
.online-chip b{color:#45bd62}
@media(max-width:640px){.online-chip{margin-left:6px;padding:3px 8px;font-size:11px}}
#dj-browser .dj-search{position:sticky;top:0;z-index:3;background:#0d0b08;padding:6px 0}
.ptab-on{align-self:center;font:800 15.5px var(--body);color:#45bd62;white-space:nowrap;padding:0 4px}
.xfpad{position:relative;width:150px;height:150px;border-radius:16px;border:2px solid var(--gold-lo);background-color:#100d08;background-image:linear-gradient(90deg,transparent calc(50% - 1px),rgba(232,197,102,.16) 50%,transparent calc(50% + 1px)),linear-gradient(180deg,transparent calc(50% - 1px),rgba(232,197,102,.16) 50%,transparent calc(50% + 1px));touch-action:none;cursor:grab;margin:2px auto;overflow:hidden}
.xfpad::before{content:"";position:absolute;left:50%;top:50%;width:142%;height:2px;background:rgba(232,197,102,.45);transform:translate(-50%,-50%) rotate(45deg);pointer-events:none}
.xfpad::after{content:"";position:absolute;left:50%;top:50%;width:142%;height:2px;background:rgba(232,197,102,.45);transform:translate(-50%,-50%) rotate(-45deg);pointer-events:none}
.xfpad:active{cursor:grabbing}
.dsec{margin-top:4px;border-top:1px solid #241d10}
.dsec-h{display:flex;justify-content:space-between;align-items:center;width:100%;background:none;border:0;color:var(--gold-lo);font:700 14px var(--body);letter-spacing:.14em;padding:8px 2px;cursor:pointer;min-height:38px;text-transform:uppercase}
.dsec-a{font-size:16.5px;transition:transform .15s}
.dsec.shut .dsec-a{transform:rotate(-90deg)}
.dsec.shut .dsec-b{display:none}
.ytbox{width:100%;aspect-ratio:16/9;background:#000;border-radius:12px;overflow:hidden;margin:8px 0}
.ytbox iframe{width:100%;height:100%;border:0;display:block}
.pfold{display:contents}
.pfold.shut{display:none}
border-radius:50%;background:radial-gradient(circle at 35% 30%,#ffe9a8,var(--gold));border:2px solid #0d0b08;box-shadow:0 2px 10px rgba(0,0,0,.65);transform:translate(-50%,-50%);pointer-events:none;left:50%;top:50%}
.xfpl{position:absolute;top:50%;transform:translateY(-50%);font:800 12px var(--body);color:var(--gold-hi)}
.xfpl.a{left:8px}.xfpl.b{right:8px}
.deck .wave{cursor:pointer;touch-action:none}
.xfpad.big{width:128px;height:128px}
.xfpad .xfpl.tl{left:10px;top:8px;transform:none}
.xfpad .xfpl.tr{right:10px;top:8px;left:auto;transform:none}
.xfpad .xfpl.bl{left:10px;bottom:8px;top:auto;transform:none}
.xfpad .xfpl.br{right:10px;bottom:8px;top:auto;left:auto;transform:none}
@media(min-width:1100px){body.dj-on main{margin-left:0!important;margin-right:0!important}body.dj-on #v-radio .wrap{max-width:1740px}}
/* the Radio view is a console: the Book rails get out of the way completely and the
   booth spreads edge to edge (the scroll-triggered hiding alone left them in the way) */
@media(min-width:1100px){body[data-view="radio"] #fb-left,body[data-view="radio"] #fb-right{display:none!important}body[data-view="radio"] main{margin-left:0!important;margin-right:0!important}body[data-view="radio"] #v-radio .wrap{max-width:1740px}}
/* compact decks on desktop: smaller platters, waves, buttons and gaps so a whole
   table fits the screen without a long scroll (Malik: "make these tabs smaller") */
@media(min-width:761px){#dj-owner .deck{gap:6px;padding:10px}#dj-owner .deck .platter{width:172px}#dj-owner .deck .wave{height:58px}#dj-owner .deck .btn{padding:6px 9px;font-size:15.5px;min-height:34px}#dj-owner .deck .row{gap:5px}#dj-owner .deck .eqrow{gap:4px}#dj-owner .deck h4{margin:0;font-size:16.5px}#dj-owner .mixer{gap:6px;padding:10px}#dj-owner .xfpad.big{width:148px;height:148px}}
/* three-zone console on wide screens (Malik: "A and B decks on the left, C and D on
   the right, make the song pick and mixer in the middle"): the deck bank unwraps so
   its pieces place straight into the booth grid — A/B left, C/D right, and the middle
   column stacks main mixer, SONG PICKER, C/D mixer. */
@media(min-width:1500px){#dj-owner{display:grid;grid-template-columns:1fr 1fr 500px 1fr 1fr;gap:14px;align-items:start}#dj-owner>.dj-top{grid-column:1/-1}#dj-owner>.dj-setups{grid-column:1/-1;grid-row:2;margin-bottom:0}#dj-owner>.dj-decks{display:contents}#dj-owner .deck[data-deck="A"]{grid-column:1;grid-row:3/span 3}#dj-owner .deck[data-deck="B"]{grid-column:2;grid-row:3/span 3}#dj-owner .deck[data-deck="C"]{grid-column:4;grid-row:3/span 3}#dj-owner .deck[data-deck="D"]{grid-column:5;grid-row:3/span 3}#dj-owner .mixer.m1{grid-column:3;grid-row:4}#dj-owner #dj-browser{grid-column:3;grid-row:3;margin-top:0!important}#dj-owner .mixer.m2{grid-column:3;grid-row:5}#dj-owner>.dj-grid2{grid-column:1/-1}#dj-owner .swapbar{display:none}}
html.popdj .popdj-hint{display:block}
.dj-rotate{display:none}
@media (orientation:portrait) and (max-width:900px){.dj-rotate{display:flex;align-items:center;gap:8px;background:linear-gradient(180deg,#2a2112,#15110a);border:1px solid var(--gold);color:var(--text);border-radius:10px;padding:9px 12px;font:600 17px var(--body);margin-bottom:10px}}
@media (max-width:760px){.dj-decks{grid-template-columns:minmax(0,1fr) minmax(0,1fr)}#dj-browser .dj-item .btn{min-width:44px;min-height:44px;padding:0 6px}}
/* song rows must be READABLE (owner, 2026-10-28: on the song search you cant
   scroll over to see what song youre choosing): on narrow screens the title
   wraps in full instead of truncating to a sliver, and the deck buttons wrap
   under it instead of running off the clipped right edge */
@media (max-width:900px){.dj-item span{white-space:normal;overflow:visible;text-overflow:clip;overflow-wrap:anywhere}}
@media (orientation:landscape) and (max-height:540px) and (max-width:1100px){.dj-decks{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:8px}.dj-decks>.deck[data-deck="A"]{grid-column:1;grid-row:1}.dj-decks>.deck[data-deck="B"]{grid-column:2;grid-row:1}.dj-decks>.deck[data-deck="C"]{grid-column:3;grid-row:1}.dj-decks>.deck[data-deck="D"]{grid-column:4;grid-row:1}.dj-decks>.mixer.m1{grid-column:1/-1;grid-row:2}.dj-decks>.mixer.m2{grid-column:1/-1;grid-row:3}.dj-decks>.swapbar{display:none!important}#dj-owner .deck{padding:8px;gap:5px}#dj-owner .deck .platter{width:92px}#dj-owner .deck .wave{height:40px}}
.vstage{position:relative;width:100%;aspect-ratio:16/9;background:#000;border:1px solid var(--line);border-radius:10px;overflow:hidden}
.vslot{position:absolute;inset:0;opacity:0;transition:opacity .12s linear;pointer-events:none}
#app-poll [data-appvote].on{outline:2px solid #f0cf78;outline-offset:2px}
.vstage .vslot{overflow:hidden}
.vstage .vslot iframe{filter:brightness(var(--vb,1)) contrast(var(--vc,1)) saturate(var(--vs,1));transform:scale(var(--vz,1))}
#dj-edit .edgrid{display:grid;grid-template-columns:1fr 1fr;gap:4px 24px}
@media(max-width:760px){#dj-edit .edgrid{grid-template-columns:1fr}}
#dj-edit label{display:flex;justify-content:space-between;gap:8px;font-size:15px;color:var(--muted);margin-top:7px}
#dj-edit label span{color:#e9d9a6;font-weight:700}
.vslot iframe{width:100%;height:100%;border:0}
.vstandby{position:absolute;inset:0;display:grid;place-items:center;color:var(--muted);font:600 12.5px var(--body);letter-spacing:.05em;text-align:center;padding:12px;z-index:1}
.vposter{position:absolute;inset:0;z-index:2;pointer-events:none;background:#000}
.vposter img{width:100%;height:100%;object-fit:contain;display:block}
.vstage.vs-on .vposter{display:none!important}
.vchip{position:absolute;left:8px;bottom:8px;max-width:calc(100% - 16px);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;background:rgba(0,0,0,.68);border:1px solid var(--gold-lo);color:var(--text);border-radius:999px;padding:3px 10px;font:700 11.5px var(--body);z-index:3}
/* GO LIVE STUDIO (owner, 2026-10-29): the WebRTC stream (his camera in full
   motion, or his captured screen) rides ABOVE the video mix on every master
   stage while S.vstream is on — the mix keeps rendering underneath, so the
   moment the stream stops the stage falls straight back to it. */
.vslive{position:absolute;inset:0;width:100%;height:100%;object-fit:contain;background:#000;z-index:5;display:none}
.vstage.vs-on .vslive{display:block}
.vstage.vs-on .vstandby{display:none!important}
.vstatus{position:absolute;top:8px;left:8px;z-index:7;background:rgba(0,0,0,.72);border:1px solid var(--gold-lo);color:#ffd766;border-radius:8px;padding:3px 9px;font:700 11.5px var(--body);letter-spacing:.02em;pointer-events:none}
.vspause{position:absolute;right:8px;bottom:8px;z-index:8;background:rgba(0,0,0,.72);border:1px solid var(--gold-lo);color:#ffd766;border-radius:8px;padding:4px 10px;font:700 11.5px var(--body);cursor:pointer}
.vspause[hidden]{display:none!important}
.vshidden{position:absolute;inset:0;z-index:7;display:grid;place-items:center;background:#050505;color:#f0cf78;font:800 14px var(--body);letter-spacing:.1em;text-align:center;padding:14px}
.vshidden[hidden]{display:none}
.vsrestore{position:absolute;left:8px;right:8px;bottom:8px;z-index:9;display:flex;gap:8px;align-items:center;justify-content:space-between;background:rgba(24,6,6,.94);border:1px solid #e5484d;color:#ffd7d7;border-radius:10px;padding:8px 10px;font:700 12.5px var(--body)}
.vsrestore[hidden]{display:none}
.vsrestore .btn{flex:none}
.capbig{display:block;width:100%;min-height:56px;margin:10px 0;padding:12px 14px;background:#000;color:#f0cf78;border:2px solid #f0cf78;border-radius:12px;font:800 16px var(--body);letter-spacing:.04em;cursor:pointer;animation:bopulse 2s ease-in-out infinite}
.capbig.on{background:#e5484d;color:#fff;border-color:#e5484d}
.vmixrow{display:flex;gap:6px;flex-wrap:wrap;align-items:center;margin-top:6px}
.vmixrow .btn.on{background:var(--gold);color:#0b0a08;border-color:var(--gold)}
/* OBS STUDIO strip (2026-10-29): the crop controls for a live screen share,
   one bar under the booth master stage, shown only while THIS tab is sharing */
#dj-studio{margin-top:8px;border:1px solid var(--gold-lo);border-radius:10px;padding:8px 10px;background:rgba(0,0,0,.35)}
#dj-studio .studio-hd{display:flex;gap:8px;align-items:center;flex-wrap:wrap;font:700 15px var(--body);letter-spacing:.05em;color:#f0cf78}
#dj-studio .studio-hd .muted{color:var(--muted);font-weight:600;letter-spacing:0}
#dj-studio .studio-sl{display:flex;gap:14px;flex-wrap:wrap;margin-top:7px}
#dj-studio .studio-sl label{display:flex;gap:6px;align-items:center;font:600 15px var(--body);color:var(--text)}
#dj-studio .studio-sl input[type=range]{width:110px;accent-color:#f0cf78}
#dj-studio .studio-sl span{min-width:34px;color:#f0cf78;font-weight:700}
/* CAMERA SQUARE (owner, 2026-10-29): his webcam sits in a square beside the
   master video on the BOOTH screen only — the slots scoot over by exactly the
   square (the stage height), and turning the cam off removes .cam-on so the
   layout is byte-for-byte the way it was. Viewers' station/mini stages never
   get .cam-on: there is no camera path to their screens. */
#dj-vstage .vslot{transition:opacity .12s linear,right .45s ease}
#dj-vstage .vstandby{transition:right .45s ease}
#dj-vstage.cam-on .vslot{right:var(--camw,0px)}
#dj-vstage.cam-on .vstandby{right:var(--camw,0px)}
#dj-camwrap{position:absolute;right:0;top:0;height:100%;aspect-ratio:1/1;z-index:4;display:none;background:#000}
#dj-vstage.cam-on #dj-camwrap{display:block}
#dj-camvid{width:100%;height:100%;object-fit:cover;transform:scaleX(-1);border:2px solid var(--gold,#f0cf78);box-sizing:border-box;display:block;background:#0a0a0c}
#dj-camwrap.novid #dj-camvid{display:none}
#dj-camph{position:absolute;inset:0;display:none;place-items:center;color:var(--muted);font:600 15px var(--body);text-align:center;padding:10px;border:2px solid var(--gold,#f0cf78);box-sizing:border-box}
#dj-camwrap.novid #dj-camph{display:grid}
#dj-camtag{position:absolute;left:6px;top:6px;background:rgba(0,0,0,.68);border:1px solid var(--gold-lo,#8a6d2f);color:#f0cf78;border-radius:999px;padding:2px 8px;font:800 13px var(--body);letter-spacing:.08em;z-index:5}
#dj-camwrap.novid #dj-camtag{display:none}
/* CAMERA SUITE (owner, 2026-10-29): filters + background removal on his
   camera box, and the small live square of him on the viewers' pop-out
   master screen (.mw-camov, bottom-right, draggable).
   CAMERA PRO (owner, 2026-10-29): the cramped chip strip on the square is
   GONE — the square now carries only a slim [🎛 Edit] bar (top-right) and
   the name banner (bottom); every control lives in the 📷 CAMERA PRO
   panel in the studio grid. The composite canvas carries NO CSS mirror
   any more: the pipeline bakes mirror + zoom + pan into its bitmap, so
   the booth display and the broadcast frame are the same picture. */
#dj-camfx{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;border:2px solid var(--gold,#f0cf78);box-sizing:border-box;display:none;background:#000;z-index:2}
#dj-camwrap.fxbg #dj-camfx{display:block}
#dj-camwrap.fxbg #dj-camvid{opacity:0}
#dj-camwrap.novid #dj-camfx{display:none}
#dj-cambar{position:absolute;top:6px;right:6px;z-index:6;display:flex;align-items:center;gap:6px;background:rgba(5,5,8,.72);border:1px solid var(--gold-lo,#8a6d2f);border-radius:999px;padding:3px 4px 3px 8px}
#dj-camlook{font:800 13px var(--body);letter-spacing:.06em;color:var(--gold-hi,#f0cf78);white-space:nowrap}
#dj-camedit{background:var(--gold,#f0cf78);color:#0b0a08;border:0;border-radius:999px;padding:5px 11px;font:800 14.5px var(--body);cursor:pointer;white-space:nowrap}
#dj-cambanner{position:absolute;left:0;right:0;bottom:0;height:11.5%;z-index:5;display:flex;align-items:center;justify-content:center;background:var(--gold,#f0cf78);color:#0b0a08;font-weight:800;letter-spacing:.04em;white-space:nowrap;overflow:hidden;padding:0 8px;box-sizing:border-box}
#dj-cambanner[hidden]{display:none}
#dj-camwrap.novid #dj-cambanner{display:none}
.cp-sec{margin-top:14px}
.cp-sec:first-of-type{margin-top:2px}
.cp-lab{display:block;font:800 14px var(--body);letter-spacing:.1em;color:var(--gold-hi,#f0cf78);margin-bottom:7px}
.cp-chips{display:flex;flex-wrap:wrap;gap:6px}
.cp-chip{background:rgba(255,255,255,.06);border:1px solid rgba(240,207,120,.35);color:#e8e2d2;border-radius:999px;padding:9px 14px;min-height:38px;font:700 15.5px var(--body);cursor:pointer;white-space:nowrap}
#cp-bgs.warming .cp-chip{opacity:.55}
#cp-bgs.dead .cp-chip{opacity:.55}
.cp-chip.on{background:var(--gold,#f0cf78);color:#0b0a08;border-color:var(--gold,#f0cf78)}
.cp-row{display:flex;justify-content:space-between;gap:8px;font-size:15px;color:var(--muted);margin-top:9px}
.cp-row span{color:#e9d9a6;font-weight:700}
#dj-campro input[type=range]{width:100%;margin:2px 0 0}
#dj-campro input[type=text]{background:rgba(255,255,255,.06);border:1px solid rgba(240,207,120,.35);border-radius:8px;color:#e8e2d2;padding:9px 10px;font:600 17px var(--body);box-sizing:border-box}
.mw-camov{position:absolute;width:30%;aspect-ratio:1/1;z-index:8;border:2px solid var(--gold,#f0cf78);border-radius:8px;overflow:hidden;background:#000;box-shadow:0 6px 18px rgba(0,0,0,.5);touch-action:none;cursor:grab}
.mw-camov:active{cursor:grabbing}
.mw-camov img{width:100%;height:100%;object-fit:cover;display:block;-webkit-user-drag:none;user-select:none;-webkit-user-select:none}
.mw-camov-tag{position:absolute;left:4px;bottom:3px;font:800 8.5px var(--body);letter-spacing:.08em;color:#f0cf78;text-shadow:0 1px 3px #000;pointer-events:none}
#mw-camov-x{position:absolute;right:2px;top:2px;width:16px;height:16px;line-height:1;background:rgba(0,0,0,.65);border:1px solid rgba(240,207,120,.5);color:#f0cf78;border-radius:50%;font-size:10px;cursor:pointer;padding:0;z-index:2}
/* VIDEO TRANSITIONS + VIDEO FX (owner, 2026-10-28): discrete master-screen
   switches animate the incoming slot (wrapper only - the player inside is
   never reloaded, so the picture cannot lose its place against the sound);
   one-shot FX ride S.vfx stamps and animate every .vstage the same way. */
.vtrrow{display:flex;gap:6px;flex-wrap:wrap;align-items:center}
.vtrrow .btn.on{background:var(--gold);color:#0b0a08;border-color:var(--gold)}
.vslot.vtr-wipe{animation:vtrWipe var(--vtrd,.65s) ease both}
@keyframes vtrWipe{from{clip-path:inset(0 100% 0 0)}to{clip-path:inset(0 0 0 0)}}
.vslot.vtr-slide{animation:vtrSlide var(--vtrd,.65s) cubic-bezier(.2,.8,.25,1) both}
@keyframes vtrSlide{from{transform:translateX(100%)}to{transform:translateX(0)}}
.vslot.vtr-zoom{animation:vtrZoom var(--vtrd,.65s) ease both}
@keyframes vtrZoom{from{transform:scale(.55)}to{transform:scale(1)}}
.vslot.vtr-blur{animation:vtrBlur var(--vtrd,.65s) ease both}
@keyframes vtrBlur{from{filter:blur(16px)}to{filter:blur(0)}}
.vslot.vtr-glitch{animation:vtrGlitch .38s steps(2,end) both}
.vslot.vtr-fade::after,.vslot.vtr-flash::after{content:"";position:absolute;inset:0;pointer-events:none;z-index:5}
.vslot.vtr-fade::after{background:#000;animation:vfxOut var(--vtrd,.65s) ease both}
.vslot.vtr-flash::after{background:#fff;animation:vfxOut calc(var(--vtrd,.65s)*.7) ease both}
@keyframes vfxOut{from{opacity:1}to{opacity:0}}
@keyframes vtrGlitch{0%{transform:translate(0);clip-path:inset(12% 0 62% 0)}20%{transform:translate(-6px,2px);clip-path:inset(58% 0 8% 0)}40%{transform:translate(5px,-2px);clip-path:inset(28% 0 40% 0)}60%{transform:translate(-4px,1px);clip-path:inset(70% 0 4% 0)}80%{transform:translate(3px,0);clip-path:inset(6% 0 78% 0)}100%{transform:translate(0);clip-path:inset(0 0 0 0)}}
.vstage.vfx-flash::after,.vstage.vfx-strobe::after{content:"";position:absolute;inset:0;background:#fff;opacity:0;pointer-events:none;z-index:6}
.vstage.vfx-flash::after{animation:vfxFlashA .3s ease-out both}
@keyframes vfxFlashA{0%{opacity:1}100%{opacity:0}}
.vstage.vfx-strobe::after{animation:vfxStrobeA .66s steps(1,end) both}
@keyframes vfxStrobeA{0%{opacity:1}12%{opacity:0}25%{opacity:1}37%{opacity:0}50%{opacity:1}62%{opacity:0}100%{opacity:0}}
.vstage.vfx-glitch{animation:vtrGlitch .4s steps(2,end) both}
.vstage.vfx-blurp .vslot{animation:vfxBlurP .7s ease both}
@keyframes vfxBlurP{0%{filter:blur(0)}35%{filter:blur(14px)}100%{filter:blur(0)}}
.vstage.vfx-zoomp .vslot{animation:vfxZoomP .55s ease both}
@keyframes vfxZoomP{0%{transform:scale(1)}40%{transform:scale(1.14)}100%{transform:scale(1)}}
.vstage.vfx-mono .vslot iframe{filter:grayscale(1) brightness(var(--vb,1)) contrast(var(--vc,1))}
.vstage.vfx-invert .vslot iframe{filter:invert(1)}
.vstage.vfx-hue .vslot iframe{animation:vfxHueA 1.2s linear both}
@keyframes vfxHueA{from{filter:hue-rotate(0deg)}to{filter:hue-rotate(360deg)}}
/* MASTER SCREEN above the table (Malik, 2026-10-26): out of the mixer, full booth
   width, cinema height — tall enough to star, capped so the decks stay in reach */
#dj-screen{position:relative;margin:0 0 12px}
#dj-screen>small{display:block;color:var(--muted);font-size:14px;letter-spacing:.12em;margin-bottom:6px}
#dj-screen .vstage{aspect-ratio:16/9;max-height:66vh;min-height:200px;border-radius:14px}
@media(max-width:760px){#dj-screen .vstage{min-height:160px;max-height:52vh}}
@media(min-width:1500px){#dj-owner>#dj-screen{grid-column:1/-1;grid-row:3}#dj-owner>#dj-edit{grid-column:1/-1;grid-row:4}#dj-owner .deck[data-deck="A"]{grid-row:6/span 3}#dj-owner .deck[data-deck="B"]{grid-row:6/span 3}#dj-owner .deck[data-deck="C"]{grid-row:6/span 3}#dj-owner .deck[data-deck="D"]{grid-row:6/span 3}#dj-owner #dj-browser{grid-row:5}#dj-owner #dj-xfbar{grid-column:3;grid-row:6}#dj-owner .mixer.m1{grid-row:7}#dj-owner .mixer.m2{grid-row:8}}
/* MINI MASTER SCREEN (owner, 2026-10-26): the live video follows viewers to the
   top of every page in a little rectangle; it steps aside whenever a big screen
   (the booth's or the station card's) is already in front of them */
#dj-livealert{position:fixed;top:124px;left:50%;transform:translateX(-50%);z-index:66;display:flex;gap:8px;align-items:center;background:linear-gradient(180deg,#1d1e21,#101012);border:1px solid #f0cf78;border-radius:999px;padding:7px 10px;box-shadow:0 12px 32px rgba(0,0,0,.6);max-width:min(94vw,560px)}
#dj-livealert[hidden]{display:none}
/* BLACKOUT MODE (owner, 2026-10-28): a listener taps Blackout and the whole
   screen goes pure black while the radio keeps playing — on an OLED phone
   black pixels are off, so it looks (and sips power) like the screen is off,
   but the page never sleeps, so even YouTube decks keep playing. A wake lock
   holds the device awake (see blackout() in the script). The screen comes
   back when the listener locks the phone and returns, or presses any key
   on a computer — tapping the black screen does nothing, by design. A website cannot reach the phones real brightness
   control — pure black is the closest thing the web is allowed to do. */
#dj-blackout{position:fixed;inset:0;width:100vw;width:100dvw;height:100vh;height:100dvh;background:#000;z-index:9999;display:grid;place-items:center;cursor:none;overscroll-behavior:none;touch-action:none}
#dj-blackout:fullscreen,#dj-blackout:-webkit-full-screen{width:100%;height:100%}
#dj-blackout[hidden]{display:none}
#dj-blackout span{color:#9a9a9a;font:600 16.5px var(--body);letter-spacing:.08em;opacity:.4;transition:opacity 1.4s ease 2.4s;pointer-events:none}
#dj-blackout.bo-dim span{opacity:0}
/* the Blackout button, impossible to miss (owner, 2026-10-28: "I dont see the
   blackout mode — I want that very noticeable"): a full-width black-and-gold
   slab on the station card with a slow gold pulse, plus one in the booth top
   bar next to Go live */
.bobig{display:block;width:100%;min-height:56px;margin:10px 0;padding:12px 14px;background:#000;color:#f0cf78;border:2px solid #f0cf78;border-radius:12px;font:800 16px var(--body);letter-spacing:.04em;cursor:pointer;animation:bopulse 2s ease-in-out infinite}
@keyframes bopulse{0%,100%{box-shadow:0 0 0 0 rgba(240,207,120,0)}50%{box-shadow:0 0 18px 2px rgba(240,207,120,.45)}}
/* BUBBLE MODE fallback backdrop (owner, 2026-10-28 night): where no
   Picture-in-Picture exists, the page itself collapses under pure black to
   one small gold MW bubble, so a listener can pocket the phone or wander
   into other apps while the radio keeps playing. No wake lock, no
   fullscreen — the screen may sleep. Tap the bubble to come back (music
   untouched); the little ✕ on the bubble stops the music and comes back. */
#dj-bubbg{position:fixed;inset:0;width:100vw;width:100dvw;height:100vh;height:100dvh;background:#000;z-index:10060;overscroll-behavior:none}
#dj-bubbg[hidden]{display:none}
#mw-bubble{position:fixed;right:16px;bottom:96px;width:56px;height:56px;border-radius:50%;background:radial-gradient(circle at 32% 30%,#ffe9b0,#d4a843 58%,#9a7b24);color:#141109;font:800 17px var(--body);letter-spacing:.02em;display:grid;place-items:center;z-index:10061;border:2px solid #f0cf78;box-shadow:0 10px 26px rgba(0,0,0,.6);cursor:pointer;touch-action:none;user-select:none;-webkit-user-select:none;padding:0}
#mw-bubble[hidden]{display:none}
#mw-bubble .mw-x{position:absolute;top:-6px;right:-6px;width:22px;height:22px;border-radius:50%;background:#141109;color:#f0cf78;border:1.5px solid #f0cf78;font:700 12px var(--body);display:grid;place-items:center;line-height:1;pointer-events:none}
.bubbig{display:block;width:100%;min-height:56px;margin:10px 0;padding:12px 14px;background:#f0cf78;color:#141109;border:2px solid #f0cf78;border-radius:12px;font:800 16px var(--body);letter-spacing:.04em;cursor:pointer;animation:bopulse 2s ease-in-out infinite}
#dj-livealert .la-txt{font:700 12.5px var(--body);color:#ffe9b0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
#dj-livealert .btn{white-space:nowrap}
body.dj-on #dj-livealert,html.popdj #dj-livealert,html.gated #dj-livealert{display:none!important}
@media (max-width:760px){#dj-livealert{top:118px}#dj-livealert .la-txt{font-size:11.5px}}
.ws-modal{position:fixed;inset:0;z-index:1200;background:rgba(0,0,0,.74);display:grid;place-items:center;padding:16px}
.ws-modal[hidden]{display:none}
.ws-card{position:relative;background:linear-gradient(180deg,#1d1e21,#101012);border:1px solid #f0cf78;border-radius:16px;max-width:540px;width:100%;padding:20px;color:#f3ead2;max-height:88vh;overflow:auto;box-shadow:0 18px 50px rgba(0,0,0,.65)}
.ws-card .ws-x{position:absolute;top:10px;right:10px}
.wpl-row{display:flex;justify-content:space-between;align-items:center;gap:12px;border:1px solid #2b2b30;border-radius:10px;padding:10px 12px;margin:8px 0;background:#141518}
.wpl-nm{display:flex;flex-direction:column;gap:2px}
.wpl-nm span{color:#9a917c;font-size:12.5px}
.wpl-pr{color:#f0cf78;white-space:nowrap}
body[data-view="dj"] #dj-livealert{display:none}
#dj-mini{position:fixed;top:64px;right:10px;width:208px;height:max-content;max-width:calc(100vw - 20px);z-index:65;background:#000;border:1px solid var(--gold-lo);border-radius:12px;overflow:hidden;box-shadow:0 10px 30px rgba(0,0,0,.55)}
#dj-mini .mn-bar{display:flex;align-items:center;justify-content:space-between;gap:6px;background:#141109;color:var(--gold-hi,#f0cf78);font:700 10px var(--body);letter-spacing:.1em;padding:4px 8px}
#dj-mini .mn-bar span{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
#dj-mini .mn-bar button{background:none;border:0;color:var(--muted);font-size:12px;cursor:pointer;padding:0 2px;flex:none}
#dj-mini #mn-pop{display:none}
#dj-mini .mn-bar{cursor:grab;touch-action:none;user-select:none;-webkit-user-select:none}
#dj-mini.mn-drag .mn-bar{cursor:grabbing}
#dj-mini .vstage{border:0;border-radius:0}
@media(max-width:760px){#dj-mini{top:calc(env(safe-area-inset-top,0px) + 56px)!important;bottom:auto!important;left:0!important;right:0!important;width:auto!important;max-width:none!important;border-left:0;border-right:0;border-radius:0}#dj-mini .mn-grip{display:none}#dj-mini .mn-bar{cursor:default}#dj-mini #mn-pop{display:block}}
html.popdj #dj-mini,html.gated #dj-mini{display:none!important}
#dj-owner [data-ckey]{position:relative}
#dj-owner [data-ckey].ck-off{display:none!important}
#dj-owner.ck-on [data-ckey]{outline:1.5px dashed rgba(212,168,67,.55);outline-offset:2px}
.ck-chip{position:absolute;top:6px;right:6px;z-index:6;display:none;background:#1d1a14;border:1px solid var(--gold);color:var(--gold-hi);border-radius:999px;padding:5px 11px;font:700 15px var(--body);cursor:pointer}
#dj-owner.ck-on .ck-chip{display:block}
#dj-ckbar{display:none;flex-wrap:wrap;gap:6px;align-items:center;background:#12100c;border:1px dashed var(--gold-lo);border-radius:10px;padding:8px 10px;margin-bottom:10px;grid-column:1/-1}
#dj-owner.ck-on #dj-ckbar{display:flex}
#dj-booth-root #dj-owner{max-width:100%}
#dj-booth-root #dj-owner .dj-decks>*{min-width:0}
@media (max-width:760px){
#dj-booth-root #dj-owner .dj-decks{grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:8px;align-items:stretch}
#dj-booth-root #dj-owner .deck{padding:8px;gap:5px}
#dj-booth-root #dj-owner .deck .platter{width:76px;margin-inline:auto}
#dj-booth-root #dj-owner .deck .wave{height:38px}
#dj-booth-root #dj-owner .deck h4{font-size:15px}
#dj-booth-root #dj-owner .btn{min-height:40px;font-size:15.5px;padding:5px 8px}
#dj-booth-root #dj-owner .mixer{padding:8px;gap:6px}
#dj-booth-root #dj-owner .xfpad.big{width:118px;height:118px}
#dj-booth-root #dj-owner .dj-panel{padding:9px}
}
@media (orientation:landscape) and (max-height:600px) and (max-width:1200px){
#dj-booth-root #dj-owner .dj-decks{grid-template-columns:repeat(4,minmax(0,1fr));gap:8px;align-items:stretch}
#dj-booth-root #dj-owner .dj-decks>.deck[data-deck="A"]{grid-column:1;grid-row:1}
#dj-booth-root #dj-owner .dj-decks>.deck[data-deck="B"]{grid-column:2;grid-row:1}
#dj-booth-root #dj-owner .dj-decks>.deck[data-deck="C"]{grid-column:3;grid-row:1}
#dj-booth-root #dj-owner .dj-decks>.deck[data-deck="D"]{grid-column:4;grid-row:1}
#dj-booth-root #dj-owner .dj-decks>.mixer.m1{grid-column:1/-1;grid-row:2}
#dj-booth-root #dj-owner .dj-decks>.mixer.m2{grid-column:1/-1;grid-row:3}
#dj-booth-root #dj-owner .deck{padding:7px;gap:4px}
#dj-booth-root #dj-owner .deck .platter{width:80px;margin-inline:auto}
#dj-booth-root #dj-owner .deck .wave{height:34px}
#dj-booth-root #dj-owner .deck h4{font-size:15px}
#dj-booth-root #dj-owner .btn{min-height:38px;font-size:15px;padding:4px 7px}
#dj-booth-root #dj-owner .mixer{padding:8px;gap:6px}
#dj-booth-root #dj-owner .xfpad.big{width:110px;height:110px}
}
@media (min-width:1100px){
#dj-booth-root #dj-owner .xfpad.big{width:190px;height:190px}
}
#dj-owner .xfbar{align-items:center;text-align:center}
/* ===== PRO HARDWARE SKIN — the owner's reference unit (AlphaTheta XDJ-AZ),
   2026-10-26: same booth, hardware body. Charcoal panels, jog wheels with
   ticked rims and color-coded decks, performance pads, silver fader caps,
   and a real bezel on the master screen. Skin only — no layout moves. ===== */
#dj-owner .deck[data-deck="A"]{--dk:#f0cf78}
#dj-owner .deck[data-deck="B"]{--dk:#38bdf8}
#dj-owner .deck[data-deck="C"]{--dk:#4ade80}
#dj-owner .deck[data-deck="D"]{--dk:#f472b6}
#dj-owner .deck,#dj-owner .mixer,#dj-owner .dj-panel{background:linear-gradient(180deg,#17181a,#0b0b0d);border:1px solid #26272b;box-shadow:inset 0 1px 0 rgba(255,255,255,.05),0 10px 24px rgba(0,0,0,.45)}
#dj-station{background:linear-gradient(180deg,#17181a,#0b0b0d);border-color:#26272b}
#dj-owner .deck h4{letter-spacing:.22em;font-size:15px;color:#d8d4c9;border-left:4px solid var(--dk,#f0cf78);padding-left:8px;text-align:left}
#dj-owner .platter{border:3px solid #33343a;background:repeating-radial-gradient(circle,#1a1b1d 0 2px,#101012 2px 4px);box-shadow:inset 0 0 0 5px #0a0a0c,inset 0 0 26px #000,0 10px 22px rgba(0,0,0,.65)}
#dj-owner .platter::before{content:"";position:absolute;inset:-3px;border-radius:50%;background:repeating-conic-gradient(from 0deg,rgba(235,235,240,.55) 0deg 2deg,transparent 2deg 10deg);-webkit-mask:radial-gradient(circle,transparent 0 76%,#000 77%);mask:radial-gradient(circle,transparent 0 76%,#000 77%);pointer-events:none}
#dj-owner .platter::after{box-shadow:0 0 0 3px #0c0a07,0 0 0 5px var(--dk,#f0cf78),inset 0 2px 6px rgba(255,255,255,.35)}
#dj-owner .deck[data-deck="A"] .platter:not(.has-cover)::after{content:"A";display:grid;place-items:center;font:800 22px var(--body);color:#15130f}
#dj-owner .deck[data-deck="B"] .platter:not(.has-cover)::after{content:"B";display:grid;place-items:center;font:800 22px var(--body);color:#15130f}
#dj-owner .deck[data-deck="C"] .platter:not(.has-cover)::after{content:"C";display:grid;place-items:center;font:800 22px var(--body);color:#15130f}
#dj-owner .deck[data-deck="D"] .platter:not(.has-cover)::after{content:"D";display:grid;place-items:center;font:800 22px var(--body);color:#15130f}
@media(max-width:760px){#dj-owner .deck[data-deck="A"] .platter:not(.has-cover)::after,#dj-owner .deck[data-deck="B"] .platter:not(.has-cover)::after,#dj-owner .deck[data-deck="C"] .platter:not(.has-cover)::after,#dj-owner .deck[data-deck="D"] .platter:not(.has-cover)::after{font-size:11px}}
#dj-owner .platter.spin{box-shadow:inset 0 0 0 5px #0a0a0c,inset 0 0 26px #000,0 0 24px color-mix(in srgb,var(--dk,#f0cf78) 45%,transparent),0 10px 22px rgba(0,0,0,.65)}
#dj-owner [data-play]{border-radius:999px;border:2px solid #4ade80!important;background:#0c1710;color:#dcffe6;box-shadow:0 0 0 3px #050d08,0 4px 10px rgba(0,0,0,.55)}
#dj-owner [data-cue0]{border-radius:999px;border:2px solid var(--gold)!important;background:#171106;color:#ffe9b0}
#dj-owner [data-brake]{border-radius:999px}
#dj-owner .dsec[data-dsec="cues"] .row{display:grid;grid-template-columns:repeat(3,1fr);gap:6px}
#dj-owner .cuebtn,#dj-owner .loopbtn{border-radius:8px;background:#101013;border:2px solid #3a3a40;color:#e8e4da;font-weight:800;letter-spacing:.03em;box-shadow:inset 0 0 0 2px #000,0 3px 0 #000;min-height:44px}
#dj-owner .cuebtn:nth-of-type(1){border-color:#f0cf78}
#dj-owner .cuebtn:nth-of-type(2){border-color:#4ade80}
#dj-owner .cuebtn:nth-of-type(3){border-color:#38bdf8}
#dj-owner .cuebtn.on,#dj-owner .loopbtn.on{background:#26200c;box-shadow:0 0 12px rgba(240,207,120,.35),inset 0 0 0 2px #000}
#dj-owner input[type=range]{-webkit-appearance:none;appearance:none;background:transparent;height:24px}
#dj-owner input[type=range]::-webkit-slider-runnable-track{height:4px;border-radius:2px;background:linear-gradient(180deg,#08080a,#26262b);box-shadow:inset 0 1px 3px #000,0 1px 0 rgba(255,255,255,.06)}
#dj-owner input[type=range]::-webkit-slider-thumb{-webkit-appearance:none;appearance:none;width:24px;height:15px;margin-top:-5.5px;border-radius:3px;background:linear-gradient(180deg,#f2f2f5,#a7a7ae 46%,#43434a 54%,#d7d7dc);border:1px solid #000;box-shadow:0 2px 5px rgba(0,0,0,.65)}
#dj-owner input[type=range]::-moz-range-track{height:4px;border-radius:2px;background:#1b1b1f}
#dj-owner input[type=range]::-moz-range-thumb{width:24px;height:15px;border-radius:3px;background:linear-gradient(180deg,#f2f2f5,#a7a7ae 46%,#43434a 54%,#d7d7dc);border:1px solid #000}
#dj-owner .eqrow label{background:#0f0f11;border:1px solid #232327;border-radius:8px;padding:5px 6px;text-align:center}
#dj-screen .vstage{border:8px solid #0a0a0c;outline:1px solid #2c2c30;border-radius:6px;box-shadow:0 16px 36px rgba(0,0,0,.6)}
#st-ytbox .vstage{border:6px solid #0a0a0c;outline:1px solid #2c2c30}
/* ===== SKIN CORRECTIONS — from the 2026-10-26 visual test + the owner's own
   booth photo: the first skin pass lost specificity fights to the booth-root
   override blocks and rounded corners instead of making shapes. These rules
   carry the double-ID prefix and finish the job: truly round transport,
   chunky pads, a bezel you can see, and the X fader's missing dot (it never
   had a size or position rule anywhere — the JS set left/top on a static,
   zero-height div, so it painted as nothing). ===== */
#dj-booth-root #dj-owner [data-play],#dj-booth-root #dj-owner [data-cue0],#dj-booth-root #dj-owner [data-brake]{width:62px;height:62px;min-height:62px;border-radius:50%;padding:0;flex:none;font-size:14px;line-height:1.15}
#dj-booth-root #dj-owner [data-play]{border:3px solid #4ade80!important;background:#0c1710;color:#dcffe6;box-shadow:0 0 0 3px #050d08,0 0 16px rgba(74,222,128,.4),0 4px 10px rgba(0,0,0,.55)}
#dj-booth-root #dj-owner [data-cue0]{border:3px solid #f0cf78!important;background:#171106;color:#ffe9b0;box-shadow:0 0 0 3px #0d0a03,0 0 12px rgba(240,207,120,.3),0 4px 10px rgba(0,0,0,.55)}
#dj-booth-root #dj-owner [data-brake]{border:2px solid #43434a!important;background:#141416;color:#e8e4da;box-shadow:0 4px 10px rgba(0,0,0,.5)}
@media(max-width:760px){#dj-booth-root #dj-owner [data-play],#dj-booth-root #dj-owner [data-cue0],#dj-booth-root #dj-owner [data-brake]{width:52px;height:52px;min-height:52px;font-size:12.5px}}
#dj-booth-root #dj-owner .cuebtn,#dj-booth-root #dj-owner .loopbtn{border-radius:10px;background:linear-gradient(180deg,#17181a,#0c0c0e);border:2px solid #3a3a40;color:#e8e4da;font-weight:800;letter-spacing:.03em;min-height:48px;box-shadow:inset 0 1px 0 rgba(255,255,255,.06),0 3px 0 #000}
#dj-booth-root #dj-owner .cuebtn:nth-of-type(1){border-color:#f0cf78}
#dj-booth-root #dj-owner .cuebtn:nth-of-type(2){border-color:#4ade80}
#dj-booth-root #dj-owner .cuebtn:nth-of-type(3){border-color:#38bdf8}
#dj-booth-root #dj-owner .cuebtn.on,#dj-booth-root #dj-owner .loopbtn.on{background:#26200c;box-shadow:0 0 12px rgba(240,207,120,.35),inset 0 0 0 2px #000}
#dj-booth-root #dj-owner .dsec .row{flex-wrap:wrap;row-gap:6px}
#dj-screen .vstage{border:14px solid #0c0c0e;outline:3px solid #77777f;box-shadow:0 18px 40px rgba(0,0,0,.65),0 0 0 6px #000,inset 0 0 0 2px rgba(240,207,120,.28)}
#st-ytbox .vstage{border:10px solid #0c0c0e;outline:3px solid #77777f}
#dj-mini .vstage{border:6px solid #0c0c0e;outline:2px solid #77777f;box-shadow:inset 0 0 0 2px rgba(240,207,120,.28)}
.deck.playing{box-shadow:0 0 0 2px var(--dk),0 0 26px -4px var(--dk)}
.deck.playing [data-play]{animation:mwpulse 1.6s ease-in-out infinite}
@keyframes mwpulse{0%,100%{box-shadow:0 0 0 0 rgba(255,70,70,.55)}50%{box-shadow:0 0 0 8px rgba(255,70,70,0)}}
.loglist{overflow-x:hidden}.loglist>div{white-space:normal;word-break:break-word}.loglist div span{min-width:0;overflow-wrap:anywhere}
.midilist{display:grid;gap:3px;max-height:260px;overflow:auto;margin-top:8px}
.midilist .mrow{display:flex;align-items:center;gap:6px;font-size:15px;padding:2px 4px;border-radius:6px}
.midilist .mrow b{flex:1;min-width:0;font-weight:600}
.midilist .mrow .mb{font-size:13px;color:var(--gold-hi,#f0cf78);white-space:nowrap}
.midilist .mrow.learning{background:rgba(240,207,120,.14);outline:1px solid var(--gold-lo)}
.xfrow{display:flex;align-items:center;justify-content:center;gap:18px}
.xfvols{display:flex;gap:14px}
.xv{width:64px;text-align:center;cursor:ns-resize;touch-action:none;user-select:none;-webkit-user-select:none}
.xv i{display:block;width:52px;height:52px;margin:0 auto;border-radius:50%;background:radial-gradient(circle at 35% 30%,#3a3a40,#131315 70%);border:2px solid #000;outline:2px solid #77777f;position:relative;transform:rotate(var(--rot,-45deg))}
.xv i::after{content:"";position:absolute;left:50%;top:3px;width:3px;height:16px;margin-left:-1.5px;border-radius:2px;background:var(--dk)}
.xv span{display:block;font:700 9.5px var(--body);letter-spacing:.08em;color:var(--gold-hi,#f0cf78);margin-top:4px}
.xv b{display:block;font-size:10.5px;color:#e8e2d0;font-weight:600}
@media(max-width:760px){.xv{width:54px}.xv i{width:44px;height:44px}.xfrow{gap:10px}.xfvols{gap:8px}}
/* SAME CONSOLE EVERYWHERE (owner, 2026-10-27 late: "make all set ups the same
 * as desktops version just make it smaller so everything fits — not so big
 * like people are blind"): the portrait-phone setup switcher below is retired
 * by this. Every screen gets the full desktop console — all four decks, both
 * mixers, in the desktop arrangement — just sized down to fit the screen it
 * is on. Nothing hidden, nothing rearranged. The phset element and its JS
 * stay in the file but are never shown again, and the data-phn attributes
 * they stamp have no rules left to read them. */
#dj-phset{display:none!important}
@media (max-width:760px) and (orientation:portrait){
#dj-booth-root{overflow-x:clip}
#dj-booth-root #dj-owner .dj-decks>.deck[data-deck="A"]{grid-column:1;grid-row:1}
#dj-booth-root #dj-owner .dj-decks>.deck[data-deck="B"]{grid-column:2;grid-row:1}
#dj-booth-root #dj-owner .dj-decks>.mixer.m1{grid-column:1/-1;grid-row:2}
#dj-booth-root #dj-owner .dj-decks>.deck[data-deck="C"]{grid-column:1;grid-row:3}
#dj-booth-root #dj-owner .dj-decks>.deck[data-deck="D"]{grid-column:2;grid-row:3}
#dj-booth-root #dj-owner .dj-decks>.mixer.m2{grid-column:1/-1;grid-row:4}
#dj-booth-root #dj-owner .dj-decks>.swapbar{display:none!important}
#dj-booth-root #dj-owner .xfrow{gap:8px}
#dj-booth-root #dj-owner .xfvols{gap:6px}
#dj-booth-root #dj-owner .xv{width:46px}
#dj-booth-root #dj-owner .xv i{width:38px;height:38px}
#dj-booth-root #dj-owner .xfpad.big{width:104px;height:104px}
#dj-yt{min-width:0!important}
#dj-ytform input{min-width:0}
.dj-rotate{display:none!important}
}
/* portrait tablets: the same full console in the same desktop order, two
   decks across at a roomier size than the phones */
@media (min-width:761px) and (max-width:1100px) and (orientation:portrait){
#dj-booth-root #dj-owner .dj-decks{grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:10px;align-items:stretch}
#dj-booth-root #dj-owner .dj-decks>.deck[data-deck="A"]{grid-column:1;grid-row:1}
#dj-booth-root #dj-owner .dj-decks>.deck[data-deck="B"]{grid-column:2;grid-row:1}
#dj-booth-root #dj-owner .dj-decks>.mixer.m1{grid-column:1/-1;grid-row:2}
#dj-booth-root #dj-owner .dj-decks>.deck[data-deck="C"]{grid-column:1;grid-row:3}
#dj-booth-root #dj-owner .dj-decks>.deck[data-deck="D"]{grid-column:2;grid-row:3}
#dj-booth-root #dj-owner .dj-decks>.mixer.m2{grid-column:1/-1;grid-row:4}
#dj-booth-root #dj-owner .dj-decks>.swapbar{display:none!important}
#dj-booth-root #dj-owner .deck{padding:9px;gap:6px}
#dj-booth-root #dj-owner .deck .platter{width:150px;margin-inline:auto}
#dj-booth-root #dj-owner .deck .wave{height:48px}
#dj-booth-root #dj-owner .deck h4{font-size:15.5px}
#dj-booth-root #dj-owner .btn{min-height:40px;font-size:15.5px;padding:5px 8px}
#dj-booth-root #dj-owner .mixer{padding:9px;gap:6px}
#dj-booth-root #dj-owner .xfpad.big{width:132px;height:132px}
.dj-rotate{display:none!important}
}
/* layout safety only (kept after the owner asked his console arrangement back,
 * 2026-10-26): these two rules change nothing visually — they just stop a deck
 * from ever spilling outside its column. */
#dj-booth-root{overflow-x:clip}
#dj-owner .deck{min-width:0}
/* the MASTER FX strip: even cells, labels lined up over their sliders */
.fxgrid{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px 16px;align-items:start}
.fxgrid .fxcell{display:grid;gap:3px;min-width:0}
.fxgrid .fxcell small{letter-spacing:.05em;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.fxgrid .fxcell input[type="range"]{width:100%}
.fxgrid .fxcell.wide{grid-column:span 2}
@media(max-width:760px){.fxgrid{grid-template-columns:repeat(auto-fit,minmax(128px,1fr))}.fxgrid .fxcell.wide{grid-column:span 2}}
#dj-livealert .la-txt{flex:1 1 auto;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;line-height:1.3}
#dj-booth-root #dj-owner .xfpad{background:linear-gradient(135deg,#1b1c1f,#0c0c0e);border:1.5px solid #3f3f46;box-shadow:inset 0 1px 0 rgba(255,255,255,.07),inset 0 0 22px #000}
#dj-booth-root #dj-owner .xfdot{position:absolute;width:34px;height:34px;border-radius:50%;transform:translate(-50%,-50%);background:radial-gradient(circle at 35% 30%,#f5f5f7,#a8a8b0 55%,#55555c);border:2px solid #000;box-shadow:0 4px 10px rgba(0,0,0,.65),0 0 0 3px rgba(240,207,120,.25);z-index:3;pointer-events:none}
#dj-booth-root #dj-owner .platter{border-color:#45454c}
#dj-booth-root #dj-owner .platter::before{background:repeating-conic-gradient(from 0deg,rgba(235,235,240,.85) 0deg 2deg,transparent 2deg 10deg)}
/* BOOTH POLISH (owner scroll report, 2026-10-29): the booth performance
   surfaces hand vertical drags back to the page (pan-y), so a scroll that
   starts on a deck scrolls instead of stealing the song; horizontal drags
   still perform (the JS handlers gate on horizontal intent). Scoped to
   #dj-owner so the Watch mirror keeps its own behavior. */
#dj-owner .platter{touch-action:pan-y}
#dj-owner .xfpad{touch-action:pan-y}
#dj-owner .deck .wave{touch-action:pan-y}
/* LAW 22 (owner, 2026-10-30): the booth sliders ride the same pan-y rule -
   a vertical scroll that starts on a slider scrolls the page and leaves
   the value untouched; only a sideways drag along the track moves it */
#dj-owner input[type=range]{touch-action:pan-y}
/* LIVE ALERT: the buttons get their own flex row so a phone can stack the
   pill into a compact card instead of ballooning (owner screenshot,
   2026-10-29: the pill stretched huge and clipped Tune in down to UN). */
#dj-livealert .la-btns{display:flex;gap:8px;align-items:center}
@media (max-width:1100px){#dj-livealert{flex-direction:column;align-items:stretch;gap:7px;border-radius:18px;padding:9px 10px;width:min(94vw,430px)}
#dj-livealert .la-txt{white-space:normal;text-align:center;display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:2;line-clamp:2;overflow:hidden}
#dj-livealert .la-btns{gap:6px;width:100%}
#dj-livealert .la-btns .btn{flex:1 1 0;min-width:0;overflow:hidden;text-overflow:ellipsis;padding-left:4px;padding-right:4px;font-size:12px}
#dj-livealert .la-btns #la-x{flex:0 0 auto}}
/* ===== SETUP UPGRADE (owner: "Upgrade my set up", 2026-10-26) — pro-size jog
   wheels on desktop/tablet, a true performance-pad grid in the cue section with
   deck-colored glow, stronger spin glow, and a metal finish for the setups row.
   The big wheels are height-guarded so landscape phones keep their fitted
   console (short screens stay on the phone sizes). ===== */
@media(min-width:761px) and (min-height:560px){#dj-booth-root #dj-owner .deck .platter{width:196px}#dj-booth-root #dj-owner .deck .platter::after{font-size:26px}}
@media(min-width:1500px) and (min-height:560px){#dj-booth-root #dj-owner .deck .platter{width:216px}}
#dj-booth-root #dj-owner .platter.spin{box-shadow:0 0 26px var(--dk,#f0cf78),inset 0 0 20px #000,0 8px 20px rgba(0,0,0,.6)}
#dj-booth-root #dj-owner .dsec[data-dsec="cues"] .row{display:grid;grid-template-columns:repeat(4,1fr);gap:6px}
#dj-booth-root #dj-owner .cuebtn,#dj-booth-root #dj-owner .loopbtn{min-height:52px}
#dj-booth-root #dj-owner .cuebtn.on,#dj-booth-root #dj-owner .loopbtn.on{box-shadow:0 0 16px var(--dk,#f0cf78),inset 0 0 0 2px #000}
#dj-booth-root #dj-owner .dj-setups .btn{background:linear-gradient(180deg,#26262a,#131315);border:1px solid #3f3f46;color:#e8e4da;box-shadow:inset 0 1px 0 rgba(255,255,255,.07),0 3px 0 #000}
#dj-booth-root #dj-owner .mixer h4,#dj-booth-root #dj-owner .dj-panel>h4{background:linear-gradient(180deg,#1d1e21,#101012);border:1px solid #2b2b30;border-radius:8px;padding:6px 9px}
/* ===== STATION-WIDE UPGRADE (owner: "Upgrade everything in my dj radio
   station", 2026-10-26) — crossfader curve selector, sound-board pads as a
   performance grid, taller deck waveforms, a gold seam under the booth
   masthead, and a steel nameplate on the listener station header. ===== */
#dj-booth-root #dj-owner .xfcurve{display:flex;gap:6px;align-items:center;justify-content:center;margin-top:7px}
#dj-booth-root #dj-owner .xfcurve span{font:800 12.5px var(--body);letter-spacing:.12em;color:var(--muted)}
#dj-booth-root #dj-owner .xfcurve button{background:linear-gradient(180deg,#17181a,#0c0c0e);border:2px solid #3a3a40;color:#e8e4da;border-radius:8px;padding:5px 10px;font:700 14px var(--body);cursor:pointer;box-shadow:0 2px 0 #000}
#dj-booth-root #dj-owner .xfcurve button.on{border-color:#f0cf78;color:#ffe9b0;box-shadow:0 0 10px rgba(240,207,120,.35)}
#dj-booth-root #dj-owner .pads{display:grid;grid-template-columns:repeat(auto-fill,minmax(104px,1fr));gap:8px}
#dj-booth-root #dj-owner .pad{min-height:56px;border-radius:12px;background:linear-gradient(180deg,#17181a,#0c0c0e);border:2px solid #3a3a40;color:#e8e4da;box-shadow:inset 0 1px 0 rgba(255,255,255,.06),0 3px 0 #000;font-weight:800;cursor:pointer}
#dj-booth-root #dj-owner .pad:active{transform:translateY(2px);box-shadow:0 0 14px rgba(240,207,120,.35)}
@media(min-width:761px) and (min-height:560px){#dj-booth-root #dj-owner .deck .wave{height:66px}}
#dj-booth-root #dj-owner .dj-top{box-shadow:0 1px 0 rgba(240,207,120,.35)}
#dj-station h3{background:linear-gradient(180deg,#1d1e21,#101012);border:1px solid #2b2b30;border-radius:8px;padding:6px 9px}
#dj-booth-root #dj-owner [data-slip].on,#dj-booth-root #dj-owner [data-roll].on{border-color:#f0cf78;color:#ffe9b0;box-shadow:0 0 10px rgba(240,207,120,.4)}
#dj-booth-root #dj-owner .edivb.on{border-color:#f0cf78;color:#ffe9b0;box-shadow:0 0 10px rgba(240,207,120,.4)}
#dj-mini{border:3px solid #0a0a0c;outline:1px solid #2c2c30}
#dj-mini .mn-grip{position:absolute;right:0;bottom:0;width:24px;height:24px;z-index:5;cursor:nwse-resize;touch-action:none;background:linear-gradient(135deg,transparent 52%,rgba(240,207,120,.65) 52%,rgba(240,207,120,.65) 64%,transparent 64%,transparent 76%,rgba(240,207,120,.65) 76%,rgba(240,207,120,.65) 88%,transparent 88%)}
#dj-owner .xfpad{background:linear-gradient(135deg,#17181a,#0b0b0d);border:1px solid #2e2e33;box-shadow:inset 0 1px 0 rgba(255,255,255,.05),inset 0 0 18px #000}
#dj-owner .xfdot{background:linear-gradient(180deg,#f2f2f5,#9a9aa2 50%,#55555c);border:1px solid #000;box-shadow:0 3px 8px rgba(0,0,0,.6)}
#dj-owner .dj-top{border-bottom:2px solid #26272b;box-shadow:0 1px 0 rgba(240,207,120,.25)}
/* ===== PRO POLISH (owner: booth to its highest level, 2026-10-27) — one
   machined-hardware finish across every booth block so the owner and member
   tables match: matched panel chrome, deck nameplates lit in the deck accent
   color, pressed-metal buttons, a framed master screen, and the same finish
   on the listener station card. NO layout change: positions, sizes and the
   owner's console arrangement are untouched. ===== */
#dj-booth-root #dj-owner .deck,#dj-booth-root #dj-owner .mixer,#dj-booth-root #dj-owner .dj-panel{background:linear-gradient(180deg,#17181b,#0b0b0d);border:1px solid #33333a;border-radius:14px;box-shadow:inset 0 1px 0 rgba(255,255,255,.06),inset 0 -1px 0 rgba(0,0,0,.6),0 6px 18px rgba(0,0,0,.45)}
#dj-booth-root #dj-owner .deck h4{display:flex;align-items:center;gap:8px;background:linear-gradient(180deg,#1d1e21,#101012);border:1px solid #2b2b30;border-radius:8px;padding:6px 9px;letter-spacing:.18em}
#dj-booth-root #dj-owner .deck h4::before{content:"";width:9px;height:9px;border-radius:50%;flex:none;background:var(--dk,#f0cf78);box-shadow:0 0 8px var(--dk,#f0cf78)}
#dj-booth-root #dj-owner .btn{border-radius:9px;box-shadow:inset 0 1px 0 rgba(255,255,255,.05),0 2px 0 rgba(0,0,0,.55)}
#dj-booth-root #dj-owner .btn:active{transform:translateY(1px);box-shadow:inset 0 1px 0 rgba(255,255,255,.04),0 1px 0 rgba(0,0,0,.55)}
#dj-booth-root #dj-owner .xv i{box-shadow:inset 0 1px 0 rgba(255,255,255,.25),0 3px 8px rgba(0,0,0,.6),0 0 0 1px #000}
#dj-booth-root #dj-owner #dj-screen .vstage{border:1px solid #3a3a41;border-radius:14px;box-shadow:0 10px 30px rgba(0,0,0,.55),0 0 0 1px rgba(240,207,120,.12)}
#dj-booth-root #dj-owner button:focus-visible,#dj-booth-root #dj-owner input:focus-visible{outline:2px solid rgba(240,207,120,.75);outline-offset:1px}
#dj-station{background:linear-gradient(180deg,#141518,#0b0b0d);border-color:#33333a;box-shadow:inset 0 1px 0 rgba(255,255,255,.05),0 6px 18px rgba(0,0,0,.4)}
}
/* mwBoothOrganize (owner, 2026-10-29: "move things lower up higher -
   push everything up to fill in. Everything. I want you to organize
   it."): the panel area below the decks PACKS instead of stacking in
   grid rows. A row grid makes every row as tall as its tallest panel,
   so short panels strand black space beneath them, the last row sits
   mostly empty beside one tall panel, and on the wide grid the whole
   panel block waits below the tall centre stack while the columns
   under the decks stand empty. Two regimes, layout only - panel
   order, contents, controls and Customize behaviour are untouched:
   (1) below 1500px the panel area becomes balanced CSS columns:
   panels stack tightly down each column, a Customize-hidden panel
   leaves no hole, and the pack reflows on its own; (2) at 1500px+
   the panels become items of the owner grid itself and pack upward
   beside the centre stack, starting in the C/D mixer row (span 2 of
   the 5 columns; span 1 once the columns are wide enough at 1900px),
   so the dead space under the decks fills with panels instead of
   black. The setups row above spans its grid area over rows 2-4 so
   a hidden screen or editing block can never pull a panel up into
   the top zone; the decks, fader and master screen keep their exact
   places. */
@media(min-width:761px){
.dj-grid2{display:block;column-width:430px;column-gap:14px}
.dj-grid2>.dj-panel{break-inside:avoid;margin:0 0 14px}
}
@media(min-width:1500px){
#dj-owner>.dj-grid2{display:contents}
#dj-owner>.dj-grid2>.dj-panel{grid-column:span 2;margin:0}
}
@media(min-width:1900px){
#dj-owner>.dj-grid2>.dj-panel{grid-column:span 1}
}

/* booth organize (owner, 2026-10-29): buttons a little bigger on the shared booth and station button surfaces */
#dj-owner .btn,#dj-station .btn{padding:13px 24px}
#dj-owner .btn.sm,#dj-station .btn.sm{padding:8px 17px;font-size:15px}
#dj-owner .btn{min-height:46px}
/* organize: the drag grip lives in each below-decks panel header and only shows while the layout is unlocked */
#dj-owner .org-grip{display:none;flex:none;cursor:grab;touch-action:none;color:var(--gold-hi);font-size:19px;line-height:1;padding:5px 8px;margin-left:8px;border:1px solid var(--gold-lo);border-radius:8px;background:#141109;user-select:none;-webkit-user-select:none}
#dj-owner.org-open .org-grip{display:inline-grid;place-items:center}
#dj-owner .dj-panel.org-drag{opacity:.55;outline:2px dashed var(--gold);outline-offset:2px;position:relative;z-index:5}
#dj-orglock.on{border-color:var(--gold);color:#191104;background:var(--gold)}
/* BOOTH PLACEMENTS (owner, voice call 2026-10-29): the search + queue band
   sits directly under the widescreen master screen and directly above the
   decks, spanning the wide space; the X fader cluster rides in the CENTER
   of the deck bank between the pairs at every width; each decks transport
   buttons ride in a rail beside its platter. Fixed placements, like the
   screen move - never part of the draggable below-decks zone. */
/* wide screens: the band takes its own full-width row (5) between the
   edit row (4) and the deck rows (6-8); the center column stack in that
   zone is now the X cluster (row 6), main mixer (7), second mixer (8) */
@media(min-width:1500px){#dj-owner>#dj-browser{grid-column:1/-1;grid-row:5}}
/* band internals: video search wide at the left, the queue beside it at
   the right, the schedule strip and the music header + panes full width
   below - the search gets the wide presentation the owner asked for
   instead of a squeezed panel column */
@media(min-width:1100px){#dj-owner>#dj-browser{display:grid;grid-template-columns:minmax(0,2fr) minmax(0,1fr);gap:12px;align-items:start}#dj-owner>#dj-browser>*{margin-top:0!important;margin-bottom:0!important}#dj-owner>#dj-browser>div:nth-child(1){grid-column:1}#dj-owner>#dj-browser>div:nth-child(2){grid-column:2}#dj-owner>#dj-browser>div:nth-child(3),#dj-owner>#dj-browser>div:nth-child(4),#dj-owner>#dj-browser>#br-panes{grid-column:1/-1}}
/* mid widths: the cluster spans the bank between the A/B row and C/D row */
@media(min-width:761px) and (max-width:1499px){#dj-owner .dj-decks>.mixer.xfbar{grid-column:1/-1;grid-row:2}#dj-owner .dj-decks>.deck[data-deck="C"]{grid-column:2;grid-row:3}#dj-owner .dj-decks>.deck[data-deck="D"]{grid-column:3;grid-row:3}#dj-owner .dj-decks>.mixer.m2{grid-column:1;grid-row:3}}
/* phones: the same split stacked - A/B, cluster, main mixer, C/D, mixer 2 */
@media(max-width:760px){#dj-owner .dj-decks>.mixer.xfbar{grid-column:1/-1;grid-row:2}#dj-owner .dj-decks>.mixer.m1{grid-column:1/-1;grid-row:3}#dj-owner .dj-decks>.deck[data-deck="C"]{grid-column:1;grid-row:4}#dj-owner .dj-decks>.deck[data-deck="D"]{grid-column:2;grid-row:4}#dj-owner .dj-decks>.mixer.m2{grid-column:1/-1;grid-row:5}}
/* short landscape: all four decks on one row, the cluster standing in
   the center column between the pairs */
@media (orientation:landscape) and (max-height:540px) and (max-width:1100px){#dj-owner .dj-decks{grid-template-columns:minmax(0,1fr) minmax(0,1fr) 240px minmax(0,1fr) minmax(0,1fr)}#dj-owner .dj-decks>.mixer.xfbar{grid-column:3;grid-row:1}#dj-owner .dj-decks>.deck[data-deck="C"]{grid-column:4;grid-row:1}#dj-owner .dj-decks>.deck[data-deck="D"]{grid-column:5;grid-row:1}}
@media (orientation:landscape) and (max-height:600px) and (max-width:1200px){#dj-booth-root #dj-owner .dj-decks{grid-template-columns:minmax(0,1fr) minmax(0,1fr) 240px minmax(0,1fr) minmax(0,1fr)}#dj-booth-root #dj-owner .dj-decks>.mixer.xfbar{grid-column:3;grid-row:1}#dj-booth-root #dj-owner .dj-decks>.deck[data-deck="C"]{grid-column:4;grid-row:1}#dj-booth-root #dj-owner .dj-decks>.deck[data-deck="D"]{grid-column:5;grid-row:1}}
/* booth-root portrait phones and tablets: the same split with the full
   booth-root selectors, so the booth roots own bank rules hand the rows
   over cleanly */
@media (max-width:760px) and (orientation:portrait){#dj-booth-root #dj-owner .dj-decks>.mixer.xfbar{grid-column:1/-1;grid-row:2}#dj-booth-root #dj-owner .dj-decks>.mixer.m1{grid-column:1/-1;grid-row:3}#dj-booth-root #dj-owner .dj-decks>.deck[data-deck="C"]{grid-column:1;grid-row:4}#dj-booth-root #dj-owner .dj-decks>.deck[data-deck="D"]{grid-column:2;grid-row:4}#dj-booth-root #dj-owner .dj-decks>.mixer.m2{grid-column:1/-1;grid-row:5}}
@media (min-width:761px) and (max-width:1100px) and (orientation:portrait){#dj-booth-root #dj-owner .dj-decks>.mixer.xfbar{grid-column:1/-1;grid-row:2}#dj-booth-root #dj-owner .dj-decks>.mixer.m1{grid-column:1/-1;grid-row:3}#dj-booth-root #dj-owner .dj-decks>.deck[data-deck="C"]{grid-column:1;grid-row:4}#dj-booth-root #dj-owner .dj-decks>.deck[data-deck="D"]{grid-column:2;grid-row:4}#dj-booth-root #dj-owner .dj-decks>.mixer.m2{grid-column:1/-1;grid-row:5}}
/* transport rail beside the platter: the platter keeps its exact box and
   the rail is its own flex column to the right of it; the wave canvas
   below stays full width, so the rail can never overlap the platter or
   wave pointer surfaces the scroll gate guards */
.decktop{display:flex;gap:10px;align-items:center;justify-content:center;width:100%}
.drail{display:grid;gap:6px}
.drail .btn{white-space:nowrap}
/* PER-DECK SOUND PADS (owner, 2026-10-30): a compact rail of the jingle board
   pads inside every deck, left of the platter, painted by paintPadRails from
   the same SYNTH + S.pads data as the board below the decks. The rail is the
   flex crumple zone of the decktop row: flex-basis 46px with an outsized
   shrink factor and min-width 0, so when a deck runs tight the RAIL gives up
   width first and the platter and the drail keep the sizes they have always
   had. contain:size with align-self stretch means the rail fills exactly the
   row height the platter sets and its pads scroll inside that height: the
   decktop row never grows taller and the deck bank never grows wider. */
.decktop .dpads{flex:0 100 46px;min-width:0;min-height:0;align-self:stretch;contain:size;display:grid;grid-template-columns:1fr;grid-auto-rows:38px;gap:4px;overflow-y:auto;overflow-x:hidden;padding:3px;border:1px solid var(--line);border-radius:10px;background:rgba(240,207,120,.04);scrollbar-width:none}
.decktop .dpads::-webkit-scrollbar{display:none}
.dpad{display:flex;align-items:center;justify-content:center;width:100%;height:38px;padding:0;border-radius:8px;border:1px solid var(--gold-lo);background:#171208;color:var(--text);font-size:20px;line-height:1;white-space:nowrap;overflow:hidden;cursor:pointer;transition:filter .15s ease,transform .15s ease}
.dpad.custom{border-style:dashed}
.dpad small{font-size:11.5px;font-weight:700;margin-left:2px}
.dpad.hit{filter:brightness(1.9);transform:scale(.93)}
/* WATCH THE SETUP: the spectator bank mirrors the booth as the placements
   leave it - one bank split A/B, center cluster, C/D, with the queue band
   directly under the master screen */
#wb-root .wb-decks{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr) 300px minmax(0,1fr) minmax(0,1fr);gap:12px;align-items:start}
#wb-root .wb-decks>.deck[data-deck="A"]{grid-column:1;grid-row:1}
#wb-root .wb-decks>.deck[data-deck="B"]{grid-column:2;grid-row:1}
#wb-root .wb-decks>.mixer.xfbar{grid-column:3;grid-row:1}
#wb-root .wb-decks>.deck[data-deck="C"]{grid-column:4;grid-row:1}
#wb-root .wb-decks>.deck[data-deck="D"]{grid-column:5;grid-row:1}
@media(max-width:900px){#wb-root .wb-decks{grid-template-columns:minmax(0,1fr) minmax(0,1fr)}#wb-root .wb-decks>.deck[data-deck="A"]{grid-column:1;grid-row:1}#wb-root .wb-decks>.deck[data-deck="B"]{grid-column:2;grid-row:1}#wb-root .wb-decks>.mixer.xfbar{grid-column:1/-1;grid-row:2}#wb-root .wb-decks>.deck[data-deck="C"]{grid-column:1;grid-row:3}#wb-root .wb-decks>.deck[data-deck="D"]{grid-column:2;grid-row:3}}

/* MW TEXT-BIGGER BOOTH OVERRIDES - pass 2: the most-read booth text lives in rules shared with the Watch mirror and the station card, so those base rules stay untouched and the booth alone grows through these booth-rooted font-size overrides (factor 1.25, rounded to the nearest 0.5px). Font-size only - no geometry, no line-height, no markup. Deck buttons: the shared 12px governs the booth only at phone widths (at 761px and up the booth already sits at 15.5px via the pass-1 media rule), so that one override lives in the phone media block below at 15px and nothing anywhere gets smaller. */
#dj-owner .deck .ttl, #dj-booth-root #dj-owner .deck .ttl{font-size:21px}
#dj-owner .deck .tm, #dj-booth-root #dj-owner .deck .tm{font-size:15px}
#dj-owner .dj-panel h4, #dj-booth-root #dj-owner .dj-panel h4{font-size:15px}
#dj-owner .dj-item, #dj-booth-root #dj-owner .dj-item{font-size:17.5px}
#dj-owner .mixer small, #dj-booth-root #dj-owner .mixer small{font-size:14px}
#dj-owner .xv span, #dj-booth-root #dj-owner .xv span{font-size:12px}
#dj-owner .xv b, #dj-booth-root #dj-owner .xv b{font-size:13px}
#dj-owner .xfpl, #dj-booth-root #dj-owner .xfpl{font-size:15px}
#dj-owner .deck label.lab, #dj-booth-root #dj-owner .deck label.lab{font-size:14px}
#dj-owner .bpmv, #dj-booth-root #dj-owner .bpmv{font-size:17.5px}
#dj-owner .keyv, #dj-booth-root #dj-owner .keyv{font-size:14px}
#dj-owner .onair-lamp, #dj-booth-root #dj-owner .onair-lamp{font-size:16.5px}
#dj-owner .btn.sm, #dj-booth-root #dj-owner .btn.sm{font-size:19px}
#dj-owner .loglist, #dj-booth-root #dj-owner .loglist{font-size:16.5px}
#dj-owner .loglist time, #dj-booth-root #dj-owner .loglist time{font-size:14px}
@media (max-width:760px){
#dj-owner .dj-decks>.deck .ttl, #dj-booth-root #dj-owner .dj-decks>.deck .ttl{font-size:15px}
#dj-owner .dj-decks>.deck .btn, #dj-booth-root #dj-owner .dj-decks>.deck .btn{font-size:15px}
}
/* END MW TEXT-BIGGER BOOTH OVERRIDES */
`;
  document.head.appendChild(css);

  // collapsible deck sections: one shared open/shut choice per section, remembered
  // on this device — fold a deck down to just its platter, wave and Play row
  const secState = (() => { try { return Object.assign({ tempo: 1, cues: 0, sound: 1 }, JSON.parse(localStorage.getItem("mw-dsec-v1") || "{}")); } catch (_) { return { tempo: 1, cues: 0, sound: 1 }; } })();
  const secShut = (n) => (secState[n] ? "" : " shut");
  const deckHTML = (k) => `<div class="deck" data-deck="${k}"><h4>DECK ${k}</h4><div class="decktop">${SANDBOX ? "" : `<div class="dpads" id="dpads-${k}" data-dpads="${k}" role="group" aria-label="Deck ${k} sound pads"></div>`}<div class="platter" id="pl-${k}" title="Drag to scratch / scrub"></div><div class="drail"><button class="btn sm" type="button" data-play="${k}">▶ Play</button><button class="btn ghost sm" type="button" data-cue0="${k}">⏮ Cue</button><button class="btn ghost sm" type="button" data-brake="${k}">🛑 Brake</button></div></div>
    <canvas class="wave" id="wv-${k}" width="520" height="84"></canvas>
    <div class="ytbox" id="ytw-${k}" hidden><div id="yt-${k}"></div></div>
    <div class="ttl" id="ttl-${k}">Load a song</div><div class="tm" id="tm-${k}">0:00</div>
    <div class="beatbox"><span class="bpmv" id="bpm-${k}">BPM —</span><span class="keyv" id="key-${k}"></span><span class="bdots" id="dots-${k}"><i></i><i></i><i></i><i></i></span></div>
    <div class="dsec${secShut("tempo")}" data-dsec="tempo"><button class="dsec-h" type="button" data-dsecbtn="tempo">⏱ Tempo & grid<span class="dsec-a">▾</span></button><div class="dsec-b"><div class="row"><button class="btn ghost sm" type="button" data-tap="${k}">👆 TAP</button><button class="btn ghost sm" type="button" data-bpmadj="${k}:-0.1">BPM −</button><button class="btn ghost sm" type="button" data-bpmadj="${k}:0.1">BPM +</button><button class="btn ghost sm" type="button" data-bpmx="${k}:2">×2</button><button class="btn ghost sm" type="button" data-bpmx="${k}:0.5">÷2</button><button class="btn ghost sm" type="button" data-nudge="${k}:-1">◀ grid</button><button class="btn ghost sm" type="button" data-nudge="${k}:1">grid ▶</button></div></div></div>
    <div class="dsec${secShut("cues")}" data-dsec="cues"><button class="dsec-h" type="button" data-dsecbtn="cues">🎯 Cues, loops & jumps<span class="dsec-a">▾</span></button><div class="dsec-b"><div class="row">${[1, 2, 3].map((n) => `<button class="btn ghost sm cuebtn" type="button" data-hot="${k}:${n}">CUE ${n}</button>`).join("")}</div>
    <div class="row"><button class="btn ghost sm loopbtn" type="button" data-loopb="${k}:4">Loop 4 beats</button><button class="btn ghost sm loopbtn" type="button" data-loopb="${k}:8">Loop 8 beats</button><button class="btn ghost sm" type="button" data-sync="${k}">SYNC</button></div>
    <div class="row"><button class="btn ghost sm rollbtn" type="button" data-roll="${k}:4">🌀 Roll 4</button><button class="btn ghost sm rollbtn" type="button" data-roll="${k}:8">🌀 Roll 8</button><button class="btn ghost sm" type="button" data-bjump="${k}:-16">⏪⏪ 16</button><button class="btn ghost sm" type="button" data-bjump="${k}:16">16 ⏩⏩</button></div>
    <div class="row"><button class="btn ghost sm" type="button" data-bjump="${k}:-4">⏪ 4 beats</button><button class="btn ghost sm" type="button" data-bjump="${k}:4">4 beats ⏩</button></div></div></div>
    <div class="dsec${secShut("sound")}" data-dsec="sound"><button class="dsec-h" type="button" data-dsecbtn="sound">🎚 Cuts, pitch, EQ & sound<span class="dsec-a">▾</span></button><div class="dsec-b"><div class="row"><button class="btn ghost sm cutbtn" type="button" data-vcut="${k}">🎤 Vocal cut</button><button class="btn ghost sm cutbtn" type="button" data-bcut="${k}">🔊 Bass cut</button></div>
    <div class="row"><button class="btn ghost sm slipbtn" type="button" data-slip="${k}">🌀 Slip mode</button><button class="btn ghost sm" type="button" data-spin="${k}">⏪ Backspin</button></div>
    <label class="lab">Pitch <span id="pit-v-${k}">+0.0%</span><input type="range" min="0.92" max="1.08" step="0.001" value="1" data-pitch="${k}" aria-label="Deck ${k} pitch"></label>
    <label class="lab" style="display:flex;align-items:center;gap:8px"><input type="checkbox" data-vinyl="${k}" style="width:auto"> Vinyl mode (pitch bends like a record)</label>
    <div class="eqrow"><label>LOW<input type="range" min="-24" max="24" step="1" value="0" data-eq="${k}:lo"></label><label>MID<input type="range" min="-24" max="24" step="1" value="0" data-eq="${k}:mid"></label><label>HIGH<input type="range" min="-24" max="24" step="1" value="0" data-eq="${k}:hi"></label></div>
    <label class="lab">Filter (left = deep ↔ right = thin)<input type="range" min="0" max="100" step="1" value="50" data-flt="${k}" aria-label="Deck ${k} filter"></label>
    <label class="lab">Volume<input type="range" min="0" max="2" step="0.01" value="0.9" data-vol="${k}" aria-label="Deck ${k} volume"></label></div></div></div>`;

  root.innerHTML = `
<div class="dj-banner" id="dj-banner" hidden><span><b>● LIVE DJ SET</b> &nbsp;Meechie is on the decks right now</span><button class="btn sm" type="button" id="dj-listen">🎧 Listen live</button><button class="btn sm ghost" type="button" id="dj-bobtn" data-bobtn>🌑 Blackout</button><button class="btn sm ghost" type="button" data-bubbtn>🫧 Bubble</button><button class="btn sm ghost" type="button" data-capbtn>🖥 Capture My Screen</button><button class="btn sm ghost" type="button" data-hidebtn data-lab-off="🙈 Hide Share" data-lab-on="👁 Show Share" hidden>🙈 Hide Share</button></div>
<div class="station" id="dj-station" hidden>
  <div style="display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap"><h3>📻 Meechie's World Radio</h3><span style="display:flex;gap:8px;align-items:center"><span class="onair-lamp" id="st-lamp"><span class="dot"></span>CONNECTING</span><button class="btn ghost sm" type="button" data-fold="st-body" aria-label="Fold the station panel">▾</button></span></div>
  <div id="st-body">
  <div class="ticker" id="st-ticker" hidden><span id="st-ticker-t"></span></div>
  <div id="st-now" class="muted" style="font-size:14px">Connecting to the station…</div>
  <div id="st-online" class="muted" style="font-size:13px"></div>
  <div id="st-host" style="font-size:13.5px;font-weight:700;color:#ff8b8f" hidden></div>
  <button class="btn ghost sm" type="button" id="st-watch" style="margin:6px 0" hidden>👀 Watch Meechie's setup — live, look only</button>
  <div id="st-battle" hidden></div>
  <div id="st-show"></div>
  <button class="bobig" type="button" data-bobtn>🌑 BLACKOUT MODE — screen goes black, music keeps playing</button>
  <button class="bubbig" type="button" data-bubbtn>🫧 BUBBLE MODE — the site shrinks into a bubble, music keeps playing</button>
  <button class="capbig" type="button" data-capbtn>🖥 CAPTURE MY SCREEN — Meechie shows you his screen, live on the master screen</button>
  <button class="capbig" type="button" data-hidebtn data-lab-off="🙈 HIDE SHARE — viewers see the video mix while Meechie sets up the next shot" data-lab-on="👁 SHOW SHARE — put the screen back on the master screen" hidden>🙈 HIDE SHARE — viewers see the video mix while Meechie sets up the next shot</button>
  <div id="st-ytbox" hidden><b style="font-size:12px;letter-spacing:.1em">📺 ON AIR — MUSIC VIDEO</b><div class="vstage"><div class="vslot" id="st-vs1"></div><div class="vslot" id="st-vs2"></div><div class="vstandby" id="st-vstandby" style="white-space:pre-line">Meechie is live on the tables — the video mix lands here the moment a music video plays.</div><div class="vposter" id="st-vposter"><img src="/img/radio-promo.jpg" srcset="/img/radio-promo-640.webp 640w, /img/radio-promo-1080.webp 1080w" sizes="100vw" alt="Meechie's World Radio" loading="lazy" decoding="async"></div><div class="vchip" id="st-vchip" hidden></div></div></div>
  <div><b style="font-size:13px;letter-spacing:.1em">RECENTLY PLAYED</b><div class="loglist" id="st-log" style="margin-top:6px"></div></div>
  <div class="dj-panel" style="margin:0"><h4>REQUEST A SONG / SEND A DROP</h4>
    <form class="dj-search" id="rq-form"><input type="text" id="rq-text" maxlength="120" placeholder="Song request or shout-out..." aria-label="Song request"><button class="btn sm" type="submit">Send</button></form>
    <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap"><button class="btn ghost sm" type="button" id="rq-rec">🎙️ Record a voice drop</button><small class="muted" id="rq-rec-st">Up to 20 seconds. Meechie can play it on air.</small></div>
    <div style="margin-top:14px;border-top:1px solid var(--line);padding-top:12px"><b style="font-size:13px;letter-spacing:.1em">🎵 PICK A SONG FOR THE RADIO</b><small class="muted" style="display:block;margin:4px 0 8px">Pick a song and it plays next on the live radio — Meechie's songs mixed with real artists, every genre. The list is long: browse the shelves, tap a genre, or search any artist.</small><div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:8px"><button class="btn sm pktab" type="button" id="pk-mine">🔥 Meechie's songs</button><button class="btn ghost sm pktab" type="button" id="pk-real">🎤 Real artists</button></div><form class="dj-search" id="pk-form" style="margin-bottom:8px"><input type="search" id="pk-q" placeholder="Search any artist or song..." aria-label="Search music to pick"><button class="btn sm" type="submit">Search</button></form><div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:8px"><button class="btn ghost sm" type="button" data-pkgenre="hiphop">🕶️ Hip-Hop</button><button class="btn ghost sm" type="button" data-pkgenre="jazz">🎷 Jazz</button><button class="btn ghost sm" type="button" data-pkgenre="rock">🎸 Rock</button><button class="btn ghost sm" type="button" data-pkgenre="soul">❤️ Soul &amp; R&amp;B</button><button class="btn ghost sm" type="button" data-pkgenre="reggae">🇯🇲 Reggae</button><button class="btn ghost sm" type="button" data-pkgenre="classics">🎺 Classics</button><button class="btn ghost sm" type="button" data-pkgenre="more">🌍 More artists</button></div><div class="dj-list" id="pk-list" style="max-height:300px"></div><b style="font-size:12px;letter-spacing:.1em;display:block;margin-top:12px">📻 COMING UP — LISTENER PICKS</b><div class="dj-list" id="pk-queue" style="margin-top:6px;max-height:110px"><small class="muted">No picks yet — be the first.</small></div></div>
  </div>
  </div>
</div>
<div class="dj" id="dj-owner" hidden>
  <div class="dj-top"><div><p class="eyebrow" style="margin:0">Owner only · the station board</p><h3>🎛️ DJ Station</h3></div>
    <span class="onair-lamp" id="dj-lamp"><span class="dot"></span>OFF AIR</span>
    <span class="dj-clock" id="dj-lead"></span><span class="dj-clock" id="dj-online"></span><span class="dj-clock" id="dj-clock"></span><span class="dj-clock" id="dj-showtime"></span>
    <label class="dj-live"><input type="checkbox" id="dj-golive"> Go live (everyone hears your mix)</label><label class="dj-live"><input type="checkbox" id="dj-ad-top" checked> AUTO-DJ</label><label class="dj-live"><input type="checkbox" id="dj-horn-top"> 📯 HORNS</label><button class="btn sm" type="button" id="dj-reports-btn" hidden style="background:#000;color:#f0cf78;border:2px solid #f0cf78;font-weight:800">📋 REPORTS <span class="rp-badge" id="dj-reports-badge" hidden></span></button><button class="btn sm" type="button" data-bobtn style="background:#000;color:#f0cf78;border:2px solid #f0cf78;font-weight:800">🌑 BLACKOUT</button><button class="btn sm" type="button" data-bubbtn style="background:#000;color:#f0cf78;border:2px solid #f0cf78;font-weight:800">🫧 BUBBLE</button><button class="btn sm" type="button" data-capbtn style="background:#000;color:#f0cf78;border:2px solid #f0cf78;font-weight:800">🖥 CAPTURE</button><button class="btn sm" type="button" data-hidebtn data-lab-off="🙈 HIDE" data-lab-on="👁 SHOW" hidden style="background:#000;color:#f0cf78;border:2px solid #f0cf78;font-weight:800">🙈 HIDE</button></div>
  <div class="dj-rotate">📱↔️ <span>Rotate your phone sideways — you get the full DJ console, all four tables in a row like the desktop.</span></div>
  <div class="dj-setups" style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:12px"><span style="font:700 14px var(--body);color:var(--muted);letter-spacing:.12em;align-self:center">SETUPS:</span><button class="btn ghost sm" type="button" data-preset="loud">🔊 Loud &amp; Clear</button><button class="btn ghost sm" type="button" data-preset="radio">🏆 Pro Radio</button><button class="btn ghost sm" type="button" data-preset="club">🔥 Club</button><button class="btn ghost sm" type="button" data-preset="scratch">🎺 Scratch Session</button><button class="btn ghost sm" type="button" data-preset="chop">⚡ Transformer</button><button class="btn ghost sm" type="button" data-pop>⛶ Pop out — own screen</button></div>
  <div class="dj-screen" id="dj-screen">
    <small>📺 MASTER SCREEN — MUSIC VIDEO · VIEWERS SEE THIS SCREEN LIVE</small>
    <div class="vstage" id="dj-vstage"><div class="vslot" id="dj-vs1"></div><div class="vslot" id="dj-vs2"></div><div class="vstandby" id="dj-vstandby">No music video on a deck right now — put a YouTube video on any deck and it plays here, mixed live.</div><div class="vchip" id="dj-vchip" hidden></div><div id="dj-camwrap" class="novid"><video id="dj-camvid" autoplay muted playsinline></video><div id="dj-camph">Camera on at the booth</div><span id="dj-camtag">📷 LIVE CAM</span><div id="dj-cambanner" hidden></div></div><svg width="0" height="0" style="position:absolute" aria-hidden="true"><defs><filter id="mw-sharp" x="-10%" y="-10%" width="120%" height="120%"><feConvolveMatrix id="mw-sharp-k" order="3" kernelMatrix="0 0 0 0 1 0 0 0 0" preserveAlpha="true"/></filter><filter id="mw-duo" x="0" y="0" width="100%" height="100%"><feColorMatrix type="matrix" values="0.33 0.33 0.33 0 0 0.33 0.33 0.33 0 0 0.33 0.33 0.33 0 0 0 0 0 1 0"/><feComponentTransfer><feFuncR type="table" tableValues="0.043 0.941"/><feFuncG type="table" tableValues="0.035 0.812"/><feFuncB type="table" tableValues="0.027 0.471"/></feComponentTransfer></filter></defs></svg></div>
    <div class="vmixrow" id="dj-vskiprow"><button class="btn ghost sm" type="button" id="dj-vskip" data-vskip disabled>⏭ Skip — end this song, roll the next</button></div>
    <div id="dj-studio" hidden><div class="studio-hd"><b>🎬 STUDIO — CROP YOUR SCREEN</b><span class="muted">what you frame here is exactly what everyone sees</span><span style="flex:1"></span><button class="btn ghost sm" type="button" data-studiofit>🖼 Frame: Fit</button><button class="btn ghost sm" type="button" data-studioreset>Reset crop</button></div><div class="studio-sl"><label>Left <input type="range" min="0" max="45" step="1" value="0" data-crop="l"><span data-cropv="l">0%</span></label><label>Right <input type="range" min="0" max="45" step="1" value="0" data-crop="r"><span data-cropv="r">0%</span></label><label>Top <input type="range" min="0" max="45" step="1" value="0" data-crop="t"><span data-cropv="t">0%</span></label><label>Bottom <input type="range" min="0" max="45" step="1" value="0" data-crop="b"><span data-cropv="b">0%</span></label></div></div>
    <div class="vmixrow"><button class="btn ghost sm" type="button" data-vmix="auto">🔀 Auto · follow fader</button><button class="btn ghost sm" type="button" data-vmix="cut">✂️ Cut</button><button class="btn ghost sm" type="button" data-vmix="fade">🌫️ Fade</button><button class="btn ghost sm" type="button" data-cam id="dj-cambtn">📷 Cam</button><button class="btn ghost sm" type="button" data-vlive id="dj-vlivebtn">📹 Live Video</button><span style="flex:1"></span><button class="btn ghost sm" type="button" data-vsrc="A">A</button><button class="btn ghost sm" type="button" data-vsrc="B">B</button><button class="btn ghost sm" type="button" data-vsrc="C">C</button><button class="btn ghost sm" type="button" data-vsrc="D">D</button></div>
  </div>
  <div class="dj-panel" id="dj-edit">
    <h4>🎬 VIDEO &amp; AUDIO EDITING</h4>
    <div class="edgrid">
      <div>
        <small>📺 VIDEO — THE MASTER PICTURE · EVERYONE SEES IT</small>
        <label>Brightness <span id="djx-vb-v">100%</span></label><input type="range" id="djx-vb" min="0.5" max="1.5" step="0.01" value="1" aria-label="Master video brightness">
        <label>Contrast <span id="djx-vc-v">100%</span></label><input type="range" id="djx-vc" min="0.5" max="1.5" step="0.01" value="1" aria-label="Master video contrast">
        <label>Saturation <span id="djx-vs-v">100%</span></label><input type="range" id="djx-vs" min="0" max="2" step="0.01" value="1" aria-label="Master video saturation">
        <label>Zoom <span id="djx-vz-v">100%</span></label><input type="range" id="djx-vz" min="1" max="1.6" step="0.01" value="1" aria-label="Master video zoom">
        <div style="margin-top:9px"><button class="btn ghost sm" type="button" id="djx-vreset">↺ Reset picture</button></div>
      </div>
      <div>
        <small>🔊 AUDIO — THE MASTER SOUND · SAME KNOBS AS THE MIXER</small>
        <label>Boost <span id="djx-boost-v">100%</span></label><input type="range" id="djx-boost" min="1" max="2" step="0.01" value="1" aria-label="Volume boost">
        <label>Filter</label><input type="range" id="djx-filter" min="0" max="100" step="1" value="100" aria-label="Master filter">
        <label>Echo</label><input type="range" id="djx-echo" min="0" max="0.6" step="0.02" value="0" aria-label="Echo level">
        <label>Echo repeat</label><input type="range" id="djx-fb" min="0" max="0.7" step="0.02" value="0.34" aria-label="Echo repeat">
        <label>Reverb</label><input type="range" id="djx-verb" min="0" max="0.7" step="0.02" value="0" aria-label="Reverb level">
        <label>Flanger</label><input type="range" id="djx-fla" min="0" max="1" step="0.02" value="0" aria-label="Flanger level">
        <label>Phaser</label><input type="range" id="djx-pha" min="0" max="1" step="0.02" value="0" aria-label="Phaser level">
        <label>Noise sweep</label><input type="range" id="djx-noise" min="0" max="1" step="0.02" value="0" aria-label="Noise sweep level">
        <label>Grit (crush)</label><input type="range" id="djx-crush" min="0" max="100" step="1" value="0" aria-label="Bitcrush grit">
      </div>
    </div>
  </div>
  <div class="mixer xfbar" id="dj-xfbar">
      <div class="xfrow"><div class="xfvols"><div class="xv" data-xv="A" style="--dk:#f0cf78" title="Deck A volume — drag up or down, double-tap for 90%"><i></i><span>VOL A</span><b>90%</b></div><div class="xv" data-xv="B" style="--dk:#38bdf8" title="Deck B volume — drag up or down, double-tap for 90%"><i></i><span>VOL B</span><b>90%</b></div></div><div class="xfpad big" id="dj-xfpad" tabindex="0" title="The X fader rides between the pairs — slide left for decks A+B, right for C+D; all the way over gives that pair 100% and silences the other. Center is both pairs full. Double-tap to center."><span class="xfpl tl">A</span><span class="xfpl tr">B</span><span class="xfpl bl">C</span><span class="xfpl br">D</span><div class="xfdot" id="dj-xfdot"></div></div><div class="xfvols"><div class="xv" data-xv="C" style="--dk:#4ade80" title="Deck C volume — drag up or down, double-tap for 90%"><i></i><span>VOL C</span><b>90%</b></div><div class="xv" data-xv="D" style="--dk:#f472b6" title="Deck D volume — drag up or down, double-tap for 90%"><i></i><span>VOL D</span><b>90%</b></div></div></div>
      <small>✕ THE X FADER — slide the dot anywhere in the X: the corners are the decks, the center is all even. It has complete control of all four volumes, and the master screen up top blends with it</small>
      <div style="display:flex;gap:8px;align-items:center;justify-content:center"><small id="dj-pan-read" style="letter-spacing:.02em">A 100% · B 100% · C 100% · D 100%</small><button class="btn ghost sm" type="button" id="dj-pan-center">◎ CENTER</button></div>
      <div class="xfcurve" role="group" aria-label="Crossfader curve"><span>CURVE</span><button type="button" data-xfc="smooth">Smooth</button><button type="button" data-xfc="sharp">Sharp</button><button type="button" data-xfc="cut">Cut</button></div>
  </div>
  <div id="dj-phset" data-n="1"><div class="phrow"><span class="phlab">📱 SETUP</span><button type="button" data-phn="1" class="on">1 DECK</button><button type="button" data-phn="2">2</button><button type="button" data-phn="3">3</button><button type="button" data-phn="4">4</button></div><div class="phrow" id="dj-phdeck"><span class="phlab">DECK</span><button type="button" data-phd="A" class="on">A<i class="phdot"></i></button><button type="button" data-phd="B">B<i class="phdot"></i></button><button type="button" data-phd="C">C<i class="phdot"></i></button><button type="button" data-phd="D">D<i class="phdot"></i></button></div></div>
  <div class="dj-decks" data-show="C" data-phn="1">
    ${deckHTML("A")}
    ${deckHTML("B")}
    <div class="mixer m1">
      <small>MIC DROP</small>
      <button class="talk" type="button" id="dj-talk" aria-label="Hold to talk">🎙️<br>HOLD TO TALK</button>
      <small id="dj-talk-st">Hold, talk, let go — it goes out over the music</small>
      <small>BEAT ENGINE</small>
      

      <label style="display:flex;gap:6px;align-items:center;font-size:15px;color:var(--muted);text-align:left"><input type="checkbox" id="dj-quant" checked style="width:auto"> Quantize — cues &amp; loops snap to the beat</label>
      <label style="display:flex;gap:6px;align-items:center;font-size:15px;color:var(--muted);text-align:left">Jog feel <select id="dj-jogf" aria-label="Jog wheel feel"><option value="0.05">Light</option><option value="0.09">Standard</option><option value="0.14">Heavy</option></select> — how far a scratch drag moves the song</label>
      <label style="display:flex;gap:6px;align-items:center;font-size:15px;color:var(--muted);text-align:left"><input type="checkbox" id="dj-fxsync" checked style="width:auto"> Effects follow the live tempo</label>
      <canvas class="pairwave" id="pw-AB" width="480" height="72"></canvas>
      <small id="ph-AB" style="letter-spacing:0;text-transform:none">Phase meter: play both decks with a measured BPM and this shows how far apart the beats sit.</small>
      <small>MASTER</small><input type="range" min="0" max="1" step="0.01" value="0.95" id="dj-master" aria-label="Master volume">
      <small>🔊 BOOST — EVERYONE HEARS IT · <span id="dj-boost-v">100%</span></small><input type="range" min="1" max="2" step="0.01" value="1" id="dj-boost" aria-label="Volume boost">
      <small>FILTER</small><input type="range" min="0" max="100" step="1" value="100" id="dj-filter" aria-label="Master filter">
      <small>ECHO</small><input type="range" min="0" max="0.6" step="0.02" value="0" id="dj-echo" aria-label="Echo level">
      <small>ECHO REPEAT</small><input type="range" min="0" max="0.7" step="0.02" value="0.34" id="dj-fb" aria-label="Echo repeat">
      <div style="display:flex;gap:4px;align-items:center;flex-wrap:wrap"><small>ECHO BEATS</small><button class="btn ghost sm edivb" type="button" data-ediv="0.25">¼</button><button class="btn ghost sm edivb" type="button" data-ediv="0.5">½</button><button class="btn ghost sm edivb" type="button" data-ediv="0.75">¾</button><button class="btn ghost sm edivb" type="button" data-ediv="1">1</button><button class="btn ghost sm edivb" type="button" data-ediv="2">2</button></div>
      <small>REVERB</small><input type="range" min="0" max="0.7" step="0.02" value="0" id="dj-verb" aria-label="Reverb level">
      <small>FLANGER</small><input type="range" min="0" max="1" step="0.02" value="0" id="dj-fla" aria-label="Flanger level">
      <small>PHASER</small><input type="range" min="0" max="1" step="0.02" value="0" id="dj-pha" aria-label="Phaser level">
      <small>NOISE</small><input type="range" min="0" max="1" step="0.02" value="0" id="dj-noise" aria-label="Noise sweep level">
      <small>TRANSFORMER (CHOP)</small><div style="display:flex;gap:5px;justify-content:center"><button class="btn ghost sm gatebtn on" type="button" data-gate="0">OFF</button><button class="btn ghost sm gatebtn" type="button" data-gate="2">SLOW</button><button class="btn ghost sm gatebtn" type="button" data-gate="4">MED</button><button class="btn ghost sm gatebtn" type="button" data-gate="8">FAST</button></div></div>
  
    <div class="mixer m2"><small>DECKS C / D</small>
      <canvas class="pairwave" id="pw-CD" width="480" height="72"></canvas>
      <small id="ph-CD" style="letter-spacing:0;text-transform:none">Phase meter for decks C and D.</small>
      <input type="range" min="0" max="100" step="1" value="0" id="dj-crush" aria-label="Bitcrush grit">
      <small style="letter-spacing:0;text-transform:none"></small></div>
  <div class="swapbar"><button class="btn sm on" type="button" data-swap="1:C">🎧 DECK C</button><button class="btn ghost sm" type="button" data-swap="1:M">🎚️ MIXER</button><button class="btn ghost sm" type="button" data-swap="1:D">🎧 DECK D</button></div>
  
    ${deckHTML("C")}
    ${deckHTML("D")}

</div>
  <div class="dj-panel" id="dj-browser" style="margin-top:16px">
    <div style="border:1.5px solid var(--gold-lo);border-radius:14px;padding:14px;margin-bottom:12px;background:rgba(240,207,120,.04)"><span style="display:flex;justify-content:space-between;align-items:center;gap:8px"><b style="font-size:20px;letter-spacing:.06em">🎬 VIDEO SEARCH — MUSIC VIDEOS FROM EVERYWHERE</b><button class="btn ghost sm" type="button" data-fold="yt-body" aria-label="Fold the video panel">▾</button></span><div id="yt-body"><small class="muted" style="display:block;margin:6px 0 10px;font-size:13px">Search YouTube or the Internet Archive, or paste a link (YouTube and Vimeo both work) — put the video on a deck and mix it: play, pause, seek and the X fader volume all work, and your listeners see it on the master screen. Video sites keep their audio locked in their own players, so EQ, effects and scratch stay on your own files. Archive videos load as real files — full deck control on those.</small><div style="display:flex;gap:6px;flex-wrap:wrap;align-items:center"><input type="text" id="dj-yt" placeholder="Paste a video link — YouTube or Vimeo..." style="flex:1;min-width:220px;font-size:16px;padding:12px" aria-label="Video link"><span style="font-size:13px;color:var(--muted)">Load on:</span><button class="btn ghost" type="button" data-ytload="A">A</button><button class="btn ghost" type="button" data-ytload="B">B</button><button class="btn ghost" type="button" data-ytload="C">C</button><button class="btn ghost" type="button" data-ytload="D">D</button><button class="btn ghost" type="button" data-ytqueue="1">＋Q</button></div><div style="display:flex;gap:6px;margin-top:12px;flex-wrap:wrap"><button class="btn sm vtab" type="button" data-vtab="yt">▶ YouTube</button><button class="btn ghost sm vtab" type="button" data-vtab="ia">🎞 Archive videos</button></div><form class="dj-search" id="dj-ytform" style="margin-top:8px;display:flex;gap:8px"><input type="search" id="dj-ytq" placeholder="Search — any artist, any song..." aria-label="Search videos" style="flex:1;font-size:17px;padding:13px"><button class="btn" type="submit" style="font-size:16px;padding:13px 22px">Search</button></form><div class="dj-list" id="dj-ytres" style="max-height:430px;margin-top:10px"></div></div></div>
    <div style="border:1.5px solid var(--gold-lo);border-radius:14px;padding:14px;margin-bottom:12px;background:rgba(240,207,120,.04)"><span style="display:flex;justify-content:space-between;align-items:center;gap:8px"><b style="font-size:20px;letter-spacing:.06em">🎶 UP NEXT — YOUR QUEUE</b><button class="btn ghost sm" type="button" data-fold="queue-body" aria-label="Fold the queue">▾</button></span><div id="queue-body"><small class="muted" style="display:block;margin:6px 0 10px;font-size:13px">Add songs and videos with ＋Q anywhere in the picker. When a deck finishes, the next one in line loads on the open deck and plays — straight through the list. Save the list as a playlist to run it again any time, or put a playlist on the schedule below.</small><div class="dj-list" id="dj-queue" style="max-height:260px"></div><div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:10px"><button class="btn sm" type="button" data-qact="play">▶ Play the queue</button><button class="btn ghost sm" type="button" data-qact="save">💾 Save as playlist</button><button class="btn ghost sm" type="button" data-qact="open">📂 Playlists</button><button class="btn ghost sm" type="button" data-qact="clear">🗑 Clear</button></div><div id="dj-playlists" style="margin-top:6px"></div></div></div>
    <div style="border:1.5px solid var(--gold-lo);border-radius:14px;padding:14px;margin-bottom:12px;background:rgba(240,207,120,.04)"><span style="display:flex;justify-content:space-between;align-items:center;gap:8px"><b style="font-size:20px;letter-spacing:.06em">📅 SCHEDULE — WHAT PLAYS WHEN</b><button class="btn ghost sm" type="button" data-fold="sched-body" aria-label="Fold the schedule">▾</button></span><div id="sched-body"><small class="muted" style="display:block;margin:6px 0 10px;font-size:13px">Pick a time and one of your playlists. Every day at that time the station switches to that list and plays it through in order — even while the booth is closed. Videos in a list play while the booth is open; with the booth closed the list runs its songs and files.</small><div id="dj-sched-list"></div><div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:10px;align-items:center"><input type="time" id="sched-time" style="padding:9px;font-size:15px" aria-label="Time of day"><select id="sched-sel" style="padding:9px;font-size:15px;flex:1;min-width:160px" aria-label="Playlist"></select><button class="btn sm" type="button" data-sched="add">＋ Add</button></div></div></div>
    <div style="display:flex;gap:6px;flex-wrap:wrap;align-items:center"><h4 style="margin:0 6px 0 0">🎵 MUSIC — PICK &amp; LOAD, NO SCROLLING</h4><button class="btn ghost sm" type="button" data-fold="br-panes" aria-label="Fold the music lists">▾</button>
      <button class="btn sm browtab on" type="button" data-brow="lib">Your Library</button>
      <button class="btn ghost sm browtab" type="button" data-brow="net">Free Music Search</button>
      <button class="btn ghost sm browtab" type="button" data-brow="cur">🏆 Pro DJ Sounds</button>
      <button class="btn ghost sm browtab" type="button" data-brow="prep">⭐ Prepare</button>
      <button class="btn ghost sm browtab" type="button" data-brow="free">🆓 Free Shelf</button></div>
    <div id="br-panes">
    <div data-browpane="lib"><input type="search" id="dj-libq" placeholder="Filter your library — type a title..." aria-label="Filter your library" style="width:100%;margin-bottom:8px"><div class="dj-list" id="dj-lib" style="max-height:300px"></div></div>
    <div data-browpane="net" hidden><form class="dj-search" id="dj-sf"><input type="search" id="dj-q" placeholder="Search: hip hop, jazz, beats..." aria-label="Search free music"><button class="btn sm" type="submit">Search</button></form>
      <small class="muted">Creative Commons music from the Internet Archive, free to play on your station.</small><div class="dj-list" id="dj-net" style="max-height:260px"></div></div>
    <div data-browpane="cur" hidden><small class="muted">Hand-picked DJ sounds from the most-downloaded free packs on the Internet Archive, every one verified playable. ▶ hears it in the booth; a deck letter loads it on that table so it goes out over the radio.</small><div class="dj-list" id="dj-cur" style="max-height:300px"></div></div>
    <div data-browpane="prep" hidden><small class="muted">Your prepare crate and the booth's memory: star songs in Your Library to line them up here; History is what the booth loaded lately — tap a deck letter to load it again.</small><b style="font-size:15px;letter-spacing:.1em;display:block;margin:6px 0 4px">⭐ PREPARE</b><div class="dj-list" id="dj-prep" style="max-height:220px"></div><b style="font-size:15px;letter-spacing:.1em;display:block;margin:10px 0 4px">🕘 HISTORY</b><div class="dj-list" id="dj-hist" style="max-height:220px"></div></div>
    <div data-browpane="free" hidden><small class="muted">Free music and music videos from the Internet Archive — public domain and Creative Commons, legal to play on the station, every file verified. Tap a deck letter to put it straight on that table. They load as real files, so EQ, FX and scratch all work on them.</small><b style="font-size:15px;letter-spacing:.1em;display:block;margin:6px 0 4px">🎵 FREE MUSIC</b><div class="dj-list" id="dj-freem" style="max-height:300px"></div><b style="font-size:15px;letter-spacing:.1em;display:block;margin:10px 0 4px">🎬 FREE VIDEOS</b><div class="dj-list" id="dj-freev" style="max-height:300px"></div></div>
    </div>
  </div>
    <div class="dj-grid2">
    <div class="dj-panel"><h4>🎤 LIVE MIC</h4>
      <div style="display:flex;gap:8px;flex-wrap:wrap"><button class="btn sm" type="button" id="mic-on">Open the mic</button><button class="btn ghost sm" type="button" id="mic-mon">🔇 Monitor off</button></div>
      <div class="micmeter"><i id="mic-lvl"></i></div>
      <label style="display:flex;gap:8px;align-items:center;font-size:17.5px"><input type="checkbox" id="mic-duck" checked style="width:auto"> Auto-duck the music while I talk (radio style)</label>
      <small class="muted">Your live mic feeds the show recording. To talk TO the listeners, use the big HOLD TO TALK button — it sends your voice out over the mix.</small></div>
    <div class="dj-panel"><h4>🔊 JINGLE / SPOT BOARD</h4>
      <div class="pads" id="dj-pads"></div>
      <small class="muted">Built-in station sounds first, then your own drops — tap an empty pad to record up to 8 seconds. ▶ plays it in the booth, 📡 sends it out over the air.</small></div>
    <div class="dj-panel"><h4>⏺️ RECORD THE SHOW</h4>
      <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap"><button class="btn sm" type="button" id="rec-btn">⏺ Start recording</button><span id="rec-st" class="muted" style="font-size:16.5px">Captures the full mix + your mic.</span></div>
      <div id="rec-out"></div>
      <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-top:10px;border-top:1px solid var(--line);padding-top:10px"><button class="btn ghost sm" type="button" id="ses-btn">🎬 Record the session (video)</button><span id="ses-st" class="muted" style="font-size:16.5px">Films this tab — the music videos, the decks, everything — with the full mix sound. Pick this tab and tick “share tab audio”.</span></div>
      <div id="ses-out"></div></div>
    <div class="dj-panel"><h4>🤖 AUTO-DJ</h4>
      <label style="display:flex;gap:8px;align-items:center;font-size:17.5px"><input type="checkbox" id="ad-on" style="width:auto" checked> Auto-DJ runs the station: when a song ends, crossfade to the next one — your queue first, then the full library on rotation</label>
      <div class="dj-list" id="ad-queue" style="max-height:150px"></div>
      <small class="muted">Add songs with the ＋Q button in Your Library. Works while you're live — the station never goes quiet.</small>
      <label style="display:flex;gap:8px;align-items:center;font-size:17.5px;margin-top:10px"><input type="checkbox" id="ad-drops" style="width:auto" checked> 🎙 Station drops: every 3rd song change, the station speaks ONE line from the rotation below — in the server male voice, over the join, instead of the pad ID</label>
      <div class="dj-list" id="ad-drops-list" style="max-height:120px"></div></div>
    <div class="dj-panel"><h4>🎛️ LIVE DJ REQUESTS</h4><div id="djguest-now"><small class="muted">No guest DJ on the tables right now.</small></div><div class="dj-list" id="djreq-list" style="max-height:180px"></div></div>
    <div class="dj-panel"><h4>⚔️ BATTLES</h4><div id="battle-box"><small class="muted">Loading…</small></div><small class="muted" style="display:block;margin-top:6px">Battles run from your open booth — if the booth closes mid-battle, the battle state stays but the turns stop advancing.</small></div>
    <div class="dj-panel" id="dj-campro" hidden><h4>📷 CAMERA PRO</h4>
      <div class="cp-sec"><span class="cp-lab">LOOKS — TAP ONE, THEN DIAL IT IN BELOW</span><div class="cp-chips" id="cp-looks"></div></div>
      <div class="cp-sec"><span class="cp-lab">ADJUST</span>
        <label class="cp-row">Brightness <span id="cp-b-v">100%</span></label><input type="range" id="cp-b" min="0.5" max="1.5" step="0.01" value="1" aria-label="Camera brightness">
        <label class="cp-row">Contrast <span id="cp-c-v">100%</span></label><input type="range" id="cp-c" min="0.5" max="1.5" step="0.01" value="1" aria-label="Camera contrast">
        <label class="cp-row">Saturation <span id="cp-s-v">100%</span></label><input type="range" id="cp-s" min="0" max="2" step="0.01" value="1" aria-label="Camera saturation">
        <label class="cp-row">Warmth <span id="cp-warm-v">0</span></label><input type="range" id="cp-warm" min="-50" max="50" step="1" value="0" aria-label="Camera warmth">
        <label class="cp-row">Detail (sharpen) <span id="cp-detail-v">0%</span></label><input type="range" id="cp-detail" min="0" max="100" step="1" value="0" aria-label="Camera detail sharpening">
      </div>
      <div class="cp-sec"><span class="cp-lab">FRAME</span>
        <label class="cp-row">Zoom <span id="cp-zoom-v">1×</span></label><input type="range" id="cp-zoom" min="1" max="2.5" step="0.01" value="1" aria-label="Camera zoom">
        <div class="cp-chips" style="margin-top:8px"><button type="button" class="cp-chip" id="cp-mirror">🪞 Mirror: ON</button><button type="button" class="cp-chip" id="cp-recenter">◎ Re-center</button></div>
        <small class="muted" style="display:block;margin-top:6px">Zoom in, then drag on the camera picture itself to reframe. What you see is exactly what viewers get.</small>
      </div>
      <div class="cp-sec"><span class="cp-lab">BACKGROUND</span><div class="cp-chips" id="cp-bgs"></div>
        <label class="cp-row">Blur strength <span id="cp-blur-v">16px</span></label><input type="range" id="cp-blur" min="4" max="40" step="1" value="16" aria-label="Background blur strength">
        <label class="cp-row">Edge smoothness <span id="cp-edge-v">1.6</span></label><input type="range" id="cp-edge" min="0.8" max="3.2" step="0.1" value="1.6" aria-label="Background edge smoothness">
        <input type="file" id="dj-cambg-file" accept="image/*" hidden>
      </div>
      <div class="cp-sec"><span class="cp-lab">BANNER — YOUR NAME ACROSS THE BOTTOM</span>
        <label style="display:flex;gap:8px;align-items:center;font-size:17.5px"><input type="checkbox" id="cp-banner-on" style="width:auto"> Show the banner on my camera — viewers see it in their square too</label>
        <input type="text" id="cp-banner-text" maxlength="42" value="DJ MEECHIE — LIVE" aria-label="Banner text" style="width:100%;margin-top:8px">
      </div>
      <small class="muted" style="display:block;margin-top:12px">The background engine warms up the moment your camera turns on, so tapping a background never stalls the music. On a phone that cannot keep up, the picture analysis steps down a size on its own — the edge stays clean and the song never skips.</small>
    </div>
    <div class="dj-panel"><h4>📥 REQUESTS &amp; DROPS</h4><div class="dj-list" id="rq-list" style="max-height:220px"><small class="muted">Nothing yet. Listener requests land here.</small></div></div>
    <div class="dj-panel"><h4>🎹 MIDI CONTROLLER</h4>
      <div class="hint" id="dj-midi-stat">Plug any DJ controller into this device by USB, then tap Enable MIDI. Tap LEARN on a row and move the knob, button or jog wheel that should own it — the mapping saves on this device.</div>
      <div class="row wrap"><button class="btn sm" type="button" id="dj-midi-on">🎹 Enable MIDI</button><button class="btn ghost sm" type="button" id="dj-midi-wake">🔆 Keep screen on: off</button><button class="btn ghost sm" type="button" id="dj-midi-clear">Clear mapping</button></div>
      <div class="midilist" id="dj-midi-list"></div>
    </div>
    <div class="dj-panel"><h4>📜 PROGRAM LOG</h4><div class="loglist" id="dj-log"></div>
      <label style="display:grid;gap:4px;font-size:15px;color:var(--muted)">Station ticker (shows on the station card for everyone)<input type="text" id="dj-ticker-in" maxlength="140" placeholder="e.g. Taking requests all night — drop yours below!"></label>
      <button class="btn ghost sm" type="button" id="dj-ticker-set" style="justify-self:start">Set ticker</button></div>
    <div class="dj-panel" id="dj-door"><h4>🚪 THE DOOR</h4><div class="dj-list" id="door-list" style="max-height:280px"><small class="muted">Watching the door — people who come on the site while your booth is open land here.</small></div><small class="muted" style="display:block;margin-top:6px">👋 Greet welcomes them on their own screen. 🎙 Shout calls their name out over the station for the whole room.</small><div class="door-row" style="margin-top:8px"><span>🔔 <b>Doorbell</b> <small id="door-bell-state">a push to your phone the second someone lands</small></span><span class="door-acts"><button class="btn sm" type="button" id="door-bell">🔔 Turn on</button></span></div></div>
  </div>
</div>`;
  // the booth moves into its own DJ view — its own section, nothing but DJing
  const boothEl = document.getElementById("dj-owner"), boothHome = document.getElementById("dj-booth-root");
  if (boothEl && boothHome) boothHome.appendChild(boothEl);
  // the mini master screen: one floating rectangle on every page, so the live
  // music video follows viewers around the whole site (never in the Playground)
  if (SANDBOX) { const gl = document.querySelector("#dj-golive"); if (gl && gl.closest(".dj-live")) gl.closest(".dj-live").lastChild.textContent = " Practice set (never on air)"; }
  if (!SANDBOX && !document.getElementById("dj-livealert")) { const la = document.createElement("div"); la.id = "dj-livealert"; la.hidden = true; la.innerHTML = "<span class='la-txt'>🔴 LIVE NOW</span><span class='la-btns'><button type='button' class='btn sm' id='la-tune'>🎧 Tune in</button><button type='button' class='btn ghost sm' id='la-watch'>👀 Watch the setup</button><button type='button' class='btn ghost sm' id='la-shop'>🛍️ Shop</button><button type='button' class='btn ghost sm' id='la-x' aria-label='Dismiss'>✕</button></span>"; document.body.appendChild(la); const laDismiss = () => { try { sessionStorage.setItem("mw-la-dismiss", la.dataset.set || "x"); } catch (_) {} la.hidden = true; }; la.querySelector("#la-x").addEventListener("click", laDismiss); la.querySelector("#la-shop").addEventListener("click", () => { laDismiss(); if (typeof go === "function") go("shop"); }); la.querySelector("#la-tune").addEventListener("click", () => { try { cutOtherAudio(); } catch (_) {} document.querySelectorAll("video").forEach((v) => { try { v.pause(); } catch (_) {} }); startListening(); la.hidden = true; if (typeof go === "function") go(vsBroadcast() && !(S.vstream || {}).hidden ? "mwtv" : "radio"); }); la.querySelector("#la-watch").addEventListener("click", () => { try { cutOtherAudio(); } catch (_) {} document.querySelectorAll("video").forEach((v) => { try { v.pause(); } catch (_) {} }); startListening(); la.hidden = true; if (typeof go === "function") go("watch"); }); setInterval(() => { try { paintLiveAlert(); } catch (_) {} }, 20000); }
  if (!SANDBOX && !document.getElementById("dj-mini")) { const mn = document.createElement("div"); mn.id = "dj-mini"; mn.hidden = true; mn.innerHTML = "<div class='mn-bar'><span>📺 MASTER — LIVE VIDEO</span><button type='button' id='mn-pop' aria-label='Pop the master screen out big on MW TV'>⤢</button><button type='button' id='mn-close' aria-label='Hide the mini screen'>✕</button></div><div class='vstage'><div class='vslot' id='mn-vs1'></div><div class='vslot' id='mn-vs2'></div><div class='mw-camov' id='mw-camov' hidden><img id='mw-camov-img' alt='' draggable='false'><span class='mw-camov-tag'>📷 MEECHIE</span><button type='button' id='mw-camov-x' aria-label='Hide the camera square'>✕</button></div></div><div class='mn-grip' id='mn-grip' title='Drag to resize the screen'></div>"; document.body.appendChild(mn); mn.querySelector("#mn-close").addEventListener("click", () => { try { sessionStorage.setItem("mw_mini_off", "1"); } catch (_) {} mn.hidden = true; try { if (window.MW_vsDismiss) window.MW_vsDismiss(); } catch (_) {} }); mn.querySelector("#mn-pop").addEventListener("click", () => { if (typeof go === "function") go("mwtv"); });
    // the mini screen is DRAGGABLE by its title bar (owner directive 2026-10-26:
    // "make the music video screen moveable") — drag it anywhere; the spot is
    // remembered per device and restored on every page
    const mnBar = mn.querySelector(".mn-bar");
    // PHONE DOCKED SCREEN (owner, 2026-10-30): on phone widths the mini is
    // not a floating pop-up at all — the CSS docks the same one box full
    // width under the site header, in the same spot on every tab, and the
    // drag / resize / re-place machinery below simply never engages there
    const mnPhone = () => { try { return matchMedia("(max-width:760px)").matches; } catch (_) { return false; } };
    const mnPlace = (x, y) => { const w = mn.offsetWidth || 208, h = mn.offsetHeight || 140; x = Math.max(2, Math.min(Math.round(x), Math.max(2, innerWidth - w - 2))); y = Math.max(2, Math.min(Math.round(y), Math.max(2, innerHeight - h - 2))); mn.style.left = x + "px"; mn.style.top = y + "px"; mn.style.right = "auto"; };
    try { const p = JSON.parse(localStorage.getItem("mw-mini-pos") || "null"); if (p && typeof p.x === "number" && typeof p.y === "number") mnPlace(p.x, p.y); } catch (_) {}
    // and RESIZEABLE by its corner grip (owner, 2026-10-27): drag the corner
    // to make the little screen bigger or smaller; the size is remembered
    // per device, and the stage keeps its 16:9 shape on its own
    const mnGrip = mn.querySelector(".mn-grip");
    // As big as it wants (owner, 2026-10-28): no artificial cap — the
    // mini can grow to the full viewport width. Where the screen is wider
    // than it is tall, the height caps it instead: the 16:9 stage plus its
    // title bar must fit the viewport height, so the whole box (grip
    // included) always stays reachable on screen. The saved width routes
    // through mnSize too, so a huge desktop size is re-clamped to a small
    // phone viewport on load instead of stranding off-screen.
    const mnMaxW = () => Math.max(140, Math.min(innerWidth, (innerHeight - 30) * 16 / 9));
    const mnSize = (w) => { w = Math.max(140, Math.min(Math.round(w), mnMaxW())); mn.style.width = w + "px"; return w; };
    try { localStorage.removeItem("mw-mini-w"); } catch (_) {} // owner (2026-10-29): the pop-out opens at its regular size on every visit — a size dragged in an earlier session never carries over; the saved POSITION still restores (mnPlace above) and resizing still works freely within the visit
    if (mnGrip) mnGrip.addEventListener("pointerdown", (e) => { if (mnPhone()) return; e.preventDefault(); e.stopPropagation(); const sx = e.clientX, sw = mn.getBoundingClientRect().width; try { mnGrip.setPointerCapture(e.pointerId); } catch (_) {} const mv = (ev) => mnSize(sw + (ev.clientX - sx)); const up = () => { mnGrip.removeEventListener("pointermove", mv); mnGrip.removeEventListener("pointerup", up); mnGrip.removeEventListener("pointercancel", up); const r2 = mn.getBoundingClientRect(); mnPlace(r2.left, r2.top); }; mnGrip.addEventListener("pointermove", mv); mnGrip.addEventListener("pointerup", up); mnGrip.addEventListener("pointercancel", up); });
    mnBar.addEventListener("pointerdown", (e) => { if (e.target.closest("#mn-close") || e.target.closest("#mn-pop")) return; if (mnPhone()) return; e.preventDefault(); const r = mn.getBoundingClientRect(), dx = e.clientX - r.left, dy = e.clientY - r.top; try { mnBar.setPointerCapture(e.pointerId); } catch (_) {} mn.classList.add("mn-drag"); const mv = (ev) => mnPlace(ev.clientX - dx, ev.clientY - dy); const up = () => { mnBar.removeEventListener("pointermove", mv); mnBar.removeEventListener("pointerup", up); mnBar.removeEventListener("pointercancel", up); mn.classList.remove("mn-drag"); delete mn.dataset.mnDock; try { const r2 = mn.getBoundingClientRect(); localStorage.setItem("mw-mini-pos", JSON.stringify({ x: Math.round(r2.left), y: Math.round(r2.top) })); } catch (_) {} }; mnBar.addEventListener("pointermove", mv); mnBar.addEventListener("pointerup", up); mnBar.addEventListener("pointercancel", up); }); addEventListener("resize", () => { if (mnPhone()) return; const r = mn.getBoundingClientRect(); if (!r.width) return; mnSize(r.width); mnPlace(r.left, r.top); }); }
  // Malik's rule: the pick-a-song browser sits at the TOP of the booth, above the
  // decks — on wide screens the console grid still parks it at the top of the
  // middle column; everywhere else it now leads the booth instead of hiding
  // below all four decks
  const brEl = document.getElementById("dj-browser"), dkEl = boothEl && boothEl.querySelector(".dj-decks");
  // the master screen rides directly above the deck row (owner, voice call
  // 2026-10-29: a big widescreen TV above the decks) — the block moves as
  // one, skip row and Customize unit included; every id inside it is
  // untouched, so renderScreen and the vmix machinery never notice
  const scrEl = document.getElementById("dj-screen"); if (scrEl && dkEl) dkEl.before(scrEl);
  // BOOTH PLACEMENTS (owner, voice call 2026-10-29): the browser becomes
  // the search + queue BAND - it moves in directly under the master
  // screen and directly above the decks, where the wide space lets the
  // search breathe; the placements CSS lays its faces out wide there.
  if (brEl && dkEl) dkEl.before(brEl);
  // the X fader cluster (the pad, the ABCD pad and the deck volume
  // knobs) leaves the top zone and moves INTO the deck bank, between
  // the B and C decks - the center column between the pairs at every
  // width. Same element, same ids: paintXfPads, the knob and pad
  // handlers and the fader law never notice the move.
  const xfEl = document.getElementById("dj-xfbar"); if (xfEl && dkEl) { const dC = dkEl.querySelector('.deck[data-deck="C"]'); if (dC) dkEl.insertBefore(xfEl, dC); else dkEl.appendChild(xfEl); }
  // MASTER FX strip (owner ask, 2026-10-26): the FX slider stack leaves the
  // center mixer — it ran long with empty space beside it — and becomes a
  // full-width panel under the console, sliders lined up in even cells. Same
  // elements, same ids: every painter, the edit panel and MIDI keep working.
  { const m1El = document.querySelector("#dj-owner .mixer.m1"), g2El = document.querySelector("#dj-owner .dj-grid2"), mstEl = document.getElementById("dj-master"); if (m1El && g2El && mstEl) { const panel = document.createElement("div"); panel.className = "dj-panel"; panel.id = "dj-fxpanel"; panel.innerHTML = "<h4>🎛️ MASTER FX</h4><div class='fxgrid'></div>"; g2El.insertBefore(panel, g2El.firstChild); const fxg = panel.querySelector(".fxgrid"); const chain = []; let n = mstEl.previousElementSibling; while (n) { chain.push(n); n = n.nextElementSibling; } let cell = null; chain.forEach((el) => { if (el.tagName === "SMALL" || !cell) { cell = document.createElement("div"); cell.className = "fxcell"; fxg.appendChild(cell); } cell.appendChild(el); if (el.querySelector && el.querySelector(".edivb, .gatebtn")) cell.classList.add("wide"); }); } }
  // VIDEO FX pad (owner, 2026-10-28): appended as the LAST child of the studio
  // grid - nothing else in the booth moves. It is created before foldPanels()
  // and the Customize registration below run, so it folds and hides exactly
  // like every other panel. Buttons carry data attributes only; the wiring
  // lives in the booth click delegation and the S.vfx watcher further down.
  { const g2v = document.querySelector("#dj-owner .dj-grid2"); if (g2v && !document.getElementById("dj-vfxpanel")) { const vp = document.createElement("div"); vp.className = "dj-panel"; vp.id = "dj-vfxpanel"; vp.innerHTML = "<h4>\uD83D\uDCFA VIDEO FX</h4>"
    + "<div class='vtrrow'><span style='font-size:14px;letter-spacing:.1em;color:var(--muted)'>TRANSITION</span>"
    + "<button class='btn ghost sm' type='button' data-vtr='cut'>\u2702\uFE0F Cut</button><button class='btn ghost sm' type='button' data-vtr='fade'>\uD83C\uDF2B\uFE0F Fade</button><button class='btn ghost sm' type='button' data-vtr='wipe'>\u25E7 Wipe</button><button class='btn ghost sm' type='button' data-vtr='slide'>\u27A1\uFE0F Slide</button><button class='btn ghost sm' type='button' data-vtr='zoom'>\uD83D\uDD0D Zoom</button><button class='btn ghost sm' type='button' data-vtr='blur'>\uD83C\uDF2B Blur</button><button class='btn ghost sm' type='button' data-vtr='flash'>\u26A1 Flash</button><button class='btn ghost sm' type='button' data-vtr='glitch'>\uD83D\uDCFA Glitch</button></div>"
    + "<div class='vtrrow'><span style='font-size:14px;letter-spacing:.1em;color:var(--muted)'>SPEED</span>"
    + "<button class='btn ghost sm' type='button' data-vspd='350'>Fast</button><button class='btn ghost sm' type='button' data-vspd='650'>Med</button><button class='btn ghost sm' type='button' data-vspd='1200'>Slow</button></div>"
    + "<div class='pads'>"
    + "<button class='pad' type='button' data-vfx='flash'>\u26A1 FLASH<small>white blast</small></button>"
    + "<button class='pad' type='button' data-vfx='strobe'>\uD83D\uDD06 STROBE<small>3 quick flashes</small></button>"
    + "<button class='pad' type='button' data-vfx='glitch'>\uD83D\uDCFA GLITCH<small>signal tear</small></button>"
    + "<button class='pad' type='button' data-vfx='blurp'>\uD83C\uDF2B BLUR PULSE<small>soft hit</small></button>"
    + "<button class='pad' type='button' data-vfx='zoomp'>\uD83D\uDD0D ZOOM PULSE<small>punch in / out</small></button>"
    + "<button class='pad' type='button' data-vfx='mono'>\uD83C\uDF9E\uFE0F B&amp;W DROP<small>mono, 2 seconds</small></button>"
    + "<button class='pad' type='button' data-vfx='invert'>\uD83D\uDD04 INVERT<small>color flip</small></button>"
    + "<button class='pad' type='button' data-vfx='hue'>\uD83C\uDF08 HUE SPIN<small>color wheel</small></button>"
    + "</div><small class='muted'>Transitions dress the master-screen switch; the pads fire one-shot picture hits on EVERY screen at once - booth, station and mini. Wrappers only: the video itself never reloads, so the picture stays locked to the sound.</small>"; g2v.appendChild(vp); } }
  // BRAIN panel (PR-B2): the DJ brain's readout, appended to the same
  // studio grid as THE DOOR — a new block only; nothing existing moves,
  // reorders or restyles. Created here, before foldPanels() and the
  // Customize registration below run, so it folds and hides exactly like
  // every other panel. The body is painted at runtime by brainPaint().
  { const doorP = document.getElementById("dj-door"); if (doorP && doorP.parentElement && !document.getElementById("dj-brain")) { const bp = document.createElement("div"); bp.className = "dj-panel"; bp.id = "dj-brain"; bp.innerHTML = "<h4>🧠 BRAIN</h4><div id=\"brain-body\"><small class=\"muted\">The brain is listening. Play, skip, and finish songs and it will start leaning your way.</small></div>"; doorP.parentElement.appendChild(bp); } }
  // REPORTS panel: the visitor + auto report inbox (POST /api/report),
  // created right after the BRAIN panel in the same grid, OWNER only -
  // member and guest booths never create it. Read-only: it reads the
  // reports/index doc and the newest report docs through the docs REST
  // select (see reportsRead) and paints them; it never writes.
  { const doorR = document.getElementById("dj-door"); if (OWNER() && doorR && doorR.parentElement && !document.getElementById("dj-reports")) { const rp = document.createElement("div"); rp.className = "dj-panel"; rp.id = "dj-reports"; rp.innerHTML = "<h4>📋 REPORTS</h4><div id=\"reports-body\"><small class=\"muted\">Loading reports…</small></div>"; doorR.parentElement.appendChild(rp); } }
  /* ---------- DJ BRAIN capture (PR-B2) ----------
   * The booth teaches the brain: every play, natural end, skip, watchdog
   * stall and queue draw on the DRIVING booth (owner + lead — a lead-booth
   * play IS the live station by the site's own rule, and the event's live
   * flag is stamped from S.live) is batched in memory and posted to
   * /api/brain/event, which folds it into the brain/taste doc (PR-B1,
   * lib/brain-taste.js). The sandbox never emits — a practice set must
   * never teach the live brain — and neither do listeners or mirror
   * windows: exactly one booth speaks for a set. Transport is
   * failure-silent by design: no session, no post; a failed post drops
   * its batch; nothing here may ever touch the music.
   * The event shape matches the server contract exactly: the client
   * sends {type, yt or src, title, artist, deck, heard, live, at} and
   * NEVER an actor — the server stamps the actor from the session and
   * derives the fold key itself (the yt id, or the /m/assets/ tail of a
   * library src, which is the assetId the keeper's bag reads).
   * BRAIN-B2-BEGIN */
  const brainSess = {}; // deck -> the play session the brain is watching
  const brainQ = []; // events waiting for the next flush
  const brainOn = () => { try { return !SANDBOX && OWNER() && leadDrive(); } catch (_) { return false; } };
  const brainKeyOf = (x) => { if (!x) return ""; if (x.yt) return "yt:" + x.yt; return "f:" + (x.src || ""); };
  /* The artist the fold needs: the item's own field first, then the
   * library track behind the src, then the "Artist - Title" convention
   * in the title itself. Empty when none of them know — the fold simply
   * skips the artist map for that event. */
  function brainArtistOf(x) {
    if (!x) return "";
    if (x.artist) return String(x.artist).slice(0, 80);
    try { if (x.src) { const t = TRACKS().find((tr) => tr && tr.artist && URLOF(tr) === x.src); if (t) return String(t.artist).slice(0, 80); } } catch (_) {}
    const ttl = String(x.title || ""), ix = ttl.indexOf(" - ");
    if (ix > 0 && ix < 60) return ttl.slice(0, ix).trim().slice(0, 80);
    return "";
  }
  /* End or skip is decided by the CLOCK, never by which door the track
   * left through: the skip button (PR #389) rides deckEnded, so an early
   * vskip must still read as a skip. Heard position inside the last 20s
   * (or the last tenth) of a known duration = the song ended; anything
   * earlier = it was skipped. With no known duration, only the natural
   * end path itself (via "ended") counts as an end. A watchdog handover
   * (sess.wdHand) closes silently — the stall rows already told it. */
  function brainClassify(sess, posEnd, via) {
    if (!sess || sess.wdHand) return null;
    const dur = +sess.dur || 0;
    if (dur > 0) return (posEnd >= dur - 20 || posEnd >= dur * 0.9) ? "end" : "skip";
    return via === "ended" ? "end" : "skip";
  }
  const brainScore = (c) => { if (!c) return 0; return 2 * (+c.e || 0) + (+c.p || 0) + (+c.heard || 0) / 120 - 1.5 * (+c.s || 0) - 0.5 * (+c.st || 0); }; // the fold's own score, mirrored from lib/brain-taste.js
  function brainEmit(ev) {
    if (!brainOn()) return;
    ev.at = Date.now();
    ev.live = S.live || ev.type === "play" ? 1 : 0; // a lead-booth play flips the station live in the same breath (togglePlay)
    brainQ.push(ev);
    if (brainQ.length > 100) brainQ.splice(0, brainQ.length - 100); // a dead endpoint can never grow this without bound
    if (brainQ.length >= 25) brainFlush();
  }
  function brainFlush() {
    if (!brainQ.length) return;
    const batch = brainQ.splice(0, 25); // the server cap: one flush is a handful of songs, never a flood
    try {
      const ses = mySess(), tok = ses && ses.access_token;
      if (!tok) return; // signed out: silent no-op, the batch is gone — never retried, never announced
      fetch("/api/brain/event", { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer " + tok }, body: JSON.stringify({ events: batch }), keepalive: true }).catch(() => {});
    } catch (_) {}
  }
  /* A deck went playing: open a session and emit play. A resume of the
   * same track continues the open session (the first flip counted it);
   * a different track landing on the deck closes the old session first. */
  function brainPlay(k) {
    if (!brainOn()) return;
    const s = S[k]; if (!s || (!s.src && !s.yt)) return;
    const key = brainKeyOf(s), cur = brainSess[k];
    if (cur && cur.key === key) return;
    if (cur) brainClose(k, "load");
    brainSess[k] = { key: key, yt: s.yt || "", src: s.src || "", title: s.title || "", artist: brainArtistOf(s), dur: +s.dur || 0, pos0: Math.max(0, posOf(k) || 0), wdHand: false };
    brainEmit({ type: "play", yt: s.yt || "", src: s.src || "", title: s.title || "", artist: brainSess[k].artist, deck: k, heard: 0 });
  }
  /* A watched play is over: classify it by the clock and emit. Heard is
   * the position span actually played — a pause freezes the deck
   * position, so paused time never inflates it. */
  function brainClose(k, via) {
    const sess = brainSess[k]; if (!sess) return;
    brainSess[k] = null;
    if (!brainOn()) return;
    const posEnd = Math.max(0, posOf(k) || 0);
    const type = brainClassify(sess, posEnd, via);
    if (!type) return;
    brainEmit({ type: type, yt: sess.yt, src: sess.src, title: sess.title, artist: sess.artist, deck: k, heard: Math.max(0, Math.min(86400, Math.round(posEnd - sess.pos0))) });
  }
  function brainDraw(it) {
    if (!it) return;
    brainEmit({ type: "draw", yt: it.yt || "", src: it.src || "", title: it.title || "", artist: brainArtistOf(it), deck: "", heard: 0 });
  }
  function brainStall(k) {
    const s = S[k]; if (!s || (!s.src && !s.yt)) return;
    brainEmit({ type: "stall", yt: s.yt || "", src: s.src || "", title: s.title || "", artist: brainArtistOf(s), deck: k, heard: 0 });
  }
  /* The watchdog is handing this deck over itself: the stall rows carry
   * the story, so the forced end must not also land as a clean end. */
  function brainWdHand(k) { const sess = brainSess[k]; if (sess) sess.wdHand = true; }
  setInterval(brainFlush, 15000);
  document.addEventListener("visibilitychange", () => { if (document.hidden) brainFlush(); });
  addEventListener("pagehide", () => { brainFlush(); });
  /* ---------- the BRAIN panel readout ----------
   * Painted from the brain/taste doc, read through the same docs facade
   * as every other booth doc: a get() on open, the doc's own snapshot
   * feed while the booth lives (the fold writes a changes row, so taste
   * rides the sync like any doc), and a slow re-read as a backstop. */
  function brainPaint(taste) {
    const box = document.getElementById("brain-body"); if (!box) return;
    const empty = "<small class=\"muted\">The brain is listening. Play, skip, and finish songs and it will start leaning your way.</small>";
    if (!taste || typeof taste !== "object") { box.innerHTML = empty; return; }
    const tracks = taste.tracks && typeof taste.tracks === "object" ? taste.tracks : {};
    const artists = taste.artists && typeof taste.artists === "object" ? taste.artists : {};
    const topA = Object.keys(artists).map((n) => [n, artists[n]]).filter((x) => (x[1].p || 0) + (x[1].e || 0) + (x[1].s || 0) > 0).sort((a, b) => brainScore(b[1]) - brainScore(a[1])).slice(0, 5);
    const topT = Object.keys(tracks).map((k2) => [k2, tracks[k2]]).sort((a, b) => brainScore(b[1]) - brainScore(a[1])).slice(0, 5);
    if (!topA.length && !topT.length && !taste.plays && !taste.ends && !taste.skips) { box.innerHTML = empty; return; }
    let h = "<div style=\"font-size:17.5px;margin-bottom:6px\">▶ " + (+taste.plays || 0) + " plays · ⏹ " + (+taste.ends || 0) + " finishes · ⏭ " + (+taste.skips || 0) + " skips</div>";
    if (topA.length) h += "<b style=\"font-size:15px;letter-spacing:.1em\">TOP ARTISTS</b>" + topA.map((x) => "<div class=\"dj-item\"><span>" + E(x[0]) + "</span><small class=\"muted\">" + (+x[1].p || 0) + " played · " + (+x[1].e || 0) + " finished · " + (+x[1].s || 0) + " skipped</small></div>").join("");
    if (topT.length) h += "<b style=\"font-size:15px;letter-spacing:.1em;display:block;margin-top:8px\">TOP TRACKS</b>" + topT.map((x) => "<div class=\"dj-item\"><span title=\"" + E(x[1].title || x[0]) + "\">" + E(x[1].title || x[0]) + "</span><small class=\"muted\">" + (+x[1].p || 0) + " played · " + (+x[1].e || 0) + " finished · " + (+x[1].s || 0) + " skipped</small></div>").join("");
    if (topA.length) h += "<div style=\"margin-top:8px;font-size:17.5px\">🎧 Auto-DJ is leaning on: <b>" + E(topA[0][0]) + "</b></div>";
    box.innerHTML = h;
  }
  function brainTasteRead() {
    if (SANDBOX || !OWNER()) return;
    try { const d = DBF(); if (!d) return; d.doc("brain/taste").get().then((snap) => { brainPaint(snap && snap.exists && snap.data ? snap.data() : null); }).catch(() => {}); } catch (_) {}
  }
  setTimeout(() => {
    brainTasteRead();
    try { const d = DBF(); if (d && !SANDBOX && OWNER()) d.doc("brain/taste").onSnapshot((snap) => { brainPaint(snap && snap.exists && snap.data ? snap.data() : null); }, () => {}); } catch (_) {}
  }, 1500);
  setInterval(() => { if (document.getElementById("dj-brain")) brainTasteRead(); }, 60000);
  /* BRAIN-B2-END */
  /* ---------- the REPORTS panel readout ----------
   * Reads reports/index, then the newest 20 report docs, newest first.
   * The mechanism is the docs REST select with the session Bearer from
   * mySess() - the established helper shape (see battleHdrs); dj.js
   * never reads the session store directly. The server excludes the
   * reports coll from non-admin selects, so when the index fetch
   * returns no row the panel says so in one plain line, no error
   * styling. Read-only: nothing here stores or writes anything. */
  function reportsPaint(docs) {
    const box = document.getElementById("reports-body"); if (!box) return;
    if (!docs) { box.innerHTML = "<small class=\"muted\">No reports yet — or reports are private to the admin account.</small>"; return; }
    if (!docs.length) { box.innerHTML = "<small class=\"muted\">No reports yet.</small>"; return; }
    box.innerHTML = docs.map((r) => {
      const when = r.at ? new Date(+r.at).toLocaleString() : "";
      const badge = r.kind === "auto" ? "🤖 auto" : "🧑 person";
      const where = [r.page || "", r.view || ""].filter(Boolean).join(" · ");
      return "<div class=\"dj-item\" style=\"align-items:flex-start\"><span style=\"white-space:normal\">" + badge + " · " + E(r.category || "other") + (when ? " · " + E(when) : "") + "<br>" + E(r.text || "") + (where ? "<br><small class=\"muted\">" + E(where) + "</small>" : "") + "</span></div>";
    }).join("");
  }
  function reportsSelect(path) {
    const ses = mySess(); const h = { "content-type": "application/json" };
    if (ses && ses.access_token) h.authorization = "Bearer " + ses.access_token;
    return fetch("/api/cf/rest", { method: "POST", headers: h, body: JSON.stringify({ table: "docs", op: "select", select: "path,data", limit: 1, filters: [["path", "eq", path]] }) }).then((r) => r.json()).then((j) => { const row = (j.data || [])[0]; if (!row) return null; const d = typeof row.data === "string" ? JSON.parse(row.data) : row.data; return d || null; }).catch(() => null);
  }
  function reportsRead() {
    if (SANDBOX || !OWNER()) return;
    if (!document.getElementById("dj-reports")) return;
    reportsSelect("reports/index").then((idx) => {
      if (!idx || !Array.isArray(idx.ids)) { reportsPaint(null); return; }
      const ids = idx.ids.slice(-20).reverse();
      if (!ids.length) { reportsPaint([]); return; }
      Promise.all(ids.map((id) => reportsSelect(id))).then((docs) => reportsPaint(docs.filter(Boolean)));
    }).catch(() => reportsPaint(null));
  }
  setTimeout(reportsRead, 1600);
  setInterval(() => { if (document.getElementById("dj-reports")) reportsRead(); }, 60000);
  /* ---------- the REPORTS button (owner fix, 2026-10-30) ----------
   * He could not find the reports: the inbox panel sits deep in the
   * studio grid. So the booth top cluster gets a 📋 REPORTS button
   * beside the AUTO-DJ and HORNS switches. The badge is the report
   * count from reports/index, read through the panel's own
   * reportsSelect (the same read, refreshed on the panel's cadence:
   * booth open, then every 60s); it hides at 0 and on any read
   * failure — never a made-up number. A tap reuses the panel's own
   * machinery to bring it into view: the phone-console tab switch,
   * the Customize restore button and the panel's own fold button,
   * then scrolls to it and re-reads. Owner only, and never in the
   * SANDBOX, which never touches real reports. Read-only. */
  const rpBtn = document.getElementById("dj-reports-btn");
  const rpBadge = document.getElementById("dj-reports-badge");
  function reportsBtnTick() {
    if (!rpBtn) return;
    if (SANDBOX || !OWNER()) { rpBtn.hidden = true; return; }
    rpBtn.hidden = false;
    reportsSelect("reports/index").then((idx) => {
      const n = idx && Array.isArray(idx.ids) ? idx.ids.length : 0;
      if (rpBadge) { rpBadge.textContent = n ? String(n) : ""; rpBadge.hidden = !n; }
    }).catch(() => { if (rpBadge) rpBadge.hidden = true; });
  }
  if (rpBtn) rpBtn.addEventListener("click", () => {
    const rp = document.getElementById("dj-reports"); if (!rp) return;
    const ow = document.getElementById("dj-owner");
    if (ow && ow.dataset.ptab && ow.dataset.ptab !== "all" && ow.dataset.ptab !== "studio") { const tb = document.querySelector('#dj-ptabs [data-ptab="all"]'); if (tb) tb.click(); }
    if (rp.classList.contains("ck-off") && rp.dataset.ckey) { const sb = document.querySelector('#dj-ckbar [data-ckshow="' + rp.dataset.ckey + '"]'); if (sb) sb.click(); }
    const pf = rp.querySelector(".pfold.shut");
    if (pf) { const fb = rp.querySelector(":scope > h4 button"); if (fb) fb.click(); }
    reportsRead();
    rp.scrollIntoView({ behavior: "smooth", block: "start" });
  });
  setTimeout(reportsBtnTick, 400);
  setTimeout(reportsBtnTick, 1600);
  setInterval(reportsBtnTick, 60000);
  /* ---------- /the REPORTS button ---------- */
  // foldable page sections: a [data-fold] button hides its block and everything
  // below pulls up to fill the space; the choice sticks on this device
  const applyFolds = () => { try { document.querySelectorAll("[data-fold]").forEach((b) => { const t = document.getElementById(b.dataset.fold); if (!t) return; const shut = !!localStorage.getItem("mw-fold-" + b.dataset.fold); t.hidden = shut; b.textContent = (shut ? "▸ " : "▾ ") + (b.dataset.foldLabel || ""); }); } catch (_) {} };
  document.addEventListener("click", (e) => { const b = e.target.closest("[data-fold]"); if (!b) return; const t = document.getElementById(b.dataset.fold); if (!t) return; t.hidden = !t.hidden; b.textContent = (t.hidden ? "▸ " : "▾ ") + (b.dataset.foldLabel || ""); try { localStorage.setItem("mw-fold-" + b.dataset.fold, t.hidden ? "1" : ""); if (!t.hidden) localStorage.removeItem("mw-fold-" + b.dataset.fold); } catch (_) {} });
  applyFolds(); if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", applyFolds);
  // every deck and studio panel folds too: the header keeps a ▾ button, the body
  // wraps in a .pfold (display:contents, so the grid layout is untouched until it
  // is shut), and the choice sticks on this device like the page folds
  function foldPanels() {
    document.querySelectorAll("#dj-owner .deck, #dj-owner .dj-panel").forEach((p) => {
      if (p.dataset.folded || p.id === "dj-browser") return;
      const h = p.querySelector(":scope > h4"); if (!h) return;
      p.dataset.folded = "1";
      const body = document.createElement("div"); body.className = "pfold";
      while (h.nextSibling) body.appendChild(h.nextSibling);
      p.appendChild(body);
      const key = "mw-fold-p-" + (p.dataset.deck ? "deck" + p.dataset.deck : (h.textContent || "panel").replace(/[^a-z0-9]+/gi, "-").toLowerCase().slice(0, 24));
      const b = document.createElement("button"); b.type = "button"; b.className = "btn ghost sm"; b.setAttribute("aria-label", "Fold this section");
      const paint = () => { b.textContent = body.classList.contains("shut") ? "▸" : "▾"; };
      try { if (localStorage.getItem(key)) body.classList.add("shut"); } catch (_) {}
      b.addEventListener("click", () => { body.classList.toggle("shut"); try { body.classList.contains("shut") ? localStorage.setItem(key, "1") : localStorage.removeItem(key); } catch (_) {} paint(); });
      h.style.display = "flex"; h.style.alignItems = "center"; h.style.justifyContent = "space-between"; h.style.width = "100%"; h.appendChild(b); paint();
    });
  }
  foldPanels();
  /* ---------- make it yours: hide whole booth blocks, remembered per device.
   * Folding shrinks a block; Customize (the 🛠 button in the booth top bar)
   * removes the ones you never touch — decks, mixers, the browser, studio
   * panels — and the restore bar brings any of them back. State and sound are
   * never touched: a hidden deck keeps playing. */
  const ckBlocks = [];
  const ckReg = (el, key, label) => { if (!el || el.dataset.ckey) return; el.dataset.ckey = key; const c = document.createElement("button"); c.type = "button"; c.className = "ck-chip"; c.dataset.ckhide = key; c.textContent = "✕ Hide"; el.appendChild(c); ckBlocks.push({ el, key, label }); };
  ckReg(document.getElementById("dj-browser"), "browser", "🎵 Music browser");
  ckReg(document.getElementById("dj-screen"), "screen", "📺 Master screen");
  ckReg(document.getElementById("dj-xfbar"), "xfbar", "🎚️ Crossfader");
  ckReg(document.getElementById("dj-edit"), "edit", "🎬 Video & audio editing");
  ["A", "B", "C", "D"].forEach((k) => ckReg(boothEl.querySelector('.deck[data-deck="' + k + '"]'), "deck" + k, "🎚️ Deck " + k));
  ckReg(boothEl.querySelector(".mixer.m1"), "mixer1", "🎛️ Mixer — mic, master & FX");
  ckReg(boothEl.querySelector(".mixer.m2"), "mixer2", "🎛️ C/D strip");
  ckReg(boothEl.querySelector(".dj-setups"), "setups", "⚙️ Setups row");
  boothEl.querySelectorAll(".dj-grid2 > .dj-panel").forEach((p) => { const h = p.querySelector("h4"); const label = h ? h.textContent.trim().slice(0, 26) : "Studio panel"; ckReg(p, "panel-" + label.replace(/[^a-z0-9]+/gi, "-").toLowerCase(), label); });
  let ckHidden = []; try { ckHidden = JSON.parse(localStorage.getItem("mw-booth-hide") || "[]"); if (!Array.isArray(ckHidden)) ckHidden = []; } catch (_) {}
  const ckBar = document.createElement("div"); ckBar.id = "dj-ckbar"; boothEl.querySelector(".dj-top").after(ckBar);
  const ckPaint = () => { ckBlocks.forEach(({ el, key }) => el.classList.toggle("ck-off", ckHidden.includes(key))); ckBar.innerHTML = "<b style='font-size:16.5px'>🛠 Customize — tap ✕ Hide on any block you don't use. Hidden:</b> " + (ckHidden.length ? ckBlocks.filter((b) => ckHidden.includes(b.key)).map((b) => `<button class='btn ghost sm' type='button' data-ckshow='${b.key}'>👁 ${b.label}</button>`).join(" ") : "<span class='muted' style='font-size:13px'>nothing hidden</span>") + " <button class='btn ghost sm' type='button' data-ckreset='1'>↺ Reset layout</button>"; };
  const ckSave = () => { try { localStorage.setItem("mw-booth-hide", JSON.stringify(ckHidden)); } catch (_) {} ckPaint(); };
  const ckBtn = document.createElement("button"); ckBtn.type = "button"; ckBtn.className = "btn ghost sm"; ckBtn.id = "dj-ck"; ckBtn.textContent = "🛠 Customize";
  boothEl.querySelector(".dj-top").appendChild(ckBtn);
  ckBtn.addEventListener("click", () => { const on = boothEl.classList.toggle("ck-on"); ckBtn.classList.toggle("on", on); if (on) say("🛠 Customize: tap ✕ Hide on anything you don't use — it's remembered on this device. Tap Customize again when you're done."); ckPaint(); });
  document.addEventListener("click", (e) => { const h = e.target.closest && e.target.closest("[data-ckhide],[data-ckshow],[data-ckreset]"); if (!h || !e.target.closest("#dj-booth-root")) return; if (h.dataset.ckhide) { if (!ckHidden.includes(h.dataset.ckhide)) ckHidden.push(h.dataset.ckhide); ckSave(); } else if (h.dataset.ckshow) { ckHidden = ckHidden.filter((x) => x !== h.dataset.ckshow); ckSave(); } else if (h.dataset.ckreset != null) { ckHidden = []; try { Object.keys(localStorage).filter((k) => k.indexOf("mw-fold") === 0).forEach((k) => localStorage.removeItem(k)); } catch (_) {} ckSave(); say("Layout reset — every block is back, and folds reset on the next load."); } });
  ckPaint();
  // console panels: tag the booth's panel groups so the phone console can tab them
  if (boothEl && boothHome) {
    const g2 = boothEl.querySelectorAll(".dj-grid2"); if (g2[0]) g2[0].classList.add("pg-studio"); if (g2[1]) g2[1].classList.add("pg-music");
    const curP = boothEl.querySelector("#dj-cur")?.closest(".dj-panel"); if (curP) curP.classList.add("pg-music");
    boothEl.dataset.ptab = "all";
    const ptabs = document.createElement("div"); ptabs.id = "dj-ptabs";
    ptabs.innerHTML = [["all", "🎛️ All"], ["decks", "🎚️ Decks"], ["studio", "🎙️ Studio"], ["music", "🎵 Music"]].map(([v, t]) => `<button class="btn ghost sm${v === "all" ? " on" : ""}" type="button" data-ptab="${v}">${t}</button>`).join("") + '<span class="ptab-on" id="dj-online2"></span>';
    boothHome.insertBefore(ptabs, boothEl);
  }
  document.addEventListener("click", (e) => { const pb = e.target.closest && e.target.closest("[data-ptab]"); if (!pb) return; const o = document.getElementById("dj-owner"); if (o) o.dataset.ptab = pb.dataset.ptab; document.querySelectorAll("#dj-ptabs [data-ptab]").forEach((x) => x.classList.toggle("on", x === pb)); });
  // phone deck switcher: panels SWAP (one tap, no sliding/scrolling through pages) —
  // each decks row shows exactly one panel: a deck or its mixer
  document.addEventListener("click", (e) => { const b = e.target.closest && e.target.closest("[data-swap]"); if (!b) return; const v = b.dataset.swap.split(":").pop(); const row = document.querySelector(".dj-decks"); if (row) row.dataset.show = v; b.parentElement.querySelectorAll("[data-swap]").forEach((x) => x.classList.toggle("on", x === b)); });
  // music browser tabs (Serato-style: one browser, three sources, right under the decks)
  document.addEventListener("click", (e) => { const bt = e.target.closest && e.target.closest("[data-brow]"); if (!bt) return; document.querySelectorAll("[data-brow]").forEach((x) => { const on = x === bt; x.classList.toggle("on", on); x.classList.toggle("ghost", !on); }); document.querySelectorAll("[data-browpane]").forEach((p) => { p.hidden = p.dataset.browpane !== bt.dataset.brow; }); if (bt.dataset.brow === "prep") paintPrep(); });
  /* ---------- booth fit (owner, voice call 2026-10-29: "fill the screen
   * with no scrolling and no open side gaps — you can shrink it so that
   * more things fit in; everything stays exactly where it is"). Nothing
   * in the console moves: this pass only (a) stretches the booth root
   * edge to edge inside its view (the page wrap caps at 1740px, which is
   * where the side gaps came from) and (b) sets a CSS zoom on #dj-owner,
   * the one scale that shrinks layout, text and hit targets together.
   * Zoom is layout-based, so every booth pointer handler keeps working
   * untouched: they all read getBoundingClientRect() (the visual, zoomed
   * box) against clientX/clientY (visual), and the ratios come out
   * identical at any zoom — the #377 scroll gate (8px of horizontal
   * proof before a surface engages) reads raw client deltas, which the
   * browser reports in that same visual space. A transform scale was
   * rejected here: it would trap the booth's position:fixed children
   * inside a transformed ancestor and desync the offsetWidth readers.
   * The zoom is width-led since the organize pass (owner, 2026-10-29:
   * no side voids): the width fit is answered first, the height fit
   * bounds it, never above 1 and never below FIT_MIN — below the floor the console keeps
   * the floor size and the page scrolls the remainder, rather than
   * shrinking the tables into print too small to work. The fit measures
   * the booth as it stands: Customize-hidden and folded blocks take no
   * space, so folding a panel re-fits the console bigger. */
  const FIT_MIN = 0.5;
  let fitTimer = 0;
  function boothFit() {
    const o = boothEl, root = boothHome;
    if (!o || !o.isConnected) return;
    const de = document.documentElement;
    if (root) { // (a) edge to edge — except the pop-out modes, already full-bleed
      const full = innerWidth >= 761 && !de.classList.contains("popdj") && !de.classList.contains("playdj");
      if (full && o.offsetParent) { const ml = parseFloat(getComputedStyle(root).marginLeft) || 0; root.style.width = de.clientWidth + "px"; const rr = root.getBoundingClientRect(); root.style.marginLeft = (ml - rr.left) + "px"; }
      else if (root.style.width) { root.style.width = ""; root.style.marginLeft = ""; }
    }
    if (!o.offsetParent || !o.clientWidth) { if (o.style.zoom) o.style.zoom = ""; return; }
    o.style.zoom = "1"; // measure the console at its natural size
    const nw = o.scrollWidth, nh = o.scrollHeight;
    if (!nw || !nh) { o.style.zoom = ""; return; }
    const top = o.getBoundingClientRect().top;
    const availW = root && root.clientWidth ? root.clientWidth : de.clientWidth;
    const availH = Math.max(240, innerHeight - Math.max(0, top));
    const sW = availW / nw, sH = availH / nh;
    let s = Math.min(sW, 1);
    if (s > sH) s = Math.max(FIT_MIN, sH);
    if (s < FIT_MIN) s = FIT_MIN;
    o.style.zoom = s >= 0.999 ? "" : String(Math.round(s * 1000) / 1000);
  }
  const fitSoon = () => { if (fitTimer) return; fitTimer = setTimeout(() => { fitTimer = 0; boothFit(); }, 140); };
  addEventListener("resize", fitSoon);
  addEventListener("hashchange", () => { fitSoon(); setTimeout(boothFit, 480); });
  document.addEventListener("click", (e) => { const t = e.target; if (t && t.closest && (t.closest("#dj-owner") || t.closest("[data-view]") || t.closest("#dj-ptabs"))) setTimeout(boothFit, 320); }, true);
  if ("IntersectionObserver" in window && boothEl) new IntersectionObserver((es) => { if (es.some((x) => x.isIntersecting)) fitSoon(); }, { threshold: 0.05 }).observe(boothEl);
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(() => fitSoon());
  boothFit(); setTimeout(boothFit, 500); setTimeout(boothFit, 1800);
  /* ---------- booth organize (owner, voice call 2026-10-29) ----------
   * The below-decks studio grid gets organized: panels pack upward in a
   * shipped priority order (the daily tools first, the rare setup last),
   * every panel folds to its header via foldPanels() above (collapse is
   * not Customize-hide; both re-pack with no holes in the dense grid),
   * and the panels can be dragged by a grip in their header to rearrange
   * them — the arrangement is per device and saved. A master lock in the
   * top bar starts LOCKED on every load, so nothing ever shifts by
   * accident; unlocking is per visit. The top zone (decks, mixers, the
   * X fader, the master screen) is never part of this: only .dj-grid2
   * panels are touched, and only their visual order changes — no state,
   * no audio, no panel logic. The Customize reset restores this shipped
   * default order too (see the data-ckreset listener below).
   * ORG-BEGIN */
  const ORG_DEFAULT = ["door", "brain", "reports", "livereq", "autodj", "mic", "record", "fx", "vfx", "pads", "midi", "log", "reqdrops", "campro", "battles", "afterhours"];
  const ORG_BY_ID = { "dj-door": "door", "dj-brain": "brain", "dj-reports": "reports", "dj-fxpanel": "fx", "dj-vfxpanel": "vfx", "dj-campro": "campro", "dj-afterhours": "afterhours" };
  const ORG_BY_H4 = [["LIVE DJ REQUESTS", "livereq"], ["AUTO-DJ", "autodj"], ["LIVE MIC", "mic"], ["RECORD THE SHOW", "record"], ["JINGLE", "pads"], ["MIDI CONTROLLER", "midi"], ["PROGRAM LOG", "log"], ["REQUESTS & DROPS", "reqdrops"], ["BATTLES", "battles"]];
  function orgKeyOf(p) {
    if (!p) return "";
    if (p.dataset && p.dataset.org) return p.dataset.org;
    let k = ORG_BY_ID[p.id] || "";
    if (!k) { const h = p.querySelector ? p.querySelector(":scope > h4") : null; const t = h ? (h.textContent || "").toUpperCase() : ""; for (let i = 0; i < ORG_BY_H4.length; i++) { if (t.indexOf(ORG_BY_H4[i][0]) >= 0) { k = ORG_BY_H4[i][1]; break; } } }
    if (!k) { const h = p.querySelector ? p.querySelector(":scope > h4") : null; k = "panel-" + ((h && h.textContent) || "panel").replace(/[^a-z0-9]+/gi, "-").toLowerCase().slice(0, 24); }
    if (p.dataset) p.dataset.org = k;
    return k;
  }
  /* The order to show: the saved per-device arrangement wins for the
   * panels it names; panels it does not name (new since the save — the
   * After Hours shelf is created lazily) slot in by the shipped default
   * rank; anything unknown keeps its current relative order at the end. */
  function orgResolve(present, saved) {
    const rank = (k) => { const d = ORG_DEFAULT.indexOf(k); return d >= 0 ? d : 900; };
    return present.slice().sort((a, b) => {
      const sa = saved ? saved.indexOf(a) : -1, sb = saved ? saved.indexOf(b) : -1;
      if (sa >= 0 && sb >= 0) return sa - sb;
      if (sa >= 0) return -1;
      if (sb >= 0) return 1;
      return rank(a) - rank(b);
    });
  }
  const orgGrid = () => boothEl ? boothEl.querySelector(".dj-grid2") : null;
  let orgLocked = true, orgBusy = false, orgDrag = null;
  function orgPanels() { const g = orgGrid(); if (!g) return []; return Array.prototype.slice.call(g.children).filter((p) => p.classList && p.classList.contains("dj-panel")); }
  function orgDecorate(p) {
    const h = p.querySelector(":scope > h4"); if (!h || h.querySelector(".org-grip")) return;
    const grip = document.createElement("span"); grip.className = "org-grip"; grip.textContent = "⠿"; grip.title = "Drag to rearrange — unlock the layout in the top bar first"; grip.setAttribute("role", "button"); grip.setAttribute("aria-label", "Drag to rearrange this panel");
    const fb = h.querySelector("button"); if (fb) h.insertBefore(grip, fb); else h.appendChild(grip);
  }
  function orgApply() {
    const g = orgGrid(); if (!g || orgBusy) return;
    const ps = orgPanels(); if (!ps.length) return;
    let saved = null; try { saved = JSON.parse(localStorage.getItem("mw-booth-order") || "null"); if (!Array.isArray(saved)) saved = null; } catch (_) {}
    const want = orgResolve(ps.map(orgKeyOf), saved);
    const now = ps.map(orgKeyOf);
    let same = want.length === now.length;
    if (same) for (let i = 0; i < want.length; i++) { if (want[i] !== now[i]) { same = false; break; } }
    ps.forEach((p) => orgDecorate(p));
    if (!same) { orgBusy = true; const byKey = {}; ps.forEach((p) => { byKey[orgKeyOf(p)] = p; }); want.forEach((k) => { if (byKey[k]) g.appendChild(byKey[k]); }); orgBusy = false; }
  }
  /* Dragging: only from the grip, only while unlocked. The panel reorders
   * live against its siblings' on-screen boxes — those boxes are read
   * with getBoundingClientRect(), the same visual space as clientX/Y, so
   * the math is exact at any booth zoom. Hidden (Customize) and folded
   * panels keep their slots in the saved order; hidden ones are skipped
   * as drop targets because they have no box. */
  function orgGripDown(e) {
    if (orgLocked || orgDrag) return;
    const grip = e.target && e.target.closest ? e.target.closest(".org-grip") : null; if (!grip) return;
    const p = grip.closest(".dj-panel"), g = orgGrid();
    if (!p || !g || p.parentElement !== g) return;
    e.preventDefault();
    orgBusy = true;
    orgDrag = { p: p, g: g, id: e.pointerId, grip: grip };
    p.classList.add("org-drag");
    try { grip.setPointerCapture(e.pointerId); } catch (_) {}
    grip.addEventListener("pointermove", orgGripMove);
    grip.addEventListener("pointerup", orgGripUp);
    grip.addEventListener("pointercancel", orgGripUp);
  }
  function orgGripMove(e) {
    if (!orgDrag || e.pointerId !== orgDrag.id) return;
    const g = orgDrag.g, p = orgDrag.p, x = e.clientX, y = e.clientY;
    const sibs = Array.prototype.slice.call(g.children).filter((c) => c !== p && c.classList && c.classList.contains("dj-panel") && !c.classList.contains("ck-off") && !c.hidden);
    let before = null;
    for (let i = 0; i < sibs.length; i++) {
      const r = sibs[i].getBoundingClientRect(); if (!r.width && !r.height) continue;
      const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
      if (cy > y + 6 || (Math.abs(cy - y) <= Math.max(30, r.height / 2) && cx > x)) { before = sibs[i]; break; }
    }
    if (before) { if (before !== p.nextSibling) g.insertBefore(p, before); }
    else if (g.lastElementChild !== p) g.appendChild(p);
  }
  function orgGripUp(e) {
    if (!orgDrag || (e && e.pointerId !== orgDrag.id)) return;
    const d = orgDrag; orgDrag = null;
    d.grip.removeEventListener("pointermove", orgGripMove);
    d.grip.removeEventListener("pointerup", orgGripUp);
    d.grip.removeEventListener("pointercancel", orgGripUp);
    d.p.classList.remove("org-drag");
    try { localStorage.setItem("mw-booth-order", JSON.stringify(orgPanels().map(orgKeyOf))); } catch (_) {}
    orgBusy = false;
    fitSoon();
  }
  document.addEventListener("pointerdown", orgGripDown, true);
  /* The master lock: lives in the booth top bar next to Customize. */
  const orgLockPaint = () => { const b = document.getElementById("dj-orglock"); if (boothEl) boothEl.classList.toggle("org-open", !orgLocked); if (!b) return; b.textContent = orgLocked ? "🔒 Layout" : "🔓 Layout open"; b.classList.toggle("on", !orgLocked); };
  { const topBar = boothEl && boothEl.querySelector(".dj-top"); if (topBar && !document.getElementById("dj-orglock")) { const lb = document.createElement("button"); lb.type = "button"; lb.className = "btn ghost sm"; lb.id = "dj-orglock"; lb.title = "Lock or unlock the below-decks panel layout"; lb.addEventListener("click", () => { orgLocked = !orgLocked; orgLockPaint(); if (!orgLocked) say("Layout open: drag any panel below the decks by the grip in its header. Tap Layout again to lock it — it will never move on its own."); else say("Layout locked — the panels stay where you put them."); }); topBar.appendChild(lb); } }
  orgLockPaint();
  /* The Customize reset restores the shipped organized default too:
   * clear the saved arrangement, re-apply the default order, and unfold
   * the grid panels on the spot (their fold keys die with the same
   * reset, in the Customize handler above). */
  document.addEventListener("click", (e) => { const h = e.target && e.target.closest ? e.target.closest("[data-ckreset]") : null; if (!h || !e.target.closest("#dj-booth-root")) return; try { localStorage.removeItem("mw-booth-order"); } catch (_) {} orgApply(); const g = orgGrid(); if (g) g.querySelectorAll(".pfold.shut").forEach((b) => b.classList.remove("shut")); fitSoon(); });
  /* Panels created after this block (the After Hours shelf) join the
   * organization the moment they land in the grid. */
  if (window.MutationObserver) { const g0 = orgGrid(); if (g0) new MutationObserver(() => { if (!orgBusy) orgApply(); }).observe(g0, { childList: true }); }
  orgApply();
  /* ORG-END */
  const $ = (s) => document.querySelector(s);
  const decks = { A: null, B: null, C: null, D: null };
  const DECKS = ["A", "B", "C", "D"]; const PAIR = { A: "B", B: "A", C: "D", D: "C" };
  const ROT = { A: "B", B: "C", C: "D", D: "A" }; // the four-deck rotation A→B→C→D→A
  /* qStock: which decks currently hold a CUED queue item, stocked by
   * "Play the queue" and by the post-transition refill (live booth
   * only). The records live in the SHARED state (S.qStock, normalized
   * in mergeState); this local copy is just the working mirror. That
   * sharing is the rotation fix (owner, 2026-10-29: "its still only
   * using deck A and B"): he taps Play the queue on whichever screen
   * is in front of him — often the mirror — and the driving window is
   * the only one whose autoNext ever runs. When the records lived
   * only in the tapping window's memory, the driver had none, C and D
   * never held a record it could start, and the pair path played A/B
   * forever. A record is still only a claim — qStockValid() re-checks
   * it against what the deck actually holds before anything trusts
   * it. Declared up here, ahead of load(), because load() clears the
   * record for the deck it loads onto. */
  let qStock = { A: null, B: null, C: null, D: null };
  function qSyncFromS() { const q = (typeof S !== "undefined" && S && S.qStock) || {}; qStock = { A: q.A || null, B: q.B || null, C: q.C || null, D: q.D || null }; }
  function qSet(k, item) { const rec = { src: (item && item.src) || "", yt: (item && item.yt) || "", at: Date.now() }; qStock[k] = rec; if (typeof S !== "undefined" && S) { if (!S.qStock) S.qStock = { A: null, B: null, C: null, D: null }; S.qStock[k] = rec; } }
  function qClear(k) { qStock[k] = null; if (typeof S !== "undefined" && S && S.qStock) S.qStock[k] = null; }
  const deck = (k) => { if (!decks[k]) { decks[k] = Deck(); decks[k].letter = k; } return decks[k]; };
  const fmt = (s) => { s = Math.max(0, Math.floor(s || 0)); return Math.floor(s / 60) + ":" + String(s % 60).padStart(2, "0"); };
  const agoT = (at) => new Date(at).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: "America/New_York" });

  /* ---------- levels, following the shared state, listener side ---------- */
  let listening = false, voiceEl = null, heardVoice = "", micHot = 0, mixVol = 1, dropDuckUntil = 0;
  /* keep the screen awake while a listener is tuned in (owner, 2026-10-27):
     a sleeping screen is what freezes video decks — the phone itself pauses
     the page, and no website can override a real lock or a closed app. But
     while the station is playing the lock never has to happen: hold a screen
     wake lock for the listener, re-grab it whenever they come back to the
     tab, and let it go when they stop. His own audio decks also keep playing
     through a lock with the lock-screen controls (Media Session, below). */
  let listenWake = null;
  let bubOn = false; // bubble mode (below): while it is on, no code path may hold a screen wake lock
  const wakeForListening = async (on) => {
    try {
      if (on && bubOn) on = false;
      if (on) { if (!listenWake && navigator.wakeLock && !document.hidden) { listenWake = await navigator.wakeLock.request("screen"); listenWake.addEventListener("release", () => { listenWake = null; }); } }
      else if (listenWake) { const w = listenWake; listenWake = null; w.release(); }
    } catch (_) {}
  };
  document.addEventListener("visibilitychange", () => { if (!document.hidden && listening) { wakeForListening(true); setTimeout(resumeDjAudio, 350); } });
  /* BLACKOUT MODE (see the CSS note above): pure black over everything, the
     sound untouched, a wake lock holding the phone awake. Exits: lock the
     phone and come back in, or press any key on a computer. Taps do nothing. */
  let boEl = null, boWakeLock = null, boOn = false, boLockOff = false;
  const boWake = async (on) => {
    try {
      if (on) { if (!boWakeLock && navigator.wakeLock && !document.hidden) { boWakeLock = await navigator.wakeLock.request("screen"); boWakeLock.addEventListener("release", () => { boWakeLock = null; }); } }
      else if (boWakeLock) { const w = boWakeLock; boWakeLock = null; w.release(); }
    } catch (_) {}
  };
  /* Lock-button exit (owner, 2026-10-28): a page cannot hear the phone's
   * power button, but locking the phone hides the page — so going hidden
   * while blackout is on marks it dismissed, and the exit is fully
   * applied when the page shows again: overlay off, fullscreen out, and
   * NO wake-lock re-grab. The re-grab survives only for a visible return
   * where blackout is still legitimately on. */
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) { if (boOn) boLockOff = true; return; }
    if (boLockOff) { boLockOff = false; blackout(false); return; }
    if (boOn) boWake(true);
  });
  /* Take the overlay itself fullscreen so Android can hide the status-bar
     clock and navigation chrome too; the fixed overlay remains the fallback
     on browsers that refuse or do not support element fullscreen. */
  const boFullscreen = (on) => {
    try {
      if (on && boEl && !document.fullscreenElement) {
        const req = boEl.requestFullscreen || boEl.webkitRequestFullscreen;
        if (req) { const p = req.call(boEl, { navigationUI: "hide" }); if (p && p.catch) p.catch(() => { try { req.call(boEl); } catch (_) {} }); }
      } else if (!on && document.fullscreenElement && document.exitFullscreen) {
        const p = document.exitFullscreen(); if (p && p.catch) p.catch(() => {});
      }
    } catch (_) { try { if (on && boEl && boEl.requestFullscreen) boEl.requestFullscreen(); } catch (__) {} }
  };
  /* A system fullscreen exit by itself (Android back gesture, Esc) no
   * longer closes blackout (owner, 2026-10-28, reversing the morning
   * rule): the overlay is fixed-position and keeps covering the viewport
   * without fullscreen. The only exits are lock-and-return on a phone
   * (a fullscreen drop while hidden still feeds that dismissal) and any
   * key on a desktop. Tapping the black screen does nothing. */
  document.addEventListener("fullscreenchange", () => { if (!document.fullscreenElement && document.hidden && boOn) boLockOff = true; });
  /* Input shield (owner, 2026-10-28 night: "when you touch the screen on
   * black out mode it makes the song skip — I want the screen protected
   * like its locked"): while blackout is on, every pointer, touch, click
   * and wheel event dies right here at capture, before any other handler
   * can see it — above all the listener tap-rescue (tapStart), which used
   * to re-sync every deck on any tap and audibly skip the song. This is
   * registered ONCE, here in the blackout section, which always runs
   * before startListening ever adds tapStart, so the shield sits earlier
   * in the capture chain and stopImmediatePropagation starves the rest.
   * Keydown is deliberately NOT shielded: any key stays the desktop exit,
   * and the phone exit stays lock-and-return. */
  ["pointerdown", "pointerup", "touchstart", "touchend", "click", "dblclick", "contextmenu", "wheel"].forEach((t) => document.addEventListener(t, (e) => { if (!boOn) return; e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation(); }, { capture: true, passive: false }));
  /* Any key exits blackout (owner, 2026-10-28 — a desktop has no tap):
   * the same exit path as tapping. The listener only acts while blackout
   * is on; with blackout off, keypresses pass through untouched. */
  document.addEventListener("keydown", () => { if (boOn) blackout(false); });
  function blackout(on) {
    boOn = !!on;
    window.MW_BLACKOUT = boOn; // app-core reads this: its autoplay rescue stays out while the screen is locked down
    if (boOn) {
      if (!boEl) { boEl = document.createElement("div"); boEl.id = "dj-blackout"; boEl.innerHTML = "<span>Playing in the dark — your screen comes back when you lock your phone and come back in · any key on a computer</span>"; document.body.appendChild(boEl); }
      boEl.hidden = false; boEl.classList.remove("bo-dim"); void boEl.offsetWidth; boEl.classList.add("bo-dim");
      boFullscreen(true);
      boWake(true);
    } else { if (boEl) boEl.hidden = true; boFullscreen(false); boWake(false); }
  }
  /* BUBBLE MODE (owner, 2026-10-28 night, his correction of the first
   * invisible-mode draft: "invisible mode makes the SITE go into the bubble
   * so the music dont stop"): the site itself shrinks into a small floating
   * bubble window that stays on top while the listener uses other things,
   * and because the site lives on inside the bubble, the music keeps
   * playing. Closing the bubble (or the site) stops the music. Three paths,
   * tried in order: (a) Document Picture-in-Picture — a real always-on-top
   * window carrying a compact live mirror of the master video screen plus
   * the current track title and two controls, Back to site (returns focus
   * and closes the window WITHOUT stopping the music) and ✕ Stop; the audio
   * elements stay in the main tab the whole time. (b) Standard video
   * Picture-in-Picture on a real playing video element, when the current
   * master source has one; leaving that PiP counts as closing the bubble.
   * (c) Fallback — the page itself collapses to the small draggable gold MW
   * bubble (tap: back, music untouched; its little ✕: stop and come back).
   * A PiP window closed from its own chrome counts as the bubble closing:
   * the music stops, unless the Back to site flag path closed it. Bubble
   * mode holds NO wake lock (the guard in wakeForListening) and takes no
   * fullscreen, so the screen may sleep; while it is on, the Media Session
   * carries the station (metadata + lock-screen play/pause wired to the
   * real listen controls) so the phone treats the decks as real media
   * playback. Separate from blackout and never touching it. Per-tab and
   * in-memory only — closing the tab or the site ends everything, nothing
   * is remembered across sessions. */
  let bubEl = null, bubBubble = null, pipWin = null, pipBox = null, bubBackFlag = false, bubVidEl = null;
  const bubMedia = (on) => {
    try {
      if (!("mediaSession" in navigator)) return;
      if (on) {
        navigator.mediaSession.metadata = new MediaMetadata({ title: "Meechie's World — Live Radio", artist: "Meechie's World Inc", album: "Meechie's World Radio", artwork: [{ src: location.origin + "/img/icon-512.png", sizes: "512x512", type: "image/png" }] });
        navigator.mediaSession.playbackState = "playing";
        if (navigator.mediaSession.setActionHandler) {
          navigator.mediaSession.setActionHandler("play", () => { if (!listening && (isLive() || OWNER())) startListening(); });
          navigator.mediaSession.setActionHandler("pause", () => { if (listening) stopListening(); });
        }
      } else if (navigator.mediaSession.setActionHandler) { navigator.mediaSession.setActionHandler("play", null); navigator.mediaSession.setActionHandler("pause", null); }
    } catch (_) {}
  };
  const bubOff = () => {
    bubOn = false;
    if (bubEl) bubEl.hidden = true; if (bubBubble) bubBubble.hidden = true;
    bubMedia(false);
    if (listening) wakeForListening(true); // normal listening holds the screen again
  };
  /* path (c): the in-page bubble */
  const bubPage = () => {
    if (!bubEl) {
      bubEl = document.createElement("div"); bubEl.id = "dj-bubbg"; document.body.appendChild(bubEl);
      bubBubble = document.createElement("button"); bubBubble.type = "button"; bubBubble.id = "mw-bubble"; bubBubble.setAttribute("aria-label", "Back to the site — the music keeps playing"); bubBubble.innerHTML = "MW<span class='mw-x'>✕</span>"; document.body.appendChild(bubBubble);
      let drag = null;
      bubBubble.addEventListener("pointerdown", (e) => { drag = { x: e.clientX, y: e.clientY, l: bubBubble.offsetLeft, t: bubBubble.offsetTop, moved: false }; try { bubBubble.setPointerCapture(e.pointerId); } catch (_) {} });
      bubBubble.addEventListener("pointermove", (e) => { if (!drag) return; const dx = e.clientX - drag.x, dy = e.clientY - drag.y; if (Math.abs(dx) + Math.abs(dy) > 6) drag.moved = true; if (drag.moved) { bubBubble.style.left = Math.max(0, Math.min(innerWidth - 56, drag.l + dx)) + "px"; bubBubble.style.top = Math.max(0, Math.min(innerHeight - 56, drag.t + dy)) + "px"; bubBubble.style.right = "auto"; bubBubble.style.bottom = "auto"; } });
      bubBubble.addEventListener("pointerup", (e) => { if (!drag) return; const wasDrag = drag.moved; drag = null; if (wasDrag) return; const xr = bubBubble.querySelector(".mw-x").getBoundingClientRect(); if (e.clientX >= xr.left - 6 && e.clientX <= xr.right + 6 && e.clientY >= xr.top - 6 && e.clientY <= xr.bottom + 6) { stopListening(); bubOff(); } else bubOff(); });
      bubBubble.addEventListener("pointercancel", () => { drag = null; });
    }
    bubEl.hidden = false; bubBubble.hidden = false;
  };
  /* path (a): keep the PiP window's title and muted video mirror live */
  const pipSync = () => {
    if (!pipBox || !pipWin || pipWin.closed) return;
    const playing = DECKS.filter((k) => S[k] && S[k].playing && S[k].title);
    try { pipBox.titleEl.textContent = playing.length ? playing.map((k) => S[k].title).join("  ×  ") : "Meechie's World — Live Radio"; } catch (_) {}
    const tg = vmixTargets().slice().sort((a, b) => b.op - a.op);
    const tok = tg.length ? (S[tg[0].k].yt || "") : "";
    if (tok !== pipBox.vid) {
      if (pipBox.player) { try { pipBox.player.destroy(); } catch (_) {} pipBox.player = null; }
      pipBox.vid = tok; pipBox.deck = tg.length ? tg[0].k : "";
      pipBox.vidEl.innerHTML = "";
      if (tok) {
        const mount = pipWin.document.createElement("div"); mount.style.cssText = "width:100%;height:100%"; pipBox.vidEl.appendChild(mount);
        const prov = vparseTok(tok).p, deck = pipBox.deck;
        const go = () => { if (pipBox && pipBox.vid === tok) { try { pipBox.player = mkVidPlayer(mount, tok, true, deck); } catch (_) {} } };
        if (prov === "yt") ytApi().then(go); else if (prov === "dm") dmApi().then(go); else vmApi().then(go);
      }
    } else if (tok && pipBox.player) {
      try { const pst = pipBox.player.getPlayerState(); if (pst !== 1) pipBox.player.playVideo(); const cur = pipBox.player.getCurrentTime ? pipBox.player.getCurrentTime() : 0, want = bcastPos(pipBox.deck); if (cur > 0 && syncLockCalc(cur - want, 1).act === "snap") pipBox.player.seekTo(want, true); } catch (_) {}
    }
  };
  const bubDocPip = async () => {
    const w = await window.documentPictureInPicture.requestWindow({ width: 360, height: 330 });
    pipWin = w;
    const d = w.document;
    try { d.title = "Meechie's World — Live Radio"; } catch (_) {}
    const st = d.createElement("style");
    st.textContent = "html,body{margin:0;padding:0;background:#000;color:#f3e5c0;font-family:system-ui,sans-serif}body{padding:10px;box-sizing:border-box}.pb-brand{display:flex;align-items:center;gap:8px;font:800 11px system-ui,sans-serif;letter-spacing:.12em;color:#f0cf78;margin-bottom:8px}.pb-mw{display:grid;place-items:center;width:26px;height:26px;border-radius:50%;background:radial-gradient(circle at 32% 30%,#ffe9b0,#d4a843 58%,#9a7b24);color:#141109;font:800 10px system-ui,sans-serif;border:1.5px solid #f0cf78}.pb-vid{width:100%;aspect-ratio:16/9;background:#0a0a0c;border:1px solid #3a3520;border-radius:10px;overflow:hidden}.pb-vid iframe{width:100%;height:100%;border:0}.pb-title{margin:9px 0;font:700 13.5px system-ui,sans-serif;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.pb-row{display:flex;gap:8px}.pb-row button{flex:1;padding:9px 6px;border-radius:999px;border:1.5px solid #f0cf78;background:#141109;color:#f0cf78;font:800 12.5px system-ui,sans-serif;cursor:pointer}#pb-stop{background:#f0cf78;color:#141109}";
    d.head.appendChild(st);
    d.body.innerHTML = "<div class='pb-brand'><span class='pb-mw'>MW</span><span>MEECHIE'S WORLD RADIO</span></div><div class='pb-vid' id='pb-vid'></div><div class='pb-title' id='pb-title'>Meechie's World — Live Radio</div><div class='pb-row'><button type='button' id='pb-back'>⤢ Back to site</button><button type='button' id='pb-stop'>✕ Stop</button></div>";
    pipBox = { vidEl: d.getElementById("pb-vid"), titleEl: d.getElementById("pb-title"), player: null, vid: null, deck: "", timer: 0 };
    d.getElementById("pb-back").addEventListener("click", () => { bubBackFlag = true; try { window.focus(); } catch (_) {} try { w.close(); } catch (_) {} });
    d.getElementById("pb-stop").addEventListener("click", () => { bubBackFlag = true; stopListening(); try { w.close(); } catch (_) {} });
    w.addEventListener("pagehide", () => {
      const wasBack = bubBackFlag; bubBackFlag = false;
      if (pipBox) { if (pipBox.timer) clearInterval(pipBox.timer); if (pipBox.player) { try { pipBox.player.destroy(); } catch (_) {} } pipBox = null; }
      pipWin = null;
      if (!wasBack) stopListening(); // closed from its own chrome = the bubble closed
      bubOff();
    });
    pipBox.timer = setInterval(pipSync, 1000);
    pipSync();
  };
  /* path (b): leaving video PiP counts as closing the bubble */
  const bubVidLeft = () => {
    if (bubVidEl) { try { bubVidEl.removeEventListener("leavepictureinpicture", bubVidLeft); } catch (_) {} bubVidEl = null; }
    if (!bubOn) return;
    stopListening(); bubOff();
  };
  const bubbleOpen = async () => {
    bubMedia(true);
    wakeForListening(false); // hand the wake lock back — in this mode the screen may sleep
    if (window.documentPictureInPicture) { try { await bubDocPip(); return; } catch (_) { pipWin = null; pipBox = null; } }
    try {
      const vids = Array.prototype.slice.call(document.querySelectorAll("video"));
      const v = vids.find((x) => !x.paused && x.readyState >= 2 && x.videoWidth > 0) || vids.find((x) => x.readyState >= 2 && x.videoWidth > 0);
      if (v && document.pictureInPictureEnabled && !v.disablePictureInPicture) {
        bubVidEl = v;
        v.addEventListener("leavepictureinpicture", bubVidLeft);
        await v.requestPictureInPicture();
        return;
      }
    } catch (_) { if (bubVidEl) { try { bubVidEl.removeEventListener("leavepictureinpicture", bubVidLeft); } catch (__) {} bubVidEl = null; } }
    bubPage();
  };
  /* CAMERA SQUARE (owner, 2026-10-29): the 📷 Cam button in the master-screen
   * controls cuts his webcam on beside the booth master video — the picture
   * scoots over by the square and comes back untouched when the cam goes off.
   * The stream lives in the lead booth tab whose button was tapped (that tap
   * is the user gesture getUserMedia wants); S.vcam is the shared switch, so
   * his other booth screens follow the layout, and a lead tab that finds the
   * cam on without a stream tries once to start its own — permission may
   * already be granted — and otherwise shows a placeholder in the square.
   * Booth screen ONLY: the station and mini stages are never touched. */
  let camStream = null, camBusy = false, camFailAt = 0, camLastW = 0, camWasOn = false, camBtnOn = null;
  /* CRASH GUARD (2026-10-29): camStartLocal stamps sessionStorage the
     moment any camera start begins and clears the stamp only after the
     camera has run cleanly for ~20s. If THIS page load finds the stamp
     still set, the previous session died with the camera starting or
     running — and when his saved camera setup (localStorage mw-camfx)
     says the camera would auto-restore, the booth does NOT auto-start
     it again on this load; he starts it with the Cam button himself. */
  let camGuardTripped = false;
  try { camGuardTripped = !!sessionStorage.getItem("mw-cam-guard") && !!localStorage.getItem("mw-camfx"); } catch (_) {}
  function camEls() { return { st: document.getElementById("dj-vstage"), wrap: document.getElementById("dj-camwrap"), vid: document.getElementById("dj-camvid"), btn: document.getElementById("dj-cambtn") }; }
  /* Glitch guard (owner, 2026-10-29: "my cam on button looks like its
     glitching"): camSize used to run on EVERY camSync (several times a
     second) and re-set --camw from clientHeight each pass — on a phone the
     browser chrome sliding wobbles that height by a few px, so the .45s
     scoot transition restarted endlessly. Now: a 6px deadband, measured
     only on the off-to-on transition and on debounced resizes. */
  function camSize() { const st = camEls().st; if (st) { const h = st.clientHeight || 0; if (h > 0 && Math.abs(h - camLastW) >= 6) { camLastW = h; st.style.setProperty("--camw", h + "px"); } } }
  function camStopLocal() { camFxOnStop(); if (camStream) { try { camStream.getTracks().forEach((t) => t.stop()); } catch (_) {} camStream = null; } const vid = camEls().vid; if (vid) { try { vid.srcObject = null; } catch (_) {} } }
  async function camStartLocal() {
    if (camStream) return true;
    if (camBusy) return false;
    camBusy = true;
    try { sessionStorage.setItem("mw-cam-guard", String(Date.now())); } catch (_) {} // crash-guard stamp: cleared only after ~20s of clean camera running
    try {
      const s = await navigator.mediaDevices.getUserMedia({ video: { width: { ideal: 640 }, height: { ideal: 640 }, facingMode: "user" }, audio: false });
      camStream = s;
      const e = camEls();
      if (e.vid) { e.vid.srcObject = s; try { await e.vid.play(); } catch (_) {} }
      if (e.wrap) e.wrap.classList.remove("novid");
      camFxOnStream();
      setTimeout(() => { if (camStream) { try { sessionStorage.removeItem("mw-cam-guard"); } catch (_) {} } }, 20000); // the camera ran clean for ~20s: the next load may auto-restore it again
      return true;
    } catch (_) { return false; }
    finally { camBusy = false; }
  }
  function camSync() {
    try {
      const e = camEls(); if (!e.st) return;
      const on = !SANDBOX && OWNER() && !!(S.vcam && S.vcam.on);
      if (on || !camProBuilt) camProBuild(); // while the cam is off the Camera Pro panel is hidden — the 700ms stage tick and every state echo used to rebuild + repaint it anyway
      if (e.btn) e.btn.style.display = SANDBOX ? "none" : "";
      if (e.btn && camBtnOn !== on) { camBtnOn = on; e.btn.classList.toggle("on", on); e.btn.textContent = on ? "📷 Cam · ON" : "📷 Cam"; }
      const cp = document.getElementById("dj-campro"); if (cp && cp.hidden === on) cp.hidden = !on; // the Camera Pro panel only exists while the cam is on
      e.st.classList.toggle("cam-on", on);
      if (!on) { camWasOn = false; camStopLocal(); return; }
      if (!camWasOn) { camWasOn = true; camSize(); }
      if (e.wrap) e.wrap.classList.toggle("novid", !camStream);
      if (boothLead && !camStream && !camBusy && !camGuardTripped && Date.now() - camFailAt > 20000) {
        camStartLocal().then((ok) => { if (!ok) { camFailAt = Date.now(); const w = camEls().wrap; if (w) w.classList.add("novid"); } });
      }
      camFrameTick();
    } catch (_) {}
  }
  async function camToggle() {
    if (SANDBOX || !OWNER()) return;
    if (!boothLead) { say("📷 The camera runs on the screen that is driving the booth — make this screen the driver first, then tap Cam."); return; }
    if (S.vcam && S.vcam.on) { S.vcam = { on: false, at: Date.now() }; camSync(); save(true); say("📷 Camera off — the master screen is back to full width."); return; }
    const ok = await camStartLocal();
    if (!ok) { say("📷 Camera blocked — allow camera for this site, then tap Cam again."); return; }
    camFailAt = 0;
    S.vcam = { on: true, at: Date.now() };
    camSync(); save(true);
    say("📷 Camera is ON — it sits beside the master video. Tap 🎛 Edit on the camera for looks, framing and backgrounds.");
  }
  let camRszT = null;
  addEventListener("resize", () => { if (camRszT) clearTimeout(camRszT); camRszT = setTimeout(() => { try { if (S.vcam && S.vcam.on) camSize(); } catch (_) {} }, 200); });
  /* ================= CAMERA PRO (owner, 2026-10-29) =================
   * His four complaints, answered in one build: the camera LAGGED (the
   * fp32 matte ran every frame on the main thread), tapping a filter
   * made the SONG SKIP (a cold engine load + a two-surface filter write
   * spiked that same thread his WebAudio plays through), he could not
   * REACH all the filters (chips crammed inside the little square), and
   * the looks were TOO BASIC — "give me OBS editing tools".
   * So: the square keeps only a slim [🎛 Edit] bar and his name banner;
   * every control lives in the 📷 CAMERA PRO panel (looks, adjust
   * sliders, zoom/pan/mirror framing, background mode + blur + edge,
   * banner). The background engine is Robust Video Matting (free,
   * open-source, off GitHub) in onnxruntime-web — the "all" bundle,
   * which carries the WebGPU backend next to wasm; the model file comes
   * from a public Hugging Face mirror that is byte-identical to the
   * official PeterL1n GitHub release (sha256 checked at build time)
   * because GitHub release downloads send no CORS header a browser can
   * use. If RVM cannot load, the fallback is MediaPipe Selfie
   * Segmentation (also free) — a per-frame mask, visibly less steady.
   * PERFORMANCE, the heart of it: the engine WARMS UP at cam-on (never
   * at tap time), inference runs single-flight in its own loop (latest
   * frame wins, an EMA of inference time steps the analysis square
   * 320 → 256 → 224 when the device cannot keep up), the filter chain
   * is written to the ONE visible surface only, and the broadcast frame
   * encodes through async convertToBlob instead of blocking toDataURL.
   * 2) VIEWERS SEE HIM on the pop-out master screen: while his cam is on
   *    and the station is live, the lead booth publishes a fresh camera
   *    FRAME every ~4 seconds into its own radio/camframe doc and every viewer's
   *    pop-out grows a small draggable square of him, bottom-right.
   *    HONESTY NOTE: this is a live photo relay — a fresh still every
   *    few seconds, NOT full-motion video. The same square becomes the
   *    real video surface when the Realtime streaming path lands.
   * Booth-local only: camera choices live in localStorage, never in
   * the shared state; the only shared writes are the frame relay. */
  const CAM_FX_W = 320; // display + broadcast square (px); the matte analysis size adapts below it
  /* A look = a base filter fragment + the ADJUST slider baseline it sets.
     Duotone runs through the inline SVG filter #mw-duo (luminance mapped
     onto the black-to-gold ramp); Detail sharpening runs through the
     SVG feConvolveMatrix filter #mw-sharp, whose kernel interpolates
     identity → sharpen as the slider climbs. */
  const CAM_LOOKS = {
    off: { label: "Off", base: "", b: 1, c: 1, s: 1 },
    gold: { label: "Gold", base: "sepia(0.30)", b: 1.04, c: 1.08, s: 1.35 },
    bw: { label: "B&W", base: "grayscale(1)", b: 1, c: 1.06, s: 1 },
    vivid: { label: "Vivid", base: "", b: 1, c: 1.12, s: 1.75 },
    soft: { label: "Soft", base: "blur(0.7px)", b: 1.13, c: 0.92, s: 1.08 },
    noir: { label: "Noir", base: "grayscale(1)", b: 0.86, c: 1.32, s: 1, d: 20 },
    cinematic: { label: "Cinematic", base: "sepia(0.18) hue-rotate(-8deg)", b: 1.02, c: 1.18, s: 0.88, d: 25 },
    vintage: { label: "Vintage", base: "sepia(0.55)", b: 1.06, c: 0.94, s: 0.72 },
    chrome: { label: "Chrome", base: "grayscale(0.35)", b: 1.10, c: 1.28, s: 0.60 },
    night: { label: "Night", base: "hue-rotate(14deg)", b: 0.85, c: 1.15, s: 0.62 },
    rose: { label: "Rose", base: "sepia(0.32) hue-rotate(-16deg)", b: 1.05, c: 1.02, s: 1.18 },
    ice: { label: "Ice", base: "sepia(0.22) hue-rotate(185deg) saturate(1.35)", b: 1.06, c: 1.04, s: 0.90 },
    duotone: { label: "Duotone", base: "url(#mw-duo)", b: 1, c: 1.05, s: 1 }
  };
  let camFx = { look: "off", b: 1, c: 1, s: 1, warm: 0, detail: 0, zoom: 1, panX: 0, panY: 0, mirror: true, bg: "off", blurPx: 16, feather: 1.6, bannerOn: false, bannerText: "DJ MEECHIE — LIVE" };
  try {
    const sfx = JSON.parse(localStorage.getItem("mw-camfx") || "{}");
    if (sfx && typeof sfx === "object") {
      // graceful migration: saves from before Camera Pro were {filter, bg}
      if (CAM_LOOKS[String(sfx.look)] != null) camFx.look = String(sfx.look);
      else if (CAM_LOOKS[String(sfx.filter)] != null) camFx.look = String(sfx.filter);
      ["b", "c", "s", "warm", "detail"].forEach((k) => { if (isFinite(+sfx[k])) camFx[k] = +sfx[k]; });
      if (isFinite(+sfx.zoom)) camFx.zoom = Math.min(2.5, Math.max(1, +sfx.zoom));
      if (isFinite(+sfx.panX)) camFx.panX = Math.min(1, Math.max(-1, +sfx.panX));
      if (isFinite(+sfx.panY)) camFx.panY = Math.min(1, Math.max(-1, +sfx.panY));
      if (typeof sfx.mirror === "boolean") camFx.mirror = sfx.mirror;
      if (["off", "blur", "brand", "pic"].indexOf(String(sfx.bg)) >= 0) camFx.bg = String(sfx.bg);
      if (isFinite(+sfx.blurPx)) camFx.blurPx = Math.min(40, Math.max(4, +sfx.blurPx));
      if (isFinite(+sfx.feather)) camFx.feather = Math.min(3.2, Math.max(0.8, +sfx.feather));
      if (typeof sfx.bannerOn === "boolean") camFx.bannerOn = sfx.bannerOn;
      if (typeof sfx.bannerText === "string" && sfx.bannerText) camFx.bannerText = sfx.bannerText.slice(0, 42);
    }
  } catch (_) {}
  function camFxSave() { try { localStorage.setItem("mw-camfx", JSON.stringify(camFx)); } catch (_) {} }
  /* the one filter chain, rebuilt from look + sliders; the plain "off at
     defaults" case returns "" so the surface carries NO filter at all
     (a filter property — even a no-op one — costs the compositor). */
  function camFilterCss() {
    if (camFx.look === "off" && camFx.b === 1 && camFx.c === 1 && camFx.s === 1 && !camFx.warm && !camFx.detail) return "";
    const L = CAM_LOOKS[camFx.look] || CAM_LOOKS.off, parts = [];
    let base = L.base;
    if (base.indexOf("url(#mw-duo)") >= 0 && !document.getElementById("mw-duo")) base = "grayscale(1)"; // defs missing: never hand the compositor a dead reference
    if (base) parts.push(base);
    parts.push("brightness(" + camFx.b + ")", "contrast(" + camFx.c + ")", "saturate(" + camFx.s + ")");
    const w = camFx.warm;
    if (w > 0) parts.push("sepia(" + Math.min(0.5, w / 100).toFixed(3) + ")", "hue-rotate(" + (-w * 0.15).toFixed(1) + "deg)");
    else if (w < 0) parts.push("sepia(" + Math.min(0.4, -w / 140).toFixed(3) + ")", "hue-rotate(195deg)", "saturate(1.1)");
    if (camFx.detail > 0 && document.getElementById("mw-sharp")) parts.push("url(#mw-sharp)");
    return parts.join(" ");
  }
  let camSharpAt = 0;
  function camSharpSync(force) { // keep the SVG sharpen kernel matched to the Detail slider (throttled — attr writes are cheap, but not free)
    const now = Date.now(); if (!force && now - camSharpAt < 90) return; camSharpAt = now;
    const k = document.getElementById("mw-sharp-k"); if (!k) return;
    const a = Math.round(camFx.detail) / 100 * 1.2, ctr = 1 + 8 * a, r = (x) => Math.round(x * 1000) / 1000;
    k.setAttribute("kernelMatrix", [r(-a), r(-a), r(-a), r(-a), r(ctr), r(-a), r(-a), r(-a), r(-a)].join(" "));
  }
  /* draw a feed into a W x H ctx with the booth framing baked in: cover
     crop, zoom about the pan-shifted centre, mirror flipped at draw time.
     Pan is stored in spare-range units (-1..1); the sample rect offsets
     WITH the pan when mirrored and AGAINST it when not, so the sampled
     picture moves exactly the way the CSS transform moves the element. */
  function drawFramed(ctx, src, W, H) {
    const sw = src.videoWidth || src.naturalWidth || src.width || 0, sh = src.videoHeight || src.naturalHeight || src.height || 0;
    if (!sw || !sh) return;
    const sc = Math.max(W / sw, H / sh), cw = W / sc, ch = H / sc;
    const zw = cw / camFx.zoom, zh = ch / camFx.zoom;
    let cx = (sw - zw) / 2 + (camFx.mirror ? camFx.panX : -camFx.panX) * (cw - zw) / 2;
    let cy = (sh - zh) / 2 + camFx.panY * (ch - zh) / 2;
    cx = Math.max(0, Math.min(cx, sw - zw)); cy = Math.max(0, Math.min(cy, sh - zh));
    ctx.save();
    if (camFx.mirror) { ctx.translate(W, 0); ctx.scale(-1, 1); }
    ctx.drawImage(src, cx, cy, zw, zh, 0, 0, W, H);
    ctx.restore();
  }
  /* the framing transform for the visible VIDEO element (BG off): pan in
     screen space, zoom about the centre, mirror last — the same numbers
     drawFramed samples with, so display and capture agree. */
  function camFrameTransform() {
    const mx = (1 - 1 / camFx.zoom) / 2;
    return "translate(" + (camFx.panX * mx * 100).toFixed(2) + "%, " + (camFx.panY * mx * 100).toFixed(2) + "%) scale(" + camFx.zoom + ")" + (camFx.mirror ? " scaleX(-1)" : "");
  }
  /* filter + framing go to the ONE surface the eye can see — the video
     when no background is up, the composite canvas when there is. The
     canvas never gets a transform: its bitmap is already framed +
     mirrored by the pipeline (which is also why the brand backdrop text
     reads correctly now instead of mirror-flipped). */
  function camProApplySurface() {
    try {
      const w = camEls().wrap, v = camEls().vid, fx = document.getElementById("dj-camfx");
      const bgOn = !!(w && w.classList.contains("fxbg"));
      const css = camFilterCss();
      if (v) { v.style.filter = bgOn ? "" : css; v.style.transform = bgOn ? "" : camFrameTransform(); }
      if (fx) { fx.style.filter = bgOn ? css : ""; fx.style.transform = ""; }
      if (w) w.style.touchAction = camFx.zoom > 1.01 ? "none" : "";
    } catch (_) {}
  }
  let camApplyRaf = 0;
  function camProReqApply() { if (camApplyRaf) return; camApplyRaf = requestAnimationFrame(() => { camApplyRaf = 0; camProApplySurface(); camSharpSync(true); }); }
  let camBgImg = null, camBgImgURL = "", camBgQuotaSaid = false;
  try { camBgImgURL = localStorage.getItem("mw-cambg") || ""; } catch (_) {}
  if (camBgImgURL) { const bim = new Image(); bim.onload = () => { camBgImg = bim; }; bim.onerror = () => { camBgImgURL = ""; }; bim.src = camBgImgURL; }
  function drawCover(ctx, src, W, H) { const sw = src.videoWidth || src.naturalWidth || src.width || 0, sh = src.videoHeight || src.naturalHeight || src.height || 0; if (!sw || !sh) return; const sc = Math.max(W / sw, H / sh), dw = sw * sc, dh = sh * sc; ctx.drawImage(src, (W - dw) / 2, (H - dh) / 2, dw, dh); }
  /* the square itself now carries ONLY the slim bar: the active look name
     + a [🎛 Edit] button that unfolds the CAMERA PRO panel and scrolls to
     it. Every control moved into the panel — nothing is out of reach. */
  let camProBuilt = false;
  function camProBuild() {
    try {
      const w = camEls().wrap; if (!w) return;
      camProBuilt = true;
      if (!document.getElementById("dj-camfx")) { const fx = document.createElement("canvas"); fx.id = "dj-camfx"; fx.width = CAM_FX_W; fx.height = CAM_FX_W; w.appendChild(fx); }
      if (!document.getElementById("dj-cambar")) {
        const bar = document.createElement("div"); bar.id = "dj-cambar";
        bar.innerHTML = "<span id='dj-camlook'></span><button type='button' id='dj-camedit'>🎛 Edit</button>";
        w.appendChild(bar);
        bar.querySelector("#dj-camedit").addEventListener("click", () => camProOpen());
      }
      if (!w._campan) {
        w._campan = true;
        w.addEventListener("pointerdown", camPanDown);
        w.addEventListener("pointermove", camPanMove);
        w.addEventListener("pointerup", camPanUp);
        w.addEventListener("pointercancel", camPanUp);
      }
      camProWire();
      camProPaint();
    } catch (_) {}
  }
  function camProOpen() {
    const p = document.getElementById("dj-campro"); if (!p) return;
    p.hidden = false;
    const body = p.querySelector(".pfold");
    if (body && body.classList.contains("shut")) { const b = p.querySelector("h4 button"); if (b) b.click(); } // unfold it the way its own fold button would (state + label stay consistent)
    try { p.scrollIntoView({ behavior: "smooth", block: "start" }); } catch (_) { try { p.scrollIntoView(); } catch (__) {} }
  }
  function camProWire() {
    const p = document.getElementById("dj-campro"); if (!p || p._wired) return; p._wired = true;
    const looks = document.getElementById("cp-looks");
    if (looks) looks.innerHTML = Object.keys(CAM_LOOKS).map((k) => "<button type='button' class='cp-chip' data-look='" + k + "'>" + CAM_LOOKS[k].label + "</button>").join("");
    const bgs = document.getElementById("cp-bgs");
    if (bgs) bgs.innerHTML = [["off", "Off"], ["blur", "Blur"], ["brand", "Brand"], ["pic", "🖼 Pic"]].map((x) => "<button type='button' class='cp-chip' data-bg='" + x[0] + "'>" + x[1] + "</button>").join("");
    p.addEventListener("click", (ev) => { const b = ev.target.closest("[data-look],[data-bg]"); if (!b) return; if (b.hasAttribute("data-look")) camFxSetLook(b.getAttribute("data-look")); else camFxSetBg(b.getAttribute("data-bg")); });
    const fi = document.getElementById("dj-cambg-file");
    if (fi) fi.addEventListener("change", () => { const f = fi.files && fi.files[0]; try { fi.value = ""; } catch (_) {} if (f) camBgLoadFile(f); });
    // sliders: the value lands in camFx on input (applied next frame via
    // rAF, never synchronously in the gesture), persistence on release
    const wire = (id, valId, fmt, set) => {
      const el = document.getElementById(id), lab = document.getElementById(valId); if (!el) return;
      el.addEventListener("input", () => { set(+el.value); if (lab) lab.textContent = fmt(+el.value); camProReqApply(); });
      el.addEventListener("change", () => { camFxSave(); camProPaint(); });
    };
    const pct = (v) => Math.round(v * 100) + "%";
    wire("cp-b", "cp-b-v", pct, (v) => { camFx.b = v; });
    wire("cp-c", "cp-c-v", pct, (v) => { camFx.c = v; });
    wire("cp-s", "cp-s-v", pct, (v) => { camFx.s = v; });
    wire("cp-warm", "cp-warm-v", (v) => (v > 0 ? "+" + v : "" + v), (v) => { camFx.warm = v; });
    wire("cp-detail", "cp-detail-v", (v) => Math.round(v) + "%", (v) => { camFx.detail = v; });
    wire("cp-zoom", "cp-zoom-v", (v) => (Math.round(v * 100) / 100) + "×", (v) => { camFx.zoom = v; });
    wire("cp-blur", "cp-blur-v", (v) => Math.round(v) + "px", (v) => { camFx.blurPx = v; });
    wire("cp-edge", "cp-edge-v", (v) => (+v).toFixed(1), (v) => { camFx.feather = v; });
    const mb = document.getElementById("cp-mirror");
    if (mb) mb.addEventListener("click", () => { camFx.mirror = !camFx.mirror; camFxSave(); camProPaint(); });
    const rc = document.getElementById("cp-recenter");
    if (rc) rc.addEventListener("click", () => { camFx.panX = 0; camFx.panY = 0; camFxSave(); camProPaint(); });
    const bo = document.getElementById("cp-banner-on");
    if (bo) bo.addEventListener("change", () => { camFx.bannerOn = !!bo.checked; camFxSave(); camProPaint(); });
    const bt = document.getElementById("cp-banner-text");
    if (bt) { bt.addEventListener("input", () => { camFx.bannerText = bt.value.slice(0, 42); camProPaint(); }); bt.addEventListener("change", () => camFxSave()); }
  }
  function camProPaint() {
    try {
      document.querySelectorAll("#cp-looks .cp-chip").forEach((c) => c.classList.toggle("on", c.getAttribute("data-look") === camFx.look));
      document.querySelectorAll("#cp-bgs .cp-chip").forEach((c) => c.classList.toggle("on", c.getAttribute("data-bg") === camFx.bg));
      const bgsBox = document.getElementById("cp-bgs"); if (bgsBox) { bgsBox.classList.toggle("warming", fxWarming && camFx.bg !== "off"); bgsBox.classList.toggle("dead", fxBailed); }
      const setR = (id, val, valId, txt) => { const el = document.getElementById(id); if (el && document.activeElement !== el) el.value = val; const lab = document.getElementById(valId); if (lab && document.activeElement !== el) lab.textContent = txt; };
      setR("cp-b", camFx.b, "cp-b-v", Math.round(camFx.b * 100) + "%");
      setR("cp-c", camFx.c, "cp-c-v", Math.round(camFx.c * 100) + "%");
      setR("cp-s", camFx.s, "cp-s-v", Math.round(camFx.s * 100) + "%");
      setR("cp-warm", camFx.warm, "cp-warm-v", (camFx.warm > 0 ? "+" + camFx.warm : "" + camFx.warm));
      setR("cp-detail", camFx.detail, "cp-detail-v", Math.round(camFx.detail) + "%");
      setR("cp-zoom", camFx.zoom, "cp-zoom-v", (Math.round(camFx.zoom * 100) / 100) + "×");
      setR("cp-blur", camFx.blurPx, "cp-blur-v", Math.round(camFx.blurPx) + "px");
      setR("cp-edge", camFx.feather, "cp-edge-v", (+camFx.feather).toFixed(1));
      const mb = document.getElementById("cp-mirror"); if (mb) mb.textContent = camFx.mirror ? "🪞 Mirror: ON" : "🪞 Mirror: OFF";
      const bo = document.getElementById("cp-banner-on"); if (bo && document.activeElement !== bo) bo.checked = !!camFx.bannerOn;
      const bt = document.getElementById("cp-banner-text"); if (bt && document.activeElement !== bt) bt.value = camFx.bannerText;
      const lk = document.getElementById("dj-camlook"); if (lk) lk.textContent = (CAM_LOOKS[camFx.look] || CAM_LOOKS.off).label + (camFx.bg !== "off" ? " · BG " + camFx.bg : "") + (fxBailed ? " · BG unavailable on this device" : fxWarming && camFx.bg !== "off" ? " · warming up" : "");
      const bn = document.getElementById("dj-cambanner");
      if (bn) { const show = camFx.bannerOn && !!camFx.bannerText; bn.hidden = !show; if (show) { bn.textContent = camFx.bannerText; const wh = (camEls().wrap && camEls().wrap.clientHeight) || 0; if (wh) bn.style.fontSize = Math.max(9, Math.round(wh * 0.058)) + "px"; } }
      camProApplySurface();
      camSharpSync(true);
    } catch (_) {}
  }
  /* reframing by hand: while zoomed, dragging on the camera picture pans
     the framing (the content follows the finger); the same pan numbers
     drive the CSS transform on the video and the sampler in the pipe. */
  let camPanDrag = null;
  function camPanDown(ev) {
    if (SANDBOX || camFx.zoom <= 1.01) return;
    if (ev.target.closest("#dj-cambar, button, input, a, select, textarea")) return;
    const w = camEls().wrap; if (!w) return;
    camPanDrag = { id: ev.pointerId, x: ev.clientX, y: ev.clientY, px: camFx.panX, py: camFx.panY, w: w.clientWidth || 1, h: w.clientHeight || 1 };
    try { w.setPointerCapture(ev.pointerId); } catch (_) {}
  }
  function camPanMove(ev) {
    if (!camPanDrag || ev.pointerId !== camPanDrag.id) return;
    const mx = (1 - 1 / camFx.zoom) / 2; if (mx <= 0) return;
    camFx.panX = Math.min(1, Math.max(-1, camPanDrag.px + (ev.clientX - camPanDrag.x) / camPanDrag.w / mx));
    camFx.panY = Math.min(1, Math.max(-1, camPanDrag.py + (ev.clientY - camPanDrag.y) / camPanDrag.h / mx));
    camProApplySurface();
  }
  function camPanUp(ev) { if (!camPanDrag || (ev && ev.pointerId !== camPanDrag.id)) return; camPanDrag = null; camFxSave(); }
  function camFxSetLook(v) { const L = CAM_LOOKS[v]; if (!L) return; camFx.look = v; camFx.b = L.b; camFx.c = L.c; camFx.s = L.s; camFx.warm = L.w || 0; camFx.detail = L.d || 0; camFxSave(); camProPaint(); }
  function camFxSetBg(v) {
    if (["off", "blur", "brand", "pic"].indexOf(v) < 0) return;
    if (v === "pic" && !camBgImg) { camBgPick(); say("🖼 Pick a picture for your background."); return; }
    if (v === "pic" && camFx.bg === "pic") { camBgPick(); return; } // tap Pic again to change the picture
    camFx.bg = v; camFxSave(); camProPaint(); camFxMaybeStart(); fxLazyStart(); // an explicit background pick is the ONE lazy trigger for the engine
  }
  function camBgPick() { const fi = document.getElementById("dj-cambg-file"); if (fi) fi.click(); }
  function camBgLoadFile(f) {
    const url = URL.createObjectURL(f), im = new Image();
    im.onload = () => {
      URL.revokeObjectURL(url);
      const sc = Math.min(1, 1024 / Math.max(im.naturalWidth || 1, im.naturalHeight || 1));
      const cv = document.createElement("canvas"); cv.width = Math.max(1, Math.round((im.naturalWidth || 1) * sc)); cv.height = Math.max(1, Math.round((im.naturalHeight || 1) * sc));
      try { cv.getContext("2d").drawImage(im, 0, 0, cv.width, cv.height); } catch (_) {}
      let data = ""; try { data = cv.toDataURL("image/jpeg", 0.85); } catch (_) {}
      camBgImg = im; camBgImgURL = data;
      if (data) { try { localStorage.setItem("mw-cambg", data); } catch (_) { if (!camBgQuotaSaid) { camBgQuotaSaid = true; say("🖼 That picture is too big to save for next time — it still works for this session."); } } }
      camFx.bg = "pic"; camFxSave(); camProPaint(); camFxMaybeStart(); fxLazyStart(); // a picture pick is also an explicit background pick: the lazy engine trigger
    };
    im.onerror = () => { URL.revokeObjectURL(url); say("🖼 That picture would not load."); };
    im.src = url;
  }
  let fxBrand = null;
  function fxBrandCanvas() {
    if (fxBrand) return fxBrand;
    const W = 640, cv = document.createElement("canvas"); cv.width = W; cv.height = W; const c = cv.getContext("2d");
    const g = c.createLinearGradient(0, 0, 0, W); g.addColorStop(0, "#171106"); g.addColorStop(0.55, "#0a0a0c"); g.addColorStop(1, "#050505"); c.fillStyle = g; c.fillRect(0, 0, W, W);
    const rg = c.createRadialGradient(W / 2, W * 0.36, 40, W / 2, W * 0.36, W * 0.75); rg.addColorStop(0, "rgba(240,207,120,0.30)"); rg.addColorStop(1, "rgba(240,207,120,0)"); c.fillStyle = rg; c.fillRect(0, 0, W, W);
    c.fillStyle = "rgba(240,207,120,0.13)"; c.font = "800 300px Georgia, 'Times New Roman', serif"; c.textAlign = "center"; c.textBaseline = "middle"; c.fillText("MW", W / 2, W * 0.44);
    c.fillStyle = "rgba(240,207,120,0.55)"; c.font = "700 29px system-ui, sans-serif"; c.fillText("M E E C H I E ' S   W O R L D", W / 2, W * 0.88);
    fxBrand = cv; return cv;
  }
  /* ---- the background engine: warm-up at cam-on, WebGPU first,
     single-flight adaptive inference, render decoupled from inference ----
     Asset story (verified with real fetches at build time): the 1.19.2
     dist on jsDelivr carries ort.all.min.js — the bundle with BOTH the
     wasm and WebGPU backends registered — plus every wasm companion it
     can ask for (ort-wasm-simd-threaded.wasm/.mjs for the wasm backend,
     ort-wasm-simd-threaded.jsep.wasm/.mjs for the WebGPU/JSEP backend),
     all answering 200 from the same folder ort.env.wasm.wasmPaths points
     at. The WebGPU session is attempted first (only where navigator.gpu
     exists); ANY failure — no adapter, create throws — falls back to a
     wasm session, and if a WebGPU session creates but its first real
     inference throws, the pipe re-creates itself on wasm once instead
     of bailing. graphOptimizationLevel is "all" on both paths. */
  const ORT_CDN = "https://cdn.jsdelivr.net/npm/onnxruntime-web@1.19.2/dist/";
  const ORT_BUNDLE = "ort.all.min.js";
  const RVM_MODEL = "https://huggingface.co/LPDoctor/video_matting/resolve/main/rvm_mobilenetv3_fp32.onnx";
  const MP_CDN = "https://cdn.jsdelivr.net/npm/@mediapipe/selfie_segmentation@0.1.1675465747/";
  let fxEngine = null, fxEngineKind = "", fxEp = "", fxModelBuf = null, fxLoadP = null, fxStarting = false, fxWarming = false;
  let fxRun = false, fxLoopLive = false, fxRaf = 0, fxRenderNew = false, fxFails = 0, fxLastAt = 0, fxBailed = false, fxRec = null, fxOkOnce = false, fxDowngrading = false;
  let fxGpuFails = 0; // WebGPU init failures this page session (session create + first inference): at two, the engine latches off
  let fxSize = CAM_FX_W, fxEma = 0, fxSlow = 0, fxLastStep = 0;
  const FX_SIZES = [320, 256, 224];
  const fxSizeOk = { 320: true }; // a smaller size is only trusted once a real inference has run at it (fxWarmSizes)
  const fxProc = document.createElement("canvas"); fxProc.width = CAM_FX_W; fxProc.height = CAM_FX_W;
  const fxAlpha = document.createElement("canvas"); fxAlpha.width = CAM_FX_W; fxAlpha.height = CAM_FX_W;
  const fxPerson = document.createElement("canvas"); fxPerson.width = CAM_FX_W; fxPerson.height = CAM_FX_W;
  const fxOut = document.createElement("canvas"); fxOut.width = CAM_FX_W; fxOut.height = CAM_FX_W; // composites land here; the render loop blits to the visible canvas only when a new matte exists
  function loadScriptOnce(src) {
    return new Promise((resolve, reject) => {
      const old = document.querySelector("script[src='" + src + "']");
      if (old) { if (old.dataset.ok) { resolve(); return; } old.addEventListener("load", () => resolve()); old.addEventListener("error", () => reject(new Error("script " + src))); return; }
      const s = document.createElement("script"); s.src = src; s.async = true;
      s.onload = () => { s.dataset.ok = "1"; resolve(); };
      s.onerror = () => reject(new Error("script " + src));
      document.head.appendChild(s);
    });
  }
  /* recurrent states scale with the analysis square S: r1 [1,16,S/4,S/4],
     r2 [1,20,S/8,S/8], r3 [1,40,S/16,S/16], r4 [1,64,S/32,S/32] — at
     S=320 these are the shapes verified against the real model (python
     onnxruntime, 2026-10-29): r1 80, r2 40, r3 20, r4 10, and each run's
     r1o..r4o feed straight back as the next frame's r1i..r4i. */
  function fxRecFor(S) { const z = (c, h, w) => new ort.Tensor("float32", new Float32Array(c * h * w), [1, c, h, w]); return [z(16, S / 4, S / 4), z(20, S / 8, S / 8), z(40, S / 16, S / 16), z(64, S / 32, S / 32)]; }
  async function fxLoadRvm() {
    await loadScriptOnce(ORT_CDN + ORT_BUNDLE);
    if (!window.ort) throw new Error("ort missing");
    ort.env.wasm.wasmPaths = ORT_CDN;
    ort.env.wasm.numThreads = 1; // no cross-origin isolation on the page — single-thread wasm is the safe path
    const resp = await fetch(RVM_MODEL); if (!resp.ok) throw new Error("model http " + resp.status);
    const buf = await resp.arrayBuffer();
    fxModelBuf = buf;
    let sess = null, ep = "wasm";
    if (navigator.gpu) { try { sess = await ort.InferenceSession.create(buf, { executionProviders: ["webgpu"], graphOptimizationLevel: "all" }); ep = "webgpu"; } catch (_) { sess = null; fxGpuFails++; } } // a WebGPU init failure is counted: two of them latch the engine off for the page session (see fxInferLoop)
    if (!sess) sess = await ort.InferenceSession.create(buf.slice(0), { executionProviders: ["wasm"], graphOptimizationLevel: "all" });
    fxEp = ep;
    fxRec = fxRecFor(fxSize);
    return { kind: "rvm", sess };
  }
  async function fxLoadMp() {
    await loadScriptOnce(MP_CDN + "selfie_segmentation.js");
    if (!window.SelfieSegmentation) throw new Error("mediapipe missing");
    const seg = new SelfieSegmentation({ locateFile: (f) => MP_CDN + f });
    seg.setOptions({ modelSelection: 1 });
    const eng = { kind: "mp", seg, waiters: [], maskMode: "" };
    seg.onResults((r) => { const ws = eng.waiters.splice(0); ws.forEach((fn) => { try { fn(r); } catch (_) {} }); });
    return eng;
  }
  function fxLoadEngine() {
    if (fxEngine) return Promise.resolve(fxEngine);
    if (fxLoadP) return fxLoadP;
    fxLoadP = (async () => {
      try { fxEngine = await fxLoadRvm(); fxEngineKind = "rvm"; }
      catch (e1) { fxEngine = await fxLoadMp(); fxEngineKind = "mp"; }
      return fxEngine;
    })();
    fxLoadP.catch(() => { fxLoadP = null; });
    return fxLoadP;
  }
  /* warm-up priming (runs inside fxLazyStart, once the lazily loaded
     engine exists — never at cam-on): one blank-frame inference per
     size, ONE SIZE PER IDLE SLICE, so priming never lands as one long
     main-thread block on the phone that is also playing his music.
     The 320 run primes the session; the 256/224 runs PROVE the model's
     dynamic axes accept those inputs before the adaptive ladder is
     allowed to step down to them. */
  function fxIdleSlice() { return new Promise((res) => { if ("requestIdleCallback" in window) { try { requestIdleCallback(() => res(), { timeout: 1200 }); return; } catch (_) {} } setTimeout(res, 60); }); }
  async function fxWarmSizes() {
    const sess = fxEngine && fxEngine.sess; if (!sess || !window.ort) return;
    let firstSize = true;
    for (const S of FX_SIZES) {
      if (!firstSize) await fxIdleSlice();
      firstSize = false;
      try {
        const rec = fxRecFor(S);
        const srcT = new ort.Tensor("float32", new Float32Array(3 * S * S), [1, 3, S, S]);
        const feeds = { src: srcT, r1i: rec[0], r2i: rec[1], r3i: rec[2], r4i: rec[3], downsample_ratio: new ort.Tensor("float32", new Float32Array([0.5]), [1]) };
        const out = await sess.run(feeds);
        fxSizeOk[S] = true;
        try { srcT.dispose(); feeds.downsample_ratio.dispose(); Object.keys(out).forEach((k) => { if (out[k] && out[k].dispose) out[k].dispose(); }); rec.forEach((t) => { if (t && t.dispose) t.dispose(); }); } catch (_) {}
      } catch (_) { fxSizeOk[S] = false; }
    }
    try { if (fxRec) fxRec.forEach((t) => { if (t && t.dispose) t.dispose(); }); } catch (_) {}
    fxRec = fxRecFor(fxSize); // the real feed starts from clean recurrent states
  }
  /* LAZY ENGINE START (owner crash report, 2026-10-29: "my camera keeps
     making my site crash"): the segmentation engine — the ORT script,
     the 15MB model, session creation — loads ONLY here, and this runs
     ONLY from an explicit background pick (camFxSetBg / camBgLoadFile).
     Cam-on never touches it; the plain camera and every CSS/SVG look
     run with zero engine involvement. The load runs in the background
     while the plain camera keeps showing; when it lands, the chosen
     mode swaps in. Any failure LATCHES (camFxBail): the engine disables
     itself for the rest of the page session and never retries. */
  function fxLazyStart() {
    if (fxEngine || fxBailed || fxStarting) return;
    if (camFx.bg === "off" || !camStream) return;
    fxStarting = true; fxWarming = true; camProPaint();
    fxLoadEngine().then(async (eng) => {
      fxStarting = false;
      if (!eng) { camFxBail(); return; }
      if (eng.kind === "rvm") { try { await fxWarmSizes(); } catch (_) {} if (fxSizeOk[320] === false) { camFxBail(); return; } } // the warm-up prime at 320 threw: this session cannot be trusted — latch off
      fxWarming = false;
      if (camStream && !fxBailed && camFx.bg !== "off") { fxRun = true; fxSwapIn(); }
      camProPaint();
    }).catch(() => { fxStarting = false; camFxBail(); }); // session creation threw on both engines: latch off for the page session, the plain camera keeps running
  }
  async function fxMatteRvm() {
    const W = fxSize, sess = fxEngine.sess;
    const img = fxProc.getContext("2d").getImageData(0, 0, W, W).data;
    const inp = new Float32Array(3 * W * W), n = W * W;
    for (let i = 0; i < n; i++) { inp[i] = img[i * 4] / 255; inp[n + i] = img[i * 4 + 1] / 255; inp[2 * n + i] = img[i * 4 + 2] / 255; }
    const srcT = new ort.Tensor("float32", inp, [1, 3, W, W]);
    const feeds = { src: srcT, r1i: fxRec[0], r2i: fxRec[1], r3i: fxRec[2], r4i: fxRec[3], downsample_ratio: new ort.Tensor("float32", new Float32Array([0.5]), [1]) };
    const out = await sess.run(feeds);
    const prev = fxRec; fxRec = [out.r1o, out.r2o, out.r3o, out.r4o];
    const pha = out.pha.data, actx = fxAlpha.getContext("2d"), aim = actx.createImageData(W, W);
    for (let i = 0; i < n; i++) { const a = pha[i]; aim.data[i * 4 + 3] = a <= 0 ? 0 : a >= 1 ? 255 : Math.round(a * 255); }
    actx.putImageData(aim, 0, 0);
    try { srcT.dispose(); feeds.downsample_ratio.dispose(); out.fgr.dispose(); out.pha.dispose(); prev.forEach((t) => { if (t && t.dispose) t.dispose(); }); } catch (_) {}
  }
  function fxMatteMp() {
    return new Promise((resolve) => {
      const eng = fxEngine; let done = false;
      const finish = (r) => {
        if (done) return; done = true;
        try {
          if (!r || !r.segmentationMask) { resolve(false); return; }
          const W = fxSize, actx = fxAlpha.getContext("2d");
          actx.save(); actx.globalCompositeOperation = "copy"; actx.drawImage(r.segmentationMask, 0, 0, W, W); actx.restore();
          // the mask packet carries the matte in its alpha channel on some
          // builds and in the red channel on others — detect once, then
          // normalize to the same alpha-only form the RVM path produces.
          const md = actx.getImageData(0, 0, W, W), px = md.data;
          if (!eng.maskMode) { let aVar = false; const a0 = px[3]; for (let i = 0; i < px.length; i += 1604) { if (px[i + 3] !== a0) { aVar = true; break; } } eng.maskMode = aVar ? "a" : "r"; }
          const useA = eng.maskMode === "a";
          for (let i = 0; i < px.length; i += 4) { const a = useA ? px[i + 3] : px[i]; px[i] = 0; px[i + 1] = 0; px[i + 2] = 0; px[i + 3] = a; }
          actx.putImageData(md, 0, 0);
          resolve(true);
        } catch (_) { resolve(false); }
      };
      eng.waiters.push(finish);
      try { const p = eng.seg.send({ image: fxProc }); if (p && p.catch) p.catch(() => finish(null)); } catch (_) { finish(null); }
      setTimeout(() => finish(null), 2500);
    });
  }
  function fxComposite() {
    const S = fxSize, W = CAM_FX_W, octx = fxOut.getContext("2d");
    if (camFx.bg === "blur") { octx.save(); try { octx.filter = "blur(" + camFx.blurPx + "px) brightness(0.85)"; } catch (_) {} const m = Math.ceil(camFx.blurPx * 2); octx.drawImage(fxProc, 0, 0, S, S, -m, -m, W + 2 * m, W + 2 * m); octx.restore(); }
    else if (camFx.bg === "brand") { octx.drawImage(fxBrandCanvas(), 0, 0, W, W); }
    else if (camFx.bg === "pic" && camBgImg) { octx.save(); octx.clearRect(0, 0, W, W); drawCover(octx, camBgImg, W, W); octx.restore(); }
    else { octx.clearRect(0, 0, W, W); }
    const pctx = fxPerson.getContext("2d");
    pctx.save(); pctx.globalCompositeOperation = "copy"; pctx.drawImage(fxProc, 0, 0);
    pctx.globalCompositeOperation = "destination-in"; try { pctx.filter = "blur(" + camFx.feather + "px)"; } catch (_) {} pctx.drawImage(fxAlpha, 0, 0); pctx.restore();
    octx.drawImage(fxPerson, 0, 0, S, S, 0, 0, W, W);
    fxRenderNew = true;
  }
  /* one inference: sample the CURRENT frame (there is no queue — the
     loop always works on the latest picture), matte it, composite it.
     Returns false when the feed is not ready (neutral — not a failure). */
  async function fxInferOnce() {
    const v = camEls().vid;
    if (!camStream || !v || v.readyState < 2) return false;
    drawFramed(fxProc.getContext("2d"), v, fxSize, fxSize);
    if (fxEngineKind === "rvm") await fxMatteRvm();
    else { const ok = await fxMatteMp(); if (!ok) throw new Error("matte"); }
    fxComposite();
    return true;
  }
  /* a WebGPU session that created fine can still throw on its first
     real run (an op the GPU backend rejects) — rebuild on wasm ONCE
     rather than killing the background over it. */
  async function fxDowngradeWasm() {
    if (fxDowngrading || !fxModelBuf || !window.ort) return false;
    fxDowngrading = true;
    try {
      fxEngine.sess = await ort.InferenceSession.create(fxModelBuf.slice(0), { executionProviders: ["wasm"], graphOptimizationLevel: "all" });
      fxEp = "wasm";
      try { if (fxRec) fxRec.forEach((t) => { if (t && t.dispose) t.dispose(); }); } catch (_) {}
      fxRec = fxRecFor(fxSize);
      return true;
    } catch (_) { return false; }
    finally { fxDowngrading = false; }
  }
  function fxSetSize(S) {
    fxSize = S;
    [fxProc, fxAlpha, fxPerson].forEach((cv) => { cv.width = S; cv.height = S; });
    if (fxEngineKind === "rvm" && window.ort) { try { if (fxRec) fxRec.forEach((t) => { if (t && t.dispose) t.dispose(); }); } catch (_) {} fxRec = fxRecFor(S); }
    fxEma = 0; fxSlow = 0;
  }
  function fxAdapt(ms) {
    fxEma = fxEma ? fxEma * 0.85 + ms * 0.15 : ms;
    fxSlow = fxEma > 55 ? fxSlow + 1 : 0;
    if (fxSlow < 30 || Date.now() - fxLastStep < 2000) return;
    const ix = FX_SIZES.indexOf(fxSize);
    const next = FX_SIZES.slice(ix + 1).find((s) => fxEngineKind !== "rvm" || fxSizeOk[s]);
    if (next) { fxSetSize(next); fxLastStep = Date.now(); }
    fxSlow = 0;
  }
  /* inference loop: single-flight, self-paced by rAF so the main thread
     (and with it the booth audio) breathes between mattes. */
  function fxInferLoop() {
    (async () => {
      while (fxRun) {
        let ok = false, failed = false;
        const t0 = performance.now();
        try { ok = await fxInferOnce(); }
        catch (e) {
          if (fxEngineKind === "rvm" && fxEp === "webgpu" && !fxOkOnce) { fxGpuFails++; if (fxGpuFails >= 2) { camFxBail(); break; } if (await fxDowngradeWasm()) { ok = false; } else failed = true; }
          else failed = true;
        }
        if (!fxRun) break;
        if (ok) { fxOkOnce = true; fxFails = 0; fxLastAt = Date.now(); fxAdapt(performance.now() - t0); }
        else if (failed && Date.now() - fxLastAt > 8000) { fxFails++; if (fxFails >= 5) { camFxBail(); break; } }
        await new Promise((r) => requestAnimationFrame(r));
      }
    })();
  }
  /* render loop: a bare blit, and only when a fresh composite exists —
     a slow matte lowers the picture rate, it never piles up work. */
  function fxRenderLoop() {
    if (!fxRun) return;
    if (fxRenderNew) {
      fxRenderNew = false;
      const out = document.getElementById("dj-camfx");
      if (out) { const c = out.getContext("2d"); c.clearRect(0, 0, CAM_FX_W, CAM_FX_W); c.drawImage(fxOut, 0, 0); }
    }
    if (fxRun) fxRaf = requestAnimationFrame(fxRenderLoop);
  }
  function fxStartLoops() {
    if (fxLoopLive) return; fxLoopLive = true;
    fxRenderNew = false;
    fxInferLoop();
    cancelAnimationFrame(fxRaf); fxRaf = requestAnimationFrame(fxRenderLoop);
  }
  function fxSwapIn() {
    fxWarming = false;
    const w = camEls().wrap; if (w) w.classList.add("fxbg");
    camProApplySurface();
    if (fxEngineKind === "rvm" && window.ort) { try { if (fxRec) fxRec.forEach((t) => { if (t && t.dispose) t.dispose(); }); } catch (_) {} fxRec = fxRecFor(fxSize); }
    fxFails = 0; fxLastAt = Date.now(); fxEma = 0; fxSlow = 0;
    fxStartLoops();
  }
  function camFxMaybeStart() {
    camProBuild(); camProPaint();
    if (camFx.bg === "off" || fxBailed) { camFxStopPipe(); return; }
    if (!camStream) return; // the stream-start hook calls back in when the camera is live
    if (fxEngine) { fxRun = true; fxSwapIn(); return; } // engine already loaded this session: a BG pick only flips the mode — no load, no spike, no skip
    /* engine not loaded: this function NEVER starts the load (the crash
       rule — cam-on and stream start stay engine-free). fxLazyStart,
       called from the BG pick handlers, owns the load; until it lands
       the chips just reflect whether a load is already in flight. */
    fxWarming = !!fxStarting; camProPaint();
  }
  function camFxStopPipe() { fxRun = false; fxWarming = false; fxLoopLive = false; cancelAnimationFrame(fxRaf); const w = camEls().wrap; if (w) w.classList.remove("fxbg"); camProApplySurface(); }
  function camFxBail() { camFxStopPipe(); fxBailed = true; say("📷 Background FX could not run on this device — showing the plain camera."); }
  function camFxOnStream() { camProPaint(); camFxMaybeStart(); } // stream start paints and notes any persisted BG pick — it NEVER loads the engine (fxLazyStart is pick-only)
  function camFxOnStop() { camFxStopPipe(); }
  /* ---- frame relay: the lead booth publishes a fresh still of him
   * every ~4s while he is on cam and the station is live, into its OWN
   * radio/camframe doc ({frame, frameAt, at}) — S.vcam in radio/dj is
   * back to just {on, at}, so the ~46KB frame no longer re-ships on
   * every booth save and every listener poll. The capture composes
   * what he SEES: the framed,
   * mirrored picture (the pipeline bitmap when a background is up, a
   * drawFramed sample of the raw feed when it is not), the look when it
   * is plain CSS functions (canvas filters cannot resolve SVG-reference
   * looks, so Duotone/Detail stay booth-side), then his banner — and
   * encodes through async convertToBlob so the JPEG work never blocks
   * the thread his music plays on. ---- */
  let camFrameLast = 0, camFrameBusy = false;
  const camCap = document.createElement("canvas"); camCap.width = 320; camCap.height = 320;
  function camDrawBanner(ctx, W) {
    if (!camFx.bannerOn || !camFx.bannerText) return;
    const h = Math.round(W * 0.115);
    ctx.save();
    ctx.fillStyle = "#f0cf78"; ctx.fillRect(0, W - h, W, h);
    ctx.fillStyle = "#0b0a08"; ctx.textAlign = "center"; ctx.textBaseline = "middle";
    let fs = Math.round(h * 0.52);
    ctx.font = "800 " + fs + "px system-ui, sans-serif";
    while (fs > 9 && ctx.measureText(camFx.bannerText).width > W - 16) { fs -= 1; ctx.font = "800 " + fs + "px system-ui, sans-serif"; }
    ctx.fillText(camFx.bannerText, W / 2, W - h / 2 + 1);
    ctx.restore();
  }
  function camFrameTick() {
    try {
      if (!boothLead || !camStream || !S.live || !S.vcam || !S.vcam.on) return;
      const now = Date.now(); if (now - camFrameLast < 4000 || camFrameBusy) return;
      const w = camEls().wrap, v = camEls().vid; if (!v) return;
      const bgOn = !!(w && w.classList.contains("fxbg"));
      if (!bgOn && v.readyState < 2) return;
      camFrameLast = now;
      const ctx = camCap.getContext("2d");
      const css = camFilterCss();
      try { ctx.filter = (css && css.indexOf("url(") < 0) ? css : "none"; } catch (_) {}
      if (bgOn) ctx.drawImage(fxOut, 0, 0); else drawFramed(ctx, v, 320, 320);
      try { ctx.filter = "none"; } catch (_) {}
      camDrawBanner(ctx, 320);
      camFrameBusy = true;
      const publish = (url) => { camFrameBusy = false; if (!url || url.length > 60000) return; if (!S.vcam || !S.vcam.on) return; try { const d = DBF(); if (d) { const p = d.doc("radio/camframe").set({ frame: url, frameAt: now, at: S.vcam.at || now }); if (p && p.catch) p.catch(() => {}); } } catch (_) {} };
      if (camCap.convertToBlob) {
        let q = 0.62;
        const step = () => {
          camCap.convertToBlob((blob) => {
            if (!blob) { publish(""); return; }
            if (blob.size > 34500 && q > 0.3) { q = Math.round((q - 0.08) * 100) / 100; step(); return; } // ~34.5KB of JPEG lands at ~46KB as a data URL
            const rd = new FileReader(); rd.onload = () => publish(String(rd.result || "")); rd.onerror = () => publish(""); rd.readAsDataURL(blob);
          }, "image/jpeg", q);
        };
        step();
      } else {
        let q = 0.62, url = camCap.toDataURL("image/jpeg", q);
        while (url.length > 46000 && q > 0.3) { q = Math.round((q - 0.08) * 100) / 100; url = camCap.toDataURL("image/jpeg", q); }
        publish(url);
      }
    } catch (_) { camFrameBusy = false; }
  }
  /* ---- the viewer square on the pop-out master screen: small, bottom-
   * right by default, draggable anywhere over the screen, position kept
   * per viewer as fractions of the screen; the ✕ hides it for the rest
   * of that cam session (keyed to S.vcam.at) and the next cam-on — a
   * new S.vcam.at — brings it back. ---- */
  let camOvPos = { fx: 1, fy: 1 };
  try { const p = JSON.parse(localStorage.getItem("mw-camov-pos") || "null"); if (p && isFinite(+p.fx) && isFinite(+p.fy)) camOvPos = { fx: Math.min(1, Math.max(0, +p.fx)), fy: Math.min(1, Math.max(0, +p.fy)) }; } catch (_) {}
  let camOvDrag = null, camOvFrameAt = 0;
  let camFrameDoc = null; // the latest radio/camframe doc ({frame, frameAt, at}), filled by the init() subscription — the viewer square reads frames from here, never from radio/dj
  let camOvPlaceKey = "";
  function camOvPlace() {
    const ov = document.getElementById("mw-camov"); if (!ov || !ov.parentElement) return;
    const st = ov.parentElement, pw = st.clientWidth, ph = st.clientHeight;
    if (!pw) return;
    /* the placement only depends on the parent size, the saved position
       and which frame is up — when none of those changed, skip the
       getBoundingClientRect (a forced layout read that used to run on
       every state echo and every 700ms mini pass) */
    const key = pw + "x" + ph + "|" + camOvPos.fx + "|" + camOvPos.fy + "|" + camOvFrameAt;
    if (key === camOvPlaceKey) return;
    const or2 = ov.getBoundingClientRect();
    if (!or2.width) return;
    camOvPlaceKey = key;
    ov.style.left = Math.round(camOvPos.fx * Math.max(0, pw - or2.width)) + "px";
    ov.style.top = Math.round(camOvPos.fy * Math.max(0, ph - or2.height)) + "px";
  }
  function camOvWire() {
    const ov = document.getElementById("mw-camov"); if (!ov || ov._wired) return; ov._wired = true;
    const x = document.getElementById("mw-camov-x");
    if (x) {
      x.addEventListener("pointerdown", (ev) => { ev.stopPropagation(); });
      x.addEventListener("click", (ev) => { ev.stopPropagation(); try { sessionStorage.setItem("mw-camov-hide", String((S.vcam && S.vcam.at) || 0)); } catch (_) {} ov.hidden = true; });
    }
    ov.addEventListener("pointerdown", (ev) => {
      const st = ov.parentElement; if (!st) return;
      const or2 = ov.getBoundingClientRect();
      camOvDrag = { id: ev.pointerId, dx: ev.clientX - or2.left, dy: ev.clientY - or2.top };
      try { ov.setPointerCapture(ev.pointerId); } catch (_) {}
      ev.preventDefault();
    });
    ov.addEventListener("pointermove", (ev) => {
      if (!camOvDrag || ev.pointerId !== camOvDrag.id) return;
      const st = ov.parentElement; if (!st) return;
      const sr = st.getBoundingClientRect(), or2 = ov.getBoundingClientRect(), pw = st.clientWidth, ph = st.clientHeight;
      let nx = ev.clientX - (sr.left + st.clientLeft) - camOvDrag.dx, ny = ev.clientY - (sr.top + st.clientTop) - camOvDrag.dy;
      nx = Math.max(0, Math.min(nx, Math.max(0, pw - or2.width)));
      ny = Math.max(0, Math.min(ny, Math.max(0, ph - or2.height)));
      ov.style.left = Math.round(nx) + "px"; ov.style.top = Math.round(ny) + "px";
      camOvPos = { fx: pw - or2.width > 0 ? nx / (pw - or2.width) : 1, fy: ph - or2.height > 0 ? ny / (ph - or2.height) : 1 };
    });
    const end = (ev) => { if (camOvDrag && (!ev || ev.pointerId === camOvDrag.id)) { camOvDrag = null; try { localStorage.setItem("mw-camov-pos", JSON.stringify(camOvPos)); } catch (_) {} } };
    ov.addEventListener("pointerup", end);
    ov.addEventListener("pointercancel", () => end(null));
  }
  function camOvSync() {
    try {
      const ov = document.getElementById("mw-camov"); if (!ov) return;
      camOvWire();
      const vc = S.vcam || {};
      let hideFor = ""; try { hideFor = sessionStorage.getItem("mw-camov-hide") || ""; } catch (_) {}
      const fd = camFrameDoc || {}; // frame + frameAt + the cam-session stamp ride the frame doc now; a frame only counts while its session stamp matches the live S.vcam.at
      const fresh = !!vc.on && String(fd.at || 0) === String(vc.at || 0) && typeof fd.frame === "string" && fd.frame.indexOf("data:image/") === 0 && +fd.frameAt > 0 && (Date.now() - +fd.frameAt) <= 15000 && String(vc.at || 0) !== hideFor;
      if (!fresh) { ov.hidden = true; return; }
      if (camOvFrameAt !== +fd.frameAt) { const img = document.getElementById("mw-camov-img"); if (img) img.src = fd.frame; camOvFrameAt = +fd.frameAt; }
      ov.hidden = false;
      if (!camOvDrag) camOvPlace();
    } catch (_) {}
  }
  function levels() {
    const duck = (S.duck || (voiceEl && !voiceEl.paused) || micHot > 0.04 || Date.now() < dropDuckUntil) ? 0.28 : 1;
    const mix = listening && !OWNER() ? mixVol : 1;
    DECKS.forEach((k) => { if (decks[k]) { const cd = k === "C" || k === "D", x = cd ? (S.xf2 ?? 0.5) : S.xf, side = k === "B" || k === "D" ? "B" : "A", py = S.panY || 0, pairG = cd ? (py < 0 ? 1 + py : 1) : (py > 0 ? 1 - py : 1); decks[k].vol((S[k].vol ?? 0.9) * xfGain(x, side) * pairG * pairXGain(S.panX, cd) * duck * mix); } });
    stageApply(mix, duck);
  }
  /* ================= GO LIVE STUDIO (owner, 2026-10-29) =================
   * "I want to use OBS system right there — it doesn't crash, neither does
   * TikTok. I want TikTok with OBS features." The booth now publishes REAL
   * live video over WebRTC (Cloudflare RealtimeKit — the same gateway as
   * the OBS keys in functions/api/streams.js, which mints the participant
   * tokens server-side; the API token never reaches a browser).
   * Two sources, one master screen:
   *   📹 Live Video (the button beside 📷 Cam) — his booth camera in full
   *      motion. This is the primary camera picture while it runs; the
   *      radio/camframe still-frame relay keeps working untouched as the
   *      picture whenever Live Video is off.
   *   🖥 Capture My Screen (a button beside EVERY Blackout button) — he
   *      picks a tab / window / screen in the browser's own picker and
   *      that screen becomes the master-screen source.
   * The shared switch is S.vstream {on, kind, at, by, meeting}: screen
   * outranks camera stream, camera stream outranks the vmix deck videos,
   * and the deck mix keeps rendering underneath, so stopping the stream
   * drops the stage straight back to the mix. SOUND follows the
   * MASTER-SCREEN RULE (owner, 2026-10-29): whatever is on the master
   * screen takes over the radio — a screen share pauses the tables and
   * carries the capture's OWN audio when the pick provides it (tab
   * audio; window/full-screen picks usually cannot), and that audio is
   * the only sound on the watch surfaces while the master is up.
   * LIGHTNESS (he is crash- and skip-sensitive): the RealtimeKit SDK
   * (~650KB) loads ONLY on a Live Video / Capture tap — never at page
   * load, never at cam-on — publishing is capped at 720p, and everything
   * is native WebRTC: no on-device ML, no canvas frame loops here. Any
   * failure answers in plain words and disturbs nothing else. */
  const VS_SDK_URL = "https://cdn.jsdelivr.net/npm/@cloudflare/realtimekit@2.0.4/dist/browser.js";
  let vsSdkP = null;          // SDK load promise — created on first tap only
  let vsPub = null;           // this tab is publishing: {meeting, mid, kind, ownStream, beat}
  let vsPubBusy = false;
  let vsWatch = null;         // this tab is watching: {meeting, mid, got, iv, triedAt}
  let vsWatchBusy = false;
  let vsWatchRetryMid = "";   // meeting whose watch join failed — retried about every 20s while the switch stays on (the old mid:at latch never retried at all, because the stamp never changes during a session)
  let vsWatchRetryAt = 0;
  /* OBS STUDIO crop (owner, 2026-10-29): percent of frame trimmed per side
   * plus how the cropped frame meets the stage — Fit shows it whole with
   * black bars, Fill covers the stage. Per device, kept across sessions. */
  let vsCrop = { l: 0, r: 0, t: 0, b: 0, fill: false };
  try { const c0 = JSON.parse(localStorage.getItem("mw-studio-crop") || "null"); if (c0) vsCrop = { l: Math.max(0, Math.min(45, +c0.l || 0)), r: Math.max(0, Math.min(45, +c0.r || 0)), t: Math.max(0, Math.min(45, +c0.t || 0)), b: Math.max(0, Math.min(45, +c0.b || 0)), fill: !!c0.fill }; } catch (_) {}
  let vsCropCtx = null;       // the running crop canvas: {vid, cv, cx, raf, rvfc, dead}
  let vsStudioSig = "";
  let vsShown = { track: null, stream: null, hls: null, atrack: null };
  let vsWatchErr = "";        // the watcher's last failure, in plain words - the TV status line reads it out instead of the watch dying silent
  let vsStatusTxt = null;     // last text painted into the .vstatus lines
  let vsPaintSig = null;
  const vsUid = () => { const s = mySess(); return (s && s.user && s.user.id) || ""; };
  const vsBroadcast = () => { const v = S.vstream || {}; return !SANDBOX && !!v.on && !!v.meeting; }; // SHARING = LIVE (owner, 2026-10-29: "if im sharing im still live"): a live stream switch lights every LIVE surface, radio switch or not
  const vsArrivedAt = Date.now();   // this page's arrival — the live-share pop-out sequences itself a few seconds after it, and never over the welcome video
  /* the mini's close button lives in the build region (it runs before this
   * block), so the dismissal hook travels on window: closing the mini WHILE
   * the share is what it shows dismisses the pop for THIS share only
   * (keyed by meeting id) and lifts the session mini-off the close set, so
   * a later, different share can pop again */
  try { window.MW_vsDismiss = () => { try { const st = document.querySelector("#dj-mini .vstage"); if (st && st.classList.contains("vs-on")) { sessionStorage.setItem("mw_vs_dismissed", (S.vstream || {}).meeting || ""); sessionStorage.removeItem("mw_mini_off"); } } catch (_) {} }; } catch (_) {}
  function vsPopReady() {
    if (SANDBOX || OWNER() || vsPub) return false;
    if (window._welcomeOn) return false;              // Meechie's welcome video owns the screen while it plays
    if (Date.now() - vsArrivedAt < 6000) return false; // the greeting lands first
    try { if (sessionStorage.getItem("mw_vs_dismissed") === ((S.vstream || {}).meeting || "")) return false; } catch (_) {}
    return true;
  }
  function vsLoadSdk() {
    if (window.RealtimeKitClient) return Promise.resolve(true);
    // a script tag that neither loads nor errors (a blocked or hung CDN)
    // otherwise leaves this promise pending forever and every later watch
    // waits on it in silence - the 12s watchdog resolves it as a failure
    // and clears the latch so the next retry starts clean
    if (!vsSdkP) vsSdkP = new Promise((res) => { const s = document.createElement("script"); let done = false; const fin = (ok) => { if (done) return; done = true; if (!ok) vsSdkP = null; res(ok); }; s.src = VS_SDK_URL; s.onload = () => fin(!!window.RealtimeKitClient); s.onerror = () => fin(false); document.head.appendChild(s); setTimeout(() => fin(!!window.RealtimeKitClient), 12000); });
    return vsSdkP;
  }
  async function vsApi(body) {
    const ses = mySess(); const h = { "content-type": "application/json" };
    if (ses && ses.access_token) h.authorization = "Bearer " + ses.access_token;
    try { const ctl = (typeof AbortController !== "undefined") ? new AbortController() : null; const to = ctl ? setTimeout(() => { try { ctl.abort(); } catch (_) {} }, 12000) : 0; const r = await fetch("/api/streams", { method: "POST", headers: h, body: JSON.stringify(body), signal: ctl ? ctl.signal : undefined }); if (to) clearTimeout(to); return await r.json().catch(() => null); } catch (_) { return null; }
  }
  function vsStageEls() {
    const out = [];
    const b = document.querySelector("#dj-vstage"); if (b) out.push(b);
    const s = document.querySelector("#st-ytbox .vstage"); if (s) out.push(s);
    const m = document.querySelector("#dj-mini .vstage"); if (m) out.push(m);
    const t = document.querySelector("#tw-stage"); if (t) out.push(t);
    const w = document.querySelector("#wb-stage"); if (w) out.push(w);
    return out;
  }
  function vsVid(stage) { let v = stage.querySelector("video.vslive"); if (!v) { v = document.createElement("video"); v.className = "vslive"; v.autoplay = true; v.muted = true; v.playsInline = true; stage.appendChild(v); } return v; }
  function vsKillHls(v) { if (!v) return; if (v._vsHls) { try { v._vsHls.destroy(); } catch (_) {} v._vsHls = null; } if (v._vsHlsUrl) { v._vsHlsUrl = ""; try { v.pause(); v.removeAttribute("src"); v.load(); } catch (_) {} } }
  function vsAttach(stream) { vsStageEls().forEach((st) => { const v = vsVid(st); try { vsKillHls(v); v.muted = true; if (v.srcObject !== stream) { v.srcObject = stream; const p = v.play(); if (p && p.catch) p.catch(() => {}); } } catch (_) {} st.classList.add("vs-on"); }); } // picture elements never sound on the WebRTC path — the one audio element (vsAudioPlay) carries the capture's sound, so surfaces cannot echo
  function vsDetach() { vsShown = { track: null, stream: null, hls: null, atrack: null }; try { vsAudioStop(); } catch (_) {} vsHlsSndEl = null; vsStageEls().forEach((st) => { st.classList.remove("vs-on"); const v = st.querySelector("video.vslive"); if (v) { try { vsKillHls(v); v.pause(); v.srcObject = null; } catch (_) {} } }); }
  function vsShowTrack(track, atrack) {
    if (!track || track.readyState === "ended") { if (vsShown.track) vsDetach(); return; }
    if (vsShown.track !== track || vsShown.atrack !== (atrack || null)) vsShown = { track, stream: new MediaStream([track]), hls: null, atrack: atrack || null };
    vsAttach(vsShown.stream);
    vsAudioPlay(atrack || null);
  }
  /* ---------- the capture's sound, viewer side ----------
   * While the master screen is up, its audio IS the station sound (the
   * radio is paused by the takeover). On the WebRTC path the sound
   * rides ONE body-level audio element fed by the producer's audio
   * track alone — the stage videos stay muted, because three surfaces
   * showing one picture must never echo it. A browser may refuse
   * unmuted playback before the viewer has tapped anything on the
   * page: the play attempt is honest, a refused one is flagged, and
   * the viewer's first tap anywhere retries it (the gesture every
   * platform accepts). On the HLS path the sound rides the stage
   * element itself — see vsHlsPickSound. */
  let vsSndBlocked = false;
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
  /* ---------- VIEWER PAUSE = LOCAL MUTE (owner, 2026-10-29) ----------
   * "If they want to pause it for them they can click pause only to
   * mute it." A watcher's pause is THEIRS alone: it pauses the picture
   * on their screen (the surfaces fall back to the video mix, exactly
   * like the hidden share does) and mutes their sound — the capture
   * audio element, and the radio engine too if they were listening.
   * It writes NO shared state, never touches the broadcast, the
   * publisher, or any other viewer. Unpausing rejoins the LIVE edge —
   * the sweep re-reads the room and re-attaches what is live NOW;
   * nothing is time-shifted, because nothing was ever buffered. */
  let vsLocalPause = false, vsPauseWasListening = false, vsPauseSig = "";
  function vsLocalDetach() {
    vsStageEls().forEach((st) => { st.classList.remove("vs-on"); const v = st.querySelector("video.vslive"); if (v) { try { vsKillHls(v); } catch (_) {} try { v.pause(); } catch (_) {} } });
    try { const a = document.getElementById("vs-audio"); if (a) a.pause(); } catch (_) {}
    if (vsHlsSndEl) { try { vsHlsSndEl.muted = true; } catch (_) {} vsHlsSndEl = null; }
  }
  function vsToggleLocalPause() {
    if (SANDBOX || OWNER() || vsPub) return;
    const ti = document.getElementById("tune-in");
    if (!vsLocalPause) {
      vsLocalPause = true;
      vsPauseWasListening = listening;
      vsLocalDetach();
      if (listening) { stopListening(); if (ti) ti.textContent = "▶ Tune in"; tvSig = ""; try { tvPaint(); } catch (_) {} }
    } else {
      vsLocalPause = false;
      if (vsPauseWasListening && !listening) { startListening(); if (ti) ti.textContent = "❚❚ Stop the radio"; tvSig = ""; try { tvPaint(); } catch (_) {} }
      vsPauseWasListening = false;
      // rejoin the live edge: re-attach what is live right now
      try { if (vsShown.hls) vsShowHls(vsShown.hls); else vsWatchGrab(); } catch (_) {}
      vsStageEls().forEach((st) => { const v = st.querySelector("video.vslive"); if (v && st.classList.contains("vs-on")) { try { const p = v.play(); if (p && p.catch) p.catch(() => {}); } catch (_) {} } });
      try { if (vsShown.atrack) vsAudioPlay(vsShown.atrack); } catch (_) {}
    }
    vsPauseSig = ""; vsPaintPause();
  }
  function vsPaintPause() {
    try {
      const viewer = !OWNER() && !vsPub && !SANDBOX;
      const on = viewer && vsBroadcast() && !(S.vstream || {}).hidden;
      const hosts = [];
      const s1 = document.querySelector("#st-ytbox .vstage"); if (s1) hosts.push(s1);
      const s2 = document.querySelector("#dj-mini .vstage"); if (s2) hosts.push(s2);
      const s3 = document.querySelector("#tw-stage"); if (s3) hosts.push(s3);
      const s4 = document.querySelector("#wb-stage"); if (s4) hosts.push(s4);
      const sig = (on ? "1" : "0") + "|" + (vsLocalPause ? "p" : "") + "|" + hosts.map((h) => h.classList.contains("vs-on") ? "1" : "0").join("");
      if (sig === vsPauseSig) return; vsPauseSig = sig;
      hosts.forEach((h) => { let b = h.querySelector(".vspause"); if (!b) { b = document.createElement("button"); b.type = "button"; b.className = "vspause"; b.title = "Pause the live picture and sound just for you — the broadcast keeps going for everyone else"; h.appendChild(b); } const show = on && (vsLocalPause || h.classList.contains("vs-on")); b.hidden = !show; const lab = vsLocalPause ? "▶ Back to live" : "⏸ Pause for me"; if (b.textContent !== lab) b.textContent = lab; });
    } catch (_) {}
  }
  /* the room's own live playback (HLS) - the fallback picture for a
   * LIVESTREAM room, where an off-stage watcher is never given a WebRTC
   * consumer at all (see the studio3 note at vsWatchGrab). Native HLS
   * where the browser has it (Safari/iOS), hls.js lazy-loaded elsewhere.
   * BUFFER PASS (owner, 2026-10-29: "it looks like its loading to much
   * i think it needs more buffers"): the hls.js players run a real
   * cushion now - a 4-segment live target with up to 30s buffered
   * ahead - instead of the 2-segment / 10s low-latency diet the
   * sync-lock build shipped. The sync lock aligns every copy to the
   * SOUNDING element, so depth costs no lip sync; and the lock's
   * live-edge trim (in vsAvSyncLock) is a stall rescue that only
   * fires a full 30s behind the edge, never at the cushion itself.
   * NO-SKIP PASS (owner, 2026-10-30: "Make it so it skips none at
   * all no mater wat thats the law"): the cushion is raised hard -
   * 90s of buffer, 120 max, 60 back, an 8-segment live target with
   * latency allowed to 24, and fragment/level/manifest loads retry
   * 6 times instead of giving up. A few seconds more latency is
   * accepted; a skip is not. */
  let vsHlsP = null;
  function vsLoadHls() {
    if (window.Hls) return Promise.resolve(true);
    if (!vsHlsP) vsHlsP = new Promise((res) => { const s = document.createElement("script"); let done = false; const fin = (ok) => { if (done) return; done = true; if (!ok) vsHlsP = null; res(ok); }; s.src = "https://cdn.jsdelivr.net/npm/hls.js@1.5.13/dist/hls.min.js"; s.onload = () => fin(!!window.Hls); s.onerror = () => fin(false); document.head.appendChild(s); setTimeout(() => fin(!!window.Hls), 12000); });
    return vsHlsP;
  }
  function vsShowHls(url) {
    if (!url) return;
    if (vsShown.hls !== url) vsShown = { track: null, stream: null, hls: url };
    vsStageEls().forEach((st) => { const v = vsVid(st); try {
      if (v._vsHlsUrl !== url) { vsKillHls(v); try { v.srcObject = null; } catch (_) {} v._vsHlsUrl = url;
        if (v.canPlayType && v.canPlayType("application/vnd.apple.mpegurl")) v.src = url;
        else if (window.Hls && window.Hls.isSupported && window.Hls.isSupported()) { const h = new window.Hls({ maxBufferLength: 90, maxMaxBufferLength: 120, backBufferLength: 60, liveSyncDurationCount: 8, liveMaxLatencyDurationCount: 24, maxLiveSyncPlaybackRate: 1.5, fragLoadingMaxRetry: 6, fragLoadingRetryDelay: 1000, levelLoadingMaxRetry: 6, levelLoadingRetryDelay: 1000, manifestLoadingMaxRetry: 6, manifestLoadingRetryDelay: 1000 }); h.loadSource(url); h.attachMedia(v); v._vsHls = h; }
        else { vsLoadHls().then((ok) => { if (ok && vsShown.hls === url) vsShowHls(url); }); }
      }
      const p = v.play(); if (p && p.catch) p.catch(() => {});
    } catch (_) {} st.classList.add("vs-on"); });
    vsHlsPickSound(false);
  }
  /* HLS carries picture and sound in the one element, and up to three
   * stages can hold the same stream — exactly ONE stage video sounds:
   * the one on the surface the viewer is actually looking at (MW TV
   * first, then the station stage, then the mini). The rest stay
   * muted, so the capture's sound is heard once, never as an echo.
   * A refused unmuted play flags vsSndBlocked and the viewer's first
   * tap retries — the same honest gesture rule as the audio element. */
  let vsHlsSndEl = null;
  function vsHlsPickSound(force) {
    try {
      if (!vsShown.hls) { if (vsHlsSndEl) { try { vsHlsSndEl.muted = true; } catch (_) {} vsHlsSndEl = null; } return; }
      const order = ["#tw-stage", "#st-ytbox .vstage", "#dj-mini .vstage", "#dj-vstage", "#wb-stage"];
      let pick = null;
      for (const sel of order) { const st = document.querySelector(sel); if (!st || !st.classList.contains("vs-on")) continue; const v = st.querySelector("video.vslive"); if (v && st.getClientRects().length) { pick = v; break; } }
      if (!pick) { const st0 = document.querySelector("#dj-mini .vstage"); if (st0) pick = st0.querySelector("video.vslive"); }
      if (pick === vsHlsSndEl && !force) return;
      vsStageEls().forEach((st) => { const v = st.querySelector("video.vslive"); if (v && v !== pick) { try { v.muted = true; } catch (_) {} } });
      vsHlsSndEl = pick;
      if (pick) { try { pick.muted = false; const p = pick.play(); if (p && p.catch) p.catch(() => { try { pick.muted = true; } catch (_) {} if (vsHlsSndEl === pick) vsHlsSndEl = null; vsSndBlocked = true; }); } catch (_) {} }
    } catch (_) {}
  }
  /* ---------- SYNC LOCK for the share (owner, 2026-10-29) ----------
   * On the WebRTC path the picture and the sound arrive as SEPARATE
   * elements - muted video elements per stage, one body-level audio
   * element - and separate elements have no shared clock: each one
   * starts when its own play() lands and buffers on its own, so the
   * lips drift away from the words a little more every minute. On
   * the HLS path every stage element runs its OWN player instance of
   * the same stream, so the muted copies drift from the one element
   * that is sounding - and a viewer watching a muted copy (the mini,
   * a second screen) hears sound timed to a different picture. This
   * lock runs every 2s and corrects with the same hysteresis as the
   * mix lock: inside 0.12s nothing moves; small drift rate-nudges
   * the lagging element; past 0.35s the lagging side restarts at the
   * live edge (a MediaStream element cannot seek - a fresh play()
   * IS its seek) or, for HLS, seeks to the sounding element's
   * position. A viewer who paused the capture for themselves is
   * exempt, a hidden or reconnecting share is exempt, the publisher
   * tab is exempt (it renders its own local stream), and restarts
   * are rate-limited to one per 4s so the lock can never flap. */
  let vsAvSnapAt = 0, vsAvRateEl = null;
  function vsAvSyncLock() {
    try {
      if (SANDBOX || vsPub || vsLocalPause) return;
      if (!vsBroadcast() || (S.vstream || {}).hidden || vsShareDown()) return;
      const now = Date.now();
      if (vsShown.hls) {
        const ref = vsHlsSndEl;
        vsStageEls().forEach((st) => { const v = st.querySelector("video.vslive"); if (!v) return;
          /* BUFFER PASS: the absolute live-edge trim is a STALL RESCUE
           * for the sounding element only (muted copies are governed by
           * the drift-vs-sound correction below, which already seeks a
           * copy that falls behind the sound). Its threshold is 30s on
           * purpose: the deepened cushion parks a healthy player
           * liveSyncDurationCount (4) segments behind the edge - up to
           * ~24s with 6s segments - so the old 6s rule ate the very
           * cushion that stops rebuffering, yanking every copy, the
           * sounding one included, to the edge every 10s and throwing
           * its buffer away. Past 30s the copy is not cushioning, it
           * is stalled (or the tab slept), and the rescue pulls it to
           * 2s behind the edge so the cushion can rebuild ahead of it. */
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
      const drift = pic.currentTime - a.currentTime; // positive: the picture is AHEAD of the sound
      const dec = syncLockCalc(drift, 1);
      if (dec.act === "none") { if (vsAvRateEl) { try { vsAvRateEl.playbackRate = 1; } catch (_) {} vsAvRateEl = null; } return; }
      if (dec.act === "nudge") { const lag = drift > 0 ? a : pic; try { lag.playbackRate = 1.05; } catch (_) {} if (vsAvRateEl && vsAvRateEl !== lag) { try { vsAvRateEl.playbackRate = 1; } catch (_) {} } vsAvRateEl = lag; return; }
      if (now - vsAvSnapAt < 4000) return; vsAvSnapAt = now;
      if (vsAvRateEl) { try { vsAvRateEl.playbackRate = 1; } catch (_) {} vsAvRateEl = null; }
      if (drift > 0) { try { a.pause(); const p = a.play(); if (p && p.catch) p.catch(() => {}); } catch (_) {} }
      else { vsStageEls().forEach((st) => { const v = st.querySelector("video.vslive"); if (v && st.classList.contains("vs-on")) { try { v.pause(); const p = v.play(); if (p && p.catch) p.catch(() => {}); } catch (_) {} } }); }
    } catch (_) {}
  }
  setInterval(() => { try { vsAvSyncLock(); } catch (_) {} }, 2000);
  /* ---------- the TV status line (owner + testers READ the watch) ----------
   * A plain-text line in the corner of the station stage and the MW TV
   * screen, present only while a share is on. Every watcher step is
   * reflected here, so a failed watch says WHERE it stopped instead of
   * going silent the way the first builds did. */
  function vsNoteErr(e) { try { const m = (e && e.message) ? String(e.message) : String(e || ""); if (m) vsWatchErr = m.slice(0, 42); } catch (_) {} }
  function vsSetStatus(txt) {
    if (txt === vsStatusTxt) return; vsStatusTxt = txt;
    const hosts = [];
    const st = document.querySelector("#st-ytbox .vstage"); if (st) hosts.push(st);
    const tw = document.querySelector("#tw-stage"); if (tw) hosts.push(tw);
    const wb = document.querySelector("#wb-stage"); if (wb) hosts.push(wb);
    hosts.forEach((h) => { let el = h.querySelector(".vstatus"); if (!el) { el = document.createElement("div"); el.className = "vstatus"; h.appendChild(el); } el.hidden = !txt; if (txt && el.textContent !== txt) el.textContent = txt; });
  }
  /* the publisher's own verdict on its chain (fix-studio5): while the
   * diag stage is repairing or source-gone, no surface may call the
   * share live — viewers hold the mix underneath and the status line
   * says reconnecting. A stage of publishing (or none, from an older
   * build) leaves the existing behavior alone. */
  const vsShareDown = () => { const vs = S.vstream || {}; const st = vs.diag && vs.diag.stage; return !!vs.on && (st === "repairing" || st === "source-gone"); };
  function vsStatusFor() {
    const vs = S.vstream || {};
    if (!vs.on || !vs.meeting) return "";
    if (vsShareDown()) return "TV: reconnecting…";
    if (vsPub) return "TV: live";
    if (vs.hidden) return "TV: hidden by Meechie";
    if ((vsShown.track && vsShown.track.readyState === "live") || vsShown.hls) {
      // "TV: live" is earned now (fix-studio5): the publisher diag says
      // publishing AND its proof stamp is fresh. The window is generous
      // (75s) because a backgrounded booth tab's timers throttle to
      // about one beat a minute — the picture keeps flowing over the
      // network while its proofs slow down, and the line must not cry
      // wolf at a healthy share
      if ((vs.diag || {}).stage === "publishing" && Date.now() - (vs.at || 0) > 75000) return "TV: reconnecting…";
      return "TV: live";
    }
    if (vsWatch) return "TV: joined — waiting for picture";
    if (vsWatchRetryMid === vs.meeting && vsWatchErr) return "TV: retrying (" + vsWatchErr + ")";
    return "TV: connecting…";
  }
  function vsPaintStatus() { try { vsSetStatus(vsStatusFor()); } catch (_) {} }
  function vsPaintBtns() {
    try {
      vsPaintStudio();
      const vs = S.vstream || {}, on = !!vs.on, kind = on ? (vs.kind || "") : "";
      const sig = kind + "|" + (vsPubBusy ? "b" : "") + "|" + (on && vs.hidden ? "h" : "");
      if (sig === vsPaintSig) return; vsPaintSig = sig;
      const lb = document.getElementById("dj-vlivebtn");
      if (lb) { lb.classList.toggle("on", kind === "cam"); lb.textContent = kind === "cam" ? "📹 Live Video · ON" : "📹 Live Video"; }
      document.querySelectorAll("[data-capbtn]").forEach((b) => b.classList.toggle("on", kind === "screen"));
      // HIDE SHARE sits beside every Capture button: visible only while a
      // screen share is live (from any of his screens), lit while hidden,
      // and its label flips to the way back
      document.querySelectorAll("[data-hidebtn]").forEach((b) => { const sh = on && kind === "screen"; b.hidden = !sh; b.classList.toggle("on", !!vs.hidden); const lab = vs.hidden ? b.dataset.labOn : b.dataset.labOff; if (lab && b.textContent !== lab) b.textContent = lab; });
    } catch (_) {}
  }
  /* the STUDIO strip lives only while THIS tab is publishing a screen
   * share; slider positions paint on show / mode change only, so a drag
   * in progress is never fought (percent labels still update live) */
  function vsStudioLabels() {
    const el = document.getElementById("dj-studio"); if (!el) return;
    el.querySelectorAll("[data-cropv]").forEach((s) => { s.textContent = (vsCrop[s.dataset.cropv] || 0) + "%"; });
  }
  function vsPaintStudio() {
    try {
      const el = document.getElementById("dj-studio"); if (!el) return;
      const show = !!(vsPub && vsPub.kind === "screen");
      const sig = (show ? "on" : "off") + "|" + (vsCrop.fill ? "F" : "f");
      if (sig === vsStudioSig) return; vsStudioSig = sig;
      el.hidden = !show;
      if (show) {
        el.querySelectorAll("[data-crop]").forEach((inp) => { inp.value = String(vsCrop[inp.dataset.crop] || 0); });
        const fb = el.querySelector("[data-studiofit]"); if (fb) fb.textContent = vsCrop.fill ? "🖼 Frame: Fill" : "🖼 Frame: Fit";
        vsStudioLabels();
      }
    } catch (_) {}
  }
  function vsCropSave() { try { localStorage.setItem("mw-studio-crop", JSON.stringify(vsCrop)); } catch (_) {} }
  /* ---------- publisher (the booth tab that tapped) ---------- */
  async function vsPubTeardown() {
    const p = vsPub; vsPub = null;
    try { sessionStorage.removeItem("mw_vspub"); } catch (_) {}
    if (!p) return;
    if (p.beat) { try { clearInterval(p.beat); } catch (_) {} }
    if (vsSupIv) { try { clearInterval(vsSupIv); } catch (_) {} vsSupIv = null; }
    vsBarSrc = false; try { vsBarPaint(); } catch (_) {}
    vsCropStop();
    if (p.meeting) {
      try { if (p.meeting.self && p.meeting.self.disableScreenShare) await p.meeting.self.disableScreenShare(); } catch (_) {}
      try { if (p.meeting.self && p.meeting.self.disableVideo) await p.meeting.self.disableVideo(); } catch (_) {}
      try { if (p.meeting.self && p.meeting.self.disableAudio) await p.meeting.self.disableAudio(); } catch (_) {}
      try { await p.meeting.leave(); } catch (_) {}
    }
    if (p.rawStream) { try { p.rawStream.getTracks().forEach((t) => t.stop()); } catch (_) {} }
    if (p.ownStream) { try { p.ownStream.getTracks().forEach((t) => t.stop()); } catch (_) {} }
    // the tables come back: resume exactly the decks the share paused at
    // start (see vsPubStart). A deck he re-cued empty or started himself
    // meanwhile is left alone — only a stopped deck still holding a song
    // resumes. This runs on EVERY teardown path (button, browser stop,
    // track end, replaced from another screen), because they all land here.
    if (p.pausedDecks && p.pausedDecks.length) {
      const ks = p.pausedDecks.slice();
      setTimeout(() => { ks.forEach((k) => { try { if (S[k] && (S[k].src || S[k].yt) && !S[k].playing) togglePlay(k); } catch (_) {} }); }, 400);
    }
    vsPaintStudio();
  }
  async function vsPubStop(msg) {
    const was = vsPub;
    await vsPubTeardown();
    if (was || ((S.vstream || {}).on && (S.vstream || {}).by === vsUid())) {
      S.vstream = { on: false, kind: "", at: Date.now(), by: "", meeting: "", hidden: false, stopAt: Date.now(), diag: { stage: "stopped", at: Date.now(), repairs: was ? (was.repairs || 0) : 0 } };
      save(true);
    }
    vsDetach(); vsPaintBtns();
    if (msg) say(msg);
  }
  /* ---------- the browser stop bar IS his stop (owner rule, 2026-10-29) ----------
   * A share ends ONLY on his booth Stop tap or the browser's own
   * stop-sharing bar — and the bar IS the raw capture track's ended
   * event. When the CURRENT raw track ends, the share ends cleanly by
   * the very path his Stop tap takes: switch off with a stopAt stamp,
   * diag stopped, publisher state cleared, viewers fall back to the
   * mix. The silent deaths he complained about were NOT track ends —
   * they were the second-screen echo teardown and dead SDK/canvas
   * legs, which the supervisor repairs from LIVE raw tracks. An ENDED
   * raw track is never repaired and never restore-barred: it is one
   * of his two sanctioned endings. A retired source's ended event (a
   * swap or restore replaced it first) is not an ending at all. */
  function vsShareTrackEnded(rt) {
    const p = vsPub;
    if (!p || p.kind !== "screen" || p.swapping) return;
    try { const cur = (p.rawStream && p.rawStream.getVideoTracks()[0]) || null; if (rt && cur && rt !== cur) return; } catch (_) {}
    try { vsPubStop("🖥 Screen share stopped — the master screen is back to the video mix."); } catch (_) {}
  }
  /* ---------- wake resilience: a share survives its tab sleeping ----------
   * Timers throttle, pages freeze, tabs get discarded — none of that may
   * end a share (owner: "never stop my tab from being shared until I
   * do"). On every wake signal the publisher re-stamps, lets vsSync
   * re-assert the switch if an echo drifted it, and re-publishes its
   * source if the PUBLISHED track died while the tab slept (the crop
   * canvas track can end under a frozen page even though the captured
   * screen is still live). Re-publishing needs no new picker — the raw
   * capture stream is still held. The capture's audio track rides the
   * raw stream independently and is not touched here. If the source
   * itself is gone, its own ended listener is the honest ender. */
  let vsRepubBusy = false;
  async function vsPubRepublish() {
    const p = vsPub; if (!p || p.starting || p.swapping || vsRepubBusy) return;
    try {
      if (p.pubTrack && p.pubTrack.readyState === "live") return;
      vsRepubBusy = true;
      if (p.kind === "screen") {
        const rt = p.rawStream && p.rawStream.getVideoTracks()[0];
        if (!rt || rt.readyState !== "live") return;
        const cs = vsCropStart(rt);
        const ct = cs.getVideoTracks()[0];
        try { if (p.meeting.self && p.meeting.self.disableVideo) await p.meeting.self.disableVideo(); } catch (_) {}
        await p.meeting.self.enableVideo(ct);
        p.pubTrack = ct; p.localStream = cs;
        if (p.hidApplied) { try { ct.enabled = false; } catch (_) {} } // a share republished while hidden stays dark
      } else {
        const t = (typeof camStream !== "undefined" && camStream && camStream.getVideoTracks()[0]) || (p.ownStream && p.ownStream.getVideoTracks()[0]);
        if (!t || t.readyState !== "live") return;
        try { if (p.meeting.self && p.meeting.self.disableVideo) await p.meeting.self.disableVideo(); } catch (_) {}
        await p.meeting.self.enableVideo(t);
        p.pubTrack = t; p.localStream = new MediaStream([t]);
      }
      // no stamp here (fix-studio5): a republish is a repair attempt,
      // not a proof — the supervisor stamps the switch when the chain
      // verifies whole again
      try { vsSync(); } catch (_) {}
    } catch (_) {}
    finally { vsRepubBusy = false; }
  }
  function vsPubWake() {
    const p = vsPub; if (!p) return;
    // no unproven stamp on wake (fix-studio5): waking asks the
    // supervisor to PROVE the chain — it stamps only when the proof
    // passes, and repairs instead when it does not
    try { vsSync(); } catch (_) {}
    try { vsPubRepublish(); } catch (_) {}
    try { vsSupTick(); } catch (_) {}
  }
  /* ---------- PUBLISHER SUPERVISOR (fix-studio5, 2026-10-29) ----------
   * "Why does it keep stopping my capture share — I never want that to
   * happen." The named break: the vsSync takeover branch fired on ANY
   * adopted switch whose at stamp postdated the publish start — it
   * never required the claim to name a DIFFERENT meeting. His second
   * screen adopts the switch (at and all, stamped forward by the
   * publisher itself), its next ordinary save echoes that doc back,
   * this tab adopts it, and the branch tore the healthy publish down:
   * teardown stopped the raw capture and left the room, the switch was
   * deliberately left on for the "new owner" who never existed, the
   * beat died with the record, and teardown removed the mw_vspub
   * marker so the one honest message could never fire. Switch on,
   * nobody publishing, boothAt fresh from the other screen, at
   * climbing forever — the exact ghost he kept hitting. That branch
   * now requires a different meeting (see vsSync), and this supervisor
   * stands guard over the rest of the chain: every ~2s it verifies the
   * raw source, the published track, the room's own slot, and the
   * capture audio, rebuilds whichever leg died FROM THE HELD SOURCE in
   * the SAME meeting, and stamps the switch only on proof. The stamp
   * is evidence now, not a habit: save(), the old 20s beat, wake
   * paths and the vsSync cadence no longer advance vstream.at at all. */
  let vsSupIv = null, vsSupBusy = false, vsRestoreBusy = false;
  let vsBarSrc = false, vsBarGhost = false;   // the two masters of the restore bar: a live record whose source died, and a switch whose tab was reloaded
  function vsBarPaint() {
    try {
      const st = document.querySelector("#dj-vstage"); if (!st) return;
      const show = !!(vsBarSrc || vsBarGhost);
      let bar = st.querySelector(".vsrestore");
      if (show && !bar) { bar = document.createElement("div"); bar.className = "vsrestore"; bar.innerHTML = "<span>⚠️ Your share dropped — tap to bring it back</span><button type='button' class='btn sm' data-vsrestore>🔁 Bring it back</button>"; st.appendChild(bar); }
      if (bar) bar.hidden = !show;
    } catch (_) {}
  }
  function vsPubDiagSet(stage, p) {
    if (!p || vsPub !== p) return;
    const vs = S.vstream || {};
    if (!vs.on || vs.meeting !== p.mid) return;
    p.dStage = stage;
    // the diag moves, the stamp does NOT: vstream.at advances only on a
    // passed proof, so a stale stamp under a reconnecting diag is the
    // honest picture of a chain that is down
    S.vstream.diag = { stage, at: p.dAt || 0, repairs: p.repairs || 0 };
    save(true);
  }
  function vsPubProof(p) {
    if (!p || vsPub !== p) return;
    const vs = S.vstream || {};
    if (!vs.on || vs.meeting !== p.mid) return;
    p.dAt = Date.now(); p.dStage = "publishing";
    S.vstream.at = p.dAt;
    S.vstream.diag = { stage: "publishing", at: p.dAt, repairs: p.repairs || 0 };
    save();
  }
  function vsSupRawTrack(p) {
    try {
      if (p.kind === "screen") return (p.rawStream && p.rawStream.getVideoTracks()[0]) || null;
      const ct = (typeof camStream !== "undefined" && camStream && camStream.getVideoTracks()[0]) || null;
      return ct || (p.ownStream && p.ownStream.getVideoTracks()[0]) || null;
    } catch (_) { return null; }
  }
  function vsSupSlotOk(p) {
    // does the room itself still hold a live video slot for this tab?
    // The SDK exposes the self tracks (videoTrack for the camera path,
    // screenShareTracks for a share slot). If it exposes neither, the
    // slot cannot be judged — defer to the published-track check
    // instead of repairing on an absence of evidence
    try {
      const self = p.meeting && p.meeting.self;
      if (!self) return false;
      const cand = [];
      try { if (self.videoTrack) cand.push(self.videoTrack); } catch (_) {}
      try { if (self.screenShareTracks && self.screenShareTracks.video) cand.push(self.screenShareTracks.video); } catch (_) {}
      if (!cand.length) return !!(p.pubTrack && p.pubTrack.readyState === "live");
      return cand.some((t) => t && t.readyState === "live");
    } catch (_) { return false; }
  }
  function vsSupStart() { if (vsSupIv) return; vsSupIv = setInterval(() => { try { vsSupTick(); } catch (_) {} }, 2000); }
  async function vsSupPublishInto(p, meeting) {
    // publish the held source into a meeting: a fresh crop canvas for a
    // screen share (the old canvas loop may be the corpse), the held
    // track itself for the camera. Used for same-meeting repairs, for
    // rejoins, and for the remint fallback — one code path, no picker
    const rt = vsSupRawTrack(p);
    if (!rt || rt.readyState !== "live") return false;
    if (p.kind === "screen") {
      const cs = vsCropStart(rt);
      const ct = cs.getVideoTracks()[0];
      try { if (meeting.self && meeting.self.disableVideo) await meeting.self.disableVideo(); } catch (_) {}
      await meeting.self.enableVideo(ct);
      p.pubTrack = ct; p.localStream = cs;
    } else {
      try { if (meeting.self && meeting.self.disableVideo) await meeting.self.disableVideo(); } catch (_) {}
      await meeting.self.enableVideo(rt);
      p.pubTrack = rt; p.localStream = new MediaStream([rt]);
    }
    if (p.hidApplied && p.pubTrack) { try { p.pubTrack.enabled = false; } catch (_) {} } // a repair while hidden stays dark
    await vsPubAudio(meeting, p.rawStream);
    return true;
  }
  async function vsSupRejoin(p) {
    // the room dropped this tab (or never fully held it): ask the same
    // meeting object to join again, then publish into it once more. An
    // "already joined" refusal means the room had us all along — that
    // is a successful rejoin, not a failure
    try {
      if (!p.meeting || typeof p.meeting.join !== "function") return false;
      let ok = false;
      await Promise.race([p.meeting.join().then(() => { ok = true; }, (e) => { if (e && /already/i.test(String(e.message || e))) ok = true; }), new Promise((res) => setTimeout(res, 15000))]);
      if (!ok || vsPub !== p) return false;
      return await vsSupPublishInto(p, p.meeting);
    } catch (_) { return false; }
  }
  async function vsSupRemint(p) {
    // last resort, and the one place a fresh meeting is honest: the
    // gateway cannot re-add the HOST to an existing meeting — its host
    // mint always opens a new room, and its meeting-taking mint issues
    // viewer credentials that cannot publish — so a dead room is
    // REPLACED, not rejoined. Mint, join, publish from the held
    // source, and only then move record and switch together in one
    // save: no off flicker, no picker, and viewers follow the meeting
    // id in the switch on their own vsSync, as they already do
    const mint = await vsApi({ action: "live_mint", role: "host" });
    if (!mint || !mint.token || !mint.meeting) return false;
    if (!(await vsLoadSdk())) return false;
    let meeting = null;
    try {
      meeting = await RealtimeKitClient.init({ authToken: mint.token, defaults: { audio: false, video: false } });
      let ok = false;
      await Promise.race([meeting.join().then(() => { ok = true; }), new Promise((res) => setTimeout(res, 20000))]);
      if (!ok) { try { await meeting.leave(); } catch (_) {} return false; }
      if (!(await vsSupPublishInto(p, meeting))) { try { await meeting.leave(); } catch (_) {} return false; }
    } catch (_) { if (meeting) { try { await meeting.leave(); } catch (_) {} } return false; }
    if (vsPub !== p) { try { await meeting.leave(); } catch (_) {} return false; } // he stopped (or was replaced) while the new room was being built — it must not resurrect the switch
    const old = p.meeting;
    p.meeting = meeting; p.mid = mint.meeting; p.since = Date.now();
    S.vstream = { on: true, kind: p.kind, at: (S.vstream || {}).at || 0, by: vsUid(), meeting: mint.meeting, hidden: !!p.hidApplied, stopAt: 0, diag: { stage: "repairing", at: p.dAt || 0, repairs: p.repairs || 0 } };
    p.dStage = "repairing";
    save(true);
    try { sessionStorage.setItem("mw_vspub", JSON.stringify({ mid: mint.meeting, kind: p.kind })); } catch (_) {}
    if (old && old !== meeting) { try { await old.leave(); } catch (_) {} }
    return true;
  }
  function vsSupTick() {
    if (vsSupBusy) return;
    const p = vsPub;
    if (!p || p.starting || p.swapping) return;
    const vs = S.vstream || {};
    if (!vs.on || vs.meeting !== p.mid) return; // vsSync arbitrates stops, claims and echoes — the supervisor only guards a publish the switch still says is this tab's
    vsSupBusy = true;
    (async () => {
      try {
        // LEG 1 — the raw source itself
        const rt = vsSupRawTrack(p);
        if (!rt || rt.readyState !== "live") {
          if (p.kind === "screen") {
            // the raw capture track has ENDED — that is the browser
            // stop-sharing bar, one of his two sanctioned endings
            // (owner rule, 2026-10-29). If the track's own ended event
            // was somehow missed, this poll is the backstop: end the
            // share cleanly, exactly as his booth Stop does. Never a
            // repair, never a restore bar — the share is over
            try { await vsPubStop("🖥 Screen share stopped — the master screen is back to the video mix."); } catch (_) {}
            return;
          }
          // the camera source is truly gone — no code can resurrect it
          // without him. The switch STAYS ON, the diag tells viewers
          // the reconnecting truth, and the booth gets the restore
          // bar: one tap re-runs the camera into this same meeting
          p.srcGone = true;
          if (p.dStage !== "source-gone") vsPubDiagSet("source-gone", p);
          if (!vsBarSrc) { vsBarSrc = true; vsBarPaint(); }
          return;
        }
        p.srcGone = false;
        // LEG 2 — the published track; LEG 3 — the room still holds a
        // live slot for us; LEG 4 — the capture's audio, while the
        // pick actually provides one
        const pubLive = !!(p.pubTrack && p.pubTrack.readyState === "live");
        const slotOk = vsSupSlotOk(p);
        let audOk = true;
        if (p.hadAudio) {
          const at = p.rawStream && p.rawStream.getAudioTracks ? p.rawStream.getAudioTracks()[0] : null;
          if (!at || at.readyState !== "live") p.hadAudio = false; // the pick's audio ended for good: the share is honestly video-only from here, not a repair loop
          else audOk = !!(p.pubAudio && p.pubAudio.readyState === "live");
        }
        if (pubLive && slotOk && audOk) {
          p.badN = 0; p.esc = 0;
          if (vsBarSrc) { vsBarSrc = false; vsBarPaint(); }
          if (p.dStage !== "publishing" || Date.now() - (p.dAt || 0) >= 8000) vsPubProof(p);
          return;
        }
        // a leg is down: say so at once, but act only after two bad
        // ticks in a row, so a transient never triggers a rebuild
        if (p.dStage !== "repairing") vsPubDiagSet("repairing", p);
        p.badN = (p.badN || 0) + 1;
        if (p.badN < 2 || vsPub !== p) return;
        p.badN = 0;
        if (!audOk && pubLive && slotOk) { try { await vsPubAudio(p.meeting, p.rawStream); } catch (_) {} p.repairs = (p.repairs || 0) + 1; return; }
        if (p.esc === 0) { p.esc = 1; try { await vsSupPublishInto(p, p.meeting); } catch (_) {} if (vsPub === p) p.repairs = (p.repairs || 0) + 1; }
        else if (p.esc === 1) { p.esc = 2; try { await vsSupRejoin(p); } catch (_) {} if (vsPub === p) p.repairs = (p.repairs || 0) + 1; }
        else if (Date.now() - (p.lastRemint || 0) > 15000) { p.lastRemint = Date.now(); let ok = false; try { ok = await vsSupRemint(p); } catch (_) {} if (ok && vsPub === p) { p.esc = 1; p.repairs = (p.repairs || 0) + 1; } }
      } catch (_) {}
      finally { vsSupBusy = false; }
    })();
  }
  async function vsPubRestore() {
    // the restore bar's button — his one tap brings the share back.
    // With a live publish record whose source died, the picker (or the
    // camera) re-runs INTO THE SAME MEETING; if the room died with the
    // source, the remint fallback replaces the room around the new
    // source. With no record at all (this tab was reloaded mid-share),
    // the start flow itself is the restore — it re-picks and re-mints,
    // and the switch follows it
    if (vsRestoreBusy || vsSupBusy) return;
    const p = vsPub;
    if (!p) {
      let kind = "screen";
      try { const mk = JSON.parse(sessionStorage.getItem("mw_vspub") || "null"); if (mk && (mk.kind === "cam" || mk.kind === "screen")) kind = mk.kind; } catch (_) {}
      vsBarGhost = false; vsBarPaint();
      vsPubStart(kind);
      return;
    }
    vsRestoreBusy = true;
    try {
      if (p.kind === "screen") {
        let raw;
        try { raw = await vsGetDisplay(); }
        catch (_) { say("🖥 The picker closed — your share is still waiting. Tap Bring it back when you are ready to pick the screen again."); return; }
        const rt = raw && raw.getVideoTracks()[0];
        if (!rt) { try { raw.getTracks().forEach((t) => t.stop()); } catch (_) {} say("🖥 That pick had no screen in it — tap Bring it back and choose the screen you want to show."); return; }
        if (vsPub !== p) { try { raw.getTracks().forEach((t) => t.stop()); } catch (_) {} return; }
        if (p.rawStream && p.rawStream !== raw) { try { p.rawStream.getTracks().forEach((t) => t.stop()); } catch (_) {} }
        p.rawStream = raw;
        rt.addEventListener("ended", () => { if (vsPub && vsPub.kind === "screen" && !vsPub.swapping) { try { vsShareTrackEnded(rt); } catch (_) {} } });
        let into = false;
        try { into = await vsSupPublishInto(p, p.meeting); } catch (_) {}
        if (!into && vsPub === p) { p.lastRemint = 0; let ok = false; try { ok = await vsSupRemint(p); } catch (_) {} if (ok) { p.repairs = (p.repairs || 0) + 1; into = true; } }
        if (vsPub !== p) return;
        if (into) {
          p.srcGone = false; p.esc = 0; p.badN = 0;
          if (p.dStage !== "repairing") vsPubDiagSet("repairing", p);
          vsBarSrc = false; vsBarPaint();
          say("🖥 Your screen is back on the master screen.");
          try { vsSupTick(); } catch (_) {}
        } else say("🖥 The share could not be rebuilt just now — check your connection and tap Bring it back once more.");
      } else {
        let s = null;
        try { s = await navigator.mediaDevices.getUserMedia({ video: { width: { ideal: 1280, max: 1280 }, height: { ideal: 720, max: 720 }, frameRate: { max: 30 } }, audio: false }); } catch (_) {}
        if (!s) { say("📹 The camera did not come back — check it is plugged in and allowed for this site, then tap Bring it back again."); return; }
        if (vsPub !== p) { try { s.getTracks().forEach((t) => t.stop()); } catch (_) {} return; }
        if (p.ownStream && p.ownStream !== s) { try { p.ownStream.getTracks().forEach((t) => t.stop()); } catch (_) {} }
        p.ownStream = s;
        let into = false;
        try { into = await vsSupPublishInto(p, p.meeting); } catch (_) {}
        if (!into && vsPub === p) { p.lastRemint = 0; let ok = false; try { ok = await vsSupRemint(p); } catch (_) {} if (ok) { p.repairs = (p.repairs || 0) + 1; into = true; } }
        if (vsPub !== p) return;
        if (into) {
          p.srcGone = false; p.esc = 0; p.badN = 0;
          if (p.dStage !== "repairing") vsPubDiagSet("repairing", p);
          vsBarSrc = false; vsBarPaint();
          say("📹 Your camera is back on the master screen.");
          try { vsSupTick(); } catch (_) {}
        } else say("📹 Live video could not be rebuilt just now — check your connection and tap Bring it back once more.");
      }
    } catch (_) {}
    finally { vsRestoreBusy = false; }
  }
  async function vsPubStart(kind) {
    if (SANDBOX) { say("The DJ Playground is a sandbox — live video only runs on the real station."); return; }
    if (!OWNER()) { say("Only Meechie can put a live picture on the master screen."); return; }
    if (!leadDrive()) { say("📹 Live video runs on the screen that is driving the booth — make this screen the driver first."); return; } // gate aligned to leadDrive (was boothLead): the publish-proof chain belongs to the claim holder, like every other automation gate
    if (vsPubBusy) return;
    if (kind === "screen" && !(navigator.mediaDevices && navigator.mediaDevices.getDisplayMedia)) {
      say("🖥 This browser cannot capture your screen — screen capture needs a computer browser (Chrome or Edge). On this device, 📹 Live Video by the Cam button still works for your camera.");
      return;
    }
    if (kind === "cam" && !(navigator.mediaDevices && navigator.mediaDevices.getUserMedia)) { say("📹 This browser cannot reach a camera."); return; }
    vsPubBusy = true; vsPaintBtns();
    let stateWrote = false, pubMid = "";
    try {
      say(kind === "screen" ? "🖥 Setting up your screen share…" : "📹 Starting live video…");
      const mint = await vsApi({ action: "live_mint", role: "host" });
      if (!mint || !mint.token || !mint.meeting) { say((mint && mint.message) || "📹 Live video could not start — the streaming service did not answer. Nothing else was touched."); return; }
      if (!(await vsLoadSdk())) { say("📹 The live video engine could not load — check your connection and tap again. Nothing else was touched."); return; }
      const meeting = await RealtimeKitClient.init({ authToken: mint.token, defaults: { audio: false, video: false } });
      // a join that never settles would latch vsPubBusy for the whole
      // session with the switch never written — the watcher got this
      // race in fix-studio2; the publisher gets the same honesty
      await Promise.race([meeting.join(), new Promise((_, rej) => setTimeout(() => rej(new Error("join timeout")), 20000))]);
      // STUDIO FIX (2026-10-29): the shared switch goes on BEFORE any
      // user-paced await (the screen picker, the camera prompt). The old
      // order installed vsPub first and wrote the switch only after those
      // awaits — vsSync, ticking every 700ms on the stage cadence, saw a
      // publisher whose switch was still off and tore it down mid-start:
      // the meeting was left and vsPub nulled while the picker was still
      // open, the late switch write then landed as a permanent ghost (on,
      // stamped once, pointing at a meeting nobody was in), and the beat
      // assignment threw on the nulled record so the stamp never moved
      // again. That is the whole 2026-10-29 failure in one race.
      vsPub = { meeting, mid: mint.meeting, kind, ownStream: null, rawStream: null, localStream: null, pubTrack: null, pubAudio: null, hadAudio: false, hidApplied: false, beat: null, starting: true, strikes: 0, pausedDecks: null, since: Date.now(), dStage: "repairing", dAt: 0, repairs: 0, esc: 0, badN: 0, srcGone: false, lastRemint: 0 };
      S.vstream = { on: true, kind, at: Date.now(), by: vsUid(), meeting: mint.meeting, hidden: false, stopAt: 0, diag: { stage: "repairing", at: 0, repairs: 0 } };
      pubMid = mint.meeting; stateWrote = true;
      save(true);
      // remember (this tab only) that WE are the publisher: if the tab is
      // discarded and restored, the reloaded page finds this marker and
      // tells him plainly instead of leaving a silent ghost (see vsSync)
      try { sessionStorage.setItem("mw_vspub", JSON.stringify({ mid: mint.meeting, kind })); } catch (_) {}
      // the 20s beat is retired (fix-studio5): it stamped the switch
      // unproven and its republish only noticed an ended published
      // track. The supervisor owns liveness now — 2s verification of
      // the whole chain, repairs in the same meeting, proof-only stamps
      vsSupStart();
      if (kind === "cam") {
        let track = (typeof camStream !== "undefined" && camStream && camStream.getVideoTracks()[0]) || null;
        if (!track) {
          const s = await navigator.mediaDevices.getUserMedia({ video: { width: { ideal: 1280, max: 1280 }, height: { ideal: 720, max: 720 }, frameRate: { max: 30 } }, audio: false });
          vsPub.ownStream = s; track = s.getVideoTracks()[0];
        }
        await meeting.self.enableVideo(track);
        vsPub.pubTrack = track;
        vsPub.localStream = new MediaStream([track]);
      } else {
        await vsStartScreen(meeting);
      }
      vsPub.starting = false;
      try { vsSupTick(); } catch (_) {} // first proof right away — the diag flips from repairing to publishing the moment the chain verifies
      vsSync();
      say(kind === "screen" ? "🖥 Your screen is on the master screen — everyone sees it now. Tap Capture again to stop." : "📹 You are on the master screen in full motion. Tap Live Video again to stop.");
      if (kind === "screen") {
        // PAUSE THE TABLES (owner, 2026-10-29: "i also want that to pause
        // the dj tables till it cuts off"): a screen share is a
        // presentation, not a set. Every playing deck pauses through
        // togglePlay — the same deliberate pause a manual all-pause makes,
        // S.pausedAt stamp and all, so the station keeper respects it.
        // (The keeper honors a deliberate pause for up to 30 minutes; the
        // share's own saves keep boothAt fresh meanwhile, so the keeper
        // is standing down anyway.) The decks that were playing are
        // remembered on the publish record and resumed by vsPubTeardown,
        // so every way the share ends brings exactly those decks back.
        const wasPlaying = DECKS.filter((k) => S[k] && S[k].playing);
        if (wasPlaying.length) {
          vsPub.pausedDecks = wasPlaying;
          for (const k of wasPlaying) { try { await togglePlay(k); } catch (_) {} }
          say("⏸ Tables paused while your screen is up — they pick back up the moment the share stops.");
        }
      }
    } catch (_) {
      await vsPubTeardown(); vsDetach();
      // a start that failed AFTER the switch was written (picker closed,
      // camera denied) clears its own switch — no ghost left behind
      if (stateWrote && (S.vstream || {}).meeting === pubMid) { S.vstream = { on: false, kind: "", at: Date.now(), by: "", meeting: "", hidden: false, stopAt: Date.now(), diag: { stage: "stopped", at: Date.now(), repairs: 0 } }; save(true); }
      if (kind === "screen") say("🖥 Screen share did not start — if you closed the picker, tap Capture and pick the screen you want to show.");
      else say("📹 Live video did not start — allow the camera for this site, then tap Live Video again.");
    } finally { vsPubBusy = false; vsPaintBtns(); }
  }
  function vsToggle(kind) {
    if (vsPub) {
      // HIDE SHARE flow: while hidden, Capture re-picks the source in the
      // same meeting (see vsSwapSource) instead of ending the share
      if (kind === "screen" && vsPub.kind === "screen" && (S.vstream || {}).hidden) { vsSwapSource(); return; }
      vsPubStop(kind === "screen" ? "🖥 Screen share stopped — the master screen is back to the video mix." : "📹 Live video stopped — the master screen is back to the video mix."); return;
    }
    const vs = S.vstream || {};
    if (vs.on && vs.by === vsUid() && vs.kind === kind) { S.vstream = { on: false, kind: "", at: Date.now(), by: "", meeting: "", hidden: false, stopAt: Date.now(), diag: { stage: "stopped", at: Date.now(), repairs: (vs.diag || {}).repairs || 0 } }; save(true); vsSync(); say("Stopped — the master screen is back to the video mix."); return; }
    if (vs.on && vs.by === vsUid()) { S.vstream = { on: false, kind: "", at: Date.now(), by: "", meeting: "", hidden: false, stopAt: Date.now(), diag: { stage: "stopped", at: Date.now(), repairs: (vs.diag || {}).repairs || 0 } }; save(true); }
    vsPubStart(kind);
  }
  /* ---------- HIDE SHARE (owner, 2026-10-29) ----------
   * "I want to be able to hide the share... when I want to change it":
   * while S.vstream.hidden is set, the share SESSION stays up (the tables
   * stay paused, the meeting stays joined) but no picture of his screen
   * can reach a viewer. Three layers, so no single one has to be trusted:
   * (1) the published track itself is disabled (a disabled video track
   * sends black, never a held frame) and the crop canvas paints black
   * instead of drawing his screen, so even the frames in flight are
   * black; (2) every viewer stops rendering the overlay and falls back
   * to the video mix, driven by the state field; (3) his own stage
   * swaps the preview for a HIDDEN placeholder so he KNOWS he is
   * private while he rearranges. disableVideo() is deliberately NOT the
   * mechanism: in this SDK it stops the transformed track outright,
   * which would kill the very canvas/raw track the share must resume
   * from — track.enabled mutes the send and restores it cleanly. */
  function vsApplyHidden(h) {
    const p = vsPub; if (!p) return;
    const t = p.pubTrack || (p.localStream && p.localStream.getVideoTracks()[0]);
    if (!t) return;
    if (h) { try { t.enabled = false; } catch (_) {} return; }
    if (t.readyState === "live") { try { t.enabled = true; } catch (_) {} return; }
    // the published track died while hidden: put the source back if it
    // is still alive (the republish path) instead of ending the share —
    // a track that died on OUR side is not his Stop. If the source
    // itself is gone, its own ended listener owns that ending.
    try { vsPubRepublish(); } catch (_) {}
  }
  function vsHiddenPh(show) {
    try {
      const st = document.querySelector("#dj-vstage"); if (!st) return;
      let ph = st.querySelector(".vshidden");
      if (show && !ph) { ph = document.createElement("div"); ph.className = "vshidden"; ph.textContent = "🙈 HIDDEN — viewers can't see this"; st.appendChild(ph); }
      if (ph) ph.hidden = !show;
    } catch (_) {}
  }
  function vsToggleHide() {
    if (!OWNER()) { say("Only Meechie can hide the share."); return; }
    const vs = S.vstream || {};
    if (!vs.on || vs.kind !== "screen" || vs.by !== vsUid()) { say("🙈 Hide Share works while your screen is on the master screen."); return; }
    S.vstream.hidden = !vs.hidden;
    save(true);
    // the publishing tab applies at once; any other of his screens flips
    // the state and the publishing tab follows within a stage tick
    if (vsPub && vsPub.kind === "screen") { const h = !!S.vstream.hidden; if (h !== !!vsPub.hidApplied) { vsPub.hidApplied = h; vsApplyHidden(h); } }
    vsPaintSig = null; vsPaintBtns();
    say(S.vstream.hidden ? "🙈 Share hidden — viewers see the video mix while you set up. Tap Show Share when you are ready." : "👁 Your screen is back on the master screen.");
  }
  let vsSwapBusy = false;
  /* change-source while hidden: the picker runs, the NEW source is in
   * hand before the old one is touched, the swap publishes into the SAME
   * meeting and clears hidden by itself. A cancelled picker changes
   * nothing — he stays hidden on the old source. */
  async function vsSwapSource() {
    if (vsSwapBusy || !vsPub || vsPub.kind !== "screen") return;
    if (!(navigator.mediaDevices && navigator.mediaDevices.getDisplayMedia)) { say("🖥 This browser cannot capture a new source."); return; }
    vsSwapBusy = true;
    let swapNew = null;
    try {
      let raw;
      raw = await vsGetDisplay();
      const rt = raw.getVideoTracks()[0];
      if (!rt) { try { raw.getTracks().forEach((t) => t.stop()); } catch (_) {} say("🙈 Still hidden — that pick had no screen in it."); return; }
      const p = vsPub;
      if (!p || p.kind !== "screen") { try { raw.getTracks().forEach((t) => t.stop()); } catch (_) {} return; }
      // retiring the old source stops its track, which fires the track's
      // own ended listener — the swapping flag tells that listener (and
      // any teardown path) this is a source change, not a share end
      p.swapping = true;
      vsCropStop();
      if (p.rawStream && p.rawStream !== raw) { try { p.rawStream.getTracks().forEach((t) => t.stop()); } catch (_) {} }
      p.rawStream = raw;
      rt.addEventListener("ended", () => { if (vsPub && vsPub.kind === "screen" && !vsPub.swapping) { try { vsShareTrackEnded(rt); } catch (_) {} } });
      let newTrack = rt, newLocal = new MediaStream([rt]);
      try { const cs = vsCropStart(rt); newTrack = cs.getVideoTracks()[0]; newLocal = cs; } catch (_) { vsCropStop(); }
      swapNew = { track: newTrack, local: newLocal, raw };
      // retire the old producer slot first (its track is being discarded
      // either way), then publish the fresh track into the same meeting
      try { if (p.meeting.self && p.meeting.self.disableVideo) await p.meeting.self.disableVideo(); } catch (_) {}
      await p.meeting.self.enableVideo(newTrack);
      p.pubTrack = newTrack; p.localStream = newLocal; p.hidApplied = false; p.swapping = false;
      await vsPubAudio(p.meeting, raw);
      if ((S.vstream || {}).hidden) { S.vstream.hidden = false; save(true); }
      vsPaintSig = null; vsPaintBtns(); vsSync();
      say("🖥 New source on the master screen — you are visible again.");
    } catch (_) {
      // a failure BEFORE the old source was touched (the picker was
      // cancelled) leaves him hidden on the old source; a failure AFTER
      // the swap began gets ONE honest retry of the publish — a
      // transient SDK hiccup mid-swap is not his Stop — and only a
      // second failure ends the share, rather than pretending the old
      // source is still there when it was already retired
      if (vsPub && vsPub.swapping) {
        let retried = false;
        try { if (swapNew && swapNew.track && swapNew.track.readyState === "live") { await vsPub.meeting.self.enableVideo(swapNew.track); vsPub.pubTrack = swapNew.track; vsPub.localStream = swapNew.local; vsPub.hidApplied = false; vsPub.swapping = false; await vsPubAudio(vsPub.meeting, swapNew.raw); if ((S.vstream || {}).hidden) { S.vstream.hidden = false; save(true); } vsPaintSig = null; vsPaintBtns(); vsSync(); say("🖥 New source on the master screen — you are visible again."); retried = true; } } catch (_) {}
        if (!retried) { vsPub.swapping = false; vsPubStop("🖥 Screen share stopped — the master screen is back to the video mix."); }
      }
      else say("🙈 Still hidden — the old source is still yours when you show again.");
    } finally { vsSwapBusy = false; }
  }
  /* ---------- OBS STUDIO: the screen runs through a crop canvas ----------
   * The raw display track feeds a hidden video element; each presented
   * frame is drawn into a 1280x720 canvas through the crop rectangle, and
   * the canvas stream is what gets published AND what this tab previews
   * on the booth stage — program-monitor style, he sees exactly what he
   * sends. drawImage is GPU compositing; there is no per-pixel JS work
   * and nothing here runs per frame except the draw itself. */
  /* the capture's own sound (owner, 2026-10-29 — the MASTER-SCREEN
   * RULE: whatever he puts on the master screen takes over the radio,
   * so the TV carries the capture's audio, never the DJ music). Tab
   * shares can hand over the tab's audio track; window and full-screen
   * picks usually cannot — then the share stays video-only, exactly as
   * before, and nothing pretends otherwise. The audio rides the raw
   * stream beside the canvas video (there is no canvas for sound) and
   * replaces whatever audio the meeting slot held. */
  /* ---------- share audio quality (owner, 2026-10-29) ----------
   * "The sound from my share sounds low quality — people will play it
   * in their cars." Two killers, in order: (1) the browser's default
   * VOICE processing on capture (echo cancellation, noise suppression,
   * auto gain — built for calls, ruinous for music), and (2) the
   * stack's default Opus bitrate, tuned for speech. The capture ask
   * below requests music-clean stereo at the source. What the publish
   * side can be pushed to depends on what the SDK leaves reachable —
   * vsAudioQuality walks whatever the meeting object actually exposes
   * and takes the deepest honest hook it finds. Everything is
   * best-effort and guarded: a quality tweak that throws must never
   * cost the publish itself. */
  const VS_AUDIO_Q = { echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 2 };
  async function vsGetDisplay() {
    // the one capture door for every screen pick (start, swap,
    // restore, and the supervisor's rebuilds ride the stream this
    // returns): music-clean stereo audio first, plain audio if the
    // platform refuses the ask outright, video-only last. A cancelled
    // picker is his answer and propagates at once — the later steps
    // run only on an outright refusal, never on a cancel
    try { return await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: { max: 30 } }, audio: VS_AUDIO_Q }); }
    catch (e) {
      if (e && e.name === "NotAllowedError") throw e;
      try { return await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: { max: 30 } }, audio: true }); }
      catch (e2) { if (e2 && e2.name === "NotAllowedError") throw e2; return navigator.mediaDevices.getDisplayMedia({ video: { frameRate: { max: 30 } }, audio: false }); }
    }
  }
  async function vsAudioQuality(meeting, atrack) {
    const p = vsPub;
    const rec = { settings: null, sender: false, producer: false, bitrate: 0, stereo: false, via: "" };
    try { const s = atrack && atrack.getSettings ? atrack.getSettings() : null; if (s) rec.settings = { ec: s.echoCancellation, ns: s.noiseSuppression, agc: s.autoGainControl, ch: s.channelCount }; } catch (_) {}
    if (p) p.audioQ = rec;
    const findHit = () => {
      // a bounded, read-only walk of the objects the SDK leaves
      // reachable from the meeting: the media handler subtree, self,
      // the stage controller, the meeting itself. Looking for any of:
      // a peer connection (getSenders), a producer for this track
      // (setRtpEncodingParameters), a transceiver map, a transport's
      // handler. Private (#) slots are invisible to the walk by
      // construction — what it finds is what the runtime truly offers
      const seen = new Set(); let nodes = 0;
      const isObj = (o) => !!o && (typeof o === "object" || typeof o === "function");
      const scan = (root, depth) => {
        if (!isObj(root) || seen.has(root) || depth > 3 || nodes > 400) return null;
        seen.add(root); nodes++;
        try {
          if (typeof root.getSenders === "function" && typeof root.getReceivers === "function") { const ss = root.getSenders() || []; for (const s of ss) { if (s && s.track === atrack) { let tr = null; try { tr = (root.getTransceivers() || []).find((t) => t.sender === s) || null; } catch (_) {} return { sender: s, pc: root, transceiver: tr }; } } }
          const snd = root.sender || root.rtpSender || root._rtpSender;
          if (snd && snd.track === atrack && typeof snd.getParameters === "function") return { sender: snd, transceiver: root.sender ? root : null };
          if (typeof root.setRtpEncodingParameters === "function" && root.track === atrack) return { producer: root };
          if (root instanceof Map) { for (const v of root.values()) { const r = scan(v, depth + 1); if (r) return r; } return null; }
          const h = root._handler || root.handler;
          if (isObj(h) && h !== root) { const r = scan(h, depth + 1); if (r) return r; }
          const keys = Object.keys(root);
          for (const k of keys) { if (k === "track" || k === "sender" || k === "rtpSender" || k === "_rtpSender" || k === "_handler" || k === "handler") continue; let v; try { v = root[k]; } catch (_) { continue; } if (isObj(v)) { const r = scan(v, depth + 1); if (r) return r; } }
        } catch (_) {}
        return null;
      };
      const roots = [];
      try { if (meeting.self && meeting.self.localMediaHandler) roots.push(meeting.self.localMediaHandler); } catch (_) {}
      try { if (meeting.self) roots.push(meeting.self); } catch (_) {}
      try { if (meeting.stage) roots.push(meeting.stage); } catch (_) {}
      roots.push(meeting);
      for (const r of roots) { const hit = scan(r, 0); if (hit) return hit; }
      return null;
    };
    for (let attempt = 0; attempt < 4; attempt++) {
      if (attempt) await new Promise((r) => setTimeout(r, attempt === 1 ? 500 : 1200));
      if (!atrack || atrack.readyState !== "live") return;
      let hit = null;
      try { hit = findHit(); } catch (_) {}
      if (!hit) continue; // the producer may not exist yet — enableAudio's own share step lands a beat after the call returns
      if (hit.producer && typeof hit.producer.setRtpEncodingParameters === "function") { try { await hit.producer.setRtpEncodingParameters({ maxBitrate: 256000 }); rec.producer = true; rec.bitrate = 256000; rec.via = "producer"; } catch (_) {} }
      if (hit.sender) {
        rec.sender = true; if (!rec.via) rec.via = "sender";
        try {
          const params = hit.sender.getParameters ? hit.sender.getParameters() : null;
          if (params && params.encodings && params.encodings.length) {
            for (const br of [256000, 128000]) {
              try { const np = hit.sender.getParameters(); np.encodings.forEach((en) => { en.maxBitrate = br; }); await hit.sender.setParameters(np); const back = hit.sender.getParameters(); const got = back && back.encodings && back.encodings[0] && back.encodings[0].maxBitrate; if (got) { rec.bitrate = got; break; } } catch (_) {}
              if (rec.bitrate) break;
            }
          }
        } catch (_) {}
        // Opus stereo / fullband: codec preferences live on the
        // transceiver. Pass the FULL capability list back with only
        // the opus fmtp widened (stereo=1, sprop-stereo=1,
        // maxaveragebitrate) — this shapes the next negotiation the
        // stack performs; it is attempted, never assumed
        try {
          const tr = hit.transceiver;
          const caps = (typeof RTCRtpSender !== "undefined" && RTCRtpSender.getCapabilities) ? RTCRtpSender.getCapabilities("audio") : null;
          if (tr && typeof tr.setCodecPreferences === "function" && caps && caps.codecs) {
            const codecs = caps.codecs.map((c) => {
              if (!/opus/i.test(c.mimeType || "")) return c;
              const parts = {};
              String(c.sdpFmtpLine || "").split(";").forEach((kv) => { const i = kv.indexOf("="); if (i > 0) parts[kv.slice(0, i).trim()] = kv.slice(i + 1).trim(); });
              parts.stereo = "1"; parts["sprop-stereo"] = "1"; parts.maxaveragebitrate = "256000";
              const nc = {}; for (const k of Object.keys(c)) nc[k] = c[k];
              nc.sdpFmtpLine = Object.keys(parts).map((k) => k + "=" + parts[k]).join(";");
              return nc;
            });
            tr.setCodecPreferences(codecs); rec.stereo = true;
          }
        } catch (_) {}
      }
      if (rec.bitrate || rec.sender || rec.producer) break;
    }
    try { console.debug("[vs] share audio quality: " + JSON.stringify(rec)); } catch (_) {}
  }
  async function vsPubAudio(meeting, raw) {
    try {
      const at = raw && raw.getAudioTracks ? raw.getAudioTracks()[0] : null;
      if (vsPub) vsPub.hadAudio = !!(at && at.readyState === "live"); // the supervisor (fix-studio5) verifies the audio leg only while the pick actually provides one
      try { if (meeting.self && meeting.self.disableAudio) await meeting.self.disableAudio(); } catch (_) {}
      if (!at) { if (vsPub) vsPub.pubAudio = null; return; }
      await meeting.self.enableAudio(at);
      if (vsPub) vsPub.pubAudio = at;
      // every publish leg funnels through here (start, swap,
      // supervisor rebuilds, remint, restore), so the music-quality
      // push is re-applied after EVERY rebuild, as specified
      try { vsAudioQuality(meeting, at); } catch (_) {}
    } catch (_) {}
  }
  async function vsStartScreen(meeting) {
    const raw = await vsGetDisplay();
    vsPub.rawStream = raw;
    const rt = raw.getVideoTracks()[0];
    if (!rt) throw new Error("no screen track");
    // owner rule (2026-10-29): the raw track ending ENDS the share —
    // the browser stop-sharing bar is one of his two sanctioned
    // endings, so the ended event runs the same clean end as his
    // booth Stop (vsShareTrackEnded). What the supervisor repairs is
    // everything else: dead SDK/canvas/audio legs under a LIVE raw
    // track
    rt.addEventListener("ended", () => { if (vsPub && vsPub.kind === "screen" && !vsPub.swapping) { try { vsShareTrackEnded(rt); } catch (_) {} } });
    try {
      const cs = vsCropStart(rt);
      const ct = cs.getVideoTracks()[0];
      await meeting.self.enableVideo(ct);
      vsPub.pubTrack = ct;
      vsPub.localStream = cs;
    } catch (_) {
      // the canvas path failed on this browser: publish the raw screen
      // track the same way — no second picker, just no crop this time
      vsCropStop();
      await meeting.self.enableVideo(rt);
      vsPub.pubTrack = rt;
      vsPub.localStream = new MediaStream([rt]);
      say("🖥 The crop frame could not run on this browser — your full screen is sharing instead.");
    }
    await vsPubAudio(meeting, raw);
  }
  function vsCropStart(track) {
    vsCropStop();
    const vid = document.createElement("video");
    vid.muted = true; vid.playsInline = true; vid.autoplay = true;
    vid.srcObject = new MediaStream([track]);
    const cv = document.createElement("canvas"); cv.width = 1280; cv.height = 720;
    const cc = { vid, cv, cx: cv.getContext("2d"), raf: 0, rvfc: 0, dead: false };
    vsCropCtx = cc;
    const draw = () => {
      if (cc.dead) return;
      vsCropDraw(cc);
      if (vid.requestVideoFrameCallback) { try { cc.rvfc = vid.requestVideoFrameCallback(draw); return; } catch (_) {} }
      cc.raf = requestAnimationFrame(draw);
    };
    try { const p = vid.play(); if (p && p.catch) p.catch(() => {}); } catch (_) {}
    draw();
    return cv.captureStream(30);
  }
  function vsCropDraw(cc) {
    try {
      if (vsPub && vsPub.hidApplied) { cc.cx.fillStyle = "#000"; cc.cx.fillRect(0, 0, cc.cv.width, cc.cv.height); return; }
      const v = cc.vid;
      if (!v.videoWidth || !v.videoHeight) return;
      const sw0 = v.videoWidth, sh0 = v.videoHeight;
      const lx = sw0 * vsCrop.l / 100, rx = sw0 * vsCrop.r / 100, ty = sh0 * vsCrop.t / 100, by2 = sh0 * vsCrop.b / 100;
      const sx = lx, sy = ty, sw = Math.max(16, sw0 - lx - rx), sh = Math.max(16, sh0 - ty - by2);
      const W = cc.cv.width, H = cc.cv.height, asp = sw / sh;
      let dw, dh;
      if (vsCrop.fill) { if (asp > W / H) { dh = H; dw = H * asp; } else { dw = W; dh = W / asp; } }
      else { if (asp > W / H) { dw = W; dh = W / asp; } else { dh = H; dw = H * asp; } }
      cc.cx.fillStyle = "#000"; cc.cx.fillRect(0, 0, W, H);
      cc.cx.drawImage(v, sx, sy, sw, sh, (W - dw) / 2, (H - dh) / 2, dw, dh);
    } catch (_) {}
  }
  function vsCropStop() {
    const cc = vsCropCtx; vsCropCtx = null;
    if (!cc) return;
    cc.dead = true;
    try { if (cc.rvfc && cc.vid.cancelVideoFrameCallback) cc.vid.cancelVideoFrameCallback(cc.rvfc); } catch (_) {}
    try { if (cc.raf) cancelAnimationFrame(cc.raf); } catch (_) {}
    try { cc.vid.pause(); cc.vid.srcObject = null; } catch (_) {}
  }
  /* ---------- watcher (every other screen) ---------- */
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
  /* the two track channels on a remote participant, SDK 2.0.4 shape
   * (read off the shipped UMD + the RTKParticipants docs): the camera
   * channel is participant.videoTrack; the screenshare channel is
   * participant.screenShareTracks.video — plural, nested. There is NO
   * participant.screenShareTrack property in the shipped 2.0.4 build, so
   * the old grab's first choice for kind "screen" read undefined on
   * every participant, forever. Both channels are always checked now;
   * the kind only sets the preference order, so the producer's picture
   * is picked up whichever channel it actually arrives on. */
  function vsTrackOf(p, key) {
    try { return key === "ss" ? (p.screenShareTracks && p.screenShareTracks.video) : key === "at" ? p.audioTrack : p.videoTrack; } catch (_) { return null; }
  }
  /* SUBSCRIPTION (the 2026-10-29 viewer failure): a remote track only
   * reaches this client for participants in the SDK's subscribed set
   * (participants.videoSubscribed, aliased as participants.active), and
   * the default ACTIVE_GRID view mode fills that set from pinned +
   * ON-STAGE + active-speaker heuristics — a silent, video-only producer
   * can starve there indefinitely: joined, publishing, and never
   * subscribed, so no consumer, no track, no .vslive element, no error.
   * MANUAL mode + participants.subscribe(ids) is the SDK's deterministic
   * path for a custom viewer (RTKParticipants docs: subscribe takes
   * peerIds + kinds, screenshareVideo included). It is idempotent, so
   * it is simply re-asserted on every walk. */
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
  /* the overlay elements exist from the moment a watch joins — the mount
   * is guaranteed by the join, not by the first frame (they stay
   * display:none until vs-on, so nothing black flashes) */
  function vsEnsureEls() { vsStageEls().forEach((st) => { try { vsVid(st); } catch (_) {} }); }
  /* ---------- THE WATCHER SWEEP (fix-studio3) ----------
   * THE NAMED BREAK (evidence, 2026-10-29): the gateway app is a
   * LIVESTREAM room - the same app serves the OBS RTMPS-to-HLS flow in
   * functions/api/streams.js. In the shipped SDK 2.0.4 bundle, every
   * consumer-creation path is gated on the participant's media join
   * (the ParticipantController bails out of onParticipantMediaJoined,
   * the selectedPeer handlers and updateActiveParticipantsWithPriorities
   * whenever mediaJoined is false), and for a LIVESTREAM room a
   * participant who is not ON_STAGE joins the socket ONLY -
   * SelfController.roomJoined special-cases exactly that and joinRoom
   * logs the socket-only local peer. A viewer-preset participant is
   * off-stage by design, so the watcher joined fine, the publisher sat
   * in participants.joined with his producers listed, subscribe() added
   * him to videoSubscribed - and syncConsumers never ran for this peer,
   * no consumer was ever created, and participant.videoTrack /
   * screenShareTracks.video stayed undefined forever (they are only
   * ever assigned at consumer creation). No error at any step: the mint
   * was provably good, the state provably live, the publisher provably
   * bound to the same meeting - and members saw only the mix. That is
   * why the event-driven watch, the stamp/latch fixes and manual
   * subscribe could not fix it: they all end at a track field that
   * only a media join can fill.
   * THE REBUILD: the watcher is a 1s POLLING sweep. It joins the same
   * way, walks EVERY participant collection, reads both track channels
   * off every peer, and attaches the first live track it finds - the
   * subscribe assist stays, but nothing waits on it or on any event.
   * When the room is a LIVESTREAM room it also tries the two honest
   * ways in: join the stage (which is what media-joins a peer), and
   * the room's own live playback URL (HLS) when the room offers one.
   * Every failure lands in vsWatchErr and on the TV status line, and
   * the sweep retries on its own cadence - no silent death, no latch. */
  function vsDiag(w, peers, anyProducer) {
    try {
      window.MW_vsDiag = { at: Date.now(), meeting: w.mid, viewType: w.viewType || "", stageStatus: w.stageStatus || "", err: vsWatchErr || "", producerSeen: !!anyProducer, peers: (peers || []).map((p) => { let vt = null, ss = null; try { vt = p.videoTrack || null; } catch (_) {} try { ss = (p.screenShareTracks && p.screenShareTracks.video) || null; } catch (_) {} let prods = []; try { prods = (p.producers || []).map((x) => String((x && x.kind) || "")); } catch (_) {} return { id: String(p.id || ""), name: String(p.name || p.displayName || ""), videoTrack: !!vt, ssTrack: !!ss, videoOn: !!p.videoEnabled, ssOn: !!p.screenShareEnabled, producers: prods }; }) };
    } catch (_) {}
  }
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
      vsSubAll(w.meeting); // subscribe assist - even while hidden, so an unhide renders fast; never load-bearing
      if ((S.vstream || {}).hidden) { vsDetach(); return; } // HIDE SHARE: the join stays up, the picture does not render
      if (vsShareDown()) { vsDetach(); return; } // fix-studio5: the publisher diag says its chain is down — hold the mix underneath, never a corpse frame presented as live
      if (vsLocalPause) return; // VIEWER PAUSE (fix-studio4): this viewer paused the capture just for themselves — the join stays up, nothing renders, nothing is written anywhere
      const kind = (S.vstream || {}).kind;
      const order = kind === "screen" ? ["ss", "vt"] : ["vt", "ss"];
      const peers = vsPeers(w.meeting);
      let best = null, anyProducer = false;
      let bestP = null;
      peers.forEach((p) => { if (!p) return; try { if (p.producers && p.producers.length) anyProducer = true; } catch (_) {} if (best) return; for (const key of order) { const t = vsTrackOf(p, key); if (t && t.readyState === "live") { best = t; bestP = p; break; } } });
      try { w.stageStatus = (w.meeting.self && w.meeting.self.stageStatus) || w.stageStatus || ""; } catch (_) {}
      vsDiag(w, peers, anyProducer);
      if (best) { w.got = Date.now(); if (vsShown.hls) vsDetach(); const at2 = bestP ? vsTrackOf(bestP, "at") : null; vsShowTrack(best, at2 && at2.readyState === "live" ? at2 : null); return; }
      if (vsShown.hls) { // the room playback is carrying the picture - but WebRTC stays the preferred path: while only HLS is up, retry the stage join about every 30s, and the moment a real track lands the branch above swaps the picture over to it
        if (w.viewType === "LIVESTREAM" && Date.now() - (w.stageRetryAt || w.stageTried || 0) > 30000) { w.stageRetryAt = Date.now(); w.stageTried = Date.now(); vsTryStage(w); }
        return;
      }
      if (w.got && vsShown.track && vsShown.track.readyState === "ended") { vsWatchStop(); vsDetach(); return; } // the producer left mid-stream
      // no WebRTC track: in a LIVESTREAM room an off-stage watcher never
      // gets one (see the note above) - ask for the stage once, then
      // take the room playback when the room offers one
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
      // MANUAL subscription mode from the start (see vsSubAll): the
      // viewer subscribes to the room explicitly instead of hoping the
      // active-speaker heuristics pick a silent video producer
      try { meeting.participants.setViewMode("MANUAL"); } catch (_) {}
      try { const jn = meeting.participants.joined, cb = (pp) => { vsHookPeer(pp); vsWatchGrab(); }; if (typeof jn.on === "function") { jn.on("participantJoined", cb); jn.on("participantLeft", () => vsWatchGrab()); } else if (typeof jn.addListener === "function") { jn.addListener("participantJoined", cb); jn.addListener("participantLeft", () => vsWatchGrab()); } } catch (_) {}
      try { const ac = meeting.participants.active; if (ac && typeof ac.on === "function") ac.on("participantJoined", () => vsWatchGrab()); } catch (_) {}
      // a join that never settles must not latch the watcher: the old
      // code stored vsWatch BEFORE the await and waited forever, so one
      // hung join meant no retry, no element, no picture for the whole
      // session. Fifteen seconds, then it counts as a failed join.
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
      // walk who is ALREADY in the room — a producer who started before
      // this viewer arrived must render now, not on some future event;
      // the 2.5s grab below keeps re-walking the room the whole session
      vsWatchGrab();
      w.iv = setInterval(() => { try { vsWatchGrab(); } catch (_) {} }, 1000);
    } catch (e) {
      vsNoteErr(e);
      // a failed or half-joined watch is torn down and RETRIED in about
      // 20s for as long as the switch stays on — fresh mint, fresh SDK
      // meeting object, fresh join; never latched off for the session
      if (meeting) { try { await meeting.leave(); } catch (_) {} }
      if (vsWatch && vsWatch.mid === mid) { const w2 = vsWatch; vsWatch = null; if (w2.iv) { try { clearInterval(w2.iv); } catch (_) {} } }
      vsWatchRetry(mid);
    }
    finally { vsWatchBusy = false; }
  }
  /* the master switch — runs on the stage cadence from stageApply */
  function vsSync() {
    try {
      vsPaintBtns(); vsPaintStatus(); vsPaintPause();
      const vs = S.vstream || {};
      // discarded-and-restored publisher tab: the capture itself cannot
      // come back after a reload, and the switch is NEVER cleared on
      // wake — but he is told, once, in plain words, instead of the old
      // silent ghost (switch on, stamp frozen, nobody in the meeting)
      if (!vsPub && !SANDBOX && OWNER()) {
        try {
          const mk = JSON.parse(sessionStorage.getItem("mw_vspub") || "null");
          const ghost = !!(mk && mk.mid && vs.on && vs.meeting === mk.mid && vs.by === vsUid());
          if (ghost) {
            // the marker stays while the ghost holds — the restore bar
            // needs the kind off it, and the bar (not a one-shot
            // message) is the way back now (fix-studio5)
            if (!vsBarGhost) { vsBarGhost = true; vsBarPaint(); say("🖥 This tab was reloaded while you were sharing, so the capture itself is gone — the switch was left untouched. The red restore bar on the booth stage brings it back in one tap."); }
          } else {
            if (vsBarGhost) { vsBarGhost = false; vsBarPaint(); }
            if (mk && mk.mid && Date.now() - vsArrivedAt > 8000 && (!vs.on || vs.meeting !== mk.mid)) sessionStorage.removeItem("mw_vspub");
          }
        } catch (_) {}
      }
      if (vsPub) {
        if (!vs.on || vs.meeting !== vsPub.mid) {
          // A SHARE ENDS ONLY WHEN HE ENDS IT (owner, 2026-10-29:
          // "never stop my tab from being shared until i do"). The old
          // code counted three mismatched ticks and tore the publish
          // down — but a mismatch can be a stale echo: another of his
          // tabs re-saving an older copy of the switch, an adopt
          // landing mid-flight, a half-loaded screen. State alone now
          // ends this publish only two ways, both deliberately his:
          // (1) an explicit Stop from another of his screens — those
          // writes carry a stopAt stamp the button itself wrote, newer
          // than this publish's start; (2) a NEWER share he started on
          // another screen taking the screen over (a claim fresher
          // than this publish, from his own account). Anything else,
          // the live publisher re-asserts its own switch and keeps
          // publishing — the meeting it actually joined is the truth,
          // not an echoed row. A non-publisher screen can never end
          // the share by itself.
          if (vsPub.starting) return;
          if (!vs.on && vs.stopAt && vs.stopAt >= (vsPub.since || 0)) { vsPubStop("🖥 Screen share stopped from your other screen — the master screen is back to the video mix."); return; }
          if (vs.on && vs.meeting && vs.meeting !== vsPub.mid && vs.by === vsUid() && (vs.at || 0) > (vsPub.since || 0)) { const p0 = vsPub; if (p0) p0.pausedDecks = null; vsPubTeardown(); vsDetach(); return; } // the new share owns the tables-pause now — this tab must not resume decks on its way out. fix-studio5: the claim must name a DIFFERENT meeting — as first written, an echo of THIS share (his other screen re-saving the switch it adopted, at stamp and all, the stamp this very tab kept advancing) fired the branch against the publisher's own meeting and tore a healthy publish down: teardown stopped the capture, the switch stayed on for a successor who never existed, and the restore marker died with the record
          S.vstream = { on: true, kind: vsPub.kind, at: vs.at || 0, by: vsUid(), meeting: vsPub.mid, hidden: !!vsPub.hidApplied, stopAt: 0, diag: vs.diag || { stage: vsPub.dStage || "repairing", at: vsPub.dAt || 0, repairs: vsPub.repairs || 0 } };
          save(true);
        }
        vsPub.strikes = 0;
        // no cadence stamp here anymore (fix-studio5): re-asserting the
        // switch restores its shape but never its stamp — vstream.at is
        // advanced only by the supervisor, on proof
        // HIDE SHARE on the publishing tab: apply the state the moment it
        // flips (from this tab's button or any of his screens) — the
        // picture stops, the placeholder stands in for the preview, and
        // the session underneath (meeting, pause) is untouched
        if (vsPub.kind === "screen") {
          const hid = !!vs.hidden;
          if (hid !== !!vsPub.hidApplied) { vsPub.hidApplied = hid; vsApplyHidden(hid); }
          if (hid) { vsDetach(); vsHiddenPh(true); return; }
        }
        vsHiddenPh(false);
        // PROGRAM PREVIEW (OBS station): this tab renders its OWN local
        // stream — the crop canvas for a screen share, the camera track
        // for Live Video — exactly what it is sending, with no meeting
        // round-trip. His other screens and viewers use the meeting path.
        const m = vsPub.meeting; let tr = null;
        try { tr = (vsPub.localStream && vsPub.localStream.getVideoTracks()[0]) || (vsPub.kind === "screen" ? (m.self.screenShareTracks && m.self.screenShareTracks.video) : m.self.videoTrack); } catch (_) {}
        if (tr) vsShowTrack(tr);
        return;
      }
      if (SANDBOX || !vs.on || !vs.meeting) { if (vsLocalPause) { vsLocalPause = false; vsPauseWasListening = false; vsPauseSig = ""; } if (vsWatch) vsWatchStop(); vsDetach(); return; }
      // the station stage is UP whenever a share is live and not hidden —
      // guaranteed here, on the watch cadence itself, not only by the
      // stage painter (whose render path awaits third-party players)
      if (!OWNER() && !vs.hidden) { const bx = document.querySelector("#st-ytbox"); if (bx) bx.hidden = false; }
      if (vsWatch && vsWatch.mid !== vs.meeting) { vsWatchStop(); vsDetach(); }
      // LIVENESS (2026-10-29 fix): a stale stamp must never keep a viewer
      // out — the meeting itself is the truth, not the clock. The old code
      // hard-refused every join once the stamp was 120s old and latched a
      // single failed join for the whole session, so one frozen stamp
      // blacked out every viewer permanently. Now: join whenever the
      // switch is on, and retry a failed join about every 20s for as
      // long as the switch stays on.
      if (!vsWatch) { if (vsWatchRetryMid === vs.meeting && Date.now() < vsWatchRetryAt) return; vsWatchStart(vs.meeting); return; }
      // HIDE SHARE for viewers: the join stays up (unhide is instant),
      // but nothing renders while the owner has the share hidden — the
      // stage and mini fall back to the normal video mix underneath
      if (vs.hidden) { vsDetach(); return; }
      // fix-studio5: while the publisher reports itself repairing or
      // source-gone, viewers hold the mix underneath — the stage must
      // not present a dead share as the live TV picture (the status
      // line reads "TV: reconnecting…"). The join itself stays up, so
      // the moment the chain proves again the picture returns, and a
      // remint is followed through the meeting change above
      if (vsShareDown()) { vsDetach(); return; }
      try { if (vsShown.hls) vsHlsPickSound(false); } catch (_) {}
      vsWatchGrab();
    } catch (_) {}
  }
  document.addEventListener("click", (e) => {
    const t = e.target;
    if (!t || !t.closest) return;
    if (t.closest("#tw-sound")) { if (window.MW_DJ) window.MW_DJ.toggle(); tvSig = ""; try { tvPaint(); } catch (_) {} return; }
    if (t.closest("#tw-watch") || t.closest("#st-watch")) { try { cutOtherAudio(); } catch (_) {} try { startListening(); } catch (_) {} if (typeof go === "function") go("watch"); return; }
    if (t.closest("#wb-sound")) { if (window.MW_DJ) window.MW_DJ.toggle(); return; }
    if (t.closest(".wsu-x")) { wsModal("ws-upsell", false); return; }
    if (t.closest(".wsu-plans")) { wsModal("ws-upsell", false); wsModal("ws-plans", true); wsPaintPlans(); return; }
    if (t.closest(".wsu-free")) { wsModal("ws-upsell", false); wsGoBasic(); return; }
    if (t.closest(".wpl-x")) { wsModal("ws-plans", false); return; }
    if (t.closest(".wpl-free")) { wsModal("ws-plans", false); wsGoBasic(); return; }
    if (t.closest(".wpl-trial")) { wsStartTrial(t.closest(".wpl-trial")); return; }
    if (t.closest(".ws-ctl")) { if (!OWNER() && !SANDBOX) wsUpsell(); return; }
    if (t.closest("#tw-fs")) { const sh = document.getElementById("tw-shell"); try { if (document.fullscreenElement) document.exitFullscreen(); else if (sh && sh.requestFullscreen) sh.requestFullscreen(); } catch (_) {} return; }
    if (t.closest("[data-vsrestore]")) { vsPubRestore(); return; }
    if (t.closest(".vspause")) { vsToggleLocalPause(); return; }
    if (t.closest("[data-hidebtn]")) { vsToggleHide(); return; }
    if (t.closest("[data-capbtn]")) { vsToggle("screen"); return; }
    if (t.closest("[data-vlive]")) { vsToggle("cam"); return; }
    if (t.closest("[data-studiofit]")) { vsCrop.fill = !vsCrop.fill; vsCropSave(); vsStudioSig = ""; vsPaintStudio(); return; }
    if (t.closest("[data-studioreset]")) { vsCrop = { l: 0, r: 0, t: 0, b: 0, fill: vsCrop.fill }; vsCropSave(); vsStudioSig = ""; vsPaintStudio(); }
  });
  /* crop sliders apply live — the draw loop reads vsCrop on every frame,
   * so a drag reframes the published picture (and his preview) at once */
  document.addEventListener("input", (e) => {
    const t = e.target;
    if (!t || !t.dataset || !t.dataset.crop) return;
    const k = t.dataset.crop;
    if (k !== "l" && k !== "r" && k !== "t" && k !== "b") return;
    vsCrop[k] = Math.max(0, Math.min(45, +t.value || 0));
    vsCropSave(); vsStudioLabels();
  });
  /* waking up re-asserts the share at once — re-stamp, switch check and
   * a republish if the published track died in its sleep (vsPubWake).
   * NOTHING on any wake path clears the switch or stops the share. */
  document.addEventListener("visibilitychange", () => { if (!document.hidden) vsPubWake(); });
  window.addEventListener("pageshow", () => vsPubWake());
  window.addEventListener("focus", () => vsPubWake());
  document.addEventListener("resume", () => vsPubWake());
  /* a refused unmuted play (the capture's sound attempted before the
   * viewer had tapped anything) retries on their first tap anywhere —
   * the one gesture every platform accepts; it starts nothing else */
  document.addEventListener("pointerdown", () => { if (!vsSndBlocked) return; vsSndBlocked = false; try { if (vsShown.atrack) vsAudioPlay(vsShown.atrack); if (vsShown.hls) vsHlsPickSound(true); } catch (_) {} }, true);
  /* the live-share watch runs on its OWN cadence, not only at the tail
   * of stageApply: that paint path awaits third-party player APIs (up to
   * 7s each on a cold load, three providers in a row), and a viewer
   * whose stage tick is stuck behind a slow player API must still join
   * the share. vsSync is idempotent and sig-guarded, so a 1s tick of its
   * own costs nothing when nothing changed. */
  setInterval(() => { try { vsSync(); } catch (_) {} }, 1000);

  /* ---------- the MASTER music-video screen ----------
   * Two player slots dissolve into each other exactly like the audio
   * crossfade: in AUTO the visuals ride the same gains the X fader gives the
   * sound, so fading the sound fades the picture. The booth's screen sits in
   * the master section (muted there — the decks make the sound); viewers get
   * the SAME screen on the station card, with the sound, mixed by the same
   * numbers. The booth can also mix the picture by hand: S.vmix holds
   * {mode:"man", a, b, t} and every screen follows it. */
  const stageGain = (k) => { const s = S[k], cd = k === "C" || k === "D", x = cd ? (S.xf2 ?? 0.5) : S.xf, side = k === "B" || k === "D" ? "B" : "A", py = S.panY || 0, pairG = cd ? (py < 0 ? 1 + py : 1) : (py > 0 ? 1 - py : 1); return (s.vol ?? 0.9) * xfGain(x, side) * pairG * pairXGain(S.panX, cd); };
  const mkScreen = (ids, standby, chip, poster) => ({ ids, standby, chip, poster: poster || null, slots: [{ deck: "", vid: "", p: null }, { deck: "", vid: "", p: null }] });
  const scrBooth = mkScreen(["#dj-vs1", "#dj-vs2"], "#dj-vstandby", "#dj-vchip");
  const scrView = mkScreen(["#st-vs1", "#st-vs2"], "#st-vstandby", "#st-vchip", "#st-vposter"); // station stage carries the radio poster in its standby slot (owner, 2026-10-29)
  const scrMini = mkScreen(["#mn-vs1", "#mn-vs2"], null, null); // no title chip on the pop-out screen (owner, 2026-10-28: "take the title off the screen in my master video pop out")
  const scrTV = mkScreen(["#tw-vs1", "#tw-vs2"], "#tw-vstandby", "#tw-vchip"); // MW TV: the channel page's screen — same mix renderer, its own branded standby slate
  const scrWatch = mkScreen(["#wb-vs1", "#wb-vs2"], "#wb-vstandby", "#wb-vchip", "#wb-vposter"); // WATCH THE SETUP: the spectator booth master screen — same mix renderer, the radio poster in its standby slot like the station stage
  /* stateSeen: has a real radio/dj snapshot reached this tab yet? The
   * viewer slates (MW TV first) must not assert a station state - on
   * air or off air - before the first one lands: a cold tab paints the
   * neutral connecting slate until onState says otherwise. */
  let stateSeen = false;
  function vmixTargets() {
    const vm = S.vmix || { mode: "auto", a: "", b: "", t: 0 };
    if (vm.mode === "man" && vm.a && S[vm.a] && S[vm.a].yt) {
      const t = Math.max(0, Math.min(1, +vm.t || 0)), out = [{ k: vm.a, op: 1 - t }];
      if (vm.b && S[vm.b] && S[vm.b].yt && S[vm.b].yt !== S[vm.a].yt) out.push({ k: vm.b, op: t });
      return out.filter((x) => x.op > 0.01);
    }
    const gs = DECKS.filter((k) => S[k].yt && S[k].playing).map((k) => ({ k, g: stageGain(k) })).filter((x) => x.g > 0.02).sort((a, b) => b.g - a.g).slice(0, 2);
    if (!gs.length) return [];
    const sum = gs.reduce((a, x) => a + x.g, 0) || 1;
    return gs.map((x) => ({ k: x.k, op: Math.max(0.02, x.g / sum) }));
  }
  /* the booth PUBLISHES the mix (owner, 2026-10-29: "I want to be able
   * to play the music videos live as well"): in AUTO mode the screens
   * derive the mix from the deck state, but the shared S.vmix record
   * itself was only ever written by the manual Cut / Fade / solo
   * buttons — left on auto it sat at the defaults (a and b empty, at 0)
   * while a video was on air, so the record every screen stamps its
   * transitions from claimed no video was playing. The lead booth now
   * mirrors its own auto computation into the record on the stage
   * cadence: a = the dominant audible deck, b = the second deck of a
   * blend with t = its share (the same shape manual mode uses), at
   * stamped whenever the dominant deck changes, and the record is
   * cleared when no video deck is on air so every screen falls back
   * to the standby slate. Manual mode is never touched here. */
  function vmixPublish() {
    if (SANDBOX || !OWNER() || !boothLead) return;
    const vm = S.vmix || {};
    if (vm.mode === "man") return;
    const tg = vmixTargets();
    const a = tg.length ? tg[0].k : "", b = tg.length > 1 ? tg[1].k : "", t = tg.length > 1 ? tg[1].op : 0;
    if (a !== (vm.a || "") || b !== (vm.b || "")) {
      S.vmix = { mode: "auto", a, b, t, tr: vm.tr || "fade", trMs: vm.trMs || 650, at: Date.now() };
      save();
    } else if (a && Math.abs(t - (+vm.t || 0)) >= 0.05) {
      S.vmix = { mode: "auto", a, b, t, tr: vm.tr || "fade", trMs: vm.trMs || 650, at: vm.at || 0 };
      save();
    }
  }
  /* ---------- the booth SKIP button under the master screen ----------
   * (owner, 2026-10-29: "Give me a skip button underneeth my screen").
   * The featured deck is the vmix target with the highest opacity -
   * the same "top" the station title chip names. The button ends that
   * deck through deckEnded, the natural-end path, so blends, horns,
   * queue and Auto-DJ advance and brain capture all behave exactly as
   * if the song had run out on its own. While a live, unhidden stream
   * (screen share or Live Video) holds the master there is no deck
   * video to skip, so the row hides; while the featured deck is not
   * playing the button sits disabled instead of lying. */
  const vmixTop = () => { const tg = vmixTargets(); return tg.length ? tg.slice().sort((a, b) => b.op - a.op)[0] : null; };
  function paintVSkip() {
    const b = document.getElementById("dj-vskip"); if (!b) return;
    const row = document.getElementById("dj-vskiprow");
    const shareHolds = vsBroadcast() && !(S.vstream || {}).hidden && !vsShareDown();
    if (row) row.style.display = shareHolds ? "none" : "";
    if (shareHolds) return;
    const top = vmixTop(), on = !!(top && S[top.k] && S[top.k].playing);
    b.disabled = !on;
    b.textContent = on ? "⏭ Skip deck " + top.k + " — end this song, roll the next" : "⏭ Skip — nothing playing on the master screen";
  }
  /* ================= SYNC LOCK (owner, 2026-10-29) =================
   * "The lips dont match the audio in my master screens - make sure
   * they all stay sync locked together, no lag, optimise everything."
   * The audit found the drift: every master-screen player used to
   * chase posOf() - the RAW local clock - with a 3s seek tolerance
   * (6s for Dailymotion/Vimeo), while the deck audio chases the
   * server-corrected clock (syncDecks: Date.now()+clockOff, a 0.08s
   * deadband, a snap at 0.35s). Two different clocks plus a 3s
   * allowance is a lip mismatch by construction. Worse, on the MW TV
   * and Watch surfaces TWO mix screens could sound at once - the
   * station stage kept rendering and unmuting underneath them - so a
   * viewer could watch one player while hearing another one entirely.
   * THE LOCK: one broadcast clock for every picture (bcastPos - the
   * same basis syncDecks uses), one sounding mix screen at a time
   * (vmixSndScr), and a correction loop with hysteresis: inside the
   * 0.12s deadband nothing moves; small drift glides back on a
   * playback-rate nudge (0.95/1.05); past 0.35s the player snaps to
   * the broadcast position, at most one snap per slot per 3s, never
   * while buffering, never in the last 5s of a track. On the booth's
   * own tabs the screens lock to the deck element itself (audPos) -
   * the sound Meechie actually hears - so his picture cannot drift
   * from his speakers even while the wall clock is still settling. */
  const SYNC_DEAD = 0.12, SYNC_SNAP = 0.35;
  function syncLockCalc(drift, mul) {
    const m = mul || 1, ad = Math.abs(drift || 0);
    if (!(ad > SYNC_DEAD * m)) return { act: "none", rate: 1 };
    if (ad <= SYNC_SNAP * m) return { act: "nudge", rate: drift > 0 ? 0.95 : 1.05 };
    return { act: "snap", rate: 1 };
  }
  try { window.MW_syncLockCalc = syncLockCalc; } catch (_) {}
  /* quality cap per viewer surface (NO-SKIP WS5): the station stage
   * and the mini never need more than 480 at their size; Watch and
   * MW TV never more than 720 - fewer rendition switches, less data
   * to stall on. vCapFor answers null for the booth screen, and the
   * booth's own player builds pass no options object at all, so the
   * booth's players are never capped by this pass. */
  function vCapFor(scr) { if (scr === scrView || scr === scrMini) return "large"; if (scr === scrWatch || scr === scrTV) return "hd720"; return null; }
  /* stall bookkeeping for one viewer slot (NO-SKIP WS3): fed the
   * player state, its clock, the broadcast want and the deck's
   * playing flag on every render pass. A YouTube BUFFERING state
   * masks at once; any other stall masks once the clock has not
   * advanced for over 1.2s; the mask lifts after 0.8s of clean
   * playing WITH the clock advancing, accumulated flap-tolerantly
   * (VIEWER-LEG FIX 2, inside bufStep below). While masked,
   * exactly one invisible re-lock snap is allowed and only when
   * the drift is over 2s: _maskSnap flags the one pass on which
   * renderScreen may take it. The sync constants are untouched -
   * this works around them, never retunes them. */
  function bufStep(sl, stt, cur, want, playing, now) {
    sl._maskSnap = false;
    if (!playing) { sl._bMask = false; sl._bufSince = 0; sl._bStateAt = 0; sl._bCleanAcc = 0; sl._bDirtySince = 0; sl._bPrevAt = 0; sl._bPrevClean = false; sl._bLastCur = null; sl._bAdvAt = 0; sl._maskSnapAt = 0; return sl; }
    if (sl._bLastCur == null) { sl._bLastCur = cur; sl._bAdvAt = now; }
    const adv = Math.abs(cur - sl._bLastCur) > 0.02;
    if (adv) { sl._bLastCur = cur; sl._bAdvAt = now; }
    if (stt === 3) { if (!sl._bStateAt) sl._bStateAt = now; }
    else if (stt !== 3) sl._bStateAt = 0;
    /* VIEWER-LEG FIX (2): flap-tolerant lift. Clean play ACCUMULATES
     * toward the 800ms lift instead of demanding one unbroken run: a
     * non-playing stretch wipes the accumulation only once it runs
     * longer than 400ms continuously (a dirty-since stamp, symmetric
     * to _bStateAt), so a lone BUFFERING sample flapping between
     * PLAYING samples can no longer starve the lift forever. */
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
  try { window.MW_bufStep = bufStep; } catch (_) {}
  function bcastPos(k) { const s = S[k]; if (!s) return 0; if (!s.playing) return s.pos || 0; const now = boothLead ? Date.now() : Date.now() + clockOff; return Math.max(0, (now - (s.start || now)) / 1000); }
  function audPos(k) { try { if (!OWNER()) return null; const d = decks[k]; if (!d || !d.el || !S[k] || !S[k].playing) return null; const ct = +d.el.currentTime; return isFinite(ct) && ct > 0 ? ct : null; } catch (_) { return null; } }
  function slotWant(scr, k) { if (OWNER()) { const ap = audPos(k); if (ap != null) return ap; } return bcastPos(k); }
  /* ONE SOUNDING SCREEN (the mix half of the one-audio-clock rule):
   * exactly one mix screen may carry sound - MW TV when the channel
   * is open, else the Watch screen when it is open, else the station
   * stage (which is also what keeps the radio audible while a
   * listener browses the rest of the site). The booth and the mini
   * never sound - the decks and the big screens own the sound there -
   * an owner's screens never sound (his decks do), and while a live
   * share holds the master NO mix screen sounds at all: the capture
   * carries its own audio, and that is the only sound (takeover). */
  function vmixSndScr() {
    if (OWNER() || !listening) return null;
    if (vsBroadcast() && !(S.vstream || {}).hidden) return null;
    if (SANDBOX) return scrView;
    const tv = document.getElementById("v-mwtv"); if (tv && !tv.hidden) return scrTV;
    const wa = document.getElementById("v-watch"); if (wa && !wa.hidden) return scrWatch;
    return scrView;
  }
  /* one screen player for any video platform: the wrapper speaks the YT-ish
   * surface renderScreen already uses, whatever player is underneath */
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
    const ready = () => { try { if (muted || warm) w.mute(); try { const wd = mountEl && mountEl.clientWidth ? mountEl.clientWidth : 640; let q = wd >= 1100 ? "hd720" : wd >= 560 ? "large" : "medium"; if (!muted && q === "medium") q = "large"; if (vopt && vopt.cap) { const qr = { small: 0, medium: 1, large: 2, hd720: 3, hd1080: 4 }; if ((qr[q] || 0) > (qr[vopt.cap] || 0)) q = vopt.cap; } w.setQuality(q); } catch (_) {} const ap = audPos(deckK); w.seekTo(Math.max(0, ap != null ? ap : bcastPos(deckK))); if (warm) { if (vopt && vopt.roll) { try { w.mute(); } catch (_) {} w.playVideo(); } else w.pauseVideo(); } else w.playVideo(); } catch (_) {} };
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

  /* animate one slot with the chosen transition, then lock it to the sound:
   * the wrapper takes the animation (transform / clip / filter / overlay) and
   * the player inside is never reloaded; on landing, if the slot's player is
   * more than ~1s off the deck's live position it is seeked once (and the
   * follow loop's cooldown is stamped so it does not immediately re-seek) */
  function vtrSlot(scr, k, tr, ms) {
    const i = scr.slots.findIndex((sl) => sl.deck === k); if (i < 0) return;
    const el = $(scr.ids[i]); if (!el) return;
    const cls = "vtr-" + tr;
    ["vtr-fade", "vtr-wipe", "vtr-slide", "vtr-zoom", "vtr-blur", "vtr-flash", "vtr-glitch"].forEach((c) => el.classList.remove(c));
    void el.offsetWidth;
    el.style.setProperty("--vtrd", (ms || 650) + "ms");
    el.classList.add(cls);
    setTimeout(() => el.classList.remove(cls), (ms || 650) + 600);
    const sl = scr.slots[i];
    if (sl.p) { try { const want = slotWant(scr, k), cur = sl.p.getCurrentTime ? sl.p.getCurrentTime() : want, stt = sl.p.getPlayerState ? sl.p.getPlayerState() : -1; if (Math.abs(cur - want) > SYNC_SNAP && stt !== 3) { sl.p.seekTo(want, true); sl.seekAt = Date.now(); } } catch (_) {} }
  }
  async function renderScreen(scr, muted, mix, duck) {
    const tg = vmixTargets();
    // a true dissolve, full brightness at every point of the fade: the weaker
    // picture sits underneath at full strength and the stronger one fades in
    // over it by its share — slide the fader to a deck's 100% and the screen
    // is 100% that deck; park it in the middle and the two videos blend
    const srt = tg.slice().sort((a, b) => a.op - b.op), disp = {};
    if (srt.length === 2) { disp[srt[0].k] = 1; disp[srt[1].k] = srt[1].op; } else if (srt.length === 1) disp[srt[0].k] = 1;
    scr.slots.forEach((sl, i) => { if (sl.deck && !tg.some((x) => x.k === sl.deck)) { sl.warmK = sl.deck; sl.deck = ""; const el = $(scr.ids[i]); if (el) el.style.opacity = 0; if (sl.p) { try { sl.p.pauseVideo(); } catch (_) {} } } });
    const stb = scr.standby ? $(scr.standby) : null; if (stb && !tg.length) stb.style.display = "grid";
    const pst = scr.poster ? $(scr.poster) : null; if (pst && !tg.length) pst.style.display = "block";
    const chip = $(scr.chip);
    if (!tg.length) { scr._vTop = ""; if (chip) chip.hidden = true; return; }
    let picLive = false;
    const provs = new Set(tg.map((t) => vparseTok(S[t.k].yt).p));
    if (provs.has("yt")) await ytApi();
    if (provs.has("dm")) await dmApi();
    if (provs.has("vm")) await vmApi();
    for (const t of tg) {
      let i = scr.slots.findIndex((sl) => sl.deck === t.k);
      if (i < 0) {
        // BUFFER PASS: a free slot already holding this deck's video as a
        // warm (paused, muted) player is promoted in place - the switch
        // lands on a loaded player instead of a cold build.
        const wi = scr.slots.findIndex((sl) => !sl.deck && sl.warmK === t.k && sl.p && sl.vid === S[t.k].yt);
        if (wi >= 0) { i = wi; const sl = scr.slots[i], el = $(scr.ids[i]); sl.deck = t.k; sl.warmK = ""; if (el) { el.style.opacity = (disp[t.k] != null ? disp[t.k] : t.op).toFixed(2); el.style.zIndex = srt.length === 2 && srt[0].k === t.k ? 1 : 2; } }
      }
      if (i < 0) {
        i = scr.slots.findIndex((sl) => !sl.deck); if (i < 0) continue;
        const sl = scr.slots[i], mount = $(scr.ids[i]); if (!mount) continue;
        if (sl.p) { try { sl.p.destroy(); } catch (_) {} }
        sl.deck = t.k; sl.vid = S[t.k].yt; sl.p = null; sl.warmK = ""; sl._hadFrame = false; sl._noFrameAt = 0; sl._healN = 0; sl._bMask = false; sl._bufSince = 0; sl._bStateAt = 0; sl._bLastCur = null; sl._maskSnapAt = 0; sl._lastHealAt = 0; sl._bufHealN = 0; sl._cleanPlayAt = 0; sl._sawPlay = false; sl._maskCov = false; sl._bCleanAcc = 0; sl._bDirtySince = 0; sl._bPrevAt = 0; sl._bPrevClean = false; mount.innerHTML = "<div></div>";
        mount.style.opacity = (disp[t.k] != null ? disp[t.k] : t.op).toFixed(2); mount.style.zIndex = srt.length === 2 && srt[0].k === t.k ? 1 : 2;
        const prov = vparseTok(sl.vid).p;
        if ((prov === "yt" && (!window.YT || !YT.Player)) || (prov === "dm" && (!window.DM || !DM.player)) || (prov === "vm" && (!window.Vimeo || !Vimeo.Player))) { sl.deck = ""; continue; }
        sl.p = mkVidPlayer(mount.firstChild, sl.vid, muted, t.k, false, scr !== scrBooth ? { cap: vCapFor(scr) } : null);
        continue;
      }
      const sl = scr.slots[i];
      if (sl.vid !== S[t.k].yt) { sl.vid = S[t.k].yt; sl._hadFrame = false; sl._noFrameAt = 0; sl._healN = 0; sl._bMask = false; sl._bufSince = 0; sl._bStateAt = 0; sl._bLastCur = null; sl._maskSnapAt = 0; sl._bufHealN = 0; sl._cleanPlayAt = 0; sl._sawPlay = false; sl._maskCov = false; sl._bCleanAcc = 0; sl._bDirtySince = 0; sl._bPrevAt = 0; sl._bPrevClean = false; if (sl.p) { try { sl.p.loadVideoById(sl.vid, Math.max(0, slotWant(scr, t.k))); } catch (_) {} } }
      const el = $(scr.ids[i]); if (el) { el.style.opacity = (disp[t.k] != null ? disp[t.k] : t.op).toFixed(2); el.style.zIndex = srt.length === 2 && srt[0].k === t.k ? 1 : 2; }
      if (sl.p) { try {
        const want = slotWant(scr, t.k), cur = sl.p.getCurrentTime ? sl.p.getCurrentTime() : 0;
        const stt = sl.p.getPlayerState ? sl.p.getPlayerState() : -1;
        if (stt === 1 || stt === 2 || stt === 5) sl._hadFrame = true;
        if (stt === 1) sl._sawPlay = true; /* VIEWER-LEG FIX (5): durable evidence this slot really played - the mini OK gate reads it */
        if (stt === 1 && scr === scrMini && srt.length && t.k === srt[srt.length - 1].k) miniMarkOk(sl.vid); /* RADIO MINI FIX (2): the mini featured slot earns its proof HERE, at sample time - a heal rebuild further down can reset the slot flag, never this */
        if (sl._hadFrame) picLive = true;
        if (scr !== scrBooth) bufStep(sl, stt, cur, want, !!S[t.k].playing, Date.now());
        /* VIEWER-LEG FIX (3) clean-play tracking begin: the heal
         * counters may only reset after this slot has been unmasked
         * and continuously playing for 10s - never on a bare pass
         * that merely saw a frame. */
        if (scr !== scrBooth) { if (stt === 1 && !sl._bMask) { const nowC = Date.now(); if (!sl._cleanPlayAt) sl._cleanPlayAt = nowC; else if (nowC - sl._cleanPlayAt >= 10000) { sl._healN = 0; sl._bufHealN = 0; } } else sl._cleanPlayAt = 0; }
        /* VIEWER-LEG FIX (3) clean-play tracking end */
        /* SYNC LOCK (see the block above mkVidPlayer): the slot is held
         * to the broadcast clock on the stage cadence. Inside the
         * deadband nothing moves; small drift nudges the rate; past
         * the snap threshold it seeks - at most one snap per slot per
         * 3s, never while the player is not in the playing state
         * (buffering included, mwFlapFix), never in the last 5s of
         * the track where the handover owns the ending. A player that
         * cannot rate-nudge near 1x (YouTube quantizes its rates to
         * 0.25 steps) takes a brief hold when it runs AHEAD of the
         * sound and a small forward seek when it falls BEHIND, so
         * the picture never sits seconds off the words. Dailymotion
         * and Vimeo clocks are coarse (timeupdate-fed), so their
         * thresholds scale by 3 - still three times tighter than the
         * old flat 6s allowance. */
        if (S[t.k].playing && stt === 1) {
          const durL = +S[t.k].dur || 0, provL = vparseTok(sl.vid).p, mulL = (provL === "dm" || provL === "vm") ? 3 : 1;
          if (!(durL > 0 && durL - want <= 5)) {
            const dec = syncLockCalc(cur - want, mulL);
            if (dec.act === "snap") { if (scr !== scrBooth && sl._bMask) { if (sl._maskSnap) { sl.p.seekTo(want, true); sl.seekAt = Date.now(); if (sl.rateCur && sl.rateCur !== 1 && sl.p.setPlaybackRate) { sl.p.setPlaybackRate(1); sl.rateCur = 1; } } } else if (Date.now() - (sl.seekAt || 0) >= 3000) { sl.p.seekTo(want, true); sl.seekAt = Date.now(); if (sl.rateCur && sl.rateCur !== 1 && sl.p.setPlaybackRate) { sl.p.setPlaybackRate(1); sl.rateCur = 1; } } }
            else if (dec.act === "nudge") {
              if (sl.p.rateOk && sl.p.rateOk()) { if (sl.rateCur !== dec.rate && sl.p.setPlaybackRate) { sl.p.setPlaybackRate(dec.rate); sl.rateCur = dec.rate; } }
              else if (cur > want) { if (Date.now() - (sl.holdAt || 0) >= 4000) { sl.holdAt = Date.now(); const pHold = sl.p, kHold = t.k, msHold = Math.max(60, Math.min(340, Math.round((cur - want) * 1000))); sl.holdUntil = Date.now() + msHold; pHold.pauseVideo(); setTimeout(() => { try { if (S[kHold].playing) pHold.playVideo(); } catch (_) {} }, msHold); } }
              else if (Date.now() - (sl.seekAt || 0) >= 3000) { sl.p.seekTo(want, true); sl.seekAt = Date.now(); }
            }
            else if (sl.rateCur && sl.rateCur !== 1 && sl.p.setPlaybackRate) { sl.p.setPlaybackRate(1); sl.rateCur = 1; }
          }
        }
        if (stt !== 1 && S[t.k].playing && !(sl.holdUntil && Date.now() < sl.holdUntil)) sl.p.playVideo();
        if (stt === 1 && !S[t.k].playing) { sl.p.pauseVideo(); if (sl.rateCur && sl.rateCur !== 1 && sl.p.setPlaybackRate) { sl.p.setPlaybackRate(1); sl.rateCur = 1; } }
        if (!muted) { if (sl.p.unMute) sl.p.unMute(); sl.p.setVolume(Math.round(Math.max(0, Math.min(1, stageGain(t.k) * (duck || 1) * (mix || 1) * boostMk())) * 100)); }
        else if (sl.p.mute) sl.p.mute();
      } catch (_) {} }
    }
    /* mwScreenHeal begin - VIEWER SCREEN SELF-HEAL (2026-10-29): the booth
     * has its stall watchdog; the viewer screens (station stage, MW TV,
     * Watch, the mini screen - every renderScreen surface except the
     * booths own, which the booth watchdog already covers) had none, so a
     * wedged embed or a failed seek into a long video left the honest
     * slate up forever while the broadcast played on. When a target slot
     * has produced no frame (_hadFrame) for 12s, its player is rebuilt
     * ONCE for that video and lands back on the broadcast clock through
     * mkVidPlayer (slotWant / bcastPos); a second failure waits 24s and
     * rebuilds once more, then the surface rests on the slate. The sync
     * lock, the one-sounding-screen entitlement (the rebuild reuses this
     * pass muted value) and the slate logic are untouched. */
    if (scr !== scrBooth) {
      const nowH = Date.now();
      scr._healK = "";
      tg.forEach((t) => {
        const si = scr.slots.findIndex((x) => x.deck === t.k); if (si < 0) return;
        const sl = scr.slots[si];
        /* NO-SKIP (WS4) + VIEWER-LEG FIX (3/4): a slot stuck in
         * continuous buffering for over 6s is a failure on this
         * ladder - one rebuild (the slot stays masked, and since
         * the mask now covers the slot the slate/poster is what
         * shows), a second failure takes the ladder's own 24s
         * backoff, then the surface rests on the slate with the
         * mask held. The buffering ladder runs on its OWN counter
         * (_bufHealN): the no-frame reset below may no longer zero
         * the shared counter on every framed pass, which disarmed
         * this branch forever while a black player claimed to be
         * playing; neither counter resets until the slot has been
         * unmasked and continuously playing for 10s (tracked in
         * the target loop). And the chip stays honest: _healK is
         * set only while a rebuild on this ladder is pending or
         * firing - never once the ladder is exhausted and at rest.
         * This branch still runs before the _hadFrame line below
         * on purpose: a slot that framed once and now buffers is
         * exactly the case the old ladder never saw. */
        if (sl._bufSince && S[t.k].playing && nowH - sl._bufSince > 6000) {
          if ((sl._bufHealN || 0) >= 2) return;
          scr._healK = t.k;
          if ((sl._bufHealN || 0) === 1 && sl._lastHealAt && nowH - sl._lastHealAt < 24000) return;
          const mountB = $(scr.ids[si]); if (!mountB) return;
          if (sl.p) { try { sl.p.destroy(); } catch (_) {} }
          sl.p = null; mountB.innerHTML = "<div></div>";
          sl._bufHealN = (sl._bufHealN || 0) + 1; sl._lastHealAt = nowH; sl._noFrameAt = nowH; sl._hadFrame = false; sl._sawPlay = false; sl._cleanPlayAt = 0;
          sl._bufSince = nowH; sl._bMask = true; sl._bStateAt = 0; sl._bLastCur = null; sl._bAdvAt = 0; sl._bCleanAcc = 0; sl._bDirtySince = 0; sl._bPrevAt = 0; sl._bPrevClean = false; sl._maskSnapAt = 0;
          sl.p = mkVidPlayer(mountB.firstChild, sl.vid, muted, t.k, false, { cap: vCapFor(scr) });
          return;
        }
        if (sl._hadFrame) { sl._noFrameAt = 0; return; }
        if (!sl.p) return;
        if (!sl._noFrameAt) { sl._noFrameAt = nowH; scr._healK = t.k; return; }
        /* VIEWER-LEG FIX (4): once this ladder is exhausted the chip
         * must stop claiming a retry that will never come - the slot
         * rests masked (poster showing) until the deck or video
         * changes and the slot bookkeeping resets. */
        if ((sl._healN || 0) < 2) scr._healK = t.k;
        const wait = sl._healN === 0 ? 12000 : sl._healN === 1 ? 24000 : Infinity;
        if (nowH - sl._noFrameAt < wait) return;
        const mount = $(scr.ids[si]); if (!mount) return;
        try { sl.p.destroy(); } catch (_) {}
        sl.p = null; mount.innerHTML = "<div></div>";
        sl._healN = (sl._healN || 0) + 1; sl._noFrameAt = nowH; sl._lastHealAt = nowH; sl._sawPlay = false; sl._cleanPlayAt = 0;
        sl.p = mkVidPlayer(mount.firstChild, sl.vid, muted, t.k, false, { cap: vCapFor(scr) });
      });
    }
    /* mwScreenHeal end */
    const top = tg.slice().sort((a, b) => b.op - a.op)[0];
    /* NO-SKIP (WS3): the screen-level mask. The featured slot is
     * stalling and no other target is cleanly showing, so the
     * viewer watches the slate/poster (the chip says "buffering")
     * instead of the skip itself. A healthy outgoing picture in a
     * blend is never hidden: any other target with a frame up and
     * no mask of its own keeps the whole screen live. */
    let bufScr = false;
    if (scr !== scrBooth && top) { const fsl = scr.slots.find((x) => x.deck === top.k); const otherClean = tg.some((t) => { if (t.k === top.k) return false; const os = scr.slots.find((x) => x.deck === t.k); return !!(os && os._hadFrame && !os._bMask); }); bufScr = !!(fsl && fsl._bMask && S[top.k].playing && !otherClean); }
    scr._bufK = bufScr && top ? top.k : "";
    /* VIEWER-LEG FIX (1) begin: the mask must COVER the player.
     * #404 only toggled the slate and the chip text, but a featured
     * slot carries an inline opacity (from disp) and an inline
     * z-index above the slate - so a black-but-mounted iframe (cold
     * start, deep seek into a long video, wedged embed) painted
     * over the poster forever. A slot that is masked, playing and
     * has no other target cleanly showing is now opacity-covered
     * itself, so the slate/poster underneath is the visible
     * surface; it is restored from disp the moment it unmasks. A
     * healthy outgoing picture in a blend is a cleanly-showing
     * target, so it is never the covered one. */
    if (scr !== scrBooth) {
      scr.slots.forEach((csl, csxi) => {
        if (!csl.deck) { csl._maskCov = false; return; }
        const ctt = tg.find((x) => x.k === csl.deck); if (!ctt) { csl._maskCov = false; return; }
        const cel = $(scr.ids[csxi]); if (!cel) return;
        const otherClean = tg.some((x) => { if (x.k === csl.deck) return false; const os = scr.slots.find((y) => y.deck === x.k); return !!(os && os._hadFrame && !os._bMask); });
        const covered = !!(csl._bMask && S[csl.deck].playing && !otherClean);
        if (covered) { cel.style.opacity = "0"; csl._maskCov = true; }
        else if (csl._maskCov) { cel.style.opacity = (disp[csl.deck] != null ? disp[csl.deck] : ctt.op).toFixed(2); csl._maskCov = false; }
      });
    }
    /* VIEWER-LEG FIX (1) end */
    // VIDEO TRANSITIONS (owner, 2026-10-28): a discrete switch of the
    // dominant deck - a stamped S.vmix.at action (Cut / Fade / solo / Auto
    // buttons) or a hard swap where the old deck leaves the mix entirely
    // (an Auto-DJ handover) - animates the incoming slot with the chosen
    // S.vmix.tr. A continuous fader ride never triggers this: both decks
    // stay in the targets while the dissolve does the work. During a manual
    // Fade (vmix.b set) the dissolve IS the transition, so the stamp is
    // consumed silently. The animation touches the slot wrapper only; the
    // player is never reloaded, and on landing the player is aligned to
    // the deck's live position so picture and sound stay locked (vtrSlot).
    const vmNow = S.vmix || {}, vTop = top ? top.k : "";
    if (scr._vAt == null) { scr._vAt = vmNow.at || 0; scr._vTop = vTop; }
    else if (vmNow.b) { scr._vAt = vmNow.at || 0; scr._vTop = vTop; }
    else if (vTop && vTop !== scr._vTop) {
      const stamped = (vmNow.at || 0) !== scr._vAt, hardSwap = !!scr._vTop && !tg.some((x) => x.k === scr._vTop);
      if (stamped || hardSwap) { const tr2 = vmNow.tr || "fade"; if (tr2 !== "cut") vtrSlot(scr, vTop, tr2, vmNow.trMs || 650); }
      scr._vAt = vmNow.at || 0; scr._vTop = vTop;
    } else if (vTop) { scr._vAt = vmNow.at || 0; scr._vTop = vTop; }
    if (chip && top) { chip.hidden = false; chip.textContent = "\u25B6 DECK " + top.k + (S[top.k].title ? " \u2014 " + S[top.k].title : "") + (scr._healK === top.k ? " · retrying…" : "") + (scr._bufK === top.k ? " · buffering…" : ""); }
    // BUFFER PASS (honest loading): with targets up, the standby slate
    // and poster stay on screen until a target slot's player has really
    // loaded its video (a playing, paused or cued frame - _hadFrame).
    // Targets existing only means the mix WANTS a deck; hiding the
    // slate on that alone left a silently black screen while a cold
    // player spun up, which is the loading the owner called out.
    if (tg.length) { if (stb) stb.style.display = (picLive && !bufScr) ? "none" : "grid"; if (pst) pst.style.display = (picLive && !bufScr) ? "none" : "block"; }
    /* BUFFER PASS - warm the next picture: the handover always lands
     * on the featured deck's pair, so while a deck is featured and
     * playing, the FREE slot cues that pair deck's video early - a
     * player from the same mkVidPlayer, built warm (muted, paused on
     * ready), invisible at opacity 0, and never given volume here:
     * only target slots ever receive unMute/setVolume in this
     * renderer, and a warm slot has no deck. A Cut, a solo, a fader
     * blend or the natural roll then promotes it in place (the target
     * loop above) instead of building cold. A warm player whose deck
     * has since loaded a different video is torn down, and the freed
     * slot re-warms to the current pair on the same pass.
     * NO-SKIP (WS2) widened the guest list - the pair first, then
     * any deck the shared vmix record names, warmed as soon as it
     * is loaded - and set viewer warm players ROLLING muted so a
     * real buffer accumulates ahead of the flip; the block below
     * carries the current rules. */
    try {
      scr.slots.forEach((sl) => { if (!sl.deck && sl.warmK && (!S[sl.warmK] || S[sl.warmK].yt !== sl.vid)) { if (sl.p) { try { sl.p.destroy(); } catch (_) {} sl.p = null; } sl.warmK = ""; sl.vid = ""; sl._hadFrame = false; } });
      /* NO-SKIP (WS2): viewer warm slots ROLL muted, so a real
       * buffer accumulates ahead of the broadcast position, and
       * they are held near that position while they wait - a warm
       * player left paused, or minutes adrift, is a cold player at
       * the flip either way. Warm players are muted here and never
       * given volume anywhere: only target slots ever receive
       * unMute/setVolume in this renderer, so the one-sounding-
       * screen entitlement (vmixSndScr) is untouched. */
      if (scr !== scrBooth) scr.slots.forEach((sl) => { if (!sl.deck && sl.warmK && sl.p) { try { sl.p.mute(); const wk = sl.warmK, stw = sl.p.getPlayerState ? sl.p.getPlayerState() : -1, cw = sl.p.getCurrentTime ? sl.p.getCurrentTime() : 0, ww = slotWant(scr, wk); if (S[wk] && S[wk].playing) { if (stw !== 1) sl.p.playVideo(); if (cw > 0 && Math.abs(cw - ww) > 3) sl.p.seekTo(ww, true); } else if (stw === 1 && cw - ww > 3) sl.p.pauseVideo(); } catch (_) {} } });
      /* who may feature next, in order: the featured deck's pair
       * first (every handover lands there), then any deck the
       * shared vmix record names. Viewer screens warm from that
       * list whenever a next deck is loaded - even before it is
       * playing; the booth keeps its shipped rule (warm the pair
       * of a playing featured deck). A slot already holding a
       * listed deck warm is kept warm in place. */
      const isView = scr !== scrBooth;
      let candList = [];
      if (isView) { if (top) candList.push(PAIR[top.k]); const vm2 = S.vmix || {}; if (vm2.a) candList.push(vm2.a); if (vm2.b) candList.push(vm2.b); candList = candList.filter((c, ix) => c && candList.indexOf(c) === ix && c !== (top ? top.k : "") && S[c] && S[c].yt && !tg.some((x) => x.k === c)); }
      if (isView ? candList.length : (top && S[top.k].playing)) {
        const cand = isView ? (((scr.slots.find((sl) => !sl.deck && sl.warmK && candList.indexOf(sl.warmK) >= 0) || {}).warmK) || candList[0]) : PAIR[top.k];
        if (cand && cand !== (top ? top.k : "") && S[cand] && S[cand].yt && !tg.some((x) => x.k === cand)) {
          const fi = scr.slots.findIndex((sl) => !sl.deck);
          if (fi >= 0) { const sl = scr.slots[fi]; if (!(sl.warmK === cand && sl.p && sl.vid === S[cand].yt)) { const mount = $(scr.ids[fi]); if (mount) { const provW = vparseTok(S[cand].yt).p; if (provW === "yt") await ytApi(); else if (provW === "dm") await dmApi(); else if (provW === "vm") await vmApi(); if ((provW === "yt" && window.YT && YT.Player) || (provW === "dm" && window.DM && DM.player) || (provW === "vm" && window.Vimeo && Vimeo.Player)) { if (sl.p) { try { sl.p.destroy(); } catch (_) {} sl.p = null; } mount.innerHTML = "<div></div>"; mount.style.opacity = 0; sl.vid = S[cand].yt; sl.warmK = cand; sl._hadFrame = false; sl._bMask = false; sl._bufSince = 0; sl._bLastCur = null; sl.p = mkVidPlayer(mount.firstChild, sl.vid, true, cand, true, isView ? { cap: vCapFor(scr), roll: true } : null); } } } }
        }
      }
    } catch (_) {}
  }
  /* the member master screen never vanishes while Meechie is live (owner,
   * 2026-10-27): with no video playing yet it shows the table lineup — what is
   * loaded on each deck — so members always see his setup. View only: this
   * screen takes no input and cannot touch the radio. */
  function stSlate() {
    const rows = DECKS.filter((k) => S[k] && (S[k].title || S[k].yt)).map((k) => "DECK " + k + " — " + (S[k].title || "Music video") + (S[k].playing ? " ▶ PLAYING" : ""));
    return "🔴 MEECHIE IS LIVE ON THE TABLES\n" + (rows.length ? rows.join("\n") : "Setting up the decks…") + "\nThe video mix appears right here the moment a music video plays.";
  }
  let stageBusy = false;
  async function stageApply(mix, duck) {
    if (stageBusy) return; stageBusy = true;
    try {
      if (OWNER()) { vmixPublish(); await renderScreen(scrBooth, true, 1, 1); camSync(); const box = $("#st-ytbox"); if (box) box.hidden = true; }
      else {
        const has = vmixTargets().length > 0 || !!((S.vstream || {}).on && (S.vstream || {}).meeting), box = $("#st-ytbox"); if (box) box.hidden = !(has || S.live);
        if (has) { const sndV = vmixSndScr(); await renderScreen(scrView, sndV !== scrView, sndV === scrView ? mix : 1, duck); }
        else if (S.live) { const sb = $("#st-vstandby"); if (sb) sb.textContent = stSlate(); await renderScreen(scrView, true, 1, 1); }
        else scrView.slots.forEach((sl) => { sl.deck = ""; if (sl.p) { try { sl.p.pauseVideo(); } catch (_) {} } });
      }
      await miniApply(mix, duck);
      try { await tvApply(mix, duck); } catch (_) {}
      try { await watchApply(mix, duck); } catch (_) {}
      try { vsSync(); } catch (_) {}
    } catch (_) {}
    stageBusy = false;
  }
  /* MW TV (owner, 2026-10-29: "make a tv station channel where that screen
   * on fullscreen mode is the only thing on it call it mw tv"): the channel
   * page (#v-mwtv) is one more screen in the same system — the live stream
   * overlays it through vsStageEls, and this paints the SAME video mix the
   * station stage shows (same renderer, same transitions) underneath, over
   * the channel's own standby slate. It only renders while the channel is
   * open; leaving the channel parks its players so nothing plays unseen. */
  let tvSig = "";
  function tvPaint() {
    const vs = S.vstream || {};
    let mode = "", label = "";
    if (vs.on && vs.meeting && !vs.hidden) { mode = "live"; label = vs.kind === "cam" ? "Meechie — live camera" : "Meechie — live screen"; }
    else { const tg = vmixTargets(); if (tg.length) { mode = "mix"; label = "The video mix" + (S[tg[0].k] && S[tg[0].k].title ? " — " + S[tg[0].k].title : ""); } }
    const sig = mode + "|" + label + "|" + (listening ? 1 : 0);
    if (sig === tvSig) return; tvSig = sig;
    const bd = $("#tw-live"), wt = $("#tw-what"), sb = $("#tw-sound");
    if (bd) { bd.hidden = !mode; bd.classList.toggle("mix", mode === "mix"); bd.textContent = mode === "live" ? "🔴 LIVE" : "ON AIR"; }
    if (wt) wt.textContent = label;
    if (sb) sb.textContent = listening ? "🔊 Radio on — tap to mute" : "🔇 Radio off — tap for sound";
  }
  /* MW TV slate wording (owner, 2026-10-29: "Mw tv isnt fixed"): the
   * static first paint used to declare the station off air before any
   * state had arrived - a false off-air slate on a live station, which
   * on a slow or stale tab could stick and read as broken. Until the
   * first snapshot lands the slate is the neutral connecting line; the
   * off-air words are earned only by a snapshot that says the station
   * is not live with nothing featured. A warm tab (a snapshot already
   * in) paints the earned words on its first tvApply, as before. */
  let twSlateSig = "";
  function tvSlatePaint() {
    const p = document.querySelector("#tw-vstandby .tw-sb p"); if (!p) return;
    const txt = !stateSeen ? "TV: connecting…" : (!S.live && !(S.vstream || {}).on && !vmixTargets().length) ? "Meechie is off air — the radio is always on." : "🔴 Meechie is live on the tables — the video mix appears here the moment a music video plays.";
    if (txt !== twSlateSig) { twSlateSig = txt; p.textContent = txt; }
  }
  async function tvApply(mix, duck) {
    tvSlatePaint();
    const vw = document.getElementById("v-mwtv");
    if (!vw || vw.hidden) {
      if (scrTV.slots.some((sl) => sl.deck)) scrTV.slots.forEach((sl) => { sl.deck = ""; if (sl.p) { try { sl.p.pauseVideo(); } catch (_) {} } });
      return;
    }
    const sndT = vmixSndScr(); await renderScreen(scrTV, sndT !== scrTV, sndT === scrTV ? mix : 1, duck);
    // leaving any view pauses its <video> elements (go() in app-core) — if
    // that caught the live stream on the way out, set it playing again here
    const lv = document.querySelector("#tw-stage video.vslive");
    if (lv && lv.paused && (lv.srcObject || lv.currentSrc)) { try { const p = lv.play(); if (p && p.catch) p.catch(() => {}); } catch (_) {} }
    tvPaint();
  }
  /* WATCH THE SETUP screen (watch-setup2): the spectator booth master
   * screen is one more screen in the same system — the live stream
   * overlays it through vsStageEls and this paints the SAME video mix
   * the station stage shows underneath. It renders only while the
   * watch view is open; leaving the view parks its players so nothing
   * plays unseen, exactly like the TV screen. */
  async function watchApply(mix, duck) {
    const vw = document.getElementById("v-watch");
    if (!vw || vw.hidden) {
      if (scrWatch.slots.some((sl) => sl.deck)) scrWatch.slots.forEach((sl) => { sl.deck = ""; if (sl.p) { try { sl.p.pauseVideo(); } catch (_) {} } });
      return;
    }
    if (!stateSeen) { const sb = document.getElementById("wb-vstandby"); if (sb) sb.textContent = "TV: connecting…"; }
    else if (!vmixTargets().length && S.live) { const sb = document.getElementById("wb-vstandby"); if (sb) sb.textContent = stSlate(); }
    else if (!vmixTargets().length && !S.live && !(S.vstream || {}).on) { const sb = document.getElementById("wb-vstandby"); if (sb) sb.textContent = "Meechie is off air — the radio is always on."; }
    const sndW = vmixSndScr(); await renderScreen(scrWatch, sndW !== scrWatch, sndW === scrWatch ? mix : 1, duck);
    const lv = document.querySelector("#wb-stage video.vslive");
    if (lv && lv.paused && (lv.srcObject || lv.currentSrc)) { try { const p = lv.play(); if (p && p.catch) p.catch(() => {}); } catch (_) {} }
  }
  /* the mini screen is a silent mirror (the sound already travels with the decks
   * and the station screen): it shows the same mix in a small rectangle at the
   * top of every page, and steps aside when a big screen is in view, when the
   * booth itself is on screen, or when the viewer closed it for this video */
  let miniOffVid = "", stInView = false, miniOkVid = "", miniErrVid = "", miniLastVid = "", miniBufVid = "", miniBufAt = 0, miniGateVid = "", miniGateAt = 0, miniGraceVid = "", miniGraceAt = 0;
  /* RADIO MINI FIX (2): durable play evidence for the mini. renderScreen
   * calls this the moment the mini screen featured slot is sampled in
   * the playing state, so the proof lives in miniOkVid itself - not
   * only in the slot _sawPlay flag, which a heal rebuild resets before
   * miniApply pass-end read ever gets to spend it. Once a video has
   * really played on the mini, no rebuild of that same video player
   * can un-earn it. */
  function miniMarkOk(v) { if (v) { miniOkVid = v; if (miniErrVid === v) miniErrVid = ""; } }
  async function miniApply(mix, duck) {
    const box = $("#dj-mini"); if (!box || SANDBOX) return;
    const tg = vmixTargets(), top = tg.slice().sort((a, b) => b.op - a.op)[0], vid = top ? (S[top.k] && S[top.k].yt) || "" : "";
    if (vid !== miniLastVid) { const prevErr = !!miniLastVid && miniErrVid === miniLastVid; miniErrVid = ""; if (vid && !prevErr) { miniGraceVid = vid; miniGraceAt = Date.now(); } else { miniGraceVid = ""; miniGraceAt = 0; } miniGateVid = ""; miniGateAt = 0; miniLastVid = vid; } // VIEWER-LEG FIX (5): an error latched against a previous video must not hide the new one. RADIO MINI FIX (4): a clean change also opens a proof grace for the new video (only when the outgoing video was not error-latched), and the bounded-gate clock restarts
    let sessOff = false; try { sessOff = !!sessionStorage.getItem("mw_mini_off"); } catch (_) {}
    const vsM = S.vstream || {};
    const onTV = !!(document.body && document.body.dataset && document.body.dataset.view === "mwtv"); // the MW TV page IS the screen: the mini and its pop-out never double up there
    /* the LIVE-SHARE POP-OUT (owner, 2026-10-29: "I want this screen to
     * pop up after they enter and get greeted — if it's being shared"):
     * a viewer anywhere on the site gets the mini carrying the share
     * automatically — no tune-in, no trip to the radio view — once the
     * greeting sequence has passed (vsPopReady) and the feed is actually
     * flowing. It bypasses only the per-video close memory (vid vs
     * miniOffVid — with no deck video up, vid is "" and that check alone
     * would keep the mini down forever); the session close, the stage-in-
     * view step-aside and the booth-on-screen rule all still apply, and a
     * hidden share never pops. */
    const vsShareShow = !!(vsM.on && vsM.meeting) && !vsM.hidden && !sessOff && !stInView && !onTV && !document.body.classList.contains("dj-on") && !!((vsShown.track && vsShown.track.readyState === "live") || vsShown.hls) && vsPopReady();
    const show = ((!!tg.length || !!(vsM.on && vsM.meeting)) && !sessOff && vid !== miniOffVid && !stInView && !onTV && !document.body.classList.contains("dj-on")) || vsShareShow;
    box.hidden = !show;
    // a master video that errored or has not really started must not leave
    // a black box floating over the page: until this video's player has
    // actually played, the box stays hidden (the render below still runs,
    // so it pops in the moment the video does) — unless his camera square
    // is live on the mini, which is reason enough to keep the box up
    /* RADIO MINI FIX (3/4): the proof gate, bounded and graced. The
     * gate still keeps an unproven player from floating a black box
     * over the page, but it may no longer hide the box forever: an
     * error latched against this video still hides it outright, the
     * camera square still keeps it up (both exactly as before), a
     * fresh clean change sits inside its proof grace and cannot be
     * gate-hidden at all, and every other gate-hidden stretch is
     * clocked per video - past ~20s with no error latch the box is
     * forced visible, thumbnail and all. A permanently hidden mini
     * with no error latch and no explicit gate (session close,
     * stage in view, booth on screen, MW TV page) is now impossible. */
    if (show && vid && miniOkVid !== vid) {
      const ov = document.getElementById("mw-camov"), nowG = Date.now();
      if (miniErrVid === vid) { box.hidden = true; miniGateVid = ""; miniGateAt = 0; }
      else if (ov && !ov.hidden) { miniGateVid = ""; miniGateAt = 0; }
      else if (miniGraceVid === vid && nowG - miniGraceAt < 18000) { miniGateVid = ""; miniGateAt = 0; }
      else { if (miniGateVid !== vid) { miniGateVid = vid; miniGateAt = nowG; } if (nowG - miniGateAt <= 20000) box.hidden = true; }
    } else { miniGateVid = ""; miniGateAt = 0; }
    camOvSync();
    if (!tg.length) scrMini.slots.forEach((sl) => { sl.deck = ""; if (sl.p) { try { sl.p.pauseVideo(); } catch (_) {} } });
    /* RADIO MINI FIX (1): the render is decoupled from the box
     * visibility. The old early return here meant that whenever the
     * box was stepped aside - above all while the station stage was
     * in view - the mini players got no play or seek commands at
     * all, so the proof the gate above demands could never be
     * earned and the box stayed vanished long after the stage had
     * scrolled away. renderScreen now runs whenever there is a mix
     * to mirror or a share is live, whatever the box is doing; the
     * step-asides and gates only ever set box.hidden. Rendering is
     * skipped only when there is nothing to render (no targets and
     * no live share - the sandbox already returned at the top), and
     * the box-lifting layout passes below still run only for a box
     * that is actually showing. */
    if (!tg.length && !(vsM.on && vsM.meeting)) return;
    if (show) {
    // keep the mini clear of the bottom player bar: if a saved spot leaves it
    // under the bar, lift it above the bar while the bar is up (the saved spot
    // itself is untouched — the lift is re-applied on the next pass)
    try { const pb = document.querySelector(".player-bar"); if (pb && document.body.classList.contains("has-player")) { const pr = pb.getBoundingClientRect(), mr = box.getBoundingClientRect(); if (pr.height > 0 && mr.bottom > pr.top - 4 && mr.left < pr.right && mr.right > pr.left) { box.style.top = Math.max(2, Math.round(pr.top - mr.height - 8)) + "px"; box.style.left = Math.round(mr.left) + "px"; box.style.right = "auto"; } } } catch (_) {}
    try {
      const docked = box.dataset.mnDock === "1";
      if (!box.style.left && innerWidth >= 1100 && document.body.dataset.view === "community") { const side = document.querySelector("#v-community .side"); if (side) { const sr = side.getBoundingClientRect(), mr2 = box.getBoundingClientRect(); if (sr.width > 0 && mr2.right > sr.left - 8 && mr2.top < sr.bottom && mr2.bottom > sr.top) { box.style.left = Math.max(2, Math.round(sr.left - mr2.width - 12)) + "px"; box.style.right = "auto"; box.dataset.mnDock = "1"; } } }
      else if (docked && document.body.dataset.view !== "community") { box.style.left = ""; box.style.right = ""; delete box.dataset.mnDock; }
    } catch (_) {}
    }
    await renderScreen(scrMini, true, 1, 1);
    /* VIEWER-LEG FIX (5/6) begin */
    const actM = scrMini.slots.filter((sl) => sl.deck && sl.p), topPM = top ? actM.find((sl) => sl.deck === top.k) : null;
    if (scrMini._bufK) {
      /* (6) bounded step-aside: the box hides for at most ~15s of
       * one continuous mask episode on this video, then returns -
       * with the featured slot opacity-covered by the renderScreen
       * mask pass the poster shows through - instead of vanishing
       * for a whole song the way the unbounded #404 rule let it. */
      if (miniBufVid !== vid || !miniBufAt) { miniBufVid = vid; miniBufAt = Date.now(); }
      if (Date.now() - miniBufAt <= 15000) box.hidden = true;
      else if (show && (miniOkVid === vid || (topPM && topPM._sawPlay))) box.hidden = false; /* RADIO MINI FIX (1): the restore may only raise a box the show gates allowed up - never over a session close, the stage in view, the booth on screen, or the MW TV page */
    } else { miniBufVid = ""; miniBufAt = 0; }
    /* (5) the OK evidence no longer has to be a state-1 sample at
     * exactly this pass end: a featured slot that has really played
     * this video (_sawPlay, stamped in renderScreen) counts too. */
    if (vid) { if (topPM && topPM.p._err) miniErrVid = vid; if ((topPM && topPM._sawPlay) || actM.some((sl) => { try { return (sl.p.getPlayerState ? sl.p.getPlayerState() : sl.p._st) === 1; } catch (_) { return false; } })) { miniOkVid = vid; miniErrVid = ""; } }
    /* VIEWER-LEG FIX (5/6) end */
  }
  /* ------- effects ride the broadcast: whatever the booth sets is what listeners hear ------- */
  function fltFreq(node, v) { // v: 0..100, 50 = fully open; left sweeps lowpass down, right sweeps highpass up
    if (!node) return;
    if (v <= 50) { node.type = "lowpass"; node.frequency.value = v >= 49 ? 18000 : 200 * Math.pow(90, v / 50); }
    else { node.type = "highpass"; node.frequency.value = v <= 51 ? 10 : 20 * Math.pow(600, (v - 50) / 50); }
  }
  function setCrushCurve(v) {
    if (!crushNode || v === crushBuilt) return; crushBuilt = v;
    const n = 1024, curve = new Float32Array(n);
    if (v <= 0) { for (let i = 0; i < n; i++) curve[i] = (i / (n - 1)) * 2 - 1; }
    else { const steps = Math.pow(2, Math.max(1.5, 8 - (v / 100) * 6.5)); for (let i = 0; i < n; i++) { const x = (i / (n - 1)) * 2 - 1; curve[i] = Math.round(x * steps) / steps; } }
    crushNode.curve = curve;
  }
  let localMaster = 0.95; // this window's own master volume (the MASTER slider)
  function applyMaster() { if (masterGain) masterGain.gain.value = localMaster * (S.fx.boost || 1); const bv = $("#dj-boost-v"); if (bv) bv.textContent = Math.round((S.fx.boost || 1) * 100) + "%"; const bs = $("#dj-boost"); if (bs && document.activeElement !== bs) bs.value = S.fx.boost || 1; }
  function applyFx() { applyMaster();
    DECKS.forEach((k) => {
      const d = decks[k]; if (!d) return;
      const eq = S[k].eq || { lo: 0, mid: 0, hi: 0 };
      if (d.eq) { d.eq.lo.gain.value = eq.lo || 0; d.eq.mid.gain.value = eq.mid || 0; d.eq.hi.gain.value = eq.hi || 0; }
      if (d.flt) fltFreq(d.flt, S[k].flt == null ? 50 : S[k].flt);
    });
    const f = S.fx || defFx();
    if (fxFilter) fxFilter.frequency.value = 200 * Math.pow(90, (f.mf == null ? 100 : f.mf) / 100);
    if (echoWet) echoWet.gain.value = f.echo || 0;
    if (echoFb) echoFb.gain.value = f.fb == null ? 0.34 : f.fb;
    if (verbWet) verbWet.gain.value = Math.min(f.verb || 0, 0.3);
    if (flaWet) flaWet.gain.value = Math.min(f.fla || 0, 0.25) * 0.8;
    if (phaWet) phaWet.gain.value = Math.min(f.pha || 0, 0.3) * 0.9;
    if (noiseWet) { const nz = Math.min(f.noise || 0, 0.5); noiseWet.gain.value = nz * 0.5; if (noiseBp) noiseBp.frequency.value = 400 + nz * 5200; }
    setCrushCurve(Math.min(f.crush || 0, 12));
    
    if (gateOsc && gateDepth && gateGain) {
      const g = +f.gate || 0;
      if (g > 0) { gateOsc.frequency.value = g; gateDepth.gain.value = 0.5; gateGain.gain.value = 0.5; }
      else { gateDepth.gain.value = 0; gateGain.gain.value = 1; }
    }
    // stem cuts ride the broadcast too: what the booth cuts is what listeners lose
    DECKS.forEach((k) => { const d = decks[k]; if (d && d.stem) { d.stem.nrm.gain.value = S[k].vcut ? 0 : 1; d.stem.oop.gain.value = S[k].vcut ? 1 : 0; d.stem.hp.frequency.value = S[k].bcut ? 160 : 10; } });
    // beat-synced FX: echo, flanger and the chopper follow the tempo of what's playing
    if (f.sync !== false) { const rb = refBpm(); if (rb > 0) { const bl = 60 / rb; if (echoDly) echoDly.delayTime.value = bl * (f.ediv || 0.75); if (flaLfo) flaLfo.frequency.value = 1 / (bl * 2); if (phaLfo) phaLfo.frequency.value = 1 / (bl * 4); if (gateOsc && (+f.gate || 0) > 0) gateOsc.frequency.value = (+f.gate / 2) * (rb / 60); } }
  }
  /* follow() single-flight wrapper (2026-10-28): follow is called from
   * the booth tick, onState, syncDecks, the lease gain and visibility
   * returns, and overlapping runs for the same deck interleaved their
   * awaits — two mounts racing on one video deck, seeks landing on top
   * of each other. One run per deck at a time; a call that arrives
   * mid-run asks for exactly one more pass when the current one ends.
   * The synchronous prefix is preserved: followRun still issues its
   * play() before its first await, so the Listen-tap chain on iPhones
   * (play must ride the tap) is untouched. */
  async function follow(k) {
    const d = deck(k); if (!d) return;
    if (d._fIn) { d._fAgain = true; return; }
    d._fIn = true;
    try { await followRun(k); } finally { d._fIn = false; if (d._fAgain) { d._fAgain = false; follow(k); } }
  }
  async function followRun(k) {
    const s = S[k], d = deck(k);
    if (s.yt) {
      // a YouTube deck: listeners watch it on the station's ON AIR video stage;
      // the booth (and its mirrors) run a real player in the deck itself
      if (!OWNER()) { d.stop(); stageApply(listening ? mixVol : 1, (S.duck || micHot > 0.04) ? 0.28 : 1); return; }
      const okY = await d.setYt(s.yt); if (!okY) return;
    } else {
      if (d.shim) d.clearYt();
      if (!okUrl(s.src) || DEAD(s.src)) { d.stop(); return; }
      // cues and loops live in the shared state too, so a cue set or a loop armed in the
      // pop-out exists on the window playing the sound (and the other way round)
      if (OWNER()) { if (Array.isArray(s.cues)) { d.cues = s.cues.slice(0, 3); while (d.cues.length < 3) d.cues.push(null); } if (s.loop) { d.loop = s.loop; d.loopBeats = s.loopBeats || 0; } else if (s.loop === null) { d.loop = null; d.loopBeats = 0; } paintCues(k); }
      // iPhone fix (2026-10-28, "it wont play the radio"): start the element
      // BEFORE waiting for the file to load. d.set() puts the new src on the
      // element synchronously, so a play() issued right here still belongs to
      // the tap that called follow() — the Listen button, a tap-to-resume.
      // The old order (await the load, then play) broke that chain: iPhone
      // Safari refuses a play() that waits on the network first, the refusal
      // was swallowed, and the radio sat silent on iPhones while the button
      // claimed it was playing. The library player in index.html has always
      // played first and seeked after, for exactly this reason.
      const setP = d.set(s.src);
      if (s.playing) { try { const pp = d.el.play(); if (pp && pp.catch) pp.catch(() => {}); } catch (_) {} }
      await setP;
    }
    d.el.playbackRate = s.rate || 1;
    const want = posOf(k);
    // a deck whose shared timeline already ran past the end of its track is
    // OVER, whatever the doc still claims: park it locally instead of seeking
    // past the end on every sync tick (the seek loop sounds like skipping)
    if (s.playing && +s.dur > 0 && want > +s.dur + 2) { try { d.el.pause(); } catch (_) {} levels(); return; }
    if (s.playing) {
      // end zone (fix, 2026-10-28, "it starts skipping at the end of the song
      // instead of fading"): judge the end by the ELEMENT and its own clock,
      // never by the wall clock alone. A deck always trails the shared
      // timeline by its load delay, so the old rule (wall position within
      // 0.3s of the end -> pause) parked decks that still had seconds of
      // song left, and the seek under it kept jerking the final seconds onto
      // the wall position — the deck stuttered and skipped instead of
      // playing out into the crossfade. With <=5s left on the element:
      // hands off, no seek and no park. It plays out, and the handover
      // (early crossfade, the ended event, the state park above) owns the
      // transition.
      const elDurF = (d.el && isFinite(d.el.duration) && d.el.duration > 0) ? d.el.duration : 0;
      const elRemF = elDurF > 0 ? elDurF - (d.el.currentTime || 0) : 99;
      if (elDurF > 0 && elRemF <= 0.35) { d.el.pause(); levels(); return; }
      if (elRemF > 5 && !d.el.seeking && d.el.readyState >= 3 && Math.abs(d.el.currentTime - want) > 4) { try { d.el.currentTime = want; } catch (_) {} }
      if (d.el.paused) d.el.play().catch(() => {});
    }
    else { d.el.pause(); if (Math.abs(d.el.currentTime - want) > 0.5) { try { d.el.currentTime = want; } catch (_) {} } }
    applyFx(); levels();
    if (OWNER() && !(S[k].bpm > 0) && !s.yt) anaLater(k);
  }
  /* adoptDeck (2026-10-28): the smooth booth takeover. When this window
   * becomes the sound — lease gain, booth open, visibility return — a deck
   * the station says is playing must JOIN the song where it actually is,
   * not restart it: follow() loads and plays it, then this lands the
   * element on the shared wall-clock position, retrying briefly while
   * the player warms up (a video shim especially can take a moment to
   * accept a seek, and follow() gets exactly one seek attempt). It never
   * writes S.start — the shared timeline is the station's truth and the
   * element is what moves. If the DJ grabs the deck himself meanwhile
   * (pause, reload, a fresh state), adoption stops and his hands win. */
  async function adoptDeck(k) {
    await follow(k);
    const s0 = S[k], d = deck(k);
    if (!s0 || !s0.playing || !d || !d.el || s0.loop) return;
    if (d.noSync && Date.now() < d.noSync) return;
    if (+s0.dur > 0 && posOf(k) > +s0.dur - 4) return;
    for (let i = 0; i < 6; i++) {
      if (S[k] !== s0 || !S[k].playing) return;
      const want = posOf(k); if (!(want > 1)) return;
      let ct = 0; try { ct = d.el.currentTime || 0; } catch (_) {}
      if (Math.abs(ct - want) <= 1.5) return;
      try { d.el.currentTime = want; } catch (_) {}
      await new Promise((r) => setTimeout(r, 450));
    }
  }
  // tight sync across devices (owner ask, 2026-10-26): every playing deck is
  // held to the shared timeline — posOf() corrected by the server-clock offset.
  // Small drift glides back with a brief rate nudge (no audible jump); big
  // drift seeks clean. Loops, paused elements (a scratch in progress), and
  // brake/spin moves (noSync stamp) are left alone. Video decks can only be
  // re-seeked, and coarsely (their player lands on keyframes).
  function syncDecks() { if (document.hidden) return; const now = Date.now() + clockOff; const nowT = boothLead ? Date.now() : now; /* mwFlapFix: the booth lead authored start on its own clock, so its sync target is plain local time with no clockOff; listeners keep the corrected basis */ DECKS.forEach((k) => { const s = S[k], d = decks[k]; if (!s || !s.playing || !d || !d.el || s.loop) return; if (d.noSync && Date.now() < d.noSync) return; /* end zone (fix, 2026-10-28): with <=5s left on the element itself, no drift correction at all — it plays out into the crossfade */ const elDurZ = (d.el && isFinite(d.el.duration) && d.el.duration > 0) ? d.el.duration : 0; if (elDurZ > 0 && elDurZ - (d.el.currentTime || 0) <= 5) return; const target = Math.max(0, (nowT - (s.start || nowT)) / 1000); const durT = +s.dur || 0; if (durT > 0 && target > durT + 2) { try { d.el.pause(); } catch (_) {} return; } if (d.shim) { if (Math.abs((d.el.currentTime || 0) - target) > 5) { follow(k); d.noSync = Date.now() + 3000; /* mwFlapFix: rest 3s after a sync seek so shim clock jitter cannot retrigger it */ } return; } if (d.el.paused) return; const drift = d.el.currentTime - target, base = s.rate || 1; if (Math.abs(drift) > 0.35) { try { d.el.currentTime = Math.max(0, target); } catch (_) {} if (Math.abs(d.el.playbackRate - base) > 0.001) d.el.playbackRate = base; } else if (Math.abs(drift) > 0.08) { const want = base * (drift > 0 ? 0.96 : 1.04); if (Math.abs(d.el.playbackRate - want) > 0.001) d.el.playbackRate = want; } else if (Math.abs(d.el.playbackRate - base) > 0.001) d.el.playbackRate = base; }); }
  setInterval(syncDecks, 500);
  // the screens follow the shared state on their own clock: a booth window that
  // is not the one driving the sound, and a visitor who has not tuned in yet,
  // still see the picture (muted until they tune in) instead of a dead screen
  setInterval(() => { if (document.hidden) return; stageApply(listening ? mixVol : 1, (S.duck || micHot > 0.04) ? 0.28 : 1); }, 700);
  /* MIDI controllers (owner ask, 2026-10-26): any MIDI DJ table or controller
   * hooks up by USB. LEARN binds a physical control to a booth function —
   * knobs drive the booth's real sliders (the same input events a finger
   * makes), buttons click the real buttons, jogs scrub the song. Mappings
   * persist per device in localStorage. Play-button LEDs are fed back out so
   * the controller's lights follow the decks. */
  const MIDI_FUNCS = [];
  DECKS.forEach((k) => { MIDI_FUNCS.push(["play" + k, "btn", "▶ Play/Pause " + k], ["cue" + k, "btn", "⏺ Cue " + k], ["brake" + k, "btn", "🛑 Brake " + k], ["vol" + k, "knob", "🔊 Volume " + k, "[data-vol=\"" + k + "\"]"], ["rate" + k, "knob", "🎚 Pitch " + k, "[data-pitch=\"" + k + "\"]"], ["eqlo" + k, "knob", "EQ Low " + k, "[data-eq=\"" + k + ":lo\"]"], ["eqmid" + k, "knob", "EQ Mid " + k, "[data-eq=\"" + k + ":mid\"]"], ["eqhi" + k, "knob", "EQ High " + k, "[data-eq=\"" + k + ":hi\"]"], ["jog" + k, "jog", "💿 Jog wheel " + k]); });
  MIDI_FUNCS.push(["xf", "knob", "🎚️ Crossfader"], ["fxecho", "knob", "Echo level", "#dj-echo"], ["fxverb", "knob", "Reverb", "#dj-verb"], ["fxfla", "knob", "Flanger", "#dj-fla"], ["fxpha", "knob", "Phaser", "#dj-pha"], ["fxnoise", "knob", "Noise sweep", "#dj-noise"], ["fxfilt", "knob", "Master filter", "#dj-filter"], ["fxboost", "knob", "Boost", "#dj-boost"], ["talk", "btn", "🎙️ Hold to talk"]);
  let midiMap = {}; try { midiMap = JSON.parse(localStorage.getItem("mw-midi-map") || "{}"); } catch (_) {}
  let midiAcc = null, midiLearnKey = null, midiPaintT = 0, midiWake = null, wakeWanted = false;
  const midiSaveMap = () => { try { localStorage.setItem("mw-midi-map", JSON.stringify(midiMap)); } catch (_) {} };
  function midiStat(t) { const el = document.getElementById("dj-midi-stat"); if (el) el.textContent = t; }
  function midiPaintList() { const box = document.getElementById("dj-midi-list"); if (!box) return; box.innerHTML = MIDI_FUNCS.map((f) => { const b = midiMap[f[0]]; return "<div class='mrow" + (midiLearnKey === f[0] ? " learning" : "") + "'><b>" + f[2] + "</b><span class='mb'>" + (b ? (b.t === "note" ? "Note " + b.n : b.t === "jog" ? "Jog CC " + b.n : "CC " + b.n) + " · ch " + (b.ch + 1) : "not set") + "</span><button type='button' class='btn ghost sm' data-mlearn='" + f[0] + "'>" + (midiLearnKey === f[0] ? "…move a control" : "Learn") + "</button>" + (b ? "<button type='button' class='btn ghost sm' data-mclear='" + f[0] + "'>✕</button>" : "") + "</div>"; }).join(""); }
  function midiSetSlider(sel, frac) { const el = document.querySelector(sel); if (!el) return; const mn = parseFloat(el.min || 0), mx = parseFloat(el.max || 1); el.value = String(mn + frac * (mx - mn)); el.dispatchEvent(new Event("input", { bubbles: true })); }
  function midiClick(sel) { const el = document.querySelector(sel); if (el) el.click(); }
  function midiDirty() { const t = Date.now(); if (t - midiPaintT < 150) return; midiPaintT = t; try { paintOwner(); } catch (_) {} }
  function midiLed() { if (!midiAcc) return; DECKS.forEach((k) => { const b = midiMap["play" + k]; if (!b || b.t !== "note") return; midiAcc.outputs.forEach((o) => { try { o.send([0x90 + b.ch, b.n, S[k].playing ? 127 : 0]); } catch (_) {} }); }); }
  function onMidiMsg(e) { const dt = e.data, st = dt[0], n = dt[1], v = dt[2], cmd = st & 0xf0, ch = st & 0x0f; const isNote = cmd === 0x90 && v > 0, isNoteOff = cmd === 0x80 || (cmd === 0x90 && v === 0), isCc = cmd === 0xb0; if (!isNote && !isNoteOff && !isCc) return;
    if (midiLearnKey) { const f = MIDI_FUNCS.find((x) => x[0] === midiLearnKey); if (!f) { midiLearnKey = null; return; } if (f[1] === "btn" && isNote) midiMap[midiLearnKey] = { t: "note", n, ch }; else if (f[1] === "knob" && isCc) midiMap[midiLearnKey] = { t: "cc", n, ch }; else if (f[1] === "jog" && isCc) midiMap[midiLearnKey] = { t: "jog", n, ch }; else return; midiLearnKey = null; midiSaveMap(); midiPaintList(); midiStat("Learned — that control now owns: " + f[2] + ". Learn another row, or just play."); midiLed(); return; }
    for (const key in midiMap) { const b = midiMap[key]; if (!b || b.ch !== ch || b.n !== n) continue; const f = MIDI_FUNCS.find((x) => x[0] === key); if (!f) continue;
      if (b.t === "note") { if (key === "talk") { const tk = document.getElementById("dj-talk"); if (tk) tk.dispatchEvent(new PointerEvent(isNote ? "pointerdown" : "pointerup", { bubbles: true })); continue; } if (!isNote) continue; if (key.indexOf("play") === 0) midiClick("[data-play=\"" + key.slice(4) + "\"]"); else if (key.indexOf("cue") === 0) midiClick("[data-cue0=\"" + key.slice(3) + "\"]"); else if (key.indexOf("brake") === 0) midiClick("[data-brake=\"" + key.slice(5) + "\"]"); setTimeout(midiLed, 60); continue; }
      if (b.t === "cc" && isCc) { if (key === "xf") { xfTouchedAt = Date.now(); S.panX = v / 127; paintXfPads(); levels(); save(); continue; } if (f[3]) { midiSetSlider(f[3], v / 127); midiDirty(); } continue; } // a hardware crossfader rides the X law (S.panX, between the pairs)
      if (b.t === "jog" && isCc) { const k = key.slice(3), d = deck(k); if (!d || !d.el) continue; const delta = v < 64 ? v : v - 128; if (!delta) continue; try { const nt = Math.max(0, Math.min((d.el.duration || 1e9) - 0.3, (d.el.currentTime || 0) + delta * 0.03)); d.el.currentTime = nt; if (S[k].playing) S[k].start = Date.now() - nt * 1000; else S[k].pos = nt; } catch (_) {} midiDirty(); continue; }
    } }
  async function midiEnable() { if (!navigator.requestMIDIAccess) { midiStat("This browser can't do Web MIDI — controllers work in Chrome or Edge on a computer or Android. (Safari and iPhone don't support it; that's Apple's limit, not the site's.)"); return; } try { midiAcc = await navigator.requestMIDIAccess(); const hook = () => { midiAcc.inputs.forEach((i) => { i.onmidimessage = onMidiMsg; }); const names = []; midiAcc.inputs.forEach((i) => { if (i.name) names.push(i.name); }); midiStat(names.length ? "Connected: " + names.join(", ") + " — tap LEARN on a row, then move the control that should own it." : "MIDI is on but no controller was found. Plug it in by USB and it shows up here automatically."); midiLed(); }; midiAcc.onstatechange = hook; hook(); } catch (_) { midiStat("MIDI permission was blocked — allow it in the browser's site settings, then tap Enable again."); } }
  async function midiWakeToggle() { const b = document.getElementById("dj-midi-wake"); if (midiWake) { wakeWanted = false; try { midiWake.release(); } catch (_) {} midiWake = null; if (b) b.textContent = "🔆 Keep screen on: off"; return; } try { midiWake = await navigator.wakeLock.request("screen"); wakeWanted = true; midiWake.addEventListener("release", () => { midiWake = null; const bb = document.getElementById("dj-midi-wake"); if (bb) bb.textContent = "🔆 Keep screen on: off"; }); if (b) b.textContent = "🔆 Keep screen on: ON"; } catch (_) { midiStat("Keep-screen-on isn't available in this browser."); } }
  document.addEventListener("visibilitychange", async () => { if (!document.hidden && wakeWanted && !midiWake) { try { midiWake = await navigator.wakeLock.request("screen"); const b = document.getElementById("dj-midi-wake"); if (b) b.textContent = "🔆 Keep screen on: ON"; } catch (_) {} } });
  { const onB = document.getElementById("dj-midi-on"); if (onB) onB.addEventListener("click", midiEnable); const wkB = document.getElementById("dj-midi-wake"); if (wkB) wkB.addEventListener("click", midiWakeToggle); const clB = document.getElementById("dj-midi-clear"); if (clB) clB.addEventListener("click", () => { midiMap = {}; midiLearnKey = null; midiSaveMap(); midiPaintList(); midiStat("Mapping cleared. Tap LEARN on a row and move a control to bind it again."); }); const list = document.getElementById("dj-midi-list"); if (list) list.addEventListener("click", (e) => { const lb = e.target.closest("[data-mlearn]"), cb = e.target.closest("[data-mclear]"); if (lb) { midiLearnKey = midiLearnKey === lb.dataset.mlearn ? null : lb.dataset.mlearn; midiPaintList(); if (midiLearnKey) midiStat("Learning… move the knob, press the button, or spin the jog on your controller."); } if (cb) { delete midiMap[cb.dataset.mclear]; midiSaveMap(); midiPaintList(); } }); midiPaintList(); }
  /* PHONE DECK SETUPS wiring: the switcher only exists on portrait phones
   * (CSS hides it elsewhere). It changes which decks are SHOWN, never what
   * plays — a hidden deck keeps its sound, exactly like a folded panel. */
  let phN = "1", phDeck = "A";
  try { phN = localStorage.getItem("mw-ph-n") || "1"; phDeck = localStorage.getItem("mw-ph-deck") || "A"; } catch (_) {}
  if (!["1", "2", "3", "4"].includes(phN)) phN = "1";
  if (!DECKS.includes(phDeck)) phDeck = "A";
  function phApply() {
    const row = document.querySelector(".dj-decks"); if (!row) return;
    row.dataset.phn = phN;
    const shown = phN === "1" ? [phDeck] : phN === "2" ? ["A", "B"] : phN === "3" ? ["A", "B", "C"] : DECKS;
    DECKS.forEach((k) => { const el = row.querySelector('.deck[data-deck="' + k + '"]'); if (el) el.classList.toggle("ph-on", shown.includes(k)); });
    const ps = document.getElementById("dj-phset");
    if (ps) { ps.dataset.n = phN; ps.querySelectorAll("[data-phn]").forEach((b) => b.classList.toggle("on", b.dataset.phn === phN)); ps.querySelectorAll("[data-phd]").forEach((b) => b.classList.toggle("on", b.dataset.phd === phDeck)); }
  }
  function phPaint() { const ps = document.getElementById("dj-phset"); if (!ps || !ps.offsetParent) return; ps.querySelectorAll("[data-phd]").forEach((b) => b.classList.toggle("playing", !!(S[b.dataset.phd] && S[b.dataset.phd].playing))); }
  { const ps = document.getElementById("dj-phset"); if (ps) { ps.addEventListener("click", (e) => { const bn = e.target.closest("[data-phn]"), bd = e.target.closest("[data-phd]"); if (bn) { phN = bn.dataset.phn; try { localStorage.setItem("mw-ph-n", phN); } catch (_) {} phApply(); } else if (bd) { phDeck = bd.dataset.phd; try { localStorage.setItem("mw-ph-deck", phDeck); } catch (_) {} phApply(); const el = document.querySelector('.dj-decks>.deck[data-deck="' + phDeck + '"]'); if (el) el.scrollIntoView({ block: "nearest" }); } }); phApply(); setInterval(phPaint, 900); } }
  /* deck volume KNOBS flanking the X fader (owner ask, 2026-10-26): A+B on the
   * left, C+D on the right. Drag up/down to ride a deck volume; the knob drives
   * the deck's own volume slider so state, sound and saves follow the one path.
   * Double-tap resets to 90%. */
  document.querySelectorAll("[data-xv]").forEach((el) => { const k = el.dataset.xv; let drag = null, pend = null; el.addEventListener("pointerdown", (e) => { if (!OWNER()) return; if (serverMirror()) { takeControl(); return; } pend = { y: e.clientY, t: performance.now(), v: S[k] ? S[k].vol : 0, dwell: false }; try { el.setPointerCapture(e.pointerId); } catch (_) {} e.preventDefault(); }); el.addEventListener("pointermove", (e) => { if (pend && !drag) { const dy = e.clientY - pend.y, ady = Math.abs(dy), dt = performance.now() - pend.t; if (ady <= 4) { if (dt >= 70) pend.dwell = true; return; } if (!pend.dwell && dt < 110 && ady >= 20) { pend = null; return; } if (ady >= 10 && (pend.dwell || (dt >= 110 && ady <= dt * 0.35))) { drag = { y: pend.y, v: pend.v }; pend = null; } else return; } if (!drag) return; const v = Math.max(0, Math.min(2, drag.v + (drag.y - e.clientY) / 140)); midiSetSlider("[data-vol=\"" + k + "\"]", v / 2); paintXfPads(); }); const end = () => { drag = null; pend = null; }; el.addEventListener("pointerup", end); el.addEventListener("pointercancel", end); el.addEventListener("dblclick", () => { if (!OWNER()) return; midiSetSlider("[data-vol=\"" + k + "\"]", 0.45); paintXfPads(); }); });

  function playVoice() {
    const v = S.voice; if (!v || heardVoice === v.id || Date.now() - (v.at || 0) > 90000) return;
    if (!v.url && v.text) { heardVoice = v.id; if (!listening) return; dropSpeak(String(v.text)); return; }
    if (!okUrl(v.url) || DEAD(v.url)) return;
    heardVoice = v.id; if (!listening) return;
    voiceEl = new Audio(v.url); voiceEl.playsInline = true; levels();
    voiceEl.addEventListener("ended", levels); voiceEl.addEventListener("error", levels); voiceEl.play().catch(levels);
  }
  /* Station drops arrive as TEXT, not a file (see autoNext): speak the
   * line in the same server male voice Meechie AI uses — Deepgram Aura
   * via POST /api/ai with the page session as the key, the speakServer
   * route from ai-widget.js. The returned audio plays through voiceEl,
   * so the music ducks exactly like a sound-board pad and the at-stamp
   * + heardVoice discipline keeps echoes from double-firing. A client
   * with no session (a guest listener) or a failed fetch falls back to
   * the device voice, with the duck held by the clock (dropDuckUntil)
   * instead of the element. */
  async function dropSpeak(text) {
    try {
      const ses = (window.MW && MW.session && MW.session()) || null, tok = ses && ses.access_token;
      if (tok) {
        const r = await fetch("/api/ai", { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer " + tok }, body: JSON.stringify({ model: "@cf/deepgram/aura-1", text }) });
        if (r.ok && /^audio\//.test(r.headers.get("content-type") || "")) {
          const url = URL.createObjectURL(await r.blob());
          voiceEl = new Audio(url); voiceEl.playsInline = true; levels();
          const done = () => { try { URL.revokeObjectURL(url); } catch (_) {} levels(); };
          voiceEl.addEventListener("ended", done); voiceEl.addEventListener("error", done);
          await voiceEl.play(); return;
        }
      }
      throw new Error("notts");
    } catch (_) {
      try {
        if (!("speechSynthesis" in window)) return;
        const words = text.split(/\s+/).length;
        dropDuckUntil = Date.now() + Math.round(words / 2.4 * 1000) + 800; levels();
        const u = new SpeechSynthesisUtterance(text); u.pitch = 1; u.rate = 1;
        u.onend = () => { dropDuckUntil = 0; levels(); }; u.onerror = u.onend;
        speechSynthesis.speak(u);
      } catch (_) {}
    }
  }
  /* ---------- one set, every device (owner, 2026-10-27) ----------
   * Pad taps are events, not state: a tap on any of his devices stamps
   * S.padHit, and the window playing the sound fires it through the
   * broadcast — so the phone works the sound pad while the computer runs
   * the tables, and listeners tuned in hear the hit too. */
  let heardPad = "";
  function stampPad(hit) { if (SANDBOX || !OWNER()) return; S.padHit = Object.assign({}, hit, { at: Date.now(), by: tabId }); heardPad = S.padHit.at + ":" + S.padHit.by; save(true); }
  /* ---------- transition horn (owner, 2026-10-28) ----------
   * Every AUTOMATED handover (booth autoNext below, and the station
   * keeper stamping S.fxHornAt on its own crossfades) fires one air-horn
   * PATTERN on every audible client at the same moment — a real DJ working
   * the transition. Manual deck moves never stamp it. The sound mirrors
   * the booth Air Horn pad (detuned saws into the master chain), so the
   * broadcast polish shapes it and it rides over any deck source,
   * YouTube included. One stab per distinct stamp, per client. */
  function hornHit(c, t0, dur) {
    [392, 494, 587].forEach((f) => { const o = c.createOscillator(), bp = c.createBiquadFilter(), g = c.createGain(); o.type = "sawtooth"; o.frequency.setValueAtTime(f * 1.01, t0); o.frequency.exponentialRampToValueAtTime(f * 0.97, t0 + dur); bp.type = "bandpass"; bp.frequency.value = 1200; bp.Q.value = 0.7; g.gain.setValueAtTime(0.0001, t0); g.gain.exponentialRampToValueAtTime(0.085, t0 + 0.02); g.gain.setValueAtTime(0.085, t0 + Math.max(0.02, dur - 0.05)); g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur); o.connect(bp); bp.connect(g); g.connect(masterIn); o.start(t0); o.stop(t0 + dur + 0.05); });
  }
  function hornStab() {
    try {
      const c = actx(); if (!c || !masterIn) return;
      if (c.state !== "running") c.resume().catch(() => {});
      const t = c.currentTime + 0.02;
      // A DJ working the horn across the blend, not one flat beep: a long
      // blast, three quick re-trigger stabs, and a final long blast with
      // the pitch sagging as the pressure drops — about 1.8 seconds.
      hornHit(c, t, 0.5); hornHit(c, t + 0.56, 0.13); hornHit(c, t + 0.74, 0.13); hornHit(c, t + 0.92, 0.13); hornHit(c, t + 1.12, 0.68);
    } catch (_) {}
  }
  let hornHeard = 0, hornInit = false;
  function watchHorn() {
    const t = +(S && S.fxHornAt) || 0; if (!t) return;
    if (S.hornOn !== true) { hornInit = true; hornHeard = t; return; } // horns OFF (owner, 2026-10-29: turn off the horn sound): the stamp is still tracked, so one from before the toggle can never fire late - it just makes no sound
    if (!hornInit) { hornInit = true; hornHeard = t; return; }
    if (t === hornHeard) return;
    hornHeard = t;
    if (boothLead || listening) hornStab();
  }
  /* ---------- video FX one-shots (owner, 2026-10-28) ----------
   * The VIDEO FX pad fires stamped events, exactly like the transition
   * horn: the owner stamps S.vfx {kind, at} and EVERY client (booth,
   * station card, mini) plays the hit once per stamp by animating its
   * .vstage wrappers. The players underneath are never paused, restarted
   * or re-seeked - the picture cannot drift from the sound. In the
   * Playground the pad animates this copy only and stamps nothing. */
  const VFX_DUR = { flash: 330, strobe: 700, glitch: 430, blurp: 730, zoomp: 580, mono: 2000, invert: 900, hue: 1250 };
  function vfxStage(kind) {
    if (!VFX_DUR[kind]) return;
    document.querySelectorAll(".vstage").forEach((st) => { const cls = "vfx-" + kind; st.classList.remove(cls); void st.offsetWidth; st.classList.add(cls); setTimeout(() => st.classList.remove(cls), VFX_DUR[kind] + 80); });
  }
  let vfxHeard = 0, vfxInit = false;
  function watchVfx() {
    const v = S && S.vfx, t = +(v && v.at) || 0; if (!t) return;
    if (!vfxInit) { vfxInit = true; vfxHeard = t; return; }
    if (t === vfxHeard) return;
    vfxHeard = t;
    if (Date.now() - t > 15000) return;
    vfxStage(v.kind);
  }
  function fireVfx(kind) {
    if (!VFX_DUR[kind]) return;
    vfxStage(kind);
    const pb = document.querySelector('[data-vfx="' + kind + '"]'); if (pb) { pb.classList.add("hit"); setTimeout(() => pb.classList.remove("hit"), 200); }
    if (SANDBOX || !OWNER()) return;
    S.vfx = { kind: kind, at: Date.now() }; vfxHeard = S.vfx.at; vfxInit = true; save(true);
  }
  function firePadHit() {
    if (SANDBOX) return;
    const h = S.padHit; if (!h || !h.at || h.by === tabId) return;
    const id = h.at + ":" + h.by; if (heardPad === id || Date.now() - h.at > 15000) return;
    if (OWNER() && boothLead) {
      heardPad = id;
      if (h.kind === "synth" && SYNTH[h.i]) SYNTH[h.i].fn();
      else if (h.url && okUrl(h.url)) playPadUrl(h.url);
      const pb = document.querySelector(h.kind === "synth" ? '[data-synth="' + h.i + '"]' : '[data-pad="' + h.i + '"]'); if (pb) { pb.classList.add("hit"); setTimeout(() => pb.classList.remove("hit"), 200); }
    } else if (!OWNER() && listening && h.url && okUrl(h.url)) {
      heardPad = id;
      const a = new Audio(h.url); a.playsInline = true; a.play().catch(() => {});
    }
  }
  /* waveform peaks (decoded once per song; flat line if the file won't decode) */
  const peakCache = new Map();
  async function peaks(k) {
    const d = deck(k), src = d.src, cv = $("#wv-" + k); if (!cv || !src) return;
    const draw = (pk) => {
      const g = cv.getContext("2d"); if (!g) return; const W = cv.width, H = cv.height; g.clearRect(0, 0, W, H);
      const el = d.el, dur = el.duration || S[k].dur || 0, p = dur ? el.currentTime / dur : 0;
      const n = pk ? pk.length : 60;
      for (let i = 0; i < n; i++) { const v = pk ? pk[i] : 0.25, h = Math.max(2, v * (H - 6)); g.fillStyle = v > 0.85 ? "#e5484d" : v > 0.55 ? "#f7b928" : "#8a6d2f"; g.fillRect(i * (W / n) + 0.5, (H - h) / 2, Math.max(1, W / n - 1.5), h); }
      const bl = beatLen(k);
      if (bl && dur) { g.fillStyle = "rgba(255,255,255,.13)"; const b0 = S[k].beat0 || 0; for (let b = b0; b < dur; b += bl * 4) g.fillRect((b / dur) * W, 0, 1, H); }
      if (d.loop && dur) { g.fillStyle = "rgba(229,72,77,.22)"; g.fillRect((d.loop[0] / dur) * W, 0, Math.max(2, ((d.loop[1] - d.loop[0]) / dur) * W), H); }
      if (dur) { g.fillStyle = "#ffe08a"; d.cues.forEach((c) => { if (c != null) g.fillRect((c / dur) * W - 1, 0, 2, 10); }); }
      g.fillStyle = "rgba(0,0,0,.38)"; g.fillRect(W * p, 0, W * (1 - p), H);
      g.fillStyle = "#fff"; g.fillRect(W * p - 1, 0, 2, H);
    };
    const hiPk = ANA.get(src); if (hiPk && hiPk.pk) { draw(hiPk.pk); return; }
    if (peakCache.has(src)) { draw(peakCache.get(src)); return; }
    draw(null);
    try {
      const c = actx(); if (!c) return;
      const buf = await (await fetch(src)).arrayBuffer();
      const ab = await c.decodeAudioData(buf.slice(0));
      const ch = ab.getChannelData(0), N = 90, pk = [];
      for (let i = 0; i < N; i++) { let m = 0; const st = Math.floor(i * ch.length / N), en = Math.floor((i + 1) * ch.length / N); for (let j = st; j < en; j += 97) m = Math.max(m, Math.abs(ch[j])); pk.push(m); }
      peakCache.set(src, pk); if (deck(k).src === src) draw(pk);
    } catch (_) { peakCache.set(src, null); }
  }

  /* ================= beat engine: BPM + beat grid + key, measured from the audio itself =================
   * Every song loaded on a deck gets measured once (offline decode at 22kHz mono): tempo by
   * onset autocorrelation, the beat grid's phase by folding the onset envelope, the musical key
   * by chroma (Goertzel) matched against Krumhansl profiles, plus 360 hi-res waveform peaks.
   * Results cache in localStorage and persist onto the track doc, so a song is only ever
   * measured once. Quantize, beat loops, phase sync and the tempo-synced FX all read this. */
  const ANA = new Map(); const anaBusy = new Set(); const tapT = {};
  let anaLS = {}; try { anaLS = JSON.parse(localStorage.getItem("mw-ana-v1") || "{}"); } catch (_) {}
  const anaSaveLS = () => { try { const ks = Object.keys(anaLS); if (ks.length > 120) ks.slice(0, ks.length - 120).forEach((x) => delete anaLS[x]); localStorage.setItem("mw-ana-v1", JSON.stringify(anaLS)); } catch (_) {} };
  function anaStore(src, o) { if (!src) return; const old = ANA.get(src) || {}; ANA.set(src, Object.assign(old, { bpm: o.b, beat0: o.o, key: o.k, cam: o.c })); anaLS[src] = o; anaSaveLS(); }
  function beatLen(k) { return S[k] && S[k].bpm > 0 ? 60 / S[k].bpm : 0; }
  function beatPhase(k, t) { const bl = beatLen(k); if (!bl) return 0; const x = ((t - (S[k].beat0 || 0)) / bl) % 1; return x < 0 ? x + 1 : x; }
  function snapBeat(k, t) { const bl = beatLen(k); if (!bl) return t; const o = S[k].beat0 || 0; return Math.max(0, o + Math.round((t - o) / bl) * bl); }
  function refBpm() { for (const k of DECKS) if (S[k].playing && S[k].bpm > 0) return S[k].bpm * (S[k].rate || 1); return 0; }
  const CAMELOT = { "C": "8B", "G": "9B", "D": "10B", "A": "11B", "E": "12B", "B": "1B", "F#": "2B", "Db": "3B", "Ab": "4B", "Eb": "5B", "Bb": "6B", "F": "7B", "Am": "8A", "Em": "9A", "Bm": "10A", "F#m": "11A", "C#m": "12A", "G#m": "1A", "Ebm": "2A", "Bbm": "3A", "Fm": "4A", "Cm": "5A", "Gm": "6A", "Dm": "7A" };
  const NOTE_NAMES = ["C", "C#", "D", "Eb", "E", "F", "F#", "G", "Ab", "A", "Bb", "B"];
  function keyCompat(a, b) { if (!a || !b) return false; if (a === b) return true; const na = parseInt(a), nb = parseInt(b), la = a.slice(-1), lb = b.slice(-1); return (la === lb && Math.abs(na - nb) === 1) || (na === nb && la !== lb); }
  function detectKey(ch) {
    const maj = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88], min = [6.33, 2.68, 3.52, 5.38, 2.6, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];
    const corr = (prof, rot) => { let sx = 0, sy = 0, sxx = 0, syy = 0, sxy = 0; for (let i = 0; i < 12; i++) { const x = ch[(i + rot) % 12], y = prof[i]; sx += x; sy += y; sxx += x * x; syy += y * y; sxy += x * y; } const num = 12 * sxy - sx * sy, den = Math.sqrt((12 * sxx - sx * sx) * (12 * syy - sy * sy)); return den ? num / den : 0; };
    let best = { v: -2, name: "C", mode: "" };
    for (let r = 0; r < 12; r++) { const cm = corr(maj, r); if (cm > best.v) best = { v: cm, name: NOTE_NAMES[r], mode: "" }; const cn = corr(min, r); if (cn > best.v) best = { v: cn, name: NOTE_NAMES[r], mode: "m" }; }
    const label = best.name + best.mode; return { key: label, cam: CAMELOT[label] || "" };
  }
  function measure(mono, sr) {
    const pk = [], NB = 360;
    for (let i = 0; i < NB; i++) { let m = 0; const st = Math.floor(i * mono.length / NB), en = Math.floor((i + 1) * mono.length / NB); for (let j = st; j < en; j += 7) m = Math.max(m, Math.abs(mono[j])); pk.push(+m.toFixed(3)); }
    const hop = 256, frames = Math.floor(mono.length / hop), env = new Float32Array(frames);
    let lp = 0; const lpA = 1 - Math.exp(-2 * Math.PI * 150 / sr); let prev = 0;
    for (let f = 0; f < frames; f++) { let e = 0; const st = f * hop; for (let j = 0; j < hop; j += 4) { const x = mono[st + j]; lp += lpA * (Math.abs(x) - lp); e += lp * lp; } e = Math.sqrt(e / (hop / 4)); env[f] = Math.max(0, e - prev); prev = e; }
    const hopSec = hop / sr;
    let bestLag = 0, bestScore = -1;
    for (let bpm = 55; bpm <= 185; bpm += 0.5) { const lag = Math.round(60 / bpm / hopSec); let s = 0; const lim = frames - lag; for (let f = 0; f < lim; f += 2) s += env[f] * env[f + lag]; if (s > bestScore) { bestScore = s; bestLag = lag; } }
    let bpm = 60 / (bestLag * hopSec);
    while (bpm < 70) bpm *= 2; while (bpm > 180) bpm /= 2;
    const blF = Math.max(8, Math.round(60 / bpm / hopSec)); let phBest = 0, phScore = -1;
    for (let off = 0; off < blF; off++) { let s = 0; for (let f = off; f < frames; f += blF) s += env[f]; if (s > phScore) { phScore = s; phBest = off; } }
    const beat0 = +(phBest * hopSec).toFixed(3);
    const ch = new Array(12).fill(0), N = Math.min(mono.length, Math.floor(sr * 100));
    for (let pc = 0; pc < 12; pc++) for (let oct = 0; oct < 3; oct++) { const f0 = 130.81 * Math.pow(2, pc / 12 + oct), w = 2 * Math.PI * f0 / sr, coef = 2 * Math.cos(w); let s0 = 0, s1 = 0, s2 = 0; for (let i = 0; i < N; i += 3) { s0 = mono[i] + coef * s1 - s2; s2 = s1; s1 = s0; } ch[pc] += s1 * s1 + s2 * s2 - coef * s1 * s2; }
    const kk = detectKey(ch);
    return { bpm: +bpm.toFixed(1), beat0, key: kk.key, cam: kk.cam, pk };
  }
  // Song analysis (BPM and key) downloads and decodes the whole file. Doing it
  // the moment a song loads starves the deck that is playing (owner,
  // 2026-10-27: loading a song made the other deck stop or lag), so it waits
  // for a gap: it runs right away when nothing is playing, otherwise when the
  // booth goes quiet. Each song is only ever analyzed once — results cache.
  const anaQueue = [];
  function anaLater(k) { if (!anaQueue.includes(k)) anaQueue.push(k); anaPump(); }
  function anaPump() { if (DECKS.some((x) => S[x] && S[x].playing)) return; const k = anaQueue.shift(); if (k) analyze(k); }
  setInterval(anaPump, 4000);
  async function analyze(k) {
    if (!OWNER()) return;
    const d = deck(k), src = d.src || S[k].src; if (!src || DEAD(src) || S[k].bpm > 0) return;
    const hit = ANA.get(src) || anaLS[src];
    if (hit && (hit.bpm > 0 || hit.b > 0)) { if (!ANA.has(src)) ANA.set(src, hit); setAna(k, hit, false); return; }
    if (anaBusy.has(src)) return; anaBusy.add(src);
    const lbl = $("#bpm-" + k); if (lbl) lbl.textContent = "BPM …measuring";
    try {
      const buf = await (await fetch(src)).arrayBuffer();
      let mono, sr;
      try { const oc = new OfflineAudioContext(1, 1, 22050); const ab = await oc.decodeAudioData(buf.slice(0)); mono = ab.getChannelData(0); sr = ab.sampleRate; }
      catch (_) { const c = actx(); const ab = await c.decodeAudioData(buf.slice(0)); const L = ab.getChannelData(0), R = ab.numberOfChannels > 1 ? ab.getChannelData(1) : L; mono = new Float32Array(L.length); for (let i = 0; i < L.length; i++) mono[i] = (L[i] + R[i]) / 2; sr = ab.sampleRate; }
      const res = measure(mono, sr);
      ANA.set(src, res); anaLS[src] = { b: res.bpm, o: res.beat0, k: res.key, c: res.cam }; anaSaveLS();
      if (deck(k).src === src) setAna(k, res, true);
    } catch (_) { ANA.set(src, { bpm: 0 }); const l2 = $("#bpm-" + k); if (l2 && deck(k).src === src) l2.textContent = "BPM —"; }
    anaBusy.delete(src);
  }
  function setAna(k, a, persist) {
    const bpm = a.bpm || a.b || 0; if (!(bpm > 0)) return;
    S[k].bpm = bpm; S[k].beat0 = a.beat0 ?? a.o ?? 0; S[k].key = a.key || a.k || ""; S[k].cam = a.cam || a.c || "";
    paintBeat(k);
    if (persist && !SANDBOX) { save(); const src = deck(k).src || S[k].src; const t = TRACKS().find((x) => URLOF(x) === src); if (t && t.id && !t.bpm) { t.bpm = S[k].bpm; t.key = S[k].key; t.cam = S[k].cam; try { DB()?.collection("tracks").doc(t.id).update({ bpm: S[k].bpm, key: S[k].key, cam: S[k].cam }).catch(() => {}); } catch (_) {} } }
  }
  function paintBeat(k) {
    const s = S[k]; if (!s) return;
    const b = $("#bpm-" + k); if (b && !anaBusy.has(deck(k).src || "")) b.textContent = s.bpm > 0 ? s.bpm.toFixed(1) + " BPM" : "BPM —";
    const kv = $("#key-" + k); if (kv) { kv.textContent = s.cam ? s.cam + (s.key ? " · " + s.key : "") : ""; kv.classList.toggle("compat", !!(s.cam && DECKS.some((x) => x !== k && S[x] && S[x].cam && keyCompat(s.cam, S[x].cam)))); }
  }
  function drawPair(k1, k2) {
    const cv = $("#pw-" + k1 + k2); if (!cv) return; const g = cv.getContext("2d"); if (!g) return;
    const W = cv.width, H = cv.height, laneH = H / 2; g.clearRect(0, 0, W, H);
    [[k1, 0], [k2, 1]].forEach(([k, lane]) => {
      const d = decks[k]; if (!d || !d.src) return;
      const pk = (ANA.get(d.src) && ANA.get(d.src).pk) || peakCache.get(d.src);
      const y0 = lane * laneH, n = pk ? pk.length : 60;
      for (let i = 0; i < n; i++) { const v = pk ? pk[i] : 0.25, h = Math.max(1, v * (laneH - 8)); g.fillStyle = lane === 0 ? "#f7b928" : "#7cc7ff"; g.globalAlpha = 0.85; g.fillRect(i * (W / n) + 0.5, y0 + (laneH - h) / 2, Math.max(1, W / n - 1.5), h); }
      g.globalAlpha = 1;
      const dur = d.el.duration || S[k].dur || 0;
      if (dur) { const x = (d.el.currentTime / dur) * W; g.fillStyle = "#fff"; g.fillRect(x - 1, y0, 2, laneH); }
      g.fillStyle = "rgba(255,255,255,.75)"; g.font = "700 10px system-ui"; g.fillText(k, 4, y0 + 11);
    });
    const ph = $("#ph-" + k1 + k2);
    if (ph) {
      if (S[k1].playing && S[k2].playing && beatLen(k1) && beatLen(k2)) {
        let delta = beatPhase(k2, deck(k2).el.currentTime) - beatPhase(k1, deck(k1).el.currentTime); delta = ((delta % 1) + 1.5) % 1 - 0.5;
        ph.textContent = Math.abs(delta) < 0.03 ? "⚡ PHASE LOCKED — the beats line up" : "Phase: deck " + k2 + " sits " + Math.abs(delta).toFixed(2) + " beats " + (delta > 0 ? "behind" : "ahead") + " — SYNC on deck " + k2 + " locks it in";
        ph.style.color = Math.abs(delta) < 0.03 ? "#45bd62" : "";
      } else { ph.textContent = k1 === "A" ? "Phase meter: play both decks with a measured BPM and this shows how far apart the beats sit." : "Phase meter for decks C and D."; ph.style.color = ""; }
    }
  }
  // the beat tick: dots, labels, parallel waveforms + phase, five times a second in the booth
  setInterval(() => {
    if (!OWNER() || !document.getElementById("dj-owner") || document.getElementById("dj-owner").hidden) return;
    DECKS.forEach((k) => {
      paintBeat(k);
      const dots = $("#dots-" + k); if (!dots) return;
      const d = deck(k), on = S[k].playing && beatLen(k) > 0;
      const bn = on ? Math.floor((d.el.currentTime - (S[k].beat0 || 0)) / beatLen(k)) : -1;
      const cur = bn >= 0 ? ((bn % 4) + 4) % 4 : -1;
      [...dots.children].forEach((el2, i) => el2.classList.toggle("on", i === cur));
    });
    drawPair("A", "B"); drawPair("C", "D");
  }, 200);

  /* the editing panel under the master screen (owner, 2026-10-26): S.ved shapes
     the master PICTURE on every screen (booth, station, mini) via CSS vars, and
     the audio half mirrors the mixer's master FX — both panels always agree */
  const paintVEdit = () => { const v = S.ved || {}, de = document.documentElement.style; de.setProperty("--vb", v.b == null ? 1 : v.b); de.setProperty("--vc", v.c == null ? 1 : v.c); de.setProperty("--vs", v.s == null ? 1 : v.s); de.setProperty("--vz", v.z == null ? 1 : v.z); };
  const paintEdit = () => { const f = S.fx || defFx(), v = S.ved || {}; const set = (id, val) => { const el = $(id); if (el && document.activeElement !== el) el.value = val; }, txt = (id, val) => { const el = $(id); if (el) el.textContent = val; };
    set("#djx-boost", f.boost || 1); txt("#djx-boost-v", Math.round((f.boost || 1) * 100) + "%");
    set("#djx-filter", f.mf == null ? 100 : f.mf); set("#dj-filter", f.mf == null ? 100 : f.mf);
    set("#djx-echo", f.echo || 0); set("#dj-echo", f.echo || 0);
    set("#djx-fb", f.fb == null ? 0.34 : f.fb); set("#dj-fb", f.fb == null ? 0.34 : f.fb);
    set("#djx-verb", f.verb || 0); set("#dj-verb", f.verb || 0);
    set("#djx-fla", f.fla || 0); set("#dj-fla", f.fla || 0);
    set("#djx-pha", f.pha || 0); set("#dj-pha", f.pha || 0);
    set("#djx-noise", f.noise || 0); set("#dj-noise", f.noise || 0);
    set("#djx-crush", f.crush || 0);
    set("#djx-vb", v.b == null ? 1 : v.b); set("#djx-vc", v.c == null ? 1 : v.c); set("#djx-vs", v.s == null ? 1 : v.s); set("#djx-vz", v.z == null ? 1 : v.z);
    txt("#djx-vb-v", Math.round((v.b == null ? 1 : v.b) * 100) + "%"); txt("#djx-vc-v", Math.round((v.c == null ? 1 : v.c) * 100) + "%"); txt("#djx-vs-v", Math.round((v.s == null ? 1 : v.s) * 100) + "%"); txt("#djx-vz-v", Math.round((v.z == null ? 1 : v.z) * 100) + "%"); };
  function paintOwner() {
    try { ahEnsure(); } catch (_) {}
    document.querySelectorAll("[data-vmix]").forEach((x) => x.classList.toggle("on", x.dataset.vmix === "auto" && (!S.vmix || S.vmix.mode === "auto")));
    document.querySelectorAll("[data-vsrc]").forEach((x) => x.classList.toggle("on", !!S.vmix && S.vmix.mode === "man" && S.vmix.a === x.dataset.vsrc && !S.vmix.b));
    document.querySelectorAll("[data-vtr]").forEach((x) => x.classList.toggle("on", ((S.vmix && S.vmix.tr) || "fade") === x.dataset.vtr));
    document.querySelectorAll("[data-vspd]").forEach((x) => x.classList.toggle("on", ((S.vmix && +S.vmix.trMs) || 650) === +x.dataset.vspd));
    paintVSkip();
    DECKS.forEach((k) => {
      const s = S[k], pl = $("#pl-" + k);
      $("#ttl-" + k).textContent = s.title || "Load a song";
      pl.classList.toggle("spin", !!s.playing);
      pl.classList.toggle("has-cover", okUrl(s.cover)); if (okUrl(s.cover)) pl.style.setProperty("--cv", `url("${s.cover}")`);
      document.querySelector(`[data-play="${k}"]`).textContent = s.playing ? "⏸ Pause" : "▶ Play";
      document.querySelector(`[data-vol="${k}"]`).value = s.vol ?? 0.9;
      const pv = document.querySelector(`[data-pitch="${k}"]`); if (pv && document.activeElement !== pv) pv.value = s.rate || 1;
      $("#pit-v-" + k).textContent = (((s.rate || 1) - 1) * 100).toFixed(1).replace("-", "−") + "%";
      paintBeat(k);
      document.querySelectorAll(`[data-vcut="${k}"]`).forEach((b) => b.classList.toggle("on", !!s.vcut));
      document.querySelectorAll(`[data-bcut="${k}"]`).forEach((b) => b.classList.toggle("on", !!s.bcut));
      peaks(k);
    });
    const qz = $("#dj-quant"); if (qz && document.activeElement !== qz) qz.checked = S.quant !== false;
    const jf = $("#dj-jogf"); if (jf && document.activeElement !== jf) jf.value = String(JOGF);
    const fsx = $("#dj-fxsync"); if (fsx && document.activeElement !== fsx) fsx.checked = (S.fx && S.fx.sync) !== false;
    const cr = $("#dj-crush"); if (cr && document.activeElement !== cr) cr.value = (S.fx && S.fx.crush) || 0; $("#dj-golive").checked = !!S.live; paintEdit(); paintXfPads();
    [["dj-filter", S.fx && S.fx.mf], ["dj-echo", S.fx && S.fx.echo], ["dj-fb", S.fx && S.fx.fb], ["dj-verb", S.fx && S.fx.verb], ["dj-fla", S.fx && S.fx.fla]].forEach(([id, v]) => { const el = document.getElementById(id); if (el && document.activeElement !== el && v != null) el.value = v; });
    document.querySelectorAll(".edivb").forEach((x) => x.classList.toggle("on", Math.abs((+x.dataset.ediv) - ((S.fx && S.fx.ediv) || 0.75)) < 0.01));
    const ad = $("#ad-on"); if (ad) ad.checked = !!S.autodj;
    const adp = $("#ad-drops"); if (adp) adp.checked = S.dropsOn !== false;
    const adl = $("#ad-drops-list"); if (adl && !adl.dataset.done) { adl.dataset.done = "1"; adl.innerHTML = DROP_TEXTS.map((t, i) => `<div class="dj-item"><span title="${E(t)}">${i + 1}. ${E(t)}</span></div>`).join(""); }
    const adT = $("#dj-ad-top"); if (adT) adT.checked = !!S.autodj;
    const hnT = $("#dj-horn-top"); if (hnT) hnT.checked = S.hornOn === true;
    const lamp = $("#dj-lamp"); lamp.classList.toggle("on", !!S.live || vsBroadcast()); lamp.lastChild.textContent = SANDBOX ? (guestLiveOn() ? "ON AIR" : S.live ? "PRACTICE" : "STANDBY") : (S.live || vsBroadcast() ? "ON AIR" : "OFF AIR");
    renderLog($("#dj-log")); paintPads();
  }
  function renderLog(box) {
    if (!box) return;
    const lg = S.log || [];
    const sig = lg.length + ":" + (lg.length ? lg[0].at : 0) + ":" + Math.floor(Date.now() / 60000); // skip identical re-renders on state echoes; the minute bucket keeps the relative-time labels honest
    if (box._logSig === sig) return;
    box._logSig = sig;
    box.innerHTML = lg.length ? lg.map((x) => `<div><span>${E(x.t)}${x.live ? ' <small style="color:#ff8b8f">● LIVE</small>' : ""}</span><time>${agoT(x.at)}</time></div>`).join("") : '<small class="muted">Nothing played yet this session.</small>';
  }
  function paintStation() {
    if (!stateSeen && !OWNER() && !SANDBOX) { const lamp0 = $("#st-lamp"); if (lamp0) { lamp0.classList.toggle("on", false); if (lamp0.lastChild) lamp0.lastChild.textContent = "CONNECTING"; } const now0 = $("#st-now"); if (now0) now0.textContent = "Connecting to the station…"; const sw0 = $("#st-watch"); if (sw0) sw0.hidden = true; return; } // no state snapshot yet: never paint OFF AIR from default state
    const tvLive = vsBroadcast() && !(S.vstream || {}).hidden; // SHARING = LIVE: a TV broadcast lights the station even with the radio switch off and the tables paused for the share
    const live = isLive() || tvLive;
    const lamp = $("#st-lamp"); lamp.classList.toggle("on", live); lamp.lastChild.textContent = SANDBOX ? (guestLiveOn() ? "ON AIR" : live ? "PRACTICE" : "STANDBY") : (live ? "ON AIR" : "OFF AIR");
    const tk = $("#st-ticker"); tk.hidden = !S.ticker; if (S.ticker) $("#st-ticker-t").textContent = S.ticker;
    const now = live ? DECKS.filter((k) => S[k].playing && !(S[k].dur && S[k].start && Date.now() - S[k].start > (S[k].dur + 45) * 1000)).map((k) => S[k].title).filter(Boolean) : [];
    const boothLive = S.boothAt && Date.now() - S.boothAt < 45000;
    const gN = S.djGuest && S.djGuest.until > Date.now() ? gName(S.djGuest) : null;
    $("#st-now").textContent = tvLive && !now.length && !gN ? "📺 Meechie is live on the master screen — watch it on MW TV. The tables pick back up when the share ends." : live ? (now.length ? (boothLive ? "🎧 Live now: " : S.autodj ? "🤖 Auto-DJ live: " : "🎧 Live now: ") + now.join("  ×  ") : gN ? "🎧 " + gN + " is live on the decks." : "🎧 Meechie is live on the decks.") : "The station is on the playlist right now. When Meechie goes live on the decks, it shows up here.";
    const stWatch = $("#st-watch"); if (stWatch) stWatch.hidden = !live || OWNER() || SANDBOX;
    const stHost = $("#st-host"); // HOST MODE: the room can see the host is in — same booth-fresh window the keeper trusts (90s), and never while a guest DJ holds the tables
    if (stHost) { const hosting = !SANDBOX && live && !gN && (Date.now() - (S.boothAt || 0) < 90000); if (stHost._h !== hosting) { stHost._h = hosting; stHost.hidden = !hosting; if (hosting) stHost.textContent = "🔴 Meechie is in the booth — hosting live"; } }
    const stShow = $("#st-show");
    const showSig = S.show ? String(S.show.url || "") + "|" + (+S.show.at || 0) + "|" + (S.show.video ? "v" : "a") : ""; // only rebuild the recorded-show block when the show record itself changes — the old code destroyed and recreated its media element on every state echo
    if (stShow && stShow._showSig !== showSig) { stShow._showSig = showSig; stShow.innerHTML = S.show && okUrl(S.show.url) && !DEAD(S.show.url) ? "<b style=\"font-size:13px;letter-spacing:.1em\">" + (S.show.video ? "🎬 LATEST SESSION VIDEO" : "🎙️ LATEST RECORDED SHOW") + "</b>" + (S.show.video ? "<video controls preload=\"none\" src=\"" + E(S.show.url) + "\" style=\"width:100%;margin-top:6px;border-radius:10px;background:#000\"></video>" : "<audio controls preload=\"none\" src=\"" + E(S.show.url) + "\" style=\"width:100%;margin-top:6px\"></audio>") + "<small class=\"muted\">Recorded " + new Date(S.show.at).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: "America/New_York" }) + "</small>" : ""; }
    renderLog($("#st-log"));
    try { paintBattleCard(); } catch (_) {}
  }
  /* ---------- AGGRESSIVE STALL WATCHDOG (mwStallWatchdog) ----------
   * GATE AUDIT (2026-10-29, owner live defect): this watchdog used to arm
   * on boothLead - the LOCAL sound lease, which is per browser and says
   * nothing about who authors the shared state. A booth tab could hold
   * its own lease while another screen drove the set (or hold no lease
   * while its saves kept boothAt fresh and the keeper stood down), and
   * wedged decks sat flagged playing at pos 0 for minutes with no
   * rescue. It arms on leadDrive() now - the mwLeadLock server claim -
   * so exactly one booth, the one actually driving, runs the ladder.
   * Owner spec 2026-10-28 ("if music stops for any reason it automatically
   * cuts back on"), tightened by the owner 2026-10-29: "yes an agresive
   * watch dog". The element-state stall check inside the tick below trusts
   * the player, and a video shim can lie: its readyState sits at 4 and its
   * state can read as playing while its clock is frozen solid - twice on
   * 2026-10-29 a deck flagged playing sat at one position for minutes
   * (deck B at 1022.3s, deck C at 229.7s) while the booth kept stamping
   * fresh, and the keeper cannot rescue that because the keeper only
   * drives when the booth is stale. This watchdog trusts only the
   * player's own clock. On the driving booth (the same OWNER() +
   * boothLead + S.live gate as the neighbouring checks; in the sandbox
   * that gate is the local tables only, where save() never touches the
   * radio) a deck flagged playing whose position has not moved 0.25s
   * inside 5 seconds is stalled, and it recovers in rungs 5 seconds
   * apart: 1) press play on the player again, 2) reload the same track
   * at the stalled position, 3) hand the deck to deckEnded, the
   * natural-end path, so Auto-DJ or the queue rolls on. A track that
   * stalls again after one reload in the same play skips the reload
   * rung - it hands over and is not reloaded again this cycle. A
   * deliberate pause is never a stall: a DJ pause clears the deck's
   * playing flag and a full stop stamps S.pausedAt, and either one
   * resets this watchdog outright. Loop and roll decks, the runout zone
   * (the last 0.75s), and a deck under a hand (grain scratch, a seek
   * still landing, a fresh noSync) are left alone. It never pauses or
   * stops anything itself: recovery or handover only. Memory-only
   * state, per deck. */
  const wdPos = {};
  const wdKeyOf = (k) => { const s = S[k]; return (s.yt ? "yt:" + s.yt : "f:" + (s.src || "")) + "|" + (s.title || ""); };
  const wdKick = (k) => { const d = decks[k]; if (!d || !d.el) return; try { const pp = d.el.play(); if (pp && pp.catch) pp.catch(() => {}); } catch (_) {} };
  const wdReload = (k, at) => {
    const s = S[k], d = decks[k]; if (!s || !d) return;
    if (s.yt) { const tok = s.yt; try { d.clearYt(); } catch (_) {} d.setYt(tok).then((okY) => { if (!okY || !S[k].playing || S[k].yt !== tok) return; try { d.el.currentTime = at; } catch (_) {} wdKick(k); S[k].start = Date.now() - at * 1000; }).catch(() => {}); return; }
    if (!okUrl(s.src)) return;
    const el = d.el; if (!el) return;
    try { el.pause(); } catch (_) {}
    try { el.src = s.src; el.load(); } catch (_) {}
    const go = () => { try { el.currentTime = at; } catch (_) {} try { const pp = el.play(); if (pp && pp.catch) pp.catch(() => {}); } catch (_) {} if (S[k].playing && !S[k].yt) S[k].start = Date.now() - at * 1000; };
    if (el.readyState >= 1) go(); else el.addEventListener("loadedmetadata", go, { once: true });
  };
  setInterval(() => {
    const oe = document.getElementById("dj-owner"); if (oe && oe.hidden && OWNER()) showOwnerUI();
    if (ctx && ctx.state !== "running" && ctx.state !== "closed" && DECKS.some((k) => S[k] && S[k].playing) && (boothLead || listening)) { wakeAudio(); if (Date.now() - muteHintAt > 20000) { muteHintAt = Date.now(); setTimeout(() => { if (ctx && ctx.state !== "running") say("🔇 Your phone paused the sound. Tap anywhere on the page to bring it back."); }, 600); } }
    if (pkTab === "mine" && !(pkItems && pkItems.length) && TRACKS().length) paintPkList();
    DECKS.forEach((k) => {
      const el = $("#tm-" + k); if (el && decks[k]) { const dd = decks[k], mirror = !boothLead && S[k].playing, cur = mirror ? posOf(k) : dd.el.currentTime, dur = dd.el.duration || S[k].dur || 0; el.textContent = fmt(cur) + (dur ? " / " + fmt(dur) + " · −" + fmt(Math.max(0, dur - cur)) : ""); const dkEl = document.querySelector('.deck[data-deck="' + k + '"]'); if (dkEl) dkEl.classList.toggle("playing", !!S[k].playing); }
      // watchdog: an element that reached the end without firing 'ended' still hands over
      if (OWNER() && leadDrive() && S.live && S.autodj && S[k].playing && decks[k] && decks[k].el.ended) deckEnded(k);
      // wall-clock backstop (owner, 2026-10-27: "the turntables dont stop at the
      // end of their song"): a deck whose clock has run past the end of its song
      // and whose player has stopped — or which is a video deck, whose shim has
      // no "ended" property for the check above — still stops here, Auto-DJ or
      // not. deckEnded itself decides: with Auto-DJ or a queue it rolls on,
      // otherwise the deck just stops, like a real turntable at the runout.
      if (OWNER() && leadDrive() && S.live && S[k].playing && decks[k] && !decks[k].loop && !decks[k].roll) { const durT = (decks[k].el && decks[k].el.duration) || +S[k].dur || 0; const elD = decks[k].el; /* a video deck must be done on its OWN clock too: the wall clock runs ahead of its player by the load delay, so firing on the wall clock alone cut video decks that were still playing their final seconds */ const elDone = decks[k].shim ? (elD.paused && durT > 0 && (elD.currentTime || 0) >= durT - 0.5) : (elD.ended || elD.paused); if (durT > 0 && posOf(k) > durT + 2 && elDone) deckEnded(k); }
      // HARD-END WATCHDOG (mwHardEnd, 2026-10-28 station-down fix): element-state
      // independent. Every check above trusts the player — a YouTube shim in a
      // throttled tab can keep reporting "playing" forever after its video has
      // actually ended, which left the station silent 26 minutes past the end of
      // a song: the booth thought the deck was still playing and no code path
      // would ever end it. If the shared wall clock is 15s past a known duration
      // the song IS over — end the deck through deckEnded (rolls Auto-DJ/queue,
      // otherwise parks it) whatever the player claims. Fires once: deckEnded
      // clears the playing flag, so the tick cannot re-trigger it.
      if (OWNER() && leadDrive() && S.live && S[k].playing && decks[k] && !decks[k].loop && !decks[k].roll) { const durH = +S[k].dur || (decks[k].el && decks[k].el.duration) || 0; if (durH > 0 && posOf(k) > durH + 15) deckEnded(k); }
      // Stall watchdog (owner, 2026-10-28: if the music stops for any
      // reason it cuts back on by itself): on the DRIVING booth, a deck the
      // station says is playing whose own player has sat paused — or
      // frozen at one spot with nothing buffered — for over 5 seconds is
      // not a pause Malik made (his pauses clear the playing flag, and a
      // full stop stamps S.pausedAt). Nudge it back into play once; still
      // stuck 5 seconds later, hand the song over through deckEnded so
      // Auto-DJ or the queue rolls the next one. Visible tab only: a
      // hidden tab's frozen player is the browser's doing, and the keeper
      // covers the station meanwhile. An active grain scratch on the deck
      // is a hand on the record, never a stall.
      if (OWNER() && leadDrive() && S.live && S[k].playing && decks[k] && decks[k].el && !decks[k].loop && !decks[k].roll && !S.pausedAt && !document.hidden && !(grainSess && grainSess.k === k)) {
        const dd = decks[k], ct = dd.el.currentTime || 0;
        const frozen = !dd.el.paused && dd.el.readyState < 3 && Math.abs(ct - (dd._stallCt ?? ct)) < 0.05;
        const stalled = (dd.el.paused && !dd.el.ended) || frozen;
        if (!stalled) { dd._stallAt = 0; dd._stallTried = false; dd._stallCt = ct; }
        else if (!dd._stallAt) { dd._stallAt = Date.now(); dd._stallCt = ct; dd._stallTried = false; }
        else if (Date.now() - dd._stallAt > 5000) {
          if (!dd._stallTried) { dd._stallTried = true; dd._stallAt = Date.now(); dd._stallCt = ct; try { const pp = dd.el.play(); if (pp && pp.catch) pp.catch(() => {}); } catch (_) {} }
          else { dd._stallAt = 0; dd._stallTried = false; deckEnded(k); }
        }
      }
      // AGGRESSIVE STALL WATCHDOG (mwStallWatchdog, see the note above the
      // tick): position-based, so a video deck whose player reports itself
      // playing while its clock is frozen is still caught.
      {
        const wd = wdPos[k] || (wdPos[k] = { key: "", pos: 0, adv: 0, act: 0, step: 0, reloads: 0 });
        if (!S[k].playing || S.pausedAt) { wd.key = ""; wd.step = 0; wd.reloads = 0; wd.adv = 0; wd.act = 0; }
        else if (OWNER() && leadDrive() && S.live && decks[k] && decks[k].el && !decks[k].loop && !decks[k].roll && !S[k].loop) {
          const key = wdKeyOf(k), ddw = decks[k];
          if (wd.key !== key) { wd.key = key; wd.pos = ddw.el.currentTime || 0; wd.adv = Date.now(); wd.act = 0; wd.step = 0; wd.reloads = 0; }
          else {
            const pos = ddw.el.currentTime || 0, nowW = Date.now(), durW = +S[k].dur || ddw.el.duration || 0;
            if (Math.abs(pos - wd.pos) >= 0.25) { wd.pos = pos; wd.adv = nowW; wd.step = 0; }
            else if (!(grainSess && grainSess.k === k) && !ddw.el.seeking && !(ddw.noSync && nowW < ddw.noSync) && !(durW > 0 && pos >= durW - 0.75) && !ddw.el.ended && nowW - wd.adv >= 5000 && nowW - wd.act >= 5000) {
              wd.act = nowW; wd.adv = nowW;
              if (wd.step === 0 && wd.reloads >= 1) { console.log("[watchdog] deck " + k + " stalled again at " + pos.toFixed(1) + "s after a reload this play - handing over, no second reload"); wd.key = ""; wd.step = 0; wd.reloads = 0; brainStall(k); brainWdHand(k); deckEnded(k); }
              else if (wd.step === 0) { wd.step = 1; console.log("[watchdog] deck " + k + " stalled at " + pos.toFixed(1) + "s - rung 1: play again"); wdKick(k); brainStall(k); }
              else if (wd.step === 1 && wd.reloads < 1) { wd.step = 2; wd.reloads++; console.log("[watchdog] deck " + k + " still stalled at " + pos.toFixed(1) + "s - rung 2: reload track at position"); wdReload(k, pos); brainStall(k); }
              else { console.log("[watchdog] deck " + k + " still stalled at " + pos.toFixed(1) + "s - rung 3: hand over"); wd.key = ""; wd.step = 0; wd.reloads = 0; brainStall(k); brainWdHand(k); deckEnded(k); }
            }
          }
        }
      }
      // Preload (owner, 2026-10-28: transitions took too long because the
      // next song only started LOADING at the 5-second mark): once the
      // playing deck is inside its last 15 seconds, pick the next item and
      // load it onto the pair deck — file decks buffer, video decks mount
      // their player (setYt only presses play when the deck is flagged
      // playing, so a preload mount sits cued and silent) — and the
      // handover at 5 seconds becomes just play + fade.
      if (OWNER() && leadDrive() && S.live && (S.autodj || queue.length) && S[k].playing && decks[k] && !decks[k].loop && !S[PAIR[k]].playing && !(handoverBusy && Date.now() - handoverAt < 20000) && !(preLoad && preLoad.forStart === S[k].start) && (SANDBOX || !qStockValid(ROT[k]))) { const elP = decks[k].el, remP = elP && elP.duration && isFinite(elP.duration) ? elP.duration - elP.currentTime : 99; if (remP > 5 && remP <= 15) { const tgtP = PAIR[k]; preLoad = { target: tgtP, forStart: S[k].start, item: null }; pickNextItem().then(async (it) => { if (!it || !preLoad || preLoad.forStart !== S[k].start || preLoad.target !== tgtP) return; preLoad.item = it; saveQueue(); paintQueue(); try { await load(tgtP, it); if (it.yt) { const dp = decks[tgtP]; if (dp) { await dp.setYt(it.yt); if (!S[tgtP].playing && dp.el) { try { dp.el.pause(); } catch (_) {} } } } } catch (_) {} }).catch(() => {}); } }
      // seamless handover (owner, 2026-10-26): the only deck on air is about to
      // run out — start its pair partner NOW and crossfade into it, no hole
      if (OWNER() && leadDrive() && S.live && (S.autodj || queue.length) && S[k].playing && decks[k] && !decks[k].loop && !(handoverBusy && Date.now() - handoverAt < 20000) && DECKS.every((x) => x === k || !S[x].playing)) { const el2 = decks[k].el, rem = el2.duration && isFinite(el2.duration) ? el2.duration - el2.currentTime : 99; if (rem > 0.3 && rem <= 5) autoNext(k, true, Math.max(1200, rem * 1000)); /* blend lead 5s (owner, 2026-10-28): the next song is audibly IN before this one ends — never a pause between songs */ }
      const d = decks[k]; if (d && d.loop && !d.el.paused && d.el.currentTime >= d.loop[1]) { try { d.el.currentTime = d.loop[0]; } catch (_) {} if (OWNER() && S[k].playing) { S[k].start = Date.now() - d.loop[0] * 1000; } }
      if (OWNER() && decks[k] && S[k].playing) peaks(k);
    });
    document.querySelectorAll("[data-swap]").forEach((b) => { const v = b.dataset.swap.split(":")[1]; b.classList.toggle("hot", !!S[v] && !!S[v].playing); });
    // Dead-air backstop (2026-10-28): Auto-DJ on, station live, nothing
    // playing, no deliberate pause — that state may not persist. Five
    // seconds of it and the booth advances on its own, retrying every
    // few seconds (a stale handover latch is forced open at 6s, not 20s)
    // until something is actually playing. This is the booth-side rescue
    // that does not depend on the keeper: the keeper's own rescue is a
    // doc write that a live booth's next heartbeat can overwrite.
    if (OWNER() && leadDrive() && !serverMirror() && S.live && (S.autodj || queue.length) && !S.pausedAt && !DECKS.some((x) => S[x].playing)) {
      if (!deadAirAt) deadAirAt = Date.now();
      if (Date.now() - deadAirAt > 5000) { if (handoverBusy && Date.now() - handoverAt >= 6000) handoverBusy = false; if (!handoverBusy) autoNext(lastEndedK, true); }
    } else deadAirAt = 0;
    xfFollowGuard();
    if (listening) DECKS.forEach((k) => follow(k));
    // the booth's master screen re-renders on the same heartbeat the listeners
    // get — slots start at opacity 0 and only a render pass raises them, so a
    // booth that only re-rendered on control touches could play a video on a
    // deck (chip naming it) while the big screen stayed dark (owner report
    // 2026-10-26: deck C playing, master screen black)
    if (OWNER() && boothLead) stageApply(1, 1);
    // station clock + show timer
    const ck = $("#dj-clock"); if (ck && OWNER()) ck.textContent = new Date().toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", second: "2-digit", timeZone: "America/New_York" }) + " ET";
    const st = $("#dj-showtime"); if (st && OWNER()) st.textContent = S.live && S.liveSince ? "⏱ On air " + fmt((Date.now() - S.liveSince) / 1000) : "";
    // live mic meter + auto-duck level
    if (micAn && micStreamLive) { const a = new Uint8Array(micAn.fftSize); micAn.getByteTimeDomainData(a); let m = 0; for (let i = 0; i < a.length; i++) m = Math.max(m, Math.abs(a[i] - 128) / 128); micHot = $("#mic-duck")?.checked ? m : 0; const bar = $("#mic-lvl"); if (bar) bar.style.width = Math.min(100, m * 160) + "%"; if (OWNER()) levels(); }
  }, 500);

  /* ---------- DEAD-AIR RESCUE (mwDeadAirRescue) begin ----------
   * The booth-side rescue for the hole the 2026-10-30 01:00 sampling
   * caught live: a FRESH lead booth, station live, Auto-DJ on, queue
   * stocked - and every deck idle for over two minutes while listeners
   * heard nothing. The server keeper never rescues while a booth is
   * open (it stands down for a fresh booth heartbeat), and the older
   * 2026-10-28 dead-air backstop inside the big 500ms tick shares that
   * tick with every other booth job, treats ANY S.pausedAt stamp as a
   * forever pause, and retries its advance unboundedly. This rescue is
   * a sibling, not a replacement: its own 1s interval, its own memory-
   * only state, wrapped so nothing it does can throw into the booth.
   * It runs on the LEAD booth only - leadDrive(), the same gate as
   * the stall watchdog - never on a mirror, and never in the
   * ?playdj=1 sandbox (leadDrive() returns true there, so the sandbox
   * is gated out explicitly, first). It also never runs while the
   * master screen is carrying a share: during a screen share the
   * tables are paused BY DESIGN (the share has taken over the radio),
   * so that silence is the show, not dead air.
   * DEAD AIR, here, means all of: station live, Auto-DJ on, no deck
   * playing (the booth's own playing flags, or a local player actually
   * rolling - never a bare snapshot position), no load in flight (an
   * advance holding the handover latch, or deck content that changed
   * seconds ago and may still be building its player), and no
   * deliberate pause - S.pausedAt counts as deliberate only inside
   * the same 30 minutes the station keeper allows it (station.js:
   * a stamp younger than 30 * 60e3 is his choice; an older stamp is
   * stale and no longer holds the station silent). When that silence
   * has held continuously for ~10s the rescue restarts the music
   * through the NORMAL advance - the same autoNext(lastEndedK, true)
   * a deck end calls, so queue and stock items come first exactly
   * like an ordinary roll. It never presses play on a hand load: a
   * pick he loaded stopped stays stopped (a fresh load restarts the
   * hold and the episode instead of being fired over).
   * EPISODES: one attempt, then a 30s backoff, at most 3 attempts per
   * episode - a genuinely broken deck cannot be hammered. Anything
   * playing, a fresh deliberate pause, a fresh load, or a gate
   * closing (live off, Auto-DJ off, lead lost) ends the episode and
   * resets the count. Side effects of the rescue's own attempt (the
   * advance loading its pick) are absorbed for 20s so the attempt is
   * judged by whether music resulted, not by its own loading noise. */
  const daR = { since: 0, tries: 0, lastTry: 0, sig: null, loadAt: 0, absorbUntil: 0 };
  const daSig = () => DECKS.map((k) => { const s = S[k] || {}; return (s.yt || "") + "|" + (s.src || "") + "|" + (s.title || ""); }).join("~");
  const daReset = () => { daR.since = 0; daR.tries = 0; daR.lastTry = 0; daR.absorbUntil = 0; };
  function daRescueTick(now) {
    now = now || Date.now();
    try {
      if (SANDBOX) return;
      if (!OWNER() || !leadDrive() || serverMirror()) { daReset(); return; }
      if (!S.live || !S.autodj) { daReset(); return; }
      if (S.vstream && S.vstream.on) { daReset(); daR.sig = daSig(); return; } // a live share has taken over the radio - the tables are paused for it by design
      const sounding = DECKS.some((k) => { const s = S[k]; if (s && s.playing) return true; const d = decks[k]; return !!(d && d.el && !d.el.paused && !d.el.ended); });
      if (sounding) { daReset(); daR.sig = daSig(); return; }
      if (S.pausedAt && now - S.pausedAt < 30 * 60e3) { daReset(); daR.sig = daSig(); return; }
      const sig = daSig();
      if (daR.sig === null) daR.sig = sig;
      else if (sig !== daR.sig) {
        daR.sig = sig; daR.loadAt = now;
        if (now >= daR.absorbUntil) { daR.since = now; daR.tries = 0; daR.lastTry = 0; return; }
      }
      if (handoverBusy && now - handoverAt < 20000) return; // an advance is already in flight - never stack a second one on it
      if (!daR.since) { daR.since = now; return; }
      if (now - daR.since < 10000) return; // the silence must hold ~10s - a breath between songs is not dead air
      if (now - daR.loadAt < 12000) return; // a load landed seconds ago and may still be building its player - not dead air either
      if (daR.tries >= 3) return; // episode cap: three honest tries, then stand down until the world changes
      if (daR.lastTry && now - daR.lastTry < 30000) return; // backoff between tries
      daR.tries++; daR.lastTry = now; daR.absorbUntil = now + 20000;
      console.log("[dead-air] lead booth silent " + Math.round((now - daR.since) / 1000) + "s with Auto-DJ on - rescue attempt " + daR.tries + " of 3 via the normal advance");
      try { say("🛟 Dead air — Auto-DJ is restarting the music."); } catch (_) {}
      try { const p = autoNext(lastEndedK, true); if (p && p.catch) p.catch(() => {}); } catch (_) {}
    } catch (_) {}
  }
  setInterval(() => daRescueTick(Date.now()), 1000);
  /* DEAD-AIR RESCUE (mwDeadAirRescue) end */

  /* ---------- listeners ---------- */
  function isLive() { return S.live && Date.now() - (S.updatedAt || 0) < 3 * 60e3; }
  // booth heartbeat: while the booth is on screen (or a set is live) the booth owns the
  // tables and the 24/7 keeper stands down; close the booth and the keeper takes over
  setInterval(() => { if (OWNER() && boothLead && (S.live || document.getElementById("dj-owner")?.offsetParent)) save(true); }, 10000);
  // the keeper ping: keeps the rotation advancing around the clock, booth open or not
  // presence: every client carries a random per-tab id and reports whether it is
  // listening to the decks; the keeper answers with the live counts, painted into
  // the header chip, the booth top bar and the station card
  let myCid = ""; try { myCid = sessionStorage.getItem("mw-cid") || ""; if (!myCid) { myCid = rid(); sessionStorage.setItem("mw-cid", myCid); } } catch (_) { myCid = rid(); }
  let onlineN = 0;
  /* ---------- HOST MODE: the door (owner, 2026-10-29) ----------
   * While his booth is open, Malik hosts a live room: this feed names
   * everyone who walks in while he is hosting. The source is the presence
   * the keeper ping already paints below — signed-in members arrive as
   * MW_ONLINE_USERS entries (uid + the name their own ping reported), and
   * guests arrive as MW_GUESTS count deltas (the keeper deliberately
   * stores no guest identities, so a guest is a count going up by one).
   * While the booth is closed the same paints quietly absorb the room, so
   * opening the booth never dumps everyone who was already here — only
   * arrivals from that moment on are announced. The seen-set persists in
   * sessionStorage, so a booth refresh does not re-alert the room either;
   * the very first paint of a tab seeds it silently for the same reason. */
  const doorRows = []; let doorSeen = new Set(), doorGuestBase = -1, doorPrimed = false, doorSig = "", shoutCoolUntil = 0;
  try { const d0 = JSON.parse(sessionStorage.getItem("mw-door-seen") || "null"); if (d0 && Array.isArray(d0.u)) { doorSeen = new Set(d0.u.filter((x) => typeof x === "string")); doorGuestBase = Math.max(0, +d0.g || 0); } } catch (_) {}
  const doorPersist = () => { try { sessionStorage.setItem("mw-door-seen", JSON.stringify({ u: [...doorSeen].slice(-80), g: Math.max(0, doorGuestBase) })); } catch (_) {} };
  const doorOpen = () => { if (!OWNER() || SANDBOX) return false; const oe = document.getElementById("dj-owner"); return !!(oe && oe.offsetParent !== null); };
  const doorRel = (at) => { const s = Math.max(0, Math.round((Date.now() - at) / 1000)); if (s < 8) return "just now"; if (s < 60) return s + "s ago"; const m = Math.round(s / 60); if (m < 60) return m + "m ago"; return Math.round(m / 60) + "h ago"; };
  /* how long a present visitor has been on, from the keeper first-seen stamp
     (users[].since / guestSince in the /api/station answer), read against the
     server clock via clockOff so a wrong device clock cannot bend it */
  const doorDur = (since) => { if (!since) return ""; const s = Math.max(0, Math.round(((Date.now() + clockOff) - since) / 1000)); if (s < 60) return "under a minute"; const m = Math.floor(s / 60); if (m < 60) return m + "m"; return Math.floor(m / 60) + "h " + String(m % 60).padStart(2, "0") + "m"; };
  let doorHereHTML = "";
  function doorBlip() { try { const c = new (window.AudioContext || window.webkitAudioContext)(); const o = c.createOscillator(), g = c.createGain(); o.type = "sine"; o.frequency.setValueAtTime(880, c.currentTime); o.frequency.setValueAtTime(1320, c.currentTime + 0.12); g.gain.setValueAtTime(0.0001, c.currentTime); g.gain.exponentialRampToValueAtTime(0.15, c.currentTime + 0.02); g.gain.exponentialRampToValueAtTime(0.0001, c.currentTime + 0.5); o.connect(g).connect(c.destination); o.start(); o.stop(c.currentTime + 0.55); setTimeout(() => c.close(), 800); } catch (_) {} }
  function doorPaint() {
    const box = document.getElementById("door-list"); if (!box) return;
    const cool = Date.now() < shoutCoolUntil;
    const sig = doorRows.map((r) => r.key + (r.greeted ? "g" : "") + (r.shouted ? "s" : "") + doorRel(r.at) + (r.since ? doorDur(r.since) : "")).join(",") + "|" + (cool ? "c" : "") + "|" + doorHereHTML;
    if (sig === doorSig) return; doorSig = sig;
    box.innerHTML = doorRows.length ? doorRows.map((r) => `<div class="door-row${r.fresh ? " new" : ""}"><span>🔔 <b>${E(r.name)}</b> <small>came in · ${doorRel(r.at)}${r.since ? " · on the site " + doorDur(r.since) : ""}</small></span><span class="door-acts"><button class="btn sm" type="button" data-door-greet="${r.key}"${r.greeted ? " disabled" : ""}>${r.greeted ? "👋 Greeted" : "👋 Greet"}</button><button class="btn ghost sm" type="button" data-door-shout="${r.key}"${cool || r.shouted ? " disabled" : ""}>🎙 Shout</button></span></div>`).join("") : '<small class="muted">Watching the door — people who come on the site while your booth is open land here.</small>';
    if (doorHereHTML) box.innerHTML += doorHereHTML;
    doorRows.forEach((r) => { r.fresh = false; });
  }
  function doorAdd(row) { doorRows.unshift(row); while (doorRows.length > 12) doorRows.pop(); doorPaint(); doorBlip(); }
  function doorPing(users) {
    const list = Array.isArray(users) ? users : [];
    const guests = (typeof window.MW_GUESTS === "number" && isFinite(window.MW_GUESTS)) ? window.MW_GUESTS : 0;
    const nowIds = new Set(list.map((u) => u && u.uid).filter(Boolean));
    const myUid = (window.MW && MW.session && MW.session() && MW.session().user && MW.session().user.id) || "";
    { const gs2 = (typeof window.MW_GUEST_SINCE === "number" && window.MW_GUEST_SINCE) || 0;
      const rowsH = list.filter((u) => u && u.uid && u.uid !== myUid).map((u) => { const nm = String(u.name || (typeof members !== "undefined" && members && members[u.uid] && members[u.uid].handle) || "A member").slice(0, 40); return `<div class="door-row here"><span>🟢 <b>${E(nm)}</b> <small>${u.since ? "on the site " + doorDur(u.since) : "on the site now"}</small></span></div>`; });
      if (guests > 0) rowsH.push(`<div class="door-row here"><span>🟢 <b>${guests} guest${guests > 1 ? "s" : ""}</b> <small>${gs2 ? "longest here " + doorDur(gs2) : "on the site now"}</small></span></div>`);
      doorHereHTML = rowsH.join(""); }
    if (!doorPrimed) { doorPrimed = true; nowIds.forEach((id) => doorSeen.add(id)); if (doorGuestBase < 0) doorGuestBase = guests; doorPersist(); return; }
    if (!doorOpen()) { // booth closed or stale: absorb the room quietly — nobody is announced for a room he is not hosting
      nowIds.forEach((id) => doorSeen.add(id)); [...doorSeen].forEach((id) => { if (!nowIds.has(id)) doorSeen.delete(id); }); doorGuestBase = guests; doorPersist(); return;
    }
    list.forEach((u) => { if (!u || !u.uid || u.uid === myUid || doorSeen.has(u.uid)) return; doorSeen.add(u.uid); const nm = String(u.name || (typeof members !== "undefined" && members && members[u.uid] && members[u.uid].handle) || "A member").slice(0, 40); doorAdd({ key: rid(), uid: u.uid, name: nm, call: nm, at: Date.now(), since: u.since || 0, greeted: false, shouted: false, fresh: true }); });
    [...doorSeen].forEach((id) => { if (!nowIds.has(id)) doorSeen.delete(id); }); // left: if they walk in again, the door announces them again
    if (doorGuestBase >= 0 && guests > doorGuestBase) { for (let i = 0; i < guests - doorGuestBase; i++) doorAdd({ key: rid(), uid: null, name: "A guest", call: "friend", at: Date.now(), greeted: false, shouted: false, fresh: true }); }
    doorGuestBase = guests; doorPersist(); doorPaint();
  }
  /* ---------- Arrival alerts on every owner screen ----------
   * The Door above only announces while the booth is open on THIS tab.
   * Owner rule (2026-10-29): every screen he is signed in on gets a compact
   * arrival notice — member by name, guests as a count — off the same 12s
   * keeper paint, dismissible, never more than the latest two stacked.
   * Its own seen-set, primed silently on the tab's first paint like the
   * Door (and persisted in sessionStorage), so a fresh tab or a refresh
   * never replays the room; someone who leaves and returns counts as new.
   * While the booth IS open here the Door is the notice, so this stays
   * quiet but keeps its set in sync — closing the booth dumps nobody old.
   * Non-owners and the sandbox never see it; he is never told about himself. */
  let arrSeen = new Set(), arrGuests = -1, arrPrimed = false;
  try { const a0 = JSON.parse(sessionStorage.getItem("mw-arrive-seen") || "null"); if (a0 && Array.isArray(a0.u)) { arrSeen = new Set(a0.u.filter((x) => typeof x === "string")); arrGuests = Math.max(0, +a0.g || 0); } } catch (_) {}
  const arrPersist = () => { try { sessionStorage.setItem("mw-arrive-seen", JSON.stringify({ u: [...arrSeen].slice(-80), g: Math.max(0, arrGuests) })); } catch (_) {} };
  function arrNotice(html) {
    let box = document.getElementById("mw-arrive");
    if (!box) { box = document.createElement("div"); box.id = "mw-arrive"; box.style.cssText = "position:fixed;left:12px;bottom:calc(var(--tabbar,0px) + 84px);z-index:9500;display:flex;flex-direction:column;gap:8px;max-width:min(320px,86vw)"; document.body.appendChild(box); }
    const el = document.createElement("div");
    el.style.cssText = "background:#171307;border:1px solid #8a6a2a;color:#f5e7bd;border-radius:12px;padding:10px 34px 10px 12px;font:600 13.5px/1.35 system-ui,sans-serif;box-shadow:0 10px 30px rgba(0,0,0,.5);position:relative";
    el.innerHTML = html + "<button type='button' aria-label='Dismiss' style='position:absolute;right:4px;top:2px;background:none;border:0;color:#c9a44a;font-size:18px;cursor:pointer'>×</button>";
    el.querySelector("button").onclick = () => el.remove();
    box.appendChild(el);
    while (box.children.length > 2) box.firstChild.remove();
    setTimeout(() => { try { el.remove(); } catch (_) {} }, 9000);
  }
  function arriveWatch(users) {
    if (!OWNER() || SANDBOX) return;
    const list = Array.isArray(users) ? users : [];
    const guests = (typeof window.MW_GUESTS === "number" && isFinite(window.MW_GUESTS)) ? window.MW_GUESTS : 0;
    const nowIds = new Set(list.map((u) => u && u.uid).filter(Boolean));
    if (!arrPrimed) { arrPrimed = true; nowIds.forEach((id) => arrSeen.add(id)); arrGuests = guests; arrPersist(); return; }
    const myUid = (window.MW && MW.session && MW.session() && MW.session().user && MW.session().user.id) || "";
    const quiet = doorOpen();
    list.forEach((u) => { if (!u || !u.uid || u.uid === myUid || arrSeen.has(u.uid)) return; arrSeen.add(u.uid); if (!quiet) { const nm = String(u.name || (typeof members !== "undefined" && members && members[u.uid] && members[u.uid].handle) || "A member").slice(0, 40); arrNotice("👋 <b>" + E(nm) + "</b> is on the site now"); } });
    [...arrSeen].forEach((id) => { if (!nowIds.has(id)) arrSeen.delete(id); });
    if (arrGuests >= 0 && guests > arrGuests && !quiet) arrNotice(guests - arrGuests === 1 ? "👋 A guest just came in" : "👋 " + (guests - arrGuests) + " guests just came in");
    arrGuests = guests; arrPersist();
  }
  /* ---------- The Doorbell: instant push to the owner's phone ----------
   * One tap, by design (owner, 2026-10-29): permission, then the browser's
   * Web Push subscription is stored server-side by /api/push/subscribe —
   * which accepts the owner's session only — and the station keeper rings
   * it the moment a new arrival pings in. The VAPID public key below is
   * the same one the message notifications use (js/push.js): one keypair
   * serves the whole site, because a browser registration holds a single
   * push subscription and a second keypair would fight the first over it.
   * If this browser already holds a subscription (say from message
   * notifications), it is reused as-is and simply also stored in the
   * doorbell book. Turning off deletes only the doorbell copy; the browser
   * subscription itself, and message notifications riding it, stay exactly
   * as they were. The on/off paint comes from the server's subscription
   * count (bellSync), never from a device-local guess. */
  const BELL_KEY = "BPnls3Sbq3c1oSaHwXsjglIB9kGQiaGu19QySLHMrqX0kpjEAbUd7OZYhi9ZYM8WwOCrOczZ3f1jn4GMUNmFQCQ";
  const bellTok = () => { const s = (window.MW && MW.session && MW.session()) || null; return (s && s.access_token) || ""; };
  const bellKeyBytes = () => { const s = BELL_KEY.replace(/-/g, "+").replace(/_/g, "/"), p = "=".repeat((4 - (s.length % 4)) % 4); return Uint8Array.from(atob(s + p), (c) => c.charCodeAt(0)); };
  let bellOn = false, bellBusy = false;
  function bellPaint() {
    const b = document.getElementById("door-bell"), st = document.getElementById("door-bell-state");
    if (b) { b.textContent = bellBusy ? "🔔 Working…" : bellOn ? "🔕 Turn off" : "🔔 Turn on"; b.disabled = bellBusy; }
    if (st && !bellBusy) st.textContent = bellOn ? "ON — your phone rings the second someone lands" : "a push to your phone the second someone lands";
  }
  async function bellSync() {
    if (!OWNER() || SANDBOX) return;
    try { const r = await fetch("/api/push/subscribe", { headers: { authorization: "Bearer " + bellTok() }, cache: "no-store" }); const j = await r.json(); if (j && j.ok) { bellOn = (j.subs || 0) > 0; bellPaint(); } } catch (_) {}
  }
  async function bellToggle() {
    if (bellBusy || !OWNER() || SANDBOX) return;
    const tok = bellTok(); if (!tok) { say("Sign in as Meechie first."); return; }
    bellBusy = true; bellPaint();
    try {
      if (bellOn) {
        const reg = await navigator.serviceWorker.register("/sw.js").catch(() => null);
        const sub = reg && (await reg.pushManager.getSubscription().catch(() => null));
        if (sub) await fetch("/api/push/subscribe", { method: "DELETE", headers: { "content-type": "application/json", authorization: "Bearer " + tok }, body: JSON.stringify({ endpoint: sub.endpoint }) });
        bellOn = false; say("🔕 Doorbell off — your phone will not ring for arrivals.");
      } else {
        if (!("serviceWorker" in navigator) || !("PushManager" in window) || !("Notification" in window)) { say("This browser can't do push notifications."); bellBusy = false; bellPaint(); return; }
        if (/iPhone|iPad|iPod/.test(navigator.userAgent) && !matchMedia("(display-mode: standalone)").matches && !navigator.standalone) { say("On iPhone: tap Share, Add to Home Screen, open Meechie's World from there, then tap Turn on."); bellBusy = false; bellPaint(); return; }
        const perm = await Notification.requestPermission();
        if (perm !== "granted") { say("Notifications are blocked — allow them in your browser settings."); bellBusy = false; bellPaint(); return; }
        const reg = await navigator.serviceWorker.register("/sw.js"); await navigator.serviceWorker.ready;
        let sub = await reg.pushManager.getSubscription();
        if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: bellKeyBytes() });
        const r = await fetch("/api/push/subscribe", { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer " + tok }, body: JSON.stringify({ subscription: sub.toJSON() }) });
        const j = await r.json().catch(() => null);
        if (!r.ok || !j || !j.ok) throw new Error((j && j.error) || ("HTTP " + r.status));
        bellOn = true; say("🔔 Doorbell on — your phone rings the second someone lands.");
      }
    } catch (e) { say("Doorbell did not switch: " + (e.message || e)); }
    bellBusy = false; bellPaint();
  }
  { const bb = document.getElementById("door-bell"); if (bb && !bb._bellW) { bb._bellW = 1; bb.addEventListener("click", bellToggle); bellPaint(); bellSync(); } }
  async function doorGreet(row) {
    if (!row || row.greeted) return; row.greeted = true; doorPaint();
    const d = DB(); if (!d) { row.greeted = false; doorPaint(); say("That greeting could not send — no connection."); return; }
    // owner-gated by the doc rules themselves: the greet carries from:"host",
    // and the server only lets a post carry a from that is the writer — so no
    // member can forge one, and only the admin write lands as the host.
    try { await d.doc("greets/" + (row.uid || ("g" + row.key))).set({ to: row.uid || "guest", name: row.name, text: "Welcome in, " + row.call + " — request a song at the station 🎧", at: Date.now(), from: "host" }); say("👋 You greeted " + row.name + " — it lands on their screen."); }
    catch (_) { row.greeted = false; doorPaint(); say("That greeting did not go through — try again."); }
  }
  function doorShout(row) {
    if (!row || Date.now() < shoutCoolUntil) return;
    shoutCoolUntil = Date.now() + 20000; row.shouted = true;
    // the one and only voice-drop channel: S.voice as text, the same shape
    // the automated station drops use — every listening client speaks it
    // through playVoice/dropSpeak, booth included. No parallel TTS path.
    S.voice = { id: "shout-" + Date.now(), text: "Welcome in, " + row.call + ", to Meechie's World!", at: Date.now() };
    save(true); doorPaint(); say("🎙 You shouted out " + row.name + " over the station.");
    setTimeout(() => doorPaint(), 20100);
  }
  { const dl = document.getElementById("door-list"); if (dl && !dl._doorW) { dl._doorW = 1; dl.addEventListener("click", (e) => { const g = e.target.closest("[data-door-greet]"), s2 = e.target.closest("[data-door-shout]"); const k = g ? g.dataset.doorGreet : s2 ? s2.dataset.doorShout : ""; if (!k) return; const row = doorRows.find((r) => r.key === k); if (!row) return; if (g) doorGreet(row); else doorShout(row); }); } }
  function paintOnline(o, l, users, gs) {
    // ONE presence list for the whole site: when the keeper answers with the
    // signed-in members who are on right now, that list is the count everywhere
    // (header chip, booth, station card AND the Book strip via MW_ONLINE), so
    // the numbers can never disagree again
    onlineN = o || 0;
    let n = o;
    if (Array.isArray(users)) {
      n = users.length;
      window.MW_ONLINE = new Set(users.map((x) => x.uid).filter(Boolean));
      window.MW_ONLINE_USERS = users; window.MW_PING_AT = Date.now();
      window.MW_GUESTS = Math.max(0, (o || 0) - n); window.MW_GUEST_SINCE = gs || 0;
    }
    window.MW_ONLINE_N = n; window.MW_LISTENING_N = l;
    const chip = document.getElementById("online-chip");
    if (chip) { chip.hidden = false; const nb = document.getElementById("online-n"); if (nb) nb.textContent = n; if (!chip._clk) { chip._clk = 1; chip.style.cursor = "pointer"; chip.title = "See who's online"; chip.addEventListener("click", () => { if (window.MW_showOnline) window.MW_showOnline(); }); } }
    const b = document.getElementById("dj-online"); if (b) b.textContent = "👥 " + n + " online · 🎧 " + l + " on the decks";
    const o2 = document.getElementById("dj-online2"); if (o2) o2.textContent = "🟢 " + n + " online · 🎧 " + l;
    const s = document.getElementById("st-online"); if (s) s.textContent = l > 0 ? "🎧 " + l + " listening on the decks right now · " + n + " on the site" : n + " on the site right now";
    const li = document.getElementById("listeners"); if (li) li.textContent = l + " listening";
    try { doorPing(users); } catch (_) {} // HOST MODE: the same paint feeds the booth door
    try { arriveWatch(users); } catch (_) {} // and every owner screen gets the arrival notice
  }
  const pingKeeper = () => { let extra = ""; try { const su = window.MW && MW.session && MW.session() && MW.session().user; if (su && su.id) { const nm = (typeof members !== "undefined" && members && members[su.id] && members[su.id].handle) || su.name || ""; extra = "&u=" + encodeURIComponent(su.id) + (nm ? "&n=" + encodeURIComponent(String(nm).slice(0, 40)) : ""); } } catch (_) {}
    fetch("/api/station?cid=" + encodeURIComponent(myCid) + "&l=" + (listening && !OWNER() ? 1 : 0) + extra, { cache: "no-store" }).then((r) => r.json()).then((j) => { if (j && j.now) clockOff = clockOff * 0.7 + (j.now - Date.now()) * 0.3; if (j && j.online != null) paintOnline(j.online, j.listening || 0, j.users, j.guestSince || 0); }).catch(() => {}); };
  let clockOff = 0; // this device's clock error vs the server, learned from keeper pings — the sync math below trusts it over the local clock
  if (!SANDBOX) { pingKeeper(); setInterval(pingKeeper, 12000); }
  /* ---------- stale-tab guardian (mwGuardian, 2026-10-28) ----------
   * The flap war: a booth tab left open since morning kept running code from
   * before three emergency fixes and re-saved its dead state over every
   * rescue. From this build on, every client checks /version.json (served
   * no-store) once a minute for the current dj build. Three stamps carry
   * that one number and move together on every dj.js ship: the "dj" field
   * in version.json, MW_DJ_BUILD below, and dj.js ?v= in index.html.
   * A listener reloads once, right away. A booth is never yanked mid-set:
   * it shows a notice, reloads itself the moment every deck is stopped,
   * and in all cases within 10 minutes of the update first being seen.
   * A sessionStorage stamp per build makes a reload loop impossible. */
  const MW_DJ_BUILD = 1793369767;
  (() => {
    let updBuild = 0, updSince = 0, updTimer = null;
    const anyPlaying = () => { try { return DECKS.some((k) => S[k] && S[k].playing); } catch (_) { return false; } };
    const showUpdNote = (playing) => {
      let n = document.getElementById("dj-upd-note");
      if (!n) {
        n = document.createElement("div"); n.id = "dj-upd-note";
        n.style.cssText = "position:fixed;left:50%;bottom:calc(env(safe-area-inset-bottom,0px) + 78px);transform:translateX(-50%);z-index:10045;max-width:min(92vw,520px);background:#141109;border:1px solid #d4a843;color:#f3e5c0;font:600 13px system-ui,sans-serif;padding:10px 14px;border-radius:12px;box-shadow:0 10px 30px rgba(0,0,0,.55);text-align:center";
        n.innerHTML = "<span class='dj-upd-txt'></span> <button type='button' class='dj-upd-btn' style='margin-left:8px;background:#d4a843;color:#0b0a08;border:0;font:800 13px system-ui,sans-serif;padding:6px 12px;border-radius:999px;cursor:pointer'>Refresh now</button>";
        n.querySelector(".dj-upd-btn").addEventListener("click", () => { try { sessionStorage.setItem("mw-guard-" + updBuild, "1"); } catch (_) {} location.reload(); });
        document.body.appendChild(n);
      }
      const t = n.querySelector(".dj-upd-txt");
      if (t) t.textContent = playing ? "🔄 Booth update ready — this tab is running old DJ code. It refreshes itself when the music stops." : "🔄 Booth update ready — refreshing in a few seconds…";
    };
    const doReload = () => {
      try { if (sessionStorage.getItem("mw-guard-" + updBuild) === "1") return; sessionStorage.setItem("mw-guard-" + updBuild, "1"); } catch (_) {}
      location.reload();
    };
    const evaluate = () => {
      if (!updBuild) return;
      if (!OWNER()) { doReload(); return; }
      if (Date.now() - updSince > 10 * 60e3) { doReload(); return; }
      if (anyPlaying()) { showUpdNote(true); return; }
      showUpdNote(false);
      if (!updTimer) updTimer = setTimeout(() => { updTimer = null; if (!anyPlaying()) doReload(); else evaluate(); }, 5000);
    };
    const check = async () => {
      try {
        const j = await fetch("/version.json?t=" + Date.now(), { cache: "no-store" }).then((r) => r.json());
        const b = +(j && j.dj) || 0;
        if (b > MW_DJ_BUILD) { if (!updBuild) { updBuild = b; updSince = Date.now(); } evaluate(); }
      } catch (_) {}
    };
    setTimeout(check, 20000);
    setInterval(() => { check(); if (updBuild && OWNER()) evaluate(); }, 60000);
  })();

  /* one booth plays the sound; the other is its remote. The main tab and the pop-out
   * are two full booths sharing one station — without a leader they would each play
   * their own copy and overwrite each other's saves. A localStorage lease picks the
   * leader: the first booth window actually showing the decks holds it; a mirror's
   * buttons write the shared state and the leader plays them. Close the leader and
   * the mirror takes over within seconds. */
  let boothLead = false, driveWant = 0;
  const leaseKey = "mw-booth-lease";
  function leaseBeat() {
    if (SANDBOX) { boothLead = true; const b2 = document.getElementById("dj-lead"); if (b2) b2.textContent = guestLiveOn() ? "🔴 LIVE ON THE RADIO — your guest set is on air" : "🎛 Playground — just for fun, this copy never touches the radio"; const gl2 = document.querySelector("#dj-golive"); if (gl2 && gl2.closest(".dj-live")) gl2.closest(".dj-live").lastChild.textContent = guestLiveOn() ? " Guest set — LIVE on the radio" : " Practice set (never on air)"; return; }
    // The lease belongs to a WINDOW, not to whichever view is on screen. Once this
    // window holds the sound it keeps it — Malik can walk the whole site or switch
    // tabs and the tables keep broadcasting, because the tables ARE the live radio.
    // A window may only TAKE the lease when its booth is actually on screen and the
    // current holder is gone (stale) — that keeps the pop-out mirror honest.
    const el = document.getElementById("dj-owner");
    const boothShown = OWNER() && !!el?.offsetParent;
    let L = null; try { L = JSON.parse(localStorage.getItem(leaseKey) || "null"); } catch (_) {}
    const now = Date.now();
    const held = !!L && L.id === tabId && now - (L.at || 0) <= 7000;
    let mine = false;
    if (OWNER() && el && (held || boothShown)) { mine = held || !L || now - (L.at || 0) > 7000; if (mine) { try { localStorage.setItem(leaseKey, JSON.stringify({ id: tabId, at: now })); } catch (_) {} } }
    // one DRIVER across every device (owner, 2026-10-27: devices share the
    // set): the local lease settles windows on this machine; S.driveBy in the
    // shared state settles devices. A fresh driver heartbeat (12s) means
    // another device has the sound — this one mirrors and controls. The
    // driver re-stamps driveAt on every beat, so a closed or crashed driver
    // hands over within seconds, and the badge tap can pull the sound here
    // on purpose (driveWant).
    const drvFresh = now - (S.driveAt || 0) < 12000;
    const lead = mine && (S.driveBy === tabId || !drvFresh || now - (driveWant || 0) < 15000);
    if (lead) { S.driveBy = tabId; S.driveAt = now; }
    const was = boothLead; boothLead = lead;
    const badge = document.getElementById("dj-lead");
    if (badge && OWNER()) {
      // The server lead claim (leadTab) outranks the local sound lease for
      // STATE: while another screen holds a fresh claim this booth is a
      // state mirror — it renders everything and writes nothing but pad
      // hits. The local lease still settles which same-machine window
      // plays the sound.
      if (serverMirror()) badge.textContent = "🪞 MIRROR — another screen is driving · Tap TAKE CONTROL to drive from here";
      else if (leadFresh()) badge.textContent = "🎛 Driving: THIS SCREEN" + (boothLead ? " · 🔊 sound here" : " · 🔊 sound elsewhere — tap to play it here") + (onlineN > 1 ? " · 👥 " + onlineN + " on the site" : "");
      else badge.textContent = boothLead ? "🔊 This window is playing the sound" : "🪞 Mirror: the sound is on your other window or device. Tap here to play it here";
      badge.style.cursor = (serverMirror() || !boothLead) ? "pointer" : ""; badge.setAttribute("role", "button");
      if (!badge._take) { badge._take = 1; badge.addEventListener("click", () => { if (!OWNER()) return; if (serverMirror()) { takeControl(); return; } if (boothLead) return; driveWant = Date.now(); try { localStorage.setItem(leaseKey, JSON.stringify({ id: tabId, at: Date.now() })); } catch (_) {} leaseBeat(); actx(); say("🔊 The sound is in this window now."); }); }
    }
    if (boothLead && !was && OWNER()) DECKS.forEach((k) => { if (S[k] && S[k].playing) adoptDeck(k); });
    if (boothLead && !was && OWNER()) setTimeout(() => save(true), 400);
    if (!boothLead && was) DECKS.forEach((k) => { try { decks[k]?.stop(); } catch (_) {} });
  }
  /* TAKE CONTROL (2026-10-28): a mirror seizes the lead claim with one
   * takeover save — base is the updatedAt this tab last adopted, so the
   * server can tell a true handoff from a stale tab guessing — and it
   * pulls the sound lease here too, so state and sound land on the same
   * screen. The adopted state goes up unchanged: the song on air keeps
   * its shared start, and adoptDeck (fired by the lease gain) joins it
   * in position. Nothing restarts. */
  async function takeControl() {
    if (!serverMirror()) return;
    driveWant = Date.now();
    try { localStorage.setItem(leaseKey, JSON.stringify({ id: tabId, at: Date.now() })); } catch (_) {}
    leadTakeAt = Date.now();
    /* the server honors a takeover only when _lead.base equals the stored
     * rows updated_at column - an ISO string the snapshot feed never
     * carries (the old client sent the docs ms updatedAt, so a takeover
     * could NEVER match and the button silently did nothing). Fetch the
     * rows real updated_at through the same REST door the battles code
     * uses, then send the takeover save on top of it. */
    try { const r = await fetch("/api/cf/rest", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ table: "docs", op: "select", select: "path,updated_at", limit: 1, filters: [["path", "eq", "radio/dj"]] }) }); const j = await r.json(); const row = (j.data || [])[0]; if (row && row.updated_at) lastBaseAt = row.updated_at; } catch (_) {}
    save(true);
    leaseBeat();
    actx();
    say("🎛 Taking the wheel on this screen…");
  }
  leaseBeat(); setInterval(leaseBeat, 3000);
  document.addEventListener("visibilitychange", () => { if (!document.hidden) { leaseBeat(); if (boothLead && OWNER()) DECKS.forEach((k) => { if (S[k] && S[k].src) adoptDeck(k); }); } });
  addEventListener("pagehide", () => { if (boothLead) { try { const L = JSON.parse(localStorage.getItem(leaseKey) || "null"); if (L && L.id === tabId) localStorage.removeItem(leaseKey); } catch (_) {} } });
  setInterval(() => { if (!OWNER() && S.live) { const l = isLive(); $("#dj-banner").hidden = !l; if (!l && listening) endSet(); } paintStation(); }, 30000);
  /* Never-stop listening (owner, 2026-10-28): pressing Listen is remembered
     for 12 hours. Android may freeze a video player while the app is in the
     background, but the station itself keeps running on the server; when the
     listener comes back, the decks are re-followed at the live position
     instead of staying stopped. If Android killed the app outright, the
     first tap after reopening restarts the music — browsers require that
     one tap before any sound after a cold start. Pressing Stop clears the
     memory, so a deliberate stop always wins. */
  const DJ_KEEP_KEY = "mw-dj-keep";
  const djKeepSet = (on) => { try { if (on) localStorage.setItem(DJ_KEEP_KEY, String(Date.now())); else localStorage.removeItem(DJ_KEEP_KEY); } catch (_) {} };
  const djKeepWanted = () => { try { const t = +localStorage.getItem(DJ_KEEP_KEY) || 0; return !!t && Date.now() - t < 12 * 3600 * 1000; } catch (_) { return false; } };
  function resumeDjAudio() {
    if (!listening) return;
    actx(); wakeForListening(true);
    DECKS.forEach((k) => { if (S[k] && (S[k].playing || S[k].yt || S[k].src)) follow(k); });
    try { stageApply(listening ? mixVol : 1, (S.duck || micHot > 0.04) ? 0.28 : 1); } catch (_) {}
    try { if ("mediaSession" in navigator) navigator.mediaSession.playbackState = "playing"; } catch (_) {}
  }
  /* iPhone sound rescue (2026-10-28): pokeScreens wakes the station video
     screen players (unmute + play) and is called synchronously from inside
     the Listen tap — doing the same thing later, from a timer, is refused
     by iPhones for YouTube sound. tapStart is the safety net: while someone
     is listening, if their phone still holds a playing deck silent, their
     next tap anywhere re-runs follow() from inside a real tap, and
     checkStuck tells them on screen that one tap is all it needs instead of
     the radio failing silently. */
  function pokeScreens() { try { [scrView, scrMini].forEach((scr) => { if (scr) scr.slots.forEach((sl) => { if (sl.p && sl.deck) { try { if (sl.p.unMute) sl.p.unMute(); if (sl.p.playVideo) sl.p.playVideo(); } catch (_) {} } }); }); } catch (_) {} }
  function decksStuck() { return DECKS.some((k) => { const s = S[k], d = decks[k]; return s && s.playing && !s.yt && d && !d.shim && d.el && d.el.paused && d.el.readyState >= 3; }); }
  function tapStart() { if (boOn) return; if (!listening) return; if (decksStuck()) DECKS.forEach((k) => follow(k)); pokeScreens(); }
  function checkStuck() { if (listening && decksStuck()) say("👆 Your phone held the sound back — tap anywhere on the page and the radio starts."); }
  function startListening() {
    try { sessionStorage.removeItem("mw_mini_off"); } catch (_) {}
    listening = true; djKeepSet(true); actx(); wakeForListening(true);
    try { if (typeof media !== "undefined") media.pause(); if (typeof mode !== "undefined") mode = "dj"; } catch (_) {}
    $("#dj-listen").textContent = "⏹ Stop listening"; DECKS.forEach((k) => follow(k));
    pokeScreens(); document.removeEventListener("pointerdown", tapStart, true); document.addEventListener("pointerdown", tapStart, true); setTimeout(checkStuck, 2200);
    try { if (typeof showBar === "function") showBar({ title: "LIVE DJ SET", artist: "Meechie", cover: "" }, "Live on the decks"); } catch (_) {}
    try { if ("mediaSession" in navigator) { navigator.mediaSession.playbackState = "playing"; navigator.mediaSession.metadata = new MediaMetadata({ title: "LIVE DJ SET", artist: "Meechie", album: "Meechie's World Radio", artwork: [{ src: location.origin + "/img/icon-512.png", sizes: "512x512", type: "image/png" }] }); } } catch (_) {}
  }
  function stopListening() { listening = false; document.removeEventListener("pointerdown", tapStart, true); djKeepSet(false); wakeForListening(false); DECKS.forEach((k) => decks[k]?.stop()); voiceEl?.pause(); $("#dj-listen").textContent = "🎧 Listen live"; try { navigator.mediaSession.playbackState = "paused"; } catch (_) {} }
  try {
    if (!SANDBOX && djKeepWanted()) document.addEventListener("pointerdown", function djResumeTap(e) {
      if (listening || !djKeepWanted()) { document.removeEventListener("pointerdown", djResumeTap); return; }
      // the listen / tune-in / blackout / bubble buttons start the radio themselves on click;
      // starting it here first made their click see "listening" and stop it again
      if (e && e.target && e.target.closest && e.target.closest("#dj-listen,#tune-in,#la-tune,[data-bobtn],[data-bubbtn]")) { document.removeEventListener("pointerdown", djResumeTap); return; }
      if (isLive() || OWNER()) { startListening(); document.removeEventListener("pointerdown", djResumeTap); }
    });
  } catch (_) {}
  let autoMoved = false;
  function endSet() { stopListening(); if (autoMoved) { autoMoved = false; try { if (typeof tuneIn === "function") tuneIn(); } catch (_) {} } }
  window.MW_DJ = { start: () => { if (isLive() || OWNER()) startListening(); else if (typeof tuneIn === "function") tuneIn(); }, stop: stopListening, toggle: () => { if (listening) stopListening(); else if (isLive() || OWNER()) startListening(); const ti = document.getElementById("tune-in"); if (ti) ti.textContent = listening ? "❚❚ Stop the radio" : "▶ Tune in"; }, listening: () => listening, setMixVol: (v) => { mixVol = Math.max(0, Math.min(1, +v || 0)); if (listening) levels(); } };
  window.MW_DJ_LIVE = () => isLive();
  // the top MWR card reads the tables: whatever is on the decks is what the station says is on air
  window.MW_AIRNOW = () => {
    if (!isLive()) return null;
    const fresh = S.boothAt && Date.now() - S.boothAt < 90000;
    const playing = DECKS.filter((k) => S[k].playing && S[k].title && !(S[k].dur && S[k].start && Date.now() - S[k].start > (S[k].dur + 45) * 1000));
    const g = S.djGuest, gOn = !!(g && g.until > Date.now() && fresh);
    if (!playing.length) return { title: "Live on the decks", sub: gOn ? "🎧 " + gName(g) + " is live on the tables — guest set on Meechie's World Radio" : fresh ? "🎧 Meechie's set is live — the tables are running the station" : "🤖 Auto-DJ is running the station from the tables", cover: "" };
    const d = S[playing[0]];
    const left = d.dur && d.start ? Math.max(0, Math.round(d.dur - (Date.now() - d.start) / 1000)) : 0;
    return { title: playing.length > 1 ? d.title + " × " + S[playing[1]].title : d.title, sub: (gOn ? "🎧 " + gName(g) + " live" : fresh ? "🎧 Live now" : "🤖 Auto-DJ live") + " · Meechie's World Radio" + (left ? " · " + fmt(left) + " left" : ""), cover: d.cover || "" };
  };
  /* pop the decks out onto their own screen: a clean window with only the DJ view */
  function popOut() {
    const url = location.pathname + "?popdj=1#radio";
    const w = window.open(url, "mw-dj-decks", "popup=yes,width=1440,height=920");
    if (w) { try { w.focus(); } catch (_) {} say("Decks popped out on their own screen ⛶"); }
    else { document.documentElement.classList.add("popdj"); try { go("dj"); } catch (_) {} say("Pop-ups are blocked here — decks went full-screen on this page instead. Allow pop-ups for a separate window."); }
  }
  if (/[?&]popdj=1/.test(location.search)) document.documentElement.classList.add("popdj");
  if (SANDBOX) { document.documentElement.classList.add("playdj"); try { go("radio"); } catch (_) {} }
  const pgB = document.getElementById("pg-open"), pgW = document.getElementById("pg-wrap"), pgF = document.getElementById("pg-frame");
  if (pgB && pgW && pgF) pgB.addEventListener("click", () => { if (!pgF.getAttribute("src")) pgF.src = "/?playdj=1#radio"; pgW.hidden = false; pgB.textContent = "🎛️ The Playground is open below — play all you want, the real radio can't hear it"; pgW.scrollIntoView({ behavior: "smooth", block: "start" }); });
  /* the tables' page cuts the site's other music (owner, 2026-10-26: "when the
     dj tables turn on I want everything to cut off") — entering the DJ view or
     opening the Playground pauses the library/radio player in this tab */
  const cutOtherAudio = () => { try { if (typeof media !== "undefined" && media && !media.paused) { media.pause(); if (typeof updIcons === "function") updIcons(); } } catch (_) {} };
  if (pgB) pgB.addEventListener("click", cutOtherAudio);
  window.addEventListener("hashchange", () => { if (location.hash.replace(/^#/, "") === "dj") cutOtherAudio(); });
  if (location.hash.replace(/^#/, "") === "dj") cutOtherAudio();
  /* member DJ table → live on the real radio, by Meechie's approval only: a signed-in
     member asks from this page, the request lands in the booth's LIVE DJ REQUESTS
     panel, and an approval (S.djGuest) unlocks their GO LIVE button. Their table is
     the Playground above; while they are live, its saves relay through the server
     gate (POST /api/station kind guestdj), which checks the grant on every write. */
  (() => {
    if (SANDBOX) return;
    const sec = document.getElementById("v-dj"); if (!sec) return;
    const card = document.createElement("div"); card.className = "card"; card.id = "djlive-card"; card.style.marginTop = "16px";
    card.innerHTML = '<h3 style="margin-top:0">🎧 Your DJ table — play on the real radio</h3><div id="djlive-body"><p class="muted">Loading…</p></div>';
    const pgCard = pgW ? pgW.closest(".card") : null;
    if (pgCard && pgCard.parentNode) pgCard.parentNode.insertBefore(card, pgCard.nextSibling); else sec.appendChild(card);
  })();
  let djLiveSig = "", djLivePend = false, djLivePendAt = 0;
  const mySess = () => { try { return (window.MW && MW.session && MW.session()) || null; } catch (_) { return null; } };
  async function renderDjLive() {
    const body = document.getElementById("djlive-body"); if (!body || SANDBOX) return;
    const ses = mySess(), user = ses && ses.user, uid = user && user.id;
    const g = S && S.djGuest, approved = !!(uid && g && g.uid === uid && g.until > Date.now());
    let liveOn = false; try { liveOn = sessionStorage.getItem("mw-guestlive") === "1"; } catch (_) {}
    const bt = S && S.battle, btMine = !!(uid && bt && bt.on && bt.id && (bt.phase === "live" || (bt.phase === "done" && Date.now() - (bt.at || 0) < 10 * 60e3)) && (bt.p1.uid === uid || bt.p2.uid === uid));
    let btOn = false; try { btOn = sessionStorage.getItem("mw-battlelive") === "1"; } catch (_) {}
    if (uid && !approved && !OWNER() && Date.now() - djLivePendAt > 10000) { djLivePendAt = Date.now(); try { const d = DBF(); const snap = d ? await d.doc("requests/djlive-" + uid).get() : null; djLivePend = !!(snap && snap.exists); } catch (_) {} }
    const sig = [OWNER() ? "owner" : "", uid || "", approved ? g.until : 0, liveOn, djLivePend, btMine ? [bt.id, bt.phase, bt.round, bt.turn, bt.winner, btOn].join(":") : ""].join("|");
    if (sig === djLiveSig) return; djLiveSig = sig;
    if (OWNER()) { body.innerHTML = '<p class="muted">This is your station. When a member asks to DJ live, the request lands in your booth under 🎛️ LIVE DJ REQUESTS — approve it there and their table drives the radio until their slot ends, you end it, or you open your own booth.</p>'; return; }
    if (!uid) { body.innerHTML = '<p class="muted">Your table is the DJ Playground above — yours to play on any time, and the real radio can\'t hear it. Want the real radio? <b>Sign in</b>, then ask Meechie for a live slot right here.</p>'; return; }
    if (btMine) {
      const other = bt.p1.uid === uid ? bt.p2 : bt.p1, turnName = bt.turn === bt.p1.uid ? gName(bt.p1) : gName(bt.p2);
      if (bt.phase === "done") {
        const wn = bt.winner === bt.p1.uid ? gName(bt.p1) : bt.winner === bt.p2.uid ? gName(bt.p2) : "";
        body.innerHTML = wn ? `<p>⚔️ <b>Battle over — ${E(wn)} takes it!</b> Thanks for battling on Meechie's World Radio. The final score is on the station card.</p>` : '<p>⚔️ <b>Battle over — it ended in a draw!</b> Thanks for battling on Meechie\'s World Radio. The final score is on the station card.</p>';
        return;
      }
      body.innerHTML = `<p>⚔️ <b>You're in a DJ BATTLE</b> against <b>${E(gName(other))}</b> — Round ${bt.round} of ${bt.rounds}. ${bt.turn === uid ? "🎧 <b>Your turn — you're on the decks!</b>" : "⏳ <b>" + E(turnName) + "</b> is on the decks — you're up next."}</p><p class="muted" style="margin:6px 0">Open your battle table and play when it's your turn — the whole station hears it, and the crowd gifts and likes on the station card — most gift coins wins.</p><button class="btn" type="button" id="djlive-battle-toggle">${btOn ? "⏹ Leave the battle table" : "⚔️ Open your battle table"}</button>`;
      const t = document.getElementById("djlive-battle-toggle");
      if (t) t.addEventListener("click", () => { try { if (sessionStorage.getItem("mw-battlelive") === "1") sessionStorage.removeItem("mw-battlelive"); else { sessionStorage.removeItem("mw-guestlive"); sessionStorage.setItem("mw-battlelive", "1"); if (pgB) pgB.click(); say("⚔️ Battle table open — when it's your turn, your mix is on the radio"); } } catch (_) {} djLiveSig = ""; renderDjLive(); });
      return;
    }
    if (approved) { body.innerHTML = `<p>✅ <b>Meechie put you on!</b> Your live slot runs until ${new Date(g.until).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}. Open your table (the Playground above), flip this on, and play — the whole station hears your mix.</p><button class="btn" type="button" id="djlive-toggle">${liveOn ? "⏹ Stop — take me off the radio" : "🔴 GO LIVE on the radio"}</button>`; const t = document.getElementById("djlive-toggle"); if (t) t.addEventListener("click", () => { try { if (sessionStorage.getItem("mw-guestlive") === "1") sessionStorage.removeItem("mw-guestlive"); else { sessionStorage.setItem("mw-guestlive", "1"); if (pgB) pgB.click(); say("🔴 You are LIVE — your table is driving the radio"); } } catch (_) {} djLiveSig = ""; renderDjLive(); }); return; }
    if (djLivePend) { body.innerHTML = '<p>⏳ <b>Request sent.</b> Meechie sees it in his booth — when he approves you, your GO LIVE button appears right here.</p><button class="btn ghost" type="button" id="djlive-cancel">Cancel my request</button>'; const c = document.getElementById("djlive-cancel"); if (c) c.addEventListener("click", async () => { try { const d = DBF(); if (d) await d.doc("requests/djlive-" + uid).delete(); } catch (_) {} djLivePend = false; djLiveSig = ""; renderDjLive(); }); return; }
    body.innerHTML = '<p class="muted">Your table is the DJ Playground above — yours any time, and the real radio can\'t hear it. Want the station to hear you? Ask Meechie — if he approves you in his booth, you get a live slot (up to 2 hours) and your table drives the real radio.</p><button class="btn" type="button" id="djlive-ask">🎧 Ask Meechie to DJ live</button>';
    const a = document.getElementById("djlive-ask"); if (a) a.addEventListener("click", async () => { const d = DBF(); if (!d) { say("Still loading — try again in a second"); return; } const name = ((typeof members !== "undefined" && members && members[uid] && members[uid].handle) || user.name || user.email || "Member").toString().slice(0, 60); try { await d.doc("requests/djlive-" + uid).set({ kind: "djlive", uid, name, title: "🎧 " + name + " wants to DJ live", at: Date.now(), status: "pending" }); djLivePend = true; say("Request sent to Meechie's booth 🎧"); } catch (_) { say("Couldn't send — try again"); } djLiveSig = ""; renderDjLive(); });
  }
  /* radio-app demand poll (owner, 2026-10-26): ask the listeners before building
     the standalone app — votes ride the requests collection as kind:"appvote",
     one live vote per member (latest doc per uid wins) */
  (() => {
    const card = document.getElementById("app-poll"); if (!card || SANDBOX) return;
    let myChoice = ""; try { myChoice = localStorage.getItem("mw-appvote") || ""; } catch (_) {}
    let tally = { yes: 0, no: 0, total: 0 };
    const paint = () => {
      card.querySelectorAll("[data-appvote]").forEach((b) => b.classList.toggle("on", b.dataset.appvote === myChoice));
      const res = document.getElementById("apppoll-results"), note = document.getElementById("apppoll-note");
      const yp = tally.total ? Math.round(tally.yes / tally.total * 100) : 0, np = tally.total ? 100 - yp : 0;
      if (res) { res.hidden = !(tally.total || myChoice); const yb = document.getElementById("apppoll-yes"), nb = document.getElementById("apppoll-no"), yn = document.getElementById("apppoll-yes-n"), nn = document.getElementById("apppoll-no-n"); if (yb) yb.style.width = yp + "%"; if (nb) nb.style.width = np + "%"; if (yn) yn.textContent = yp + "%"; if (nn) nn.textContent = np + "%"; }
      if (note) note.textContent = tally.total ? (tally.total + (tally.total === 1 ? " vote" : " votes") + " so far" + (myChoice ? " — you voted " + (myChoice === "yes" ? "📲 Yes" : "🌐 Nah") + " (tap the other button to change it)" : "")) : "Be the first to vote.";
    };
    const sub = () => { const d = DB(); if (!d) { setTimeout(sub, 1500); return; } try { d.collection("requests").limit(500).onSnapshot((s) => { const byUid = {}; s.docs.forEach((x) => { const r = x.data() || {}; if (r.kind === "appvote" && r.uid && (!byUid[r.uid] || (r.at || 0) > (byUid[r.uid].at || 0))) byUid[r.uid] = r; }); tally = { yes: 0, no: 0, total: 0 }; Object.values(byUid).forEach((r) => { if (r.choice === "yes" || r.choice === "no") { tally[r.choice]++; tally.total++; } }); const ses = mySess(); const uid = ses && ses.user && ses.user.id; if (uid && byUid[uid]) { myChoice = byUid[uid].choice; try { localStorage.setItem("mw-appvote", myChoice); } catch (_) {} } paint(); }, () => {}); } catch (_) {} };
    card.addEventListener("click", async (e) => { const b = e.target.closest && e.target.closest("[data-appvote]"); if (!b) return; const ses = mySess(); const uid = ses && ses.user && ses.user.id; if (!uid) { if (typeof openAuth === "function") openAuth("signup"); say("Join free to vote — members decide what gets built."); return; } const d = DB(); if (!d) return; myChoice = b.dataset.appvote; try { localStorage.setItem("mw-appvote", myChoice); } catch (_) {} paint(); try { await d.collection("requests").add({ kind: "appvote", choice: myChoice, uid, at: Date.now() }); say(myChoice === "yes" ? "📲 Vote counted — you want the app!" : "🌐 Vote counted — the website's enough for you."); } catch (_) {} });
    sub(); paint();
  })();

  if (!SANDBOX) { renderDjLive(); setInterval(() => { renderDjLive(); }, 5000); }
  /* Mouse wheel: NATIVE scrolling, no custom glide (owner, 2026-10-28 night).
   * A custom glide lived here from 2026-10-27 (slowed at his ask, then sped up
   * twice on 2026-10-28) but every version kept gliding after the wheel
   * stopped — his final word: it must stop when he stops. Do not re-add a
   * wheel handler without his explicit say. */
  document.addEventListener("click", (e) => { if (e.target.closest && e.target.closest("#dj-pop2")) { e.preventDefault(); popOut(); } });
  if (typeof media !== "undefined") media.addEventListener("play", () => {
    if (listening) { listening = false; wakeForListening(false); DECKS.forEach((k) => decks[k]?.stop()); voiceEl?.pause(); $("#dj-listen").textContent = "🎧 Listen live"; return; }
    // The tables ARE the live radio while a set is live: any radio tune-in (player bar,
    // hero, lock-screen controls, radio-keep) hands over to the deck mix, not the playlist.
    if (!OWNER() && isLive() && typeof mode !== "undefined" && mode === "radio") { autoMoved = true; startListening(); }
  });
  $("#dj-listen").addEventListener("click", () => (listening ? stopListening() : isLive() || OWNER() ? startListening() : (typeof tuneIn === "function" && tuneIn())));
  document.querySelectorAll("[data-bobtn]").forEach((b) => b.addEventListener("click", () => { if (!listening && (isLive() || OWNER())) startListening(); blackout(true); }));
  document.querySelectorAll("[data-bubbtn]").forEach((b) => b.addEventListener("click", () => { if (bubOn) return; bubOn = true; if (!listening && (isLive() || OWNER())) startListening(); bubbleOpen(); }));

  let ownerLoaded = false;
  function mergeState(d) {
    const m = Object.assign({ live: false, xf: 0.5, xf2: 0.5, panX: 0.5, panY: 0, duck: false, quant: true, A: blank(), B: blank(), C: blank(), D: blank(), voice: null, liveSince: 0, ticker: "", log: [], show: null, pads: [], autodj: true, fxHornAt: 0, hornOn: false, fx: defFx(), vmix: { mode: "auto", a: "", b: "", t: 0, tr: "fade", trMs: 650, at: 0 }, vfx: { kind: "", at: 0 }, vcam: { on: false, at: 0 } }, d || {});
    m.fx = Object.assign(defFx(), m.fx || {});
    m.vmix = Object.assign({ mode: "auto", a: "", b: "", t: 0, tr: "fade", trMs: 650, at: 0 }, m.vmix || {});
    if (["cut", "fade", "wipe", "slide", "zoom", "blur", "flash", "glitch"].indexOf(m.vmix.tr) < 0) m.vmix.tr = "fade";
    m.vmix.trMs = Math.max(250, Math.min(1600, +m.vmix.trMs || 650)); m.vmix.at = +m.vmix.at || 0;
    m.vfx = Object.assign({ kind: "", at: 0 }, m.vfx || {});
    m.vcam = Object.assign({ on: false, at: 0 }, m.vcam || {}); m.vcam.on = !!m.vcam.on; m.vcam.at = +m.vcam.at || 0; /* BOOTH OPTIMIZATION (2026-10-29): the broadcast frame no longer rides inside radio/dj — it lives in its own radio/camframe doc (camFrameTick writes it, camOvSync reads it), so every booth save and every listener poll of this doc stays small. A stale frame/frameAt still sitting in the stored doc is ignored, never normalized in. */ delete m.vcam.frame; delete m.vcam.frameAt;
    // GO LIVE STUDIO (2026-10-29): S.vstream is the master-screen stream
    // switch — {on, kind:"cam"|"screen", at, by, meeting}. Screen outranks
    // camera stream, camera stream outranks the vmix deck videos; the
    // meeting id is how viewers find the room the booth is publishing to.
    m.vstream = Object.assign({ on: false, kind: "", at: 0, by: "", meeting: "", hidden: false, stopAt: 0 }, m.vstream || {});
    m.vstream.on = !!m.vstream.on; m.vstream.at = +m.vstream.at || 0;
    m.vstream.stopAt = +m.vstream.stopAt || 0; // explicit-stop stamp (fix-studio4): written ONLY by an owner Stop tap, so the publisher can tell a deliberate stop from a stale echo of the switch — see vsSync
    m.vstream.kind = (m.vstream.kind === "cam" || m.vstream.kind === "screen") ? m.vstream.kind : "";
    m.vstream.by = String(m.vstream.by || "");
    m.vstream.meeting = /^[A-Za-z0-9-]{8,80}$/.test(String(m.vstream.meeting || "")) ? String(m.vstream.meeting) : "";
    m.vstream.hidden = !!m.vstream.hidden;
    // PUBLISHER DIAG (fix-studio5): the publishing tab's own verdict on
    // its chain — {stage, at, repairs}. Written only by the publisher
    // supervisor (proof-stamped), normalized here like the rest of the
    // switch so echoes carry it faithfully. A doc from an older build
    // has none: an on switch then reads as publishing, as it did before.
    const vdg = (m.vstream.diag && typeof m.vstream.diag === "object" && !Array.isArray(m.vstream.diag)) ? m.vstream.diag : null;
    m.vstream.diag = { stage: (vdg && ["publishing", "repairing", "source-gone", "stopped"].indexOf(vdg.stage) >= 0) ? vdg.stage : (m.vstream.on ? "publishing" : "stopped"), at: vdg ? (+vdg.at || 0) : 0, repairs: vdg ? Math.max(0, Math.min(9999, +vdg.repairs || 0)) : 0 };
    if (!m.vstream.on) m.vstream.kind = "";
    m.A = Object.assign(blank(), m.A || {}); m.B = Object.assign(blank(), m.B || {}); m.C = Object.assign(blank(), m.C || {}); m.D = Object.assign(blank(), m.D || {});
    const qn = (r) => (r && (r.src || r.yt)) ? { src: String(r.src || ""), yt: String(r.yt || ""), at: +r.at || 0 } : null;
    m.qStock = { A: qn((m.qStock || {}).A), B: qn((m.qStock || {}).B), C: qn((m.qStock || {}).C), D: qn((m.qStock || {}).D) };
    m.dropsOn = m.dropsOn !== false; m.dropN = +m.dropN || 0; m.dropIx = +m.dropIx || 0;
    // DJ BATTLES state (2026-10-29): normalized here like vcam — scores are
    // NOT part of it (tallied server-side from the vote docs, see
    // functions/api/battle.js); this is just who is battling and whose
    // turn it is. turnSec persists the booth's turn-length pick so the
    // server turn engine advances on the same clock the booth promised.
    const bw = (w) => ({ uid: String((w && w.uid) || ""), name: String((w && w.name) || "").slice(0, 60) });
    const bb = (m.battle && typeof m.battle === "object" && !Array.isArray(m.battle)) ? m.battle : {};
    m.battle = { on: !!bb.on, id: String(bb.id || ""), p1: bw(bb.p1), p2: bw(bb.p2), round: Math.max(1, Math.min(99, +bb.round || 1)), rounds: [1, 2, 3, 5].indexOf(+bb.rounds) >= 0 ? +bb.rounds : 3, turnSec: [30, 60, 90, 120].indexOf(+bb.turnSec) >= 0 ? +bb.turnSec : 90, turn: String(bb.turn || ""), turnEndsAt: +bb.turnEndsAt || 0, phase: (bb.phase === "live" || bb.phase === "done") ? bb.phase : "off", winner: String(bb.winner || ""), at: +bb.at || 0, lastWrite: +bb.lastWrite || 0 };
    return m;
  }
  // the site-wide LIVE pill (owner ask 2026-10-26): when Meechie (or an approved
  // guest DJ) is actually at the tables, every visitor sees it, with a one-tap
  // tune-in that mutes everything else and lands them on the radio
  const gName = (g) => { const n = ((g && g.name) || "").trim(); return n ? (n.includes("@") ? n.split("@")[0] : n) : "Guest DJ"; }; // a DJ is never shown as a raw email address
  function guestLiveOn() { try { return sessionStorage.getItem("mw-guestlive") === "1"; } catch (_) { return false; } } // hoisted: the lamp paints before this line runs
  function paintLiveAlert() { const el = document.getElementById("dj-livealert"); if (!el || SANDBOX) return; const now = Date.now(); const guest = S.djGuest && S.djGuest.until > now && (now - (S.djGuest.lastWrite || 0) < 45000); const hostDeck = !guest && (now - (S.boothAt || 0) < 150000) && DECKS.some((k) => S[k] && S[k].playing); const tv = !guest && vsBroadcast() && !(S.vstream || {}).hidden; const host = hostDeck || tv; const setId = guest ? ("g" + (S.djGuest.uid || "")) : tv && !hostDeck ? ("tv" + ((S.vstream || {}).meeting || "")) : String(S.liveSince || S.boothAt || ""); let dismissed = ""; try { dismissed = sessionStorage.getItem("mw-la-dismiss") || ""; } catch (_) {} const show = !listening && (guest || host) && dismissed !== setId && !document.body.classList.contains("dj-on") && !document.documentElement.classList.contains("popdj"); el.hidden = !show; if (show) { el.dataset.set = setId; const t = el.querySelector(".la-txt"); if (t) t.textContent = guest ? ("🔴 LIVE NOW — " + gName(S.djGuest) + " is DJing on Meechie's World Radio") : tv && !hostDeck ? "🔴 LIVE NOW — Meechie is live on MW TV" : "🔴 LIVE NOW — Meechie is DJing on the radio"; } }
  /* ---------- WATCH THE SETUP (owner ask 2026-10-29) ----------
   * Guests and members watch the booth live and hear the station while
   * they watch. READ-ONLY BY CONSTRUCTION: this block only ever reads S
   * and writes #ws-* / #wb-* nodes. Nothing here calls save() or any
   * deck control, and the one DB write in the block is the member own
   * trial stamp on members/<uid>, the same pattern the profile saves
   * use. The mirror control surfaces carry class ws-ctl, whose only
   * click path runs the upsell card. Watching and listening to Meechie
   * stay free — plans are only for running a setup of your own.
   * watch-setup2 (same day, the owner correction): the first mirror was
   * rows of text and he rejected it — "they cant see my turn tables...
   * i want them to see what i see like my set up my radio tab". So
   * paintWatch now builds the booth itself a second time under #wb-root
   * (see the spectator booth note at paintWatch). */
  let wsUpsellAt = 0, wsSig = "", wsTrialAt = 0, wsTrialChecked = false;
  function wsLiveNow() { return isLive() || (vsBroadcast() && !(S.vstream || {}).hidden); }
  function wsEnsureModals() {
    if (!document.getElementById("ws-upsell")) {
      const u = document.createElement("div"); u.id = "ws-upsell"; u.className = "ws-modal"; u.hidden = true;
      u.innerHTML = `<div class="ws-card"><button type="button" class="btn ghost sm ws-x wsu-x" aria-label="Close">✕</button><h3 style="margin:0 0 8px">👀 You are watching Meechie's setup</h3><p style="margin:0 0 10px">This is Meechie's live DJ setup. You can watch everything he does on it — the controls answer to Meechie only.</p><p style="margin:0 0 14px">Want tables of your own? The <b>basic setup is FREE</b>, and the <b>full setup is free for 30 days</b>. After the trial, Basic is <b>$5/month</b>. Paid plans run <b>$20, $50, $100, $350 and $500</b> a month.</p><div style="display:flex;gap:8px;flex-wrap:wrap"><button type="button" class="btn wsu-free">Use the free basic setup</button><button type="button" class="btn ghost wsu-plans">See plans</button></div></div>`;
      document.body.appendChild(u);
    }
    if (!document.getElementById("ws-plans")) {
      const p = document.createElement("div"); p.id = "ws-plans"; p.className = "ws-modal"; p.hidden = true;
      p.innerHTML = `<div class="ws-card"><button type="button" class="btn ghost sm ws-x wpl-x" aria-label="Close">✕</button><h3 style="margin:0 0 6px">🎛️ Run your own setup</h3><p class="muted" style="margin:0 0 6px">Watching and listening to Meechie live is always free. Plans are only for running your own tables.</p><div class="wpl-row"><div class="wpl-nm"><b>Basic</b><span>The free basic setup — your own tables, any time</span></div><b class="wpl-pr">FREE</b></div><div class="wpl-row"><div class="wpl-nm"><b>Full setup — 30-day free trial</b><span>Free for 30 days. After the trial, Basic continues at $5/month</span></div><b class="wpl-pr">$0</b></div><div id="wpl-trial-note"></div><div style="display:flex;gap:8px;flex-wrap:wrap;margin:4px 0 6px"><button type="button" class="btn wpl-trial" id="wpl-trial">Start my 30-day free trial</button><button type="button" class="btn ghost wpl-free">Use the free basic setup</button></div><div class="wpl-row"><div class="wpl-nm"><b>Basic</b><span>After the free trial</span></div><b class="wpl-pr">$5/month</b></div><div class="wpl-row"><div class="wpl-nm"><b>Paid plan</b><span>For DJs who want more</span></div><b class="wpl-pr">$20/month</b></div><div class="wpl-row"><div class="wpl-nm"><b>Paid plan</b><span>For DJs who want more</span></div><b class="wpl-pr">$50/month</b></div><div class="wpl-row"><div class="wpl-nm"><b>Paid plan</b><span>For DJs who want more</span></div><b class="wpl-pr">$100/month</b></div><div class="wpl-row"><div class="wpl-nm"><b>Paid plan</b><span>For DJs who want more</span></div><b class="wpl-pr">$350/month</b></div><div class="wpl-row"><div class="wpl-nm"><b>Paid plan</b><span>For DJs who want more</span></div><b class="wpl-pr">$500/month</b></div></div>`;
      document.body.appendChild(p);
    }
  }
  function wsModal(id, show) { wsEnsureModals(); const m = document.getElementById(id); if (m) m.hidden = !show; if (show && id === "ws-plans") wsTrialPaint(); }
  function wsUpsell() { const now = Date.now(); if (now - wsUpsellAt < 60000) return; wsUpsellAt = now; wsModal("ws-upsell", true); }
  function wsGoBasic() { if (typeof go === "function") go("dj"); const pg = document.getElementById("pg-open"); if (pg) { try { pg.click(); } catch (_) {} } }
  function wsTrialPaint() { if (!wsTrialAt) return; const note = document.getElementById("wpl-trial-note"); const btn = document.getElementById("wpl-trial"); if (btn) { btn.disabled = true; btn.textContent = "✅ Trial on"; } if (note) note.innerHTML = `<p style="margin:6px 0">✅ Your 30-day free trial is on — Basic continues at $5/month after. We will remind you before it ends.</p>`; }
  function wsPaintPlans() { if (wsTrialChecked) return; const ses = mySess(); const uid = ses && ses.user && ses.user.id; if (!uid) return; wsTrialChecked = true; const d = DB(); if (!d) return; d.doc("members/" + uid).get().then((snap) => { const data = snap && snap.exists && snap.data ? snap.data() : null; if (data && data.trial_started_at) { wsTrialAt = +data.trial_started_at || 0; wsTrialPaint(); } }).catch(() => {}); }
  async function wsStartTrial(btn) {
    const ses = mySess(); const uid = ses && ses.user && ses.user.id;
    if (!uid) { wsModal("ws-plans", false); if (typeof openAuth === "function") openAuth("signup"); say("Join free first — the trial rides on your free account."); return; }
    if (wsTrialAt) { wsTrialPaint(); return; }
    const d = DB(); if (!d) { say("One moment — still connecting."); return; }
    if (btn) btn.disabled = true;
    try { await d.doc("members/" + uid).update({ trial_started_at: Date.now() }); wsTrialAt = Date.now(); wsTrialChecked = true; wsTrialPaint(); }
    catch (e) { if (btn) btn.disabled = false; say("That did not save — tap it once more."); }
  }
  /* ---------- the spectator booth (watch-setup2) ----------
   * The booth itself, built a second time for the room: the same markup
   * and classes the owner console uses (deck, platter, wave, beatbox,
   * xfpad, fxgrid, dj-panel), in the booth own order — master screen,
   * decks A-D, the X fader strip, MASTER FX, the queue — under #wb-root
   * with wb- ids so nothing collides with the real booth. It is painted
   * from S with the booth own values and formulas: posOf() for deck
   * position, the paintOwner deck values (title, cover on the platter,
   * spin on the playing deck, pitch/volume), the paintXfPads math for
   * the X dot, the pan readout and the volume knobs, paintBeat values
   * for BPM and key, paintEdit values for the FX. The platter spin is
   * the booth own .spin animation, started and stopped purely by the
   * shared playing flag. The master screen is a real screen in the
   * stage system (scrWatch, and #wb-stage rides vsStageEls), so the
   * video mix and the live share land on it exactly like the station
   * stage — rendered by the site from state, never a capture. The
   * waveform is drawn locally from the deck record (position over
   * duration) because a spectator loads no audio of its own — the
   * sound itself rides the listener engine, started by the Watch
   * buttons like TUNE IN. Owner-only panels (Door, live-DJ requests,
   * After Hours, Customize, Studio) are not part of the show and are
   * not built here. */
  let wbBuilt = false, wbQSsig = "", wbWaveSig = {};
  const WB_DK = { A: "#f0cf78", B: "#38bdf8", C: "#4ade80", D: "#f472b6" };
  function wbDeckHTML(k) {
    return `<div class="deck ws-ctl" data-deck="${k}" style="--dk:${WB_DK[k]}"><h4>DECK ${k}</h4><div class="platter" id="wb-pl-${k}"></div>
    <canvas class="wave" id="wb-wv-${k}" width="520" height="84"></canvas>
    <div class="wb-yt" id="wb-yt-${k}" hidden>🎬 MUSIC VIDEO — playing on the master screen above</div>
    <div class="ttl" id="wb-ttl-${k}">Load a song</div><div class="tm" id="wb-tm-${k}">0:00</div>
    <div class="beatbox"><span class="bpmv" id="wb-bpm-${k}">BPM —</span><span class="keyv" id="wb-key-${k}"></span><span class="bdots" id="wb-dots-${k}"><i></i><i></i><i></i><i></i></span></div>
    <div class="row"><button class="btn sm" type="button" id="wb-play-${k}">▶ Play</button><button class="btn ghost sm" type="button">⏮ Cue</button><button class="btn ghost sm" type="button">🛑 Brake</button></div>
    <label class="lab">Pitch <span id="wb-pitv-${k}">0.0%</span><input type="range" min="0.92" max="1.08" step="0.001" value="1" id="wb-pit-${k}" disabled></label>
    <label class="lab">Volume<input type="range" min="0" max="2" step="0.01" value="0.9" id="wb-vol-${k}" disabled></label></div>`;
  }
  function wbFxCell(id, lab, min, max, step) {
    return `<div class="fxcell"><small>${lab} · <span id="wb-fxv-${id}"></span></small><input type="range" min="${min}" max="${max}" step="${step}" value="${min}" id="wb-fx-${id}" disabled></div>`;
  }
  function wbBuild(body) {
    const deckA = wbDeckHTML("A"), deckB = wbDeckHTML("B"), deckC = wbDeckHTML("C"), deckD = wbDeckHTML("D");
    const xv = (k) => `<div class="xv" id="wb-xv-${k}" style="--dk:${WB_DK[k]}"><i></i><span>VOL ${k}</span><b id="wb-xvb-${k}">90%</b></div>`;
    body.innerHTML = `<div id="wb-root">
    <div class="wb-top"><span class="onair-lamp" id="wb-lamp"><span class="dot"></span>OFF AIR</span><span class="wb-now" id="wb-now"></span></div>
    <div class="dj-screen"><small>📺 MASTER SCREEN — MUSIC VIDEO · EVERYONE SEES THIS SCREEN LIVE</small>
    <div class="vstage" id="wb-stage"><div class="vslot" id="wb-vs1"></div><div class="vslot" id="wb-vs2"></div><div class="vstandby" id="wb-vstandby">Meechie is live on the tables — the video mix lands here the moment a music video plays.</div><div class="vposter" id="wb-vposter"><img src="/img/radio-promo.jpg" srcset="/img/radio-promo-640.webp 640w, /img/radio-promo-1080.webp 1080w" sizes="100vw" alt="Meechie's World Radio" loading="lazy" decoding="async"></div><div class="vchip" id="wb-vchip" hidden></div></div></div>
    <div class="dj-panel wb-band"><h4>🎶 UP NEXT — THE QUEUE</h4><div class="dj-list" id="wb-queue"></div></div>
    <div class="dj-decks wb-decks">${deckA}${deckB}
    <div class="mixer xfbar ws-ctl"><div class="xfrow"><div class="xfvols">${xv("A")}${xv("B")}</div><div class="xfpad big"><span class="xfpl tl">A</span><span class="xfpl tr">B</span><span class="xfpl bl">C</span><span class="xfpl br">D</span><div class="xfdot" id="wb-xfdot"></div></div><div class="xfvols">${xv("C")}${xv("D")}</div></div>
    <small>✕ THE X FADER — slide toward a corner deck to give it the volume; the center is all even, and the master screen up top blends with it</small>
    <div style="display:flex;gap:8px;align-items:center;justify-content:center"><small id="wb-pan-read">A 100% · B 100% · C 100% · D 100%</small></div>
    <div class="xfcurve" role="group" aria-label="Crossfader curve"><span>CURVE</span><button type="button" class="wb-xfc" data-v="smooth">Smooth</button><button type="button" class="wb-xfc" data-v="sharp">Sharp</button><button type="button" class="wb-xfc" data-v="cut">Cut</button></div></div>
    ${deckC}${deckD}</div>
    <div class="dj-panel ws-ctl"><h4>🎛️ MASTER FX</h4><div class="fxgrid">
    ${wbFxCell("boost", "🔊 BOOST", 1, 2, 0.01)}
    ${wbFxCell("mf", "FILTER", 0, 100, 1)}
    ${wbFxCell("echo", "ECHO", 0, 0.6, 0.02)}
    ${wbFxCell("fb", "ECHO REPEAT", 0, 0.7, 0.02)}
    ${wbFxCell("verb", "REVERB", 0, 0.7, 0.02)}
    ${wbFxCell("fla", "FLANGER", 0, 1, 0.02)}
    ${wbFxCell("pha", "PHASER", 0, 1, 0.02)}
    ${wbFxCell("noise", "NOISE", 0, 1, 0.02)}
    ${wbFxCell("crush", "GRIT (CRUSH)", 0, 100, 1)}
    <div class="fxcell wide"><small>TRANSFORMER (CHOP)</small><div style="display:flex;gap:5px"><button class="btn ghost sm gatebtn wb-gate" type="button" data-v="0">OFF</button><button class="btn ghost sm gatebtn wb-gate" type="button" data-v="2">SLOW</button><button class="btn ghost sm gatebtn wb-gate" type="button" data-v="4">MED</button><button class="btn ghost sm gatebtn wb-gate" type="button" data-v="8">FAST</button></div></div>
    </div></div>
    </div>`;
    wbBuilt = true; wbQSsig = ""; wbWaveSig = {};
  }
  function wbWave(k) {
    const cv = document.getElementById("wb-wv-" + k); if (!cv) return;
    const s = S[k] || {}; const dur = +s.dur || 0, pos = posOf(k);
    const sig = (s.title || "") + "|" + Math.floor(pos * 4) + "|" + dur + "|" + (s.playing ? 1 : 0);
    if (wbWaveSig[k] === sig) return; wbWaveSig[k] = sig;
    const g = cv.getContext("2d"); if (!g) return;
    const W = cv.width, H = cv.height, frac = dur > 0 ? Math.max(0, Math.min(1, pos / dur)) : 0;
    const seed = k.charCodeAt(0) * 131 + (s.title || "").length * 17 + ((s.title || " ").charCodeAt(0) || 0);
    g.clearRect(0, 0, W, H);
    const n = 72, bw = W / n;
    for (let i = 0; i < n; i++) {
      const v = 0.25 + 0.75 * Math.abs(Math.sin(seed + i * 1.7) * Math.cos(seed * 0.3 + i * 0.53));
      const h = Math.max(2, v * (H - 10));
      g.fillStyle = i / n <= frac ? "#f7b928" : "rgba(230,220,195,.28)";
      g.fillRect(i * bw + 0.5, (H - h) / 2, Math.max(1, bw - 1.5), h);
    }
    if (dur > 0) { g.fillStyle = "#fff"; g.fillRect(Math.max(0, frac * W - 1), 0, 2, H); }
  }
  function paintWatch() {
    const body = document.getElementById("ws-body"); if (!body) return;
    if (!document.body || document.body.dataset.view !== "watch") return;
    if (SANDBOX) { if (wsSig !== "sb") { wsSig = "sb"; wbBuilt = false; body.innerHTML = `<p class="muted">The Playground is a sandbox — the live setup mirror runs on the real site.</p>`; } return; }
    if (!wbBuilt || !document.getElementById("wb-root")) wbBuild(body);
    const live = wsLiveNow();
    const lamp = document.getElementById("wb-lamp");
    if (lamp) { lamp.classList.toggle("on", live); const lt = live ? "ON AIR" : "OFF AIR"; if (lamp.lastChild && lamp.lastChild.textContent !== lt) lamp.lastChild.textContent = lt; }
    const nowEl = document.getElementById("wb-now");
    if (nowEl) {
      const tvLive = vsBroadcast() && !(S.vstream || {}).hidden;
      const playing = DECKS.filter((k) => S[k] && S[k].playing && S[k].title).map((k) => S[k].title);
      const gN = S.djGuest && S.djGuest.until > Date.now() ? gName(S.djGuest) : null;
      nowEl.textContent = tvLive && !playing.length && !gN ? "📺 Meechie is live on the master screen — the tables pick back up when the share ends." : live ? (playing.length ? "🎧 Live now: " + playing.join("  ×  ") : gN ? "🎧 " + gN + " is live on the decks." : "🎧 Meechie is live on the decks.") : "The station is on the playlist right now — the booth wakes up the moment Meechie goes live.";
    }
    const sb = document.getElementById("wb-sound");
    if (sb) { const t = listening ? "🔊 Sound on — tap to mute" : "🔇 Sound off — tap for sound"; if (sb.textContent !== t) sb.textContent = t; }
    DECKS.forEach((k) => {
      const s = S[k] || {};
      const ttl = document.getElementById("wb-ttl-" + k);
      if (ttl) { const t = s.title || "Load a song"; if (ttl.textContent !== t) ttl.textContent = t; const card = ttl.closest(".deck"); if (card) card.classList.toggle("playing", !!s.playing); }
      const pl = document.getElementById("wb-pl-" + k);
      if (pl) { pl.classList.toggle("spin", !!s.playing); pl.classList.toggle("has-cover", okUrl(s.cover)); if (okUrl(s.cover)) pl.style.setProperty("--cv", `url("${s.cover}")`); }
      const yt = document.getElementById("wb-yt-" + k); if (yt) yt.hidden = !s.yt;
      const pb = document.getElementById("wb-play-" + k); if (pb) { const t = s.playing ? "⏸ Pause" : "▶ Play"; if (pb.textContent !== t) pb.textContent = t; }
      const tm = document.getElementById("wb-tm-" + k);
      if (tm) { const dur = +s.dur || 0, pos = posOf(k); tm.textContent = fmt(pos) + (dur ? " / " + fmt(dur) + " · −" + fmt(Math.max(0, dur - pos)) : ""); }
      const bp = document.getElementById("wb-bpm-" + k); if (bp) { const t = s.bpm > 0 ? s.bpm.toFixed(1) + " BPM" : "BPM —"; if (bp.textContent !== t) bp.textContent = t; }
      const kv = document.getElementById("wb-key-" + k); if (kv) { const t = s.cam ? s.cam + (s.key ? " · " + s.key : "") : ""; if (kv.textContent !== t) kv.textContent = t; }
      const dots = document.getElementById("wb-dots-" + k);
      if (dots) { const on = s.playing && s.bpm > 0 ? Math.floor(posOf(k) / (60 / s.bpm)) % 4 : -1; const kids = dots.children; for (let i = 0; i < kids.length; i++) kids[i].classList.toggle("on", i === on); }
      const pit = document.getElementById("wb-pit-" + k); if (pit) pit.value = s.rate || 1;
      const pv = document.getElementById("wb-pitv-" + k); if (pv) pv.textContent = (((s.rate || 1) - 1) * 100).toFixed(1).replace("-", "−") + "%";
      const vol = document.getElementById("wb-vol-" + k); if (vol) vol.value = s.vol ?? 0.9;
      const kn = document.getElementById("wb-xv-" + k); if (kn) kn.style.setProperty("--rot", (-135 + ((s.vol || 0) / 2) * 270) + "deg");
      const xb = document.getElementById("wb-xvb-" + k); if (xb) xb.textContent = Math.round((s.vol || 0) * 100) + "%";
      wbWave(k);
    });
    const dot = document.getElementById("wb-xfdot");
    if (dot) { const xfv = S.panX == null ? 0.5 : S.panX; dot.style.left = (50 + (xfv - 0.5) * 84) + "%"; dot.style.top = (50 + (S.panY || 0) * 42) + "%"; }
    const rd = document.getElementById("wb-pan-read");
    if (rd) { const py = S.panY || 0, ab = py > 0 ? 1 - py : 1, cd = py < 0 ? 1 + py : 1; const g = { A: xfGain(S.xf, "A") * ab * pairXGain(S.panX, false), B: xfGain(S.xf, "B") * ab * pairXGain(S.panX, false), C: xfGain(S.xf2 ?? 0.5, "A") * cd * pairXGain(S.panX, true), D: xfGain(S.xf2 ?? 0.5, "B") * cd * pairXGain(S.panX, true) }; const mx = Math.max(g.A, g.B, g.C, g.D, 0.0001); rd.textContent = ["A", "B", "C", "D"].map((k) => k + " " + Math.round(g[k] / mx * 100) + "%").join(" · "); }
    document.querySelectorAll(".wb-xfc").forEach((x) => x.classList.toggle("on", x.dataset.v === (S.xfCurve || "smooth")));
    const fx = S.fx || {};
    const fxSet = (id, v, lab) => { const el = document.getElementById("wb-fx-" + id); if (el) el.value = v; const t = document.getElementById("wb-fxv-" + id); if (t) t.textContent = lab; };
    fxSet("boost", fx.boost || 1, Math.round((fx.boost || 1) * 100) + "%");
    fxSet("mf", fx.mf == null ? 100 : fx.mf, Math.round(fx.mf == null ? 100 : fx.mf) + "%");
    fxSet("echo", fx.echo || 0, Math.round((fx.echo || 0) * 100) + "%");
    fxSet("fb", fx.fb == null ? 0.34 : fx.fb, Math.round((fx.fb == null ? 0.34 : fx.fb) * 100) + "%");
    fxSet("verb", fx.verb || 0, Math.round((fx.verb || 0) * 100) + "%");
    fxSet("fla", fx.fla || 0, Math.round((fx.fla || 0) * 100) + "%");
    fxSet("pha", fx.pha || 0, Math.round((fx.pha || 0) * 100) + "%");
    fxSet("noise", fx.noise || 0, Math.round((fx.noise || 0) * 100) + "%");
    fxSet("crush", fx.crush || 0, String(fx.crush || 0));
    document.querySelectorAll(".wb-gate").forEach((x) => x.classList.toggle("on", +x.dataset.v === (+fx.gate || 0)));
    const q = Array.isArray(S.queue) ? S.queue : [];
    const qsig = q.length + "|" + q.map((x) => ((x || {}).title || "")).join("~");
    if (qsig !== wbQSsig) { wbQSsig = qsig; const qEl = document.getElementById("wb-queue"); if (qEl) qEl.innerHTML = q.length ? q.map((x, i) => `<div class="dj-item"><span>${i + 1}. ${(x || {}).yt ? "🎬 " : ""}${E((x || {}).title || "Untitled")}</span></div>`).join("") : `<small class="muted">The queue is empty — Auto-DJ pulls from the full rotation.</small>`; }
  }
  setInterval(() => { try { paintWatch(); } catch (_) {} }, 1000);
  function onState(d) {
    stateSeen = true; // the first real snapshot has landed - viewer slates may now speak for the station (see tvSlatePaint)
    try { paintVEdit(); } catch (_) {} try { paintLiveAlert(); } catch (_) {}
    const firstOwnerLoad = OWNER() && !ownerLoaded;
    if (OWNER() && ownerLoaded) {
      // Booth-to-booth sync: my own saves echo back and are ignored, but a save stamped
      // by the OTHER booth window (the pop-out, or the main tab) is a command — repaint
      // from it, and if THIS window holds the sound, play what it says. The 24/7 keeper's
      // advances land here too, so an open booth never shows a stale station.
      if (d && d.by !== tabId && (d.updatedAt || 0) > (S.updatedAt || 0)) {
        // A stocked deck may not be un-stocked by an echo: the keeper
        // (and any slower screen) writes from a snapshot that can
        // predate the stocking save, so its C/D come back empty — the
        // deck fields revert, the record stops matching, and the
        // rotation silently dies while the pair path keeps A/B alive.
        // When the incoming doc still carries the stock record and the
        // deck itself arrived empty, keep this window's deck fields.
        const stockedSnap = {};
        DECKS.forEach((k) => { if (qStockValid(k)) stockedSnap[k] = S[k]; });
        S = mergeState(d);
        DECKS.forEach((k) => { const snap = stockedSnap[k]; if (!snap) return; const rec = qStock[k], inc = (S.qStock || {})[k]; if (rec && inc && inc.src === rec.src && inc.yt === rec.yt && !S[k].src && !S[k].yt) S[k] = snap; });
        qSyncFromS();
        lastBaseAt = d.updatedAt || 0;
        adoptQueue(d);
        watchHorn(); watchVfx();
        paintOwner(); paintStation();
        if (boothLead) DECKS.forEach((k) => { if (S[k].src) follow(k); });
      }
      return;
    }
    if (OWNER()) ownerLoaded = true;
    const was = isLive();
    S = mergeState(d);
    qSyncFromS();
    if (d && d.by !== tabId) lastBaseAt = d.updatedAt || 0;
    adoptQueue(d);
    watchHorn(); watchVfx();
    // heal the booth: anything still pointing at the dead storage comes off the decks
    if (OWNER()) { let dirty = false; DECKS.forEach((k) => { if (DEAD(S[k].src)) { S[k] = blank(); dirty = true; } }); if (S.voice && DEAD(S.voice.url)) { S.voice = null; dirty = true; } if (S.show && DEAD(S.show.url)) { S.show = null; dirty = true; } if (dirty) setTimeout(() => save(true), 800); }
    const live = isLive() || (vsBroadcast() && !(S.vstream || {}).hidden); // SHARING = LIVE, same rule as paintStation: the station section and banner stay up while the TV broadcasts
    $("#dj-banner").hidden = !live || OWNER();
    $("#dj-station").hidden = OWNER() ? false : (live || (S.log || []).length > 0 || !!S.show);
    if (!live && listening) endSet();
    if (live && !was && !document.hidden && !OWNER() && typeof mode !== "undefined" && mode === "radio" && typeof media !== "undefined" && !media.paused) { autoMoved = true; startListening(); }
    if (listening) DECKS.forEach((k) => follow(k));
    // taking control: opening the booth pulls whatever the station is playing onto the
    // decks, in sync, so the tables are his from the first second
    if (firstOwnerLoad) { showOwnerUI(); DECKS.forEach((k) => { if (S[k].playing && boothLead) adoptDeck(k); }); }
    playVoice(); firePadHit(); paintStation(); try { paintWatch(); } catch (_) {}
    if (OWNER()) paintOwner();
  }

  /* ---------- owner: loading songs, transport, deck tools ---------- */
  const prepSet = () => { try { return new Set(JSON.parse(localStorage.getItem("mw-dj-prep") || "[]")); } catch (_) { return new Set(); } };
  const histList = () => { try { return JSON.parse(localStorage.getItem("mw-dj-hist") || "[]"); } catch (_) { return []; } };
  let libFilter = "";
  function libList() {
    const list = TRACKS(), prep = prepSet();
    const rows = list.map((t, i) => [t, i]).filter(([t]) => !libFilter || (t.title || "").toLowerCase().includes(libFilter));
    $("#dj-lib").innerHTML = list.length ? (rows.length ? rows.map(([t, i]) => `<div class="dj-item"><span title="${E(t.title)}">${E(t.title)}</span><button class="btn ghost sm" type="button" data-load="A" data-lib="${i}">A</button><button class="btn ghost sm" type="button" data-load="B" data-lib="${i}">B</button><button class="btn ghost sm" type="button" data-load="C" data-lib="${i}">C</button><button class="btn ghost sm" type="button" data-load="D" data-lib="${i}">D</button><button class="btn ghost sm" type="button" data-queue="${i}">＋Q</button><button class="btn ghost sm" type="button" data-prep="${i}">${prep.has(URLOF(t)) ? "⭐" : "☆"}</button></div>`).join("") : '<small class="muted">No songs match that filter.</small>') : '<small class="muted">No songs in your library yet.</small>';
  }
  function paintPrep() { const box = $("#dj-prep"); if (!box) return; const set = prepSet(), list = TRACKS(); const rows = list.map((t, i) => [t, i]).filter(([t]) => set.has(URLOF(t))); box.innerHTML = rows.length ? rows.map(([t, i]) => `<div class="dj-item"><span title="${E(t.title)}">${E(t.title)}</span><button class="btn ghost sm" type="button" data-load="A" data-lib="${i}">A</button><button class="btn ghost sm" type="button" data-load="B" data-lib="${i}">B</button><button class="btn ghost sm" type="button" data-load="C" data-lib="${i}">C</button><button class="btn ghost sm" type="button" data-load="D" data-lib="${i}">D</button><button class="btn ghost sm" type="button" data-queue="${i}">＋Q</button><button class="btn ghost sm" type="button" data-prep="${i}">⭐</button></div>`).join("") : '<small class="muted">Nothing prepared yet — tap ☆ on any song in Your Library.</small>'; const hb = $("#dj-hist"); if (hb) { const h = histList(); hb.innerHTML = h.length ? h.map((x, i) => `<div class="dj-item"><span title="${E(x.title || "")}">${E(x.title || "")}</span>${["A", "B", "C", "D"].map((L) => `<button class="btn ghost sm" type="button" data-hload="${L}" data-hist="${i}">${L}</button>`).join("")}</div>`).join("") : '<small class="muted">Nothing loaded yet — the booth history builds as you play.</small>'; } }
  let net = [];
  async function load(k, item, opts) {
    qClear(k); // any fresh load replaces what the deck held — its stocked record is void (stockDeck re-records after its own load)
    brainClose(k, "load"); // PR-B2: the replaced track's play closes here, classified by the clock (an early replacement is a skip)
    const wasSounding = !!(S[k] && S[k].playing); // GENTLE LOAD: was this deck the sounding one before this pick replaced it
    if (serverMirror()) leadTakeAt = Date.now();
    const d = deck(k); actx();
    // a pick from his own hand loads STOPPED (owner, 2026-10-27): the deck
    // cues up and waits for his Play. The station's own flows (Auto-DJ, the
    // queue, schedule, listener picks) call load without the cue flag and
    // start playing through togglePlay as before.
    const cueDeck = !!(opts && opts.cue);
    if (item && (item.src || item.yt)) { try { const key = item.src || ("yt:" + item.yt); const h = histList().filter((x) => (x.src || ("yt:" + x.yt)) !== key); h.unshift({ src: item.src || "", yt: item.yt || "", title: item.title || "", cover: item.cover || "", dur: item.dur || 0, at: Date.now() }); localStorage.setItem("mw-dj-hist", JSON.stringify(h.slice(0, 30))); } catch (_) {} }
    if (!boothLead) {
      // mirror window: put the song on the shared deck — the window playing the sound loads it for real
      S[k] = Object.assign(blank(), { src: item.src || "", yt: item.yt || "", title: item.title, cover: item.cover || "", vol: S[k].vol ?? 0.9, rate: S[k].rate || 1, dur: item.dur || 0, bpm: item.bpm || 0, beat0: 0, key: item.key || "", cam: item.cam || "", vcut: false, bcut: false, loop: null, loopBeats: 0 });
      d.cues = [null, null, null]; d.loop = null; d.loopBeats = 0; paintCues(k); paintOwner(); save();
      say("Loaded on deck " + k + " — the window playing the sound picked it up.");
      return;
    }
    S[k] = Object.assign(blank(), { src: item.src || "", yt: item.yt || "", title: item.title, cover: item.cover || "", vol: S[k].vol ?? 0.9, rate: S[k].rate || 1, dur: item.dur || 0, bpm: item.bpm || 0, beat0: 0, key: item.key || "", cam: item.cam || "", vcut: false, bcut: false, loop: null, loopBeats: 0 });
    d.cues = [null, null, null]; d.loop = null; d.loopBeats = 0; paintCues(k);
    paintOwner(); $("#ttl-" + k).textContent = "Loading " + item.title + "...";
    /* GENTLE LOAD (owner, 2026-10-29: "when I clicked to choose a song it
     * started skipping"): a MANUAL pick (the cue flag) onto a deck that
     * is not sounding records the state exactly as a normal load - the
     * song sits loaded and STOPPED, per his law - but does NOT build the
     * deck's video player. Building an iframe player at click time
     * steals the main thread from the deck that IS sounding, and the
     * sound stutters. Any old player is torn down so no stale picture
     * sits under the new title. The player builds lazily at the first
     * moment it is actually needed: his Play press builds it inside
     * togglePlay (which already calls setYt for a video deck), and
     * every automation path - queue draw, stockDeck, preload, Auto-DJ -
     * calls load WITHOUT the cue flag, so it builds right here exactly
     * as before. File picks are cheap and keep the path below as is. */
    if (item.yt && cueDeck && !wasSounding) { try { d.clearYt(); } catch (_) {} paintOwner(); levels(); save(); return; }
    if (item.yt) { const okY = await d.setYt(item.yt); if (!okY) { if (ageIsLocked(item.yt)) say("That video is age-locked by YouTube — it cannot play inside the site. Skipped it for next time."); else say("That video wouldn't play here — some are blocked from playing on other sites. Try another one."); S[k] = blank(); paintOwner(); return; } try { d.el.currentTime = 0; } catch (_) {} if (cueDeck) { const stopIt = () => { try { if (!S[k].playing && d.el && !d.el.paused) d.el.pause(); } catch (_) {} }; stopIt(); [350, 900, 1600].forEach((ms) => setTimeout(stopIt, ms)); } paintOwner(); levels(); save(); return; }
    const ok = await d.set(item.src);
    if (!ok) { say("That song couldn't load. Try another one."); S[k] = blank(); paintOwner(); return; }
    d.el.currentTime = 0; d.el.playbackRate = S[k].rate || 1; if (cueDeck) { try { d.el.pause(); } catch (_) {} } paintOwner(); levels(); save(); anaLater(k);
  }
  function paintCues(k) { document.querySelectorAll(`[data-hot^="${k}:"]`).forEach((b, i) => b.classList.toggle("on", deck(k).cues[i] != null)); document.querySelectorAll(`[data-loopb^="${k}:"]`).forEach((b) => b.classList.toggle("on", !!deck(k).loopBeats && +b.dataset.loopb.split(":")[1] === deck(k).loopBeats)); document.querySelectorAll(`[data-roll^="${k}:"]`).forEach((b) => b.classList.toggle("on", !!deck(k).roll && +b.dataset.roll.split(":")[1] === deck(k).loopBeats)); document.querySelectorAll(`[data-slip="${k}"]`).forEach((b) => b.classList.toggle("on", !!deck(k).slip)); }
  // loop roll: the loop cycles on the speakers while a shadow playhead keeps
  // travelling; ending the roll lands exactly where the song would have been
  function endRoll(k) { const d = deck(k); if (!d.roll) return; const sh = d.roll.pos + (performance.now() - d.roll.at) / 1000 * (S[k].rate || 1); d.roll = null; d.loop = null; d.loopBeats = 0; S[k].loop = null; S[k].loopBeats = 0; try { d.el.currentTime = Math.max(0, Math.min((d.el.duration || 1e9) - 0.3, sh)); } catch (_) {} if (S[k].playing) S[k].start = Date.now() - d.el.currentTime * 1000; paintCues(k); save(true); }
  async function togglePlay(k) {
    if (serverMirror()) leadTakeAt = Date.now();
    const s = S[k], d = deck(k); if (!s.yt && !okUrl(s.src)) { say("Load a song on deck " + k + " first."); return; }
    actx(); try { if (typeof media !== "undefined" && !media.paused) media.pause(); } catch (_) {}
    if (!boothLead) {
      // mirror window: flip the shared state only — the window holding the sound plays it
      if (s.playing) { s.pos = posOf(k); s.playing = false; }
      else { s.playing = true; s.start = Date.now() - (s.pos || 0) * 1000; logPlay(s.title); if (!S.live) { S.live = true; S.liveSince = Date.now(); const gl = $("#dj-golive"); if (gl) gl.checked = true; paintStation(); say("🔴 You're LIVE — the window playing the sound has the tables on the radio."); } }
      if (s.playing) S.pausedAt = 0; else if (S.live && !DECKS.some((x) => S[x].playing)) S.pausedAt = Date.now();
      paintOwner(); save(true);
      return;
    }
    if (s.playing) { s.pos = d.el.currentTime; s.playing = false; d.el.pause(); }
    else {
      if (s.yt) { const okY = await d.setYt(s.yt); if (!okY) { if (ageIsLocked(s.yt)) say("That video is age-locked by YouTube — it cannot play inside the site. Skipped it for next time."); else say("That video won't play here — it may be blocked from playing on other sites, or YouTube didn't load. Try another video."); paintOwner(); return; } } else await d.set(s.src); try { d.el.currentTime = s.pos || 0; } catch (_) {}
      d.el.playbackRate = s.rate || 1; d.el.preservesPitch = !d.vinyl;
      await d.el.play().catch(() => {}); s.start = Date.now() - d.el.currentTime * 1000; s.playing = true;
      logPlay(s.title); brainPlay(k); // PR-B2: the playing flip is the brain's play event — every start path (hand, Auto-DJ, queue) funnels through here
      // The tables ARE the radio: pressing play on a deck goes live, no separate switch.
      if (!S.live) { S.live = true; S.liveSince = Date.now(); const gl = $("#dj-golive"); if (gl) gl.checked = true; paintOwner(); paintStation(); say("🔴 You're LIVE — whatever you play on the tables is on the radio for everyone."); }
    }
    // A pause from the DJ is a PAUSE, not dead air: stamp it (S.pausedAt) and
    // nothing restarts a deck over it — not this booth, not the station keeper.
    // A song that ENDS on its own still rolls into the next one (see deckEnded).
    if (s.playing) S.pausedAt = 0; else if (S.live && !DECKS.some((x) => S[x].playing)) S.pausedAt = Date.now();
    paintOwner(); levels(); save(true);
  }
  onMain("click", async (e) => {
    const b = e.target.closest("button"); if (!b || !OWNER()) return;
    if (b.dataset.pop != null) { popOut(); return; }
    if (b.dataset.dsecbtn) { const n = b.dataset.dsecbtn; secState[n] = secState[n] ? 0 : 1; try { localStorage.setItem("mw-dsec-v1", JSON.stringify(secState)); } catch (_) {} document.querySelectorAll('.dsec[data-dsec="' + n + '"]').forEach((s) => s.classList.toggle("shut", !secState[n])); return; }
    /* mwLeadLock client phase: on a mirror booth (another screen holds the
     * server claim) performance taps never touch the decks - they ask for
     * control instead, so a second booth cannot silently drive the set. */
    if (serverMirror() && (b.dataset.mwauto != null || b.closest("#dj-owner .deck, #dj-owner #dj-browser, #dj-owner #dj-xfbar, #dj-owner .mixer"))) { takeControl(); return; }
    if (b.dataset.vtr || b.dataset.vspd || b.dataset.vfx) {
      if (b.dataset.vfx) { fireVfx(b.dataset.vfx); return; }
      if (b.dataset.vtr) { S.vmix = Object.assign({}, S.vmix || {}, { tr: b.dataset.vtr }); paintOwner(); save(true); say("\uD83D\uDCFA Video transition: " + b.dataset.vtr.toUpperCase() + " - it dresses the next master-screen switch on every screen."); return; }
      S.vmix = Object.assign({}, S.vmix || {}, { trMs: +b.dataset.vspd || 650 }); paintOwner(); save(true); say("\uD83D\uDCFA Video transition speed set."); return;
    }
    if (b.dataset.cam != null) { camToggle(); return; }
    if (b.dataset.vmix || b.dataset.vsrc) {
      const ytDecks = () => DECKS.filter((k) => S[k].yt && S[k].playing).sort((x, y) => stageGain(y) - stageGain(x));
      // every discrete switch keeps the chosen transition + speed and stamps
      // S.vmix.at, so every screen animates the same switch (renderScreen)
      const vKeep = () => ({ tr: (S.vmix && S.vmix.tr) || "fade", trMs: (S.vmix && S.vmix.trMs) || 650, at: Date.now() });
      if (b.dataset.vsrc) { const k = b.dataset.vsrc; if (S[k] && S[k].yt) { S.vmix = Object.assign({ mode: "man", a: k, b: "", t: 0 }, vKeep()); say("📺 Master screen: deck " + k + " full screen — viewers see it too."); } else say("No video on deck " + k + " — put a YouTube video there first."); paintOwner(); save(true); return; }
      const a = b.dataset.vmix;
      if (a === "auto") { S.vmix = Object.assign({ mode: "auto", a: "", b: "", t: 0 }, vKeep()); say("📺 Video screen on AUTO — the picture now fades with the X fader, just like the sound."); paintOwner(); save(true); return; }
      const top2 = ytDecks(), cur = vmixTargets()[0];
      if (top2.length < 2 || !cur) { say("Put videos on two decks first — then Cut and Fade mix the pictures."); return; }
      const other = top2.find((k) => k !== cur.k);
      if (a === "cut") { S.vmix = Object.assign({ mode: "man", a: other, b: "", t: 0 }, vKeep()); say("✂️ Video CUT to deck " + other + "."); paintOwner(); save(true); return; }
      // the chosen transition dresses this switch too: Cut lands instantly
      // and any other non-Fade pick switches now (renderScreen animates it
      // from the S.vmix.at stamp); Fade keeps the classic dissolve below
      const trSel = (S.vmix && S.vmix.tr) || "fade";
      if (trSel === "cut") { S.vmix = Object.assign({ mode: "man", a: other, b: "", t: 0 }, vKeep()); say("\u2702\uFE0F Video CUT to deck " + other + "."); paintOwner(); save(true); return; }
      if (trSel !== "fade") { S.vmix = Object.assign({ mode: "man", a: other, b: "", t: 0 }, vKeep()); say("\uD83D\uDCFA Video switch (" + trSel + ") to deck " + other + "."); paintOwner(); save(true); return; }
      // fade: dissolve from the deck on screen to the other one over ~1.2s,
      // saving as it goes so viewers dissolve with the booth
      S.vmix = Object.assign({ mode: "man", a: cur.k, b: other, t: 0 }, vKeep()); save(true);
      const t0 = performance.now(); say("🌫️ Fading the picture to deck " + other + "…");
      const step = () => { const p = Math.min(1, (performance.now() - t0) / 1200); S.vmix.t = p; stageApply(1, 1); save(); if (p < 1) requestAnimationFrame(step); else { S.vmix = Object.assign({ mode: "man", a: other, b: "", t: 0 }, vKeep()); paintOwner(); save(true); } };
      requestAnimationFrame(step); return;
    }
    if (b.dataset.vskip != null) {
      const top = vmixTop();
      if (top && S[top.k] && S[top.k].playing) deckEnded(top.k);
      return;
    }
    if (b.dataset.preset) {
      const P = {
        loud: { fx: { mf: 100, echo: 0, fb: 0.3, verb: 0.1, fla: 0, gate: 0, crush: 0, boost: 1.25 }, vinyl: false, keepMix: true, msg: "🔊 Loud & Clear: the phone setup — mud off, boost set, and the broadcast polish brings the bass and clarity. Your mix and deck volumes stay right where they are." },
        radio: { fx: { mf: 100, echo: 0, fb: 0.34, verb: 0.12, fla: 0, gate: 0, crush: 0 }, vinyl: false, msg: "🏆 Pro Radio setup: clean broadcast sound, a touch of reverb, echo armed for drops." },
        club: { fx: { mf: 100, echo: 0.22, fb: 0.45, verb: 0.3, fla: 0.25, gate: 0, crush: 0 }, vinyl: false, msg: "🔥 Club setup: echo, reverb and flanger up — big-room energy on everything you play." },
        scratch: { fx: { mf: 100, echo: 0.1, fb: 0.3, verb: 0.05, fla: 0, gate: 0, crush: 15 }, vinyl: true, msg: "🎺 Scratch Session: vinyl mode on every deck and a little grit — grab a platter and cut." },
        chop: { fx: { mf: 100, echo: 0.15, fb: 0.4, verb: 0.1, fla: 0, gate: 4, crush: 0 }, vinyl: false, msg: "⚡ Transformer setup: the chop is ON at medium speed — the beat gets sliced live for everyone." },
      }[b.dataset.preset];
      if (!P) return;
      S.fx = Object.assign(defFx(), P.fx); if (!P.keepMix) { S.xf = 0.5; S.xf2 = 0.5; S.panX = 0.5; }
      DECKS.forEach((k) => { const d = deck(k); d.vinyl = P.vinyl; d.el.preservesPitch = !P.vinyl; const vc = document.querySelector(`[data-vinyl="${k}"]`); if (vc) vc.checked = P.vinyl; if (!P.keepMix) S[k].vol = 0.9; });
      document.querySelectorAll("[data-gate]").forEach((x) => x.classList.toggle("on", +x.dataset.gate === S.fx.gate));
      applyFx(); levels(); paintOwner(); save(true); say(P.msg); return;
    }
    if (b.dataset.curplay != null) { const ci = CURATED[+b.dataset.curplay]; if (ci) { b.disabled = true; const src = await curatedSrc(ci); b.disabled = false; if (src) { if (boothLead) playPadUrl(src); stampPad({ kind: "url", i: -1, url: src }); } else say("That sound wouldn't load. Try another."); } return; }
    if (b.dataset.fsave) { const [kind, ix] = b.dataset.fsave.split(":"), it = (kind === "m" ? FREE_MEDIA.music : FREE_MEDIA.videos)[+ix]; if (!it) return; const u = it.src; let om = {}; try { om = JSON.parse(localStorage.getItem("mw-offline-meta") || "{}"); } catch (_) {} if (om[u]) { say("Already saved for offline — it is in the 📥 Offline shelf on the Radio page."); return; } b.disabled = true; const oldT = b.textContent; b.textContent = "Saving…"; try { const r = await fetch(u, { headers: { "x-mw-save": "1" } }); if (!r.ok) throw new Error("fetch"); const len = +r.headers.get("content-length") || 0; if (len && len < 100000) throw new Error("tiny"); if (len > 200 * 1024 * 1024) { try { r.body && r.body.cancel(); } catch (_) {} say("That one is too big to save on a phone (" + Math.round(len / 1048576) + " MB)."); b.disabled = false; b.textContent = oldT; return; } if ("caches" in window) { const c = await caches.open("mw-music"); await c.put(u, r); } else await r.arrayBuffer(); om[u] = { title: it.t, artist: it.a, cover: it.cover || "", kind: kind === "v" ? "video" : "audio" }; try { localStorage.setItem("mw-offline-meta", JSON.stringify(om)); } catch (_) {} b.textContent = "✓ Saved"; say("⬇ Saved offline: " + it.t + " — find it in the 📥 Offline shelf on the Radio page. It plays with no internet now."); } catch (_) { b.disabled = false; b.textContent = oldT; say("That save didn't go through — check your signal (or the phone's storage) and try again."); } return; }
    if (b.dataset.freeload) { const [dk, kind, ix] = b.dataset.freeload.split(":"), it = (kind === "m" ? FREE_MEDIA.music : FREE_MEDIA.videos)[+ix]; if (it) load(dk, { src: it.src, yt: "", title: it.t, cover: it.cover, dur: it.dur || 0 }, { cue: true }); return; }
    if (b.dataset.vput) { const [dk, ix] = b.dataset.vput.split(":"), it = vRes[+ix]; if (!it) return; if (it.kind === "ia") { say("Finding the video file on the Archive..."); const fsrc = await iaVideoFile(it.id); if (!fsrc) { say("That Archive item has no playable video file — try another one."); return; } load(dk, { src: fsrc, yt: "", title: it.title, cover: it.thumb || "", dur: 0 }, { cue: true }); return; } const tok2 = it.kind === "dm" ? "dm:" + it.id : it.id; load(dk, { yt: tok2, src: "", title: it.title, cover: it.thumb || "", dur: it.dur || 0 }, { cue: true }); return; }
    if (b.dataset.ytload) { const inp = $("#dj-yt"), item = vidParse(inp && inp.value); if (!item) { say("Paste a YouTube or Vimeo link first — then pick the deck."); return; } if (item.iaId) { say("Finding the video file on the Archive..."); const asrc = await iaVideoFile(item.iaId); if (!asrc) { say("That Archive item has no playable video file."); return; } load(b.dataset.ytload, { src: asrc, yt: "", title: item.title || "Archive video", cover: "https://archive.org/services/img/" + item.iaId, dur: 0 }, { cue: true }); return; } load(b.dataset.ytload, item, { cue: true }); return; }
    if (b.dataset.load) {
      if (b.dataset.cur != null) { const ci = CURATED[+b.dataset.cur]; if (!ci) return; b.disabled = true; const src = await curatedSrc(ci); b.disabled = false; if (!src) { say("That sound wouldn't load. Try another."); return; } load(b.dataset.load, { src, title: ci.name, cover: "" }, { cue: true }); }
      else if (b.dataset.lib != null) { const t = TRACKS()[+b.dataset.lib]; if (t) load(b.dataset.load, { src: URLOF(t), title: t.title, cover: t.cover, dur: +t.duration || 0, bpm: +t.bpm || 0, key: t.key || "", cam: t.cam || "" }, { cue: true }); }
      else if (b.dataset.net != null) { const n = net[+b.dataset.net]; if (!n) return; b.disabled = true; const src = await iaFile(n.id); b.disabled = false; if (!src) { say("No playable file in that one. Pick another."); return; } load(b.dataset.load, { src, title: n.title, cover: "https://archive.org/services/img/" + encodeURIComponent(n.id) }, { cue: true }); }
      return;
    }
    if (b.dataset.queue != null) { const t = TRACKS()[+b.dataset.queue]; if (t) { queue.push({ src: URLOF(t), title: t.title, cover: t.cover || "", dur: +t.duration || 0 }); saveQueue(); paintQueue(); say("Queued: " + t.title); } return; }
    if (b.dataset.nqueue != null) { const n = net[+b.dataset.nqueue]; if (!n) return; b.disabled = true; const src = await iaFile(n.id); b.disabled = false; if (!src) { say("No playable file in that one. Pick another."); return; } queue.push({ src, title: n.title, cover: "https://archive.org/services/img/" + encodeURIComponent(n.id), dur: 0 }); saveQueue(); paintQueue(); say("Queued: " + n.title); return; }
    if (b.dataset.ytqueue != null) { const inp = $("#dj-yt"), item = vidParse(inp && inp.value); if (!item) { say("Paste a video link first — then tap ＋Q."); return; } if (item.iaId) { say("Finding the video file on the Archive..."); const asrc = await iaVideoFile(item.iaId); if (!asrc) { say("That Archive item has no playable video file."); return; } queue.push({ src: asrc, yt: "", title: item.title || "Archive video", cover: "https://archive.org/services/img/" + item.iaId, dur: 0 }); } else queue.push({ yt: item.yt, src: "", title: item.title || "Video", cover: item.cover || "", dur: 0 }); saveQueue(); paintQueue(); say("🎶 Queued: " + (item.title || "video")); return; }
    if (b.dataset.vqueue != null) { const it = vRes[+b.dataset.vqueue]; if (!it) return; if (it.kind === "ia") { say("Finding the video file on the Archive..."); const fsrc = await iaVideoFile(it.id); if (!fsrc) { say("That Archive item has no playable video file — try another one."); return; } queue.push({ src: fsrc, yt: "", title: it.title, cover: it.thumb || "", dur: 0 }); } else { const tok2 = it.kind === "dm" ? "dm:" + it.id : it.id; queue.push({ yt: tok2, src: "", title: it.title, cover: it.thumb || "", dur: it.dur || 0 }); } saveQueue(); paintQueue(); say("🎶 Queued: " + it.title); return; }
    if (b.dataset.freequeue != null) { const [kind, ix] = b.dataset.freequeue.split(":"), it = (kind === "m" ? FREE_MEDIA.music : FREE_MEDIA.videos)[+ix]; if (it) { queue.push({ src: it.src, yt: "", title: it.t, cover: it.cover, dur: it.dur || 0 }); saveQueue(); paintQueue(); say("🎶 Queued: " + it.t); } return; }
    if (b.dataset.ahload != null) { ahLoadShelf(+b.dataset.ahload); return; }
    if (b.dataset.ahput) { const [dk, si, ix] = b.dataset.ahput.split(":"), it = (ahCache[+si] || [])[+ix]; if (!it) return; load(dk, { yt: it.id, src: "", title: it.title, cover: it.thumb || "", dur: it.dur || 0 }, { cue: true }); return; }
    if (b.dataset.ahqueue != null) { const [si, ix] = b.dataset.ahqueue.split(":"), it = (ahCache[+si] || [])[+ix]; if (!it) return; queue.push({ yt: it.id, src: "", title: it.title, cover: it.thumb || "", dur: it.dur || 0 }); saveQueue(); paintQueue(); say("🎶 Queued: " + it.title); return; }
    if (b.dataset.qact) { const a = b.dataset.qact;
      if (a === "clear") { queue = []; saveQueue(); paintQueue(); say("Queue cleared."); }
      else if (a === "open") { plOpen = !plOpen; paintPlaylists(); }
      else if (a === "save") { if (!queue.length) { say("The queue is empty — add songs first, then save the list."); return; } const name = prompt("Name this playlist:"); if (!name || !name.trim()) return; const rec = { name: name.trim().slice(0, 60), items: queue.slice() }; const ex = playlists.findIndex((p) => (p.name || "").toLowerCase() === rec.name.toLowerCase()); if (ex >= 0) playlists[ex] = rec; else playlists.unshift(rec); savePlaylists(); plOpen = true; paintPlaylists(); paintSched(); say("💾 Playlist saved: " + rec.name); }
      else if (a === "play") { if (!queue.length) { say("The queue is empty — add songs with ＋Q first."); return; } if (!SANDBOX) { playQueueStock(); return; } if (DECKS.some((k) => S[k].playing)) { say("▶ The queue is rolling — the next one in line loads when this deck finishes."); return; } const it = queue.shift(); saveQueue(); paintQueue(); load("A", it).then(() => togglePlay("A")); say("▶ Playing the queue: " + (it.title || "")); }
      return; }
    if (b.dataset.plload != null || b.dataset.pladd != null || b.dataset.pldel != null) { const i = +(b.dataset.plload ?? b.dataset.pladd ?? b.dataset.pldel); const p = playlists[i]; if (!p) return; if (b.dataset.pldel != null) { playlists.splice(i, 1); savePlaylists(); paintPlaylists(); paintSched(); say("Playlist deleted: " + (p.name || "")); } else if (b.dataset.plload != null) { queue = (p.items || []).slice(); saveQueue(); paintQueue(); say("📂 In the queue: " + (p.name || "") + " — press ▶ Play the queue, or it rolls in as decks finish."); } else { queue = queue.concat(p.items || []); saveQueue(); paintQueue(); say("📂 Added to the queue: " + (p.name || "")); } return; }
    if (b.dataset.sched) { const t = $("#sched-time"), sel = $("#sched-sel"); const p = sel ? playlists[+sel.value] : null; if (!t || !t.value) { say("Pick a time first."); return; } if (!p) { say("Save a playlist first — the schedule runs playlists."); return; } sched.push({ id: "s" + Date.now().toString(36), time: t.value, name: p.name || "", items: (p.items || []).slice() }); sched.sort((x, y) => (x.time < y.time ? -1 : 1)); saveSched(); paintSched(); say("📅 Scheduled: " + (p.name || "") + " every day at " + t.value + "."); return; }
    if (b.dataset.sdel != null) { const en = sched[+b.dataset.sdel]; sched.splice(+b.dataset.sdel, 1); saveSched(); paintSched(); if (en) say("Schedule removed: " + (en.name || "") + " at " + (en.time || "")); return; }
    if (b.dataset.play) return togglePlay(b.dataset.play);
    if (b.dataset.cue0) { const k = b.dataset.cue0, s = S[k], d = deck(k); s.pos = 0; if (s.playing) s.start = Date.now(); try { d.el.currentTime = 0; } catch (_) {} save(true); return; }
    if (b.dataset.brake) { const k = b.dataset.brake, d = deck(k); if (d.el.paused) return; d.noSync = Date.now() + 1100; const r0 = d.el.playbackRate, t0 = performance.now(), pos0 = d.el.currentTime || 0, slip = !!d.slip; const step = () => { const p = (performance.now() - t0) / 800; if (p >= 1) { d.el.playbackRate = S[k].rate || 1; if (slip) { try { d.el.currentTime = Math.max(0, Math.min((d.el.duration || 1e9) - 0.3, pos0 + 0.8 * (S[k].rate || 1))); } catch (_) {} d.el.play().catch(() => {}); if (S[k].playing) S[k].start = Date.now() - d.el.currentTime * 1000; save(true); say("🌀 Slip brake — deck " + k + " lands right where the song would have been."); } else { d.el.pause(); if (S[k].playing) { S[k].playing = false; S[k].pos = d.el.currentTime; paintOwner(); save(true); } } return; } d.el.playbackRate = Math.max(0.02, r0 * (1 - p)); requestAnimationFrame(step); }; step(); return; }
    if (b.dataset.hot) { if (hotTimer === "done") { hotTimer = null; return; } const [k, n] = b.dataset.hot.split(":"), d = deck(k), i = +n - 1; if (d.cues[i] == null) { let ct = d.el.currentTime || 0; if (S.quant !== false) ct = snapBeat(k, ct); d.cues[i] = ct; S[k].cues = d.cues.slice(); save(true); say("Cue " + n + " set at " + fmt(ct) + (S.quant !== false && beatLen(k) ? " (snapped to the beat)" : "")); } else { try { d.el.currentTime = d.cues[i]; } catch (_) {} if (S[k].playing) S[k].start = Date.now() - d.cues[i] * 1000; save(true); } paintCues(k); return; }
    if (b.dataset.loopb) { const [k, beats] = b.dataset.loopb.split(":"), d = deck(k), bl = beatLen(k); if (d.roll) { endRoll(k); return; } if (d.loop && d.loopBeats === +beats) { d.loop = null; d.loopBeats = 0; S[k].loop = null; S[k].loopBeats = 0; save(true); } else { let st = d.el.currentTime || 0; if (S.quant !== false) st = snapBeat(k, st); const len = bl ? +beats * bl : +beats; d.loop = [st, st + len]; d.loopBeats = +beats; S[k].loop = d.loop; S[k].loopBeats = d.loopBeats; try { d.el.currentTime = st; } catch (_) {} if (S[k].playing) S[k].start = Date.now() - st * 1000; save(true); say("Looping " + beats + " beats on deck " + k + (bl ? "" : " (no BPM measured yet — seconds for now)")); } paintCues(k); return; }
    if (b.dataset.roll) { const [k, beats] = b.dataset.roll.split(":"), d = deck(k), bl = beatLen(k); if (d.roll) { endRoll(k); say("🌀 Roll off — deck " + k + " is back where the song would have been."); return; } let st = d.el.currentTime || 0; if (S.quant !== false) st = snapBeat(k, st); const len = bl ? +beats * bl : +beats; d.loop = [st, st + len]; d.loopBeats = +beats; S[k].loop = d.loop; S[k].loopBeats = d.loopBeats; d.roll = { pos: st, at: performance.now() }; try { d.el.currentTime = st; } catch (_) {} if (S[k].playing) S[k].start = Date.now() - st * 1000; paintCues(k); save(true); say("🌀 Rolling " + beats + " beats on deck " + k + " — tap Roll again and it lands where the song would have been."); return; }
    if (b.dataset.slip) { const k = b.dataset.slip, d = deck(k); d.slip = !d.slip; paintCues(k); say(d.slip ? "🌀 Slip ON for deck " + k + " — scratch, brake or backspin, and it lands where the song would have been." : "Slip off for deck " + k + "."); return; }
    if (b.dataset.spin) { const k = b.dataset.spin, d = deck(k); if (d.el.paused) return; d.noSync = Date.now() + 950; const t0 = performance.now(); scratchBed(); const iv = setInterval(() => { const p = (performance.now() - t0) / 750; if (p >= 1) { clearInterval(iv); scratchStop(); if (d.slip) { try { d.el.currentTime = Math.max(0, Math.min((d.el.duration || 1e9) - 0.3, (d.el.currentTime || 0) + 0.75 * (S[k].rate || 1))); } catch (_) {} if (S[k].playing) S[k].start = Date.now() - d.el.currentTime * 1000; save(true); say("🌀 Slip backspin — deck " + k + " never lost its place."); } else { d.el.pause(); if (S[k].playing) { S[k].playing = false; S[k].pos = d.el.currentTime; paintOwner(); save(true); } } return; } try { d.el.currentTime = Math.max(0, (d.el.currentTime || 0) - (0.04 + p * 0.3)); } catch (_) {} scratchSound(0.4 + p); }, 50); return; }
    if (b.dataset.prep != null) { const t = TRACKS()[+b.dataset.prep]; if (t) { const set = prepSet(), u = URLOF(t); if (set.has(u)) set.delete(u); else set.add(u); try { localStorage.setItem("mw-dj-prep", JSON.stringify([...set])); } catch (_) {} libList(); paintPrep(); say(set.has(u) ? "⭐ Prepared: " + t.title : "Removed from Prepare: " + t.title); } return; }
    if (b.dataset.hload) { const x = histList()[+b.dataset.hist]; if (x) load(b.dataset.hload, { src: x.src || "", yt: x.yt || "", title: x.title || "", cover: x.cover || "", dur: x.dur || 0 }, { cue: true }); return; }
    if (b.dataset.ediv) { S.fx.ediv = +b.dataset.ediv; applyFx(); document.querySelectorAll(".edivb").forEach((x) => x.classList.toggle("on", x === b)); save(true); say("Echo locked to " + b.textContent + " of a beat."); return; }
    if (b.dataset.sync) { const k = b.dataset.sync, o = DECKS.find((x) => x !== k && S[x].playing) || PAIR[k];
      if (S[k].bpm > 0 && S[o].bpm > 0) {
        const target = (S[o].bpm * (S[o].rate || 1)) / S[k].bpm;
        if (target < 0.92 || target > 1.08) { say("Deck " + k + " (" + S[k].bpm + " BPM) and deck " + o + " (" + S[o].bpm + " BPM) are too far apart for the pitch fader — ride the pitch by hand or pick a closer song."); return; }
        S[k].rate = +target.toFixed(3); deck(k).el.playbackRate = S[k].rate;
        if (S[k].playing && S[o].playing) { const dk = deck(k), dl = beatLen(k); let delta = beatPhase(o, deck(o).el.currentTime) - beatPhase(k, dk.el.currentTime); delta = ((delta % 1) + 1.5) % 1 - 0.5; if (Math.abs(delta) > 0.02 && dl) { const nt = Math.max(0, Math.min((dk.el.duration || 1) - 0.3, dk.el.currentTime + delta * dl)); try { dk.el.currentTime = nt; } catch (_) {} } S[k].start = Date.now() - dk.el.currentTime * 1000; say("⚡ Deck " + k + " SYNCED to deck " + o + " — tempo matched, beats locked"); }
        else say("Deck " + k + " tempo matched to deck " + o + " (" + S[o].bpm + " BPM)");
      } else { S[k].rate = S[o].rate || 1; deck(k).el.playbackRate = S[k].rate; if (S[k].playing) S[k].start = Date.now() - deck(k).el.currentTime * 1000; say("Deck " + k + " speed matched to deck " + o + " (no BPM measured yet — speed only)"); }
      paintOwner(); save(true); return; }
    if (b.dataset.tap) { const k = b.dataset.tap; tapT[k] = (tapT[k] || []).filter((t) => performance.now() - t < 2500); tapT[k].push(performance.now()); if (tapT[k].length >= 3) { const iv = (tapT[k][tapT[k].length - 1] - tapT[k][0]) / (tapT[k].length - 1); const nb = +(60000 / iv).toFixed(1); S[k].bpm = nb; S[k].beat0 = +(((deck(k).el.currentTime || 0) % (60 / nb)) ).toFixed(3); anaStore(deck(k).src || S[k].src, { b: nb, o: S[k].beat0, k: S[k].key || "", c: S[k].cam || "" }); paintBeat(k); applyFx(); save(true); say("Deck " + k + " tapped in at " + nb + " BPM"); } else say("Keep tapping on the beat…"); return; }
    if (b.dataset.bpmadj) { const [k, dv] = b.dataset.bpmadj.split(":"); if (!(S[k].bpm > 0)) { say("No BPM on deck " + k + " yet — tap the tempo or let it measure."); return; } S[k].bpm = +(S[k].bpm + (+dv)).toFixed(1); anaStore(deck(k).src || S[k].src, { b: S[k].bpm, o: S[k].beat0 || 0, k: S[k].key || "", c: S[k].cam || "" }); paintBeat(k); applyFx(); save(true); return; }
    if (b.dataset.bpmx) { const [k, mx] = b.dataset.bpmx.split(":"); if (!(S[k].bpm > 0)) { say("No BPM on deck " + k + " yet."); return; } S[k].bpm = +(S[k].bpm * (+mx)).toFixed(1); anaStore(deck(k).src || S[k].src, { b: S[k].bpm, o: S[k].beat0 || 0, k: S[k].key || "", c: S[k].cam || "" }); paintBeat(k); applyFx(); save(true); say("Deck " + k + " tempo " + (+mx === 2 ? "doubled" : "halved") + ": " + S[k].bpm + " BPM"); return; }
    if (b.dataset.nudge) { const [k, dir] = b.dataset.nudge.split(":"), bl = beatLen(k); if (!bl) { say("No beat grid on deck " + k + " yet."); return; } let nb0 = ((S[k].beat0 || 0) + (+dir) * 0.02) % bl; if (nb0 < 0) nb0 += bl; S[k].beat0 = +nb0.toFixed(3); anaStore(deck(k).src || S[k].src, { b: S[k].bpm, o: S[k].beat0, k: S[k].key || "", c: S[k].cam || "" }); save(true); say("Beat grid nudged on deck " + k); return; }
    if (b.dataset.bjump) { const [k, nb2] = b.dataset.bjump.split(":"), d = deck(k), bl = beatLen(k); const delta = bl ? (+nb2) * bl : (+nb2); let t = Math.max(0, Math.min((d.el.duration || 1e9) - 0.3, (d.el.currentTime || 0) + delta)); if (S.quant !== false && bl) t = snapBeat(k, t); try { d.el.currentTime = t; } catch (_) {} if (S[k].playing) S[k].start = Date.now() - t * 1000; else S[k].pos = t; save(true); return; }
    if (b.dataset.vcut != null && b.dataset.vcut !== "") { const k = b.dataset.vcut; S[k].vcut = !S[k].vcut; applyFx(); paintOwner(); save(true); say(S[k].vcut ? "🎤 Vocal cut ON deck " + k + " — the center (vocals) drops out for everyone. Karaoke trick, not true stems." : "Vocal cut off, deck " + k); return; }
    if (b.dataset.bcut != null && b.dataset.bcut !== "") { const k = b.dataset.bcut; S[k].bcut = !S[k].bcut; applyFx(); paintOwner(); save(true); say(S[k].bcut ? "🔊 Bass cut ON deck " + k + " — the low end is out, classic mix move." : "Bass back in, deck " + k); return; }
    if (b.dataset.gate != null) { S.fx.gate = +b.dataset.gate; document.querySelectorAll("[data-gate]").forEach((x) => x.classList.toggle("on", +x.dataset.gate === S.fx.gate)); applyFx(); save(true); say(S.fx.gate ? "Transformer chop is ON — everyone listening hears the beat get sliced." : "Transformer off."); return; }
    if (b.id === "djx-vreset") { S.ved = { b: 1, c: 1, s: 1, z: 1 }; paintVEdit(); paintEdit(); save(true); say("Master picture reset — brightness, contrast, color and zoom back to normal for everyone."); return; }
    if (b.dataset.xfc) { S.xfCurve = b.dataset.xfc; paintXfPads(); levels(); save(true); say("Crossfader curve: " + S.xfCurve + (S.xfCurve === "cut" ? " — instant switch at the center." : S.xfCurve === "sharp" ? " — stays loud in the middle, made for scratch work." : " — the smooth equal-power blend.")); return; }
  });
  // long-press a hot cue clears it
  let hotTimer = null, hotAt = null;
  onMain("pointerdown", (e) => { const b = e.target.closest("[data-hot]"); if (!b || !OWNER()) return; hotAt = { x: e.clientX, y: e.clientY }; hotTimer = setTimeout(() => { const [k, n] = b.dataset.hot.split(":"); deck(k).cues[+n - 1] = null; S[k].cues = deck(k).cues.slice(); save(true); paintCues(k); say("Cue " + n + " cleared"); hotTimer = "done"; }, 650); });
  onMainRaw("pointerup", (e) => { hotAt = null; if (hotTimer === "done") { e.preventDefault(); return; } clearTimeout(hotTimer); hotTimer = null; }, true);
  // LAW 22: a press that turns into a scroll (it moves off the button, or
  // the browser cancels it) is not a long-press — the hold is abandoned,
  // so scrolling across a hot cue can never clear the cue mid-scroll.
  onMainRaw("pointermove", (e) => { if (hotAt && Math.hypot(e.clientX - hotAt.x, e.clientY - hotAt.y) > 10) { hotAt = null; if (hotTimer !== "done") { clearTimeout(hotTimer); hotTimer = null; } } }, true);
  onMainRaw("pointercancel", () => { hotAt = null; if (hotTimer !== "done") { clearTimeout(hotTimer); hotTimer = null; } }, true);
  onMain("input", (e) => {
    if (!OWNER()) return;
    const t = e.target;
    if (t.dataset.vol) { S[t.dataset.vol].vol = +t.value; levels(); save(); }
    if (t.dataset.pitch) { const k = t.dataset.pitch; S[k].rate = +t.value; deck(k).el.playbackRate = S[k].rate; deck(k).el.preservesPitch = !deck(k).vinyl; $("#pit-v-" + k).textContent = ((S[k].rate - 1) * 100).toFixed(1).replace("-", "−") + "%"; save(); }
    if (t.dataset.eq) { const [k, band] = t.dataset.eq.split(":"), d = deck(k); if (d.eq) d.eq[band].gain.value = +t.value; S[k].eq = Object.assign({ lo: 0, mid: 0, hi: 0 }, S[k].eq || {}); S[k].eq[band] = +t.value; save(); }
    if (t.dataset.flt) { const k = t.dataset.flt; S[k].flt = +t.value; if (deck(k).flt) fltFreq(deck(k).flt, +t.value); save(); }
    if (t.id === "dj-crush") { S.fx.crush = +t.value; applyFx(); save(); }
    if (t.id === "dj-master") { localMaster = +t.value; applyMaster(); }
    if (t.id === "dj-boost") { S.fx.boost = +t.value; applyFx(); save(); }
    if (t.id === "dj-filter") { S.fx.mf = +t.value; applyFx(); save(); }
    if (t.id === "dj-echo") { S.fx.echo = +t.value; applyFx(); save(); }
    if (t.id === "dj-fb") { S.fx.fb = +t.value; applyFx(); save(); }
    if (t.id === "dj-verb") { S.fx.verb = +t.value; applyFx(); save(); }
    if (t.id === "dj-fla") { S.fx.fla = +t.value; applyFx(); save(); }
    if (t.id === "dj-pha") { S.fx.pha = +t.value; applyFx(); paintEdit(); save(); }
    if (t.id === "dj-noise") { S.fx.noise = +t.value; applyFx(); paintEdit(); save(); }
    if (t.id === "dj-libq") { libFilter = t.value.trim().toLowerCase(); libList(); }
    if (t.id === "djx-boost") { S.fx.boost = +t.value; applyFx(); paintEdit(); save(); }
    if (t.id === "djx-filter") { S.fx.mf = +t.value; applyFx(); paintEdit(); save(); }
    if (t.id === "djx-echo") { S.fx.echo = +t.value; applyFx(); paintEdit(); save(); }
    if (t.id === "djx-fb") { S.fx.fb = +t.value; applyFx(); paintEdit(); save(); }
    if (t.id === "djx-verb") { S.fx.verb = +t.value; applyFx(); paintEdit(); save(); }
    if (t.id === "djx-fla") { S.fx.fla = +t.value; applyFx(); paintEdit(); save(); }
    if (t.id === "djx-pha") { S.fx.pha = +t.value; applyFx(); paintEdit(); save(); }
    if (t.id === "djx-noise") { S.fx.noise = +t.value; applyFx(); paintEdit(); save(); }
    if (t.id === "djx-crush") { S.fx.crush = +t.value; applyFx(); paintEdit(); save(); }
    if (t.id === "djx-vb") { (S.ved = S.ved || { b: 1, c: 1, s: 1, z: 1 }).b = +t.value; paintVEdit(); paintEdit(); save(); }
    if (t.id === "djx-vc") { (S.ved = S.ved || { b: 1, c: 1, s: 1, z: 1 }).c = +t.value; paintVEdit(); paintEdit(); save(); }
    if (t.id === "djx-vs") { (S.ved = S.ved || { b: 1, c: 1, s: 1, z: 1 }).s = +t.value; paintVEdit(); paintEdit(); save(); }
    if (t.id === "djx-vz") { (S.ved = S.ved || { b: 1, c: 1, s: 1, z: 1 }).z = +t.value; paintVEdit(); paintEdit(); save(); }
  });
  onMain("change", (e) => { if (!OWNER()) return; if (e.target.dataset.vinyl != null) { const k = e.target.dataset.vinyl, d = deck(k); d.vinyl = e.target.checked; d.el.preservesPitch = !d.vinyl; } if (e.target.id === "ad-on") { S.autodj = e.target.checked; save(true); say(S.autodj ? "Auto-DJ is running the station 🤖" : "Auto-DJ off — you're flying manual."); } if (e.target.id === "dj-ad-top") { S.autodj = e.target.checked; save(true); say(S.autodj ? "Auto-DJ is running the station 🤖" : "Auto-DJ off — you're flying manual."); } if (e.target.id === "dj-horn-top") { S.hornOn = e.target.checked; save(true); say(S.hornOn ? "📯 Transition horns ON — automated crossfades get the air horn again." : "🔇 Transition horns OFF — automated crossfades stay quiet."); } if (e.target.id === "ad-drops") { S.dropsOn = e.target.checked; save(true); say(S.dropsOn ? "🎙 Station drops on — one spoken line every 3rd song change." : "Station drops off — transitions go back to the pad ID only."); } if (e.target.id === "dj-quant") { S.quant = e.target.checked; save(true); say(S.quant ? "Quantize ON — cues and loops snap to the beat." : "Quantize off — cues and loops land exactly where you tap."); } if (e.target.id === "dj-jogf") { JOGF = parseFloat(e.target.value) || 0.09; try { localStorage.setItem("mw-jogf", String(JOGF)); } catch (_) {} say("Jog feel set — grab a platter and feel the difference."); } if (e.target.id === "dj-fxsync") { S.fx.sync = e.target.checked; applyFx(); save(true); say(S.fx.sync ? "Effects now follow the live tempo — echo, flanger and the chopper lock to the beat." : "Effects free-running."); } });
  // circular pan pads: drag the gold dot — left/right is the X between the
  // pairs (A+B on the left, C+D on the right, the ends at 100%), up/down
  // tilts between the pairs. Same mix as the sliders and the phone fader
  // bar; everything stays in sync, including Auto-DJ crossfades.
  function paintXfPads() { // THE ONE FADER dot: full-travel paint (the dot reaches the edge your finger reaches) + live mix readout
    XFCURVE = S.xfCurve || "smooth"; document.querySelectorAll("[data-xfc]").forEach((x) => x.classList.toggle("on", x.dataset.xfc === XFCURVE));
    const dot = $("#dj-xfdot"); if (dot) { dot.style.left = (50 + ((S.panX ?? 0.5) - 0.5) * 84) + "%"; dot.style.top = (50 + (S.panY || 0) * 42) + "%"; }
    const rd = $("#dj-pan-read"); if (rd) { const py = S.panY || 0, ab = py > 0 ? 1 - py : 1, cd = py < 0 ? 1 + py : 1; const g = { A: xfGain(S.xf, "A") * ab * pairXGain(S.panX, false), B: xfGain(S.xf, "B") * ab * pairXGain(S.panX, false), C: xfGain(S.xf2 ?? 0.5, "A") * cd * pairXGain(S.panX, true), D: xfGain(S.xf2 ?? 0.5, "B") * cd * pairXGain(S.panX, true) }; const mx = Math.max(g.A, g.B, g.C, g.D, 0.0001); rd.textContent = ["A", "B", "C", "D"].map((k) => k + " " + Math.round(g[k] / mx * 100) + "%").join(" · "); }
    document.querySelectorAll("[data-xv]").forEach((el) => { const k = el.dataset.xv, v = S[k] ? (S[k].vol || 0) : 0; el.style.setProperty("--rot", (-135 + (v / 2) * 270) + "deg"); const b = el.querySelector("b"); if (b) b.textContent = Math.round(v * 100) + "%"; });
  }
  // ONE pan dot for all four decks. THE X LAW (owner, 2026-10-29):
  // left/right is the X — it rides BETWEEN THE PAIRS (S.panX): all the way
  // left = decks A+B at 100% and C+D silent, all the way right = C+D at
  // 100% and A+B silent, center = both pairs full. Up/down still tilts
  // between the pairs (top = A/B, bottom = C/D). The within-pair faders
  // (S.xf / S.xf2) are no longer written by the pad — they belong to the
  // automated blends, the follow guard and the curve, exactly as the
  // crossfade code below expects.
  // LAW 22 (owner, 2026-10-30): scroll and touch never touch the music.
  // A press on a sideways booth surface (the X pad, a waveform, a platter)
  // is classified ONCE by pressIntent and the verdict never flips back:
  // "control" = sideways travel of 10px or more, at least 1.6x the vertical
  // travel (a deliberate drag); "scroll" = vertical travel of 10px or more,
  // at least the sideways travel (a page scroll, however it veers later);
  // anything else is undecided and the press does nothing yet.
  const pressIntent = (pend, e) => { const dx = e.clientX - pend.x, dy = e.clientY - pend.y; if (Math.abs(dx) >= 10 && Math.abs(dx) >= Math.abs(dy) * 1.6) return "control"; if (Math.abs(dy) >= 10 && Math.abs(dy) >= Math.abs(dx)) return "scroll"; return ""; };
  (() => { const pad = $("#dj-xfpad"); if (!pad) return; let drag = false;
    const center = () => { xfTouchedAt = Date.now(); S.xf = 0.5; S.xf2 = 0.5; S.panX = 0.5; S.panY = 0; paintXfPads(); levels(); save(true); };
    const apply = (e) => { if (serverMirror()) { takeControl(); return; } const r = pad.getBoundingClientRect(), rad = r.width / 2; let dx = (e.clientX - (r.left + rad)) / rad, dy = (e.clientY - (r.top + rad)) / rad; dx = Math.min(1, Math.max(-1, dx)); dy = Math.min(1, Math.max(-1, dy)); if (Math.abs(dx) < 0.07) dx = 0; if (Math.abs(dy) < 0.09) dy = 0; xfTouchedAt = Date.now(); if (xfAnim) { clearInterval(xfAnim); xfAnim = null; } S.panX = Math.round(((dx + 1) / 2) * 1000) / 1000; S.panY = Math.round(dy * 1000) / 1000; paintXfPads(); levels(); save(); };
    // scroll gate (owner, 2026-10-29; LAW 22, 2026-10-30): a press applies
    // nothing until pressIntent calls it a control move, and the moment it
    // calls it a scroll the press is dropped for good — a scroll that veers
    // sideways mid-page can never grab the fader. A vertical scroll starting
    // on the pad is the page scroll (pan-y) and a pointercancel drops the
    // press untouched; a clean tap applies the tapped point on release.
    let pend = null;
    pad.addEventListener("pointerdown", (e) => { if (!OWNER()) return; pend = { x: e.clientX, y: e.clientY, id: e.pointerId }; e.preventDefault(); });
    pad.addEventListener("pointermove", (e) => { if (pend && !drag) { if (!e.buttons) { pend = null; return; } const intent = pressIntent(pend, e); if (intent === "scroll") { pend = null; return; } if (intent !== "control") return; drag = true; try { pad.setPointerCapture(pend.id); } catch (_) {} apply(e); pend = null; } if (drag) apply(e); });
    pad.addEventListener("pointerup", (e) => { if (pend) { pend = null; apply(e); save(true); return; } if (drag) { drag = false; save(true); } });
    pad.addEventListener("pointercancel", () => { pend = null; drag = false; });
    pad.addEventListener("dblclick", () => { if (OWNER()) center(); });
    pad.addEventListener("keydown", (e) => { if (!OWNER()) return; const st = e.shiftKey ? 0.01 : 0.05; if (e.key === "ArrowLeft") { S.panX = Math.max(0, (S.panX ?? 0.5) - st); } else if (e.key === "ArrowRight") { S.panX = Math.min(1, (S.panX ?? 0.5) + st); } else if (e.key === "ArrowUp") { S.panY = Math.max(-1, (S.panY || 0) - st); } else if (e.key === "ArrowDown") { S.panY = Math.min(1, (S.panY || 0) + st); } else return; xfTouchedAt = Date.now(); paintXfPads(); levels(); save(); e.preventDefault(); });
    const cb = $("#dj-pan-center"); if (cb) cb.addEventListener("click", () => { if (OWNER()) center(); });
  })();
  // touch the waveform to jump the song there: tap a spot to play from it, or drag
  // across to scrub. Works in the sound window and from the mirror (it writes the
  // shared position and the leader follows). Seeking outside an active loop clears it.
  DECKS.forEach((k) => {
    const cv = document.getElementById("wv-" + k); if (!cv) return;
    let scrub = false;
    const seekTo = (e) => { const d = deck(k); const dur = d.el.duration || S[k].dur || 0; if (!dur) { say("That deck needs a song loaded before you can scrub it."); return; } const r = cv.getBoundingClientRect(); const f = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)); const t = f * dur;
      if (d.loop && (t < d.loop[0] || t > d.loop[1])) { d.loop = null; d.loopBeats = 0; S[k].loop = null; S[k].loopBeats = 0; }
      try { d.el.currentTime = t; } catch (_) {}
      if (S[k].playing) S[k].start = Date.now() - t * 1000; else S[k].pos = t;
      paintCues(k); peaks(k); };
    // scroll gate (owner, 2026-10-29; LAW 22, 2026-10-30): the wave no
    // longer seeks on touch-down — the seek waits until pressIntent calls
    // the gesture a control move, and a scroll verdict drops the press for
    // good, so a scroll veering sideways can never scrub the song. It then
    // seeks to the current pointer spot and scrubs on as before. A vertical
    // scroll starting on the wave just scrolls the page (pan-y) and a
    // pointercancel abandons the press; a clean tap still seeks, on release.
    let pend = null;
    cv.addEventListener("pointerdown", (e) => { if (!OWNER()) return; pend = { x: e.clientX, y: e.clientY, id: e.pointerId }; e.preventDefault(); });
    cv.addEventListener("pointermove", (e) => { if (pend && !scrub) { if (!e.buttons) { pend = null; return; } const intent = pressIntent(pend, e); if (intent === "scroll") { pend = null; return; } if (intent !== "control") return; scrub = true; try { cv.setPointerCapture(pend.id); } catch (_) {} seekTo(e); pend = null; } if (scrub) seekTo(e); });
    cv.addEventListener("pointerup", (e) => { if (pend) { pend = null; seekTo(e); save(true); return; } if (scrub) { scrub = false; save(true); } });
    cv.addEventListener("pointercancel", () => { pend = null; scrub = false; });
  });
  $("#dj-golive").addEventListener("change", (e) => { S.live = e.target.checked; S.liveSince = S.live ? Date.now() : 0; save(true); paintOwner(); paintStation(); say(S.live ? "You're live. Everyone on the radio hears your mix." : "Live DJ set ended.");
    // Auto-DJ is the station's play method: if nothing is playing it starts the rotation itself,
    // and it primes the idle deck so the first crossfade is ready
    if (S.live && S.autodj) {
      const playing = ["A", "B"].find((k) => S[k].playing);
      if (!playing) { const item = queue.length ? queue.shift() : nextFromLibrary(); if (item) { saveQueue(); paintQueue(); load("A", item).then(() => togglePlay("A")); } }
      else { const idle = playing === "A" ? "B" : "A"; if (!okUrl(S[idle].src)) { const item = queue.length ? queue[0] : nextFromLibrary(); if (item && !queue.length) bag.push(item); if (item) load(idle, item); } }
    }
  });
  // scratch / scrub: drag a platter sideways — the song position follows the
  // hand AND the hand makes a scratch noise (owner ask, 2026-10-26). The deck
  // element is paused while scrubbing, so the track itself stays silent; the
  // noise is a synthesized vinyl bed (looped noise through a bandpass whose
  // pitch and volume ride the hand speed) on the master bus — the booth hears
  // it and show recordings keep it. YouTube decks scrub coarsely (their player
  // seeks in chunks) but get the same noise, so every disc answers the hand.
  let scrBed = null;
  let JOGF = 0.09; try { JOGF = parseFloat(localStorage.getItem("mw-jogf") || "0.09") || 0.09; } catch (_) {}
  const scratchBed = () => { const c = (typeof actx === "function") ? actx() : ctx; if (!c || !masterIn) return null; if (scrBed) return scrBed; try { const len = 2 * c.sampleRate, buf = c.createBuffer(1, len, c.sampleRate), ch = buf.getChannelData(0); for (let i = 0; i < len; i++) ch[i] = Math.random() * 2 - 1; const src = c.createBufferSource(); src.buffer = buf; src.loop = true; const bp = c.createBiquadFilter(); bp.type = "bandpass"; bp.frequency.value = 900; bp.Q.value = 1.1; const g = c.createGain(); g.gain.value = 0; src.connect(bp); bp.connect(g); g.connect(masterIn); src.start(); scrBed = { bp, g }; } catch (_) {} return scrBed; };
  const scratchSound = (vel) => { const s = scratchBed(); if (!s || !ctx) return; const v = Math.min(1, Math.abs(vel) / 1.6), t = ctx.currentTime; s.g.gain.setTargetAtTime(v * (grainSess ? 0.1 : 0.38), t, 0.012); s.bp.frequency.setTargetAtTime(450 + v * 1600, t, 0.02); };
  const scratchStop = () => { if (scrBed && ctx) scrBed.g.gain.setTargetAtTime(0, ctx.currentTime, 0.06); };
  // the REAL scratch for his own files (top-tier build, 2026-10-26): decode the
  // track once into memory, then while the hand drags, fire short grains of the
  // actual song at the hand position — the slice start points step with the
  // hand, so forward, backward and baby scratches are the track itself, the
  // way pro systems resample at hand speed. YouTube decks keep the noise bed
  // (their audio can never be decoded). Grains ride the deck's own fader gain.
  const bufCache = new Map(); let grainSess = null;
  const deckBuffer = async (k) => { const d = deck(k); if (!d || d.shim || !d.src) return null; if (bufCache.has(d.src)) return bufCache.get(d.src); const c = (typeof actx === "function") ? actx() : ctx; if (!c) return null; try { const r = await fetch(d.src); const ab = await r.arrayBuffer(); const buf = await c.decodeAudioData(ab); if (buf.duration > 900) return null; bufCache.set(d.src, buf); if (bufCache.size > 2) bufCache.delete(bufCache.keys().next().value); return buf; } catch (_) { return null; } };
  const grainStart = (k) => { const d = deck(k), c = ctx; if (!c || !masterIn || grainSess || !d || d.shim) return; const buf = bufCache.get(d.src); if (!buf) return; try { const bus = c.createGain(); bus.gain.value = 0; bus.connect(d.gain || masterIn); bus.gain.setTargetAtTime(1, c.currentTime, 0.03); grainSess = { k, bus, timer: setInterval(() => { const dd = deck(k); if (!dd) return; const pos = dd.el.currentTime || 0, vel = Math.max(0.35, Math.min(2, Math.abs(dd.scrVel || 0) || 0.8)); const g = c.createBufferSource(); g.buffer = buf; g.playbackRate.value = vel; const e = c.createGain(), t = c.currentTime; e.gain.setValueAtTime(0, t); e.gain.linearRampToValueAtTime(0.85, t + 0.02); e.gain.linearRampToValueAtTime(0, t + 0.1); g.connect(e); e.connect(bus); try { g.start(t, Math.max(0, Math.min(buf.duration - 0.15, pos))); g.stop(t + 0.12); } catch (_) {} }, 25) }; } catch (_) {} };
  const grainStop = () => { if (!grainSess) return; const s = grainSess; grainSess = null; clearInterval(s.timer); try { s.bus.gain.setTargetAtTime(0, ctx.currentTime, 0.03); setTimeout(() => { try { s.bus.disconnect(); } catch (_) {} }, 200); } catch (_) {} };
  DECKS.forEach((k) => {
    const pl = () => $("#pl-" + k); let drag = null, pend = null;
    // scroll gate (owner, 2026-10-29; LAW 22, 2026-10-30): the platter no
    // longer pauses on touch-down — a press only arms the scratch, and the
    // scratch (pause, grain, noise bed) starts when pressIntent calls the
    // gesture a control move. A scroll verdict drops the armed press for
    // good: a scroll that veers sideways mid-page can never grab the disc.
    // A vertical scroll starting on the platter scrolls the page (pan-y).
    // A clean tap left no trace before either (down paused, up resumed at
    // the same spot, slip shadow included — the song ends up where it
    // would have played to), so a gated tap simply does nothing.
    const beginScratch = (e) => { drag = { x: e.clientX, t: performance.now(), at: performance.now(), pos: deck(k).el.currentTime || 0, was: !deck(k).el.paused }; deck(k).el.pause(); scratchBed(); deckBuffer(k).then(() => { if (drag) grainStart(k); }); if (bufCache.has(deck(k).src)) grainStart(k); };
    onMain("pointerdown", (e) => { if (e.target !== pl() || !OWNER()) return; pend = { x: e.clientX, y: e.clientY }; e.preventDefault(); });
    onMainRaw("pointermove", (e) => { if (pend && !drag) { if (!e.buttons) { pend = null; return; } const intent = pressIntent(pend, e); if (intent === "scroll") { pend = null; return; } if (intent !== "control") return; beginScratch(e); pend = null; } if (!drag) return; const d = deck(k), now = performance.now(), dx = e.clientX - drag.x, dt = Math.max(1, now - drag.t); drag.x = e.clientX; drag.t = now; try { d.el.currentTime = Math.max(0, Math.min((d.el.duration || 0) - 0.2, d.el.currentTime + dx * JOGF)); } catch (_) {} if (S[k]) S[k].pos = d.el.currentTime; d.scrVel = (d.scrVel || 0) * 0.55 + (Math.abs(dx * JOGF) / (dt / 1000)) * 0.45; scratchSound(dx / dt); });
    onMainRaw("pointerup", () => { if (pend) { pend = null; return; } if (!drag) return; grainStop(); scratchStop(); const d = deck(k); if (drag.was && d.slip) { const sh = drag.pos + (performance.now() - drag.at) / 1000 * (S[k].rate || 1); try { d.el.currentTime = Math.max(0, Math.min((d.el.duration || 1e9) - 0.3, sh)); } catch (_) {} } if (drag.was) { d.el.play().catch(() => {}); if (S[k].playing) S[k].start = Date.now() - d.el.currentTime * 1000; } else if (S[k]) S[k].pos = d.el.currentTime; drag = null; save(true); });
    // LAW 22: a pointercancel means the browser took the gesture away (a
    // page scroll) — an interrupted scratch is undone as if it never
    // happened: a playing deck lands where the song would have played to
    // and resumes; a paused deck returns to the exact spot it was grabbed.
    onMainRaw("pointercancel", () => { pend = null; if (!drag) return; grainStop(); scratchStop(); const d = deck(k); if (drag.was) { const sh = drag.pos + (performance.now() - drag.at) / 1000 * (S[k].rate || 1); try { d.el.currentTime = Math.max(0, Math.min((d.el.duration || 1e9) - 0.3, sh)); } catch (_) {} d.el.play().catch(() => {}); if (S[k].playing) S[k].start = Date.now() - d.el.currentTime * 1000; } else { try { d.el.currentTime = drag.pos; } catch (_) {} if (S[k]) S[k].pos = drag.pos; } drag = null; save(true); });
  });
  // deck ended -> owner bookkeeping + Auto-DJ
  // dead-air guard: a deck that runs out (or stalls at the end) while the station is
  // LIVE hands over automatically — listener pick first, then the queue, then the mix —
  // even with Auto-DJ switched off, because a live set should never just stop
  function deckEnded(k) {
    // The booth LEAD owns the advance even when this same tab is also
    // listening to the station: gating on listening alone can leave a lead
    // booth unable to end or roll a deck while the keeper stands down for
    // its fresh heartbeat (2026-10-28, the song that ended and rolled nothing).
    if (!OWNER() || (listening && !boothLead) || !S[k].playing) return;
    brainClose(k, "ended"); // PR-B2: classify by position vs duration BEFORE the deck state is wiped — a full play is an end, an early vskip through this same door is a skip
    S[k].playing = false; S[k].pos = 0; lastEndedK = k; paintOwner(); save(true);
    // Only Auto-DJ picks songs by itself. With Auto-DJ off the DJ is in charge: a deck that ends just stops
    // (owner, 2026-10-27: "it keeps forcing songs to change").
    // Another deck flagged playing blocks the roll only when it is genuinely
    // mid-song — a corpse flag (playing, but already past its own end) must
    // never veto the next song.
    if (S.live && (S.autodj || queue.length) && !DECKS.some((x) => S[x].playing && !(+S[x].dur > 0 && posOf(x) > +S[x].dur + 15))) { say("⏭️ Deck " + k + " ended — rolling the next song."); autoNext(k, true); }
  }
  DECKS.forEach((k) => { deck(k).onEnded = () => deckEnded(k); });

  /* ---------- Auto-DJ queue ---------- */
  let queue = []; try { queue = JSON.parse(localStorage.getItem("mw-dj-queue") || "[]"); } catch (_) {}
  const saveQueue = () => { try { localStorage.setItem("mw-dj-queue", JSON.stringify(queue)); } catch (_) {} if (OWNER() && !SANDBOX) { S.queue = queue.slice(); save(); } };
  /* The queue also lives in the shared station state (S.queue) so the 24/7
     keeper can play HIS set after he closes the booth (owner, 2026-10-27:
     "make my dj session continue even if im not on"). When state arrives with
     a queue that differs from this window's — the keeper played some of it, or
     his other booth window changed it — adopt the server's truth. */
  function adoptQueue(d) { if (!d || !Array.isArray(d.queue)) return; if (JSON.stringify(d.queue) === JSON.stringify(queue)) return; queue = d.queue.slice(); try { localStorage.setItem("mw-dj-queue", JSON.stringify(queue)); } catch (_) {} paintQueue(); }
  function paintQueue() { const rich = $("#dj-queue"); if (rich) rich.innerHTML = queue.length ? queue.map((q, i) => `<div class="dj-item"><span title="${E(q.title || "")}">${i + 1}. ${q.yt ? "🎬 " : ""}${E(q.title || "")}</span><button class="btn ghost sm" type="button" data-qup="${i}" aria-label="Move up">▲</button><button class="btn ghost sm" type="button" data-qdn="${i}" aria-label="Move down">▼</button><button class="btn ghost sm" type="button" data-qdel="${i}">✕</button></div>`).join("") : '<small class="muted">Nothing queued — tap ＋Q on any song or video and it plays next, in order.</small>'; const box = $("#ad-queue"); if (box) box.innerHTML = queue.length ? queue.map((q, i) => `<div class="dj-item"><span title="${E(q.title || "")}">${i + 1}. ${E(q.title || "")}</span><button class="btn ghost sm" type="button" data-qdel="${i}">✕</button></div>`).join("") : '<small class="muted">Queue is empty — Auto-DJ pulls from the full library rotation.</small>'; }
  onMain("click", (e) => { const b = e.target.closest("[data-qdel],[data-qup],[data-qdn]"); if (!b) return; if (b.dataset.qdel != null) queue.splice(+b.dataset.qdel, 1); else if (b.dataset.qup != null) { const i = +b.dataset.qup; if (i > 0) { const t = queue[i - 1]; queue[i - 1] = queue[i]; queue[i] = t; } } else if (b.dataset.qdn != null) { const i = +b.dataset.qdn; if (i < queue.length - 1) { const t = queue[i + 1]; queue[i + 1] = queue[i]; queue[i] = t; } } saveQueue(); paintQueue(); });
  /* playlists: name a queue and keep it (owner ask, 2026-10-27 — "que that
     list or make a play list") */
  let playlists = []; try { playlists = JSON.parse(localStorage.getItem("mw-dj-playlists") || "[]"); } catch (_) {}
  const savePlaylists = () => { try { localStorage.setItem("mw-dj-playlists", JSON.stringify(playlists)); } catch (_) {} };
  let plOpen = false;
  function paintPlaylists() { const box = $("#dj-playlists"); if (box) box.innerHTML = !plOpen ? "" : (playlists.length ? playlists.map((p, i) => `<div class="dj-item"><span title="${E(p.name || "")}">📂 ${E(p.name || "")} <small class="muted">${(p.items || []).length} in line</small></span><button class="btn ghost sm" type="button" data-plload="${i}">Load</button><button class="btn ghost sm" type="button" data-pladd="${i}">＋ Add</button><button class="btn ghost sm" type="button" data-pldel="${i}">✕</button></div>`).join("") : '<small class="muted">No playlists saved yet — build a queue and tap 💾 Save as playlist.</small>'); paintSchedSel(); }
  function paintSchedSel() { const sel = $("#sched-sel"); if (!sel) return; const cur = sel.value; sel.innerHTML = playlists.length ? playlists.map((p, i) => `<option value="${i}">${E(p.name || "")} (${(p.items || []).length})</option>`).join("") : '<option value="">Save a playlist first</option>'; if (cur !== "" && playlists[+cur]) sel.value = cur; }
  /* ---------- schedule: what plays when (owner ask, 2026-10-27) ----------
     Entries live in this browser AND in the station/schedule doc, which the
     station keeper reads — so a scheduled playlist runs even with the booth
     closed (file items there; video items join in when the booth is open). */
  let sched = []; try { sched = JSON.parse(localStorage.getItem("mw-dj-sched") || "[]"); } catch (_) {}
  const saveSchedLocal = () => { try { localStorage.setItem("mw-dj-sched", JSON.stringify(sched)); } catch (_) {} };
  const saveSched = () => { saveSchedLocal(); try { const d = DBF(); if (d) d.doc("station/schedule").set({ entries: sched, updatedAt: Date.now() }).catch(() => {}); } catch (_) {} };
  function paintSched() { const box = $("#dj-sched-list"); if (box) box.innerHTML = sched.length ? sched.map((en, i) => `<div class="dj-item"><span>🕐 ${E(en.time || "")} — 📂 ${E(en.name || "")} <small class="muted">${(en.items || []).length} in line · every day</small></span><button class="btn ghost sm" type="button" data-sdel="${i}">✕</button></div>`).join("") : '<small class="muted">Nothing scheduled — the station runs its normal mix.</small>'; paintSchedSel(); }
  const etHM = () => { try { const p = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour12: false, hour: "2-digit", minute: "2-digit" }).formatToParts(new Date()); const g = (t) => (p.find((x) => x.type === t) || {}).value || "00"; return g("hour").padStart(2, "0") + ":" + g("minute").padStart(2, "0"); } catch (_) { return ""; } };
  const etDay = () => { try { return new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date()); } catch (_) { return ""; } };
  function fireSched(en) { queue = (en.items || []).slice(); saveQueue(); paintQueue(); say("📅 Schedule: " + (en.name || "playlist") + " is up — " + queue.length + " in line."); if (queue.length && !DECKS.some((k) => S[k].playing)) { const it = queue.shift(); saveQueue(); paintQueue(); load("A", it).then(() => togglePlay("A")); } }
  setInterval(() => { if (!OWNER() || !leadDrive() || !sched.length) return; const hm = etHM(), day = etDay(); if (!hm || !day) return; let fired = {}; try { fired = JSON.parse(localStorage.getItem("mw-dj-sched-fired") || "{}"); } catch (_) {} sched.forEach((en) => { const key = en.id + "@" + day; if (en.time === hm && fired[key] !== 1) { fired[key] = 1; try { localStorage.setItem("mw-dj-sched-fired", JSON.stringify(fired)); } catch (_) {} fireSched(en); } }); }, 20000);
  let schedDocTried = false;
  function loadSchedDoc() { if (schedDocTried || !OWNER()) return; schedDocTried = true; try { const d = DBF(); if (!d) { schedDocTried = false; return; } d.doc("station/schedule").get().then((doc) => { const e = doc && doc.exists && doc.data() && doc.data().entries; if (Array.isArray(e)) { sched = e; saveSchedLocal(); paintSched(); } }).catch(() => {}); } catch (_) {} }
  /* the library rotation: a shuffled bag of the whole library, refilled when it runs out —
     this is what the station plays on Auto-DJ when the hand-picked queue is empty */
  let bag = [], lastTitle = "";
  function nextFromLibrary() {
    if (!bag.length) { bag = TRACKS().map((t) => ({ src: URLOF(t), title: t.title, cover: t.cover || "", dur: +t.duration || 0 })).filter((x) => okUrl(x.src)); for (let i = bag.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [bag[i], bag[j]] = [bag[j], bag[i]]; } }
    if (!bag.length) return null;
    let item = bag.pop();
    if (item.title === lastTitle && bag.length) { const other = bag.pop(); bag.push(item); item = other; }
    lastTitle = item.title;
    return item;
  }
  /* the mixed rotation, booth side: alternate Meechie's own tracks with real-artist
     music from the Archive pool — like a real station, not just his catalog */
  let mixFlip = false, poolCache = null;
  async function nextFromPool() {
    if (!poolCache) poolCache = await iaMulti(['creator:"Johnny Cash"', 'creator:"Miles Davis"', 'creator:"Grateful Dead"', 'creator:"James Brown"', 'creator:"Bob Marley"', 'creator:"Duke Ellington"', 'creator:"John Coltrane"', '"hip hop" mixtape', '"soul" "live"', '"rock" "live" concert', '"reggae" "live"', '"jazz" "live"']);
    for (let tries = 0; tries < 3 && poolCache && poolCache.length; tries++) {
      const n = poolCache[Math.floor(Math.random() * poolCache.length)];
      const src = await iaFile(n.id);
      if (src) return { src, title: n.title, cover: "https://archive.org/services/img/" + encodeURIComponent(n.id), dur: 0 };
    }
    return null;
  }
  let xfAnim = null, adTimer = null, handoverBusy = false, handoverAt = 0, lastEndedK = "A", deadAirAt = 0, preLoad = null, xfTouchedAt = 0;
  const usedPicks = new Set((() => { try { return JSON.parse(localStorage.getItem("mw-dj-usedpicks") || "[]"); } catch (_) { return []; } })());
  /* YouTube age / embed lock (owner, 2026-10-29: the age walls keep
   * stopping his videos — he is 36; the wall is YouTube's own and no
   * site player can prove an age, so the booth stops sitting on it):
   * when a deck player reports error 100, 101 or 150 (gone, or the
   * embed / age restriction YouTube documents under 101 and 150), the
   * video is remembered in a persistent skip-set, automation treats
   * the deck as a failed start and rolls on, and no draw ever hands
   * the booth that video again. Only a real player error marks a
   * video — a slow load never does. */
  function ageSkipSet() { try { return new Set(JSON.parse(localStorage.getItem("mw-dj-ageskip") || "[]")); } catch (_) { return new Set(); } }
  const ageSharedSent = new Set();
  /* fix-3 write side (2026-10-29): a local 100/101/150 conviction also
   * reports the id to the shared ban list (POST /api/brain/block, which
   * appends to the brain/ytblock doc) so the search relay can drop the
   * video for every device, not just this one. Fire-and-forget on the
   * house session pattern: no session = silence, any failure = silence,
   * at most one POST per id per page session, and nothing here may
   * ever throw into the deck error path that called ageMarkLocked. */
  function ageShareBlock(id) {
    try {
      if (!id || ageSharedSent.has(id)) return;
      const ses = mySess(), tok = ses && ses.access_token;
      if (!tok) return;
      ageSharedSent.add(id);
      fetch("/api/brain/block", { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer " + tok }, body: JSON.stringify({ id }) }).catch(() => {});
    } catch (_) {}
  }
  function ageMarkLocked(tok) { const vp = vparseTok(tok || ""); if (vp.p !== "yt" || !vp.id) return; const s = ageSkipSet(); if (s.has(vp.id)) return; s.add(vp.id); try { localStorage.setItem("mw-dj-ageskip", JSON.stringify([...s].slice(-300))); } catch (_) {} ageShareBlock(vp.id); }
  function ageIsLocked(tok) { const vp = vparseTok(tok || ""); return vp.p === "yt" && !!vp.id && ageSkipSet().has(vp.id); }
  /* Search side of the same lock (fix-search-filter, 2026-10-29): the
   * relay now drops age / embed-gated videos server-side before they are
   * offered, and this drops the ones this device has already caught — a
   * video a deck player ever refused (errors 100/101/150, marked into
   * mw-dj-ageskip by the shim's onError) never comes back in this
   * booth's search results. Applied inside ytPage, so the relay path,
   * the direct fallback path, MORE RESULTS and the After Hours shelves
   * are all covered by the same two return points. */
  function ytUnblocked(list) { try { const s = ageSkipSet(); if (!s.size || !Array.isArray(list)) return list; return list.filter((it) => !it || !it.id || !s.has(it.id)); } catch (_) { return list; } }
  const ageSaid = new Set();
  function ageNote(it) { const id = (it && it.yt) || ""; if (!id || ageSaid.has(id)) return; ageSaid.add(id); say("That video is age-locked by YouTube — it cannot play inside the site, so it is out of the picks for next time."); }
  /* drawQueueItem: ONLY the queue draw out of pickNextItem — the
   * owner's shuffle rule (2026-10-28): pick at random and remove it, so
   * nothing repeats until the queue empties. No listener picks, no
   * pool, no library. The draw mutates the queue array; the caller owns
   * saveQueue() + paintQueue() afterwards. Age-locked videos are drawn
   * out and dropped instead of returned — the caller's saveQueue() +
   * paintQueue() upkeep persists the shorter queue. */
  function drawQueueItem() {
    while (queue.length) { const qi = Math.floor(Math.random() * queue.length); const it = queue.splice(qi, 1)[0]; if (it && it.yt && ageIsLocked(it.yt)) { ageNote(it); continue; } brainDraw(it); return it; }
    return null;
  }
  /* pickNextItem: what plays next, in the booth's order — a listener pick
   * first (played once, then deleted), then the queue (shuffled: drawn at
   * random and removed, no repeats until it empties), then, with Auto-DJ
   * on, the pool and the library rotation. Null when nothing is available. */
  async function pickNextItem() {
    let item = null;
    const pick = reqCache.filter((r) => r.data && r.data.kind === "pick" && !usedPicks.has(r.id)).sort((a, b) => (a.data.at || 0) - (b.data.at || 0))[0];
    if (pick) {
      // a pick plays once, even if deleting its request fails (it used to come back on every handover)
      usedPicks.add(pick.id); try { localStorage.setItem("mw-dj-usedpicks", JSON.stringify([...usedPicks].slice(-200))); } catch (_) {}
      if (pick.data.src && okUrl(pick.data.src)) item = { src: pick.data.src, title: pick.data.title || "", cover: pick.data.cover || "", dur: pick.data.dur || 0 };
      else if (pick.data.iaId) { const src = await iaFile(pick.data.iaId); if (src) item = { src, title: pick.data.title || "", cover: "https://archive.org/services/img/" + encodeURIComponent(pick.data.iaId) }; }
      DBF()?.doc("requests/" + pick.id).delete().catch(() => {});
      if (item) say("🎵 Listener pick up next: " + item.title);
    }
    // The queue SHUFFLES through the decks (owner, 2026-10-28): draw at
    // random and remove the pick, so nothing repeats until the queue is empty.
    if (!item) item = drawQueueItem();
    if (item && item.yt && ageIsLocked(item.yt)) { ageNote(item); item = null; } // defense in depth: a locked video never leaves this picker, whatever path produced it
    if (!item && !S.autodj) return null;
    if (!item) { mixFlip = !mixFlip; if (mixFlip) item = await nextFromPool(); if (!item) item = nextFromLibrary(); }
    return item;
  }
  /* Crossfader home (owner, 2026-10-29: "keep it centered... or make it
     follow whats playing automatically"): the fader RESTS at center. After
     an automated blend lands on a side, xfSettle eases it back to 0.5; and
     xfFollowGuard (booth tick, Auto-DJ on only) walks it back to center
     whenever a playing deck is left faded out (gain under 0.2 — the state
     that reads as "music aint playing"). His hand always wins: pad, arrow
     keys and MIDI all stamp xfTouchedAt — a blend that began after his
     last touch never settles, and the guard stands down for 8s a touch. */
  function xfSettle(key, touch0) {
    if (xfTouchedAt > (touch0 || 0)) return;
    const from = S[key] ?? 0.5; if (Math.abs(from - 0.5) < 0.01) return;
    const t0 = performance.now();
    clearInterval(xfAnim); xfAnim = setInterval(() => { const p = Math.min(1, (performance.now() - t0) / 2200); S[key] = from + (0.5 - from) * p; levels(); paintXfPads(); if (p >= 1) { clearInterval(xfAnim); xfAnim = null; save(true); } }, 100);
  }
  /* xfSettle for a cross-pair blend: BOTH faders ease home to center
   * together — same 2.2s glide, same hands-off rule (a touch after the
   * blend began cancels the settle) as the single-fader xfSettle. */
  function xfSettleKeys(keys, touch0) {
    if (xfTouchedAt > (touch0 || 0)) return;
    const froms = keys.map((key) => S[key] ?? 0.5);
    if (froms.every((f) => Math.abs(f - 0.5) < 0.01)) return;
    const t0 = performance.now();
    clearInterval(xfAnim); xfAnim = setInterval(() => { const p = Math.min(1, (performance.now() - t0) / 2200); keys.forEach((key, i) => { S[key] = froms[i] + (0.5 - froms[i]) * p; }); levels(); paintXfPads(); if (p >= 1) { clearInterval(xfAnim); xfAnim = null; save(true); } }, 100);
  }
  function xfFollowGuard() {
    if (!OWNER() || !leadDrive() || !S.autodj || xfAnim || Date.now() - xfTouchedAt < 8000) return;
    [["xf", "A", "B"], ["xf2", "C", "D"]].forEach(([key, a, b]) => {
      if (xfAnim) return;
      const pa = !!S[a].playing, pb = !!S[b].playing;
      if (pa === pb) return;
      const k = pa ? a : b, x = S[key] ?? 0.5;
      if (xfGain(x, k === "B" || k === "D" ? "B" : "A") >= 0.2) return;
      const from = x, t0 = performance.now();
      xfAnim = setInterval(() => { const p = Math.min(1, (performance.now() - t0) / 1200); S[key] = from + (0.5 - from) * p; levels(); paintXfPads(); if (p >= 1) { clearInterval(xfAnim); xfAnim = null; save(true); } }, 100);
    });
    // THE X LAW rescue, same hands-off spirit: if the ONLY deck playing
    // sits on the pair the parked X has silenced (pair gain under 0.2
    // while its own pair fader would pass it), the station would be
    // silent under Auto-DJ — ease the X home to center. Layered play
    // (decks on both pairs) never triggers it: a parked X with decks
    // playing on the favored pair is the owner's mix, not a stranding.
    if (xfAnim) return;
    const px = S.panX ?? 0.5;
    if (Math.abs(px - 0.5) < 0.01) return;
    const playing = DECKS.filter((k) => S[k].playing);
    if (playing.length !== 1) return;
    const k = playing[0], cd = k === "C" || k === "D";
    if (pairXGain(px, cd) >= 0.2) return;
    const x = cd ? (S.xf2 ?? 0.5) : S.xf;
    if (xfGain(x, k === "B" || k === "D" ? "B" : "A") < 0.2) return; // the pair fader owns that silence — the loop above handles it
    const from = px, t0 = performance.now();
    xfAnim = setInterval(() => { const p = Math.min(1, (performance.now() - t0) / 1200); S.panX = from + (0.5 - from) * p; levels(); paintXfPads(); if (p >= 1) { clearInterval(xfAnim); xfAnim = null; save(true); } }, 100);
  }
  /* qKeyOf: the content key for "what is on this deck", applied to
   * BOTH the deck state and the stock record so the two sides always
   * meet in the same form: file items key on their src; video items
   * key on the bare video ID for YouTube (a queue token, a pasted
   * watch URL and the stored state all land on the same key) or on
   * their prefixed token (dm: / vm:) for the other providers. */
  const qKeyOf = (src, yt) => { if (src) return "s:" + src; const vp = vparseTok(yt || ""); if (!vp.id) return ""; return vp.p === "yt" ? "y:" + (ytParse(vp.id) || vp.id) : vp.p + ":" + vp.id; };
  /* qStockValid: a stocked record counts only while the deck still
   * holds exactly that item (same content key) and is not playing —
   * anything else means the deck changed hands and the record is void. */
  function qStockValid(k) { const r = qStock[k]; if (!r || S[k].playing) return false; const a = qKeyOf(S[k].src || "", S[k].yt || ""), b = qKeyOf(r.src || "", r.yt || ""); return !!a && a === b; }
  /* stockDeck: the cued load — the exact pattern the booth tick's
   * preload uses (load, then for a video mount the player and pause it
   * while the deck is not flagged playing), then record the deck as
   * stocked with this item. */
  async function stockDeck(k, item) {
    if (item && item.yt && ageIsLocked(item.yt)) { qClear(k); ageNote(item); return; } // a locked video is never stocked
    try { await load(k, item); if (item.yt) { const dp = decks[k]; if (dp) { await dp.setYt(item.yt); if (!S[k].playing && dp.el) { try { dp.el.pause(); } catch (_) {} } } } } catch (_) {}
    if (item && item.yt && decks[k] && decks[k].shim && decks[k].shim._locked) { qClear(k); return; } // it locked while loading cued — do not stock a dead deck
    qSet(k, item);
  }
  /* Play the queue (owner, 2026-10-29: "Load the next 4 queue songs
   * onto A, B, C, D right away"): draw up to four queue items and stock
   * them onto the decks in order. A deck that is playing is never
   * stomped — it refills when it ends (see autoNext). From a cold booth
   * deck A takes the first draw as a station flow and STARTS it — that
   * is playing the queue; B, C, D load cued. If something is already on
   * air, every free deck (A included) just loads cued and the rotation
   * in autoNext rolls them in as decks finish. Live booth only — the
   * Playground keeps the old single-deck play. */
  async function playQueueStock() {
    qSyncFromS();
    const stocked = []; let startedK = null;
    const anyPlaying = DECKS.some((k) => S[k].playing);
    for (const k of DECKS) {
      if (!queue.length) break;
      if (S[k].playing) continue;
      const it = drawQueueItem(); if (!it) break;
      if (k === "A" && !anyPlaying) {
        try { await load("A", it); await togglePlay("A"); } catch (_) {}
        if (S.A.playing && decks.A && decks.A.shim && decks.A.shim._locked) { try { decks.A.el.pause(); } catch (_) {} S.A.playing = false; } // age / embed locked: flagged playing but the player can never roll
        if (S.A.playing) startedK = "A";
        else if (decks.A && decks.A.shim && decks.A.shim._locked) { /* locked on its first load — already out of the queue; never stocked */ }
        else { qSet("A", it); stocked.push("A"); } // loaded but would not start — leave it stocked cued like the others
      } else { await stockDeck(k, it); if (qStock[k]) stocked.push(k); }
    }
    saveQueue(); paintQueue();
    if (!boothLead && (startedK || stocked.length)) say("🎶 Queue is on the decks (" + [startedK].concat(stocked).filter(Boolean).join(" ") + ") — this screen is the mirror, so the records went to the shared station and the screen driving the sound rolls them through all four decks.");
    else if (startedK) say("🎶 Queue on the decks — A playing" + (stocked.length ? ", " + stocked.join(" ") + " loaded and ready" : "") + ".");
    else if (stocked.length) say("🎶 Queue loaded onto the decks — " + stocked.join(" ") + " ready, and they roll in as each deck finishes.");
    else say("🎶 Every deck is playing — each one refills from the queue as it finishes.");
  }
  /* The station drop rotation (owner, 2026-10-29 — the welcome line is
   * his own dictation): one line at a time, in this order, cycling. */
  const DROP_TEXTS = [
    "Welcome to Meechie's World. You are now tuned in to the live DJ. Please stay tuned in — make sure you put in your song that you want to hear, and we'll play it as soon as possible.",
    "Go check out the shop at Meechies World Inc dot com — new drops and fresh gear. More than clothing, it is a movement.",
    "Pull up Meechie's Book and say what's up — the community is live right now.",
    "Take the radio with you — get the Meechie's World apps and listen anywhere.",
    "Feeling lucky? The Coin Jackpot is open — play fair, win real coins."
  ];
  async function autoNext(endedK, force, fadeMs) {
    if ((!S.autodj && !force) || !leadDrive()) return;
    // A handover that died mid-flight (an unsettled load or play promise)
    // must not hold this latch forever: one older than 20s is stuck, and
    // this call takes over (2026-10-28: a stuck latch meant the song ended
    // and nothing ever rolled again).
    if (handoverBusy && Date.now() - handoverAt < 20000) return; handoverBusy = true; handoverAt = Date.now();
    let target = PAIR[endedK] || "A";
    /* Station voice drops (owner, 2026-10-29): every 3rd AUTOMATED
     * transition speaks ONE line from the drop rotation over the join.
     * The counters live in S (dropN / dropIx, normalized in mergeState)
     * so every screen agrees on the cadence and a refresh does not
     * reset it. A drop REPLACES the pads[0] station ID on its
     * transition — one voice at a time, his words. Manual moves never
     * reach autoNext, so they never count and never fire. */
    let dropFired = false;
    if (!SANDBOX && S.dropsOn !== false) {
      S.dropN = (S.dropN || 0) + 1;
      if (S.dropN % 3 === 0) { const ix = (S.dropIx || 0) % DROP_TEXTS.length; S.dropIx = ix + 1; S.voice = { id: "drop" + ix + "-" + Date.now(), text: DROP_TEXTS[ix], at: Date.now() }; dropFired = true; }
    }
    if (!dropFired) { const idPad = (S.pads || [])[0]; if (idPad && okUrl(idPad.url)) { S.voice = { id: idPad.id, url: idPad.url, at: Date.now() }; } }
    // Stocked rotation (live booth only, owner 2026-10-29): when decks
    // hold cued queue items (Play the queue, or the refill below), the
    // next deck in rotation A→B→C→D→A after the ended one that holds a
    // stocked item goes FIRST — already loaded, so this is play + fade
    // only, no pick and no load. Each stocked try spends from the same
    // 4-attempt budget as the pick path below; if no stocked deck
    // starts, target stays the pair deck and the pick path runs exactly
    // as before (preload fast-path included).
    let started = false, attempts = 0;
    if (!SANDBOX) {
      let cand = ROT[endedK];
      for (let step = 0; step < 3 && !started && attempts < 4; step++) {
        if (qStockValid(cand)) {
          if (ageIsLocked((qStock[cand] || {}).yt || "")) { qClear(cand); } // locked while it sat cued — void the record without spending an attempt; the refill draw replaces it
          else {
            attempts++;
            try { await togglePlay(cand); } catch (_) {}
            started = !!S[cand].playing;
            if (started && decks[cand] && decks[cand].shim && decks[cand].shim._locked) { try { decks[cand].el.pause(); } catch (_) {} S[cand].playing = false; started = false; } // age / embed locked: flagged playing, but the player can never roll — a failed start
            if (started) target = cand; else say("⏭ That one would not play — rolling the next.");
            qClear(cand); // started (record served its purpose) or would not play (record is void)
          }
        }
        cand = ROT[cand];
      }
    }
    // A preloaded pair deck (loaded during the last 15 seconds, see the
    // booth tick) skips the pick and the load entirely — play and fade only.
    let preItem = null;
    if (preLoad && preLoad.item && preLoad.target === target && (S[target].yt || "") === (preLoad.item.yt || "") && (S[target].src || "") === (preLoad.item.src || "") && !(preLoad.item.yt && ageIsLocked(preLoad.item.yt))) { preItem = preLoad.item; preLoad = null; }
    // Pick, load, play — then CHECK the deck actually started. One
    // unplayable pick (an embed-blocked video, a player that will not
    // mount in this tab) used to eat the whole transition silently: the
    // horn stamped, the fade animated, nothing played, and the booth
    // burned one item every 20 seconds without making a sound (the
    // 2026-10-28 13:58 dead air: three silent minutes, full queue). A
    // failed start now rolls straight to the next candidate, up to 4.
    for (let attempt = attempts; attempt < 4 && !started; attempt++) {
      const item = attempt === 0 && preItem ? preItem : await pickNextItem();
      if (!item) break;
      if (!(attempt === 0 && preItem)) { saveQueue(); paintQueue(); try { await load(target, item); } catch (_) {} }
      try { await togglePlay(target); } catch (_) {}
      started = !!S[target].playing;
      if (started && decks[target] && decks[target].shim && decks[target].shim._locked) { try { decks[target].el.pause(); } catch (_) {} S[target].playing = false; started = false; } // age / embed locked: flagged playing, but the player can never roll — a failed start, roll on
      if (!started) say("⏭ That one would not play — rolling the next.");
    }
    if (started) {
      // Automated transition: stamp the horn so every audible client plays
      // the same pattern at the same moment, and play it here on the
      // driver. The stamp lands only on a REAL start — no more horns
      // over silence.
      if (S.hornOn === true) { S.fxHornAt = hornHeard = Date.now(); hornInit = true; hornStab(); } // horns OFF (owner, 2026-10-29): no stamp and no stab; when on, mark heard so an echo of this stamp does not horn again
      // The crossfade: every deck rides its pair fader — A/B on S.xf,
      // C/D on S.xf2 — toward the value where that deck is full and its
      // pair mate is silent (xfGain: A and C are full at 0, B and D at
      // 1). A same-pair handover animates the one shared fader, exactly
      // as before. A rotation handover across pairs (A ends, C starts)
      // animates BOTH faders in the same interval: the target's fader
      // rides to the target's full value while the ended deck's fader
      // rides to the ended deck's silent value. The other two decks are
      // not playing during a handover, so their gains moving changes
      // nothing heard. Afterwards every fader that moved settles back
      // to center (xfSettle / xfSettleKeys). THE X LAW rides along on a
      // cross-pair handover only: if the owner left the X (S.panX) parked
      // off center, the blend eases it home to center in the same
      // interval, so the incoming pair rises to full instead of landing
      // in the parked pair's silence; at center (the home) nothing about
      // the X moves and the blend is gain-identical to before the law.
      const fullAt = (k) => (k === "B" || k === "D") ? 1 : 0;
      const eKey = (endedK === "C" || endedK === "D") ? "xf2" : "xf", tKey = (target === "C" || target === "D") ? "xf2" : "xf";
      const moves = [{ key: tKey, from: S[tKey] ?? 0.5, to: fullAt(target) }];
      if (eKey !== tKey) { moves.push({ key: eKey, from: S[eKey] ?? 0.5, to: 1 - fullAt(endedK) }); if (Math.abs((S.panX ?? 0.5) - 0.5) > 0.01) moves.push({ key: "panX", from: S.panX ?? 0.5, to: 0.5 }); }
      const t0 = performance.now(), dur = Math.max(800, fadeMs || 3500);
      const touch0 = xfTouchedAt;
      clearInterval(xfAnim); xfAnim = setInterval(() => { const p = Math.min(1, (performance.now() - t0) / dur); moves.forEach((m) => { S[m.key] = m.from + (m.to - m.from) * p; }); levels(); paintXfPads(); if (p >= 1) { clearInterval(xfAnim); xfAnim = null; save(true); if (moves.length === 1) xfSettle(moves[0].key, touch0); else xfSettleKeys(moves.map((m) => m.key), touch0); } }, 100);
    }
    // Refill (live booth only): after a successful transition the deck
    // that just ended takes the next queue draw, cued and stocked, so
    // the rotation always has somewhere to go. The early-crossfade path
    // calls in while the ended deck is still flagged playing (its last
    // seconds are blending out), so when it is, the refill re-checks a
    // few seconds later once the deck has actually stopped. Every guard
    // is re-tested at fire time: not playing, not already stocked. The
    // re-check is a bounded retry, not a single shot (2026-10-29 audit:
    // one timer meant one transient miss — a video deck whose player
    // had not quite reported its end at that instant — lost the refill
    // forever, and the rotation decayed deck by deck back to the pair
    // path). The refill also never stomps a hand load: if the deck's
    // content changed since the transition, it is his, not the queue's.
    if (!SANDBOX && started && queue.length) {
      const endedKey = qKeyOf(S[endedK].src || "", S[endedK].yt || "");
      const refill = async () => { if (S[endedK].playing || qStockValid(endedK) || !queue.length) return; const ck = qKeyOf(S[endedK].src || "", S[endedK].yt || ""); if (ck && ck !== endedKey) return; const itR = drawQueueItem(); if (itR) { await stockDeck(endedK, itR); saveQueue(); paintQueue(); } };
      if (!S[endedK].playing) await refill();
      else [6500, 14000, 24000].forEach((ms) => setTimeout(() => { refill().catch(() => {}); }, ms));
    }
    handoverBusy = false; save(true);
  }

  /* ---------- pro DJ sounds: best of the free market (curated, verified) ---------- */
    const CURATED = [
    { id: "dj-puzzle-scratch-tactics", file: "Scratch Tactics/Mixed Scratches/Clean/Clean Mixed Sratch 02.mp3", name: "🎺 Clean Scratch 2", tag: "Scratch Tactics · scratch · public domain" },
    { id: "dj-puzzle-scratch-tactics", file: "Scratch Tactics/Mixed Scratches/Clean/Clean Mixed Sratch 01.mp3", name: "🎺 Clean Scratch 1", tag: "Scratch Tactics · scratch" },
    { id: "dj-puzzle-scratch-tactics", file: "Scratch Tactics/Mixed Scratches/Clean/Clean Mixed Sratch 03.mp3", name: "🎺 Clean Scratch 3", tag: "Scratch Tactics · scratch" },
    { id: "dj-puzzle-scratch-tactics", file: "Scratch Tactics/Mixed Scratches/Clean/Clean Mixed Sratch 05.mp3", name: "🎺 Clean Scratch 5", tag: "Scratch Tactics · scratch" },
    { id: "dj-puzzle-scratch-tactics", file: "Scratch Tactics/Mixed Scratches/Clean/Clean Mixed Sratch 04.mp3", name: "💿 Battle Scratch 4", tag: "Scratch Tactics · scratch · public domain" },
    { id: "dj-puzzle-scratch-tactics", file: "Scratch Tactics/Mixed Scratches/Clean/Clean Mixed Sratch 07.mp3", name: "💿 Battle Scratch 7", tag: "Scratch Tactics · scratch · public domain" },
    { id: "dj-puzzle-scratch-tactics", file: "Scratch Tactics/Battle Beats/Battle Beat 08.mp3", name: "🥁 Battle Beat 8", tag: "Scratch Tactics · beat loop" },
    { id: "dj-puzzle-scratch-tactics", file: "Scratch Tactics/Battle Beats/Battle Beat 10.mp3", name: "🥁 Battle Beat 10", tag: "Scratch Tactics · beat loop" },
    { id: "dj-puzzle-scratch-tactics", file: "Scratch Tactics/Bass/Bass 01.mp3", name: "🔊 Bass Line 1", tag: "Scratch Tactics · bass" },
    { id: "dj-puzzle-scratch-tactics", file: "Scratch Tactics/Bass/Bass 03.mp3", name: "🔊 Bass Line 3", tag: "Scratch Tactics · bass" },
    { id: "dj-puzzle-scratch-tactics", file: "Scratch Tactics/One Shots/Old Skool Hit 01.mp3", name: "💥 Old Skool Hit 1", tag: "Scratch Tactics · one-shot" },
    { id: "dj-puzzle-scratch-tactics", file: "Scratch Tactics/One Shots/Old Skool Hit 04.mp3", name: "💥 Old Skool Hit 4", tag: "Scratch Tactics · one-shot" },
    { id: "dj-puzzle-scratch-tactics", file: "Scratch Tactics/SFX/SFX  01.mp3", name: "✨ Pro SFX 1", tag: "Scratch Tactics · fx" },
    { id: "dj-puzzle-scratch-tactics", file: "Scratch Tactics/SFX/SFX  05.mp3", name: "✨ Pro SFX 5", tag: "Scratch Tactics · fx" },
    { id: "dj-puzzle-scratch-tactics", file: "Scratch Tactics/Old Skool Elements/Old Skool Element 02.mp3", name: "📼 Old Skool Element 2", tag: "Scratch Tactics · element" },
    { id: "dj-puzzle-scratch-tactics", file: "Scratch Tactics/Atmospherics/Atmospheric  01.mp3", name: "🌌 Atmosphere 1", tag: "Scratch Tactics · texture" },
    { id: "dj-puzzle-scratch-tactics", file: "Scratch Tactics/Atmospherics/Atmospheric  09.mp3", name: "🌌 Atmosphere 9 (long)", tag: "Scratch Tactics · texture" },
  ];
  async function curatedSrc(ci) {
    if (ci.file) return "https://archive.org/download/" + encodeURIComponent(ci.id) + "/" + ci.file.split("/").map(encodeURIComponent).join("/");
    return iaFile(ci.id);
  }
  function paintCurated() {
    const box = $("#dj-cur"); if (!box || !OWNER()) return;
    box.innerHTML = CURATED.length ? CURATED.map((c, i) => `<div class="dj-item"><span title="${E(c.name)}">${E(c.name)} <small class="muted">${E(c.tag)}</small></span><button class="btn ghost sm" type="button" data-curplay="${i}">▶</button><button class="btn ghost sm" type="button" data-load="A" data-cur="${i}">A</button><button class="btn ghost sm" type="button" data-load="B" data-cur="${i}">B</button><button class="btn ghost sm" type="button" data-load="C" data-cur="${i}">C</button><button class="btn ghost sm" type="button" data-load="D" data-cur="${i}">D</button></div>`).join("") : '<small class="muted">Loading the sound library…</small>';
  }

  /* ---------- jingle / spot board ---------- */
  const SYNTH = [
    { name: "📯 Air Horn", fn() { const c = actx(), t = c.currentTime; [392, 494, 587].forEach((f) => { const o = c.createOscillator(), g = c.createGain(); o.type = "sawtooth"; o.frequency.value = f; g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.16, t + 0.03); g.gain.setValueAtTime(0.16, t + 0.55); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.8); o.connect(g); g.connect(masterIn); o.start(t); o.stop(t + 0.85); }); } },
    { name: "🚨 Siren", fn() { const c = actx(), t = c.currentTime, o = c.createOscillator(), g = c.createGain(); o.type = "square"; o.frequency.setValueAtTime(700, t); for (let i = 0; i < 4; i++) { o.frequency.linearRampToValueAtTime(1400, t + i * 0.36 + 0.18); o.frequency.linearRampToValueAtTime(700, t + i * 0.36 + 0.36); } g.gain.setValueAtTime(0.07, t); g.gain.setValueAtTime(0.07, t + 1.4); g.gain.linearRampToValueAtTime(0.0001, t + 1.55); o.connect(g); g.connect(masterIn); o.start(t); o.stop(t + 1.6); } },
    { name: "🔫 Laser", fn() { const c = actx(), t = c.currentTime, o = c.createOscillator(), g = c.createGain(); o.type = "sawtooth"; o.frequency.setValueAtTime(2400, t); o.frequency.exponentialRampToValueAtTime(120, t + 0.28); g.gain.setValueAtTime(0.12, t); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.3); o.connect(g); g.connect(masterIn); o.start(t); o.stop(t + 0.32); } },
    { name: "✨ Sting", fn() { const c = actx(), t = c.currentTime; [523, 659, 784, 1047].forEach((f, i) => { const o = c.createOscillator(), g = c.createGain(); o.type = "triangle"; o.frequency.value = f; const st = t + i * 0.09; g.gain.setValueAtTime(0.0001, st); g.gain.exponentialRampToValueAtTime(0.18, st + 0.02); g.gain.exponentialRampToValueAtTime(0.0001, st + 0.9); o.connect(g); g.connect(masterIn); o.start(st); o.stop(st + 0.95); }); } },
    { name: "🎺 Scratch", fn() { const c = actx(), t = c.currentTime, o = c.createOscillator(), bp = c.createBiquadFilter(), g = c.createGain(); o.type = "sawtooth"; bp.type = "bandpass"; bp.frequency.value = 900; bp.Q.value = 2; o.frequency.setValueAtTime(300, t); o.frequency.linearRampToValueAtTime(1100, t + 0.1); o.frequency.linearRampToValueAtTime(240, t + 0.22); o.frequency.linearRampToValueAtTime(950, t + 0.32); o.frequency.linearRampToValueAtTime(200, t + 0.46); g.gain.setValueAtTime(0.14, t); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.5); o.connect(bp); bp.connect(g); g.connect(masterIn); o.start(t); o.stop(t + 0.52); } },
    { name: "💥 Impact", fn() { const c = actx(), t = c.currentTime, o = c.createOscillator(), g = c.createGain(); o.type = "sine"; o.frequency.setValueAtTime(160, t); o.frequency.exponentialRampToValueAtTime(36, t + 0.5); g.gain.setValueAtTime(0.5, t); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.6); o.connect(g); g.connect(masterIn); o.start(t); o.stop(t + 0.62); const nb = noiseBuf(), ns = c.createBufferSource(), ng = c.createGain(), nf = c.createBiquadFilter(); nf.type = "lowpass"; nf.frequency.value = 900; ns.buffer = nb; ng.gain.setValueAtTime(0.22, t); ng.gain.exponentialRampToValueAtTime(0.0001, t + 0.25); ns.connect(nf); nf.connect(ng); ng.connect(masterIn); ns.start(t); ns.stop(t + 0.3); } },
    { name: "🔔 Bell", fn() { const c = actx(), t = c.currentTime; [880, 1318, 1760].forEach((f, i) => { const o = c.createOscillator(), g = c.createGain(); o.type = "sine"; o.frequency.value = f; g.gain.setValueAtTime(0.16 / (i + 1), t); g.gain.exponentialRampToValueAtTime(0.0001, t + 1.1 - i * 0.25); o.connect(g); g.connect(masterIn); o.start(t); o.stop(t + 1.15); }); } },
    { name: "⏪ Rewind", fn() { const c = actx(), t = c.currentTime, o = c.createOscillator(), g = c.createGain(); o.type = "sawtooth"; o.frequency.setValueAtTime(950, t); o.frequency.exponentialRampToValueAtTime(110, t + 0.55); g.gain.setValueAtTime(0.09, t); g.gain.setValueAtTime(0.09, t + 0.4); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.58); o.connect(g); g.connect(masterIn); o.start(t); o.stop(t + 0.6); } },
    { name: "🥁 Drum Fill", fn() { const c = actx(), t = c.currentTime, nb = noiseBuf(); [0, 0.11, 0.22, 0.33].forEach((off, i) => { const ns = c.createBufferSource(), ng = c.createGain(), nf = c.createBiquadFilter(); nf.type = "bandpass"; nf.frequency.value = 400 + i * 350; nf.Q.value = 1.2; ns.buffer = nb; ng.gain.setValueAtTime(0.2, t + off); ng.gain.exponentialRampToValueAtTime(0.0001, t + off + 0.09); ns.connect(nf); nf.connect(ng); ng.connect(masterIn); ns.start(t + off); ns.stop(t + off + 0.1); const o = c.createOscillator(), og = c.createGain(); o.type = "sine"; o.frequency.value = 180 - i * 25; og.gain.setValueAtTime(0.22, t + off); og.gain.exponentialRampToValueAtTime(0.0001, t + off + 0.1); o.connect(og); og.connect(masterIn); o.start(t + off); o.stop(t + off + 0.11); }); } },
  ];
  function noiseBuf() { const c = actx(); if (!c._nb) { const b = c.createBuffer(1, c.sampleRate, c.sampleRate), d = b.getChannelData(0); for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1; c._nb = b; } return c._nb; }
  let padEl = null, padSrc = null;
  function playPadUrl(url) {
    actx();
    if (!padEl) { padEl = new Audio(); padEl.crossOrigin = "anonymous"; padEl.playsInline = true; try { padSrc = ctx.createMediaElementSource(padEl); padSrc.connect(masterIn); } catch (_) { padSrc = null; } }
    padEl.src = url; padEl.play().catch(() => {});
  }
  function paintPadRails(sig) {
    const custom = [0, 1, 2, 3].map((i) => (S.pads || [])[i] || null);
    ["A", "B", "C", "D"].forEach((k) => {
      const rail = $("#dpads-" + k); if (!rail || rail._padsSig === sig) return;
      rail._padsSig = sig;
      rail.innerHTML = SYNTH.map((p, i) => `<button class="dpad" type="button" data-synth="${i}" title="${p.name}">${p.name.split(" ")[0]}</button>`).join("") +
        custom.map((p, i) => p ? `<button class="dpad custom" type="button" data-pad="${i}" title="Drop ${i + 1}: tap plays it in the booth, long-press sends it on air">🎙️<small>${i + 1}</small></button>` : `<button class="dpad custom" type="button" data-padrec="${i}" title="Drop ${i + 1}: tap to record 8 seconds">➕<small>${i + 1}</small></button>`).join("");
    });
  }
  function paintPads() {
    const box = $("#dj-pads"); if (!box || !OWNER()) return;
    const sig = JSON.stringify((S.pads || []).map((p) => p ? (p.id || p.url || 1) : 0));
    paintPadRails(sig); // the pads only change when S.pads does — skip the full innerHTML rebuild on every state echo (same changed-key guard pattern as djLiveSig / battleCardSig)
    if (box._padsSig === sig) return;
    box._padsSig = sig;
    const custom = [0, 1, 2, 3].map((i) => (S.pads || [])[i] || null);
    box.innerHTML = SYNTH.map((p, i) => `<button class="pad" type="button" data-synth="${i}">${p.name}<small>booth + recording</small></button>`).join("") +
      custom.map((p, i) => p ? `<button class="pad custom" type="button" data-pad="${i}">🎙️ Drop ${i + 1}<small>▶ booth · long-press = 📡 on air</small></button>` : `<button class="pad custom" type="button" data-padrec="${i}">➕ Drop ${i + 1}<small>tap to record 8s</small></button>`).join("");
  }
  let padPress = null, padAt = null;
  onMain("pointerdown", (e) => { const b = e.target.closest("[data-pad]"); if (!b) return; padAt = { x: e.clientX, y: e.clientY }; padPress = setTimeout(() => { const p = (S.pads || [])[+b.dataset.pad]; if (p && okUrl(p.url)) { S.voice = { id: p.id, url: p.url, at: Date.now() }; heardVoice = p.id; save(true); say("Drop sent out over the air 📡"); } padPress = "done"; }, 650); });
  onMainRaw("pointerup", () => { padAt = null; clearTimeout(padPress); if (padPress !== "done") padPress = null; }, true);
  // LAW 22: the same hold guard as the hot cues — a press that turns into
  // a scroll abandons the long-press, so a voice drop can never go on air
  // mid-scroll.
  onMainRaw("pointermove", (e) => { if (padAt && Math.hypot(e.clientX - padAt.x, e.clientY - padAt.y) > 10) { padAt = null; if (padPress !== "done") { clearTimeout(padPress); padPress = null; } } }, true);
  onMainRaw("pointercancel", () => { padAt = null; if (padPress !== "done") { clearTimeout(padPress); padPress = null; } }, true);
  onMain("click", async (e) => {
    const s = e.target.closest("[data-synth]"); if (s && OWNER()) { s.classList.add("hit"); setTimeout(() => s.classList.remove("hit"), 200); if (boothLead) SYNTH[+s.dataset.synth].fn(); stampPad({ kind: "synth", i: +s.dataset.synth }); return; }
    const pb = e.target.closest("[data-pad]"); if (pb && OWNER()) { if (padPress === "done") { padPress = null; return; } const p = (S.pads || [])[+pb.dataset.pad]; if (p) { pb.classList.add("hit"); setTimeout(() => pb.classList.remove("hit"), 200); if (boothLead) playPadUrl(p.url); stampPad({ kind: "url", i: +pb.dataset.pad, url: p.url }); } return; }
    const pr = e.target.closest("[data-padrec]"); if (pr && OWNER()) return recordPad(+pr.dataset.padrec, pr);
  });
  async function recordPad(i, btn) {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
      const type = ["audio/webm;codecs=opus", "audio/mp4", "audio/webm"].find((t) => window.MediaRecorder && MediaRecorder.isTypeSupported(t)) || "";
      const r = new MediaRecorder(stream, type ? { mimeType: type } : undefined), ch = [];
      r.ondataavailable = (ev) => ev.data.size && ch.push(ev.data);
      btn.textContent = "⏺ Recording..."; r.start();
      setTimeout(() => { try { r.stop(); } catch (_) {} }, 8000);
      r.onstop = async () => {
        stream.getTracks().forEach((t) => t.stop());
        try {
          const a = await claude.use("assets"); if (!a) throw new Error("owner only");
          const up = await a.upload(new Blob(ch, { type: r.mimeType || "audio/webm" }), { type: (r.mimeType || "audio/webm").split(";")[0] });
          S.pads = S.pads || []; S.pads[i] = { id: up.id, url: up.url, at: Date.now() }; save(true); paintPads(); say("Drop " + (i + 1) + " saved to the board");
        } catch (_) { btn.textContent = "Couldn't save — try again"; }
      };
    } catch (_) { say("Allow the microphone to record a drop."); }
  }

  /* ---------- live mic (feeds the show recording + auto-duck) ---------- */
  let liveMic = null, micStreamLive = false;
  $("#mic-on").addEventListener("click", async () => {
    if (liveMic) { liveMic.getTracks().forEach((t) => t.stop()); liveMic = null; micStreamLive = false; $("#mic-on").textContent = "Open the mic"; $("#mic-lvl").style.width = "0"; micHot = 0; levels(); return; }
    try {
      const c = actx();
      liveMic = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
      const src = c.createMediaStreamSource(liveMic), comp = c.createDynamicsCompressor();
      comp.threshold.value = -18; comp.ratio.value = 6; comp.attack.value = 0.004; comp.release.value = 0.18;
      src.connect(comp); comp.connect(micGain); micStreamLive = true; $("#mic-on").textContent = "⏹ Close the mic"; say("Mic is open — it's in the show recording, and the music ducks while you talk.");
    } catch (_) { say("Allow the microphone to open the live mic."); }
  });
  $("#mic-mon").addEventListener("click", () => { if (!micMon) return; const on = micMon.gain.value > 0; micMon.gain.value = on ? 0 : 0.8; $("#mic-mon").textContent = on ? "🔇 Monitor off" : "🔊 Monitor ON (use headphones!)"; });

  /* ---------- talk drops to listeners (hold, talk, release) ---------- */
  let rec = null, chunks = [], talkStream = null, talkStart = 0, held = false;
  const talkBtn = $("#dj-talk"), talkSt = $("#dj-talk-st");
  async function talkDown(e) {
    e.preventDefault(); if (!OWNER() || rec) return; held = true;
    try {
      talkStream = talkStream || await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
      if (!held || rec) { if (!rec) { talkStream.getTracks().forEach((t) => t.stop()); talkStream = null; } return; }
      const type = ["audio/webm;codecs=opus", "audio/mp4", "audio/webm"].find((t) => window.MediaRecorder && MediaRecorder.isTypeSupported(t)) || "";
      rec = new MediaRecorder(talkStream, type ? { mimeType: type } : undefined); chunks = [];
      rec.ondataavailable = (ev) => ev.data.size && chunks.push(ev.data);
      rec.start(); talkStart = Date.now(); talkBtn.classList.add("on"); talkSt.textContent = "Talking... let go to send";
      S.duck = true; levels(); save(true);
    } catch (err) { held = false; say("Allow the microphone to talk over the music."); rec = null; }
  }
  async function talkUp() {
    held = false; if (!rec) return; const r = rec; rec = null; talkBtn.classList.remove("on");
    const long = Date.now() - talkStart;
    await new Promise((res) => { r.onstop = res; r.stop(); });
    try { talkStream.getTracks().forEach((t) => t.stop()); } catch (_) {} talkStream = null;
    S.duck = false; levels();
    if (long < 600) { talkSt.textContent = "Hold the button while you talk"; save(true); return; }
    talkSt.textContent = "Sending your voice...";
    try {
      const blob = new Blob(chunks, { type: r.mimeType || "audio/webm" });
      const a = await claude.use("assets"); if (!a) throw new Error("owner only");
      const up = await a.upload(blob, { type: (r.mimeType || "audio/webm").split(";")[0] });
      const old = S.voice && S.voice.id;
      S.voice = { id: up.id, url: up.url, at: Date.now() }; heardVoice = up.id; save(true);
      talkSt.textContent = "Sent ✓ Everyone listening hears it now";
      if (old) setTimeout(() => a.delete(old).catch(() => {}), 120000);
    } catch (err) { talkSt.textContent = "Couldn't send. Try again."; save(true); }
  }
  talkBtn.addEventListener("pointerdown", talkDown);
  ["pointerup", "pointercancel", "pointerleave"].forEach((ev) => talkBtn.addEventListener(ev, talkUp));
  talkBtn.addEventListener("contextmenu", (e) => e.preventDefault());

  /* ---------- record the show ---------- */
  let showRec = null, showChunks = [], showT0 = 0;
  $("#rec-btn").addEventListener("click", () => {
    if (showRec) { showRec.stop(); return; }
    const c = actx(); if (!c || !recDest) { say("The recorder needs the decks open first — load a song."); return; }
    const type = ["audio/webm;codecs=opus", "audio/mp4", "audio/webm"].find((t) => window.MediaRecorder && MediaRecorder.isTypeSupported(t)) || "";
    showRec = new MediaRecorder(recDest.stream, type ? { mimeType: type } : undefined); showChunks = [];
    showRec.ondataavailable = (ev) => ev.data.size && showChunks.push(ev.data);
    showRec.onstop = () => {
      const blob = new Blob(showChunks, { type: showRec.mimeType || "audio/webm" }), url = URL.createObjectURL(blob), dur = fmt((Date.now() - showT0) / 1000);
      $("#rec-out").innerHTML = `<audio controls src="${url}" style="width:100%"></audio><div style="display:flex;gap:8px;flex-wrap:wrap"><a class="btn sm" href="${url}" download="meechies-world-radio-show.webm">⬇ Download the show (${dur})</a><button class="btn ghost sm" type="button" id="rec-post">📻 Post as Latest Show</button></div>`;
      $("#rec-st").textContent = "Recorded " + dur + ". Download it, or post it to the station card for everyone.";
      $("#rec-btn").textContent = "⏺ Start recording"; showRec = null;
      $("#rec-post").addEventListener("click", async (ev) => {
        if (SANDBOX) { say("In the playground the download is yours to keep — posting is off so the real station stays untouched."); return; }
        ev.target.disabled = true; ev.target.textContent = "Posting...";
        try { const a = await claude.use("assets"); const up = await a.upload(blob, { type: (blob.type || "audio/webm").split(";")[0] }); const old = S.show; S.show = { id: up.id, url: up.url, at: Date.now() }; save(true); paintStation(); ev.target.textContent = "Posted ✓ It's on the station card"; if (old && old.id) a.delete(old.id).catch(() => {}); }
        catch (_) { ev.target.disabled = false; ev.target.textContent = "📻 Post as Latest Show"; say("Couldn't post the show. Download it instead."); }
      });
    };
    showT0 = Date.now(); showRec.start(1000); $("#rec-btn").textContent = "⏹ Stop recording"; $("#rec-st").innerHTML = '<span class="rec-on">● REC</span> Recording the show...';
  });

  const FREE_MEDIA = {"music": [{"t": "Danse Macabre", "a": "Kevin MacLeod", "src": "https://archive.org/download/Classical_Sampler-9615/Kevin_MacLeod_-_Danse_Macabre.mp3", "dur": 409, "cover": "https://archive.org/services/img/Classical_Sampler-9615"}, {"t": "Boogieman Penthouse", "a": "Boogie Belgique", "src": "https://archive.org/download/DWK149/Boogie_Belgique_-_11_-_Boogieman_Penthouse.mp3", "dur": 371, "cover": "https://archive.org/services/img/DWK149"}, {"t": "Time2Spare", "a": "Anitek", "src": "https://archive.org/download/DWK315/33_-_Tab_and_Anitek_-_Time2Spare.mp3", "dur": 270, "cover": "https://archive.org/services/img/DWK315"}, {"t": "Sad/Emotional Rap Beat - Free Rap Beats", "a": "Leon Wiseman - Free Rap Beats", "src": "https://archive.org/download/leonwise13_gmail/It%20Hurts%20-%20Emotional%20Instrumental%20-%20The%20Hip%20Hop%20HQ.MP3", "dur": 252, "cover": "https://archive.org/services/img/leonwise13_gmail"}, {"t": "Candlelight", "a": "Jahzzar", "src": "https://archive.org/download/Grab_Bag-12446/02_-_Candlelight.mp3", "dur": 308, "cover": "https://archive.org/services/img/Grab_Bag-12446"}, {"t": "Arcane", "a": "Kevin MacLeod (incompetech.com)", "src": "https://archive.org/download/Incompetech/mp3-royaltyfree/Arcane.mp3", "dur": 323, "cover": "https://archive.org/services/img/Incompetech"}, {"t": "Valentine's Day", "a": "ProleteR", "src": "https://archive.org/download/DWK226/ProleteR_-_02_-_Valentines_Day.mp3", "dur": 340, "cover": "https://archive.org/services/img/DWK226"}, {"t": "Cradle Militia", "a": "Anitek", "src": "https://archive.org/download/DWK114/Anitek_-_13_-_Cradle_Militia.mp3", "dur": 252, "cover": "https://archive.org/services/img/DWK114"}, {"t": "Overture to a Jam Session - Part I", "a": "Ray Nance", "src": "https://archive.org/download/78_overture-to-a-jam-session-part-2_duke-ellington-and-his-orchestra-strayhorn_gbia0039398/_01%20-%20Overture%20to%20a%20Jam%20Sessi%20-%20Duke%20Ellington%20and%20his%20Orchestra.mp3", "dur": 185, "cover": "https://archive.org/services/img/78_overture-to-a-jam-session-part-2_duke-ellington-and-his-orchestra-strayhorn_gbia0039398"}, {"t": "Fairytale", "a": "Kai Engel", "src": "https://archive.org/download/SCL115/03_-_Fairytale.mp3", "dur": 316, "cover": "https://archive.org/services/img/SCL115"}, {"t": "Backed Vibes Clean", "a": "Kevin MacLeod", "src": "https://archive.org/download/Jazz_Sampler-9619/Kevin_MacLeod_-_Backed_Vibes_Clean.mp3", "dur": 232, "cover": "https://archive.org/services/img/Jazz_Sampler-9619"}, {"t": "Soul Key", "a": "ProleteR", "src": "https://archive.org/download/Curses_From_The_Past-12105/ProleteR_-_03_-_Soul_Key.mp3", "dur": 304, "cover": "https://archive.org/services/img/Curses_From_The_Past-12105"}, {"t": "A Record Falls", "a": "Boogie Belgique", "src": "https://archive.org/download/DWK260/Boogie_Belgique_-_10_-_A_Record_Falls.mp3", "dur": 379, "cover": "https://archive.org/services/img/DWK260"}, {"t": "BlueBird", "a": "Anitek", "src": "https://archive.org/download/DWK117/Tab_and_Anitek_-_04_-_BlueBird.mp3", "dur": 223, "cover": "https://archive.org/services/img/DWK117"}, {"t": "In The Rain (Dark Choir 2)", "a": "Mounika", "src": "https://archive.org/download/Mounika.BasketSoundPart.2/Mounika.%20-%20Basket%20Sound%20Part.2%20-%2021%20In%20The%20Rain%20%28Dark%20Choir%202%29.mp3", "dur": 243, "cover": "https://archive.org/services/img/Mounika.BasketSoundPart.2"}, {"t": "FAQ (Hip-Hop Instrumental Mix)", "a": "Soundwavesofficial", "src": "https://archive.org/download/FAQHipHopInstrumentalMix/FAQ%20%28Hip-Hop%20Instrumental%20Mix%29.mp3", "dur": 480, "cover": "https://archive.org/services/img/FAQHipHopInstrumentalMix"}, {"t": "Disciples Of Steel", "a": "Kai Engel", "src": "https://archive.org/download/SCL125/02_-_Disciples_Of_Steel.mp3", "dur": 304, "cover": "https://archive.org/services/img/SCL125"}], "videos": [{"t": "Betty Boop: Minnie The Moocher", "a": "Internet Archive", "src": "https://archive.org/download/bb_minnie_the_moocher/bb_minnie_the_moocher_512kb.mp4", "dur": 466, "cover": "https://archive.org/services/img/bb_minnie_the_moocher"}, {"t": "Blues For Peace", "a": "Internet Archive", "src": "https://archive.org/download/blues_for_peace/blues_for_peace.mp4", "dur": 85, "cover": "https://archive.org/services/img/blues_for_peace"}, {"t": "Jazz Moscow: Vladimir Danilin, Jon Hammond, Igor Butman concert", "a": "Internet Archive", "src": "https://archive.org/download/JonHammondJazzMoscow_VladimirDanilin_JonHammond_IgorButmanconcert/WineDanilinButmanHammond_512kb.mp4", "dur": 602, "cover": "https://archive.org/services/img/JonHammondJazzMoscow_VladimirDanilin_JonHammond_IgorButmanconcert"}, {"t": "CONCERT JAZZ BAND DU PALAIS", "a": "Internet Archive", "src": "https://archive.org/download/ClaudeBesson-CONCERTJAZZBANDDUPALAIS223-2/ClaudeBesson-CONCERTJAZZBANDDUPALAIS223_512kb.mp4", "dur": 878, "cover": "https://archive.org/services/img/ClaudeBesson-CONCERTJAZZBANDDUPALAIS223-2"}, {"t": "Ummati Qad Laha Fajrun Music Video", "a": "Internet Archive", "src": "https://archive.org/download/ummati-qad-laha-fajrun_joke/Ummati%20Qad%20Laha%20Fajrun.mp4", "dur": 252, "cover": "https://archive.org/services/img/ummati-qad-laha-fajrun_joke"}, {"t": "Throwing Hammers Freestyle Music Video By KazeLoon", "a": "Internet Archive", "src": "https://archive.org/download/ThrowingHammersFreestyleMusicVideoByKazeLoon/ThrowingHammersFreestyleMusicVideoByKazeLoon.mp4", "dur": 240, "cover": "https://archive.org/services/img/ThrowingHammersFreestyleMusicVideoByKazeLoon"}, {"t": "Betty Boop: Snow White", "a": "Internet Archive", "src": "https://archive.org/download/bb_snow_white/bb_snow_white_512kb.mp4", "dur": 424, "cover": "https://archive.org/services/img/bb_snow_white"}, {"t": "The Cobweb Hotel", "a": "Internet Archive", "src": "https://archive.org/download/the_cobweb_hotel/the_cobweb_hotel_512kb.mp4", "dur": 473, "cover": "https://archive.org/services/img/the_cobweb_hotel"}, {"t": "Betty Boop: The Old Man Of The Mountain", "a": "Internet Archive", "src": "https://archive.org/download/bb_old_man_of_the_mountain/bb_old_man_of_the_mountain_512kb.mp4", "dur": 413, "cover": "https://archive.org/services/img/bb_old_man_of_the_mountain"}, {"t": "Betty Boop: Judge For a Day", "a": "Internet Archive", "src": "https://archive.org/download/Betty_Boop_Judge_For_a_Day_1935/Betty_Boop_Judge_For_a_Day_1935_512kb.mp4", "dur": 453, "cover": "https://archive.org/services/img/Betty_Boop_Judge_For_a_Day_1935"}, {"t": "Halloween Cartoon Collection", "a": "Internet Archive", "src": "https://archive.org/download/halloween-cartoon-collection_20231022/05-1930%20-%20Fleischer%20Studios%20-%20%20Swing%20You%20Sinners.ia.mp4", "dur": 476, "cover": "https://archive.org/services/img/halloween-cartoon-collection_20231022"}]};
  function paintFree() {
    const offSaved = (() => { try { return JSON.parse(localStorage.getItem("mw-offline-meta") || "{}"); } catch (_) { return {}; } })();
    const row = (it, i, kind) => `<div class="dj-item"><span style="display:flex;gap:8px;align-items:center;min-width:0"><img src="${E(it.cover)}" alt="" style="width:64px;height:36px;object-fit:cover;border-radius:6px;flex:none;background:#000"><span style="min-width:0"><span style="display:block" title="${E(it.t)}">${E(it.t)}</span><small class="muted">${E(it.a)}${it.dur ? " · " + fmt(it.dur) : ""}</small></span></span>${["A", "B", "C", "D"].map((dk) => `<button class="btn ghost sm" type="button" data-freeload="${dk}:${kind}:${i}">${dk}</button>`).join("")}<button class="btn ghost sm" type="button" data-freequeue="${kind}:${i}">＋Q</button><button class="btn ghost sm" type="button" data-fsave="${kind}:${i}">${offSaved[it.src] ? "✓ Saved" : "⬇ Offline"}</button></div>`;
    const em = $("#dj-freem"), ev = $("#dj-freev");
    if (em) em.innerHTML = FREE_MEDIA.music.map((it, i) => row(it, i, "m")).join("");
    if (ev) ev.innerHTML = FREE_MEDIA.videos.map((it, i) => row(it, i, "v")).join("");
  }
  paintFree();
  /* ---------- AFTER HOURS (owner booth only, 2026-10-29) ----------
   * The late-night shelf: curated YouTube searches for the newest
   * explicit versions, one tap from the decks. It rides the booth
   * video search path (ytSearch over the Invidious mirrors) and the
   * exact load/queue plumbing of the video results, so the age-skip
   * machinery covers it untouched: the player marks a locked video
   * (errors 100/101/150) into mw-dj-ageskip, load() speaks the
   * one-time notice and skips it, and the queue picker never draws
   * a locked video. The panel is created lazily by ahEnsure() from
   * the booth paint, and only for the real owner: SANDBOX is a
   * parse-time const, so the member Playground DOM never contains
   * this shelf at all, and a member mirror never builds it either. */
  const AH_SHELVES = [
    { label: "🔥 NEW RAP — EXPLICIT", q: "new rap songs explicit version" },
    { label: "🎤 NEW HIP-HOP SINGLES — EXPLICIT", q: "new hip hop single explicit version" },
    { label: "💜 NEW R&B — EXPLICIT", q: "new r&b songs explicit version" },
    { label: "🎬 EXPLICIT MUSIC VIDEOS", q: "explicit version official music video" }
  ];
  const ahCache = {}, ahBusy = {};
  function paintAhShelf(s) {
    const box = document.getElementById("ah-list-" + s); if (!box) return;
    if (ahBusy[s]) { box.innerHTML = '<small class="muted">Searching YouTube...</small>'; return; }
    const res = ahCache[s];
    if (res === null) { box.innerHTML = '<small class="muted">Search is being stubborn right now — tap Load to try again.</small>'; return; }
    if (!res) { box.innerHTML = '<small class="muted">Tap Load to pull the latest.</small>'; return; }
    box.innerHTML = res.length ? res.map((it, i) => `<div class="dj-item" style="padding:10px"><span style="display:flex;gap:12px;align-items:center;min-width:0"><img src="${E(it.thumb || "")}" alt="" style="width:152px;height:85px;object-fit:cover;border-radius:8px;flex:none;background:#000"><span style="min-width:0"><span style="display:block;font-size:19px" title="${E(it.title)}">${E(it.title)}</span><small class="muted">YouTube${it.dur ? " · " + fmt(it.dur) : ""}</small></span></span>${["A", "B", "C", "D"].map((dk) => `<button class="btn ghost" type="button" data-ahput="${dk}:${s}:${i}" style="min-width:42px;padding:10px 0">${dk}</button>`).join("")}<button class="btn ghost" type="button" data-ahqueue="${s}:${i}" style="min-width:42px;padding:10px 0">＋Q</button></div>`).join("") : '<small class="muted">Nothing came back for this shelf right now — tap Load to try again.</small>';
  }
  async function ahLoadShelf(s) {
    if (ahBusy[s]) return; const def = AH_SHELVES[s]; if (!def) return;
    ahBusy[s] = true; paintAhShelf(s);
    const r = await ytSearch(def.q);
    ahBusy[s] = false;
    ahCache[s] = r ? r.map((it) => ({ kind: "yt", id: it.id, title: it.title, dur: it.dur, thumb: "https://i.ytimg.com/vi/" + it.id + "/hqdefault.jpg" })) : null;
    paintAhShelf(s);
  }
  function ahEnsure() {
    if (SANDBOX || !OWNER()) return; // real owner only — the Playground and member mirrors never build this shelf
    if (document.getElementById("dj-afterhours")) return;
    const g2 = boothEl && boothEl.querySelector(".dj-grid2"); if (!g2) return;
    const p = document.createElement("div"); p.className = "dj-panel"; p.id = "dj-afterhours";
    p.innerHTML = "<h4>🌙 AFTER HOURS</h4>"
      + "<small class='muted' style='display:block;margin:2px 0 4px'>Your late-night shelf: the newest explicit versions, straight from YouTube search. A deck letter loads the video on that table, ＋Q lines it up. Booth only — nobody else ever sees this shelf. A video YouTube age-locks is skipped on its own, same as everywhere else here.</small>"
      + AH_SHELVES.map((sh, s) => `<b style="font-size:15px;letter-spacing:.1em;display:flex;justify-content:space-between;align-items:center;gap:8px;margin:10px 0 4px"><span>${sh.label}</span><button class="btn ghost sm" type="button" data-ahload="${s}">↻ Load</button></b><div class="dj-list" id="ah-list-${s}" style="max-height:300px"><small class="muted">Tap Load to pull the latest.</small></div>`).join("");
    g2.appendChild(p);
    try { foldPanels(); } catch (_) {}
    try { const h = p.querySelector("h4"); const label = h ? h.textContent.trim().slice(0, 26) : "Studio panel"; ckReg(p, "panel-" + label.replace(/[^a-z0-9]+/gi, "-").toLowerCase(), label); ckPaint(); } catch (_) {}
    ahLoadShelf(0);
  }
  /* ---------- Video search everywhere: YouTube (Invidious mirrors, no key)
   * and Internet Archive videos (no key). Dailymotion was taken off
   * 2026-10-28 (owner's call): no search tab, no new loads — the "dm:<id>"
   * playback shim stays so anything already queued still plays.
   * YouTube decks carry a plain id in S[k].yt; Vimeo (paste-a-link) rides
   * as "vm:<id>" — setYt and the screens dispatch on the prefix. Archive
   * videos resolve to a real file and load as file decks. */
  let vRes = [], vSrc = "yt", vQuery = "", vMoreOn = false, vNextPage = 3;
  async function ytHosts() {
    const out = ["https://yt.chocolatemoo53.com"];
    try {
      const ctl = typeof AbortSignal !== "undefined" && AbortSignal.timeout ? { signal: AbortSignal.timeout(6000) } : {};
      const r = await fetch("https://api.invidious.io/instances.json", ctl);
      const j = await r.json();
      if (Array.isArray(j)) j.forEach((pair) => { const info = pair && pair[1]; if (info && info.api && info.cors && info.uri && !out.includes(info.uri)) out.push(info.uri); });
    } catch (_) {}
    return out.slice(0, 5);
  }
  async function ytPage(q, page) {
    // Same-origin relay first (functions/api/ytsearch.js): the server fans
    // out over the full Invidious API pool from Cloudflare's network, so a
    // dead or unreachable mirror can no longer kill booth search the way
    // the single browser-side host did. Any failure here falls through to
    // the direct path below, unchanged.
    try {
      const ctl = typeof AbortSignal !== "undefined" && AbortSignal.timeout ? { signal: AbortSignal.timeout(8000) } : {};
      const r = await fetch("/api/ytsearch?q=" + encodeURIComponent(q) + "&page=" + page, ctl);
      if (r.ok) {
        const j = await r.json();
        if (j && j.ok && Array.isArray(j.results) && j.results.length) return ytUnblocked(j.results);
      }
    } catch (_) {}
    const hosts = await ytHosts();
    for (const base of hosts) {
      try {
        const ctl = typeof AbortSignal !== "undefined" && AbortSignal.timeout ? { signal: AbortSignal.timeout(7000) } : {};
        const r = await fetch(base + "/api/v1/search?q=" + encodeURIComponent(q) + "&type=video&page=" + page, ctl);
        if (!r.ok) continue;
        const j = await r.json();
        if (Array.isArray(j)) return ytUnblocked(j.filter((it) => it && it.videoId).map((it) => ({ id: it.videoId, title: it.title || "YouTube video", dur: it.lengthSeconds || 0 })));
      } catch (_) {}
    }
    return null;
  }
  async function ytSearch(q) {
    const a = await ytPage(q, 1);
    if (!a) return null;
    const b = await ytPage(q, 2);
    const seen = new Set(), out = [];
    for (const it of a.concat(b || [])) { if (!seen.has(it.id)) { seen.add(it.id); out.push(it); } }
    return out.slice(0, 30);
  }
  let iaPage = 1;
  async function iaVidSearch(q) {
    try {
      const u = "https://archive.org/advancedsearch.php?q=" + encodeURIComponent("mediatype:movies AND (" + q + ")") + "&fl[]=identifier&fl[]=title&rows=24&page=" + iaPage + "&sort[]=downloads%20desc&output=json";
      const r = await fetch(u); if (!r.ok) return null;
      const j = await r.json(); const docs = (j && j.response && j.response.docs) || [];
      return docs.filter((d) => d && d.identifier).map((d) => ({ kind: "ia", id: d.identifier, title: d.title || "Archive video", dur: 0, thumb: "https://archive.org/services/img/" + encodeURIComponent(d.identifier) }));
    } catch (_) { return null; }
  }
  async function iaVideoFile(id) {
    try {
      const j = await (await fetch("https://archive.org/metadata/" + encodeURIComponent(id))).json();
      const files = (j.files || []).filter((x) => /\.(mp4|webm)$/i.test(x.name || "") && !/sample|preview|trailer/i.test(x.name || ""));
      files.sort((a, b) => (+b.size || 0) - (+a.size || 0));
      const f = files.find((x) => /\.mp4$/i.test(x.name)) || files[0];
      return f ? "https://archive.org/download/" + encodeURIComponent(id) + "/" + f.name.split("/").map(encodeURIComponent).join("/") : "";
    } catch (_) { return ""; }
  }
  function paintTabs() { document.querySelectorAll("[data-vtab]").forEach((b) => { b.className = b.dataset.vtab === vSrc ? "btn sm vtab" : "btn ghost sm vtab"; }); }
  function paintVRes(msg) {
    const box = $("#dj-ytres"); if (!box) return;
    if (msg) { box.innerHTML = `<small class="muted">${msg}</small>`; return; }
    const srcName = { yt: "YouTube", ia: "Archive" };
    box.innerHTML = vRes.map((it, i) => `<div class="dj-item" style="padding:10px"><span style="display:flex;gap:12px;align-items:center;min-width:0"><img src="${E(it.thumb || "")}" alt="" style="width:152px;height:85px;object-fit:cover;border-radius:8px;flex:none;background:#000"><span style="min-width:0"><span style="display:block;font-size:19px" title="${E(it.title)}">${E(it.title)}</span><small class="muted">${srcName[it.kind] || ""}${it.dur ? " · " + fmt(it.dur) : ""}</small></span></span>${["A", "B", "C", "D"].map((dk) => `<button class="btn ghost" type="button" data-vput="${dk}:${i}" style="min-width:42px;padding:10px 0">${dk}</button>`).join("")}<button class="btn ghost" type="button" data-vqueue="${i}" style="min-width:42px;padding:10px 0">＋Q</button></div>`).join("") + (vMoreOn ? `<button class="btn" type="button" data-vmore="1" style="width:100%;margin-top:10px">🔁 MORE RESULTS</button>` : "");
  }
  const vtf = $("#dj-ytform");
  if (vtf) vtf.addEventListener("submit", async (e) => {
    e.preventDefault(); const q = $("#dj-ytq").value.trim(); if (!q) return;
    vQuery = q; iaPage = 1; vNextPage = 3; vMoreOn = false;
    paintVRes("Searching " + ({ yt: "YouTube", ia: "the Archive" })[vSrc] + "...");
    let res = null;
    if (vSrc === "yt") { const r = await ytSearch(q); res = r ? r.map((it) => ({ kind: "yt", id: it.id, title: it.title, dur: it.dur, thumb: it.thumb || ("https://i.ytimg.com/vi/" + it.id + "/hqdefault.jpg") })) : null; if (res) vMoreOn = res.length >= 20; }
    else { res = await iaVidSearch(q); if (res) vMoreOn = res.length >= 24; }
    if (!res) { vRes = []; vMoreOn = false; paintVRes("Search is being stubborn right now — paste the video's link in the box above instead, that always works."); return; }
    vRes = res; paintVRes(res.length ? "" : "Nothing found for that — try another name.");
  });
  document.querySelectorAll("[data-vtab]").forEach((b) => b.addEventListener("click", () => { vSrc = b.dataset.vtab; paintTabs(); const q = $("#dj-ytq"); if (q) q.focus(); }));
  document.addEventListener("click", async (e) => {
    const m = e.target.closest && e.target.closest("[data-vmore]"); if (!m || !vQuery) return;
    m.disabled = true; m.textContent = "Loading more...";
    let add = null;
    if (vSrc === "yt") { const r = await ytPage(vQuery, vNextPage); if (r) { add = r.map((it) => ({ kind: "yt", id: it.id, title: it.title, dur: it.dur, thumb: "https://i.ytimg.com/vi/" + it.id + "/hqdefault.jpg" })); vNextPage++; vMoreOn = r.length >= 15; } }
    else { iaPage++; const r = await iaVidSearch(vQuery); if (r) { add = r; vMoreOn = r.length >= 24; } else iaPage--; }
    if (add && add.length) { const seen = new Set(vRes.map((x) => x.kind + ":" + x.id)); vRes = vRes.concat(add.filter((x) => !seen.has(x.kind + ":" + x.id))); }
    else vMoreOn = false;
    paintVRes("");
  });
  paintTabs();


  /* ---------- session video: film the tab, so a music-video mix lands in one file.
   * The show recorder above only hears the audio graph, and YouTube decks never
   * enter it — the tab's own rendered picture + sound is the whole session. ---------- */
  let sesRec = null, sesChunks = [], sesStream = null, sesT0 = 0;
  $("#ses-btn").addEventListener("click", async () => {
    if (sesRec) { sesRec.stop(); return; }
    if (!navigator.mediaDevices || !navigator.mediaDevices.getDisplayMedia) { say("This browser can't film the tab — the regular show recording still works for audio."); return; }
    try { sesStream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true }); }
    catch (_) { say("No film this time — pick this tab and tick “share tab audio” so the mix is in the movie."); return; }
    if (!sesStream.getAudioTracks().length) $("#ses-st").textContent = "Heads up: no tab audio was shared, so this film will be silent — stop and share again with tab audio on for the full mix.";
    sesChunks = []; const type = ["video/webm;codecs=vp9,opus", "video/webm;codecs=vp8,opus", "video/webm"].find((t) => window.MediaRecorder && MediaRecorder.isTypeSupported(t)) || "";
    sesRec = new MediaRecorder(sesStream, type ? { mimeType: type, videoBitsPerSecond: 6000000 } : undefined);
    sesRec.ondataavailable = (ev) => ev.data.size && sesChunks.push(ev.data);
    sesRec.onstop = () => {
      const blob = new Blob(sesChunks, { type: (sesRec && sesRec.mimeType) || "video/webm" }), url = URL.createObjectURL(blob), dur = fmt((Date.now() - sesT0) / 1000);
      if (sesStream) { sesStream.getTracks().forEach((t) => t.stop()); sesStream = null; }
      sesRec = null; $("#ses-btn").textContent = "🎬 Record the session (video)";
      $("#ses-out").innerHTML = `<video controls src="${url}" style="width:100%;border-radius:10px;background:#000"></video><div style="display:flex;gap:8px;flex-wrap:wrap"><a class="btn sm" href="${url}" download="meechies-world-dj-session.webm">⬇ Download the session (${dur})</a><button class="btn ghost sm" type="button" id="ses-post">📻 Post as Latest Show</button></div>`;
      $("#ses-st").textContent = "Filmed " + dur + ". Download it, or post it to the station card so everyone can watch the session.";
      $("#ses-post").addEventListener("click", async (ev) => {
        if (SANDBOX) { say("In the playground the download is yours to keep — posting is off so the real station stays untouched."); return; }
        ev.target.disabled = true; ev.target.textContent = "Posting...";
        try { const a = await claude.use("assets"); const up = await a.upload(blob, { type: "video/webm" }); const old = S.show; S.show = { id: up.id, url: up.url, at: Date.now(), video: true }; save(true); paintStation(); ev.target.textContent = "Posted ✓ It's on the station card"; if (old && old.id) a.delete(old.id).catch(() => {}); }
        catch (_) { ev.target.disabled = false; ev.target.textContent = "📻 Post as Latest Show"; say("Couldn't post the session. Download it instead."); }
      });
    };
    sesStream.getVideoTracks().forEach((t) => t.addEventListener("ended", () => { if (sesRec) sesRec.stop(); }));
    sesT0 = Date.now(); sesRec.start(1000); $("#ses-btn").textContent = "⏹ Stop filming"; $("#ses-st").innerHTML = '<span class="rec-on">● REC</span> Filming the session — everything you play and mix is in the movie.';
  });

  /* ---------- requests + listener voice drops ---------- */
  async function sendRequest(data) {
    const d = DBF();
    if (d) { try { await d.collection("requests").add(data); return; } catch (_) {} }
    // not signed in (or the member write refused): the station itself takes song
    // picks and text requests from anyone — the booth sees them like any request
    const body = { kind: data.kind, title: data.title || "", cover: data.cover || "", dur: +data.dur || 0, text: data.text || "" };
    if (data.kind === "pick") { let src = data.src || ""; if (!src && data.iaId) { try { src = await iaFile(data.iaId); } catch (_) {} } if (!src) throw new Error("no src"); body.src = src; }
    const r = await fetch("/api/station", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    if (!r.ok) throw new Error("request refused");
  }
  $("#rq-form").addEventListener("submit", async (e) => {
    e.preventDefault(); const v = $("#rq-text").value.trim(); if (!v) return;
    try { await sendRequest({ kind: "text", text: v.slice(0, 120), at: Date.now() }); $("#rq-text").value = ""; say("Request sent to the booth 🎧"); }
    catch (_) { say("That request didn't go through — wait a few seconds and try again."); }
  });
  let dropRec = null;
  $("#rq-rec").addEventListener("click", async () => {
    if (dropRec) { dropRec.stop(); return; }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const type = ["audio/webm;codecs=opus", "audio/mp4", "audio/webm"].find((t) => window.MediaRecorder && MediaRecorder.isTypeSupported(t)) || "";
      dropRec = new MediaRecorder(stream, type ? { mimeType: type } : undefined); const ch = [];
      dropRec.ondataavailable = (ev) => ev.data.size && ch.push(ev.data);
      dropRec.onstop = async () => {
        stream.getTracks().forEach((t) => t.stop()); dropRec = null; $("#rq-rec").textContent = "🎙️ Record a voice drop";
        $("#rq-rec-st").textContent = "Sending your drop to the booth...";
        try { const a = await claude.use("assets"); if (!a) throw new Error("members"); const up = await a.upload(new Blob(ch, { type: type || "audio/webm" }), { type: (type || "audio/webm").split(";")[0] }); await sendRequest({ kind: "voice", url: up.url, asset: up.id, at: Date.now() }); $("#rq-rec-st").textContent = "Sent ✓ Meechie can play it on air."; }
        catch (_) { $("#rq-rec-st").textContent = "Couldn't send — members only, try again."; }
      };
      dropRec.start(); $("#rq-rec").textContent = "⏹ Stop & send";
      setTimeout(() => { if (dropRec) dropRec.stop(); }, 20000);
    } catch (_) { say("Allow the microphone to record a drop."); }
  });
  let reqSubbed = false, reqCache = [];
  function renderDjReqs() {
    const nowBox = $("#djguest-now"), list = $("#djreq-list"); if (!list) return;
    const g = S.djGuest;
    if (nowBox) nowBox.innerHTML = (g && g.until > Date.now())
      ? `<div class="req"><span>🔴 <b>${E(gName(g))}</b> is LIVE on the tables until ${new Date(g.until).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}</span><span><button class="btn sm" type="button" data-djend="1">⏹ End their set</button></span></div>`
      : '<small class="muted">No guest DJ on the tables right now. Approve a request below and that member plays on the real radio for up to 2 hours — opening your own booth takes the tables back instantly.</small>';
    const rows = (reqCache || []).filter((r) => r.data && r.data.kind === "djlive").sort((a, b) => (a.data.at || 0) - (b.data.at || 0));
    list.innerHTML = rows.length ? rows.map((r) => `<div class="req"><span>🎧 <b>${E(r.data.name || "Member")}</b> wants to DJ live</span><small>${agoT(r.data.at || Date.now())}</small><span style="display:flex;gap:6px;flex-wrap:wrap"><button class="btn sm" type="button" data-djok="${E(r.id)}|${E(r.data.uid || "")}|${E(r.data.name || "Member")}">✅ Put them on</button><button class="btn ghost sm" type="button" data-djno="${E(r.id)}">✕ Not now</button></span></div>`).join("") : '<small class="muted">No requests waiting.</small>';
    try { paintBattlePanel(); } catch (_) {}
  }
  function renderReqs(docs) {
    const box = $("#rq-list"); if (!box) return;
    const rows = docs.map((x) => ({ id: x.id, data: x.data() || {} })).filter((r) => r.data.kind !== "djlive").sort((a, b) => (b.data.at || 0) - (a.data.at || 0)).slice(0, 30);
    box.innerHTML = rows.length ? rows.map((r) => r.data.kind === "voice"
      ? `<div class="req"><b>🎙️ Voice drop</b><small>${agoT(r.data.at || Date.now())}</small><span style="display:flex;gap:6px;flex-wrap:wrap"><button class="btn ghost sm" type="button" data-rqplay="${E(r.data.url)}">▶ Hear it</button><button class="btn sm" type="button" data-rqair="${E(r.id)}|${E(r.data.url)}|${E(r.data.asset || "")}">📡 Play on air</button><button class="btn ghost sm" type="button" data-rqdone="${E(r.id)}">✓ Done</button></span></div>`
      : r.data.kind === "pick" ? `<div class="req"><span>🎵 Listener pick: ${E(r.data.title || "")}</span><small>${agoT(r.data.at || Date.now())}</small><span><button class="btn ghost sm" type="button" data-rqdone="${E(r.id)}">✓ Played</button></span></div>`
      : `<div class="req"><span>${E(r.data.text || "")}</span><small>${agoT(r.data.at || Date.now())}</small><span><button class="btn ghost sm" type="button" data-rqdone="${E(r.id)}">✓ Played</button></span></div>`).join("") : '<small class="muted">Nothing yet. Listener requests land here.</small>';
    renderDjReqs();
  }
  function subReqs() {
    if (reqSubbed || !OWNER() || SANDBOX) return; const d = DBF(); if (!d) return; reqSubbed = true;
    try { d.collection("requests").limit(40).onSnapshot((s) => { reqCache = s.docs.map((x) => ({ id: x.id, data: x.data() || {} })); renderReqs(s.docs); }, () => {}); } catch (_) { reqSubbed = false; }
  }
  onMain("click", async (e) => {
    const p = e.target.closest("[data-rqplay]"); if (p) { new Audio(p.dataset.rqplay).play().catch(() => {}); return; }
    const air = e.target.closest("[data-rqair]"); if (air && OWNER()) { const [id, url, asset] = air.dataset.rqair.split("|"); S.voice = { id: asset || id, url, at: Date.now() }; heardVoice = S.voice.id; save(true); say("Drop is on the air 📡"); DBF()?.doc("requests/" + id).delete().catch(() => {}); return; }
    const dn = e.target.closest("[data-rqdone]"); if (dn && OWNER()) { DBF()?.doc("requests/" + dn.dataset.rqdone).delete().catch(() => {}); }
    const ok = e.target.closest("[data-djok]"); if (ok && OWNER()) { const parts = ok.dataset.djok.split("|"); const id = parts[0], uid = parts[1], name = parts.slice(2).join("|") || "Member"; if (uid) { S.djGuest = { uid, name, until: Date.now() + 2 * 3600e3, lastWrite: 0 }; save(true); say("🎧 " + name + " is on the tables — live for up to 2 hours"); } DBF()?.doc("requests/" + id).delete().catch(() => {}); renderDjReqs(); return; }
    const no = e.target.closest("[data-djno]"); if (no && OWNER()) { DBF()?.doc("requests/" + no.dataset.djno).delete().catch(() => {}); return; }
    const end = e.target.closest("[data-djend]"); if (end && OWNER()) { S.djGuest = null; save(true); say("Guest set ended — the tables are yours"); renderDjReqs(); return; }
  });

  /* ---------- DJ BATTLES (owner ask 2026-10-29) ----------
   * Two members Malik picks go head-to-head on the decks in timed turns;
   * the winner is announced on air. BATTLES 2.0 (the TikTok model, owner,
   * later the same day): the crowd GIFTS coins on the station card and
   * most gift coins wins; likes are the free hype layer and break gift
   * ties; a Share button deep-links new people to the Radio view (#radio).
   * State lives in S.battle (booth-written at START, server-written after
   * that by functions/api/battle.js). Scores are tallied server-side from
   * the battlegifts / battlelikes docs — never stored in S. Turn switches are driven by the
   * /api/battle advance action: this booth ticks it while a battle is
   * live, and the battler whose turn just ended backstops it from their
   * Playground — the server only transitions when the stored turnEndsAt
   * has passed, and only once (optimistic write), so every caller
   * computes the same next state. */
  let battleTally = null, battleTallyId = "", battlePollAt = 0, battleAdvAt = 0, battlePushAt = 0, battleVoiceSent = "", battleCardSig = "", battlePanelSig = "", battleGuestTurnSeen = "";
  const bName = (w) => gName(w || {});
  const battleHdrs = () => { const ses = mySess(); const h = { "content-type": "application/json" }; if (ses && ses.access_token) h.authorization = "Bearer " + ses.access_token; return h; };
  async function battleApi(body) { try { const r = await fetch("/api/battle", { method: "POST", headers: battleHdrs(), body: JSON.stringify(body) }); return await r.json().catch(() => null); } catch (_) { return null; } }
  // battleTally (2.0 shape): { g: {p1,p2} gift coins, l: {p1,p2} likes }
  const battleSetTally = (j) => {
    if (!j || (!j.gifts && !j.likes)) return false;
    battleTally = { g: { p1: +((j.gifts || {}).p1) || 0, p2: +((j.gifts || {}).p2) || 0 }, l: { p1: +((j.likes || {}).p1) || 0, p2: +((j.likes || {}).p2) || 0 } };
    if (S.battle && S.battle.id) battleTallyId = S.battle.id;
    return true;
  };
  async function battleTallyFetch(id) {
    try { const r = await fetch("/api/battle?battleId=" + encodeURIComponent(id)); const j = await r.json().catch(() => null); if (j && j.ok) { battleSetTally(j); battleTallyId = id; paintBattleCard(); if (OWNER() && !SANDBOX) paintBattlePanel(); } } catch (_) {}
  }
  async function battleAdvanceCall() {
    const t = Date.now(); if (t - battleAdvAt < 3000) return; battleAdvAt = t;
    const j = await battleApi({ action: "advance" });
    if (j && j.ok) battleSetTally(j);
  }
  async function battleLike(side) {
    const b = S.battle; if (!b || !b.on || b.phase !== "live" || !b.id) return;
    const ses = mySess();
    if (!ses || !ses.access_token) { if (typeof openAuth === "function") openAuth("signup"); say("Join free to like in the battle ❤️"); return; }
    if (battleTallyId === b.id && battleTally) { // optimistic: the heart lands instantly, the poll reconciles
      battleTally = { g: battleTally.g, l: { p1: battleTally.l.p1 + (side === "p1" ? 1 : 0), p2: battleTally.l.p2 + (side === "p2" ? 1 : 0) } };
      battleCardSig = ""; paintBattleCard();
    }
    const j = await battleApi({ action: "like", battleId: b.id, side });
    if (j && j.ok && j.likes && battleTallyId === b.id && battleTally) {
      battleTally = { g: battleTally.g, l: { p1: +j.likes.p1 || 0, p2: +j.likes.p2 || 0 } };
      battleCardSig = ""; paintBattleCard();
    }
  }
  async function battleGift(side, amount) {
    const b = S.battle; if (!b || !b.on || b.phase !== "live" || !b.id) return;
    const ses = mySess();
    if (!ses || !ses.access_token) { if (typeof openAuth === "function") openAuth("signup"); say("Join free to gift in the battle 🪙"); return; }
    const j = await battleApi({ action: "gift", battleId: b.id, side, amount });
    if (j && j.ok) {
      battleSetTally(j); battleCardSig = ""; paintBattleCard();
      const zone = document.querySelector('[data-bgiftzone="' + side + '"]');
      if (zone) {
        const s = document.createElement("span");
        s.textContent = "+" + amount + " 🪙";
        s.style.cssText = "position:absolute;right:6px;top:-4px;font-weight:800;color:var(--gold);pointer-events:none;font-size:15px;z-index:2";
        zone.appendChild(s);
        try { s.animate([{ transform: "translateY(0)", opacity: 1 }, { transform: "translateY(-26px)", opacity: 0 }], { duration: 1100, easing: "ease-out" }); } catch (_) {}
        setTimeout(() => { try { s.remove(); } catch (_) {} }, 1150);
      }
      say("🪙 Gift sent — " + amount + " coins for " + bName(side === "p1" ? b.p1 : b.p2) + "!");
    } else if (j && j.error === "coins") say("Not enough coins for that gift — earn or grab more in the Coin Jackpot 🎰");
    else say("That gift did not land — try again in a moment.");
  }
  async function battleShare() {
    const b = S.battle; if (!b || !b.id) return;
    // the router's deep link is the location hash: go() reads it on a cold
    // load and "radio" is a real view, so #radio lands a fresh visitor on
    // the Radio view with the battle card on it (verified in app-core.js)
    const url = location.origin + location.pathname + "#radio";
    const wn = b.phase === "done" ? (b.winner === b.p1.uid ? bName(b.p1) : b.winner === b.p2.uid ? bName(b.p2) : "") : "";
    const text = b.phase === "done"
      ? (wn ? wn + " just won a DJ battle on Meechie's World ⚔️ Catch the next one live!" : "The DJ battle on Meechie's World ended in a draw ⚔️ Catch the next one live!")
      : "⚔️ DJ Battle LIVE on Meechie's World: " + bName(b.p1) + " vs " + bName(b.p2) + " — most gift coins wins. Come watch and gift your DJ!";
    if (navigator.share) {
      try { await navigator.share({ title: "DJ Battle — Meechie's World", text, url }); return; }
      catch (e) { if (e && e.name === "AbortError") return; }
    }
    try { await navigator.clipboard.writeText(url); say("Link copied — send it to your people 🔗"); }
    catch (_) { say("Share the battle: " + url); }
  }
  function paintBattleCard() {
    const box = document.getElementById("st-battle"); if (!box || SANDBOX) return;
    const b = S.battle;
    const doneFresh = b && b.phase === "done" && Date.now() - (b.at || 0) < 5 * 60e3;
    if (!b || !b.on || !b.id || (b.phase !== "live" && !doneFresh)) { box.hidden = true; if (box.innerHTML) box.innerHTML = ""; battleCardSig = ""; return; }
    const t = (battleTallyId === b.id && battleTally) ? battleTally : null;
    const sig = [b.id, b.phase, b.round, b.turn, b.winner, t ? t.g.p1 + "-" + t.g.p2 + "/" + t.l.p1 + "-" + t.l.p2 : "x"].join("|");
    if (sig === battleCardSig) return; battleCardSig = sig;
    box.hidden = false;
    const shareBtn = `<button class="btn sm ghost" type="button" data-bshare="1">🔗 Share</button>`;
    if (b.phase === "done") {
      const wn = b.winner === b.p1.uid ? bName(b.p1) : b.winner === b.p2.uid ? bName(b.p2) : "";
      box.innerHTML = `<div style="border:1px solid var(--line);border-radius:12px;padding:10px 12px;margin:10px 0"><b>⚔️ DJ BATTLE — RESULT</b><div style="margin-top:4px">${wn ? ("🏆 <b>" + E(wn) + "</b> takes the battle!") : "🤝 It ended in a <b>draw</b>!"}</div><div class="muted" style="font-size:13px;margin-top:2px">Final gifts — ${E(bName(b.p1))} 🪙 <b>${t ? t.g.p1 : "…"}</b> · ❤️ <b>${t ? t.l.p1 : "…"}</b> — ${E(bName(b.p2))} 🪙 <b>${t ? t.g.p2 : "…"}</b> · ❤️ <b>${t ? t.l.p2 : "…"}</b></div><div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:8px">${shareBtn}</div></div>`;
      return;
    }
    const turnName = b.turn === b.p1.uid ? bName(b.p1) : bName(b.p2);
    const secs = Math.max(0, Math.ceil(((b.turnEndsAt || 0) - Date.now()) / 1000));
    const tot = t ? t.g.p1 + t.g.p2 : 0;
    const pct = tot > 0 ? Math.round((t.g.p1 / tot) * 100) : 50; // the tug-of-war split, by gift share
    const sideHtml = (sd, w) => `<div data-bgiftzone="${sd}" style="position:relative;flex:1;min-width:140px;border:1px solid var(--line);border-radius:10px;padding:8px">
      <div style="font-weight:700">${E(bName(w))}</div>
      <div style="font-size:15px;margin-top:2px">🪙 <b>${t ? (sd === "p1" ? t.g.p1 : t.g.p2) : "…"}</b></div>
      <button class="btn sm" type="button" data-blike="${sd}" style="margin-top:6px">❤️ Like · ${t ? (sd === "p1" ? t.l.p1 : t.l.p2) : "…"}</button>
      <div style="display:flex;gap:4px;flex-wrap:wrap;margin-top:6px">${[10, 50, 100, 500].map((a) => `<button class="btn sm ghost" type="button" data-bgift="${sd}:${a}">${a} 🪙</button>`).join("")}</div>
    </div>`;
    box.innerHTML = `<div style="border:1px solid var(--line);border-radius:12px;padding:10px 12px;margin:10px 0"><b>⚔️ DJ BATTLE — LIVE</b>
      <div style="margin-top:4px"><b>${E(bName(b.p1))}</b> vs <b>${E(bName(b.p2))}</b> · Round ${b.round} of ${b.rounds}</div>
      <div class="muted" style="font-size:13px;margin-top:2px">🎧 <b>${E(turnName)}</b> is on the decks · <span id="st-battle-cd">${secs}</span>s left this turn</div>
      <div style="display:flex;height:14px;border-radius:8px;overflow:hidden;border:1px solid var(--line);margin-top:8px">
        <div style="width:${pct}%;background:linear-gradient(90deg,var(--gold-lo),var(--gold));transition:width .6s ease"></div>
        <div style="width:${100 - pct}%;background:#f4efe3;transition:width .6s ease"></div>
      </div>
      <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:8px">${sideHtml("p1", b.p1)}${sideHtml("p2", b.p2)}</div>
      <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:8px">${shareBtn}</div>
      <small class="muted">Most gift coins wins — likes break ties.</small></div>`;
  }
  function battleCandidates() {
    const out = [], seen = new Set();
    const push = (uid, name) => { uid = String(uid || ""); if (!uid || seen.has(uid)) return; seen.add(uid); out.push({ uid, name: gName({ name: name || "Member" }) }); };
    (reqCache || []).forEach((r) => { if (r.data && r.data.kind === "djlive") push(r.data.uid, r.data.name); });
    const g = S.djGuest; if (g && g.until > Date.now()) push(g.uid, g.name);
    return out;
  }
  function paintBattlePanel() {
    const box = $("#battle-box"); if (!box || SANDBOX) return;
    const b = S.battle;
    if (b && b.on && b.phase === "live" && b.id) {
      const sig = "live|" + b.id + "|" + b.round + "|" + b.turn;
      if (sig !== battlePanelSig) {
        battlePanelSig = sig;
        box.innerHTML = `<div class="req"><span>⚔️ <b>${E(bName(b.p1))}</b> vs <b>${E(bName(b.p2))}</b> — Round ${b.round} of ${b.rounds}</span></div>
          <div style="font-size:14px;margin:4px 0">🎧 On the decks: <b>${E(b.turn === b.p1.uid ? bName(b.p1) : bName(b.p2))}</b> · <span id="battle-cd">${Math.max(0, Math.ceil(((b.turnEndsAt || 0) - Date.now()) / 1000))}</span>s left</div>
          <div style="font-size:14px;margin:4px 0">🪙 Gifts — ${E(bName(b.p1))} <b id="battle-sc1">…</b> · <b id="battle-sc2">…</b> ${E(bName(b.p2))}</div>
          <div style="font-size:14px;margin:4px 0">❤️ Likes — ${E(bName(b.p1))} <b id="battle-lc1">…</b> · <b id="battle-lc2">…</b> ${E(bName(b.p2))}</div>
          <small class="muted">Most gift coins wins — likes break ties.</small>
          <div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:6px"><button class="btn sm" type="button" data-bswitch="1">⏭ SWITCH TURN NOW</button><button class="btn ghost sm" type="button" data-bend="1">⏹ END BATTLE</button></div>`;
      }
      const t = (battleTallyId === b.id && battleTally) ? battleTally : null;
      const s1 = document.getElementById("battle-sc1"), s2 = document.getElementById("battle-sc2");
      if (s1 && t) s1.textContent = t.g.p1; if (s2 && t) s2.textContent = t.g.p2;
      const l1 = document.getElementById("battle-lc1"), l2 = document.getElementById("battle-lc2");
      if (l1 && t) l1.textContent = t.l.p1; if (l2 && t) l2.textContent = t.l.p2;
      return;
    }
    if (b && b.on && b.phase === "done" && b.id && Date.now() - (b.at || 0) < 60000) {
      const sig = "done|" + b.id;
      if (sig !== battlePanelSig) {
        battlePanelSig = sig;
        const wn = b.winner === b.p1.uid ? bName(b.p1) : b.winner === b.p2.uid ? bName(b.p2) : "";
        box.innerHTML = `<div class="req"><span>⚔️ Battle over — ${wn ? ("🏆 <b>" + E(wn) + "</b> takes it!") : "🤝 a <b>draw</b>!"}</span></div><small class="muted">The result is on the station card. Setting up the next battle…</small>`;
      }
      return;
    }
    const cands = battleCandidates();
    const sig = "setup|" + cands.map((c) => c.uid).join(",");
    if (sig === battlePanelSig) return;
    const keep = {}; ["battle-p1", "battle-p2", "battle-rounds", "battle-turnsec"].forEach((id) => { const el = document.getElementById(id); if (el) keep[id] = el.value; });
    battlePanelSig = sig;
    if (cands.length < 2) {
      box.innerHTML = `<small class="muted">Battles need <b>two</b> members ready to DJ. Right now ${cands.length === 1 ? ("only <b>" + E(cands[0].name) + "</b> is") : "nobody is"} lined up — when members tap 🎧 Ask Meechie to DJ live (or one is on a guest set), their names land here to pick from.</small>`;
      return;
    }
    const opts = (sel) => cands.map((c, i) => `<option value="${E(c.uid)}"${(keep[sel] ? keep[sel] === c.uid : i === (sel === "battle-p2" ? 1 : 0)) ? " selected" : ""}>${E(c.name)}</option>`).join("");
    box.innerHTML = `<div style="display:grid;gap:8px">
      <label class="lab">Battler 1<select id="battle-p1">${opts("battle-p1")}</select></label>
      <label class="lab">Battler 2<select id="battle-p2">${opts("battle-p2")}</select></label>
      <div style="display:flex;gap:8px;flex-wrap:wrap">
        <label class="lab" style="flex:1">Rounds<select id="battle-rounds">${[1, 2, 3, 5].map((n) => `<option value="${n}"${(keep["battle-rounds"] ? +keep["battle-rounds"] : 3) === n ? " selected" : ""}>${n}</option>`).join("")}</select></label>
        <label class="lab" style="flex:1">Turn length<select id="battle-turnsec">${[30, 60, 90, 120].map((n) => `<option value="${n}"${(keep["battle-turnsec"] ? +keep["battle-turnsec"] : 90) === n ? " selected" : ""}>${n} seconds</option>`).join("")}</select></label>
      </div>
      <button class="btn" type="button" data-bstart="1">⚔️ START BATTLE</button>
      <small class="muted">Starting a battle takes the tables over from any guest set in progress. Battlers open their battle table from the DJ Station page; only the battler on turn can move the decks.</small></div>`;
  }
  function battleStart() {
    const s1 = $("#battle-p1"), s2 = $("#battle-p2"); if (!s1 || !s2) return;
    const u1 = s1.value, u2 = s2.value;
    if (!u1 || !u2 || u1 === u2) { say("Pick two different battlers ⚔️"); return; }
    const n1 = s1.options[s1.selectedIndex] ? s1.options[s1.selectedIndex].textContent : "DJ 1";
    const n2 = s2.options[s2.selectedIndex] ? s2.options[s2.selectedIndex].textContent : "DJ 2";
    const rounds = +($("#battle-rounds") || {}).value || 3, turnSec = +($("#battle-turnsec") || {}).value || 90;
    const now = Date.now(), id = "b" + rid();
    S.battle = { on: true, id, p1: { uid: u1, name: n1 }, p2: { uid: u2, name: n2 }, round: 1, rounds, turnSec, turn: u1, turnEndsAt: now + turnSec * 1000, phase: "live", winner: "", at: now, lastWrite: 0 };
    if (S.djGuest) S.djGuest = null; // the battle takes the station: the guest relay door closes so turns rule alone
    S.ticker = "⚔️ DJ BATTLE: " + n1 + " vs " + n2 + " — gift your DJ on the station card, most coins wins!";
    S.voice = { id: "battle-" + id + "-start", text: "Battle time! " + n1 + " versus " + n2 + " — round one, " + n1 + ", you are up!", at: now };
    battleTally = { g: { p1: 0, p2: 0 }, l: { p1: 0, p2: 0 } }; battleTallyId = id; battlePanelSig = ""; battleCardSig = "";
    save(true); paintBattlePanel(); paintBattleCard();
    say("⚔️ Battle started: " + n1 + " vs " + n2);
  }
  onMain("click", async (e) => {
    const lk = e.target.closest("[data-blike]"); if (lk) { battleLike(lk.dataset.blike); return; }
    const gf = e.target.closest("[data-bgift]"); if (gf) { const parts = gf.dataset.bgift.split(":"); battleGift(parts[0], +parts[1] || 0); return; }
    const sh = e.target.closest("[data-bshare]"); if (sh) { battleShare(); return; }
    const bs = e.target.closest("[data-bstart]"); if (bs && OWNER() && !SANDBOX) { battleStart(); return; }
    const sw = e.target.closest("[data-bswitch]"); if (sw && OWNER() && !SANDBOX) { const j = await battleApi({ action: "switch" }); if (j && j.ok) { battleSetTally(j); say(j.done ? "⚔️ Battle over!" : "⏭ Turn switched"); } else say("That did not go through — try again."); return; }
    const en = e.target.closest("[data-bend]"); if (en && OWNER() && !SANDBOX) { const j = await battleApi({ action: "end" }); if (j && j.ok) { battleSetTally(j); say("⚔️ Battle ended — the winner is on the station card!"); } else say("That did not go through — try again."); return; }
  });
  function battleSecondTick() {
    if (SANDBOX) return;
    const b = S.battle; if (!b || !b.on || !b.id) return;
    const doneFresh = b.phase === "done" && Date.now() - (b.at || 0) < 5 * 60e3;
    if (b.phase !== "live" && !doneFresh) return;
    const secs = b.phase === "live" ? Math.max(0, Math.ceil(((b.turnEndsAt || 0) - Date.now()) / 1000)) : 0;
    const cd = document.getElementById("st-battle-cd"); if (cd) cd.textContent = secs;
    const cd2 = document.getElementById("battle-cd"); if (cd2) cd2.textContent = secs;
    if (Date.now() - battlePollAt > 10000) { battlePollAt = Date.now(); battleTallyFetch(b.id); }
    if (OWNER()) { paintBattlePanel(); if (b.phase === "live" && Date.now() > (b.turnEndsAt || 0)) battleAdvanceCall(); }
  }
  setInterval(() => { try { battleSecondTick(); } catch (_) {} }, 1000);
  /* The battler's side: inside their Playground (SANDBOX), a battle table
   * pushes performance state through the cf gate (merge_doc rpc — the
   * server merges ONLY sanitized performance fields, and only while it
   * is this battler's turn) and backstops the turn clock. Mirrors the
   * guestdj relay's shape and discipline; the relay itself is untouched. */
  function battlePushPerf() {
    const t = Date.now(); if (t - battlePushAt < 2000) return;
    const ses = mySess(); if (!ses || !ses.access_token) return;
    const freshVoice = S.voice && S.voice.id && S.voice.id !== battleVoiceSent && (S.voice.at || 0) > t - 30000;
    const anyDeck = DECKS.some((k) => S[k] && (S[k].src || S[k].yt));
    if (!anyDeck && !freshVoice) return; // nothing on my table yet — the outgoing state stays on air until I put something on
    battlePushAt = t;
    const patch = { A: S.A, B: S.B, C: S.C, D: S.D, xf: S.xf, xf2: S.xf2, panX: S.panX ?? 0.5, panY: S.panY, fx: S.fx };
    if (freshVoice) { patch.voice = S.voice; battleVoiceSent = S.voice.id; }
    fetch("/api/cf/rpc", { method: "POST", headers: battleHdrs(), body: JSON.stringify({ name: "merge_doc", args: { p_path: "radio/dj", p_patch: patch } }) }).catch(() => {});
  }
  async function battleGuestTick() {
    let on = false; try { on = sessionStorage.getItem("mw-battlelive") === "1"; } catch (_) {}
    if (!on) return;
    const ses = mySess(); const uid = ses && ses.user && ses.user.id; if (!uid) return;
    let d = null;
    try { const r = await fetch("/api/cf/rest", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ table: "docs", op: "select", select: "path,data", limit: 1, filters: [["path", "eq", "radio/dj"]] }) }); const j = await r.json(); const row = (j.data || [])[0]; d = row && (typeof row.data === "string" ? JSON.parse(row.data) : row.data); } catch (_) {}
    if (!d) return;
    const b = d.battle;
    const mine = b && b.on && b.id && (b.p1.uid === uid || b.p2.uid === uid);
    if (!mine || b.phase === "off") { try { sessionStorage.removeItem("mw-battlelive"); } catch (_) {} battleGuestTurnSeen = ""; say("⚔️ The battle is over for you — thanks for playing!"); return; }
    if (b.phase === "done") { try { sessionStorage.removeItem("mw-battlelive"); } catch (_) {} battleGuestTurnSeen = ""; const wn = b.winner === b.p1.uid ? gName(b.p1) : b.winner === b.p2.uid ? gName(b.p2) : ""; say(wn ? ("⚔️ Battle over — " + wn + " takes it!") : "⚔️ Battle over — it is a draw!"); return; }
    if (b.turn === uid) {
      if (battleGuestTurnSeen !== uid + b.round) { battleGuestTurnSeen = uid + b.round; say("⚔️ Your turn — you're on the decks!"); }
      battlePushPerf();
    }
    if (Date.now() > (b.turnEndsAt || 0)) battleAdvanceCall();
  }
  if (SANDBOX) setInterval(() => { battleGuestTick().catch(() => {}); }, 3000);

  /* ---------- listener song picker: the audience queues the radio ---------- */
  let pkTab = "mine", pkReal = null, pkItems = null, pkLabel = "", pkSubbed = false;
  const PK_GENRES = {
    hiphop: ['"hip hop" mixtape', '"rap" mixtape', 'creator:"Soulja Boy"', '"hip hop" "live"'],
    jazz: ['creator:"Miles Davis"', 'creator:"John Coltrane"', '"jazz" "live" quartet', 'creator:"Duke Ellington"'],
    rock: ['creator:"Grateful Dead"', '"rock" "live" concert', 'creator:"Phish"', '"rock" "live"'],
    soul: ['creator:"James Brown"', 'creator:"Marvin Gaye"', '"soul" "live"', '"motown"'],
    reggae: ['creator:"Bob Marley"', '"reggae" "live"', 'creator:"Peter Tosh"'],
    classics: ['creator:"Johnny Cash"', 'creator:"Frank Sinatra"', 'creator:"Duke Ellington"', '"big band" "live"'],
    more: ['creator:"Bob Dylan"', 'creator:"Janis Joplin"', '"blues" "live"', '"gospel" choir', '"funk" "live"'],
  };
  async function iaMulti(qs) {
    const seen = new Set(), out = [];
    const rs = await Promise.allSettled(qs.map((q) => iaSearch(q)));
    for (const r of rs) if (r.status === "fulfilled") for (const n of r.value) if (!seen.has(n.id)) { seen.add(n.id); out.push(n); }
    return out;
  }
  function paintPkList() {
    const box = $("#pk-list"); if (!box) return;
    const m = $("#pk-mine"), r = $("#pk-real");
    if (m) { m.classList.toggle("on", pkTab === "mine"); m.classList.toggle("ghost", pkTab !== "mine"); }
    if (r) { r.classList.toggle("on", pkTab === "real"); r.classList.toggle("ghost", pkTab !== "real"); }
    if (pkTab === "mine") {
      const ts = TRACKS();
      box.innerHTML = ts.length ? ts.map((t, i) => `<div class="dj-item"><span title="${E(t.title)}">${E(t.title)}</span><button class="btn sm" type="button" data-picklib="${i}">▶ Play next</button></div>`).join("") : '<small class="muted">The library is loading \u2014 one second.</small>';
      return;
    }
    if (pkItems == null) { box.innerHTML = `<small class="muted">Loading ${E(pkLabel || "music")}\u2026</small>`; return; }
    box.innerHTML = (pkLabel ? `<small class="muted" style="display:block;margin-bottom:4px">${E(pkLabel)} \u2014 ${pkItems.length} songs. Tap \u25B6 and yours plays next.</small>` : "") +
      (pkItems.length ? pkItems.map((n, i) => `<div class="dj-item"><span title="${E(n.title)}">${E(n.title)}</span><button class="btn sm" type="button" data-picknet="${i}">\u25B6 Play next</button></div>`).join("") : '<small class="muted">Nothing on this shelf right now \u2014 try a genre or search an artist.</small>');
  }
  async function loadReal() {
    const out = await iaMulti(['creator:"Johnny Cash"', 'creator:"Miles Davis"', 'creator:"Grateful Dead"', 'creator:"James Brown"', 'creator:"Bob Marley"', 'creator:"Duke Ellington"', 'creator:"John Coltrane"', 'creator:"Marvin Gaye"']);
    pkReal = out.slice(0, 60);
    if (pkTab === "real") { pkItems = pkReal; pkLabel = "Real artists"; paintPkList(); }
  }
  async function loadGenre(g) {
    const out = await iaMulti(PK_GENRES[g] || []);
    if (pkTab === "genre") { pkItems = out.slice(0, 60); paintPkList(); }
  }
  async function loadSearch(q) {
    let out = [];
    try { out = await iaSearch(q); } catch (_) {}
    if (pkTab === "search") { pkItems = out; paintPkList(); }
  }
  function subPicks() {
    if (pkSubbed || SANDBOX) return; const d = DBF(); if (!d) return; pkSubbed = true;
    try { d.collection("requests").limit(100).onSnapshot((s) => { const box = $("#pk-queue"); if (!box) return; const picks = s.docs.map((x) => x.data() || {}).filter((r) => r.kind === "pick").sort((a, b) => (a.at || 0) - (b.at || 0)); box.innerHTML = picks.length ? picks.map((p, i) => `<div class="dj-item"><span title="${E(p.title || "")}">${i + 1}. ${E(p.title || "")}</span><small class="muted">listener pick</small></div>`).join("") : '<small class="muted">No picks yet — be the first.</small>'; }, () => { pkSubbed = false; }); } catch (_) { pkSubbed = false; }
  }
  onMain("click", async (e) => {
    if (e.target.closest("#pk-mine")) { pkTab = "mine"; paintPkList(); return; }
    if (e.target.closest("#pk-real")) { pkTab = "real"; pkItems = pkReal; pkLabel = "Real artists"; paintPkList(); if (!pkReal) loadReal(); return; }
    const gb = e.target.closest("[data-pkgenre]");
    if (gb) { pkTab = "genre"; pkItems = null; pkLabel = gb.textContent.trim(); paintPkList(); loadGenre(gb.dataset.pkgenre); return; }
    const pl = e.target.closest("[data-picklib]"), pn = e.target.closest("[data-picknet]");
    if (!pl && !pn) return;
    const now = Date.now();
    if (now - (+(localStorage.getItem("mw-last-pick") || 0)) < 45000) { say("One pick at a time — your song is in line 🎵"); return; }
    let data = null;
    if (pl) { const t = TRACKS()[+pl.dataset.picklib]; if (t) data = { kind: "pick", title: t.title, src: URLOF(t), cover: t.cover || "", dur: +t.duration || 0, at: now }; }
    else { const n = (pkItems || [])[+pn.dataset.picknet]; if (n) data = { kind: "pick", title: n.title, iaId: n.id, cover: "https://archive.org/services/img/" + encodeURIComponent(n.id), at: now }; }
    if (!data) return;
    try { await sendRequest(data); try { localStorage.setItem("mw-last-pick", String(now)); } catch (_) {} say("🎵 Picked: " + data.title + " — it's in line for the radio!"); }
    catch (_) { say("That pick didn't go through — wait a few seconds and try again."); }
  });
  const pkFormEl = $("#pk-form");
  if (pkFormEl) pkFormEl.addEventListener("submit", (e) => { e.preventDefault(); const q = $("#pk-q").value.trim(); if (!q) return; pkTab = "search"; pkItems = null; pkLabel = "Search: " + q; paintPkList(); loadSearch(q); });

  /* ---------- ticker ---------- */
  $("#dj-ticker-set").addEventListener("click", () => { S.ticker = $("#dj-ticker-in").value.trim().slice(0, 140); save(true); paintStation(); say(S.ticker ? "Ticker is on the station card." : "Ticker cleared."); });

  /* Internet Archive: Creative Commons audio */
  async function iaSearch(q) {
    const query = `(${q}) AND mediatype:audio AND licenseurl:*creativecommons*`;
    const u = "https://archive.org/advancedsearch.php?q=" + encodeURIComponent(query) + "&fl[]=identifier&fl[]=title&fl[]=creator&sort[]=downloads+desc&rows=25&output=json";
    const r = await fetch(u); const j = await r.json();
    return (j.response?.docs || []).map((d) => ({ id: String(d.identifier), title: [].concat(d.title || d.identifier)[0] + (d.creator ? " · " + [].concat(d.creator)[0] : "") }));
  }
  async function iaFile(id) {
    try {
      const j = await (await fetch("https://archive.org/metadata/" + encodeURIComponent(id))).json();
      const f = (j.files || []).find((x) => /mp3/i.test(x.format || "") && /\.mp3$/i.test(x.name)) || (j.files || []).find((x) => /\.(mp3|ogg|m4a)$/i.test(x.name));
      return f ? "https://archive.org/download/" + encodeURIComponent(id) + "/" + f.name.split("/").map(encodeURIComponent).join("/") : "";
    } catch (_) { return ""; }
  }
  $("#dj-sf").addEventListener("submit", async (e) => {
    e.preventDefault(); const q = $("#dj-q").value.trim(); if (!q) return;
    $("#dj-net").innerHTML = '<small class="muted">Searching...</small>';
    try { net = await iaSearch(q); $("#dj-net").innerHTML = net.length ? net.map((n, i) => `<div class="dj-item"><span title="${E(n.title)}">${E(n.title)}</span><button class="btn ghost sm" type="button" data-load="A" data-net="${i}">A</button><button class="btn ghost sm" type="button" data-load="B" data-net="${i}">B</button><button class="btn ghost sm" type="button" data-load="C" data-net="${i}">C</button><button class="btn ghost sm" type="button" data-load="D" data-net="${i}">D</button><button class="btn ghost sm" type="button" data-nqueue="${i}">＋Q</button></div>`).join("") : '<small class="muted">Nothing found. Try another word.</small>'; }
    catch (_) { $("#dj-net").innerHTML = '<small class="muted">Search is busy. Try again in a moment.</small>'; }
  });

  /* ---------- start ---------- */
  let initTries = 0;
  async function init() {
    // the backend facade can lag this script in a fresh window — the decks
    // pop-out is exactly that, a new window where dj.js can run before the
    // facade exists. Bailing here with no retry left the pop-out frozen on
    // its empty OFF AIR markup while every other window showed the live
    // station, so retry until the facade answers (the requests subscription
    // above already retries the same way), then subscribe to the same
    // radio/dj doc the station card reads — one live signal everywhere.
    if (!window.claude) { if (initTries++ < 40) setTimeout(init, 750); return; }
    const d = await claude.use("db"); if (!d) { if (initTries++ < 40) setTimeout(init, 750); return; }
    if (!SANDBOX) d.doc("radio/camframe").onSnapshot((snap) => { camFrameDoc = snap.exists ? snap.data() : null; camOvSync(); }, () => {}); // the viewer camera square's frame source (BOOTH OPTIMIZATION Job A) — same doc facade + changes feed as radio/dj, fail-silent; the sandbox never subscribes, it never touches the frame doc
    if (!SANDBOX) d.doc("radio/dj").onSnapshot((snap) => onState(snap.exists ? snap.data() : null), () => {});
    else { try { const s0 = JSON.parse(sessionStorage.getItem("mw-playdj") || "null"); if (s0) S = mergeState(s0); } catch (_) {} setTimeout(() => { paintOwner(); DECKS.forEach((k) => { if (S[k] && (S[k].src || S[k].yt)) follow(k); }); }, 600); }
    if (SANDBOX) setInterval(async () => { let on = false; try { on = sessionStorage.getItem("mw-guestlive") === "1"; } catch (_) {} if (!on) return; try { const r = await fetch("/api/cf/rest", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ table: "docs", op: "select", select: "path,data", limit: 1, filters: [["path", "eq", "radio/dj"]] }) }); const j = await r.json(); const row = (j.data || [])[0]; const d = row && (typeof row.data === "string" ? JSON.parse(row.data) : row.data); const ses = (window.MW && MW.session && MW.session()) || null; const uid = ses && ses.user && ses.user.id; const g = d && d.djGuest; if (!g || !uid || g.uid !== uid || !(g.until > Date.now())) { try { sessionStorage.removeItem("mw-guestlive"); } catch (_) {} say("Your live slot has ended 🎧"); } } catch (_) {} }, 15000);
    const show = () => { const own = OWNER(); $("#dj-owner").hidden = !own; document.documentElement.classList.toggle("popdj-guest", document.documentElement.classList.contains("popdj") && !own); if (own) { libList(); paintOwner(); paintQueue(); paintPlaylists(); paintSched(); loadSchedDoc(); paintPads(); paintCurated(); subReqs(); const ti = $("#dj-ticker-in"); if (ti && document.activeElement !== ti) ti.value = S.ticker || ""; } paintPkList(); subPicks(); const vn = document.getElementById("dj-visit-note"); if (vn) vn.hidden = own; };
    showOwnerUI = show; show(); setTimeout(show, 1500); setTimeout(show, 5000);
    setInterval(() => { if (OWNER() && !$("#dj-owner").hidden && $("#dj-lib").children.length !== TRACKS().length) libList(); }, 4000);
    // scroll past the tables and the side buttons/floats fold away — nothing covers the decks
    const boothHome2 = document.getElementById("dj-booth-root");
    // the cut-off gate, scroll-driven (fixes the 2026-10-26 tabs trap for good):
    // an IntersectionObserver alone only reports enter/exit, so a ratio condition
    // inside it goes stale mid-scroll — the bars stayed hidden at the very top.
    // dj-on now means: the booth's top has scrolled up to the viewport top AND
    // the booth still fills the lower screen — i.e. he is working the tables.
    // At the hero, scrolling back up, or on any other view, every bar stays.
    // LAW 22: the gate state is cached and the classes are written only
    // when it actually changes — a scroll frame that changes nothing does
    // one rect read and no DOM writes, so scrolling never restyles the
    // booth chrome or competes with the music.
    let gateState = "";
    const boothGate = () => { if (!boothHome2) return; const r = boothHome2.getBoundingClientRect(); const on = r.top <= 80 && r.bottom > innerHeight * 0.5, st = on ? "on" : (r.bottom < 0 ? "past" : ""); if (st === gateState) return; gateState = st; document.body.classList.toggle("dj-on", st === "on"); document.body.classList.toggle("dj-past", st === "past"); };
    if (boothHome2) { let gateQueued = false; const gateSoon = () => { if (gateQueued) return; gateQueued = true; requestAnimationFrame(() => { gateQueued = false; boothGate(); }); }; addEventListener("scroll", gateSoon, { passive: true }); addEventListener("resize", gateSoon); addEventListener("hashchange", () => { boothGate(); setTimeout(boothGate, 300); }); if ("IntersectionObserver" in window) new IntersectionObserver(() => boothGate(), { threshold: 0 }).observe(boothHome2); boothGate(); setTimeout(boothGate, 800); }
    const stBox2 = document.getElementById("st-ytbox");
    if (stBox2 && "IntersectionObserver" in window) new IntersectionObserver((es) => { es.forEach((en) => { stInView = en.isIntersecting; }); }, { threshold: 0.05 }).observe(stBox2);
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init); else init();
})();
