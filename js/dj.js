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
      try { ctx = new (window.AudioContext || window.webkitAudioContext)(); } catch (_) { ctx = null; }
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
    d.set = (src) => new Promise((res) => {
      if (d.shim) d.clearYt();
      if (d.src === src) return res(true);
      d.src = src; d.cors = true; d.el.crossOrigin = "anonymous"; d.el.src = src; d.peaks = null;
      const ok = () => { clean(); wire(); res(true); };
      const bad = () => { clean(); if (d.cors) { d.cors = false;
          if (d.gain) { const old = d.el; old.pause(); d.el = new Audio(); d.el.preload = "auto"; d.el.playsInline = true; d.gain = null; d.eq = null; d.flt = null; d.stem = null; d.onswap && d.onswap(old); }
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
      d.shim = sh; d.el = sh;
      const okP = await sh._mount(mount); if (d.shim !== sh) return false;
      try { sh._p && sh._p.setVolume(Math.round(d.level * 100)); if (S[d.letter] && S[d.letter].playing) sh.play(); } catch (_) {}
      return okP;
    };
    d.clearYt = () => { if (d.shim) { try { d.shim._p && d.shim._p.destroy(); } catch (_) {} d.shim = null; if (d._audioEl) d.el = d._audioEl; } if (d.ytId) d.ytId = ""; const wrap = document.getElementById("ytw-" + d.letter); if (wrap) { wrap.hidden = true; wrap.innerHTML = '<div id="yt-' + d.letter + '"></div>'; } };
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
    m = v.match(/dailymotion\.com\/video\/([a-z0-9]+)/i) || v.match(/dai\.ly\/([a-z0-9]+)/i); if (m) return { yt: "dm:" + m[1], src: "", title: "Dailymotion video", cover: "https://www.dailymotion.com/thumbnail/video/" + m[1], dur: 0 };
    m = v.match(/archive\.org\/details\/([A-Za-z0-9_.-]+)/); if (m) return { iaId: m[1], title: "Archive video" };
    return null;
  };
  function ytShim(d, vid, onTitle) {
    const sh = { _p: null, _dur: 0, _rate: 1, _h: {}, seeking: false, readyState: 0 };
    Object.defineProperties(sh, {
      currentTime: { get() { try { return sh._p ? sh._p.getCurrentTime() || 0 : 0; } catch (_) { return 0; } }, set(t) { try { sh._p && sh._p.seekTo(Math.max(0, +t || 0), true); } catch (_) {} } },
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
        // allowed) and bring the sound up the moment it is actually playing
        let muted = false; const t0 = Date.now();
        const iv = setInterval(() => {
          try {
            const st = sh._p.getPlayerState();
            if (st === 1) { if (muted) { sh._p.unMute(); sh._p.setVolume(Math.round((d.level || 1) * 100)); } clearInterval(iv); return; }
            if (Date.now() - t0 > 4000) { clearInterval(iv); return; }
            if (!muted && st !== 3 && Date.now() - t0 > 800) { muted = true; sh._p.mute(); sh._p.playVideo(); }
          } catch (_) { clearInterval(iv); }
        }, 250);
      } catch (_) {}
      return Promise.resolve();
    };
    sh.pause = () => { try { sh._p && sh._p.pauseVideo(); } catch (_) {} };
    sh.addEventListener = (ev, fn) => { (sh._h[ev] = sh._h[ev] || []).push(fn); };
    sh.removeEventListener = (ev, fn) => { if (sh._h[ev]) sh._h[ev] = sh._h[ev].filter((f) => f !== fn); };
    sh._fire = (ev) => (sh._h[ev] || []).slice().forEach((f) => { try { f(); } catch (_) {} });
    sh._mount = (mountEl) => new Promise((res) => {
      let done = false; const fin = (v) => { if (!done) { done = true; res(v); } };
      try {
        sh._p = new YT.Player(mountEl, { videoId: vid, width: "100%", height: "100%", playerVars: { playsinline: 1, rel: 0, controls: 1 }, events: {
          onReady: (e) => { sh.readyState = 4; try { sh._dur = e.target.getDuration() || 0; const vd = e.target.getVideoData && e.target.getVideoData(); if (vd && onTitle) onTitle(vd.title || "", sh._dur); } catch (_) {} fin(true); },
          onStateChange: (e) => { if (e.data === 0) sh._fire("ended"); if (e.data === 1) { try { sh._dur = sh._p.getDuration() || sh._dur; } catch (_) {} } },
          onError: () => fin(false),
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
      currentTime: { get() { return sh._cur || 0; }, set(t) { try { wrap._dm && wrap._dm.seek(Math.max(0, +t || 0)); } catch (_) {} } },
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
        on("timeupdate", (e) => { try { if (e && typeof e.time === "number") sh._cur = e.time; if (e && typeof e.time === "number" && e.duration) sh._dur = e.duration; } catch (_) {} });
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
      currentTime: { get() { return sh._cur || 0; }, set(t) { try { wrap._vm && wrap._vm.setCurrentTime(Math.max(0, +t || 0)).catch(() => {}); } catch (_) {} } },
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
        p.on("timeupdate", (e) => { try { if (e && typeof e.seconds === "number") sh._cur = e.seconds; } catch (_) {} });
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

  /* ---------- shared station state (doc radio/dj) ---------- */
  const blank = () => ({ src: "", yt: "", title: "", cover: "", start: 0, pos: 0, playing: false, vol: 0.9, rate: 1, dur: 0 });
  const defFx = () => ({ mf: 100, echo: 0, fb: 0.34, verb: 0, fla: 0, pha: 0, noise: 0, ediv: 0.75, gate: 0, crush: 0, sync: true, boost: 1 });
  let S = { live: false, xf: 0.5, xf2: 0.5, xfCurve: "smooth", panY: 0, duck: false, quant: true, A: blank(), B: blank(), C: blank(), D: blank(), voice: null, updatedAt: 0, liveSince: 0, ticker: "", log: [], show: null, pads: [], autodj: true, fx: defFx(), vmix: { mode: "auto", a: "", b: "", t: 0 } };
  const posOf = (k) => { const s = S[k]; return s.playing ? Math.max(0, (Date.now() - s.start) / 1000) : (s.pos || 0); };
  let saveT = null;
  let guestPostAt = 0;
  function guestRelay() {
    let on = false; try { on = sessionStorage.getItem("mw-guestlive") === "1"; } catch (_) {}
    if (!on) return;
    const t = Date.now(); if (t - guestPostAt < 2500) return; guestPostAt = t;
    const ses = (window.MW && MW.session && MW.session()) || null; const tok = ses && ses.access_token; if (!tok) return;
    fetch("/api/station", { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer " + tok }, body: JSON.stringify({ kind: "guestdj", A: S.A, B: S.B, C: S.C, D: S.D, xf: S.xf, xf2: S.xf2, panY: S.panY, fx: S.fx, voice: S.voice }) }).then((r) => r.json()).then((j) => { if (j && j.ok === false) { try { sessionStorage.removeItem("mw-guestlive"); } catch (_) {} say("Your live slot has ended — thanks for spinning 🎧"); } }).catch(() => {});
  }
  function save(now) { if (!OWNER()) return; if (SANDBOX) { S.updatedAt = Date.now(); S.boothAt = Date.now(); try { sessionStorage.setItem("mw-playdj", JSON.stringify(S)); } catch (_) {} guestRelay(); return; } clearTimeout(saveT); const run = () => { S.updatedAt = Date.now(); S.boothAt = Date.now(); S.by = tabId; DB()?.doc("radio/dj").set(JSON.parse(JSON.stringify(S))).catch((e) => say(e.message || e.code)); }; if (now) run(); else saveT = setTimeout(run, 250); }
  function logPlay(title) { if (!title) return; S.log = [{ t: title, at: Date.now(), live: !!S.live }].concat((S.log || []).filter((x) => x.t !== title)).slice(0, 30); }

  /* ---------- styles ---------- */
  const css = document.createElement("style");
  css.textContent = `
.dj{margin-top:40px;border:1px solid var(--gold-lo);border-radius:20px;padding:26px;background:radial-gradient(ellipse at 50% 0,#2a2112 0,#100d08 60%);box-shadow:0 20px 50px rgba(0,0,0,.5);min-width:0}
#v-radio .wrap{max-width:1500px}
#dj-booth-root{width:100%;min-width:0}
.dj-top{display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap;margin-bottom:14px}
.dj-top h3{margin:0;font-size:26px}
.dj-live{display:flex;align-items:center;gap:8px;font-weight:700}
.dj-live input{width:20px;height:20px;accent-color:#e5484d}
.onair-lamp{display:inline-flex;align-items:center;gap:8px;font:800 13px var(--body);letter-spacing:.14em;padding:7px 12px;border-radius:999px;border:1px solid var(--line);color:var(--muted)}
.onair-lamp.on{color:#fff;background:#a3161c;border-color:#e5484d;box-shadow:0 0 18px rgba(229,72,77,.55)}
.onair-lamp .dot{width:9px;height:9px;border-radius:50%;background:#666}
.onair-lamp.on .dot{background:#ff5b60;animation:djpulse 1.2s infinite}
@keyframes djpulse{50%{opacity:.35}}
.dj-clock{font:700 13px ui-monospace,monospace;color:var(--gold-hi)}
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
.eqrow label{font-size:10px;color:var(--muted);letter-spacing:.08em;display:grid;gap:2px}
.cuebtn.on{background:var(--gold);color:#191104;border-color:var(--gold)}
.gatebtn.on,.pktab.on{background:var(--gold);color:#191104;border-color:var(--gold)}
.loopbtn.on{background:#a3161c;color:#fff;border-color:#e5484d}
.mixer{background:#0c0a07;border:1px solid var(--line);border-radius:16px;padding:14px 10px;display:grid;gap:12px;align-content:start;justify-items:center;text-align:center;min-width:0}
.mixer>*{max-width:100%}
.mixer label{white-space:normal}
.mixer small{overflow-wrap:break-word}
.mixer small{color:var(--muted);font-size:11px;letter-spacing:.12em}
.talk{width:120px;height:120px;border-radius:50%;border:3px solid #e5484d;background:#2a0f10;color:#fff;font:800 13px var(--body);cursor:pointer;touch-action:none;user-select:none;-webkit-user-select:none}
.talk.on{background:#e5484d;box-shadow:0 0 0 8px rgba(229,72,77,.25),0 0 30px #e5484d}
.micmeter{width:100%;height:8px;background:#1c1710;border-radius:99px;overflow:hidden}
.micmeter i{display:block;height:100%;width:0;background:linear-gradient(90deg,#45bd62,#f7b928,#e5484d);transition:width .08s}
.dj-grid2{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(430px,100%),1fr));gap:14px;margin-top:14px}
.dj-panel{background:#0c0a07;border:1px solid var(--line);border-radius:16px;padding:14px;display:grid;gap:10px;align-content:start;min-width:0}
.dj-panel h4{margin:0;font:800 12px var(--body);letter-spacing:.16em;color:var(--gold-hi)}
.pads{display:grid;grid-template-columns:repeat(4,1fr);gap:8px}
.pad{padding:20px 8px;border-radius:12px;border:1px solid var(--gold-lo);background:#171208;color:var(--text);font:700 12px var(--body);cursor:pointer}
.pad:active{transform:scale(.96)}
.pad.custom{border-style:dashed}
.pad small{display:block;color:var(--muted);font-weight:600;font-size:10px;margin-top:3px}
.dj-list{display:grid;gap:6px;max-height:240px;overflow:auto;min-width:0}
.dj-item{display:grid;grid-template-columns:minmax(0,1fr) repeat(5,auto);gap:6px;align-items:center;padding:8px;border:1px solid var(--line);border-radius:10px;font-size:14px;min-width:0}
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
#dj-owner [data-play]{min-height:50px;font-size:16px}
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
  html.popdj #dj-owner [data-play]{min-height:52px;font-size:16px}
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
.ptab-on{align-self:center;font:800 12.5px var(--body);color:#45bd62;white-space:nowrap;padding:0 4px}
.xfpad{position:relative;width:150px;height:150px;border-radius:16px;border:2px solid var(--gold-lo);background-color:#100d08;background-image:linear-gradient(90deg,transparent calc(50% - 1px),rgba(232,197,102,.16) 50%,transparent calc(50% + 1px)),linear-gradient(180deg,transparent calc(50% - 1px),rgba(232,197,102,.16) 50%,transparent calc(50% + 1px));touch-action:none;cursor:grab;margin:2px auto;overflow:hidden}
.xfpad::before{content:"";position:absolute;left:50%;top:50%;width:142%;height:2px;background:rgba(232,197,102,.45);transform:translate(-50%,-50%) rotate(45deg);pointer-events:none}
.xfpad::after{content:"";position:absolute;left:50%;top:50%;width:142%;height:2px;background:rgba(232,197,102,.45);transform:translate(-50%,-50%) rotate(-45deg);pointer-events:none}
.xfpad:active{cursor:grabbing}
.dsec{margin-top:4px;border-top:1px solid #241d10}
.dsec-h{display:flex;justify-content:space-between;align-items:center;width:100%;background:none;border:0;color:var(--gold-lo);font:700 11px var(--body);letter-spacing:.14em;padding:8px 2px;cursor:pointer;min-height:38px;text-transform:uppercase}
.dsec-a{font-size:13px;transition:transform .15s}
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
@media(min-width:761px){#dj-owner .deck{gap:6px;padding:10px}#dj-owner .deck .platter{width:172px}#dj-owner .deck .wave{height:58px}#dj-owner .deck .btn{padding:6px 9px;font-size:12.5px;min-height:34px}#dj-owner .deck .row{gap:5px}#dj-owner .deck .eqrow{gap:4px}#dj-owner .deck h4{margin:0;font-size:13px}#dj-owner .mixer{gap:6px;padding:10px}#dj-owner .xfpad.big{width:148px;height:148px}}
/* three-zone console on wide screens (Malik: "A and B decks on the left, C and D on
   the right, make the song pick and mixer in the middle"): the deck bank unwraps so
   its pieces place straight into the booth grid — A/B left, C/D right, and the middle
   column stacks main mixer, SONG PICKER, C/D mixer. */
@media(min-width:1500px){#dj-owner{display:grid;grid-template-columns:1fr 1fr 500px 1fr 1fr;gap:14px;align-items:start}#dj-owner>.dj-top{grid-column:1/-1}#dj-owner>.dj-setups{grid-column:1/-1;margin-bottom:0}#dj-owner>.dj-decks{display:contents}#dj-owner .deck[data-deck="A"]{grid-column:1;grid-row:3/span 3}#dj-owner .deck[data-deck="B"]{grid-column:2;grid-row:3/span 3}#dj-owner .deck[data-deck="C"]{grid-column:4;grid-row:3/span 3}#dj-owner .deck[data-deck="D"]{grid-column:5;grid-row:3/span 3}#dj-owner .mixer.m1{grid-column:3;grid-row:4}#dj-owner #dj-browser{grid-column:3;grid-row:3;margin-top:0!important}#dj-owner .mixer.m2{grid-column:3;grid-row:5}#dj-owner>.dj-grid2{grid-column:1/-1}#dj-owner .swapbar{display:none}}
html.popdj .popdj-hint{display:block}
.dj-rotate{display:none}
@media (orientation:portrait) and (max-width:900px){.dj-rotate{display:flex;align-items:center;gap:8px;background:linear-gradient(180deg,#2a2112,#15110a);border:1px solid var(--gold);color:var(--text);border-radius:10px;padding:9px 12px;font:600 13.5px var(--body);margin-bottom:10px}}
@media (max-width:760px){.dj-decks{grid-template-columns:minmax(0,1fr) minmax(0,1fr)}#dj-browser .dj-item{grid-template-columns:minmax(0,1fr) repeat(5,44px)}#dj-browser .dj-item .btn{min-width:44px;width:44px;padding:0}}
@media (orientation:landscape) and (max-height:540px) and (max-width:1100px){.dj-decks{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:8px}.dj-decks>.deck[data-deck="A"]{grid-column:1;grid-row:1}.dj-decks>.deck[data-deck="B"]{grid-column:2;grid-row:1}.dj-decks>.deck[data-deck="C"]{grid-column:3;grid-row:1}.dj-decks>.deck[data-deck="D"]{grid-column:4;grid-row:1}.dj-decks>.mixer.m1{grid-column:1/-1;grid-row:2}.dj-decks>.mixer.m2{grid-column:1/-1;grid-row:3}.dj-decks>.swapbar{display:none!important}#dj-owner .deck{padding:8px;gap:5px}#dj-owner .deck .platter{width:92px}#dj-owner .deck .wave{height:40px}}
.vstage{position:relative;width:100%;aspect-ratio:16/9;background:#000;border:1px solid var(--line);border-radius:10px;overflow:hidden}
.vslot{position:absolute;inset:0;opacity:0;transition:opacity .12s linear;pointer-events:none}
#app-poll [data-appvote].on{outline:2px solid #f0cf78;outline-offset:2px}
.vstage .vslot{overflow:hidden}
.vstage .vslot iframe{filter:brightness(var(--vb,1)) contrast(var(--vc,1)) saturate(var(--vs,1));transform:scale(var(--vz,1))}
#dj-edit .edgrid{display:grid;grid-template-columns:1fr 1fr;gap:4px 24px}
@media(max-width:760px){#dj-edit .edgrid{grid-template-columns:1fr}}
#dj-edit label{display:flex;justify-content:space-between;gap:8px;font-size:12px;color:var(--muted);margin-top:7px}
#dj-edit label span{color:#e9d9a6;font-weight:700}
.vslot iframe{width:100%;height:100%;border:0}
.vstandby{position:absolute;inset:0;display:grid;place-items:center;color:var(--muted);font:600 12.5px var(--body);letter-spacing:.05em;text-align:center;padding:12px;z-index:1}
.vchip{position:absolute;left:8px;bottom:8px;max-width:calc(100% - 16px);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;background:rgba(0,0,0,.68);border:1px solid var(--gold-lo);color:var(--text);border-radius:999px;padding:3px 10px;font:700 11.5px var(--body);z-index:3}
.vmixrow{display:flex;gap:6px;flex-wrap:wrap;align-items:center;margin-top:6px}
.vmixrow .btn.on{background:var(--gold);color:#0b0a08;border-color:var(--gold)}
/* MASTER SCREEN above the table (Malik, 2026-10-26): out of the mixer, full booth
   width, cinema height — tall enough to star, capped so the decks stay in reach */
#dj-screen{position:relative;margin:0 0 12px}
#dj-screen>small{display:block;color:var(--muted);font-size:11px;letter-spacing:.12em;margin-bottom:6px}
#dj-screen .vstage{aspect-ratio:21/9;max-height:46vh;min-height:170px;border-radius:14px}
@media(max-width:760px){#dj-screen .vstage{min-height:150px;max-height:36vh}}
@media(min-width:1500px){#dj-owner>#dj-screen{grid-column:1/-1;grid-row:3}#dj-owner>#dj-edit{grid-column:1/-1;grid-row:4}#dj-owner .deck[data-deck="A"]{grid-row:5/span 3}#dj-owner .deck[data-deck="B"]{grid-row:5/span 3}#dj-owner .deck[data-deck="C"]{grid-row:5/span 3}#dj-owner .deck[data-deck="D"]{grid-row:5/span 3}#dj-owner #dj-browser{grid-row:5}#dj-owner #dj-xfbar{grid-column:3;grid-row:6}#dj-owner .mixer.m1{grid-row:7}#dj-owner .mixer.m2{grid-row:8}}
/* MINI MASTER SCREEN (owner, 2026-10-26): the live video follows viewers to the
   top of every page in a little rectangle; it steps aside whenever a big screen
   (the booth's or the station card's) is already in front of them */
#dj-livealert{position:fixed;top:124px;left:50%;transform:translateX(-50%);z-index:66;display:flex;gap:8px;align-items:center;background:linear-gradient(180deg,#1d1e21,#101012);border:1px solid #f0cf78;border-radius:999px;padding:7px 10px;box-shadow:0 12px 32px rgba(0,0,0,.6);max-width:min(94vw,560px)}
#dj-livealert[hidden]{display:none}
#dj-livealert .la-txt{font:700 12.5px var(--body);color:#ffe9b0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
#dj-livealert .btn{white-space:nowrap}
body.dj-on #dj-livealert,html.popdj #dj-livealert,html.gated #dj-livealert{display:none!important}
@media (max-width:760px){#dj-livealert{top:118px}#dj-livealert .la-txt{font-size:11.5px}}
body[data-view="dj"] #dj-livealert{display:none}
#dj-mini{position:fixed;top:64px;right:10px;width:208px;z-index:65;background:#000;border:1px solid var(--gold-lo);border-radius:12px;overflow:hidden;box-shadow:0 10px 30px rgba(0,0,0,.55)}
#dj-mini .mn-bar{display:flex;align-items:center;justify-content:space-between;gap:6px;background:#141109;color:var(--gold-hi,#f0cf78);font:700 10px var(--body);letter-spacing:.1em;padding:4px 8px}
#dj-mini .mn-bar button{background:none;border:0;color:var(--muted);font-size:12px;cursor:pointer;padding:0 2px}
#dj-mini .mn-bar{cursor:grab;touch-action:none;user-select:none;-webkit-user-select:none}
#dj-mini.mn-drag .mn-bar{cursor:grabbing}
#dj-mini .vstage{border:0;border-radius:0}
@media(max-width:760px){#dj-mini{top:56px;width:168px}}
html.popdj #dj-mini,html.gated #dj-mini{display:none!important}
#dj-owner [data-ckey]{position:relative}
#dj-owner [data-ckey].ck-off{display:none!important}
#dj-owner.ck-on [data-ckey]{outline:1.5px dashed rgba(212,168,67,.55);outline-offset:2px}
.ck-chip{position:absolute;top:6px;right:6px;z-index:6;display:none;background:#1d1a14;border:1px solid var(--gold);color:var(--gold-hi);border-radius:999px;padding:5px 11px;font:700 12px var(--body);cursor:pointer}
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
#dj-booth-root #dj-owner .deck h4{font-size:12px}
#dj-booth-root #dj-owner .btn{min-height:40px;font-size:12.5px;padding:5px 8px}
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
#dj-booth-root #dj-owner .deck h4{font-size:12px}
#dj-booth-root #dj-owner .btn{min-height:38px;font-size:12px;padding:4px 7px}
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
#dj-owner .deck h4{letter-spacing:.22em;font-size:12px;color:#d8d4c9;border-left:4px solid var(--dk,#f0cf78);padding-left:8px;text-align:left}
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
#dj-booth-root #dj-owner [data-play],#dj-booth-root #dj-owner [data-cue0],#dj-booth-root #dj-owner [data-brake]{width:62px;height:62px;min-height:62px;border-radius:50%;padding:0;flex:none;font-size:11px;line-height:1.15}
#dj-booth-root #dj-owner [data-play]{border:3px solid #4ade80!important;background:#0c1710;color:#dcffe6;box-shadow:0 0 0 3px #050d08,0 0 16px rgba(74,222,128,.4),0 4px 10px rgba(0,0,0,.55)}
#dj-booth-root #dj-owner [data-cue0]{border:3px solid #f0cf78!important;background:#171106;color:#ffe9b0;box-shadow:0 0 0 3px #0d0a03,0 0 12px rgba(240,207,120,.3),0 4px 10px rgba(0,0,0,.55)}
#dj-booth-root #dj-owner [data-brake]{border:2px solid #43434a!important;background:#141416;color:#e8e4da;box-shadow:0 4px 10px rgba(0,0,0,.5)}
@media(max-width:760px){#dj-booth-root #dj-owner [data-play],#dj-booth-root #dj-owner [data-cue0],#dj-booth-root #dj-owner [data-brake]{width:52px;height:52px;min-height:52px;font-size:10px}}
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
.midilist .mrow{display:flex;align-items:center;gap:6px;font-size:12px;padding:2px 4px;border-radius:6px}
.midilist .mrow b{flex:1;min-width:0;font-weight:600}
.midilist .mrow .mb{font-size:10.5px;color:var(--gold-hi,#f0cf78);white-space:nowrap}
.midilist .mrow.learning{background:rgba(240,207,120,.14);outline:1px solid var(--gold-lo)}
.xfrow{display:flex;align-items:center;justify-content:center;gap:18px}
.xfvols{display:flex;gap:14px}
.xv{width:64px;text-align:center;cursor:ns-resize;touch-action:none;user-select:none;-webkit-user-select:none}
.xv i{display:block;width:52px;height:52px;margin:0 auto;border-radius:50%;background:radial-gradient(circle at 35% 30%,#3a3a40,#131315 70%);border:2px solid #000;outline:2px solid #77777f;position:relative;transform:rotate(var(--rot,-45deg))}
.xv i::after{content:"";position:absolute;left:50%;top:3px;width:3px;height:16px;margin-left:-1.5px;border-radius:2px;background:var(--dk)}
.xv span{display:block;font:700 9.5px var(--body);letter-spacing:.08em;color:var(--gold-hi,#f0cf78);margin-top:4px}
.xv b{display:block;font-size:10.5px;color:#e8e2d0;font-weight:600}
@media(max-width:760px){.xv{width:54px}.xv i{width:44px;height:44px}.xfrow{gap:10px}.xfvols{gap:8px}}
/* PHONE DECK SETUPS (owner ask, 2026-10-27): on a portrait phone the booth is
 * a compact controller — tap 1, 2, 3 or 4 decks. 1-deck mode shows ONE deck
 * with an A B C D switch on it (red dot = that deck is playing). Hidden decks
 * keep playing; only the view changes. This replaces the old phone DECK LOCK
 * for portrait phones at the owner's direct ask. Desktop + landscape untouched. */
#dj-phset{display:none}
@media (max-width:760px) and (orientation:portrait){
#dj-phset{display:grid;gap:8px;margin:0 0 10px}
#dj-phset .phrow{display:flex;gap:6px;align-items:center}
#dj-phset .phlab{font:800 10.5px var(--body);letter-spacing:.12em;color:var(--muted,#a99f8b);margin-right:2px;flex:none}
#dj-phset button{flex:1;min-height:42px;border-radius:11px;border:1px solid #3a3223;background:#14110b;color:#e8e2d0;font:800 13.5px var(--body);cursor:pointer;position:relative;padding:6px 2px}
#dj-phset button.on{border-color:var(--gold,#d4a843);background:rgba(212,168,67,.18);color:var(--gold-hi,#f0cf78)}
#dj-phset #dj-phdeck{display:none}
#dj-phset[data-n="1"] #dj-phdeck{display:flex}
#dj-phset .phdot{display:none;width:8px;height:8px;border-radius:50%;background:#ff4747;position:absolute;top:6px;right:8px;box-shadow:0 0 8px #ff4747}
#dj-phset button.playing .phdot{display:block}
#dj-booth-root #dj-owner .dj-decks[data-phn="1"]>.deck{display:none}
#dj-booth-root #dj-owner .dj-decks[data-phn="1"]>.deck.ph-on{display:grid;grid-column:1/-1;grid-row:1}
#dj-booth-root #dj-owner .dj-decks[data-phn="1"]>.mixer.m1{grid-column:1/-1;grid-row:2}
#dj-booth-root #dj-owner .dj-decks[data-phn="1"]>.mixer.m2{grid-column:1/-1;grid-row:3}
#dj-booth-root #dj-owner .dj-decks[data-phn="1"] .deck .platter{width:min(210px,62vw)}
#dj-booth-root #dj-owner .dj-decks[data-phn="2"]>.deck[data-deck="C"],#dj-booth-root #dj-owner .dj-decks[data-phn="2"]>.deck[data-deck="D"]{display:none}
#dj-booth-root #dj-owner .dj-decks[data-phn="2"]>.mixer.m2{grid-row:3}
#dj-booth-root #dj-owner .dj-decks[data-phn="3"]>.deck[data-deck="D"]{display:none}
#dj-booth-root #dj-owner .dj-decks[data-phn="3"]>.deck[data-deck="C"]{grid-column:1/-1;grid-row:3}
#dj-booth-root #dj-owner .dj-decks[data-phn="3"]>.mixer.m2{grid-row:4}
#dj-booth-root{overflow-x:clip}
#dj-booth-root #dj-owner .xfrow{gap:8px}
#dj-booth-root #dj-owner .xfvols{gap:6px}
#dj-booth-root #dj-owner .xv{width:46px}
#dj-booth-root #dj-owner .xv i{width:38px;height:38px}
#dj-booth-root #dj-owner .xfpad.big{width:104px;height:104px}
#dj-yt{min-width:0!important}
#dj-ytform input{min-width:0}
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
#dj-livealert .la-txt{flex:1 1 auto;min-width:0;white-space:normal;line-height:1.3}
#dj-booth-root #dj-owner .xfpad{background:linear-gradient(135deg,#1b1c1f,#0c0c0e);border:1.5px solid #3f3f46;box-shadow:inset 0 1px 0 rgba(255,255,255,.07),inset 0 0 22px #000}
#dj-booth-root #dj-owner .xfdot{position:absolute;width:34px;height:34px;border-radius:50%;transform:translate(-50%,-50%);background:radial-gradient(circle at 35% 30%,#f5f5f7,#a8a8b0 55%,#55555c);border:2px solid #000;box-shadow:0 4px 10px rgba(0,0,0,.65),0 0 0 3px rgba(240,207,120,.25);z-index:3;pointer-events:none}
#dj-booth-root #dj-owner .platter{border-color:#45454c}
#dj-booth-root #dj-owner .platter::before{background:repeating-conic-gradient(from 0deg,rgba(235,235,240,.85) 0deg 2deg,transparent 2deg 10deg)}
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
#dj-booth-root #dj-owner .xfcurve span{font:800 10px var(--body);letter-spacing:.12em;color:var(--muted)}
#dj-booth-root #dj-owner .xfcurve button{background:linear-gradient(180deg,#17181a,#0c0c0e);border:2px solid #3a3a40;color:#e8e4da;border-radius:8px;padding:5px 10px;font:700 11px var(--body);cursor:pointer;box-shadow:0 2px 0 #000}
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
}`;
  document.head.appendChild(css);

  // collapsible deck sections: one shared open/shut choice per section, remembered
  // on this device — fold a deck down to just its platter, wave and Play row
  const secState = (() => { try { return Object.assign({ tempo: 1, cues: 0, sound: 1 }, JSON.parse(localStorage.getItem("mw-dsec-v1") || "{}")); } catch (_) { return { tempo: 1, cues: 0, sound: 1 }; } })();
  const secShut = (n) => (secState[n] ? "" : " shut");
  const deckHTML = (k) => `<div class="deck" data-deck="${k}"><h4>DECK ${k}</h4><div class="platter" id="pl-${k}" title="Drag to scratch / scrub"></div>
    <canvas class="wave" id="wv-${k}" width="520" height="84"></canvas>
    <div class="ytbox" id="ytw-${k}" hidden><div id="yt-${k}"></div></div>
    <div class="ttl" id="ttl-${k}">Load a song</div><div class="tm" id="tm-${k}">0:00</div>
    <div class="beatbox"><span class="bpmv" id="bpm-${k}">BPM —</span><span class="keyv" id="key-${k}"></span><span class="bdots" id="dots-${k}"><i></i><i></i><i></i><i></i></span></div>
    <div class="dsec${secShut("tempo")}" data-dsec="tempo"><button class="dsec-h" type="button" data-dsecbtn="tempo">⏱ Tempo & grid<span class="dsec-a">▾</span></button><div class="dsec-b"><div class="row"><button class="btn ghost sm" type="button" data-tap="${k}">👆 TAP</button><button class="btn ghost sm" type="button" data-bpmadj="${k}:-0.1">BPM −</button><button class="btn ghost sm" type="button" data-bpmadj="${k}:0.1">BPM +</button><button class="btn ghost sm" type="button" data-bpmx="${k}:2">×2</button><button class="btn ghost sm" type="button" data-bpmx="${k}:0.5">÷2</button><button class="btn ghost sm" type="button" data-nudge="${k}:-1">◀ grid</button><button class="btn ghost sm" type="button" data-nudge="${k}:1">grid ▶</button></div></div></div>
    <div class="row"><button class="btn sm" type="button" data-play="${k}">▶ Play</button><button class="btn ghost sm" type="button" data-cue0="${k}">⏮ Cue</button><button class="btn ghost sm" type="button" data-brake="${k}">🛑 Brake</button></div>
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
<div class="dj-banner" id="dj-banner" hidden><span><b>● LIVE DJ SET</b> &nbsp;Meechie is on the decks right now</span><button class="btn sm" type="button" id="dj-listen">🎧 Listen live</button></div>
<div class="station" id="dj-station" hidden>
  <div style="display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap"><h3>📻 Meechie's World Radio</h3><span style="display:flex;gap:8px;align-items:center"><span class="onair-lamp" id="st-lamp"><span class="dot"></span>OFF AIR</span><button class="btn ghost sm" type="button" data-fold="st-body" aria-label="Fold the station panel">▾</button></span></div>
  <div id="st-body">
  <div class="ticker" id="st-ticker" hidden><span id="st-ticker-t"></span></div>
  <div id="st-now" class="muted" style="font-size:14px">The station is on the playlist right now.</div>
  <div id="st-online" class="muted" style="font-size:13px"></div>
  <div id="st-show"></div>
  <div id="st-ytbox" hidden><b style="font-size:12px;letter-spacing:.1em">📺 ON AIR — MUSIC VIDEO</b><div class="vstage"><div class="vslot" id="st-vs1"></div><div class="vslot" id="st-vs2"></div><div class="vstandby" id="st-vstandby" style="white-space:pre-line">Meechie is live on the tables — the video mix lands here the moment a music video plays.</div><div class="vchip" id="st-vchip" hidden></div></div></div>
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
    <label class="dj-live"><input type="checkbox" id="dj-golive"> Go live (everyone hears your mix)</label></div>
  <div class="dj-rotate">📱↔️ <span>Rotate your phone sideways — you get the full DJ console, all four tables in a row like the desktop.</span></div>
  <div class="dj-setups" style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:12px"><span style="font:700 11px var(--body);color:var(--muted);letter-spacing:.12em;align-self:center">SETUPS:</span><button class="btn ghost sm" type="button" data-preset="loud">🔊 Loud &amp; Clear</button><button class="btn ghost sm" type="button" data-preset="radio">🏆 Pro Radio</button><button class="btn ghost sm" type="button" data-preset="club">🔥 Club</button><button class="btn ghost sm" type="button" data-preset="scratch">🎺 Scratch Session</button><button class="btn ghost sm" type="button" data-preset="chop">⚡ Transformer</button><button class="btn ghost sm" type="button" data-pop>⛶ Pop out — own screen</button></div>
  <div class="dj-screen" id="dj-screen">
    <small>📺 MASTER SCREEN — MUSIC VIDEO · VIEWERS SEE THIS SCREEN LIVE</small>
    <div class="vstage" id="dj-vstage"><div class="vslot" id="dj-vs1"></div><div class="vslot" id="dj-vs2"></div><div class="vstandby" id="dj-vstandby">No music video on a deck right now — put a YouTube video on any deck and it plays here, mixed live.</div><div class="vchip" id="dj-vchip" hidden></div></div>
    <div class="vmixrow"><button class="btn ghost sm" type="button" data-vmix="auto">🔀 Auto · follow fader</button><button class="btn ghost sm" type="button" data-vmix="cut">✂️ Cut</button><button class="btn ghost sm" type="button" data-vmix="fade">🌫️ Fade</button><span style="flex:1"></span><button class="btn ghost sm" type="button" data-vsrc="A">A</button><button class="btn ghost sm" type="button" data-vsrc="B">B</button><button class="btn ghost sm" type="button" data-vsrc="C">C</button><button class="btn ghost sm" type="button" data-vsrc="D">D</button></div>
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
      <div class="xfrow"><div class="xfvols"><div class="xv" data-xv="A" style="--dk:#f0cf78" title="Deck A volume — drag up or down, double-tap for 90%"><i></i><span>VOL A</span><b>90%</b></div><div class="xv" data-xv="B" style="--dk:#38bdf8" title="Deck B volume — drag up or down, double-tap for 90%"><i></i><span>VOL B</span><b>90%</b></div></div><div class="xfpad big" id="dj-xfpad" tabindex="0" title="The X fader runs all four decks — slide toward a corner deck to give it the volume. Double-tap to center."><span class="xfpl tl">A</span><span class="xfpl tr">B</span><span class="xfpl bl">C</span><span class="xfpl br">D</span><div class="xfdot" id="dj-xfdot"></div></div><div class="xfvols"><div class="xv" data-xv="C" style="--dk:#4ade80" title="Deck C volume — drag up or down, double-tap for 90%"><i></i><span>VOL C</span><b>90%</b></div><div class="xv" data-xv="D" style="--dk:#f472b6" title="Deck D volume — drag up or down, double-tap for 90%"><i></i><span>VOL D</span><b>90%</b></div></div></div>
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
      

      <label style="display:flex;gap:6px;align-items:center;font-size:12px;color:var(--muted);text-align:left"><input type="checkbox" id="dj-quant" checked style="width:auto"> Quantize — cues &amp; loops snap to the beat</label>
      <label style="display:flex;gap:6px;align-items:center;font-size:12px;color:var(--muted);text-align:left">Jog feel <select id="dj-jogf" aria-label="Jog wheel feel"><option value="0.05">Light</option><option value="0.09">Standard</option><option value="0.14">Heavy</option></select> — how far a scratch drag moves the song</label>
      <label style="display:flex;gap:6px;align-items:center;font-size:12px;color:var(--muted);text-align:left"><input type="checkbox" id="dj-fxsync" checked style="width:auto"> Effects follow the live tempo</label>
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
    <div style="border:1.5px solid var(--gold-lo);border-radius:14px;padding:14px;margin-bottom:12px;background:rgba(240,207,120,.04)"><span style="display:flex;justify-content:space-between;align-items:center;gap:8px"><b style="font-size:16px;letter-spacing:.06em">🎬 VIDEO SEARCH — MUSIC VIDEOS FROM EVERYWHERE</b><button class="btn ghost sm" type="button" data-fold="yt-body" aria-label="Fold the video panel">▾</button></span><div id="yt-body"><small class="muted" style="display:block;margin:6px 0 10px;font-size:13px">Search YouTube, Dailymotion or the Internet Archive, or paste a link (YouTube, Vimeo and Dailymotion all work) — put the video on a deck and mix it: play, pause, seek and the X fader volume all work, and your listeners see it on the master screen. Video sites keep their audio locked in their own players, so EQ, effects and scratch stay on your own files. Archive videos load as real files — full deck control on those.</small><div style="display:flex;gap:6px;flex-wrap:wrap;align-items:center"><input type="text" id="dj-yt" placeholder="Paste a video link — YouTube, Vimeo, Dailymotion..." style="flex:1;min-width:220px;font-size:16px;padding:12px" aria-label="Video link"><span style="font-size:13px;color:var(--muted)">Load on:</span><button class="btn ghost" type="button" data-ytload="A">A</button><button class="btn ghost" type="button" data-ytload="B">B</button><button class="btn ghost" type="button" data-ytload="C">C</button><button class="btn ghost" type="button" data-ytload="D">D</button></div><div style="display:flex;gap:6px;margin-top:12px;flex-wrap:wrap"><button class="btn sm vtab" type="button" data-vtab="yt">▶ YouTube</button><button class="btn ghost sm vtab" type="button" data-vtab="dm">Dailymotion</button><button class="btn ghost sm vtab" type="button" data-vtab="ia">🎞 Archive videos</button></div><form class="dj-search" id="dj-ytform" style="margin-top:8px;display:flex;gap:8px"><input type="search" id="dj-ytq" placeholder="Search — any artist, any song..." aria-label="Search videos" style="flex:1;font-size:17px;padding:13px"><button class="btn" type="submit" style="font-size:16px;padding:13px 22px">Search</button></form><div class="dj-list" id="dj-ytres" style="max-height:430px;margin-top:10px"></div></div></div>
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
    <div data-browpane="prep" hidden><small class="muted">Your prepare crate and the booth's memory: star songs in Your Library to line them up here; History is what the booth loaded lately — tap a deck letter to load it again.</small><b style="font-size:12px;letter-spacing:.1em;display:block;margin:6px 0 4px">⭐ PREPARE</b><div class="dj-list" id="dj-prep" style="max-height:220px"></div><b style="font-size:12px;letter-spacing:.1em;display:block;margin:10px 0 4px">🕘 HISTORY</b><div class="dj-list" id="dj-hist" style="max-height:220px"></div></div>
    <div data-browpane="free" hidden><small class="muted">Free music and music videos from the Internet Archive — public domain and Creative Commons, legal to play on the station, every file verified. Tap a deck letter to put it straight on that table. They load as real files, so EQ, FX and scratch all work on them.</small><b style="font-size:12px;letter-spacing:.1em;display:block;margin:6px 0 4px">🎵 FREE MUSIC</b><div class="dj-list" id="dj-freem" style="max-height:300px"></div><b style="font-size:12px;letter-spacing:.1em;display:block;margin:10px 0 4px">🎬 FREE VIDEOS</b><div class="dj-list" id="dj-freev" style="max-height:300px"></div></div>
    </div>
  </div>
    <div class="dj-grid2">
    <div class="dj-panel"><h4>🎤 LIVE MIC</h4>
      <div style="display:flex;gap:8px;flex-wrap:wrap"><button class="btn sm" type="button" id="mic-on">Open the mic</button><button class="btn ghost sm" type="button" id="mic-mon">🔇 Monitor off</button></div>
      <div class="micmeter"><i id="mic-lvl"></i></div>
      <label style="display:flex;gap:8px;align-items:center;font-size:14px"><input type="checkbox" id="mic-duck" checked style="width:auto"> Auto-duck the music while I talk (radio style)</label>
      <small class="muted">Your live mic feeds the show recording. To talk TO the listeners, use the big HOLD TO TALK button — it sends your voice out over the mix.</small></div>
    <div class="dj-panel"><h4>🔊 JINGLE / SPOT BOARD</h4>
      <div class="pads" id="dj-pads"></div>
      <small class="muted">Built-in station sounds first, then your own drops — tap an empty pad to record up to 8 seconds. ▶ plays it in the booth, 📡 sends it out over the air.</small></div>
    <div class="dj-panel"><h4>⏺️ RECORD THE SHOW</h4>
      <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap"><button class="btn sm" type="button" id="rec-btn">⏺ Start recording</button><span id="rec-st" class="muted" style="font-size:13px">Captures the full mix + your mic.</span></div>
      <div id="rec-out"></div>
      <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-top:10px;border-top:1px solid var(--line);padding-top:10px"><button class="btn ghost sm" type="button" id="ses-btn">🎬 Record the session (video)</button><span id="ses-st" class="muted" style="font-size:13px">Films this tab — the music videos, the decks, everything — with the full mix sound. Pick this tab and tick “share tab audio”.</span></div>
      <div id="ses-out"></div></div>
    <div class="dj-panel"><h4>🤖 AUTO-DJ</h4>
      <label style="display:flex;gap:8px;align-items:center;font-size:14px"><input type="checkbox" id="ad-on" style="width:auto" checked> Auto-DJ runs the station: when a song ends, crossfade to the next one — your queue first, then the full library on rotation</label>
      <div class="dj-list" id="ad-queue" style="max-height:150px"></div>
      <small class="muted">Add songs with the ＋Q button in Your Library. Works while you're live — the station never goes quiet.</small></div>
    <div class="dj-panel"><h4>🎛️ LIVE DJ REQUESTS</h4><div id="djguest-now"><small class="muted">No guest DJ on the tables right now.</small></div><div class="dj-list" id="djreq-list" style="max-height:180px"></div></div>
    <div class="dj-panel"><h4>📥 REQUESTS &amp; DROPS</h4><div class="dj-list" id="rq-list" style="max-height:220px"><small class="muted">Nothing yet. Listener requests land here.</small></div></div>
    <div class="dj-panel"><h4>🎹 MIDI CONTROLLER</h4>
      <div class="hint" id="dj-midi-stat">Plug any DJ controller into this device by USB, then tap Enable MIDI. Tap LEARN on a row and move the knob, button or jog wheel that should own it — the mapping saves on this device.</div>
      <div class="row wrap"><button class="btn sm" type="button" id="dj-midi-on">🎹 Enable MIDI</button><button class="btn ghost sm" type="button" id="dj-midi-wake">🔆 Keep screen on: off</button><button class="btn ghost sm" type="button" id="dj-midi-clear">Clear mapping</button></div>
      <div class="midilist" id="dj-midi-list"></div>
    </div>
    <div class="dj-panel"><h4>📜 PROGRAM LOG</h4><div class="loglist" id="dj-log"></div>
      <label style="display:grid;gap:4px;font-size:12px;color:var(--muted)">Station ticker (shows on the station card for everyone)<input type="text" id="dj-ticker-in" maxlength="140" placeholder="e.g. Taking requests all night — drop yours below!"></label>
      <button class="btn ghost sm" type="button" id="dj-ticker-set" style="justify-self:start">Set ticker</button></div>
  </div>
</div>`;
  // the booth moves into its own DJ view — its own section, nothing but DJing
  const boothEl = document.getElementById("dj-owner"), boothHome = document.getElementById("dj-booth-root");
  if (boothEl && boothHome) boothHome.appendChild(boothEl);
  // the mini master screen: one floating rectangle on every page, so the live
  // music video follows viewers around the whole site (never in the Playground)
  if (SANDBOX) { const gl = document.querySelector("#dj-golive"); if (gl && gl.closest(".dj-live")) gl.closest(".dj-live").lastChild.textContent = " Practice set (never on air)"; }
  if (!SANDBOX && !document.getElementById("dj-livealert")) { const la = document.createElement("div"); la.id = "dj-livealert"; la.hidden = true; la.innerHTML = "<span class='la-txt'>🔴 LIVE NOW</span><button type='button' class='btn sm' id='la-tune'>🎧 Tune in</button><button type='button' class='btn ghost sm' id='la-shop'>🛍️ Shop</button><button type='button' class='btn ghost sm' id='la-x' aria-label='Dismiss'>✕</button>"; document.body.appendChild(la); const laDismiss = () => { try { sessionStorage.setItem("mw-la-dismiss", la.dataset.set || "x"); } catch (_) {} la.hidden = true; }; la.querySelector("#la-x").addEventListener("click", laDismiss); la.querySelector("#la-shop").addEventListener("click", () => { laDismiss(); if (typeof go === "function") go("shop"); }); la.querySelector("#la-tune").addEventListener("click", () => { try { cutOtherAudio(); } catch (_) {} document.querySelectorAll("video").forEach((v) => { try { v.pause(); } catch (_) {} }); startListening(); la.hidden = true; if (typeof go === "function") go("radio"); }); setInterval(() => { try { paintLiveAlert(); } catch (_) {} }, 20000); }
  if (!SANDBOX && !document.getElementById("dj-mini")) { const mn = document.createElement("div"); mn.id = "dj-mini"; mn.hidden = true; mn.innerHTML = "<div class='mn-bar'><span>📺 MASTER — LIVE VIDEO</span><button type='button' id='mn-close' aria-label='Hide the mini screen'>✕</button></div><div class='vstage'><div class='vslot' id='mn-vs1'></div><div class='vslot' id='mn-vs2'></div><div class='vchip' id='mn-vchip' hidden></div></div><div class='mn-grip' id='mn-grip' title='Drag to resize the screen'></div>"; document.body.appendChild(mn); mn.querySelector("#mn-close").addEventListener("click", () => { const t = vmixTargets()[0]; miniOffVid = t ? (S[t.k] && S[t.k].yt) || "*" : "*"; mn.hidden = true; });
    // the mini screen is DRAGGABLE by its title bar (owner directive 2026-10-26:
    // "make the music video screen moveable") — drag it anywhere; the spot is
    // remembered per device and restored on every page
    const mnBar = mn.querySelector(".mn-bar");
    const mnPlace = (x, y) => { const w = mn.offsetWidth || 208, h = mn.offsetHeight || 140; x = Math.max(2, Math.min(Math.round(x), Math.max(2, innerWidth - w - 2))); y = Math.max(2, Math.min(Math.round(y), Math.max(2, innerHeight - h - 2))); mn.style.left = x + "px"; mn.style.top = y + "px"; mn.style.right = "auto"; };
    try { const p = JSON.parse(localStorage.getItem("mw-mini-pos") || "null"); if (p && typeof p.x === "number" && typeof p.y === "number") mnPlace(p.x, p.y); } catch (_) {}
    // and RESIZEABLE by its corner grip (owner, 2026-10-27): drag the corner
    // to make the little screen bigger or smaller; the size is remembered
    // per device, and the stage keeps its 16:9 shape on its own
    const mnGrip = mn.querySelector(".mn-grip");
    const mnSize = (w) => { w = Math.max(140, Math.min(Math.round(w), Math.min(640, innerWidth - 8))); mn.style.width = w + "px"; return w; };
    try { const w = +localStorage.getItem("mw-mini-w"); if (w) mnSize(w); } catch (_) {}
    if (mnGrip) mnGrip.addEventListener("pointerdown", (e) => { e.preventDefault(); e.stopPropagation(); const sx = e.clientX, sw = mn.getBoundingClientRect().width; try { mnGrip.setPointerCapture(e.pointerId); } catch (_) {} const mv = (ev) => mnSize(sw + (ev.clientX - sx)); const up = () => { mnGrip.removeEventListener("pointermove", mv); mnGrip.removeEventListener("pointerup", up); mnGrip.removeEventListener("pointercancel", up); const r2 = mn.getBoundingClientRect(); mnPlace(r2.left, r2.top); try { localStorage.setItem("mw-mini-w", String(Math.round(mn.getBoundingClientRect().width))); } catch (_) {} }; mnGrip.addEventListener("pointermove", mv); mnGrip.addEventListener("pointerup", up); mnGrip.addEventListener("pointercancel", up); });
    mnBar.addEventListener("pointerdown", (e) => { if (e.target.closest("#mn-close")) return; e.preventDefault(); const r = mn.getBoundingClientRect(), dx = e.clientX - r.left, dy = e.clientY - r.top; try { mnBar.setPointerCapture(e.pointerId); } catch (_) {} mn.classList.add("mn-drag"); const mv = (ev) => mnPlace(ev.clientX - dx, ev.clientY - dy); const up = () => { mnBar.removeEventListener("pointermove", mv); mnBar.removeEventListener("pointerup", up); mnBar.removeEventListener("pointercancel", up); mn.classList.remove("mn-drag"); try { const r2 = mn.getBoundingClientRect(); localStorage.setItem("mw-mini-pos", JSON.stringify({ x: Math.round(r2.left), y: Math.round(r2.top) })); } catch (_) {} }; mnBar.addEventListener("pointermove", mv); mnBar.addEventListener("pointerup", up); mnBar.addEventListener("pointercancel", up); }); }
  // Malik's rule: the pick-a-song browser sits at the TOP of the booth, above the
  // decks — on wide screens the console grid still parks it at the top of the
  // middle column; everywhere else it now leads the booth instead of hiding
  // below all four decks
  const brEl = document.getElementById("dj-browser"), dkEl = boothEl && boothEl.querySelector(".dj-decks");
  if (brEl && dkEl) dkEl.before(brEl);
  // the X fader rides right under the music browser / YouTube search (owner,
  // 2026-10-26: "put the cross fader at the top under the youtube search")
  const xfEl = document.getElementById("dj-xfbar"); if (xfEl && brEl) brEl.after(xfEl);
  // MASTER FX strip (owner ask, 2026-10-26): the FX slider stack leaves the
  // center mixer — it ran long with empty space beside it — and becomes a
  // full-width panel under the console, sliders lined up in even cells. Same
  // elements, same ids: every painter, the edit panel and MIDI keep working.
  { const m1El = document.querySelector("#dj-owner .mixer.m1"), g2El = document.querySelector("#dj-owner .dj-grid2"), mstEl = document.getElementById("dj-master"); if (m1El && g2El && mstEl) { const panel = document.createElement("div"); panel.className = "dj-panel"; panel.id = "dj-fxpanel"; panel.innerHTML = "<h4>🎛️ MASTER FX</h4><div class='fxgrid'></div>"; g2El.insertBefore(panel, g2El.firstChild); const fxg = panel.querySelector(".fxgrid"); const chain = []; let n = mstEl.previousElementSibling; while (n) { chain.push(n); n = n.nextElementSibling; } let cell = null; chain.forEach((el) => { if (el.tagName === "SMALL" || !cell) { cell = document.createElement("div"); cell.className = "fxcell"; fxg.appendChild(cell); } cell.appendChild(el); if (el.querySelector && el.querySelector(".edivb, .gatebtn")) cell.classList.add("wide"); }); } }
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
  const ckPaint = () => { ckBlocks.forEach(({ el, key }) => el.classList.toggle("ck-off", ckHidden.includes(key))); ckBar.innerHTML = "<b style='font-size:13px'>🛠 Customize — tap ✕ Hide on any block you don't use. Hidden:</b> " + (ckHidden.length ? ckBlocks.filter((b) => ckHidden.includes(b.key)).map((b) => `<button class='btn ghost sm' type='button' data-ckshow='${b.key}'>👁 ${b.label}</button>`).join(" ") : "<span class='muted' style='font-size:13px'>nothing hidden</span>") + " <button class='btn ghost sm' type='button' data-ckreset='1'>↺ Reset layout</button>"; };
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
  const $ = (s) => document.querySelector(s);
  const decks = { A: null, B: null, C: null, D: null };
  const DECKS = ["A", "B", "C", "D"]; const PAIR = { A: "B", B: "A", C: "D", D: "C" };
  const deck = (k) => { if (!decks[k]) { decks[k] = Deck(); decks[k].letter = k; } return decks[k]; };
  const fmt = (s) => { s = Math.max(0, Math.floor(s || 0)); return Math.floor(s / 60) + ":" + String(s % 60).padStart(2, "0"); };
  const agoT = (at) => new Date(at).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: "America/New_York" });

  /* ---------- levels, following the shared state, listener side ---------- */
  let listening = false, voiceEl = null, heardVoice = "", micHot = 0, mixVol = 1;
  /* keep the screen awake while a listener is tuned in (owner, 2026-10-27):
     a sleeping screen is what freezes video decks — the phone itself pauses
     the page, and no website can override a real lock or a closed app. But
     while the station is playing the lock never has to happen: hold a screen
     wake lock for the listener, re-grab it whenever they come back to the
     tab, and let it go when they stop. His own audio decks also keep playing
     through a lock with the lock-screen controls (Media Session, below). */
  let listenWake = null;
  const wakeForListening = async (on) => {
    try {
      if (on) { if (!listenWake && navigator.wakeLock && !document.hidden) { listenWake = await navigator.wakeLock.request("screen"); listenWake.addEventListener("release", () => { listenWake = null; }); } }
      else if (listenWake) { const w = listenWake; listenWake = null; w.release(); }
    } catch (_) {}
  };
  document.addEventListener("visibilitychange", () => { if (!document.hidden && listening) wakeForListening(true); });
  function levels() {
    const duck = (S.duck || (voiceEl && !voiceEl.paused) || micHot > 0.04) ? 0.28 : 1;
    const mix = listening && !OWNER() ? mixVol : 1;
    DECKS.forEach((k) => { if (decks[k]) { const cd = k === "C" || k === "D", x = cd ? (S.xf2 ?? 0.5) : S.xf, side = k === "B" || k === "D" ? "B" : "A", py = S.panY || 0, pairG = cd ? (py < 0 ? 1 + py : 1) : (py > 0 ? 1 - py : 1); decks[k].vol((S[k].vol ?? 0.9) * xfGain(x, side) * pairG * duck * mix); } });
    stageApply(mix, duck);
  }
  /* ---------- the MASTER music-video screen ----------
   * Two player slots dissolve into each other exactly like the audio
   * crossfade: in AUTO the visuals ride the same gains the X fader gives the
   * sound, so fading the sound fades the picture. The booth's screen sits in
   * the master section (muted there — the decks make the sound); viewers get
   * the SAME screen on the station card, with the sound, mixed by the same
   * numbers. The booth can also mix the picture by hand: S.vmix holds
   * {mode:"man", a, b, t} and every screen follows it. */
  const stageGain = (k) => { const s = S[k], cd = k === "C" || k === "D", x = cd ? (S.xf2 ?? 0.5) : S.xf, side = k === "B" || k === "D" ? "B" : "A", py = S.panY || 0, pairG = cd ? (py < 0 ? 1 + py : 1) : (py > 0 ? 1 - py : 1); return (s.vol ?? 0.9) * xfGain(x, side) * pairG; };
  const mkScreen = (ids, standby, chip) => ({ ids, standby, chip, slots: [{ deck: "", vid: "", p: null }, { deck: "", vid: "", p: null }] });
  const scrBooth = mkScreen(["#dj-vs1", "#dj-vs2"], "#dj-vstandby", "#dj-vchip");
  const scrView = mkScreen(["#st-vs1", "#st-vs2"], "#st-vstandby", "#st-vchip");
  const scrMini = mkScreen(["#mn-vs1", "#mn-vs2"], null, "#mn-vchip");
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
  /* one screen player for any video platform: the wrapper speaks the YT-ish
   * surface renderScreen already uses, whatever player is underneath */
  function mkVidPlayer(mountEl, tok, muted, deckK) {
    const vp = vparseTok(tok);
    const w = { _raw: null, _st: -1, _cur: 0,
      playVideo() { try { if (!w._raw) return; if (vp.p === "yt") w._raw.playVideo(); else if (vp.p === "dm") w._raw.play(); else { const r = w._raw.play(); if (r && r.catch) r.catch(() => {}); } } catch (_) {} },
      pauseVideo() { try { if (!w._raw) return; if (vp.p === "yt") w._raw.pauseVideo(); else if (vp.p === "dm") w._raw.pause(); else w._raw.pause(); } catch (_) {} },
      seekTo(t) { try { if (!w._raw) return; if (vp.p === "yt") w._raw.seekTo(t, true); else if (vp.p === "dm") w._raw.seek(t); else { const r = w._raw.setCurrentTime(t); if (r && r.catch) r.catch(() => {}); } w._cur = t; } catch (_) {} },
      getCurrentTime() { try { if (vp.p === "yt" && w._raw) return w._raw.getCurrentTime() || 0; } catch (_) {} return w._cur || 0; },
      getPlayerState() { try { if (vp.p === "yt" && w._raw) return w._raw.getPlayerState(); } catch (_) {} return w._st; },
      setVolume(v) { try { if (!w._raw) return; if (vp.p === "yt") w._raw.setVolume(v); else w._raw.setVolume(Math.max(0, Math.min(1, v / 100))); } catch (_) {} },
      mute() { try { if (!w._raw) return; if (vp.p === "yt") w._raw.mute(); else w._raw.setVolume(0); } catch (_) {} },
      unMute() { try { if (vp.p === "yt" && w._raw) w._raw.unMute(); } catch (_) {} },
      loadVideoById(tok2, t) { const v2 = vparseTok(tok2); try { if (!w._raw) return; if (vp.p === "yt") w._raw.loadVideoById(v2.id, t); else if (vp.p === "dm") { if (w._raw.load) w._raw.load(v2.id); if (t) setTimeout(() => w.seekTo(t), 900); } else { const r = w._raw.loadVideo(v2.id); if (r && r.then) r.then(() => { if (t) w.seekTo(t); w.playVideo(); }); } } catch (_) {} },
      destroy() { try { if (w._raw && vp.p !== "dm") w._raw.destroy(); } catch (_) {} w._raw = null; } };
    const ready = () => { try { if (muted) w.mute(); w.seekTo(Math.max(0, posOf(deckK))); w.playVideo(); } catch (_) {} };
    try {
      if (vp.p === "yt") {
        w._raw = new YT.Player(mountEl, { videoId: vp.id, width: "100%", height: "100%", playerVars: { playsinline: 1, rel: 0, controls: 0 }, events: { onReady: () => ready(), onStateChange: (e) => { w._st = e.data; } } });
      } else if (vp.p === "dm") {
        const p = DM.player(mountEl, { video: vp.id, width: "100%", height: "100%", params: { autoplay: false, controls: false, "endscreen-enable": false } });
        w._raw = p;
        const on = (ev, fn) => { try { p.addEventListener(ev, fn); } catch (_) {} };
        on("apiready", () => ready());
        on("timeupdate", (e) => { try { if (e && typeof e.time === "number") w._cur = e.time; } catch (_) {} });
        on("play", () => { w._st = 1; }); on("pause", () => { if (w._st !== 0) w._st = 2; }); on("ended", () => { w._st = 0; });
      } else {
        const p = new Vimeo.Player(mountEl, { id: vp.id, width: "100%", height: "100%", controls: false, title: false, byline: false, portrait: false });
        w._raw = p;
        p.ready().then(() => ready()).catch(() => {});
        p.on("timeupdate", (e) => { try { if (e && typeof e.seconds === "number") w._cur = e.seconds; } catch (_) {} });
        p.on("play", () => { w._st = 1; }); p.on("pause", () => { if (w._st !== 0) w._st = 2; }); p.on("ended", () => { w._st = 0; });
      }
    } catch (_) {}
    return w;
  }

  async function renderScreen(scr, muted, mix, duck) {
    const tg = vmixTargets();
    // a true dissolve, full brightness at every point of the fade: the weaker
    // picture sits underneath at full strength and the stronger one fades in
    // over it by its share — slide the fader to a deck's 100% and the screen
    // is 100% that deck; park it in the middle and the two videos blend
    const srt = tg.slice().sort((a, b) => a.op - b.op), disp = {};
    if (srt.length === 2) { disp[srt[0].k] = 1; disp[srt[1].k] = srt[1].op; } else if (srt.length === 1) disp[srt[0].k] = 1;
    scr.slots.forEach((sl, i) => { if (sl.deck && !tg.some((x) => x.k === sl.deck)) { sl.deck = ""; const el = $(scr.ids[i]); if (el) el.style.opacity = 0; if (sl.p) { try { sl.p.pauseVideo(); } catch (_) {} } } });
    const stb = scr.standby ? $(scr.standby) : null; if (stb) stb.style.display = tg.length ? "none" : "grid";
    const chip = $(scr.chip);
    if (!tg.length) { if (chip) chip.hidden = true; return; }
    const provs = new Set(tg.map((t) => vparseTok(S[t.k].yt).p));
    if (provs.has("yt")) await ytApi();
    if (provs.has("dm")) await dmApi();
    if (provs.has("vm")) await vmApi();
    for (const t of tg) {
      let i = scr.slots.findIndex((sl) => sl.deck === t.k);
      if (i < 0) {
        i = scr.slots.findIndex((sl) => !sl.deck); if (i < 0) continue;
        const sl = scr.slots[i], mount = $(scr.ids[i]); if (!mount) continue;
        sl.deck = t.k; sl.vid = S[t.k].yt; sl.p = null; mount.innerHTML = "<div></div>";
        mount.style.opacity = (disp[t.k] != null ? disp[t.k] : t.op).toFixed(2); mount.style.zIndex = srt.length === 2 && srt[0].k === t.k ? 1 : 2;
        const prov = vparseTok(sl.vid).p;
        if ((prov === "yt" && (!window.YT || !YT.Player)) || (prov === "dm" && (!window.DM || !DM.player)) || (prov === "vm" && (!window.Vimeo || !Vimeo.Player))) { sl.deck = ""; continue; }
        sl.p = mkVidPlayer(mount.firstChild, sl.vid, muted, t.k);
        continue;
      }
      const sl = scr.slots[i];
      if (sl.vid !== S[t.k].yt) { sl.vid = S[t.k].yt; if (sl.p) { try { sl.p.loadVideoById(sl.vid, Math.max(0, posOf(t.k))); } catch (_) {} } }
      const el = $(scr.ids[i]); if (el) { el.style.opacity = (disp[t.k] != null ? disp[t.k] : t.op).toFixed(2); el.style.zIndex = srt.length === 2 && srt[0].k === t.k ? 1 : 2; }
      if (sl.p) { try {
        const want = posOf(t.k), cur = sl.p.getCurrentTime ? sl.p.getCurrentTime() : 0;
        if (Math.abs(cur - want) > 3) sl.p.seekTo(want, true);
        const stt = sl.p.getPlayerState ? sl.p.getPlayerState() : -1;
        if (stt !== 1 && S[t.k].playing) sl.p.playVideo();
        if (stt === 1 && !S[t.k].playing) sl.p.pauseVideo();
        if (!muted) { if (sl.p.unMute) sl.p.unMute(); sl.p.setVolume(Math.round(Math.max(0, Math.min(1, stageGain(t.k) * (duck || 1) * (mix || 1) * boostMk())) * 100)); }
        else if (sl.p.mute) sl.p.mute();
      } catch (_) {} }
    }
    const top = tg.slice().sort((a, b) => b.op - a.op)[0];
    if (chip && top) { chip.hidden = false; chip.textContent = "\u25B6 DECK " + top.k + (S[top.k].title ? " \u2014 " + S[top.k].title : ""); }
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
      if (OWNER()) { await renderScreen(scrBooth, true, 1, 1); const box = $("#st-ytbox"); if (box) box.hidden = true; }
      else {
        const has = vmixTargets().length > 0, box = $("#st-ytbox"); if (box) box.hidden = !(has || S.live);
        if (has) await renderScreen(scrView, !listening, listening ? mix : 1, duck);
        else if (S.live) { const sb = $("#st-vstandby"); if (sb) sb.textContent = stSlate(); await renderScreen(scrView, true, 1, 1); }
        else scrView.slots.forEach((sl) => { sl.deck = ""; if (sl.p) { try { sl.p.pauseVideo(); } catch (_) {} } });
      }
      await miniApply(mix, duck);
    } catch (_) {}
    stageBusy = false;
  }
  /* the mini screen is a silent mirror (the sound already travels with the decks
   * and the station screen): it shows the same mix in a small rectangle at the
   * top of every page, and steps aside when a big screen is in view, when the
   * booth itself is on screen, or when the viewer closed it for this video */
  let miniOffVid = "", stInView = false;
  async function miniApply(mix, duck) {
    const box = $("#dj-mini"); if (!box || SANDBOX) return;
    const tg = vmixTargets(), top = tg.slice().sort((a, b) => b.op - a.op)[0], vid = top ? (S[top.k] && S[top.k].yt) || "" : "";
    const show = !!tg.length && vid !== miniOffVid && !stInView && !document.body.classList.contains("dj-on");
    box.hidden = !show;
    if (!tg.length) scrMini.slots.forEach((sl) => { sl.deck = ""; if (sl.p) { try { sl.p.pauseVideo(); } catch (_) {} } });
    if (!show) return;
    // keep the mini clear of the bottom player bar: if a saved spot leaves it
    // under the bar, lift it above the bar while the bar is up (the saved spot
    // itself is untouched — the lift is re-applied on the next pass)
    try { const pb = document.querySelector(".player-bar"); if (pb && document.body.classList.contains("has-player")) { const pr = pb.getBoundingClientRect(), mr = box.getBoundingClientRect(); if (pr.height > 0 && mr.bottom > pr.top - 4 && mr.left < pr.right && mr.right > pr.left) { box.style.top = Math.max(2, Math.round(pr.top - mr.height - 8)) + "px"; box.style.left = Math.round(mr.left) + "px"; box.style.right = "auto"; } } } catch (_) {}
    await renderScreen(scrMini, true, 1, 1);
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
  async function follow(k) {
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
      await d.set(s.src);
    }
    d.el.playbackRate = s.rate || 1;
    const want = posOf(k);
    // a deck whose shared timeline already ran past the end of its track is
    // OVER, whatever the doc still claims: park it locally instead of seeking
    // past the end on every sync tick (the seek loop sounds like skipping)
    if (s.playing && +s.dur > 0 && want > +s.dur + 2) { try { d.el.pause(); } catch (_) {} levels(); return; }
    if (s.playing) {
      if (d.el.duration && want >= d.el.duration - 0.3) { d.el.pause(); levels(); return; }
      if (!d.el.seeking && d.el.readyState >= 3 && Math.abs(d.el.currentTime - want) > 4) { try { d.el.currentTime = want; } catch (_) {} }
      if (d.el.paused) d.el.play().catch(() => {});
    }
    else { d.el.pause(); if (Math.abs(d.el.currentTime - want) > 0.5) { try { d.el.currentTime = want; } catch (_) {} } }
    applyFx(); levels();
    if (OWNER() && !(S[k].bpm > 0) && !s.yt) analyze(k);
  }
  // tight sync across devices (owner ask, 2026-10-26): every playing deck is
  // held to the shared timeline — posOf() corrected by the server-clock offset.
  // Small drift glides back with a brief rate nudge (no audible jump); big
  // drift seeks clean. Loops, paused elements (a scratch in progress), and
  // brake/spin moves (noSync stamp) are left alone. Video decks can only be
  // re-seeked, and coarsely (their player lands on keyframes).
  function syncDecks() { if (document.hidden) return; const now = Date.now() + clockOff; DECKS.forEach((k) => { const s = S[k], d = decks[k]; if (!s || !s.playing || !d || !d.el || s.loop) return; if (d.noSync && Date.now() < d.noSync) return; const target = Math.max(0, (now - (s.start || now)) / 1000); const durT = +s.dur || 0; if (durT > 0 && target > durT + 2) { try { d.el.pause(); } catch (_) {} return; } if (d.shim) { if (Math.abs((d.el.currentTime || 0) - target) > 2) follow(k); return; } if (d.el.paused) return; const drift = d.el.currentTime - target, base = s.rate || 1; if (Math.abs(drift) > 0.35) { try { d.el.currentTime = Math.max(0, target); } catch (_) {} if (Math.abs(d.el.playbackRate - base) > 0.001) d.el.playbackRate = base; } else if (Math.abs(drift) > 0.08) { const want = base * (drift > 0 ? 0.96 : 1.04); if (Math.abs(d.el.playbackRate - want) > 0.001) d.el.playbackRate = want; } else if (Math.abs(d.el.playbackRate - base) > 0.001) d.el.playbackRate = base; }); }
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
      if (b.t === "cc" && isCc) { if (key === "xf") { S.xf = v / 127; paintXfPads(); levels(); save(); continue; } if (f[3]) { midiSetSlider(f[3], v / 127); midiDirty(); } continue; }
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
  document.querySelectorAll("[data-xv]").forEach((el) => { const k = el.dataset.xv; let drag = null; el.addEventListener("pointerdown", (e) => { if (!OWNER()) return; drag = { y: e.clientY, v: S[k] ? S[k].vol : 0 }; try { el.setPointerCapture(e.pointerId); } catch (_) {} e.preventDefault(); }); el.addEventListener("pointermove", (e) => { if (!drag) return; const v = Math.max(0, Math.min(2, drag.v + (drag.y - e.clientY) / 140)); midiSetSlider("[data-vol=\"" + k + "\"]", v / 2); paintXfPads(); }); const end = () => { drag = null; }; el.addEventListener("pointerup", end); el.addEventListener("pointercancel", end); el.addEventListener("dblclick", () => { if (!OWNER()) return; midiSetSlider("[data-vol=\"" + k + "\"]", 0.45); paintXfPads(); }); });

  function playVoice() {
    const v = S.voice; if (!v || !okUrl(v.url) || DEAD(v.url) || heardVoice === v.id || Date.now() - (v.at || 0) > 90000) return;
    heardVoice = v.id; if (!listening) return;
    voiceEl = new Audio(v.url); voiceEl.playsInline = true; levels();
    voiceEl.addEventListener("ended", levels); voiceEl.addEventListener("error", levels); voiceEl.play().catch(levels);
  }
  /* ---------- one set, every device (owner, 2026-10-27) ----------
   * Pad taps are events, not state: a tap on any of his devices stamps
   * S.padHit, and the window playing the sound fires it through the
   * broadcast — so the phone works the sound pad while the computer runs
   * the tables, and listeners tuned in hear the hit too. */
  let heardPad = "";
  function stampPad(hit) { if (SANDBOX || !OWNER()) return; S.padHit = Object.assign({}, hit, { at: Date.now(), by: tabId }); heardPad = S.padHit.at + ":" + S.padHit.by; save(true); }
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
    document.querySelectorAll("[data-vmix]").forEach((x) => x.classList.toggle("on", x.dataset.vmix === "auto" && (!S.vmix || S.vmix.mode === "auto")));
    document.querySelectorAll("[data-vsrc]").forEach((x) => x.classList.toggle("on", !!S.vmix && S.vmix.mode === "man" && S.vmix.a === x.dataset.vsrc && !S.vmix.b));
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
    const lamp = $("#dj-lamp"); lamp.classList.toggle("on", !!S.live); lamp.lastChild.textContent = SANDBOX ? (guestLiveOn() ? "ON AIR" : S.live ? "PRACTICE" : "STANDBY") : (S.live ? "ON AIR" : "OFF AIR");
    renderLog($("#dj-log")); paintPads();
  }
  function renderLog(box) {
    if (!box) return;
    box.innerHTML = (S.log || []).length ? S.log.map((x) => `<div><span>${E(x.t)}${x.live ? ' <small style="color:#ff8b8f">● LIVE</small>' : ""}</span><time>${agoT(x.at)}</time></div>`).join("") : '<small class="muted">Nothing played yet this session.</small>';
  }
  function paintStation() {
    const live = isLive();
    const lamp = $("#st-lamp"); lamp.classList.toggle("on", live); lamp.lastChild.textContent = SANDBOX ? (guestLiveOn() ? "ON AIR" : live ? "PRACTICE" : "STANDBY") : (live ? "ON AIR" : "OFF AIR");
    const tk = $("#st-ticker"); tk.hidden = !S.ticker; if (S.ticker) $("#st-ticker-t").textContent = S.ticker;
    const now = live ? DECKS.filter((k) => S[k].playing && !(S[k].dur && S[k].start && Date.now() - S[k].start > (S[k].dur + 45) * 1000)).map((k) => S[k].title).filter(Boolean) : [];
    const boothLive = S.boothAt && Date.now() - S.boothAt < 45000;
    const gN = S.djGuest && S.djGuest.until > Date.now() ? gName(S.djGuest) : null;
    $("#st-now").textContent = live ? (now.length ? (boothLive ? "🎧 Live now: " : S.autodj ? "🤖 Auto-DJ live: " : "🎧 Live now: ") + now.join("  ×  ") : gN ? "🎧 " + gN + " is live on the decks." : "🎧 Meechie is live on the decks.") : "The station is on the playlist right now. When Meechie goes live on the decks, it shows up here.";
    $("#st-show").innerHTML = S.show && okUrl(S.show.url) && !DEAD(S.show.url) ? "<b style=\"font-size:13px;letter-spacing:.1em\">" + (S.show.video ? "🎬 LATEST SESSION VIDEO" : "🎙️ LATEST RECORDED SHOW") + "</b>" + (S.show.video ? "<video controls preload=\"none\" src=\"" + E(S.show.url) + "\" style=\"width:100%;margin-top:6px;border-radius:10px;background:#000\"></video>" : "<audio controls preload=\"none\" src=\"" + E(S.show.url) + "\" style=\"width:100%;margin-top:6px\"></audio>") + "<small class=\"muted\">Recorded " + new Date(S.show.at).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: "America/New_York" }) + "</small>" : "";
    renderLog($("#st-log"));
  }
  setInterval(() => {
    const oe = document.getElementById("dj-owner"); if (oe && oe.hidden && OWNER()) showOwnerUI();
    if (ctx && ctx.state !== "running" && ctx.state !== "closed" && DECKS.some((k) => S[k] && S[k].playing) && (boothLead || listening)) { wakeAudio(); if (Date.now() - muteHintAt > 20000) { muteHintAt = Date.now(); setTimeout(() => { if (ctx && ctx.state !== "running") say("🔇 Your phone paused the sound. Tap anywhere on the page to bring it back."); }, 600); } }
    if (pkTab === "mine" && !(pkItems && pkItems.length) && TRACKS().length) paintPkList();
    DECKS.forEach((k) => {
      const el = $("#tm-" + k); if (el && decks[k]) { const dd = decks[k], mirror = !boothLead && S[k].playing, cur = mirror ? posOf(k) : dd.el.currentTime, dur = dd.el.duration || S[k].dur || 0; el.textContent = fmt(cur) + (dur ? " / " + fmt(dur) + " · −" + fmt(Math.max(0, dur - cur)) : ""); const dkEl = document.querySelector('.deck[data-deck="' + k + '"]'); if (dkEl) dkEl.classList.toggle("playing", !!S[k].playing); }
      // watchdog: an element that reached the end without firing 'ended' still hands over
      if (OWNER() && boothLead && S.live && S.autodj && S[k].playing && decks[k] && decks[k].el.ended) deckEnded(k);
      // seamless handover (owner, 2026-10-26): the only deck on air is about to
      // run out — start its pair partner NOW and crossfade into it, no hole
      if (OWNER() && boothLead && S.live && S.autodj && !listening && S[k].playing && decks[k] && !decks[k].loop && !handoverBusy && DECKS.every((x) => x === k || !S[x].playing)) { const el2 = decks[k].el, rem = el2.duration && isFinite(el2.duration) ? el2.duration - el2.currentTime : 99; if (rem > 0.3 && rem <= 3.5) autoNext(k, true, Math.max(1200, rem * 1000)); }
      const d = decks[k]; if (d && d.loop && !d.el.paused && d.el.currentTime >= d.loop[1]) { try { d.el.currentTime = d.loop[0]; } catch (_) {} if (OWNER() && S[k].playing) { S[k].start = Date.now() - d.loop[0] * 1000; } }
      if (OWNER() && decks[k] && S[k].playing) peaks(k);
    });
    document.querySelectorAll("[data-swap]").forEach((b) => { const v = b.dataset.swap.split(":")[1]; b.classList.toggle("hot", !!S[v] && !!S[v].playing); });
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
  function paintOnline(o, l, users) {
    // ONE presence list for the whole site: when the keeper answers with the
    // signed-in members who are on right now, that list is the count everywhere
    // (header chip, booth, station card AND the Book strip via MW_ONLINE), so
    // the numbers can never disagree again
    let n = o;
    if (Array.isArray(users)) {
      n = users.length;
      window.MW_ONLINE = new Set(users.map((x) => x.uid).filter(Boolean));
      window.MW_ONLINE_USERS = users; window.MW_PING_AT = Date.now();
      window.MW_GUESTS = Math.max(0, (o || 0) - n);
    }
    const chip = document.getElementById("online-chip");
    if (chip) { chip.hidden = false; const nb = document.getElementById("online-n"); if (nb) nb.textContent = n; if (!chip._clk) { chip._clk = 1; chip.style.cursor = "pointer"; chip.title = "See who's online"; chip.addEventListener("click", () => { if (window.MW_showOnline) window.MW_showOnline(); }); } }
    const b = document.getElementById("dj-online"); if (b) b.textContent = "👥 " + n + " online · 🎧 " + l + " on the decks";
    const o2 = document.getElementById("dj-online2"); if (o2) o2.textContent = "🟢 " + n + " online · 🎧 " + l;
    const s = document.getElementById("st-online"); if (s) s.textContent = l > 0 ? "🎧 " + l + " listening on the decks right now · " + n + " on the site" : n + " on the site right now";
  }
  const pingKeeper = () => { let extra = ""; try { const su = window.MW && MW.session && MW.session() && MW.session().user; if (su && su.id) { const nm = (typeof members !== "undefined" && members && members[su.id] && members[su.id].handle) || su.name || ""; extra = "&u=" + encodeURIComponent(su.id) + (nm ? "&n=" + encodeURIComponent(String(nm).slice(0, 40)) : ""); } } catch (_) {}
    fetch("/api/station?cid=" + encodeURIComponent(myCid) + "&l=" + (listening && !OWNER() ? 1 : 0) + extra, { cache: "no-store" }).then((r) => r.json()).then((j) => { if (j && j.now) clockOff = clockOff * 0.7 + (j.now - Date.now()) * 0.3; if (j && j.online != null) paintOnline(j.online, j.listening || 0, j.users); }).catch(() => {}); };
  let clockOff = 0; // this device's clock error vs the server, learned from keeper pings — the sync math below trusts it over the local clock
  if (!SANDBOX) { pingKeeper(); setInterval(pingKeeper, 12000); }
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
      badge.textContent = boothLead ? "🔊 This window is playing the sound" : "🪞 Mirror: the sound is on your other window or device. Tap here to play it here";
      badge.style.cursor = boothLead ? "" : "pointer"; badge.setAttribute("role", "button");
      if (!badge._take) { badge._take = 1; badge.addEventListener("click", () => { if (boothLead || !OWNER()) return; driveWant = Date.now(); try { localStorage.setItem(leaseKey, JSON.stringify({ id: tabId, at: Date.now() })); } catch (_) {} leaseBeat(); actx(); say("🔊 The sound is in this window now."); }); }
    }
    if (boothLead && !was && OWNER()) DECKS.forEach((k) => { if (S[k] && S[k].playing) follow(k); });
    if (boothLead && !was && OWNER()) setTimeout(() => save(true), 400);
    if (!boothLead && was) DECKS.forEach((k) => { try { decks[k]?.stop(); } catch (_) {} });
  }
  leaseBeat(); setInterval(leaseBeat, 3000);
  document.addEventListener("visibilitychange", () => { if (!document.hidden) { leaseBeat(); if (boothLead && OWNER()) DECKS.forEach((k) => { if (S[k] && S[k].src) follow(k); }); } });
  addEventListener("pagehide", () => { if (boothLead) { try { const L = JSON.parse(localStorage.getItem(leaseKey) || "null"); if (L && L.id === tabId) localStorage.removeItem(leaseKey); } catch (_) {} } });
  setInterval(() => { if (!OWNER() && S.live) { const l = isLive(); $("#dj-banner").hidden = !l; if (!l && listening) endSet(); } paintStation(); }, 30000);
  function startListening() {
    listening = true; actx(); wakeForListening(true);
    try { if (typeof media !== "undefined") media.pause(); if (typeof mode !== "undefined") mode = "dj"; } catch (_) {}
    $("#dj-listen").textContent = "⏹ Stop listening"; DECKS.forEach((k) => follow(k));
    try { if (typeof showBar === "function") showBar({ title: "LIVE DJ SET", artist: "Meechie", cover: "" }, "Live on the decks"); } catch (_) {}
    try { if ("mediaSession" in navigator) { navigator.mediaSession.playbackState = "playing"; navigator.mediaSession.metadata = new MediaMetadata({ title: "LIVE DJ SET", artist: "Meechie", album: "Meechie's World Radio", artwork: [{ src: location.origin + "/img/icon-512.png", sizes: "512x512", type: "image/png" }] }); } } catch (_) {}
  }
  function stopListening() { listening = false; wakeForListening(false); DECKS.forEach((k) => decks[k]?.stop()); voiceEl?.pause(); $("#dj-listen").textContent = "🎧 Listen live"; try { navigator.mediaSession.playbackState = "paused"; } catch (_) {} }
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
    if (uid && !approved && !OWNER() && Date.now() - djLivePendAt > 10000) { djLivePendAt = Date.now(); try { const d = DBF(); const snap = d ? await d.doc("requests/djlive-" + uid).get() : null; djLivePend = !!(snap && snap.exists); } catch (_) {} }
    const sig = [OWNER() ? "owner" : "", uid || "", approved ? g.until : 0, liveOn, djLivePend].join("|");
    if (sig === djLiveSig) return; djLiveSig = sig;
    if (OWNER()) { body.innerHTML = '<p class="muted">This is your station. When a member asks to DJ live, the request lands in your booth under 🎛️ LIVE DJ REQUESTS — approve it there and their table drives the radio until their slot ends, you end it, or you open your own booth.</p>'; return; }
    if (!uid) { body.innerHTML = '<p class="muted">Your table is the DJ Playground above — yours to play on any time, and the real radio can\'t hear it. Want the real radio? <b>Sign in</b>, then ask Meechie for a live slot right here.</p>'; return; }
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
  /* gentle mouse-wheel on the Radio + DJ Station pages (desktop): the booth is a
   * long page and stock wheel notches jump it too far. Ease to 20% AND cap each
   * notch at 85px of travel — page-mode wheels (deltaMode 2, e.g. Windows set to
   * "one screen at a time") used to sail ~430px per notch even eased, which the
   * owner reported 2026-10-26 as "one scroll moves down too fast and far".
   * Trackpads (small pixel deltas), pinch zoom, and the inner song lists keep
   * their native feel. */
  let wheelTgt = null, wheelRaf = 0;
  const wheelStop = () => { if (wheelRaf) cancelAnimationFrame(wheelRaf); wheelRaf = 0; wheelTgt = null; };
  addEventListener("pointerdown", wheelStop, true);
  addEventListener("wheel", (e) => {
    if (!matchMedia("(pointer:fine)").matches || !/^(radio|dj)$/.test(document.body.dataset.view || "") || e.ctrlKey) return;
    let n = e.target;
    while (n && n !== document.body) { const st = getComputedStyle(n); if ((st.overflowY === "auto" || st.overflowY === "scroll") && n.scrollHeight > n.clientHeight + 1) { if ((e.deltaY > 0 && n.scrollTop + n.clientHeight < n.scrollHeight - 1) || (e.deltaY < 0 && n.scrollTop > 0)) { wheelStop(); return; } } n = n.parentElement; }
    if (e.deltaMode === 0 && Math.abs(e.deltaY) < 40) { wheelStop(); return; }
    const d = e.deltaMode === 1 ? e.deltaY * 33 : e.deltaMode === 2 ? e.deltaY * innerHeight : e.deltaY;
    e.preventDefault();
    const max = Math.max(0, document.documentElement.scrollHeight - innerHeight);
    wheelTgt = Math.max(0, Math.min(max, scrollY + Math.max(-14, Math.min(14, d * 0.0125))));
    if (!wheelRaf) { const step = () => { const cur = scrollY, diff = wheelTgt - cur; if (Math.abs(diff) < 0.6) { scrollTo(0, wheelTgt); wheelRaf = 0; wheelTgt = null; return; } scrollTo(0, cur + diff * 0.18); wheelRaf = requestAnimationFrame(step); }; wheelRaf = requestAnimationFrame(step); }
  }, { passive: false });
  document.addEventListener("click", (e) => { if (e.target.closest && e.target.closest("#dj-pop2")) { e.preventDefault(); popOut(); } });
  if (typeof media !== "undefined") media.addEventListener("play", () => {
    if (listening) { listening = false; wakeForListening(false); DECKS.forEach((k) => decks[k]?.stop()); voiceEl?.pause(); $("#dj-listen").textContent = "🎧 Listen live"; return; }
    // The tables ARE the live radio while a set is live: any radio tune-in (player bar,
    // hero, lock-screen controls, radio-keep) hands over to the deck mix, not the playlist.
    if (!OWNER() && isLive() && typeof mode !== "undefined" && mode === "radio") { autoMoved = true; startListening(); }
  });
  $("#dj-listen").addEventListener("click", () => (listening ? stopListening() : isLive() || OWNER() ? startListening() : (typeof tuneIn === "function" && tuneIn())));

  let ownerLoaded = false;
  function mergeState(d) {
    const m = Object.assign({ live: false, xf: 0.5, xf2: 0.5, panY: 0, duck: false, quant: true, A: blank(), B: blank(), C: blank(), D: blank(), voice: null, liveSince: 0, ticker: "", log: [], show: null, pads: [], autodj: true, fx: defFx(), vmix: { mode: "auto", a: "", b: "", t: 0 } }, d || {});
    m.fx = Object.assign(defFx(), m.fx || {});
    m.vmix = Object.assign({ mode: "auto", a: "", b: "", t: 0 }, m.vmix || {});
    m.A = Object.assign(blank(), m.A || {}); m.B = Object.assign(blank(), m.B || {}); m.C = Object.assign(blank(), m.C || {}); m.D = Object.assign(blank(), m.D || {});
    return m;
  }
  // the site-wide LIVE pill (owner ask 2026-10-26): when Meechie (or an approved
  // guest DJ) is actually at the tables, every visitor sees it, with a one-tap
  // tune-in that mutes everything else and lands them on the radio
  const gName = (g) => { const n = ((g && g.name) || "").trim(); return n ? (n.includes("@") ? n.split("@")[0] : n) : "Guest DJ"; }; // a DJ is never shown as a raw email address
  function guestLiveOn() { try { return sessionStorage.getItem("mw-guestlive") === "1"; } catch (_) { return false; } } // hoisted: the lamp paints before this line runs
  function paintLiveAlert() { const el = document.getElementById("dj-livealert"); if (!el || SANDBOX) return; const now = Date.now(); const guest = S.djGuest && S.djGuest.until > now && (now - (S.djGuest.lastWrite || 0) < 45000); const host = !guest && (now - (S.boothAt || 0) < 150000) && DECKS.some((k) => S[k] && S[k].playing); const setId = guest ? ("g" + (S.djGuest.uid || "")) : String(S.liveSince || S.boothAt || ""); let dismissed = ""; try { dismissed = sessionStorage.getItem("mw-la-dismiss") || ""; } catch (_) {} const show = !listening && (guest || host) && dismissed !== setId && !document.body.classList.contains("dj-on") && !document.documentElement.classList.contains("popdj"); el.hidden = !show; if (show) { el.dataset.set = setId; const t = el.querySelector(".la-txt"); if (t) t.textContent = guest ? ("🔴 LIVE NOW — " + gName(S.djGuest) + " is DJing on Meechie's World Radio") : "🔴 LIVE NOW — Meechie is DJing on the radio"; } }
  function onState(d) {
    paintVEdit(); try { paintLiveAlert(); } catch (_) {}
    const firstOwnerLoad = OWNER() && !ownerLoaded;
    if (OWNER() && ownerLoaded) {
      // Booth-to-booth sync: my own saves echo back and are ignored, but a save stamped
      // by the OTHER booth window (the pop-out, or the main tab) is a command — repaint
      // from it, and if THIS window holds the sound, play what it says. The 24/7 keeper's
      // advances land here too, so an open booth never shows a stale station.
      if (d && d.by !== tabId && (d.updatedAt || 0) > (S.updatedAt || 0)) {
        S = mergeState(d);
        paintOwner(); paintStation();
        if (boothLead) DECKS.forEach((k) => { if (S[k].src) follow(k); });
      }
      return;
    }
    if (OWNER()) ownerLoaded = true;
    const was = isLive();
    S = mergeState(d);
    // heal the booth: anything still pointing at the dead storage comes off the decks
    if (OWNER()) { let dirty = false; DECKS.forEach((k) => { if (DEAD(S[k].src)) { S[k] = blank(); dirty = true; } }); if (S.voice && DEAD(S.voice.url)) { S.voice = null; dirty = true; } if (S.show && DEAD(S.show.url)) { S.show = null; dirty = true; } if (dirty) setTimeout(() => save(true), 800); }
    const live = isLive();
    $("#dj-banner").hidden = !live || OWNER();
    $("#dj-station").hidden = OWNER() ? false : (live || (S.log || []).length > 0 || !!S.show);
    if (!live && listening) endSet();
    if (live && !was && !document.hidden && !OWNER() && typeof mode !== "undefined" && mode === "radio" && typeof media !== "undefined" && !media.paused) { autoMoved = true; startListening(); }
    if (listening) DECKS.forEach((k) => follow(k));
    // taking control: opening the booth pulls whatever the station is playing onto the
    // decks, in sync, so the tables are his from the first second
    if (firstOwnerLoad) { showOwnerUI(); DECKS.forEach((k) => { if (S[k].playing && boothLead) follow(k); }); }
    playVoice(); firePadHit(); paintStation();
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
  function paintPrep() { const box = $("#dj-prep"); if (!box) return; const set = prepSet(), list = TRACKS(); const rows = list.map((t, i) => [t, i]).filter(([t]) => set.has(URLOF(t))); box.innerHTML = rows.length ? rows.map(([t, i]) => `<div class="dj-item"><span title="${E(t.title)}">${E(t.title)}</span><button class="btn ghost sm" type="button" data-load="A" data-lib="${i}">A</button><button class="btn ghost sm" type="button" data-load="B" data-lib="${i}">B</button><button class="btn ghost sm" type="button" data-load="C" data-lib="${i}">C</button><button class="btn ghost sm" type="button" data-load="D" data-lib="${i}">D</button><button class="btn ghost sm" type="button" data-prep="${i}">⭐</button></div>`).join("") : '<small class="muted">Nothing prepared yet — tap ☆ on any song in Your Library.</small>'; const hb = $("#dj-hist"); if (hb) { const h = histList(); hb.innerHTML = h.length ? h.map((x, i) => `<div class="dj-item"><span title="${E(x.title || "")}">${E(x.title || "")}</span>${["A", "B", "C", "D"].map((L) => `<button class="btn ghost sm" type="button" data-hload="${L}" data-hist="${i}">${L}</button>`).join("")}</div>`).join("") : '<small class="muted">Nothing loaded yet — the booth history builds as you play.</small>'; } }
  let net = [];
  async function load(k, item) {
    const d = deck(k); actx();
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
    if (item.yt) { const okY = await d.setYt(item.yt); if (!okY) { say("That video wouldn't play here — some are blocked from playing on other sites. Try another one."); S[k] = blank(); paintOwner(); return; } try { d.el.currentTime = 0; } catch (_) {} paintOwner(); levels(); save(); return; }
    const ok = await d.set(item.src);
    if (!ok) { say("That song couldn't load. Try another one."); S[k] = blank(); paintOwner(); return; }
    d.el.currentTime = 0; d.el.playbackRate = S[k].rate || 1; paintOwner(); levels(); save(); analyze(k);
  }
  function paintCues(k) { document.querySelectorAll(`[data-hot^="${k}:"]`).forEach((b, i) => b.classList.toggle("on", deck(k).cues[i] != null)); document.querySelectorAll(`[data-loopb^="${k}:"]`).forEach((b) => b.classList.toggle("on", !!deck(k).loopBeats && +b.dataset.loopb.split(":")[1] === deck(k).loopBeats)); document.querySelectorAll(`[data-roll^="${k}:"]`).forEach((b) => b.classList.toggle("on", !!deck(k).roll && +b.dataset.roll.split(":")[1] === deck(k).loopBeats)); document.querySelectorAll(`[data-slip="${k}"]`).forEach((b) => b.classList.toggle("on", !!deck(k).slip)); }
  // loop roll: the loop cycles on the speakers while a shadow playhead keeps
  // travelling; ending the roll lands exactly where the song would have been
  function endRoll(k) { const d = deck(k); if (!d.roll) return; const sh = d.roll.pos + (performance.now() - d.roll.at) / 1000 * (S[k].rate || 1); d.roll = null; d.loop = null; d.loopBeats = 0; S[k].loop = null; S[k].loopBeats = 0; try { d.el.currentTime = Math.max(0, Math.min((d.el.duration || 1e9) - 0.3, sh)); } catch (_) {} if (S[k].playing) S[k].start = Date.now() - d.el.currentTime * 1000; paintCues(k); save(true); }
  async function togglePlay(k) {
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
      if (s.yt) { const okY = await d.setYt(s.yt); if (!okY) { say("That video won't play here — it may be blocked from playing on other sites, or YouTube didn't load. Try another video."); paintOwner(); return; } } else await d.set(s.src); try { d.el.currentTime = s.pos || 0; } catch (_) {}
      d.el.playbackRate = s.rate || 1; d.el.preservesPitch = !d.vinyl;
      await d.el.play().catch(() => {}); s.start = Date.now() - d.el.currentTime * 1000; s.playing = true;
      logPlay(s.title);
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
    if (b.dataset.vmix || b.dataset.vsrc) {
      const ytDecks = () => DECKS.filter((k) => S[k].yt && S[k].playing).sort((x, y) => stageGain(y) - stageGain(x));
      if (b.dataset.vsrc) { const k = b.dataset.vsrc; if (S[k] && S[k].yt) { S.vmix = { mode: "man", a: k, b: "", t: 0 }; say("📺 Master screen: deck " + k + " full screen — viewers see it too."); } else say("No video on deck " + k + " — put a YouTube video there first."); paintOwner(); save(true); return; }
      const a = b.dataset.vmix;
      if (a === "auto") { S.vmix = { mode: "auto", a: "", b: "", t: 0 }; say("📺 Video screen on AUTO — the picture now fades with the X fader, just like the sound."); paintOwner(); save(true); return; }
      const top2 = ytDecks(), cur = vmixTargets()[0];
      if (top2.length < 2 || !cur) { say("Put videos on two decks first — then Cut and Fade mix the pictures."); return; }
      const other = top2.find((k) => k !== cur.k);
      if (a === "cut") { S.vmix = { mode: "man", a: other, b: "", t: 0 }; say("✂️ Video CUT to deck " + other + "."); paintOwner(); save(true); return; }
      // fade: dissolve from the deck on screen to the other one over ~1.2s,
      // saving as it goes so viewers dissolve with the booth
      S.vmix = { mode: "man", a: cur.k, b: other, t: 0 }; save(true);
      const t0 = performance.now(); say("🌫️ Fading the picture to deck " + other + "…");
      const step = () => { const p = Math.min(1, (performance.now() - t0) / 1200); S.vmix.t = p; stageApply(1, 1); save(); if (p < 1) requestAnimationFrame(step); else { S.vmix = { mode: "man", a: other, b: "", t: 0 }; paintOwner(); save(true); } };
      requestAnimationFrame(step); return;
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
      S.fx = Object.assign(defFx(), P.fx); if (!P.keepMix) { S.xf = 0.5; S.xf2 = 0.5; }
      DECKS.forEach((k) => { const d = deck(k); d.vinyl = P.vinyl; d.el.preservesPitch = !P.vinyl; const vc = document.querySelector(`[data-vinyl="${k}"]`); if (vc) vc.checked = P.vinyl; if (!P.keepMix) S[k].vol = 0.9; });
      document.querySelectorAll("[data-gate]").forEach((x) => x.classList.toggle("on", +x.dataset.gate === S.fx.gate));
      applyFx(); levels(); paintOwner(); save(true); say(P.msg); return;
    }
    if (b.dataset.curplay != null) { const ci = CURATED[+b.dataset.curplay]; if (ci) { b.disabled = true; const src = await curatedSrc(ci); b.disabled = false; if (src) { if (boothLead) playPadUrl(src); stampPad({ kind: "url", i: -1, url: src }); } else say("That sound wouldn't load. Try another."); } return; }
    if (b.dataset.freeload) { const [dk, kind, ix] = b.dataset.freeload.split(":"), it = (kind === "m" ? FREE_MEDIA.music : FREE_MEDIA.videos)[+ix]; if (it) load(dk, { src: it.src, yt: "", title: it.t, cover: it.cover, dur: it.dur || 0 }); return; }
    if (b.dataset.vput) { const [dk, ix] = b.dataset.vput.split(":"), it = vRes[+ix]; if (!it) return; if (it.kind === "ia") { say("Finding the video file on the Archive..."); const fsrc = await iaVideoFile(it.id); if (!fsrc) { say("That Archive item has no playable video file — try another one."); return; } load(dk, { src: fsrc, yt: "", title: it.title, cover: it.thumb || "", dur: 0 }); return; } const tok2 = it.kind === "dm" ? "dm:" + it.id : it.id; load(dk, { yt: tok2, src: "", title: it.title, cover: it.thumb || "", dur: it.dur || 0 }); return; }
    if (b.dataset.ytload) { const inp = $("#dj-yt"), item = vidParse(inp && inp.value); if (!item) { say("Paste a YouTube, Vimeo or Dailymotion link first — then pick the deck."); return; } if (item.iaId) { say("Finding the video file on the Archive..."); const asrc = await iaVideoFile(item.iaId); if (!asrc) { say("That Archive item has no playable video file."); return; } load(b.dataset.ytload, { src: asrc, yt: "", title: item.title || "Archive video", cover: "https://archive.org/services/img/" + item.iaId, dur: 0 }); return; } load(b.dataset.ytload, item); return; }
    if (b.dataset.load) {
      if (b.dataset.cur != null) { const ci = CURATED[+b.dataset.cur]; if (!ci) return; b.disabled = true; const src = await curatedSrc(ci); b.disabled = false; if (!src) { say("That sound wouldn't load. Try another."); return; } load(b.dataset.load, { src, title: ci.name, cover: "" }); }
      else if (b.dataset.lib != null) { const t = TRACKS()[+b.dataset.lib]; if (t) load(b.dataset.load, { src: URLOF(t), title: t.title, cover: t.cover, dur: +t.duration || 0, bpm: +t.bpm || 0, key: t.key || "", cam: t.cam || "" }); }
      else if (b.dataset.net != null) { const n = net[+b.dataset.net]; if (!n) return; b.disabled = true; const src = await iaFile(n.id); b.disabled = false; if (!src) { say("No playable file in that one. Pick another."); return; } load(b.dataset.load, { src, title: n.title, cover: "https://archive.org/services/img/" + encodeURIComponent(n.id) }); }
      return;
    }
    if (b.dataset.queue != null) { const t = TRACKS()[+b.dataset.queue]; if (t) { queue.push({ src: URLOF(t), title: t.title, cover: t.cover || "", dur: +t.duration || 0 }); saveQueue(); paintQueue(); say("Queued: " + t.title); } return; }
    if (b.dataset.nqueue != null) { const n = net[+b.dataset.nqueue]; if (!n) return; b.disabled = true; const src = await iaFile(n.id); b.disabled = false; if (!src) { say("No playable file in that one. Pick another."); return; } queue.push({ src, title: n.title, cover: "https://archive.org/services/img/" + encodeURIComponent(n.id), dur: 0 }); saveQueue(); paintQueue(); say("Queued: " + n.title); return; }
    if (b.dataset.play) return togglePlay(b.dataset.play);
    if (b.dataset.cue0) { const k = b.dataset.cue0, s = S[k], d = deck(k); s.pos = 0; if (s.playing) s.start = Date.now(); try { d.el.currentTime = 0; } catch (_) {} save(true); return; }
    if (b.dataset.brake) { const k = b.dataset.brake, d = deck(k); if (d.el.paused) return; d.noSync = Date.now() + 1100; const r0 = d.el.playbackRate, t0 = performance.now(), pos0 = d.el.currentTime || 0, slip = !!d.slip; const step = () => { const p = (performance.now() - t0) / 800; if (p >= 1) { d.el.playbackRate = S[k].rate || 1; if (slip) { try { d.el.currentTime = Math.max(0, Math.min((d.el.duration || 1e9) - 0.3, pos0 + 0.8 * (S[k].rate || 1))); } catch (_) {} d.el.play().catch(() => {}); if (S[k].playing) S[k].start = Date.now() - d.el.currentTime * 1000; save(true); say("🌀 Slip brake — deck " + k + " lands right where the song would have been."); } else { d.el.pause(); if (S[k].playing) { S[k].playing = false; S[k].pos = d.el.currentTime; paintOwner(); save(true); } } return; } d.el.playbackRate = Math.max(0.02, r0 * (1 - p)); requestAnimationFrame(step); }; step(); return; }
    if (b.dataset.hot) { if (hotTimer === "done") { hotTimer = null; return; } const [k, n] = b.dataset.hot.split(":"), d = deck(k), i = +n - 1; if (d.cues[i] == null) { let ct = d.el.currentTime || 0; if (S.quant !== false) ct = snapBeat(k, ct); d.cues[i] = ct; S[k].cues = d.cues.slice(); save(true); say("Cue " + n + " set at " + fmt(ct) + (S.quant !== false && beatLen(k) ? " (snapped to the beat)" : "")); } else { try { d.el.currentTime = d.cues[i]; } catch (_) {} if (S[k].playing) S[k].start = Date.now() - d.cues[i] * 1000; save(true); } paintCues(k); return; }
    if (b.dataset.loopb) { const [k, beats] = b.dataset.loopb.split(":"), d = deck(k), bl = beatLen(k); if (d.roll) { endRoll(k); return; } if (d.loop && d.loopBeats === +beats) { d.loop = null; d.loopBeats = 0; S[k].loop = null; S[k].loopBeats = 0; save(true); } else { let st = d.el.currentTime || 0; if (S.quant !== false) st = snapBeat(k, st); const len = bl ? +beats * bl : +beats; d.loop = [st, st + len]; d.loopBeats = +beats; S[k].loop = d.loop; S[k].loopBeats = d.loopBeats; try { d.el.currentTime = st; } catch (_) {} if (S[k].playing) S[k].start = Date.now() - st * 1000; save(true); say("Looping " + beats + " beats on deck " + k + (bl ? "" : " (no BPM measured yet — seconds for now)")); } paintCues(k); return; }
    if (b.dataset.roll) { const [k, beats] = b.dataset.roll.split(":"), d = deck(k), bl = beatLen(k); if (d.roll) { endRoll(k); say("🌀 Roll off — deck " + k + " is back where the song would have been."); return; } let st = d.el.currentTime || 0; if (S.quant !== false) st = snapBeat(k, st); const len = bl ? +beats * bl : +beats; d.loop = [st, st + len]; d.loopBeats = +beats; S[k].loop = d.loop; S[k].loopBeats = d.loopBeats; d.roll = { pos: st, at: performance.now() }; try { d.el.currentTime = st; } catch (_) {} if (S[k].playing) S[k].start = Date.now() - st * 1000; paintCues(k); save(true); say("🌀 Rolling " + beats + " beats on deck " + k + " — tap Roll again and it lands where the song would have been."); return; }
    if (b.dataset.slip) { const k = b.dataset.slip, d = deck(k); d.slip = !d.slip; paintCues(k); say(d.slip ? "🌀 Slip ON for deck " + k + " — scratch, brake or backspin, and it lands where the song would have been." : "Slip off for deck " + k + "."); return; }
    if (b.dataset.spin) { const k = b.dataset.spin, d = deck(k); if (d.el.paused) return; d.noSync = Date.now() + 950; const t0 = performance.now(); scratchBed(); const iv = setInterval(() => { const p = (performance.now() - t0) / 750; if (p >= 1) { clearInterval(iv); scratchStop(); if (d.slip) { try { d.el.currentTime = Math.max(0, Math.min((d.el.duration || 1e9) - 0.3, (d.el.currentTime || 0) + 0.75 * (S[k].rate || 1))); } catch (_) {} if (S[k].playing) S[k].start = Date.now() - d.el.currentTime * 1000; save(true); say("🌀 Slip backspin — deck " + k + " never lost its place."); } else { d.el.pause(); if (S[k].playing) { S[k].playing = false; S[k].pos = d.el.currentTime; paintOwner(); save(true); } } return; } try { d.el.currentTime = Math.max(0, (d.el.currentTime || 0) - (0.04 + p * 0.3)); } catch (_) {} scratchSound(0.4 + p); }, 50); return; }
    if (b.dataset.prep != null) { const t = TRACKS()[+b.dataset.prep]; if (t) { const set = prepSet(), u = URLOF(t); if (set.has(u)) set.delete(u); else set.add(u); try { localStorage.setItem("mw-dj-prep", JSON.stringify([...set])); } catch (_) {} libList(); paintPrep(); say(set.has(u) ? "⭐ Prepared: " + t.title : "Removed from Prepare: " + t.title); } return; }
    if (b.dataset.hload) { const x = histList()[+b.dataset.hist]; if (x) load(b.dataset.hload, { src: x.src || "", yt: x.yt || "", title: x.title || "", cover: x.cover || "", dur: x.dur || 0 }); return; }
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
  let hotTimer = null;
  onMain("pointerdown", (e) => { const b = e.target.closest("[data-hot]"); if (!b || !OWNER()) return; hotTimer = setTimeout(() => { const [k, n] = b.dataset.hot.split(":"); deck(k).cues[+n - 1] = null; S[k].cues = deck(k).cues.slice(); save(true); paintCues(k); say("Cue " + n + " cleared"); hotTimer = "done"; }, 650); });
  onMainRaw("pointerup", (e) => { if (hotTimer === "done") { e.preventDefault(); return; } clearTimeout(hotTimer); hotTimer = null; }, true);
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
  onMain("change", (e) => { if (!OWNER()) return; if (e.target.dataset.vinyl != null) { const k = e.target.dataset.vinyl, d = deck(k); d.vinyl = e.target.checked; d.el.preservesPitch = !d.vinyl; } if (e.target.id === "ad-on") { S.autodj = e.target.checked; save(true); say(S.autodj ? "Auto-DJ is running the station 🤖" : "Auto-DJ off — you're flying manual."); } if (e.target.id === "dj-quant") { S.quant = e.target.checked; save(true); say(S.quant ? "Quantize ON — cues and loops snap to the beat." : "Quantize off — cues and loops land exactly where you tap."); } if (e.target.id === "dj-jogf") { JOGF = parseFloat(e.target.value) || 0.09; try { localStorage.setItem("mw-jogf", String(JOGF)); } catch (_) {} say("Jog feel set — grab a platter and feel the difference."); } if (e.target.id === "dj-fxsync") { S.fx.sync = e.target.checked; applyFx(); save(true); say(S.fx.sync ? "Effects now follow the live tempo — echo, flanger and the chopper lock to the beat." : "Effects free-running."); } });
  // circular pan pads: drag the gold dot anywhere in the circle — the further it
  // moves toward a deck, the more that deck plays. Same mix as the sliders and the
  // phone fader bar; everything stays in sync, including Auto-DJ crossfades.
  function paintXfPads() { // THE ONE FADER dot: full-travel paint (the dot reaches the edge your finger reaches) + live mix readout
    XFCURVE = S.xfCurve || "smooth"; document.querySelectorAll("[data-xfc]").forEach((x) => x.classList.toggle("on", x.dataset.xfc === XFCURVE));
    const dot = $("#dj-xfdot"); if (dot) { dot.style.left = (50 + (S.xf - 0.5) * 84) + "%"; dot.style.top = (50 + (S.panY || 0) * 42) + "%"; }
    const rd = $("#dj-pan-read"); if (rd) { const py = S.panY || 0, ab = py > 0 ? 1 - py : 1, cd = py < 0 ? 1 + py : 1; const g = { A: xfGain(S.xf, "A") * ab, B: xfGain(S.xf, "B") * ab, C: xfGain(S.xf2 ?? 0.5, "A") * cd, D: xfGain(S.xf2 ?? 0.5, "B") * cd }; const mx = Math.max(g.A, g.B, g.C, g.D, 0.0001); rd.textContent = ["A", "B", "C", "D"].map((k) => k + " " + Math.round(g[k] / mx * 100) + "%").join(" · "); }
    document.querySelectorAll("[data-xv]").forEach((el) => { const k = el.dataset.xv, v = S[k] ? (S[k].vol || 0) : 0; el.style.setProperty("--rot", (-135 + (v / 2) * 270) + "deg"); const b = el.querySelector("b"); if (b) b.textContent = Math.round(v * 100) + "%"; });
  }
  // ONE pan dot for all four decks: left/right rides both crossfaders together,
  // up/down picks which pair rules (top = A/B, bottom = C/D). Center = everything even.
  (() => { const pad = $("#dj-xfpad"); if (!pad) return; let drag = false;
    const center = () => { S.xf = 0.5; S.xf2 = 0.5; S.panY = 0; paintXfPads(); levels(); save(true); };
    const apply = (e) => { const r = pad.getBoundingClientRect(), rad = r.width / 2; let dx = (e.clientX - (r.left + rad)) / rad, dy = (e.clientY - (r.top + rad)) / rad; dx = Math.min(1, Math.max(-1, dx)); dy = Math.min(1, Math.max(-1, dy)); if (Math.abs(dx) < 0.07) dx = 0; if (Math.abs(dy) < 0.09) dy = 0; if (xfAnim) { clearInterval(xfAnim); xfAnim = null; } S.xf = Math.round(((dx + 1) / 2) * 1000) / 1000; S.xf2 = S.xf; S.panY = Math.round(dy * 1000) / 1000; paintXfPads(); levels(); save(); };
    pad.addEventListener("pointerdown", (e) => { if (!OWNER()) return; drag = true; try { pad.setPointerCapture(e.pointerId); } catch (_) {} apply(e); e.preventDefault(); });
    pad.addEventListener("pointermove", (e) => { if (drag) apply(e); });
    pad.addEventListener("pointerup", () => { if (drag) { drag = false; save(true); } });
    pad.addEventListener("pointercancel", () => { drag = false; });
    pad.addEventListener("dblclick", () => { if (OWNER()) center(); });
    pad.addEventListener("keydown", (e) => { if (!OWNER()) return; const st = e.shiftKey ? 0.01 : 0.05; if (e.key === "ArrowLeft") { S.xf = Math.max(0, S.xf - st); S.xf2 = S.xf; } else if (e.key === "ArrowRight") { S.xf = Math.min(1, S.xf + st); S.xf2 = S.xf; } else if (e.key === "ArrowUp") { S.panY = Math.max(-1, (S.panY || 0) - st); } else if (e.key === "ArrowDown") { S.panY = Math.min(1, (S.panY || 0) + st); } else return; paintXfPads(); levels(); save(); e.preventDefault(); });
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
    cv.addEventListener("pointerdown", (e) => { if (!OWNER()) return; scrub = true; try { cv.setPointerCapture(e.pointerId); } catch (_) {} seekTo(e); e.preventDefault(); });
    cv.addEventListener("pointermove", (e) => { if (scrub) seekTo(e); });
    cv.addEventListener("pointerup", () => { if (scrub) { scrub = false; save(true); } });
    cv.addEventListener("pointercancel", () => { scrub = false; });
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
    const pl = () => $("#pl-" + k); let drag = null;
    onMain("pointerdown", (e) => { if (e.target !== pl() || !OWNER()) return; drag = { x: e.clientX, t: performance.now(), at: performance.now(), pos: deck(k).el.currentTime || 0, was: !deck(k).el.paused }; deck(k).el.pause(); scratchBed(); deckBuffer(k).then(() => { if (drag) grainStart(k); }); if (bufCache.has(deck(k).src)) grainStart(k); e.preventDefault(); });
    onMainRaw("pointermove", (e) => { if (!drag) return; const d = deck(k), now = performance.now(), dx = e.clientX - drag.x, dt = Math.max(1, now - drag.t); drag.x = e.clientX; drag.t = now; try { d.el.currentTime = Math.max(0, Math.min((d.el.duration || 0) - 0.2, d.el.currentTime + dx * JOGF)); } catch (_) {} if (S[k]) S[k].pos = d.el.currentTime; d.scrVel = (d.scrVel || 0) * 0.55 + (Math.abs(dx * JOGF) / (dt / 1000)) * 0.45; scratchSound(dx / dt); });
    onMainRaw("pointerup", () => { if (!drag) return; grainStop(); scratchStop(); const d = deck(k); if (drag.was && d.slip) { const sh = drag.pos + (performance.now() - drag.at) / 1000 * (S[k].rate || 1); try { d.el.currentTime = Math.max(0, Math.min((d.el.duration || 1e9) - 0.3, sh)); } catch (_) {} } if (drag.was) { d.el.play().catch(() => {}); if (S[k].playing) S[k].start = Date.now() - d.el.currentTime * 1000; } else if (S[k]) S[k].pos = d.el.currentTime; drag = null; save(true); });
    onMainRaw("pointercancel", () => { if (!drag) return; grainStop(); scratchStop(); drag = null; });
  });
  // deck ended -> owner bookkeeping + Auto-DJ
  // dead-air guard: a deck that runs out (or stalls at the end) while the station is
  // LIVE hands over automatically — listener pick first, then the queue, then the mix —
  // even with Auto-DJ switched off, because a live set should never just stop
  function deckEnded(k) {
    if (!OWNER() || listening || !S[k].playing) return;
    S[k].playing = false; S[k].pos = 0; paintOwner(); save(true);
    // Only Auto-DJ picks songs by itself. With Auto-DJ off the DJ is in charge: a deck that ends just stops
    // (owner, 2026-10-27: "it keeps forcing songs to change").
    if (S.live && S.autodj && !DECKS.some((x) => S[x].playing)) { say("⏭️ Deck " + k + " ended — Auto-DJ is rolling the next song."); autoNext(k, true); }
  }
  DECKS.forEach((k) => setTimeout(() => deck(k).el.addEventListener("ended", () => deckEnded(k)), 0));

  /* ---------- Auto-DJ queue ---------- */
  let queue = []; try { queue = JSON.parse(localStorage.getItem("mw-dj-queue") || "[]"); } catch (_) {}
  const saveQueue = () => { try { localStorage.setItem("mw-dj-queue", JSON.stringify(queue)); } catch (_) {} };
  function paintQueue() { const box = $("#ad-queue"); if (!box) return; box.innerHTML = queue.length ? queue.map((q, i) => `<div class="dj-item"><span title="${E(q.title)}">${i + 1}. ${E(q.title)}</span><button class="btn ghost sm" type="button" data-qdel="${i}">✕</button></div>`).join("") : '<small class="muted">Queue is empty — Auto-DJ pulls from the full library rotation.</small>'; }
  onMain("click", (e) => { const b = e.target.closest("[data-qdel]"); if (b) { queue.splice(+b.dataset.qdel, 1); saveQueue(); paintQueue(); } });
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
  let xfAnim = null, adTimer = null, handoverBusy = false;
  const usedPicks = new Set((() => { try { return JSON.parse(localStorage.getItem("mw-dj-usedpicks") || "[]"); } catch (_) { return []; } })());
  async function autoNext(endedK, force, fadeMs) {
    if ((!S.autodj && !force) || !boothLead) return;
    if (handoverBusy) return; handoverBusy = true;
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
    if (!item && queue.length) item = queue.shift();
    if (!item) { mixFlip = !mixFlip; if (mixFlip) item = await nextFromPool(); if (!item) item = nextFromLibrary(); }
    if (!item) { handoverBusy = false; return; }
    saveQueue(); paintQueue();
    const target = PAIR[endedK] || "A";
    const idPad = (S.pads || [])[0]; if (idPad && okUrl(idPad.url)) { S.voice = { id: idPad.id, url: idPad.url, at: Date.now() }; }
    load(target, item).then(async () => {
      await togglePlay(target);
      // the crossfade rides the pair's own axis: A/B on S.xf, C/D on S.xf2
      const cd = target === "C" || target === "D", key = cd ? "xf2" : "xf";
      const from = S[key] ?? 0.5, to = target === "B" || target === "D" ? 1 : 0, t0 = performance.now(), dur = Math.max(800, fadeMs || 3500);
      clearInterval(xfAnim); xfAnim = setInterval(() => { const p = Math.min(1, (performance.now() - t0) / dur); S[key] = from + (to - from) * p; levels(); paintXfPads(); if (p >= 1) { clearInterval(xfAnim); xfAnim = null; handoverBusy = false; save(true); } }, 100);
    }).catch(() => { handoverBusy = false; });
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
  function paintPads() {
    const box = $("#dj-pads"); if (!box || !OWNER()) return;
    const custom = [0, 1, 2, 3].map((i) => (S.pads || [])[i] || null);
    box.innerHTML = SYNTH.map((p, i) => `<button class="pad" type="button" data-synth="${i}">${p.name}<small>booth + recording</small></button>`).join("") +
      custom.map((p, i) => p ? `<button class="pad custom" type="button" data-pad="${i}">🎙️ Drop ${i + 1}<small>▶ booth · long-press = 📡 on air</small></button>` : `<button class="pad custom" type="button" data-padrec="${i}">➕ Drop ${i + 1}<small>tap to record 8s</small></button>`).join("");
  }
  let padPress = null;
  onMain("pointerdown", (e) => { const b = e.target.closest("[data-pad]"); if (!b) return; padPress = setTimeout(() => { const p = (S.pads || [])[+b.dataset.pad]; if (p && okUrl(p.url)) { S.voice = { id: p.id, url: p.url, at: Date.now() }; heardVoice = p.id; save(true); say("Drop sent out over the air 📡"); } padPress = "done"; }, 650); });
  onMainRaw("pointerup", () => { clearTimeout(padPress); if (padPress !== "done") padPress = null; }, true);
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
    const row = (it, i, kind) => `<div class="dj-item"><span style="display:flex;gap:8px;align-items:center;min-width:0"><img src="${E(it.cover)}" alt="" style="width:64px;height:36px;object-fit:cover;border-radius:6px;flex:none;background:#000"><span style="min-width:0"><span style="display:block" title="${E(it.t)}">${E(it.t)}</span><small class="muted">${E(it.a)}${it.dur ? " · " + fmt(it.dur) : ""}</small></span></span>${["A", "B", "C", "D"].map((dk) => `<button class="btn ghost sm" type="button" data-freeload="${dk}:${kind}:${i}">${dk}</button>`).join("")}</div>`;
    const em = $("#dj-freem"), ev = $("#dj-freev");
    if (em) em.innerHTML = FREE_MEDIA.music.map((it, i) => row(it, i, "m")).join("");
    if (ev) ev.innerHTML = FREE_MEDIA.videos.map((it, i) => row(it, i, "v")).join("");
  }
  paintFree();
  /* ---------- Video search everywhere: YouTube (Invidious mirrors, no key),
   * Dailymotion (public API, no key) and Internet Archive videos (no key).
   * YouTube decks carry a plain id in S[k].yt; Dailymotion rides as "dm:<id>"
   * and Vimeo (paste-a-link) as "vm:<id>" — setYt and the screens dispatch on
   * the prefix. Archive videos resolve to a real file and load as file decks. */
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
    const hosts = await ytHosts();
    for (const base of hosts) {
      try {
        const ctl = typeof AbortSignal !== "undefined" && AbortSignal.timeout ? { signal: AbortSignal.timeout(7000) } : {};
        const r = await fetch(base + "/api/v1/search?q=" + encodeURIComponent(q) + "&type=video&page=" + page, ctl);
        if (!r.ok) continue;
        const j = await r.json();
        if (Array.isArray(j)) return j.filter((it) => it && it.videoId).map((it) => ({ id: it.videoId, title: it.title || "YouTube video", dur: it.lengthSeconds || 0 }));
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
  let dmPage = 1;
  async function dmSearch(q) {
    try {
      const ctl = typeof AbortSignal !== "undefined" && AbortSignal.timeout ? { signal: AbortSignal.timeout(7000) } : {};
      const r = await fetch("https://api.dailymotion.com/videos?fields=id,title,duration,thumbnail_480_url&limit=24&sort=relevance&page=" + dmPage + "&search=" + encodeURIComponent(q), ctl);
      if (!r.ok) return null;
      const j = await r.json();
      if (!j || !Array.isArray(j.list)) return null;
      return j.list.filter((it) => it && it.id).map((it) => ({ kind: "dm", id: it.id, title: it.title || "Dailymotion video", dur: it.duration || 0, thumb: it.thumbnail_480_url || "" }));
    } catch (_) { return null; }
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
    const srcName = { yt: "YouTube", dm: "Dailymotion", ia: "Archive" };
    box.innerHTML = vRes.map((it, i) => `<div class="dj-item" style="padding:10px"><span style="display:flex;gap:12px;align-items:center;min-width:0"><img src="${E(it.thumb || "")}" alt="" style="width:152px;height:85px;object-fit:cover;border-radius:8px;flex:none;background:#000"><span style="min-width:0"><span style="display:block;font-size:15px" title="${E(it.title)}">${E(it.title)}</span><small class="muted">${srcName[it.kind] || ""}${it.dur ? " · " + fmt(it.dur) : ""}</small></span></span>${["A", "B", "C", "D"].map((dk) => `<button class="btn ghost" type="button" data-vput="${dk}:${i}" style="min-width:42px;padding:10px 0">${dk}</button>`).join("")}</div>`).join("") + (vMoreOn ? `<button class="btn" type="button" data-vmore="1" style="width:100%;margin-top:10px">🔁 MORE RESULTS</button>` : "");
  }
  const vtf = $("#dj-ytform");
  if (vtf) vtf.addEventListener("submit", async (e) => {
    e.preventDefault(); const q = $("#dj-ytq").value.trim(); if (!q) return;
    vQuery = q; dmPage = 1; iaPage = 1; vNextPage = 3; vMoreOn = false;
    paintVRes("Searching " + ({ yt: "YouTube", dm: "Dailymotion", ia: "the Archive" })[vSrc] + "...");
    let res = null;
    if (vSrc === "yt") { const r = await ytSearch(q); res = r ? r.map((it) => ({ kind: "yt", id: it.id, title: it.title, dur: it.dur, thumb: it.thumb || ("https://i.ytimg.com/vi/" + it.id + "/hqdefault.jpg") })) : null; if (res) vMoreOn = res.length >= 20; }
    else if (vSrc === "dm") { res = await dmSearch(q); if (res) vMoreOn = res.length >= 24; }
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
    else if (vSrc === "dm") { dmPage++; const r = await dmSearch(vQuery); if (r) { add = r; vMoreOn = r.length >= 24; } else dmPage--; }
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
  async function init() {
    if (!window.claude) return;
    const d = await claude.use("db"); if (!d) return;
    if (!SANDBOX) d.doc("radio/dj").onSnapshot((snap) => onState(snap.exists ? snap.data() : null), () => {});
    else { try { const s0 = JSON.parse(sessionStorage.getItem("mw-playdj") || "null"); if (s0) S = mergeState(s0); } catch (_) {} setTimeout(() => { paintOwner(); DECKS.forEach((k) => { if (S[k] && (S[k].src || S[k].yt)) follow(k); }); }, 600); }
    if (SANDBOX) setInterval(async () => { let on = false; try { on = sessionStorage.getItem("mw-guestlive") === "1"; } catch (_) {} if (!on) return; try { const r = await fetch("/api/cf/rest", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ table: "docs", op: "select", select: "path,data", limit: 1, filters: [["path", "eq", "radio/dj"]] }) }); const j = await r.json(); const row = (j.data || [])[0]; const d = row && (typeof row.data === "string" ? JSON.parse(row.data) : row.data); const ses = (window.MW && MW.session && MW.session()) || null; const uid = ses && ses.user && ses.user.id; const g = d && d.djGuest; if (!g || !uid || g.uid !== uid || !(g.until > Date.now())) { try { sessionStorage.removeItem("mw-guestlive"); } catch (_) {} say("Your live slot has ended 🎧"); } } catch (_) {} }, 15000);
    const show = () => { const own = OWNER(); $("#dj-owner").hidden = !own; document.documentElement.classList.toggle("popdj-guest", document.documentElement.classList.contains("popdj") && !own); if (own) { libList(); paintOwner(); paintQueue(); paintPads(); paintCurated(); subReqs(); const ti = $("#dj-ticker-in"); if (ti && document.activeElement !== ti) ti.value = S.ticker || ""; } paintPkList(); subPicks(); const vn = document.getElementById("dj-visit-note"); if (vn) vn.hidden = own; };
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
    const boothGate = () => { if (!boothHome2) return; const r = boothHome2.getBoundingClientRect(); const on = r.top <= 80 && r.bottom > innerHeight * 0.5; document.body.classList.toggle("dj-on", on); document.body.classList.toggle("dj-past", !on && r.bottom < 0); };
    if (boothHome2) { let gateQueued = false; const gateSoon = () => { if (gateQueued) return; gateQueued = true; requestAnimationFrame(() => { gateQueued = false; boothGate(); }); }; addEventListener("scroll", gateSoon, { passive: true }); addEventListener("resize", gateSoon); addEventListener("hashchange", () => { boothGate(); setTimeout(boothGate, 300); }); if ("IntersectionObserver" in window) new IntersectionObserver(() => boothGate(), { threshold: 0 }).observe(boothHome2); boothGate(); setTimeout(boothGate, 800); }
    const stBox2 = document.getElementById("st-ytbox");
    if (stBox2 && "IntersectionObserver" in window) new IntersectionObserver((es) => { es.forEach((en) => { stInView = en.isIntersecting; }); }, { threshold: 0.05 }).observe(stBox2);
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init); else init();
})();
