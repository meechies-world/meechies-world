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

  /* ================= audio engine: decks -> EQ -> mixer -> FX -> master ================= */
  let ctx = null, masterIn = null, masterGain = null, analyser = null, recDest = null;
  let fxFilter = null, echoWet = null, verbWet = null, micGain = null, micMon = null, micAn = null;
  function actx() {
    if (!ctx) {
      try { ctx = new (window.AudioContext || window.webkitAudioContext)(); } catch (_) { ctx = null; }
      if (ctx) {
        masterIn = ctx.createGain();
        fxFilter = ctx.createBiquadFilter(); fxFilter.type = "lowpass"; fxFilter.frequency.value = 18000; fxFilter.Q.value = 0.4;
        masterGain = ctx.createGain(); masterGain.gain.value = 0.95;
        analyser = ctx.createAnalyser(); analyser.fftSize = 256;
        masterIn.connect(fxFilter); fxFilter.connect(masterGain); masterGain.connect(analyser); analyser.connect(ctx.destination);
        // echo send
        const dly = ctx.createDelay(1); dly.delayTime.value = 0.28; const fb = ctx.createGain(); fb.gain.value = 0.34;
        const dw = ctx.createGain(); dw.gain.value = 0; dly.connect(fb); fb.connect(dly); dly.connect(dw); dw.connect(masterGain);
        masterIn.connect(dly); echoWet = dw;
        // reverb send (generated impulse — no files, always free)
        const verb = ctx.createConvolver(); verb.buffer = impulse(2.2, 2.4);
        const vw = ctx.createGain(); vw.gain.value = 0; masterIn.connect(verb); verb.connect(vw); vw.connect(masterGain); verbWet = vw;
        // recording tap (the whole mix + mic land here)
        recDest = ctx.createMediaStreamDestination(); masterGain.connect(recDest);
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
    const d = { el: new Audio(), gain: null, eq: null, src: "", level: 1, cors: true, peaks: null, rate: 1, vinyl: false, cues: [null, null, null], loop: null };
    d.el.preload = "auto"; d.el.playsInline = true; d.el.crossOrigin = "anonymous";
    d.set = (src) => new Promise((res) => {
      if (d.src === src) return res(true);
      d.src = src; d.cors = true; d.el.crossOrigin = "anonymous"; d.el.src = src; d.peaks = null;
      const ok = () => { clean(); wire(); res(true); };
      const bad = () => { clean(); if (d.cors) { d.cors = false;
          if (d.gain) { const old = d.el; old.pause(); d.el = new Audio(); d.el.preload = "auto"; d.el.playsInline = true; d.gain = null; d.eq = null; d.onswap && d.onswap(old); }
          d.el.removeAttribute("crossorigin"); d.el.src = src; d.el.addEventListener("loadedmetadata", () => res(true), { once: true }); d.el.addEventListener("error", () => res(false), { once: true }); } else res(false); };
      const clean = () => { d.el.removeEventListener("loadedmetadata", ok); d.el.removeEventListener("error", bad); };
      d.el.addEventListener("loadedmetadata", ok); d.el.addEventListener("error", bad);
    });
    function wire() { if (!OWNER() && ((typeof IOS !== "undefined" && IOS) || (typeof TOUCH !== "undefined" && TOUCH))) return; const c = actx(); if (!c || d.gain || !d.cors) return; try {
        const s = c.createMediaElementSource(d.el);
        const lo = c.createBiquadFilter(); lo.type = "lowshelf"; lo.frequency.value = 120;
        const mid = c.createBiquadFilter(); mid.type = "peaking"; mid.frequency.value = 1000; mid.Q.value = 0.9;
        const hi = c.createBiquadFilter(); hi.type = "highshelf"; hi.frequency.value = 8000;
        d.gain = c.createGain(); s.connect(lo); lo.connect(mid); mid.connect(hi); hi.connect(d.gain); d.gain.connect(masterIn);
        d.eq = { lo, mid, hi };
      } catch (_) { d.gain = null; d.eq = null; } d.apply(); }
    d.vol = (v) => { d.level = Math.max(0, Math.min(1, v)); d.apply(); };
    d.apply = () => { if (d.gain) { d.gain.gain.value = d.level; d.el.volume = 1; } else d.el.volume = d.level; };
    d.stop = () => { try { d.el.pause(); } catch (_) {} };
    return d;
  }
  const xfGain = (xf, side) => Math.cos((side === "A" ? xf : 1 - xf) * Math.PI / 2); // equal-power crossfade

  /* ---------- shared station state (doc radio/dj) ---------- */
  const blank = () => ({ src: "", title: "", cover: "", start: 0, pos: 0, playing: false, vol: 0.9, rate: 1 });
  let S = { live: false, xf: 0.5, duck: false, A: blank(), B: blank(), voice: null, updatedAt: 0, liveSince: 0, ticker: "", log: [], show: null, pads: [], autodj: true };
  const posOf = (k) => { const s = S[k]; return s.playing ? Math.max(0, (Date.now() - s.start) / 1000) : (s.pos || 0); };
  let saveT = null;
  function save(now) { if (!OWNER()) return; clearTimeout(saveT); const run = () => { S.updatedAt = Date.now(); S.boothAt = Date.now(); DB()?.doc("radio/dj").set(JSON.parse(JSON.stringify(S))).catch((e) => say(e.message || e.code)); }; if (now) run(); else saveT = setTimeout(run, 250); }
  function logPlay(title) { if (!title) return; S.log = [{ t: title, at: Date.now(), live: !!S.live }].concat((S.log || []).filter((x) => x.t !== title)).slice(0, 30); }

  /* ---------- styles ---------- */
  const css = document.createElement("style");
  css.textContent = `
.dj{margin-top:40px;border:1px solid var(--gold-lo);border-radius:20px;padding:26px;background:radial-gradient(ellipse at 50% 0,#2a2112 0,#100d08 60%);box-shadow:0 20px 50px rgba(0,0,0,.5)}
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
.dj-decks{display:grid;grid-template-columns:1fr 240px 1fr;gap:16px;align-items:stretch}
.deck{background:#0c0a07;border:1px solid var(--line);border-radius:16px;padding:14px;display:grid;gap:10px;justify-items:center;text-align:center;min-width:0;align-content:start}
.deck h4{margin:0;font:800 13px var(--body);letter-spacing:.18em;color:var(--gold-hi)}
.platter{width:min(240px,38vw);aspect-ratio:1;border-radius:50%;background:repeating-radial-gradient(circle,#111 0 2px,#1b1b1b 2px 4px);border:3px solid #2a2418;position:relative;box-shadow:inset 0 0 20px #000,0 8px 20px rgba(0,0,0,.6);cursor:grab;touch-action:none}
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
.loopbtn.on{background:#a3161c;color:#fff;border-color:#e5484d}
.mixer{background:#0c0a07;border:1px solid var(--line);border-radius:16px;padding:14px 10px;display:grid;gap:12px;align-content:start;justify-items:center;text-align:center}
.mixer small{color:var(--muted);font-size:11px;letter-spacing:.12em}
.talk{width:120px;height:120px;border-radius:50%;border:3px solid #e5484d;background:#2a0f10;color:#fff;font:800 13px var(--body);cursor:pointer;touch-action:none;user-select:none;-webkit-user-select:none}
.talk.on{background:#e5484d;box-shadow:0 0 0 8px rgba(229,72,77,.25),0 0 30px #e5484d}
.micmeter{width:100%;height:8px;background:#1c1710;border-radius:99px;overflow:hidden}
.micmeter i{display:block;height:100%;width:0;background:linear-gradient(90deg,#45bd62,#f7b928,#e5484d);transition:width .08s}
.dj-grid2{display:grid;grid-template-columns:1fr 1fr;gap:14px;margin-top:14px}
.dj-panel{background:#0c0a07;border:1px solid var(--line);border-radius:16px;padding:14px;display:grid;gap:10px;align-content:start;min-width:0}
.dj-panel h4{margin:0;font:800 12px var(--body);letter-spacing:.16em;color:var(--gold-hi)}
.pads{display:grid;grid-template-columns:repeat(4,1fr);gap:8px}
.pad{padding:20px 8px;border-radius:12px;border:1px solid var(--gold-lo);background:#171208;color:var(--text);font:700 12px var(--body);cursor:pointer}
.pad:active{transform:scale(.96)}
.pad.custom{border-style:dashed}
.pad small{display:block;color:var(--muted);font-weight:600;font-size:10px;margin-top:3px}
.dj-list{display:grid;gap:6px;max-height:240px;overflow:auto}
.dj-item{display:grid;grid-template-columns:minmax(0,1fr) auto auto auto;gap:6px;align-items:center;padding:8px;border:1px solid var(--line);border-radius:10px;font-size:14px}
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
@media (min-width:1000px){#dj-root{width:min(1400px,95vw);margin-left:50%;transform:translateX(-50%)}}
@media (max-width:760px){.dj-decks{display:flex;flex-direction:column}.deck{order:1}.deck[data-deck=B]{order:3}.mixer{order:2}.dj-grid2{grid-template-columns:1fr}.pads{grid-template-columns:repeat(2,1fr)}}`;
  document.head.appendChild(css);

  const deckHTML = (k) => `<div class="deck" data-deck="${k}"><h4>DECK ${k}</h4><div class="platter" id="pl-${k}" title="Drag to scratch / scrub"></div>
    <canvas class="wave" id="wv-${k}" width="520" height="84"></canvas>
    <div class="ttl" id="ttl-${k}">Load a song</div><div class="tm" id="tm-${k}">0:00</div>
    <div class="row"><button class="btn sm" type="button" data-play="${k}">▶ Play</button><button class="btn ghost sm" type="button" data-cue0="${k}">⏮ Cue</button><button class="btn ghost sm" type="button" data-brake="${k}">🛑 Brake</button></div>
    <div class="row">${[1, 2, 3].map((n) => `<button class="btn ghost sm cuebtn" type="button" data-hot="${k}:${n}">CUE ${n}</button>`).join("")}</div>
    <div class="row"><button class="btn ghost sm loopbtn" type="button" data-loop="${k}:4">Loop 4s</button><button class="btn ghost sm loopbtn" type="button" data-loop="${k}:8">Loop 8s</button><button class="btn ghost sm" type="button" data-sync="${k}">SYNC</button></div>
    <label class="lab">Pitch <span id="pit-v-${k}">+0.0%</span><input type="range" min="0.92" max="1.08" step="0.001" value="1" data-pitch="${k}" aria-label="Deck ${k} pitch"></label>
    <label class="lab" style="display:flex;align-items:center;gap:8px"><input type="checkbox" data-vinyl="${k}" style="width:auto"> Vinyl mode (pitch bends like a record)</label>
    <div class="eqrow"><label>LOW<input type="range" min="-24" max="24" step="1" value="0" data-eq="${k}:lo"></label><label>MID<input type="range" min="-24" max="24" step="1" value="0" data-eq="${k}:mid"></label><label>HIGH<input type="range" min="-24" max="24" step="1" value="0" data-eq="${k}:hi"></label></div>
    <label class="lab">Volume<input type="range" min="0" max="1" step="0.01" value="0.9" data-vol="${k}" aria-label="Deck ${k} volume"></label></div>`;

  root.innerHTML = `
<div class="dj-banner" id="dj-banner" hidden><span><b>● LIVE DJ SET</b> &nbsp;Meechie is on the decks right now</span><button class="btn sm" type="button" id="dj-listen">🎧 Listen live</button></div>
<div class="station" id="dj-station" hidden>
  <div style="display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap"><h3>📻 Meechie's World Radio</h3><span class="onair-lamp" id="st-lamp"><span class="dot"></span>OFF AIR</span></div>
  <div class="ticker" id="st-ticker" hidden><span id="st-ticker-t"></span></div>
  <div id="st-now" class="muted" style="font-size:14px">The station is on the playlist right now.</div>
  <div id="st-show"></div>
  <div><b style="font-size:13px;letter-spacing:.1em">RECENTLY PLAYED</b><div class="loglist" id="st-log" style="margin-top:6px"></div></div>
  <div class="dj-panel" style="margin:0"><h4>REQUEST A SONG / SEND A DROP</h4>
    <form class="dj-search" id="rq-form"><input type="text" id="rq-text" maxlength="120" placeholder="Song request or shout-out..." aria-label="Song request"><button class="btn sm" type="submit">Send</button></form>
    <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap"><button class="btn ghost sm" type="button" id="rq-rec">🎙️ Record a voice drop</button><small class="muted" id="rq-rec-st">Up to 20 seconds. Meechie can play it on air.</small></div>
  </div>
</div>
<div class="dj" id="dj-owner" hidden>
  <div class="dj-top"><div><p class="eyebrow" style="margin:0">Owner only · the station board</p><h3>🎛️ DJ Station</h3></div>
    <span class="onair-lamp" id="dj-lamp"><span class="dot"></span>OFF AIR</span>
    <span class="dj-clock" id="dj-clock"></span><span class="dj-clock" id="dj-showtime"></span>
    <label class="dj-live"><input type="checkbox" id="dj-golive"> Go live (everyone hears your mix)</label></div>
  <div class="dj-decks">
    ${deckHTML("A")}
    <div class="mixer"><small>MIC DROP</small>
      <button class="talk" type="button" id="dj-talk" aria-label="Hold to talk">🎙️<br>HOLD TO TALK</button>
      <small id="dj-talk-st">Hold, talk, let go — it goes out over the music</small>
      <small>CROSSFADER</small><input type="range" min="0" max="1" step="0.01" value="0.5" id="dj-xf" aria-label="Crossfader">
      <div style="display:flex;justify-content:space-between;width:100%;font:700 11px var(--body);color:var(--gold-hi)"><span>A</span><span>B</span></div>
      <small>MASTER</small><input type="range" min="0" max="1" step="0.01" value="0.95" id="dj-master" aria-label="Master volume">
      <small>FILTER</small><input type="range" min="0" max="100" step="1" value="100" id="dj-filter" aria-label="Master filter">
      <small>ECHO</small><input type="range" min="0" max="0.6" step="0.02" value="0" id="dj-echo" aria-label="Echo level">
      <small>REVERB</small><input type="range" min="0" max="0.7" step="0.02" value="0" id="dj-verb" aria-label="Reverb level"></div>
    ${deckHTML("B")}
  </div>
  <div class="dj-grid2">
    <div class="dj-panel"><h4>🎤 LIVE MIC</h4>
      <div style="display:flex;gap:8px;flex-wrap:wrap"><button class="btn sm" type="button" id="mic-on">Open the mic</button><button class="btn ghost sm" type="button" id="mic-mon">🔇 Monitor off</button></div>
      <div class="micmeter"><i id="mic-lvl"></i></div>
      <label style="display:flex;gap:8px;align-items:center;font-size:14px"><input type="checkbox" id="mic-duck" checked style="width:auto"> Auto-duck the music while I talk (radio style)</label>
      <small class="muted">Your live mic feeds the show recording. To talk TO the listeners, use the big HOLD TO TALK button — it sends your voice out over the mix.</small></div>
    <div class="dj-panel"><h4>🔊 JINGLE / SPOT BOARD</h4>
      <div class="pads" id="dj-pads"></div>
      <small class="muted">Top row: built-in station sounds. Bottom row: your own drops — tap an empty pad to record up to 8 seconds. ▶ plays it in the booth, 📡 sends it out over the air.</small></div>
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
  <div class="dj-grid2">
    <div class="dj-panel"><b>Your Library</b><div class="dj-list" id="dj-lib"></div></div>
    <div class="dj-panel"><b>Free music from the internet</b><form class="dj-search" id="dj-sf"><input type="search" id="dj-q" placeholder="Search: hip hop, jazz, beats..." aria-label="Search free music"><button class="btn sm" type="submit">Search</button></form>
      <small class="muted">Creative Commons music from the Internet Archive, free to play on your station.</small><div class="dj-list" id="dj-net"></div></div>
  </div>
</div>`;
  const $ = (s) => root.querySelector(s);
  const decks = { A: null, B: null };
  const deck = (k) => decks[k] || (decks[k] = Deck());
  const fmt = (s) => { s = Math.max(0, Math.floor(s || 0)); return Math.floor(s / 60) + ":" + String(s % 60).padStart(2, "0"); };
  const agoT = (at) => new Date(at).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: "America/New_York" });

  /* ---------- levels, following the shared state, listener side ---------- */
  let listening = false, voiceEl = null, heardVoice = "", micHot = 0;
  function levels() {
    const duck = (S.duck || (voiceEl && !voiceEl.paused) || micHot > 0.04) ? 0.28 : 1;
    ["A", "B"].forEach((k) => { if (decks[k]) decks[k].vol((S[k].vol ?? 0.9) * xfGain(S.xf, k) * duck); });
  }
  async function follow(k) {
    const s = S[k], d = deck(k);
    if (!okUrl(s.src) || DEAD(s.src)) { d.stop(); return; }
    await d.set(s.src);
    d.el.playbackRate = s.rate || 1;
    const want = posOf(k);
    if (s.playing) {
      if (d.el.duration && want >= d.el.duration - 0.3) { d.el.pause(); levels(); return; }
      if (!d.el.seeking && d.el.readyState >= 3 && Math.abs(d.el.currentTime - want) > 4) { try { d.el.currentTime = want; } catch (_) {} }
      if (d.el.paused) d.el.play().catch(() => {});
    }
    else { d.el.pause(); if (Math.abs(d.el.currentTime - want) > 0.5) { try { d.el.currentTime = want; } catch (_) {} } }
    levels();
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
      g.fillStyle = "#3a2f16"; const n = pk ? pk.length : 60;
      for (let i = 0; i < n; i++) { const h = Math.max(2, (pk ? pk[i] : 0.25) * (H - 6)); g.fillRect(i * (W / n) + 0.5, (H - h) / 2, Math.max(1, W / n - 1.5), h); }
      const el = d.el, p = el.duration ? el.currentTime / el.duration : 0;
      g.fillStyle = "rgba(247,185,40,.85)"; g.fillRect(0, 0, W * p, H);
    };
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
  function paintOwner() {
    ["A", "B"].forEach((k) => {
      const s = S[k], pl = $("#pl-" + k);
      $("#ttl-" + k).textContent = s.title || "Load a song";
      pl.classList.toggle("spin", !!s.playing);
      pl.classList.toggle("has-cover", okUrl(s.cover)); if (okUrl(s.cover)) pl.style.setProperty("--cv", `url("${s.cover}")`);
      root.querySelector(`[data-play="${k}"]`).textContent = s.playing ? "⏸ Pause" : "▶ Play";
      root.querySelector(`[data-vol="${k}"]`).value = s.vol ?? 0.9;
      const pv = root.querySelector(`[data-pitch="${k}"]`); if (pv && document.activeElement !== pv) pv.value = s.rate || 1;
      $("#pit-v-" + k).textContent = (((s.rate || 1) - 1) * 100).toFixed(1).replace("-", "−") + "%";
      peaks(k);
    });
    $("#dj-xf").value = S.xf; $("#dj-golive").checked = !!S.live;
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
    const now = live ? ["A", "B"].filter((k) => S[k].playing).map((k) => S[k].title).filter(Boolean) : [];
    $("#st-now").textContent = live ? (now.length ? (S.autodj ? "🤖 Auto-DJ live: " : "🎧 Live now: ") + now.join("  ×  ") : "🎧 Meechie is live on the decks.") : "The station is on the playlist right now. When Meechie goes live on the decks, it shows up here.";
    $("#st-show").innerHTML = S.show && okUrl(S.show.url) && !DEAD(S.show.url) ? `<b style="font-size:13px;letter-spacing:.1em">🎙️ LATEST RECORDED SHOW</b><audio controls preload="none" src="${E(S.show.url)}" style="width:100%;margin-top:6px"></audio><small class="muted">Recorded ${new Date(S.show.at).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: "America/New_York" })}</small>` : "";
    renderLog($("#st-log"));
  }
  setInterval(() => {
    ["A", "B"].forEach((k) => {
      const el = $("#tm-" + k); if (el && decks[k]) el.textContent = fmt(decks[k].el.currentTime) + (decks[k].el.duration ? " / " + fmt(decks[k].el.duration) : "");
      const d = decks[k]; if (d && d.loop && !d.el.paused && d.el.currentTime >= d.loop[1]) { try { d.el.currentTime = d.loop[0]; } catch (_) {} if (OWNER() && S[k].playing) { S[k].start = Date.now() - d.loop[0] * 1000; } }
      if (OWNER() && decks[k] && S[k].playing) peaks(k);
    });
    if (listening) { follow("A"); follow("B"); }
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
  setInterval(() => { if (OWNER() && (S.live || root.offsetParent)) save(true); }, 20000);
  // the keeper ping: keeps the rotation advancing around the clock, booth open or not
  const pingKeeper = () => fetch("/api/station", { cache: "no-store" }).catch(() => {});
  pingKeeper(); setInterval(pingKeeper, 12000);
  setInterval(() => { if (!OWNER() && S.live) { const l = isLive(); $("#dj-banner").hidden = !l; if (!l && listening) endSet(); } paintStation(); }, 30000);
  function startListening() {
    listening = true; actx();
    try { if (typeof media !== "undefined") media.pause(); if (typeof mode !== "undefined") mode = "dj"; } catch (_) {}
    $("#dj-listen").textContent = "⏹ Stop listening"; follow("A"); follow("B");
    try { if (typeof showBar === "function") showBar({ title: "LIVE DJ SET", artist: "Meechie", cover: "" }, "Live on the decks"); } catch (_) {}
    try { if ("mediaSession" in navigator) { navigator.mediaSession.playbackState = "playing"; navigator.mediaSession.metadata = new MediaMetadata({ title: "LIVE DJ SET", artist: "Meechie", album: "Meechie's World Radio", artwork: [{ src: location.origin + "/img/icon-512.png", sizes: "512x512", type: "image/png" }] }); } } catch (_) {}
  }
  function stopListening() { listening = false; ["A", "B"].forEach((k) => decks[k]?.stop()); voiceEl?.pause(); $("#dj-listen").textContent = "🎧 Listen live"; try { navigator.mediaSession.playbackState = "paused"; } catch (_) {} }
  let autoMoved = false;
  function endSet() { stopListening(); if (autoMoved) { autoMoved = false; try { if (typeof tuneIn === "function") tuneIn(); } catch (_) {} } }
  window.MW_DJ = { start: () => { if (isLive() || OWNER()) startListening(); else if (typeof tuneIn === "function") tuneIn(); }, stop: stopListening };
  if (typeof media !== "undefined") media.addEventListener("play", () => {
    if (listening) { listening = false; ["A", "B"].forEach((k) => decks[k]?.stop()); voiceEl?.pause(); $("#dj-listen").textContent = "🎧 Listen live"; return; }
    // The tables ARE the live radio while a set is live: any radio tune-in (player bar,
    // hero, lock-screen controls, radio-keep) hands over to the deck mix, not the playlist.
    if (!OWNER() && isLive() && typeof mode !== "undefined" && mode === "radio") { autoMoved = true; startListening(); }
  });
  $("#dj-listen").addEventListener("click", () => (listening ? stopListening() : isLive() || OWNER() ? startListening() : (typeof tuneIn === "function" && tuneIn())));

  let ownerLoaded = false;
  function onState(d) {
    const firstOwnerLoad = OWNER() && !ownerLoaded;
    if (OWNER() && ownerLoaded) return;
    if (OWNER()) ownerLoaded = true;
    const was = isLive();
    S = Object.assign({ live: false, xf: 0.5, duck: false, A: blank(), B: blank(), voice: null, liveSince: 0, ticker: "", log: [], show: null, pads: [], autodj: true }, d || {});
    S.A = Object.assign(blank(), S.A || {}); S.B = Object.assign(blank(), S.B || {});
    // heal the booth: anything still pointing at the dead storage comes off the decks
    if (OWNER()) { let dirty = false; ["A", "B"].forEach((k) => { if (DEAD(S[k].src)) { S[k] = blank(); dirty = true; } }); if (S.voice && DEAD(S.voice.url)) { S.voice = null; dirty = true; } if (S.show && DEAD(S.show.url)) { S.show = null; dirty = true; } if (dirty) setTimeout(() => save(true), 800); }
    const live = isLive();
    $("#dj-banner").hidden = !live || OWNER();
    $("#dj-station").hidden = OWNER() ? false : (live || (S.log || []).length > 0 || !!S.show);
    if (!live && listening) endSet();
    if (live && !was && !document.hidden && !OWNER() && typeof mode !== "undefined" && mode === "radio" && typeof media !== "undefined" && !media.paused) { autoMoved = true; startListening(); }
    if (listening) { follow("A"); follow("B"); }
    // taking control: opening the booth pulls whatever the station is playing onto the
    // decks, in sync, so the tables are his from the first second
    if (firstOwnerLoad) ["A", "B"].forEach((k) => { if (S[k].playing) follow(k); });
    playVoice(); paintStation();
    if (OWNER()) paintOwner();
  }

  /* ---------- owner: loading songs, transport, deck tools ---------- */
  function libList() {
    const list = TRACKS();
    $("#dj-lib").innerHTML = list.length ? list.map((t, i) => `<div class="dj-item"><span title="${E(t.title)}">${E(t.title)}</span><button class="btn ghost sm" type="button" data-load="A" data-lib="${i}">A</button><button class="btn ghost sm" type="button" data-load="B" data-lib="${i}">B</button><button class="btn ghost sm" type="button" data-queue="${i}">＋Q</button></div>`).join("") : '<small class="muted">No songs in your library yet.</small>';
  }
  let net = [];
  async function load(k, item) {
    const d = deck(k); actx();
    S[k] = Object.assign(blank(), { src: item.src, title: item.title, cover: item.cover || "", vol: S[k].vol ?? 0.9, rate: S[k].rate || 1 });
    d.cues = [null, null, null]; d.loop = null; paintCues(k);
    paintOwner(); $("#ttl-" + k).textContent = "Loading " + item.title + "...";
    const ok = await d.set(item.src);
    if (!ok) { say("That song couldn't load. Try another one."); S[k] = blank(); paintOwner(); return; }
    d.el.currentTime = 0; d.el.playbackRate = S[k].rate || 1; paintOwner(); levels(); save();
  }
  function paintCues(k) { root.querySelectorAll(`[data-hot^="${k}:"]`).forEach((b, i) => b.classList.toggle("on", deck(k).cues[i] != null)); root.querySelectorAll(`[data-loop^="${k}:"]`).forEach((b) => b.classList.toggle("on", !!deck(k).loop && +b.dataset.loop.split(":")[1] === Math.round(deck(k).loop[1] - deck(k).loop[0]))); }
  async function togglePlay(k) {
    const s = S[k], d = deck(k); if (!okUrl(s.src)) { say("Load a song on deck " + k + " first."); return; }
    actx(); try { if (typeof media !== "undefined" && !media.paused) media.pause(); } catch (_) {}
    if (s.playing) { s.pos = d.el.currentTime; s.playing = false; d.el.pause(); }
    else {
      await d.set(s.src); try { d.el.currentTime = s.pos || 0; } catch (_) {}
      d.el.playbackRate = s.rate || 1; d.el.preservesPitch = !d.vinyl;
      await d.el.play().catch(() => {}); s.start = Date.now() - d.el.currentTime * 1000; s.playing = true;
      logPlay(s.title);
      if (!S.live) say("🔇 Booth only right now — flip “Go live” at the top of the station and the tables take over the radio for everyone.");
    }
    paintOwner(); levels(); save(true);
  }
  root.addEventListener("click", async (e) => {
    const b = e.target.closest("button"); if (!b || !OWNER()) return;
    if (b.dataset.load) {
      if (b.dataset.lib != null) { const t = TRACKS()[+b.dataset.lib]; if (t) load(b.dataset.load, { src: URLOF(t), title: t.title, cover: t.cover }); }
      else if (b.dataset.net != null) { const n = net[+b.dataset.net]; if (!n) return; b.disabled = true; const src = await iaFile(n.id); b.disabled = false; if (!src) { say("No playable file in that one. Pick another."); return; } load(b.dataset.load, { src, title: n.title, cover: "https://archive.org/services/img/" + encodeURIComponent(n.id) }); }
      return;
    }
    if (b.dataset.queue != null) { const t = TRACKS()[+b.dataset.queue]; if (t) { queue.push({ src: URLOF(t), title: t.title, cover: t.cover || "" }); saveQueue(); paintQueue(); say("Queued: " + t.title); } return; }
    if (b.dataset.play) return togglePlay(b.dataset.play);
    if (b.dataset.cue0) { const k = b.dataset.cue0, s = S[k], d = deck(k); s.pos = 0; if (s.playing) s.start = Date.now(); try { d.el.currentTime = 0; } catch (_) {} save(true); return; }
    if (b.dataset.brake) { const k = b.dataset.brake, d = deck(k); if (d.el.paused) return; const r0 = d.el.playbackRate, t0 = performance.now(); const step = () => { const p = (performance.now() - t0) / 800; if (p >= 1) { d.el.pause(); d.el.playbackRate = S[k].rate || 1; if (S[k].playing) { S[k].playing = false; S[k].pos = d.el.currentTime; paintOwner(); save(true); } return; } d.el.playbackRate = Math.max(0.02, r0 * (1 - p)); requestAnimationFrame(step); }; step(); return; }
    if (b.dataset.hot) { if (hotTimer === "done") { hotTimer = null; return; } const [k, n] = b.dataset.hot.split(":"), d = deck(k), i = +n - 1; if (d.cues[i] == null) { d.cues[i] = d.el.currentTime || 0; say("Cue " + n + " set at " + fmt(d.cues[i])); } else { try { d.el.currentTime = d.cues[i]; } catch (_) {} if (S[k].playing) S[k].start = Date.now() - d.cues[i] * 1000; save(true); } paintCues(k); return; }
    if (b.dataset.loop) { const [k, secs] = b.dataset.loop.split(":"), d = deck(k); if (d.loop && Math.round(d.loop[1] - d.loop[0]) === +secs) d.loop = null; else { const st = d.el.currentTime || 0; d.loop = [st, st + (+secs)]; say("Looping " + secs + "s on deck " + k); } paintCues(k); return; }
    if (b.dataset.sync) { const k = b.dataset.sync, o = k === "A" ? "B" : "A"; S[k].rate = S[o].rate || 1; deck(k).el.playbackRate = S[k].rate; if (S[k].playing) { /* keep position honest */ S[k].start = Date.now() - deck(k).el.currentTime * 1000; } paintOwner(); save(true); say("Deck " + k + " speed matched to deck " + o); return; }
  });
  // long-press a hot cue clears it
  let hotTimer = null;
  root.addEventListener("pointerdown", (e) => { const b = e.target.closest("[data-hot]"); if (!b || !OWNER()) return; hotTimer = setTimeout(() => { const [k, n] = b.dataset.hot.split(":"); deck(k).cues[+n - 1] = null; paintCues(k); say("Cue " + n + " cleared"); hotTimer = "done"; }, 650); });
  root.addEventListener("pointerup", (e) => { if (hotTimer === "done") { e.preventDefault(); return; } clearTimeout(hotTimer); hotTimer = null; }, true);
  root.addEventListener("input", (e) => {
    if (!OWNER()) return;
    const t = e.target;
    if (t.dataset.vol) { S[t.dataset.vol].vol = +t.value; levels(); save(); }
    if (t.dataset.pitch) { const k = t.dataset.pitch; S[k].rate = +t.value; deck(k).el.playbackRate = S[k].rate; deck(k).el.preservesPitch = !deck(k).vinyl; $("#pit-v-" + k).textContent = ((S[k].rate - 1) * 100).toFixed(1).replace("-", "−") + "%"; save(); }
    if (t.dataset.eq) { const [k, band] = t.dataset.eq.split(":"), d = deck(k); if (d.eq) d.eq[band].gain.value = +t.value; }
    if (t.id === "dj-xf") { S.xf = +t.value; levels(); save(); }
    if (t.id === "dj-master" && masterGain) masterGain.gain.value = +t.value;
    if (t.id === "dj-filter" && fxFilter) fxFilter.frequency.value = 200 * Math.pow(90, +t.value / 100);
    if (t.id === "dj-echo" && echoWet) echoWet.gain.value = +t.value;
    if (t.id === "dj-verb" && verbWet) verbWet.gain.value = +t.value;
  });
  root.addEventListener("change", (e) => { if (!OWNER()) return; if (e.target.dataset.vinyl != null) { const k = e.target.dataset.vinyl, d = deck(k); d.vinyl = e.target.checked; d.el.preservesPitch = !d.vinyl; } if (e.target.id === "ad-on") { S.autodj = e.target.checked; save(true); say(S.autodj ? "Auto-DJ is running the station 🤖" : "Auto-DJ off — you're flying manual."); } });
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
  ["A", "B"].forEach((k) => {
    const pl = () => $("#pl-" + k); let drag = null;
    root.addEventListener("pointerdown", (e) => { if (e.target !== pl() || !OWNER()) return; drag = { x: e.clientX, was: !deck(k).el.paused }; deck(k).el.pause(); e.preventDefault(); });
    root.addEventListener("pointermove", (e) => { if (!drag) return; const d = deck(k), dx = e.clientX - drag.x; drag.x = e.clientX; try { d.el.currentTime = Math.max(0, Math.min((d.el.duration || 0) - 0.2, d.el.currentTime + dx * 0.06)); } catch (_) {} });
    root.addEventListener("pointerup", () => { if (!drag) return; const d = deck(k); if (drag.was) { d.el.play().catch(() => {}); if (S[k].playing) S[k].start = Date.now() - d.el.currentTime * 1000; } else if (S[k]) S[k].pos = d.el.currentTime; drag = null; save(true); });
  });
  // deck ended -> owner bookkeeping + Auto-DJ
  ["A", "B"].forEach((k) => setTimeout(() => deck(k).el.addEventListener("ended", () => { if (OWNER() && !listening) { S[k].playing = false; S[k].pos = 0; paintOwner(); save(true); autoNext(k); } if (listening && !OWNER()) { /* listeners follow the doc */ } }), 0));

  /* ---------- Auto-DJ queue ---------- */
  let queue = []; try { queue = JSON.parse(localStorage.getItem("mw-dj-queue") || "[]"); } catch (_) {}
  const saveQueue = () => { try { localStorage.setItem("mw-dj-queue", JSON.stringify(queue)); } catch (_) {} };
  function paintQueue() { const box = $("#ad-queue"); if (!box) return; box.innerHTML = queue.length ? queue.map((q, i) => `<div class="dj-item"><span title="${E(q.title)}">${i + 1}. ${E(q.title)}</span><button class="btn ghost sm" type="button" data-qdel="${i}">✕</button></div>`).join("") : '<small class="muted">Queue is empty — Auto-DJ pulls from the full library rotation.</small>'; }
  root.addEventListener("click", (e) => { const b = e.target.closest("[data-qdel]"); if (b) { queue.splice(+b.dataset.qdel, 1); saveQueue(); paintQueue(); } });
  /* the library rotation: a shuffled bag of the whole library, refilled when it runs out —
     this is what the station plays on Auto-DJ when the hand-picked queue is empty */
  let bag = [], lastTitle = "";
  function nextFromLibrary() {
    if (!bag.length) { bag = TRACKS().map((t) => ({ src: URLOF(t), title: t.title, cover: t.cover || "" })).filter((x) => okUrl(x.src)); for (let i = bag.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [bag[i], bag[j]] = [bag[j], bag[i]]; } }
    if (!bag.length) return null;
    let item = bag.pop();
    if (item.title === lastTitle && bag.length) { const other = bag.pop(); bag.push(item); item = other; }
    lastTitle = item.title;
    return item;
  }
  let xfAnim = null;
  function autoNext(endedK) {
    if (!S.autodj) return;
    const item = queue.length ? queue.shift() : nextFromLibrary();
    if (!item) return;
    saveQueue(); paintQueue();
    const target = endedK === "A" ? "B" : "A";
    const idPad = (S.pads || [])[0]; if (idPad && okUrl(idPad.url)) { S.voice = { id: idPad.id, url: idPad.url, at: Date.now() }; }
    load(target, item).then(async () => {
      await togglePlay(target);
      const from = S.xf, to = target === "A" ? 0 : 1, t0 = performance.now();
      clearInterval(xfAnim); xfAnim = setInterval(() => { const p = Math.min(1, (performance.now() - t0) / 3500); S.xf = from + (to - from) * p; $("#dj-xf").value = S.xf; levels(); if (p >= 1) { clearInterval(xfAnim); save(true); } }, 100);
    });
  }

  /* ---------- jingle / spot board ---------- */
  const SYNTH = [
    { name: "📯 Air Horn", fn() { const c = actx(), t = c.currentTime; [392, 494, 587].forEach((f) => { const o = c.createOscillator(), g = c.createGain(); o.type = "sawtooth"; o.frequency.value = f; g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.16, t + 0.03); g.gain.setValueAtTime(0.16, t + 0.55); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.8); o.connect(g); g.connect(masterIn); o.start(t); o.stop(t + 0.85); }); } },
    { name: "🚨 Siren", fn() { const c = actx(), t = c.currentTime, o = c.createOscillator(), g = c.createGain(); o.type = "square"; o.frequency.setValueAtTime(700, t); for (let i = 0; i < 4; i++) { o.frequency.linearRampToValueAtTime(1400, t + i * 0.36 + 0.18); o.frequency.linearRampToValueAtTime(700, t + i * 0.36 + 0.36); } g.gain.setValueAtTime(0.07, t); g.gain.setValueAtTime(0.07, t + 1.4); g.gain.linearRampToValueAtTime(0.0001, t + 1.55); o.connect(g); g.connect(masterIn); o.start(t); o.stop(t + 1.6); } },
    { name: "🔫 Laser", fn() { const c = actx(), t = c.currentTime, o = c.createOscillator(), g = c.createGain(); o.type = "sawtooth"; o.frequency.setValueAtTime(2400, t); o.frequency.exponentialRampToValueAtTime(120, t + 0.28); g.gain.setValueAtTime(0.12, t); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.3); o.connect(g); g.connect(masterIn); o.start(t); o.stop(t + 0.32); } },
    { name: "✨ Sting", fn() { const c = actx(), t = c.currentTime; [523, 659, 784, 1047].forEach((f, i) => { const o = c.createOscillator(), g = c.createGain(); o.type = "triangle"; o.frequency.value = f; const st = t + i * 0.09; g.gain.setValueAtTime(0.0001, st); g.gain.exponentialRampToValueAtTime(0.18, st + 0.02); g.gain.exponentialRampToValueAtTime(0.0001, st + 0.9); o.connect(g); g.connect(masterIn); o.start(st); o.stop(st + 0.95); }); } },
  ];
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
  root.addEventListener("pointerdown", (e) => { const b = e.target.closest("[data-pad]"); if (!b) return; padPress = setTimeout(() => { const p = (S.pads || [])[+b.dataset.pad]; if (p && okUrl(p.url)) { S.voice = { id: p.id, url: p.url, at: Date.now() }; heardVoice = p.id; save(true); say("Drop sent out over the air 📡"); } padPress = "done"; }, 650); });
  root.addEventListener("pointerup", () => { clearTimeout(padPress); if (padPress !== "done") padPress = null; }, true);
  root.addEventListener("click", async (e) => {
    const s = e.target.closest("[data-synth]"); if (s && OWNER()) { SYNTH[+s.dataset.synth].fn(); return; }
    const pb = e.target.closest("[data-pad]"); if (pb && OWNER()) { if (padPress === "done") { padPress = null; return; } const p = (S.pads || [])[+pb.dataset.pad]; if (p) playPadUrl(p.url); return; }
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
  let reqSubbed = false;
  function renderReqs(docs) {
    const box = $("#rq-list"); if (!box) return;
    const rows = docs.map((x) => ({ id: x.id, data: x.data() || {} })).sort((a, b) => (b.data.at || 0) - (a.data.at || 0)).slice(0, 30);
    box.innerHTML = rows.length ? rows.map((r) => r.data.kind === "voice"
      ? `<div class="req"><b>🎙️ Voice drop</b><small>${agoT(r.data.at || Date.now())}</small><span style="display:flex;gap:6px;flex-wrap:wrap"><button class="btn ghost sm" type="button" data-rqplay="${E(r.data.url)}">▶ Hear it</button><button class="btn sm" type="button" data-rqair="${E(r.id)}|${E(r.data.url)}|${E(r.data.asset || "")}">📡 Play on air</button><button class="btn ghost sm" type="button" data-rqdone="${E(r.id)}">✓ Done</button></span></div>`
      : `<div class="req"><span>${E(r.data.text || "")}</span><small>${agoT(r.data.at || Date.now())}</small><span><button class="btn ghost sm" type="button" data-rqdone="${E(r.id)}">✓ Played</button></span></div>`).join("") : '<small class="muted">Nothing yet. Listener requests land here.</small>';
  }
  function subReqs() {
    if (reqSubbed || !OWNER()) return; const d = DBF(); if (!d) return; reqSubbed = true;
    try { d.collection("requests").limit(40).onSnapshot((s) => renderReqs(s.docs), () => {}); } catch (_) { reqSubbed = false; }
  }
  root.addEventListener("click", async (e) => {
    const p = e.target.closest("[data-rqplay]"); if (p) { new Audio(p.dataset.rqplay).play().catch(() => {}); return; }
    const air = e.target.closest("[data-rqair]"); if (air && OWNER()) { const [id, url, asset] = air.dataset.rqair.split("|"); S.voice = { id: asset || id, url, at: Date.now() }; heardVoice = S.voice.id; save(true); say("Drop is on the air 📡"); DBF()?.doc("requests/" + id).delete().catch(() => {}); return; }
    const dn = e.target.closest("[data-rqdone]"); if (dn && OWNER()) { DBF()?.doc("requests/" + dn.dataset.rqdone).delete().catch(() => {}); }
  });

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
    try { net = await iaSearch(q); $("#dj-net").innerHTML = net.length ? net.map((n, i) => `<div class="dj-item"><span title="${E(n.title)}">${E(n.title)}</span><button class="btn ghost sm" type="button" data-load="A" data-net="${i}">A</button><button class="btn ghost sm" type="button" data-load="B" data-net="${i}">B</button></div>`).join("") : '<small class="muted">Nothing found. Try another word.</small>'; }
    catch (_) { $("#dj-net").innerHTML = '<small class="muted">Search is busy. Try again in a moment.</small>'; }
  });

  /* ---------- start ---------- */
  async function init() {
    if (!window.claude) return;
    const d = await claude.use("db"); if (!d) return;
    d.doc("radio/dj").onSnapshot((snap) => onState(snap.exists ? snap.data() : null), () => {});
    const show = () => { const own = OWNER(); $("#dj-owner").hidden = !own; if (own) { libList(); paintOwner(); paintQueue(); paintPads(); subReqs(); const ti = $("#dj-ticker-in"); if (ti && document.activeElement !== ti) ti.value = S.ticker || ""; } };
    show(); setTimeout(show, 1500); setTimeout(show, 5000);
    setInterval(() => { if (OWNER() && !$("#dj-owner").hidden && $("#dj-lib").children.length !== TRACKS().length) libList(); }, 4000);
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init); else init();
})();
