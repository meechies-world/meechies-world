/* ============================================================================
   v2 DJ DECKS — the booth's audio half (Phase 4). The graph, the deck
   objects and the level math are the live booth's (dj.js @ main
   ebc7da70), rebuilt as one module the booth view drives:

   - ONE AudioContext {latencyHint:"playback"}; chain masterIn → gate
     (transformer chopper) → crush (waveshaper) → fxFilter → masterGain
     → polish (hp 30 → lowshelf 110 +4 dB → peak 3.2 kHz +1.5 dB → glue
     compressor → tanh soft-clip) → limiter → analyser → destination.
     The limiter also taps the record destination. Sends (echo /
     flanger / phaser / noise / reverb) feed from masterIn, wet gains
     land on masterGain, and every wet is clamped by the broadcast caps
     in djstate.fxCaps (verb ≤ 0.30, fla ≤ 0.25, crush ≤ 12 — law).
   - A file deck is an <audio> element through a per-deck chain
     (MediaElementSource → stem stage → 3-band EQ → deck filter → deck
     gain → masterIn). A CORS failure swaps in a fresh element without
     crossOrigin and the deck rides el.volume instead (live onswap).
   - A video deck rides the platform player's own volume (YouTube caps
     at its own 100; boost ≤ 1.5× via djstate/station boostMk). The
     `ended` hook lives on the DECK object and is re-hooked on every
     element swap — bolting it to one element is the historical bug.
   - The YouTube shim keeps the live honesty rules: real seeking state,
     and the muted-rescue on play ("the mute is a loan, never a gift").
   - Listener audio path (closes Phase 2 gap 1): the same engine, fed
     the shared state, is what a v2 listener seat runs for file decks —
     one chain, one set of caps, booth and listener alike.

   LAW 22 (scroll/touch never touches the music): this module installs
   NO wheel or scroll handlers and never touches playbackRate/position
   outside the deck controls the view wires deliberately.
   ============================================================================ */
import { DECKS, PAIR, stageGain, boostMk } from "./station.js";
import { fxCaps, crushSteps } from "./djstate.js";
import { vparseTok } from "./engine.js";

const $min = (a, b) => Math.min(a, b);

