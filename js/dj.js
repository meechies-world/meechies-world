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
  const DB = () => (typeof db !== "undefined" ? db : null);
  const OWNER = () => (typeof isOwner !== "undefined" && isOwner);
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
  let echoDly = null, flaLfo = null;
  function actx() {
    if (!ctx) {
      try { ctx = new (window.AudioContext || window.webkitAudioContext)(); } catch (_) { ctx = null; }
      if (ctx) {
        masterIn = ctx.createGain();
        fxFilter = ctx.createBiquadFilter(); fxFilter.type = "lowpass"; fxFilter.frequency.value = 18000; fxFilter.Q.value = 0.4;
        masterGain = ctx.createGain(); masterGain.gain.value = 0.95;
        limiter = ctx.createDynamicsCompressor(); limiter.threshold.value = -3; limiter.knee.value = 0; limiter.ratio.value = 20; limiter.attack.value = 0.002; limiter.release.value = 0.18;
        analyser = ctx.createAnalyser(); analyser.fftSize = 256;
        // transformer/gate chopper sits in the master path (depth 0 = open)
        gateGain = ctx.createGain(); gateGain.gain.value = 1;
        crushNode = ctx.createWaveShaper(); crushNode.oversample = "2x";
        masterIn.connect(gateGain); gateGain.connect(crushNode); crushNode.connect(fxFilter); fxFilter.connect(masterGain); masterGain.connect(limiter); limiter.connect(analyser); analyser.connect(ctx.destination);
        gateOsc = ctx.createOscillator(); gateOsc.type = "square"; gateOsc.frequency.value = 4;
        const gateShaper = ctx.createWaveShaper(); gateShaper.curve = new Float32Array([-1, 1]);
        gateDepth = ctx.createGain(); gateDepth.gain.value = 0;
        gateOsc.connect(gateShaper); gateShaper.connect(gateDepth); gateDepth.connect(gateGain.gain); gateOsc.start();
        // echo send (feedback exposed as Echo Repeat)
        const dly = ctx.createDelay(1); dly.delayTime.value = 0.28; echoDly = dly; echoFb = ctx.createGain(); echoFb.gain.value = 0.34;
        const dw = ctx.createGain(); dw.gain.value = 0; dly.connect(echoFb); echoFb.connect(dly); dly.connect(dw); dw.connect(masterGain);
        masterIn.connect(dly); echoWet = dw;
        // flanger send: short modulated delay with feedback
        const fd = ctx.createDelay(0.05); fd.delayTime.value = 0.004;
        const ffb = ctx.createGain(); ffb.gain.value = 0.45;
        const fw = ctx.createGain(); fw.gain.value = 0;
        const lfo = ctx.createOscillator(); lfo.frequency.value = 0.3; flaLfo = lfo; const lfoG = ctx.createGain(); lfoG.gain.value = 0.0016;
        lfo.connect(lfoG); lfoG.connect(fd.delayTime); lfo.start();
        fd.connect(ffb); ffb.connect(fd); fd.connect(fw); fw.connect(masterGain); masterIn.connect(fd); flaWet = fw;
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
  function impulse(dur, decay) {
    const rate = ctx.sampleRate, len = rate * dur, buf = ctx.createBuffer(2, len, rate);
    for (let ch = 0; ch < 2; ch++) { const d = buf.getChannelData(ch); for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, decay); }
    return buf;
  }

  /* ---------- a deck: one audio element with its own EQ + gain ---------- */
  function Deck() {
    const d = { el: new Audio(), gain: null, eq: null, flt: null, stem: null, src: "", level: 1, cors: true, peaks: null, rate: 1, vinyl: false, cues: [null, null, null], loop: null, loopBeats: 0 };
    d.el.preload = "auto"; d.el.playsInline = true; d.el.crossOrigin = "anonymous";
    d.set = (src) => new Promise((res) => {
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
    d.apply = () => { if (d.gain) { d.gain.gain.value = d.level; d.el.volume = 1; } else d.el.volume = d.level; };
    d.stop = () => { try { d.el.pause(); } catch (_) {} };
    return d;
  }
  const xfGain = (xf, side) => Math.cos((side === "A" ? xf : 1 - xf) * Math.PI / 2); // equal-power crossfade

  /* ---------- shared station state (doc radio/dj) ---------- */
  const blank = () => ({ src: "", title: "", cover: "", start: 0, pos: 0, playing: false, vol: 0.9, rate: 1, dur: 0 });
  const defFx = () => ({ mf: 100, echo: 0, fb: 0.34, verb: 0, fla: 0, gate: 0, crush: 0, sync: true, boost: 1 });
  let S = { live: false, xf: 0.5, xf2: 0.5, panY: 0, duck: false, quant: true, A: blank(), B: blank(), C: blank(), D: blank(), voice: null, updatedAt: 0, liveSince: 0, ticker: "", log: [], show: null, pads: [], autodj: true, fx: defFx() };
  const posOf = (k) => { const s = S[k]; return s.playing ? Math.max(0, (Date.now() - s.start) / 1000) : (s.pos || 0); };
  let saveT = null;
  function save(now) { if (!OWNER()) return; clearTimeout(saveT); const run = () => { S.updatedAt = Date.now(); S.boothAt = Date.now(); S.by = tabId; DB()?.doc("radio/dj").set(JSON.parse(JSON.stringify(S))).catch((e) => say(e.message || e.code)); }; if (now) run(); else saveT = setTimeout(run, 250); }
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
.station{margin-top:20px;border:1px solid var(--gold-lo);border-radius:16px;padding:16px;background:#0d0b08;display:grid;gap:12px}
.station h3{margin:0;font-size:20px}
.ticker{overflow:hidden;white-space:nowrap;border:1px solid #e5484d;border-radius:10px;padding:8px 0;background:#1c0b0c;color:#ffb3b6;font-weight:700}
.ticker span{display:inline-block;padding-left:100%;animation:djtick 18s linear infinite}
@keyframes djtick{to{transform:translateX(-100%)}}
.rec-on{color:#ff8b8f;font-weight:800}
#fb-left,#fb-right{transition:transform .35s ease,opacity .35s ease}
body.dj-past #fb-left,body.dj-on #fb-left{transform:translateX(-110%);opacity:0;pointer-events:none}
body.dj-past #fb-right,body.dj-on #fb-right{transform:translateX(110%);opacity:0;pointer-events:none}
body.dj-past #ai-fab,body.dj-past #mx-heads,body.dj-on #ai-fab,body.dj-on #mx-heads{opacity:0!important;pointer-events:none!important;transform:scale(.5)}
#ai-fab,#mx-heads{transition:opacity .3s ease,transform .3s ease}
.swapbar{display:none}
@media (max-width:760px){
.dj-decks{display:grid;grid-template-columns:1fr 1fr;gap:8px}
.dj-decks>.deck[data-deck="C"],.dj-decks>.deck[data-deck="D"],.dj-decks>.mixer.m2{display:none!important}
.dj-decks[data-show="C"]>.deck[data-deck="C"],.dj-decks[data-show="D"]>.deck[data-deck="D"],.dj-decks[data-show="M"]>.mixer.m2{display:grid!important}
.dj-decks>.deck[data-deck="A"]{grid-column:1;grid-row:1}
.dj-decks>.deck[data-deck="B"]{grid-column:2;grid-row:1}
.dj-decks>.mixer.m1{grid-column:1/-1;grid-row:2}
.dj-decks>.swapbar{grid-column:1/-1;grid-row:3}
.dj-decks>.deck[data-deck="C"],.dj-decks>.deck[data-deck="D"],.dj-decks>.mixer.m2{grid-column:1/-1;grid-row:4}
.dj-decks>.deck[data-deck="A"],.dj-decks>.deck[data-deck="B"]{padding:8px;gap:5px}
#dj-owner .dj-decks>.deck[data-deck="A"] .platter,#dj-owner .dj-decks>.deck[data-deck="B"] .platter{width:84px}
.dj-decks>.deck[data-deck="A"] .wave,.dj-decks>.deck[data-deck="B"] .wave{height:44px}
.dj-decks>.deck[data-deck="A"] .btn,.dj-decks>.deck[data-deck="B"] .btn{padding:6px 8px;font-size:12px}
.dj-decks>.deck[data-deck="A"] .ttl,.dj-decks>.deck[data-deck="B"] .ttl{font-size:12px}
body.dj-on #dj-booth-root{padding-bottom:70px}
.swapbar{display:flex;gap:6px;margin:0 0 8px;position:sticky;top:0;z-index:4;background:#0d0b08;padding:4px 0}
.swapbar .btn{flex:1;min-height:44px}
.swapbar .btn.on{background:var(--gold);color:#191104;border-color:var(--gold)}
.swapbar .btn.hot{box-shadow:inset 0 0 0 2px #45bd62}
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
html.popdj header.bar,html.popdj #player-bar,html.popdj footer,html.popdj #fb-left,html.popdj #fb-right,html.popdj #ai-fab,html.popdj #mx-heads{display:none!important}
html.popdj main{margin:0!important;padding:10px!important}
html.popdj #v-radio .wrap{max-width:none!important;width:100%!important}
html.popdj #v-radio .wrap>*:not(#dj-booth-root){display:none!important}
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
.xfpad{position:relative;width:150px;height:150px;border-radius:50%;border:2px solid var(--gold-lo);background:radial-gradient(circle,#1a1409 0 55%,#0d0b08 75%);touch-action:none;cursor:grab;margin:2px auto}
.xfpad::before{content:"";position:absolute;inset:16px;border-radius:50%;border:1px dashed #3a2f16}
.xfpad::after{content:"";position:absolute;left:50%;top:6px;bottom:6px;width:1px;background:#2c2413}
.xfdot{position:absolute;width:26px;height:26px;border-radius:50%;background:radial-gradient(circle at 35% 30%,#ffe9a8,var(--gold));border:2px solid #0d0b08;box-shadow:0 2px 10px rgba(0,0,0,.65);transform:translate(-50%,-50%);pointer-events:none;left:50%;top:50%}
.xfpl{position:absolute;top:50%;transform:translateY(-50%);font:800 12px var(--body);color:var(--gold-hi)}
.xfpl.a{left:8px}.xfpl.b{right:8px}
.deck .wave{cursor:pointer;touch-action:none}
.xfpad.big{width:172px;height:172px}
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
@media(min-width:761px){#dj-owner .deck{gap:6px;padding:10px}#dj-owner .deck .platter{width:172px}#dj-owner .deck .wave{height:58px}#dj-owner .deck .btn{padding:6px 9px;font-size:12.5px;min-height:34px}#dj-owner .deck .row{gap:5px}#dj-owner .deck .eqrow{gap:4px}#dj-owner .deck h4{margin:0;font-size:13px}#dj-owner .mixer{gap:6px;padding:10px}#dj-owner .xfpad.big{width:150px;height:150px}}
/* three-zone console on wide screens (Malik: "deck A and B on one side, C and D on
   the other, the mixer and song pick in the middle"): the deck bank unwraps so its
   pieces place straight into the booth grid — A/B left, C/D right, and the middle
   column stacks main mixer, SONG PICKER, C/D mixer. Pick and load without scrolling. */
@media(min-width:1500px){#dj-owner{display:grid;grid-template-columns:1fr 1fr 500px 1fr 1fr;gap:14px;align-items:start}#dj-owner>.dj-top{grid-column:1/-1}#dj-owner>.dj-setups{grid-column:1/-1;margin-bottom:0}#dj-owner>.dj-decks{display:contents}#dj-owner .deck[data-deck="A"]{grid-column:1;grid-row:3/span 3}#dj-owner .deck[data-deck="B"]{grid-column:2;grid-row:3/span 3}#dj-owner .deck[data-deck="C"]{grid-column:4;grid-row:3/span 3}#dj-owner .deck[data-deck="D"]{grid-column:5;grid-row:3/span 3}#dj-owner .mixer.m1{grid-column:3;grid-row:3}#dj-owner #dj-browser{grid-column:3;grid-row:4;margin-top:0!important}#dj-owner .mixer.m2{grid-column:3;grid-row:5}#dj-owner>.dj-grid2{grid-column:1/-1}#dj-owner .swapbar{display:none}}
html.popdj .popdj-hint{display:block}`;
  document.head.appendChild(css);

  const deckHTML = (k) => `<div class="deck" data-deck="${k}"><h4>DECK ${k}</h4><div class="platter" id="pl-${k}" title="Drag to scratch / scrub"></div>
    <canvas class="wave" id="wv-${k}" width="520" height="84"></canvas>
    <div class="ttl" id="ttl-${k}">Load a song</div><div class="tm" id="tm-${k}">0:00</div>
    <div class="beatbox"><span class="bpmv" id="bpm-${k}">BPM —</span><span class="keyv" id="key-${k}"></span><span class="bdots" id="dots-${k}"><i></i><i></i><i></i><i></i></span></div>
    <div class="row"><button class="btn ghost sm" type="button" data-tap="${k}">👆 TAP</button><button class="btn ghost sm" type="button" data-bpmadj="${k}:-0.1">BPM −</button><button class="btn ghost sm" type="button" data-bpmadj="${k}:0.1">BPM +</button><button class="btn ghost sm" type="button" data-bpmx="${k}:2">×2</button><button class="btn ghost sm" type="button" data-bpmx="${k}:0.5">÷2</button><button class="btn ghost sm" type="button" data-nudge="${k}:-1">◀ grid</button><button class="btn ghost sm" type="button" data-nudge="${k}:1">grid ▶</button></div>
    <div class="row"><button class="btn sm" type="button" data-play="${k}">▶ Play</button><button class="btn ghost sm" type="button" data-cue0="${k}">⏮ Cue</button><button class="btn ghost sm" type="button" data-brake="${k}">🛑 Brake</button></div>
    <div class="row">${[1, 2, 3].map((n) => `<button class="btn ghost sm cuebtn" type="button" data-hot="${k}:${n}">CUE ${n}</button>`).join("")}</div>
    <div class="row"><button class="btn ghost sm loopbtn" type="button" data-loopb="${k}:4">Loop 4 beats</button><button class="btn ghost sm loopbtn" type="button" data-loopb="${k}:8">Loop 8 beats</button><button class="btn ghost sm" type="button" data-sync="${k}">SYNC</button></div>
    <div class="row"><button class="btn ghost sm" type="button" data-bjump="${k}:-4">⏪ 4 beats</button><button class="btn ghost sm" type="button" data-bjump="${k}:4">4 beats ⏩</button><button class="btn ghost sm cutbtn" type="button" data-vcut="${k}">🎤 Vocal cut</button><button class="btn ghost sm cutbtn" type="button" data-bcut="${k}">🔊 Bass cut</button></div>
    <label class="lab">Pitch <span id="pit-v-${k}">+0.0%</span><input type="range" min="0.92" max="1.08" step="0.001" value="1" data-pitch="${k}" aria-label="Deck ${k} pitch"></label>
    <label class="lab" style="display:flex;align-items:center;gap:8px"><input type="checkbox" data-vinyl="${k}" style="width:auto"> Vinyl mode (pitch bends like a record)</label>
    <div class="eqrow"><label>LOW<input type="range" min="-24" max="24" step="1" value="0" data-eq="${k}:lo"></label><label>MID<input type="range" min="-24" max="24" step="1" value="0" data-eq="${k}:mid"></label><label>HIGH<input type="range" min="-24" max="24" step="1" value="0" data-eq="${k}:hi"></label></div>
    <label class="lab">Filter (left = deep ↔ right = thin)<input type="range" min="0" max="100" step="1" value="50" data-flt="${k}" aria-label="Deck ${k} filter"></label>
    <label class="lab">Volume<input type="range" min="0" max="1" step="0.01" value="0.9" data-vol="${k}" aria-label="Deck ${k} volume"></label></div>`;

  root.innerHTML = `
<div class="dj-banner" id="dj-banner" hidden><span><b>● LIVE DJ SET</b> &nbsp;Meechie is on the decks right now</span><button class="btn sm" type="button" id="dj-listen">🎧 Listen live</button></div>
<div class="station" id="dj-station" hidden>
  <div style="display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap"><h3>📻 Meechie's World Radio</h3><span class="onair-lamp" id="st-lamp"><span class="dot"></span>OFF AIR</span></div>
  <div class="ticker" id="st-ticker" hidden><span id="st-ticker-t"></span></div>
  <div id="st-now" class="muted" style="font-size:14px">The station is on the playlist right now.</div>
  <div id="st-online" class="muted" style="font-size:13px"></div>
  <div id="st-show"></div>
  <div><b style="font-size:13px;letter-spacing:.1em">RECENTLY PLAYED</b><div class="loglist" id="st-log" style="margin-top:6px"></div></div>
  <div class="dj-panel" style="margin:0"><h4>REQUEST A SONG / SEND A DROP</h4>
    <form class="dj-search" id="rq-form"><input type="text" id="rq-text" maxlength="120" placeholder="Song request or shout-out..." aria-label="Song request"><button class="btn sm" type="submit">Send</button></form>
    <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap"><button class="btn ghost sm" type="button" id="rq-rec">🎙️ Record a voice drop</button><small class="muted" id="rq-rec-st">Up to 20 seconds. Meechie can play it on air.</small></div>
    <div style="margin-top:14px;border-top:1px solid var(--line);padding-top:12px"><b style="font-size:13px;letter-spacing:.1em">🎵 PICK A SONG FOR THE RADIO</b><small class="muted" style="display:block;margin:4px 0 8px">Pick a song and it plays next on the live radio — Meechie's songs mixed with real artists, every genre. The list is long: browse the shelves, tap a genre, or search any artist.</small><div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:8px"><button class="btn sm pktab" type="button" id="pk-mine">🔥 Meechie's songs</button><button class="btn ghost sm pktab" type="button" id="pk-real">🎤 Real artists</button></div><form class="dj-search" id="pk-form" style="margin-bottom:8px"><input type="search" id="pk-q" placeholder="Search any artist or song..." aria-label="Search music to pick"><button class="btn sm" type="submit">Search</button></form><div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:8px"><button class="btn ghost sm" type="button" data-pkgenre="hiphop">🕶️ Hip-Hop</button><button class="btn ghost sm" type="button" data-pkgenre="jazz">🎷 Jazz</button><button class="btn ghost sm" type="button" data-pkgenre="rock">🎸 Rock</button><button class="btn ghost sm" type="button" data-pkgenre="soul">❤️ Soul &amp; R&amp;B</button><button class="btn ghost sm" type="button" data-pkgenre="reggae">🇯🇲 Reggae</button><button class="btn ghost sm" type="button" data-pkgenre="classics">🎺 Classics</button><button class="btn ghost sm" type="button" data-pkgenre="more">🌍 More artists</button></div><div class="dj-list" id="pk-list" style="max-height:300px"></div><b style="font-size:12px;letter-spacing:.1em;display:block;margin-top:12px">📻 COMING UP — LISTENER PICKS</b><div class="dj-list" id="pk-queue" style="margin-top:6px;max-height:110px"><small class="muted">No picks yet — be the first.</small></div></div>
  </div>
</div>
<div class="dj" id="dj-owner" hidden>
  <div class="dj-top"><div><p class="eyebrow" style="margin:0">Owner only · the station board</p><h3>🎛️ DJ Station</h3></div>
    <span class="onair-lamp" id="dj-lamp"><span class="dot"></span>OFF AIR</span>
    <span class="dj-clock" id="dj-lead"></span><span class="dj-clock" id="dj-online"></span><span class="dj-clock" id="dj-clock"></span><span class="dj-clock" id="dj-showtime"></span>
    <label class="dj-live"><input type="checkbox" id="dj-golive"> Go live (everyone hears your mix)</label></div>
  <div class="dj-setups" style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:12px"><span style="font:700 11px var(--body);color:var(--muted);letter-spacing:.12em;align-self:center">SETUPS:</span><button class="btn ghost sm" type="button" data-preset="radio">🏆 Pro Radio</button><button class="btn ghost sm" type="button" data-preset="club">🔥 Club</button><button class="btn ghost sm" type="button" data-preset="scratch">🎺 Scratch Session</button><button class="btn ghost sm" type="button" data-preset="chop">⚡ Transformer</button><button class="btn ghost sm" type="button" data-pop>⛶ Pop out — own screen</button></div>
  <div class="dj-decks" data-show="C">
    ${deckHTML("A")}
    ${deckHTML("B")}
    <div class="mixer m1"><small>MIC DROP</small>
      <button class="talk" type="button" id="dj-talk" aria-label="Hold to talk">🎙️<br>HOLD TO TALK</button>
      <small id="dj-talk-st">Hold, talk, let go — it goes out over the music</small>
      <div class="xfpad big" id="dj-xfpad" title="One dot runs all four decks — drag it toward a deck and that deck takes over"><span class="xfpl tl">A</span><span class="xfpl tr">B</span><span class="xfpl bl">C</span><span class="xfpl br">D</span><div class="xfdot" id="dj-xfdot"></div></div>
      
      <small>BEAT ENGINE</small>
      <label style="display:flex;gap:6px;align-items:center;font-size:12px;color:var(--muted);text-align:left"><input type="checkbox" id="dj-quant" checked style="width:auto"> Quantize — cues &amp; loops snap to the beat</label>
      <label style="display:flex;gap:6px;align-items:center;font-size:12px;color:var(--muted);text-align:left"><input type="checkbox" id="dj-fxsync" checked style="width:auto"> Effects follow the live tempo</label>
      <canvas class="pairwave" id="pw-AB" width="480" height="72"></canvas>
      <small id="ph-AB" style="letter-spacing:0;text-transform:none">Phase meter: play both decks with a measured BPM and this shows how far apart the beats sit.</small>
      <small>MASTER</small><input type="range" min="0" max="1" step="0.01" value="0.95" id="dj-master" aria-label="Master volume">
      <small>🔊 BOOST — EVERYONE HEARS IT · <span id="dj-boost-v">100%</span></small><input type="range" min="1" max="2" step="0.01" value="1" id="dj-boost" aria-label="Volume boost">
      <small>FILTER</small><input type="range" min="0" max="100" step="1" value="100" id="dj-filter" aria-label="Master filter">
      <small>ECHO</small><input type="range" min="0" max="0.6" step="0.02" value="0" id="dj-echo" aria-label="Echo level">
      <small>ECHO REPEAT</small><input type="range" min="0" max="0.7" step="0.02" value="0.34" id="dj-fb" aria-label="Echo repeat">
      <small>REVERB</small><input type="range" min="0" max="0.7" step="0.02" value="0" id="dj-verb" aria-label="Reverb level">
      <small>FLANGER</small><input type="range" min="0" max="1" step="0.02" value="0" id="dj-fla" aria-label="Flanger level">
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
    <div style="display:flex;gap:6px;flex-wrap:wrap;align-items:center"><h4 style="margin:0 6px 0 0">🎵 MUSIC — PICK &amp; LOAD, NO SCROLLING</h4>
      <button class="btn sm browtab on" type="button" data-brow="lib">Your Library</button>
      <button class="btn ghost sm browtab" type="button" data-brow="net">Free Music Search</button>
      <button class="btn ghost sm browtab" type="button" data-brow="cur">🏆 Pro DJ Sounds</button></div>
    <div data-browpane="lib"><div class="dj-list" id="dj-lib" style="max-height:300px"></div></div>
    <div data-browpane="net" hidden><form class="dj-search" id="dj-sf"><input type="search" id="dj-q" placeholder="Search: hip hop, jazz, beats..." aria-label="Search free music"><button class="btn sm" type="submit">Search</button></form>
      <small class="muted">Creative Commons music from the Internet Archive, free to play on your station.</small><div class="dj-list" id="dj-net" style="max-height:260px"></div></div>
    <div data-browpane="cur" hidden><small class="muted">Hand-picked DJ sounds from the most-downloaded free packs on the Internet Archive, every one verified playable. ▶ hears it in the booth; a deck letter loads it on that table so it goes out over the radio.</small><div class="dj-list" id="dj-cur" style="max-height:300px"></div></div>
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
      <div id="rec-out"></div></div>
    <div class="dj-panel"><h4>🤖 AUTO-DJ</h4>
      <label style="display:flex;gap:8px;align-items:center;font-size:14px"><input type="checkbox" id="ad-on" style="width:auto" checked> Auto-DJ runs the station: when a song ends, crossfade to the next one — your queue first, then the full library on rotation</label>
      <div class="dj-list" id="ad-queue" style="max-height:150px"></div>
      <small class="muted">Add songs with the ＋Q button in Your Library. Works while you're live — the station never goes quiet.</small></div>
    <div class="dj-panel"><h4>📥 REQUESTS &amp; DROPS</h4><div class="dj-list" id="rq-list" style="max-height:220px"><small class="muted">Nothing yet. Listener requests land here.</small></div></div>
    <div class="dj-panel"><h4>📜 PROGRAM LOG</h4><div class="loglist" id="dj-log"></div>
      <label style="display:grid;gap:4px;font-size:12px;color:var(--muted)">Station ticker (shows on the station card for everyone)<input type="text" id="dj-ticker-in" maxlength="140" placeholder="e.g. Taking requests all night — drop yours below!"></label>
      <button class="btn ghost sm" type="button" id="dj-ticker-set" style="justify-self:start">Set ticker</button></div>
  </div>
</div>`;
  // the booth moves into its own DJ view — its own section, nothing but DJing
  const boothEl = document.getElementById("dj-owner"), boothHome = document.getElementById("dj-booth-root");
  if (boothEl && boothHome) boothHome.appendChild(boothEl);
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
  document.addEventListener("click", (e) => { const bt = e.target.closest && e.target.closest("[data-brow]"); if (!bt) return; document.querySelectorAll("[data-brow]").forEach((x) => { const on = x === bt; x.classList.toggle("on", on); x.classList.toggle("ghost", !on); }); document.querySelectorAll("[data-browpane]").forEach((p) => { p.hidden = p.dataset.browpane !== bt.dataset.brow; }); });
  const $ = (s) => document.querySelector(s);
  const decks = { A: null, B: null, C: null, D: null };
  const DECKS = ["A", "B", "C", "D"]; const PAIR = { A: "B", B: "A", C: "D", D: "C" };
  const deck = (k) => decks[k] || (decks[k] = Deck());
  const fmt = (s) => { s = Math.max(0, Math.floor(s || 0)); return Math.floor(s / 60) + ":" + String(s % 60).padStart(2, "0"); };
  const agoT = (at) => new Date(at).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: "America/New_York" });

  /* ---------- levels, following the shared state, listener side ---------- */
  let listening = false, voiceEl = null, heardVoice = "", micHot = 0, mixVol = 1;
  function levels() {
    const duck = (S.duck || (voiceEl && !voiceEl.paused) || micHot > 0.04) ? 0.28 : 1;
    const mix = listening && !OWNER() ? mixVol : 1;
    DECKS.forEach((k) => { if (decks[k]) { const cd = k === "C" || k === "D", x = cd ? (S.xf2 ?? 0.5) : S.xf, side = k === "B" || k === "D" ? "B" : "A", py = S.panY || 0, pairG = cd ? (py < 0 ? 1 + py : 1) : (py > 0 ? 1 - py : 1); decks[k].vol((S[k].vol ?? 0.9) * xfGain(x, side) * pairG * duck * mix); } });
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
    if (verbWet) verbWet.gain.value = f.verb || 0;
    if (flaWet) flaWet.gain.value = (f.fla || 0) * 0.8;
    
    if (gateOsc && gateDepth && gateGain) {
      const g = +f.gate || 0;
      if (g > 0) { gateOsc.frequency.value = g; gateDepth.gain.value = 0.5; gateGain.gain.value = 0.5; }
      else { gateDepth.gain.value = 0; gateGain.gain.value = 1; }
    }
    // stem cuts ride the broadcast too: what the booth cuts is what listeners lose
    DECKS.forEach((k) => { const d = decks[k]; if (d && d.stem) { d.stem.nrm.gain.value = S[k].vcut ? 0 : 1; d.stem.oop.gain.value = S[k].vcut ? 1 : 0; d.stem.hp.frequency.value = S[k].bcut ? 160 : 10; } });
    // beat-synced FX: echo, flanger and the chopper follow the tempo of what's playing
    if (f.sync !== false) { const rb = refBpm(); if (rb > 0) { const bl = 60 / rb; if (echoDly) echoDly.delayTime.value = bl * 0.75; if (flaLfo) flaLfo.frequency.value = 1 / (bl * 2); if (gateOsc && (+f.gate || 0) > 0) gateOsc.frequency.value = (+f.gate / 2) * (rb / 60); } }
  }
  async function follow(k) {
    const s = S[k], d = deck(k);
    if (!okUrl(s.src) || DEAD(s.src)) { d.stop(); return; }
    // cues and loops live in the shared state too, so a cue set or a loop armed in the
    // pop-out exists on the window playing the sound (and the other way round)
    if (OWNER()) { if (Array.isArray(s.cues)) { d.cues = s.cues.slice(0, 3); while (d.cues.length < 3) d.cues.push(null); } if (s.loop) { d.loop = s.loop; d.loopBeats = s.loopBeats || 0; } else if (s.loop === null) { d.loop = null; d.loopBeats = 0; } paintCues(k); }
    await d.set(s.src);
    d.el.playbackRate = s.rate || 1;
    const want = posOf(k);
    if (s.playing) {
      if (d.el.duration && want >= d.el.duration - 0.3) { d.el.pause(); levels(); return; }
      if (!d.el.seeking && d.el.readyState >= 3 && Math.abs(d.el.currentTime - want) > 4) { try { d.el.currentTime = want; } catch (_) {} }
      if (d.el.paused) d.el.play().catch(() => {});
    }
    else { d.el.pause(); if (Math.abs(d.el.currentTime - want) > 0.5) { try { d.el.currentTime = want; } catch (_) {} } }
    applyFx(); levels();
    if (OWNER() && !(S[k].bpm > 0)) analyze(k);
  }
  function playVoice() {
    const v = S.voice; if (!v || !okUrl(v.url) || DEAD(v.url) || heardVoice === v.id || Date.now() - (v.at || 0) > 90000) return;
    heardVoice = v.id; if (!listening) return;
    voiceEl = new Audio(v.url); voiceEl.playsInline = true; levels();
    voiceEl.addEventListener("ended", levels); voiceEl.addEventListener("error", levels); voiceEl.play().catch(levels);
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
    if (persist) { save(); const src = deck(k).src || S[k].src; const t = TRACKS().find((x) => URLOF(x) === src); if (t && t.id && !t.bpm) { t.bpm = S[k].bpm; t.key = S[k].key; t.cam = S[k].cam; try { DB()?.collection("tracks").doc(t.id).update({ bpm: S[k].bpm, key: S[k].key, cam: S[k].cam }).catch(() => {}); } catch (_) {} } }
  }
  function paintBeat(k) {
    const s = S[k]; if (!s) return;
    const b = $("#bpm-" + k); if (b && !anaBusy.has(deck(k).src || "")) b.textContent = s.bpm > 0 ? s.bpm.toFixed(1) + " BPM" : "BPM —";
    const kv = $("#key-" + k); if (kv) { kv.textContent = s.cam ? s.cam + (s.key ? " · " + s.key : "") : ""; const o = S[PAIR[k]]; kv.classList.toggle("compat", !!(s.cam && o && o.cam && keyCompat(s.cam, o.cam))); }
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

  function paintOwner() {
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
    const fsx = $("#dj-fxsync"); if (fsx && document.activeElement !== fsx) fsx.checked = (S.fx && S.fx.sync) !== false;
    const cr = $("#dj-crush"); if (cr && document.activeElement !== cr) cr.value = (S.fx && S.fx.crush) || 0; $("#dj-golive").checked = !!S.live;
    [["dj-filter", S.fx && S.fx.mf], ["dj-echo", S.fx && S.fx.echo], ["dj-fb", S.fx && S.fx.fb], ["dj-verb", S.fx && S.fx.verb], ["dj-fla", S.fx && S.fx.fla]].forEach(([id, v]) => { const el = document.getElementById(id); if (el && document.activeElement !== el && v != null) el.value = v; });
    const ad = $("#ad-on"); if (ad) ad.checked = !!S.autodj;
    const lamp = $("#dj-lamp"); lamp.classList.toggle("on", !!S.live); lamp.lastChild.textContent = S.live ? "ON AIR" : "OFF AIR";
    renderLog($("#dj-log")); paintPads();
  }
  function renderLog(box) {
    if (!box) return;
    box.innerHTML = (S.log || []).length ? S.log.map((x) => `<div><span>${E(x.t)}${x.live ? ' <small style="color:#ff8b8f">● LIVE</small>' : ""}</span><time>${agoT(x.at)}</time></div>`).join("") : '<small class="muted">Nothing played yet this session.</small>';
  }
  function paintStation() {
    const live = isLive();
    const lamp = $("#st-lamp"); lamp.classList.toggle("on", live); lamp.lastChild.textContent = live ? "ON AIR" : "OFF AIR";
    const tk = $("#st-ticker"); tk.hidden = !S.ticker; if (S.ticker) $("#st-ticker-t").textContent = S.ticker;
    const now = live ? DECKS.filter((k) => S[k].playing && !(S[k].dur && S[k].start && Date.now() - S[k].start > (S[k].dur + 45) * 1000)).map((k) => S[k].title).filter(Boolean) : [];
    const boothLive = S.boothAt && Date.now() - S.boothAt < 45000;
    $("#st-now").textContent = live ? (now.length ? (boothLive ? "🎧 Live now: " : S.autodj ? "🤖 Auto-DJ live: " : "🎧 Live now: ") + now.join("  ×  ") : "🎧 Meechie is live on the decks.") : "The station is on the playlist right now. When Meechie goes live on the decks, it shows up here.";
    $("#st-show").innerHTML = S.show && okUrl(S.show.url) && !DEAD(S.show.url) ? `<b style="font-size:13px;letter-spacing:.1em">🎙️ LATEST RECORDED SHOW</b><audio controls preload="none" src="${E(S.show.url)}" style="width:100%;margin-top:6px"></audio><small class="muted">Recorded ${new Date(S.show.at).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: "America/New_York" })}</small>` : "";
    renderLog($("#st-log"));
  }
  setInterval(() => {
    const oe = document.getElementById("dj-owner"); if (oe && oe.hidden && OWNER()) show();
    if (pkTab === "mine" && !pkItems.length && TRACKS().length) paintPkList();
    DECKS.forEach((k) => {
      const el = $("#tm-" + k); if (el && decks[k]) el.textContent = fmt(decks[k].el.currentTime) + (decks[k].el.duration ? " / " + fmt(decks[k].el.duration) : "");
      // watchdog: an element that reached the end without firing 'ended' still hands over
      if (OWNER() && boothLead && S.live && S[k].playing && decks[k] && decks[k].el.ended) deckEnded(k);
      const d = decks[k]; if (d && d.loop && !d.el.paused && d.el.currentTime >= d.loop[1]) { try { d.el.currentTime = d.loop[0]; } catch (_) {} if (OWNER() && S[k].playing) { S[k].start = Date.now() - d.loop[0] * 1000; } }
      if (OWNER() && decks[k] && S[k].playing) peaks(k);
    });
    document.querySelectorAll("[data-swap]").forEach((b) => { const v = b.dataset.swap.split(":")[1]; b.classList.toggle("hot", !!S[v] && !!S[v].playing); });
    if (listening) DECKS.forEach((k) => follow(k));
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
  function paintOnline(o, l) {
    const chip = document.getElementById("online-chip"); if (chip) { chip.hidden = false; const nb = document.getElementById("online-n"); if (nb) nb.textContent = o; }
    const b = document.getElementById("dj-online"); if (b) b.textContent = "👥 " + o + " online · 🎧 " + l + " on the decks";
    const o2 = document.getElementById("dj-online2"); if (o2) o2.textContent = "🟢 " + o + " online · 🎧 " + l;
    const s = document.getElementById("st-online"); if (s) s.textContent = l > 0 ? "🎧 " + l + " listening on the decks right now · " + o + " on the site" : o + " on the site right now";
  }
  const pingKeeper = () => fetch("/api/station?cid=" + encodeURIComponent(myCid) + "&l=" + (listening && !OWNER() ? 1 : 0), { cache: "no-store" }).then((r) => r.json()).then((j) => { if (j && j.online != null) paintOnline(j.online, j.listening || 0); }).catch(() => {});
  pingKeeper(); setInterval(pingKeeper, 12000);
  /* one booth plays the sound; the other is its remote. The main tab and the pop-out
   * are two full booths sharing one station — without a leader they would each play
   * their own copy and overwrite each other's saves. A localStorage lease picks the
   * leader: the first booth window actually showing the decks holds it; a mirror's
   * buttons write the shared state and the leader plays them. Close the leader and
   * the mirror takes over within seconds. */
  let boothLead = false;
  const leaseKey = "mw-booth-lease";
  function leaseBeat() {
    const boothOpen = OWNER() && !!document.getElementById("dj-owner")?.offsetParent;
    let L = null; try { L = JSON.parse(localStorage.getItem(leaseKey) || "null"); } catch (_) {}
    const now = Date.now();
    let mine = false;
    if (boothOpen) { mine = !L || L.id === tabId || now - (L.at || 0) > 7000; if (mine) { try { localStorage.setItem(leaseKey, JSON.stringify({ id: tabId, at: now })); } catch (_) {} } }
    const was = boothLead; boothLead = mine;
    const badge = document.getElementById("dj-lead");
    if (badge && OWNER()) badge.textContent = boothLead ? "🔊 This window is playing the sound" : "🪞 Mirror — the other window plays the sound, this one is the remote";
    if (boothLead && !was && OWNER()) DECKS.forEach((k) => { if (S[k] && S[k].playing) follow(k); });
    if (!boothLead && was) DECKS.forEach((k) => { try { decks[k]?.stop(); } catch (_) {} });
  }
  leaseBeat(); setInterval(leaseBeat, 3000);
  addEventListener("pagehide", () => { if (boothLead) { try { const L = JSON.parse(localStorage.getItem(leaseKey) || "null"); if (L && L.id === tabId) localStorage.removeItem(leaseKey); } catch (_) {} } });
  setInterval(() => { if (!OWNER() && S.live) { const l = isLive(); $("#dj-banner").hidden = !l; if (!l && listening) endSet(); } paintStation(); }, 30000);
  function startListening() {
    listening = true; actx();
    try { if (typeof media !== "undefined") media.pause(); if (typeof mode !== "undefined") mode = "dj"; } catch (_) {}
    $("#dj-listen").textContent = "⏹ Stop listening"; DECKS.forEach((k) => follow(k));
    try { if (typeof showBar === "function") showBar({ title: "LIVE DJ SET", artist: "Meechie", cover: "" }, "Live on the decks"); } catch (_) {}
    try { if ("mediaSession" in navigator) { navigator.mediaSession.playbackState = "playing"; navigator.mediaSession.metadata = new MediaMetadata({ title: "LIVE DJ SET", artist: "Meechie", album: "Meechie's World Radio", artwork: [{ src: location.origin + "/img/icon-512.png", sizes: "512x512", type: "image/png" }] }); } } catch (_) {}
  }
  function stopListening() { listening = false; DECKS.forEach((k) => decks[k]?.stop()); voiceEl?.pause(); $("#dj-listen").textContent = "🎧 Listen live"; try { navigator.mediaSession.playbackState = "paused"; } catch (_) {} }
  let autoMoved = false;
  function endSet() { stopListening(); if (autoMoved) { autoMoved = false; try { if (typeof tuneIn === "function") tuneIn(); } catch (_) {} } }
  window.MW_DJ = { start: () => { if (isLive() || OWNER()) startListening(); else if (typeof tuneIn === "function") tuneIn(); }, stop: stopListening, toggle: () => { if (listening) stopListening(); else if (isLive() || OWNER()) startListening(); const ti = document.getElementById("tune-in"); if (ti) ti.textContent = listening ? "❚❚ Stop the radio" : "▶ Tune in"; }, listening: () => listening, setMixVol: (v) => { mixVol = Math.max(0, Math.min(1, +v || 0)); if (listening) levels(); } };
  window.MW_DJ_LIVE = () => isLive();
  // the top MWR card reads the tables: whatever is on the decks is what the station says is on air
  window.MW_AIRNOW = () => {
    if (!isLive()) return null;
    const fresh = S.boothAt && Date.now() - S.boothAt < 90000;
    const playing = DECKS.filter((k) => S[k].playing && S[k].title && !(S[k].dur && S[k].start && Date.now() - S[k].start > (S[k].dur + 45) * 1000));
    if (!playing.length) return { title: "Live on the decks", sub: fresh ? "🎧 Meechie's set is live — the tables are running the station" : "🤖 Auto-DJ is running the station from the tables", cover: "" };
    const d = S[playing[0]];
    const left = d.dur && d.start ? Math.max(0, Math.round(d.dur - (Date.now() - d.start) / 1000)) : 0;
    return { title: playing.length > 1 ? d.title + " × " + S[playing[1]].title : d.title, sub: (fresh ? "🎧 Live now" : "🤖 Auto-DJ live") + " · Meechie's World Radio" + (left ? " · " + fmt(left) + " left" : ""), cover: d.cover || "" };
  };
  /* pop the decks out onto their own screen: a clean window with only the DJ view */
  function popOut() {
    const url = location.pathname + "?popdj=1#radio";
    const w = window.open(url, "mw-dj-decks", "popup=yes,width=1440,height=920");
    if (w) { try { w.focus(); } catch (_) {} say("Decks popped out on their own screen ⛶"); }
    else { document.documentElement.classList.add("popdj"); try { go("dj"); } catch (_) {} say("Pop-ups are blocked here — decks went full-screen on this page instead. Allow pop-ups for a separate window."); }
  }
  if (/[?&]popdj=1/.test(location.search)) document.documentElement.classList.add("popdj");
  /* gentle mouse-wheel on the Radio page (desktop): the booth is a long page and stock
   * wheel notches jump it too far — ease wheel steps to about half speed. Trackpads
   * (small pixel deltas), pinch zoom, and the inner song lists keep their native feel. */
  let wheelTgt = null, wheelRaf = 0;
  const wheelStop = () => { if (wheelRaf) cancelAnimationFrame(wheelRaf); wheelRaf = 0; wheelTgt = null; };
  addEventListener("pointerdown", wheelStop, true);
  addEventListener("wheel", (e) => {
    if (!matchMedia("(pointer:fine)").matches || document.body.dataset.view !== "radio" || e.ctrlKey) return;
    let n = e.target;
    while (n && n !== document.body) { const st = getComputedStyle(n); if ((st.overflowY === "auto" || st.overflowY === "scroll") && n.scrollHeight > n.clientHeight + 1) { if ((e.deltaY > 0 && n.scrollTop + n.clientHeight < n.scrollHeight - 1) || (e.deltaY < 0 && n.scrollTop > 0)) { wheelStop(); return; } } n = n.parentElement; }
    if (e.deltaMode === 0 && Math.abs(e.deltaY) < 40) { wheelStop(); return; }
    const d = e.deltaMode === 1 ? e.deltaY * 33 : e.deltaMode === 2 ? e.deltaY * innerHeight : e.deltaY;
    e.preventDefault();
    const max = Math.max(0, document.documentElement.scrollHeight - innerHeight);
    wheelTgt = Math.max(0, Math.min(max, (wheelTgt ?? scrollY) + d * 0.45));
    if (!wheelRaf) { const step = () => { const cur = scrollY, diff = wheelTgt - cur; if (Math.abs(diff) < 0.6) { scrollTo(0, wheelTgt); wheelRaf = 0; wheelTgt = null; return; } scrollTo(0, cur + diff * 0.3); wheelRaf = requestAnimationFrame(step); }; wheelRaf = requestAnimationFrame(step); }
  }, { passive: false });
  document.addEventListener("click", (e) => { if (e.target.closest && e.target.closest("#dj-pop2")) { e.preventDefault(); popOut(); } });
  if (typeof media !== "undefined") media.addEventListener("play", () => {
    if (listening) { listening = false; DECKS.forEach((k) => decks[k]?.stop()); voiceEl?.pause(); $("#dj-listen").textContent = "🎧 Listen live"; return; }
    // The tables ARE the live radio while a set is live: any radio tune-in (player bar,
    // hero, lock-screen controls, radio-keep) hands over to the deck mix, not the playlist.
    if (!OWNER() && isLive() && typeof mode !== "undefined" && mode === "radio") { autoMoved = true; startListening(); }
  });
  $("#dj-listen").addEventListener("click", () => (listening ? stopListening() : isLive() || OWNER() ? startListening() : (typeof tuneIn === "function" && tuneIn())));

  let ownerLoaded = false;
  function mergeState(d) {
    const m = Object.assign({ live: false, xf: 0.5, xf2: 0.5, panY: 0, duck: false, quant: true, A: blank(), B: blank(), C: blank(), D: blank(), voice: null, liveSince: 0, ticker: "", log: [], show: null, pads: [], autodj: true, fx: defFx() }, d || {});
    m.fx = Object.assign(defFx(), m.fx || {});
    m.A = Object.assign(blank(), m.A || {}); m.B = Object.assign(blank(), m.B || {}); m.C = Object.assign(blank(), m.C || {}); m.D = Object.assign(blank(), m.D || {});
    return m;
  }
  function onState(d) {
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
    if (firstOwnerLoad) { show(); DECKS.forEach((k) => { if (S[k].playing && boothLead) follow(k); }); }
    playVoice(); paintStation();
    if (OWNER()) paintOwner();
  }

  /* ---------- owner: loading songs, transport, deck tools ---------- */
  function libList() {
    const list = TRACKS();
    $("#dj-lib").innerHTML = list.length ? list.map((t, i) => `<div class="dj-item"><span title="${E(t.title)}">${E(t.title)}</span><button class="btn ghost sm" type="button" data-load="A" data-lib="${i}">A</button><button class="btn ghost sm" type="button" data-load="B" data-lib="${i}">B</button><button class="btn ghost sm" type="button" data-load="C" data-lib="${i}">C</button><button class="btn ghost sm" type="button" data-load="D" data-lib="${i}">D</button><button class="btn ghost sm" type="button" data-queue="${i}">＋Q</button></div>`).join("") : '<small class="muted">No songs in your library yet.</small>';
  }
  let net = [];
  async function load(k, item) {
    const d = deck(k); actx();
    if (!boothLead) {
      // mirror window: put the song on the shared deck — the window playing the sound loads it for real
      S[k] = Object.assign(blank(), { src: item.src, title: item.title, cover: item.cover || "", vol: S[k].vol ?? 0.9, rate: S[k].rate || 1, dur: item.dur || 0, bpm: item.bpm || 0, beat0: 0, key: item.key || "", cam: item.cam || "", vcut: false, bcut: false, loop: null, loopBeats: 0 });
      d.cues = [null, null, null]; d.loop = null; d.loopBeats = 0; paintCues(k); paintOwner(); save();
      say("Loaded on deck " + k + " — the window playing the sound picked it up.");
      return;
    }
    S[k] = Object.assign(blank(), { src: item.src, title: item.title, cover: item.cover || "", vol: S[k].vol ?? 0.9, rate: S[k].rate || 1, dur: item.dur || 0, bpm: item.bpm || 0, beat0: 0, key: item.key || "", cam: item.cam || "", vcut: false, bcut: false, loop: null, loopBeats: 0 });
    d.cues = [null, null, null]; d.loop = null; d.loopBeats = 0; paintCues(k);
    paintOwner(); $("#ttl-" + k).textContent = "Loading " + item.title + "...";
    const ok = await d.set(item.src);
    if (!ok) { say("That song couldn't load. Try another one."); S[k] = blank(); paintOwner(); return; }
    d.el.currentTime = 0; d.el.playbackRate = S[k].rate || 1; paintOwner(); levels(); save(); analyze(k);
  }
  function paintCues(k) { document.querySelectorAll(`[data-hot^="${k}:"]`).forEach((b, i) => b.classList.toggle("on", deck(k).cues[i] != null)); document.querySelectorAll(`[data-loopb^="${k}:"]`).forEach((b) => b.classList.toggle("on", !!deck(k).loopBeats && +b.dataset.loopb.split(":")[1] === deck(k).loopBeats)); }
  async function togglePlay(k) {
    const s = S[k], d = deck(k); if (!okUrl(s.src)) { say("Load a song on deck " + k + " first."); return; }
    actx(); try { if (typeof media !== "undefined" && !media.paused) media.pause(); } catch (_) {}
    if (!boothLead) {
      // mirror window: flip the shared state only — the window holding the sound plays it
      if (s.playing) { s.pos = posOf(k); s.playing = false; }
      else { s.playing = true; s.start = Date.now() - (s.pos || 0) * 1000; logPlay(s.title); if (!S.live) { S.live = true; S.liveSince = Date.now(); const gl = $("#dj-golive"); if (gl) gl.checked = true; paintStation(); say("🔴 You're LIVE — the window playing the sound has the tables on the radio."); } }
      paintOwner(); save(true);
      return;
    }
    if (s.playing) { s.pos = d.el.currentTime; s.playing = false; d.el.pause(); }
    else {
      await d.set(s.src); try { d.el.currentTime = s.pos || 0; } catch (_) {}
      d.el.playbackRate = s.rate || 1; d.el.preservesPitch = !d.vinyl;
      await d.el.play().catch(() => {}); s.start = Date.now() - d.el.currentTime * 1000; s.playing = true;
      logPlay(s.title);
      // The tables ARE the radio: pressing play on a deck goes live, no separate switch.
      if (!S.live) { S.live = true; S.liveSince = Date.now(); const gl = $("#dj-golive"); if (gl) gl.checked = true; paintOwner(); paintStation(); say("🔴 You're LIVE — whatever you play on the tables is on the radio for everyone."); }
    }
    paintOwner(); levels(); save(true);
    // Pausing the tables doesn't kill the radio: with Auto-DJ on and every deck
    // stopped, the rotation (listener picks first) takes the wheel after a short
    // grace — and playing any deck again cancels it.
    if (s.playing && adTimer) { clearTimeout(adTimer); adTimer = null; }
    if (!s.playing && S.live && S.autodj && !DECKS.some((x) => S[x].playing)) {
      if (adTimer) clearTimeout(adTimer);
      adTimer = setTimeout(() => { adTimer = null; if (S.live && S.autodj && !DECKS.some((x) => S[x].playing)) { say("🤖 Auto-DJ is keeping the station rolling — play any deck to take back over."); autoNext(k === "B" ? "B" : "A"); } }, 5000);
    }
  }
  onMain("click", async (e) => {
    const b = e.target.closest("button"); if (!b || !OWNER()) return;
    if (b.dataset.pop != null) { popOut(); return; }
    if (b.dataset.preset) {
      const P = {
        radio: { fx: { mf: 100, echo: 0, fb: 0.34, verb: 0.12, fla: 0, gate: 0, crush: 0 }, vinyl: false, msg: "🏆 Pro Radio setup: clean broadcast sound, a touch of reverb, echo armed for drops." },
        club: { fx: { mf: 100, echo: 0.22, fb: 0.45, verb: 0.3, fla: 0.25, gate: 0, crush: 0 }, vinyl: false, msg: "🔥 Club setup: echo, reverb and flanger up — big-room energy on everything you play." },
        scratch: { fx: { mf: 100, echo: 0.1, fb: 0.3, verb: 0.05, fla: 0, gate: 0, crush: 15 }, vinyl: true, msg: "🎺 Scratch Session: vinyl mode on every deck and a little grit — grab a platter and cut." },
        chop: { fx: { mf: 100, echo: 0.15, fb: 0.4, verb: 0.1, fla: 0, gate: 4, crush: 0 }, vinyl: false, msg: "⚡ Transformer setup: the chop is ON at medium speed — the beat gets sliced live for everyone." },
      }[b.dataset.preset];
      if (!P) return;
      S.fx = Object.assign(defFx(), P.fx); S.xf = 0.5; S.xf2 = 0.5;
      DECKS.forEach((k) => { const d = deck(k); d.vinyl = P.vinyl; d.el.preservesPitch = !P.vinyl; const vc = document.querySelector(`[data-vinyl="${k}"]`); if (vc) vc.checked = P.vinyl; S[k].vol = 0.9; });
      document.querySelectorAll("[data-gate]").forEach((x) => x.classList.toggle("on", +x.dataset.gate === S.fx.gate));
      applyFx(); levels(); paintOwner(); save(true); say(P.msg); return;
    }
    if (b.dataset.curplay != null) { const ci = CURATED[+b.dataset.curplay]; if (ci) { b.disabled = true; const src = await curatedSrc(ci); b.disabled = false; if (src) playPadUrl(src); else say("That sound wouldn't load. Try another."); } return; }
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
    if (b.dataset.brake) { const k = b.dataset.brake, d = deck(k); if (d.el.paused) return; const r0 = d.el.playbackRate, t0 = performance.now(); const step = () => { const p = (performance.now() - t0) / 800; if (p >= 1) { d.el.pause(); d.el.playbackRate = S[k].rate || 1; if (S[k].playing) { S[k].playing = false; S[k].pos = d.el.currentTime; paintOwner(); save(true); } return; } d.el.playbackRate = Math.max(0.02, r0 * (1 - p)); requestAnimationFrame(step); }; step(); return; }
    if (b.dataset.hot) { if (hotTimer === "done") { hotTimer = null; return; } const [k, n] = b.dataset.hot.split(":"), d = deck(k), i = +n - 1; if (d.cues[i] == null) { let ct = d.el.currentTime || 0; if (S.quant !== false) ct = snapBeat(k, ct); d.cues[i] = ct; S[k].cues = d.cues.slice(); save(true); say("Cue " + n + " set at " + fmt(ct) + (S.quant !== false && beatLen(k) ? " (snapped to the beat)" : "")); } else { try { d.el.currentTime = d.cues[i]; } catch (_) {} if (S[k].playing) S[k].start = Date.now() - d.cues[i] * 1000; save(true); } paintCues(k); return; }
    if (b.dataset.loopb) { const [k, beats] = b.dataset.loopb.split(":"), d = deck(k), bl = beatLen(k); if (d.loop && d.loopBeats === +beats) { d.loop = null; d.loopBeats = 0; S[k].loop = null; S[k].loopBeats = 0; save(true); } else { let st = d.el.currentTime || 0; if (S.quant !== false) st = snapBeat(k, st); const len = bl ? +beats * bl : +beats; d.loop = [st, st + len]; d.loopBeats = +beats; S[k].loop = d.loop; S[k].loopBeats = d.loopBeats; try { d.el.currentTime = st; } catch (_) {} if (S[k].playing) S[k].start = Date.now() - st * 1000; save(true); say("Looping " + beats + " beats on deck " + k + (bl ? "" : " (no BPM measured yet — seconds for now)")); } paintCues(k); return; }
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
  });
  onMain("change", (e) => { if (!OWNER()) return; if (e.target.dataset.vinyl != null) { const k = e.target.dataset.vinyl, d = deck(k); d.vinyl = e.target.checked; d.el.preservesPitch = !d.vinyl; } if (e.target.id === "ad-on") { S.autodj = e.target.checked; save(true); say(S.autodj ? "Auto-DJ is running the station 🤖" : "Auto-DJ off — you're flying manual."); } if (e.target.id === "dj-quant") { S.quant = e.target.checked; save(true); say(S.quant ? "Quantize ON — cues and loops snap to the beat." : "Quantize off — cues and loops land exactly where you tap."); } if (e.target.id === "dj-fxsync") { S.fx.sync = e.target.checked; applyFx(); save(true); say(S.fx.sync ? "Effects now follow the live tempo — echo, flanger and the chopper lock to the beat." : "Effects free-running."); } });
  // circular pan pads: drag the gold dot anywhere in the circle — the further it
  // moves toward a deck, the more that deck plays. Same mix as the sliders and the
  // phone fader bar; everything stays in sync, including Auto-DJ crossfades.
  // ONE pan dot for all four decks: left/right rides both crossfaders together,
  // up/down picks which pair rules (top = A/B, bottom = C/D). Center = everything even.
  (() => { const pad = $("#dj-xfpad"); if (!pad) return; let drag = false;
    const apply = (e) => { const r = pad.getBoundingClientRect(), rad = r.width / 2; let dx = (e.clientX - (r.left + rad)) / rad, dy = (e.clientY - (r.top + rad)) / rad; const m = Math.hypot(dx, dy); if (m > 1) { dx /= m; dy /= m; } const v = Math.round(((dx + 1) / 2) * 1000) / 1000; S.xf = v; S.xf2 = v; S.panY = Math.round(dy * 1000) / 1000; paintXfPads(); levels(); save(); };
    pad.addEventListener("pointerdown", (e) => { if (!OWNER()) return; drag = true; try { pad.setPointerCapture(e.pointerId); } catch (_) {} apply(e); e.preventDefault(); });
    pad.addEventListener("pointermove", (e) => { if (drag) apply(e); });
    pad.addEventListener("pointerup", () => { drag = false; });
    pad.addEventListener("pointercancel", () => { drag = false; });
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
  // scratch / scrub: drag a platter sideways to move through the song
  DECKS.forEach((k) => {
    const pl = () => $("#pl-" + k); let drag = null;
    onMain("pointerdown", (e) => { if (e.target !== pl() || !OWNER()) return; drag = { x: e.clientX, was: !deck(k).el.paused }; deck(k).el.pause(); e.preventDefault(); });
    onMainRaw("pointermove", (e) => { if (!drag) return; const d = deck(k), dx = e.clientX - drag.x; drag.x = e.clientX; try { d.el.currentTime = Math.max(0, Math.min((d.el.duration || 0) - 0.2, d.el.currentTime + dx * 0.06)); } catch (_) {} });
    onMainRaw("pointerup", () => { if (!drag) return; const d = deck(k); if (drag.was) { d.el.play().catch(() => {}); if (S[k].playing) S[k].start = Date.now() - d.el.currentTime * 1000; } else if (S[k]) S[k].pos = d.el.currentTime; drag = null; save(true); });
  });
  // deck ended -> owner bookkeeping + Auto-DJ
  // dead-air guard: a deck that runs out (or stalls at the end) while the station is
  // LIVE hands over automatically — listener pick first, then the queue, then the mix —
  // even with Auto-DJ switched off, because a live set should never just stop
  function deckEnded(k) {
    if (!OWNER() || listening || !S[k].playing) return;
    S[k].playing = false; S[k].pos = 0; paintOwner(); save(true);
    if (S.live && !DECKS.some((x) => S[x].playing)) { say("⏭️ Deck " + k + " ended — rolling the next song so the station never goes quiet."); autoNext(k, true); }
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
  let xfAnim = null, adTimer = null;
  async function autoNext(endedK, force) {
    if ((!S.autodj && !force) || !boothLead) return;
    let item = null;
    const pick = reqCache.filter((r) => r.data && r.data.kind === "pick").sort((a, b) => (a.data.at || 0) - (b.data.at || 0))[0];
    if (pick) {
      if (pick.data.src && okUrl(pick.data.src)) item = { src: pick.data.src, title: pick.data.title || "", cover: pick.data.cover || "", dur: pick.data.dur || 0 };
      else if (pick.data.iaId) { const src = await iaFile(pick.data.iaId); if (src) item = { src, title: pick.data.title || "", cover: "https://archive.org/services/img/" + encodeURIComponent(pick.data.iaId) }; }
      DBF()?.doc("requests/" + pick.id).delete().catch(() => {});
      if (item) say("🎵 Listener pick up next: " + item.title);
    }
    if (!item && queue.length) item = queue.shift();
    if (!item) { mixFlip = !mixFlip; if (mixFlip) item = await nextFromPool(); if (!item) item = nextFromLibrary(); }
    if (!item) return;
    saveQueue(); paintQueue();
    const target = endedK === "A" ? "B" : "A";
    const idPad = (S.pads || [])[0]; if (idPad && okUrl(idPad.url)) { S.voice = { id: idPad.id, url: idPad.url, at: Date.now() }; }
    load(target, item).then(async () => {
      await togglePlay(target);
      const from = S.xf, to = target === "A" ? 0 : 1, t0 = performance.now();
      clearInterval(xfAnim); xfAnim = setInterval(() => { const p = Math.min(1, (performance.now() - t0) / 3500);  paintXfPads(); if (p >= 1) { clearInterval(xfAnim); save(true); } }, 100);
    });
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
    const s = e.target.closest("[data-synth]"); if (s && OWNER()) { s.classList.add("hit"); setTimeout(() => s.classList.remove("hit"), 200); SYNTH[+s.dataset.synth].fn(); return; }
    const pb = e.target.closest("[data-pad]"); if (pb && OWNER()) { if (padPress === "done") { padPress = null; return; } const p = (S.pads || [])[+pb.dataset.pad]; if (p) { pb.classList.add("hit"); setTimeout(() => pb.classList.remove("hit"), 200); playPadUrl(p.url); } return; }
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
        ev.target.disabled = true; ev.target.textContent = "Posting...";
        try { const a = await claude.use("assets"); const up = await a.upload(blob, { type: (blob.type || "audio/webm").split(";")[0] }); const old = S.show; S.show = { id: up.id, url: up.url, at: Date.now() }; save(true); paintStation(); ev.target.textContent = "Posted ✓ It's on the station card"; if (old && old.id) a.delete(old.id).catch(() => {}); }
        catch (_) { ev.target.disabled = false; ev.target.textContent = "📻 Post as Latest Show"; say("Couldn't post the show. Download it instead."); }
      });
    };
    showT0 = Date.now(); showRec.start(1000); $("#rec-btn").textContent = "⏹ Stop recording"; $("#rec-st").innerHTML = '<span class="rec-on">● REC</span> Recording the show...';
  });

  /* ---------- requests + listener voice drops ---------- */
  async function sendRequest(data) {
    const d = DBF(); if (!d) throw new Error("no db");
    await d.collection("requests").add(data);
  }
  $("#rq-form").addEventListener("submit", async (e) => {
    e.preventDefault(); const v = $("#rq-text").value.trim(); if (!v) return;
    try { await sendRequest({ kind: "text", text: v.slice(0, 120), at: Date.now() }); $("#rq-text").value = ""; say("Request sent to the booth 🎧"); }
    catch (_) { say("Join free / sign in to send a request."); }
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
  function renderReqs(docs) {
    const box = $("#rq-list"); if (!box) return;
    const rows = docs.map((x) => ({ id: x.id, data: x.data() || {} })).sort((a, b) => (b.data.at || 0) - (a.data.at || 0)).slice(0, 30);
    box.innerHTML = rows.length ? rows.map((r) => r.data.kind === "voice"
      ? `<div class="req"><b>🎙️ Voice drop</b><small>${agoT(r.data.at || Date.now())}</small><span style="display:flex;gap:6px;flex-wrap:wrap"><button class="btn ghost sm" type="button" data-rqplay="${E(r.data.url)}">▶ Hear it</button><button class="btn sm" type="button" data-rqair="${E(r.id)}|${E(r.data.url)}|${E(r.data.asset || "")}">📡 Play on air</button><button class="btn ghost sm" type="button" data-rqdone="${E(r.id)}">✓ Done</button></span></div>`
      : r.data.kind === "pick" ? `<div class="req"><span>🎵 Listener pick: ${E(r.data.title || "")}</span><small>${agoT(r.data.at || Date.now())}</small><span><button class="btn ghost sm" type="button" data-rqdone="${E(r.id)}">✓ Played</button></span></div>`
      : `<div class="req"><span>${E(r.data.text || "")}</span><small>${agoT(r.data.at || Date.now())}</small><span><button class="btn ghost sm" type="button" data-rqdone="${E(r.id)}">✓ Played</button></span></div>`).join("") : '<small class="muted">Nothing yet. Listener requests land here.</small>';
  }
  function subReqs() {
    if (reqSubbed || !OWNER()) return; const d = DBF(); if (!d) return; reqSubbed = true;
    try { d.collection("requests").limit(40).onSnapshot((s) => { reqCache = s.docs.map((x) => ({ id: x.id, data: x.data() || {} })); renderReqs(s.docs); }, () => {}); } catch (_) { reqSubbed = false; }
  }
  onMain("click", async (e) => {
    const p = e.target.closest("[data-rqplay]"); if (p) { new Audio(p.dataset.rqplay).play().catch(() => {}); return; }
    const air = e.target.closest("[data-rqair]"); if (air && OWNER()) { const [id, url, asset] = air.dataset.rqair.split("|"); S.voice = { id: asset || id, url, at: Date.now() }; heardVoice = S.voice.id; save(true); say("Drop is on the air 📡"); DBF()?.doc("requests/" + id).delete().catch(() => {}); return; }
    const dn = e.target.closest("[data-rqdone]"); if (dn && OWNER()) { DBF()?.doc("requests/" + dn.dataset.rqdone).delete().catch(() => {}); }
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
    if (pkSubbed) return; const d = DBF(); if (!d) return; pkSubbed = true;
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
    catch (_) { say("Join free / sign in to pick songs for the radio."); }
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
    d.doc("radio/dj").onSnapshot((snap) => onState(snap.exists ? snap.data() : null), () => {});
    const show = () => { const own = OWNER(); $("#dj-owner").hidden = !own; if (own) { libList(); paintOwner(); paintQueue(); paintPads(); paintCurated(); subReqs(); const ti = $("#dj-ticker-in"); if (ti && document.activeElement !== ti) ti.value = S.ticker || ""; } paintPkList(); subPicks(); const vn = document.getElementById("dj-visit-note"); if (vn) vn.hidden = own; };
    show(); setTimeout(show, 1500); setTimeout(show, 5000);
    setInterval(() => { if (OWNER() && !$("#dj-owner").hidden && $("#dj-lib").children.length !== TRACKS().length) libList(); }, 4000);
    // scroll past the tables and the side buttons/floats fold away — nothing covers the decks
    const boothHome2 = document.getElementById("dj-booth-root");
    if (boothHome2 && "IntersectionObserver" in window) new IntersectionObserver((es) => { es.forEach((en) => { document.body.classList.toggle("dj-past", !en.isIntersecting && en.boundingClientRect.top < 0); document.body.classList.toggle("dj-on", en.isIntersecting); }); }, { threshold: 0 }).observe(boothHome2);
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init); else init();
})();