/* ---------------- the shared audio graph ---------------- */
export function createAudioGraph() {
  const AC = window.AudioContext || window.webkitAudioContext;
  const ctx = new AC({ latencyHint: "playback" });
  const g = (v) => { const n = ctx.createGain(); n.gain.value = v; return n; };
  const masterIn = g(1);
  // gate (transformer chopper): square osc → shaper [-1,1] → depth → gateGain.gain
  const gateGain = g(1);
  const gateOsc = ctx.createOscillator(); gateOsc.type = "square"; gateOsc.frequency.value = 8;
  const gateShape = ctx.createWaveShaper(); gateShape.curve = new Float32Array([-1, 1]);
  const gateDepth = g(0);
  gateOsc.connect(gateShape); gateShape.connect(gateDepth); gateDepth.connect(gateGain.gain); gateOsc.start();
  // crush
  const crushNode = ctx.createWaveShaper(); crushNode.oversample = "2x";
  // master filter + gain
  const fxFilter = ctx.createBiquadFilter(); fxFilter.type = "lowpass"; fxFilter.frequency.value = 18000; fxFilter.Q.value = 0.4;
  const masterGain = g(0.95);
  masterIn.connect(gateGain); gateGain.connect(crushNode); crushNode.connect(fxFilter); fxFilter.connect(masterGain);
  // polish chain
  const hp = ctx.createBiquadFilter(); hp.type = "highpass"; hp.frequency.value = 30; hp.Q.value = 0.5;
  const low = ctx.createBiquadFilter(); low.type = "lowshelf"; low.frequency.value = 110; low.gain.value = 4;
  const pres = ctx.createBiquadFilter(); pres.type = "peaking"; pres.frequency.value = 3200; pres.Q.value = 0.9; pres.gain.value = 1.5;
  const glue = ctx.createDynamicsCompressor();
  glue.threshold.value = -18; glue.ratio.value = 18; glue.attack.value = 0.03; glue.release.value = 0.24; glue.knee.value = 2.5;
  const clip = ctx.createWaveShaper(); clip.oversample = "4x";
  { const c = new Float32Array(1024); for (let i = 0; i < 1024; i++) { const x = i / 511.5 - 1; c[i] = Math.tanh(1.15 * x); } clip.curve = c; }
  const limiter = ctx.createDynamicsCompressor();
  limiter.threshold.value = -1.2; limiter.ratio.value = 20; limiter.attack.value = 0.001; limiter.release.value = 0.24; limiter.knee.value = 0;
  const analyser = ctx.createAnalyser(); analyser.fftSize = 256;
  masterGain.connect(hp); hp.connect(low); low.connect(pres); pres.connect(glue); glue.connect(clip); clip.connect(limiter);
  limiter.connect(analyser); analyser.connect(ctx.destination);
  const recDest = ctx.createMediaStreamDestination(); limiter.connect(recDest);
  // sends, fed from masterIn, wet → masterGain
  const echoDelay = ctx.createDelay(2); echoDelay.delayTime.value = 0.28;
  const echoFb = g(0.34); const echoLp = ctx.createBiquadFilter(); echoLp.type = "lowpass"; echoLp.frequency.value = 1600;
  const echoWet = g(0);
  masterIn.connect(echoDelay); echoDelay.connect(echoLp); echoLp.connect(echoFb); echoFb.connect(echoDelay);
  echoDelay.connect(echoWet); echoWet.connect(masterGain);
  const flaDelay = ctx.createDelay(0.05); flaDelay.delayTime.value = 0.004;
  const flaFb = g(0.45); const flaWet = g(0);
  const flaLfo = ctx.createOscillator(); flaLfo.frequency.value = 0.3;
  const flaDepth = g(0.0016); flaLfo.connect(flaDepth); flaDepth.connect(flaDelay.delayTime); flaLfo.start();
  masterIn.connect(flaDelay); flaDelay.connect(flaFb); flaFb.connect(flaDelay); flaDelay.connect(flaWet); flaWet.connect(masterGain);
  let phaIn = masterIn; const phaWet = g(0); const phaFb = g(0.25);
  const phaNodes = [];
  for (let i = 0; i < 4; i++) { const ap = ctx.createBiquadFilter(); ap.type = "allpass"; ap.frequency.value = 800; ap.Q.value = 0.8; phaIn.connect(ap); phaIn = ap; phaNodes.push(ap); }
  phaIn.connect(phaWet); phaWet.connect(masterGain); phaIn.connect(phaFb); phaFb.connect(phaNodes[0]);
  const phaLfo = ctx.createOscillator(); phaLfo.frequency.value = 0.4; const phaDepth = g(420);
  phaLfo.connect(phaDepth); phaNodes.forEach((ap) => phaDepth.connect(ap.frequency)); phaLfo.start();
  const noiseBuf = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
  { const d = noiseBuf.getChannelData(0); for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1; }
  const noiseSrc = ctx.createBufferSource(); noiseSrc.buffer = noiseBuf; noiseSrc.loop = true;
  const noiseBp = ctx.createBiquadFilter(); noiseBp.type = "bandpass"; noiseBp.frequency.value = 900; noiseBp.Q.value = 0.7;
  const noiseWet = g(0);
  noiseSrc.connect(noiseBp); noiseBp.connect(noiseWet); noiseWet.connect(masterGain); noiseSrc.start();
  const verb = ctx.createConvolver(); verb.buffer = impulse(ctx, 2.2, 2.4);
  const verbWet = g(0); masterIn.connect(verb); verb.connect(verbWet); verbWet.connect(masterGain);
  // mic: gain → monitor (0 by default) + analyser + record bus
  const micGain = g(0.9), micMon = g(0), micAn = ctx.createAnalyser(); micAn.fftSize = 512;
  micGain.connect(micMon); micMon.connect(ctx.destination); micGain.connect(micAn); micGain.connect(recDest);

  function impulse(c, dur, decay) {
    const len = c.sampleRate * dur, buf = c.createBuffer(2, len, c.sampleRate);
    for (let ch = 0; ch < 2; ch++) { const d = buf.getChannelData(ch); for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, decay); }
    return buf;
  }
  function setCrush(v) {
    if (!v) { crushNode.curve = null; return; }
    const steps = crushSteps(v), n = 1024, c = new Float32Array(n);
    for (let i = 0; i < n; i++) { const x = i / (n - 1) * 2 - 1; c[i] = Math.round(x * steps / 2) / (steps / 2); }
    crushNode.curve = c;
  }
  let masterMul = 1, lastBoost = 1;
  return {
    ctx, masterIn, masterGain, recDest, analyser, micGain, micMon, micAn,
    wake() { if (ctx.state === "suspended") ctx.resume().catch(() => {}); },
    setMasterVol(v) { masterMul = v; masterGain.gain.value = 0.95 * lastBoost * masterMul; },
    /* applyFx: S.fx → the graph, through the broadcast caps (law) */
    applyFx(fx, bpm) {
      const cap = fxCaps(fx);
      verbWet.gain.value = cap.verbWet;
      flaWet.gain.value = cap.flaWet;
      phaWet.gain.value = cap.phaWet;
      noiseWet.gain.value = cap.noiseWet;
      noiseBp.frequency.value = cap.noiseFreq;
      setCrush(cap.crushCurve);
      fxFilter.frequency.value = cap.filterFreq;
      echoFb.gain.value = cap.echoFb;
      lastBoost = fx && fx.boost ? Math.max(0.2, Math.min(2, +fx.boost)) : 1;
      masterGain.gain.value = 0.95 * lastBoost * masterMul;
      if (cap.gate > 0) { gateOsc.frequency.value = cap.gate; gateDepth.gain.value = 0.5; gateGain.gain.value = 0.5; }
      else { gateDepth.gain.value = 0; gateGain.gain.value = 1; }
      // beat-sync (fx.sync !== false): sends follow the playing tempo
      if (fx && fx.sync !== false && bpm > 0) {
        const bl = 60 / bpm;
        echoDelay.delayTime.value = bl * (fx.ediv || 0.75);
        flaLfo.frequency.value = 1 / (bl * 2);
        phaLfo.frequency.value = 1 / (bl * 4);
        if (cap.gate > 0) gateOsc.frequency.value = cap.gate * (120 / bpm);
      } else {
        echoDelay.delayTime.value = 0.28;
      }
    },
  };
}

/* ---------------- YouTube API (lazy, once) ---------------- */
let ytApiP = null;
export function loadYtApi() {
  if (window.YT && window.YT.Player) return Promise.resolve(true);
  if (ytApiP) return ytApiP;
  ytApiP = new Promise((res) => {
    const prev = window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady = () => { try { prev && prev(); } catch (_) {} res(true); };
    const s = document.createElement("script"); s.src = "https://www.youtube.com/iframe_api"; s.async = true;
    s.onerror = () => res(false);
    document.head.appendChild(s);
    setTimeout(() => res(!!(window.YT && window.YT.Player)), 8000);
  });
  return ytApiP;
}

/* ---------------- one deck ---------------- */
export class Deck {
  constructor(k, graph, hooks) {
    this.k = k; this.graph = graph; this.hooks = hooks || {};
    this.shim = null; this.player = null; this.wired = false;
    this.level = 0; this._locked = false;
    this.el = this._newAudioEl(true);
    this._buildChain();
  }
  _newAudioEl(cors) {
    const el = new Audio();
    el.preload = "auto"; el.playsInline = true;
    if (cors) el.crossOrigin = "anonymous";
    el.addEventListener("ended", () => { if (this.el === el && this.onEnded) this.onEnded(this.k); });
    el.addEventListener("error", () => { if (this.el === el && !this.shim) this._onElError(); });
    return el;
  }
  _buildChain() {
    const ctx = this.graph.ctx;
    try {
      this.srcNode = ctx.createMediaElementSource(this.el);
      // stem stage: normal path + center-cancel (oop) path, crossfaded
      this.nrm = ctx.createGain(); this.oop = ctx.createGain(); this.oop.gain.value = 0;
      this.hp = ctx.createBiquadFilter(); this.hp.type = "highpass"; this.hp.frequency.value = 10;
      // a light center-cancel approximation: mid emphasis via a peaking cut is
      // beyond a shim-free rebuild; the oop path rides the hp stage like live
      this.srcNode.connect(this.nrm); this.srcNode.connect(this.hp); this.hp.connect(this.oop);
      this.eqLo = ctx.createBiquadFilter(); this.eqLo.type = "lowshelf"; this.eqLo.frequency.value = 120;
      this.eqMid = ctx.createBiquadFilter(); this.eqMid.type = "peaking"; this.eqMid.frequency.value = 1000; this.eqMid.Q.value = 0.9;
      this.eqHi = ctx.createBiquadFilter(); this.eqHi.type = "highshelf"; this.eqHi.frequency.value = 8000;
      this.flt = ctx.createBiquadFilter(); this.flt.type = "lowpass"; this.flt.frequency.value = 18000;
      this.gain = ctx.createGain();
      this.an = ctx.createAnalyser(); this.an.fftSize = 256;
      this.nrm.connect(this.eqLo); this.oop.connect(this.eqLo);
      this.eqLo.connect(this.eqMid); this.eqMid.connect(this.eqHi); this.eqHi.connect(this.flt);
      this.flt.connect(this.gain); this.gain.connect(this.an); this.an.connect(this.graph.masterIn);
      this.wired = true;
    } catch (_) { this.wired = false; }
  }
  _onElError() {
    // CORS-tainted source: swap to a fresh element without crossOrigin;
    // the deck keeps playing, riding el.volume (live onswap discipline)
    if (!this.wired || !this.el.src) return;
    const src = this.el.src, wasPlaying = !this.el.paused;
    const el = this._newAudioEl(false);
    this.el = el; this.wired = false;
    el.src = src;
    if (this.hooks.onSwap) this.hooks.onSwap(this.k);
    if (wasPlaying) el.play().catch(() => {});
    this.apply(this.level);
  }
  set(src) {
    this.clearYt();
    if (this.el.src !== src) { this.el.src = src; }
    this.el.load();
  }
  clearYt() {
    if (this.player) { try { this.player.destroy(); } catch (_) {} this.player = null; }
    if (this.shim) { this.shim = null; if (this._audioEl) { this.el = this._audioEl; this._audioEl = null; this.apply(this.level); } }
  }
  /* Mount a video token (yt / dm: / vm:) into mountEl; resolves the shim.
     Only YouTube gets a full shim in v2 — Dailymotion/Vimeo tokens fall
     back to the view's screen slots (see the differences list). */
  async setYt(tok, mountEl) {
    const t = vparseTok(tok);
    if (t.p !== "yt") return null;
    const ok = await loadYtApi();
    if (!ok || !window.YT) return null;
    this.clearYt();
    this._audioEl = this.el;
    const shim = this._makeShim(t.id);
    this.shim = shim; this.el = shim;
    await shim._mount(mountEl, this);
    shim._locked = this._locked;
    return shim;
  }
  _makeShim(vid) {
    const deck = this;
    const shim = {
      _isShim: true, _locked: false, _skTo: -1, seeking: false, _vid: vid,
      _p: null, _ready: false,
      get currentTime() { try { return this._p && this._ready ? this._p.getCurrentTime() || 0 : 0; } catch (_) { return 0; } },
      get duration() { try { return this._p && this._ready ? this._p.getDuration() || 0 : 0; } catch (_) { return 0; } },
      get paused() { try { return !this._p || !this._ready ? true : this._p.getPlayerState() !== 1; } catch (_) { return true; } },
      get ended() { try { return this._p && this._ready ? this._p.getPlayerState() === 0 : false; } catch (_) { return false; } },
      get readyState() { return this._ready ? 4 : 0; },
      get playbackRate() { try { return this._p.getPlaybackRate() || 1; } catch (_) { return 1; } },
      set playbackRate(r) {
        try { const rates = this._p.getAvailablePlaybackRates() || [1]; let best = rates[0]; for (const x of rates) if (Math.abs(x - r) < Math.abs(best - r)) best = x; this._p.setPlaybackRate(best); } catch (_) {}
      },
      set volume(_) {}, get volume() { return 1; },
      play() {
        const p = this._p; if (!p || !this._ready) return Promise.resolve();
        try { p.playVideo(); } catch (_) {}
        // muted-rescue: if not PLAYING within 800 ms, mute + replay; the
        // mute is a loan — PLAYING state un-mutes and restores volume
        setTimeout(() => {
          try {
            if (this._p && this._p.getPlayerState() !== 1) {
              this._mutedLoan = true; this._p.mute(); this._p.playVideo();
            }
          } catch (_) {}
        }, 800);
        return Promise.resolve();
      },
      pause() { try { this._p && this._p.pauseVideo(); } catch (_) {} },
      seekTo(sec) {
        this.seeking = true; this._skTo = sec;
        try { this._p.seekTo(sec, true); } catch (_) {}
        setTimeout(() => { this.seeking = false; }, 4000); // backstop; state change settles sooner
      },
      _mount(mountEl, deckRef) {
        return new Promise((resolve) => {
          let done = false;
          const finish = () => { if (!done) { done = true; resolve(shim); } };
          setTimeout(finish, 6000);
          try {
            this._p = new window.YT.Player(mountEl, {
              videoId: vid, width: "100%", height: "100%",
              playerVars: { playsinline: 1, rel: 0, modestbranding: 1 },
              events: {
                onReady: () => { this._ready = true; deckRef.apply(deckRef.level); finish(); },
                onStateChange: (e) => {
                  if (e.data === 1) { // PLAYING: repay the mute loan
                    if (this._mutedLoan) { this._mutedLoan = false; try { this._p.unMute(); } catch (_) {} deckRef.apply(deckRef.level); }
                    this.seeking = false;
                    const dur = this.duration;
                    if (dur > 0 && deckRef.hooks.onTitle) deckRef.hooks.onTitle(deckRef.k, "", dur);
                  }
                  if (e.data === 0 && deckRef.onEnded) deckRef.onEnded(deckRef.k); // ENDED
                },
                onError: (e) => {
                  const code = e && e.data;
                  if (code === 100 || code === 101 || code === 150) {
                    this._locked = true; shim._locked = true;
                    if (deckRef.hooks.onLocked) deckRef.hooks.onLocked(deckRef.k, vid);
                  }
                  finish();
                },
              },
            });
            deckRef.player = this._p;
          } catch (_) { finish(); }
        });
      },
    };
    return shim;
  }
  /* apply a computed level (the fader law output for this deck) */
  apply(level) {
    this.level = level;
    if (this.shim) {
      try { if (this.shim._p && this.shim._ready) this.shim._p.setVolume(Math.round($min(1, Math.max(0, level)) * 100)); } catch (_) {}
      return;
    }
    if (this.wired && this.gain) { this.gain.gain.value = level; this.el.volume = 1; }
    else this.el.volume = $min(1, Math.max(0, level));
  }
  /* per-deck sound shaping from the deck record (EQ / filter / stems) */
  applyDeckFx(s) {
    if (!this.wired || this.shim || !s) return;
    this.eqLo.gain.value = s.eq && s.eq.lo != null ? +s.eq.lo : 0;
    this.eqMid.gain.value = s.eq && s.eq.mid != null ? +s.eq.mid : 0;
    this.eqHi.gain.value = s.eq && s.eq.hi != null ? +s.eq.hi : 0;
    const v = s.flt == null ? 50 : +s.flt;
    if (v < 49) { this.flt.type = "lowpass"; this.flt.frequency.value = 200 * Math.pow(90, v / 50); }
    else if (v > 51) { this.flt.type = "highpass"; this.flt.frequency.value = 20 * Math.pow(600, (v - 50) / 50); }
    else { this.flt.type = "lowpass"; this.flt.frequency.value = 18000; }
    if (s.vcut) { this.nrm.gain.value = 0; this.oop.gain.value = 1; } else { this.nrm.gain.value = 1; this.oop.gain.value = 0; }
    this.hp.frequency.value = s.bcut ? 160 : 10;
  }
  peak() {
    if (this.shim || !this.an) return 0;
    const a = new Uint8Array(this.an.frequencyBinCount);
    this.an.getByteTimeDomainData(a);
    let m = 0; for (let i = 0; i < a.length; i++) m = Math.max(m, Math.abs(a[i] - 128) / 128);
    return m;
  }
}

/* ---------------- the deck engine the view drives ---------------- */
export function createDeckEngine(getS, hooks) {
  const graph = createAudioGraph();
  const decks = {};
  for (const k of DECKS) {
    decks[k] = new Deck(k, graph, hooks);
    decks[k].onEnded = (kk) => { if (hooks.onEnded) hooks.onEnded(kk); };
  }
  let mixVol = 1, voicePlaying = false, micHot = 0, dropDuckUntil = 0;
  function levels() {
    const S = getS();
    const duck = (S.duck || voicePlaying || micHot > 0.04 || Date.now() < dropDuckUntil) ? 0.28 : 1;
    for (const k of DECKS) {
      const base = stageGain(S, k);
      const lvl = base * duck * (hooks.isListenerSeat && hooks.isListenerSeat() ? mixVol : 1);
      // video decks ride the player volume with the boost law (≤1.5×)
      if (decks[k].shim) {
        const b = boostMk(S);
        try { if (decks[k].shim._p && decks[k].shim._ready) decks[k].shim._p.setVolume(Math.round(Math.min(1, Math.max(0, lvl * b)) * 100)); } catch (_) {}
        decks[k].level = lvl;
      } else decks[k].apply(lvl);
    }
    return duck;
  }
  return {
    graph, decks, levels,
    applyFx(bpm) { graph.applyFx(getS().fx, bpm); },
    applyDeckFx() { const S = getS(); for (const k of DECKS) decks[k].applyDeckFx(S[k]); },
    setMixVol(v) { mixVol = v; },
    setVoicePlaying(v) { voicePlaying = !!v; },
    setMicHot(v) { micHot = v; },
    duckDrop() { dropDuckUntil = Date.now() + 4000; },
    wake() { graph.wake(); },
    get PAIR() { return PAIR; },
  };
}
