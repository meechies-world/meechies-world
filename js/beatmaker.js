/* Meechie's World Beat Maker: make beats right in the Studio.
 * 16-step sequencer with 808 kick, snare, clap, hi-hats (with rolls), open hat, rim, an 808 bass and keys you
 * play in a key and scale. Every sound is made live in the browser (no samples, so nothing to license).
 * Presets (Trap, Drill, Boom Bap, R&B), BPM, swing, per-row volume and mute, and it saves itself on this device.
 * "Send to Studio" turns the beat into a track in the recording studio below so you can record vocals over it;
 * "Download WAV" saves the beat as a file. */
(function () {
  "use strict";
  const root = document.getElementById("bm-root");
  if (!root) return;
  const say = (t) => (typeof toast === "function" ? toast(t) : null);

  /* ---------- the beat ---------- */
  const ROWS = [
    { id: "kick", name: "808 Kick", kind: "drum" },
    { id: "snare", name: "Snare", kind: "drum" },
    { id: "clap", name: "Clap", kind: "drum" },
    { id: "hat", name: "Hi-Hat", kind: "hat" },
    { id: "ohat", name: "Open Hat", kind: "drum" },
    { id: "rim", name: "Rim", kind: "drum" },
    { id: "bass", name: "808 Bass", kind: "note", oct: 1 },
    { id: "keys", name: "Keys", kind: "note", oct: 4 },
  ];
  const STEPS = 16;
  const NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
  const SCALES = { minor: [0, 2, 3, 5, 7, 8, 10], major: [0, 2, 4, 5, 7, 9, 11], dark: [0, 1, 3, 5, 7, 8, 10], harmonic: [0, 2, 3, 5, 7, 8, 11] };
  const SCALE_NAMES = { minor: "Minor", major: "Major", dark: "Dark (Phrygian)", harmonic: "Harmonic minor" };
  const empty = () => Object.fromEntries(ROWS.map((r) => [r.id, Array(STEPS).fill(r.kind === "note" ? null : 0)]));
  const def = () => ({ bpm: 140, swing: 0, key: 0, scale: "minor", keysSound: "keys", bassLen: 0.9, glide: true, bars: 8,
    vol: Object.fromEntries(ROWS.map((r) => [r.id, r.id === "keys" ? 0.55 : r.id === "rim" ? 0.6 : 0.85])), mute: {}, steps: empty() });
  let S = def();
  try { const s = JSON.parse(localStorage.getItem("mw_beat") || "null"); if (s && s.steps) S = { ...def(), ...s, steps: { ...empty(), ...s.steps }, vol: { ...def().vol, ...(s.vol || {}) } }; } catch (_) {}
  let curDeg = 0; // the note (scale step, 0-13) you paint onto the 808 and Keys rows
  const save = () => { try { localStorage.setItem("mw_beat", JSON.stringify(S)); } catch (_) {} };

  // notes: a scale step (0..13 = two octaves) -> MIDI note for a row
  const midiOf = (row, deg) => { const sc = SCALES[S.scale] || SCALES.minor; const o = Math.floor(deg / sc.length); return 12 * (row.oct + 1) + S.key + sc[deg % sc.length] + 12 * o; };
  const hz = (m) => 440 * Math.pow(2, (m - 69) / 12);
  const noteLabel = (row, deg) => { const m = midiOf(row, deg); return NOTE_NAMES[m % 12] + (Math.floor(m / 12) - 1); };

  /* ---------- presets ---------- */
  function preset(name) {
    const st = empty(), set = (id, hits) => hits.forEach((i) => { st[id][i] = 1; });
    if (name === "trap") {
      S.bpm = 140; S.swing = 0;
      set("kick", [0, 7, 10]); set("clap", [8]); set("snare", [8]);
      st.hat = [1, 0, 1, 0, 1, 0, 2, 0, 1, 0, 1, 0, 3, 0, 1, 1]; set("ohat", [14]);
      st.bass[0] = 0; st.bass[7] = 0; st.bass[10] = 3; st.keys[0] = 7; st.keys[3] = 9; st.keys[6] = 11; st.keys[8] = 7; st.keys[11] = 6;
    } else if (name === "drill") {
      S.bpm = 142; S.swing = 0;
      set("kick", [0, 10]); set("snare", [8]); set("clap", [8]); set("rim", [3, 13]);
      st.hat = [1, 0, 0, 1, 0, 0, 1, 0, 2, 0, 1, 0, 0, 1, 3, 0]; set("ohat", [6]);
      st.bass[0] = 0; st.bass[10] = 1; st.bass[13] = 2; st.keys[0] = 7; st.keys[4] = 8; st.keys[8] = 7; st.keys[12] = 5;
    } else if (name === "boombap") {
      S.bpm = 90; S.swing = 0.5;
      set("kick", [0, 3, 10]); set("snare", [4, 12]); set("hat", [0, 2, 4, 6, 8, 10, 12, 14]); set("ohat", [7]); set("rim", [15]);
      st.bass[0] = 0; st.bass[3] = 0; st.bass[10] = 4; st.keys[0] = 7; st.keys[6] = 9; st.keys[12] = 8;
    } else if (name === "rnb") {
      S.bpm = 72; S.swing = 0.25;
      set("kick", [0, 6, 9]); set("snare", [4, 12]); set("clap", [12]); set("hat", [0, 2, 4, 6, 8, 10, 12, 14]); set("rim", [7]);
      st.bass[0] = 0; st.bass[6] = 2; st.bass[9] = 4; st.keys[0] = 9; st.keys[4] = 11; st.keys[8] = 7; st.keys[12] = 8;
    }
    S.steps = st; save(); paint();
  }

  /* ---------- sounds (made live, for playing and for saving) ---------- */
  const noiseCache = new WeakMap();
  function noise(ctx) {
    let b = noiseCache.get(ctx); if (b) return b;
    b = ctx.createBuffer(1, ctx.sampleRate * 1, ctx.sampleRate); const d = b.getChannelData(0); for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    noiseCache.set(ctx, b); return b;
  }
  const env = (g, t, peak, attack, decay) => { g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(peak, t + attack); g.gain.exponentialRampToValueAtTime(0.0001, t + attack + decay); };
  function nz(ctx, out, t, dur, type, freq, q, peak) {
    const s = ctx.createBufferSource(); s.buffer = noise(ctx); const f = ctx.createBiquadFilter(); f.type = type; f.frequency.value = freq; if (q) f.Q.value = q;
    const g = ctx.createGain(); env(g, t, peak, 0.002, dur); s.connect(f); f.connect(g); g.connect(out); s.start(t); s.stop(t + dur + 0.05);
  }
  function osc(ctx, out, t, type, f0, f1, glideT, peak, attack, decay) {
    const o = ctx.createOscillator(); o.type = type; o.frequency.setValueAtTime(f0, t); if (f1 && f1 !== f0) o.frequency.exponentialRampToValueAtTime(f1, t + glideT);
    const g = ctx.createGain(); env(g, t, peak, attack, decay); o.connect(g); g.connect(out); o.start(t); o.stop(t + attack + decay + 0.05); return o;
  }
  let lastBass = null; // for 808 glides while playing live
  function hit(ctx, out, row, t, val, stepDur, prevBassDeg) {
    const v = S.vol[row.id] ?? 0.8; if (!v || S.mute[row.id]) return;
    const g = ctx.createGain(); g.gain.value = v; g.connect(out); const o = g;
    switch (row.id) {
      case "kick": osc(ctx, o, t, "sine", 160, 42, 0.11, 1, 0.003, 0.42); nz(ctx, o, t, 0.012, "highpass", 3000, 0, 0.25); break;
      case "snare": nz(ctx, o, t, 0.2, "bandpass", 1900, 0.8, 0.9); nz(ctx, o, t, 0.12, "highpass", 5000, 0, 0.35); osc(ctx, o, t, "triangle", 210, 170, 0.08, 0.5, 0.002, 0.11); break;
      case "clap": [0, 0.011, 0.022].forEach((d) => nz(ctx, o, t + d, 0.03, "bandpass", 1500, 1.2, 0.8)); nz(ctx, o, t + 0.03, 0.2, "bandpass", 1300, 0.9, 0.6); break;
      case "hat": { const n = val >= 2 ? val : 1; for (let k = 0; k < n; k++) nz(ctx, o, t + (k * stepDur) / n, 0.045, "highpass", 7600, 0, n > 1 ? 0.45 : 0.55); break; }
      case "ohat": nz(ctx, o, t, 0.32, "highpass", 6800, 0, 0.45); break;
      case "rim": osc(ctx, o, t, "square", 1700, 900, 0.02, 0.35, 0.001, 0.04); nz(ctx, o, t, 0.03, "bandpass", 2600, 2, 0.4); break;
      case "bass": {
        const f = hz(midiOf(row, val)), from = S.glide && prevBassDeg != null && prevBassDeg !== val ? hz(midiOf(row, prevBassDeg)) : f * 1.02;
        const sat = ctx.createWaveShaper(); const c = new Float32Array(512); for (let i = 0; i < 512; i++) { const x = i / 255.5 - 1; c[i] = Math.tanh(2.2 * x); } sat.curve = c;
        const lp = ctx.createBiquadFilter(); lp.type = "lowpass"; lp.frequency.value = 900; sat.connect(lp); lp.connect(o);
        osc(ctx, sat, t, "sine", from, f, S.glide ? 0.07 : 0.03, 0.9, 0.004, S.bassLen); break;
      }
      case "keys": {
        const f = hz(midiOf(row, val)), lp = ctx.createBiquadFilter(); lp.type = "lowpass"; lp.connect(o);
        if (S.keysSound === "pad") { lp.frequency.value = 1800; osc(ctx, lp, t, "sawtooth", f, 0, 0, 0.18, 0.08, 1.4); osc(ctx, lp, t, "sawtooth", f * 1.006, 0, 0, 0.18, 0.08, 1.4); }
        else if (S.keysSound === "pluck") { lp.frequency.value = 2600; osc(ctx, lp, t, "square", f, 0, 0, 0.22, 0.002, 0.22); osc(ctx, lp, t, "triangle", f * 2, 0, 0, 0.12, 0.002, 0.15); }
        else { lp.frequency.value = 3200; osc(ctx, lp, t, "triangle", f, 0, 0, 0.45, 0.004, 0.75); osc(ctx, lp, t, "sine", f * 2, 0, 0, 0.18, 0.003, 0.5); osc(ctx, lp, t, "sine", f * 4, 0, 0, 0.05, 0.002, 0.2); }
        break;
      }
    }
  }
  function masterChain(ctx) {
    const comp = ctx.createDynamicsCompressor(); comp.threshold.value = -10; comp.knee.value = 8; comp.ratio.value = 4; comp.attack.value = 0.003; comp.release.value = 0.15;
    const g = ctx.createGain(); g.gain.value = 0.9; comp.connect(g); g.connect(ctx.destination); return comp;
  }
  const stepDur = () => 60 / S.bpm / 4;
  const stepTime = (i) => i * stepDur() + (i % 2 ? S.swing * stepDur() * 0.5 : 0);
  function scheduleStep(ctx, out, i, t0) {
    const s = i % STEPS, sd = stepDur();
    ROWS.forEach((row) => {
      const val = S.steps[row.id][s];
      if (row.kind === "note") { if (val == null) return; }
      else if (!val) return;
      let prev = null;
      if (row.id === "bass") { for (let k = 1; k < STEPS; k++) { const p = S.steps.bass[(s - k + STEPS) % STEPS]; if (p != null) { prev = p; break; } } }
      hit(ctx, out, row, t0 + stepTime(i), val, sd, prev);
    });
  }

  /* ---------- live playback ---------- */
  let ctx = null, out = null, playing = false, nextStep = 0, startT = 0, timer = 0, raf = 0;
  const live = () => { if (!ctx) { ctx = new (window.AudioContext || window.webkitAudioContext)(); out = masterChain(ctx); } if (ctx.state === "suspended") ctx.resume(); return ctx; };
  function play() {
    live(); try { if (typeof media !== "undefined" && !media.paused) media.pause(); } catch (_) {} // stop the radio while you work
    playing = true; nextStep = 0; startT = ctx.currentTime + 0.08;
    const loop = () => {
      if (!playing) return;
      while (startT + stepTime(nextStep) < ctx.currentTime + 0.15) {
        // keep the clock steady even when you change BPM mid-loop
        scheduleStep(ctx, out, nextStep, startT); nextStep++;
        if (nextStep % STEPS === 0) { startT += STEPS * stepDur(); nextStep = 0; }
      }
      timer = setTimeout(loop, 25);
    };
    loop(); tick(); paintTransport();
  }
  function stop() { playing = false; clearTimeout(timer); cancelAnimationFrame(raf); root.querySelectorAll(".bm-cell.now").forEach((c) => c.classList.remove("now")); paintTransport(); }
  function tick() {
    if (!playing) return;
    const el = ctx.currentTime - startT, sd = stepDur(); let s = Math.floor(el / sd); s = ((s % STEPS) + STEPS) % STEPS;
    root.querySelectorAll(".bm-cell.now").forEach((c) => c.classList.remove("now"));
    root.querySelectorAll(`.bm-cell[data-s="${s}"]`).forEach((c) => c.classList.add("now"));
    raf = requestAnimationFrame(tick);
  }

  /* ---------- saving a beat as audio ---------- */
  async function renderBeat(bars) {
    const sr = 44100, steps = bars * STEPS, len = steps * stepDur() + 2;
    const oc = new OfflineAudioContext(2, Math.ceil(len * sr), sr), o = masterChain(oc);
    for (let i = 0; i < steps; i++) scheduleStep(oc, o, i, 0.02);
    return oc.startRendering();
  }
  function wav(buf) {
    const ch = buf.numberOfChannels, n = buf.length, ab = new ArrayBuffer(44 + n * ch * 2), v = new DataView(ab), w = (o, s) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
    w(0, "RIFF"); v.setUint32(4, 36 + n * ch * 2, true); w(8, "WAVE"); w(12, "fmt "); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, ch, true); v.setUint32(24, buf.sampleRate, true);
    v.setUint32(28, buf.sampleRate * ch * 2, true); v.setUint16(32, ch * 2, true); v.setUint16(34, 16, true); w(36, "data"); v.setUint32(40, n * ch * 2, true);
    const data = Array.from({ length: ch }, (_, c) => buf.getChannelData(c)); let p = 44;
    for (let i = 0; i < n; i++) for (let c = 0; c < ch; c++) { const x = Math.max(-1, Math.min(1, data[c][i])); v.setInt16(p, x < 0 ? x * 0x8000 : x * 0x7fff, true); p += 2; }
    return new Blob([ab], { type: "audio/wav" });
  }
  const hasNotes = () => ROWS.some((r) => S.steps[r.id].some((x) => (r.kind === "note" ? x != null : x)));

  /* ---------- screen ---------- */
  const css = document.createElement("style");
  css.textContent = `
#bm-root{margin-bottom:22px;border:1px solid var(--gold-lo);border-radius:16px;background:linear-gradient(180deg,#17130c,#0d0b08);padding:14px;display:grid;gap:12px}
#bm-root .bm-title{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
#bm-root .bm-title h3{margin:0;font-family:var(--display);color:var(--gold-hi);letter-spacing:.06em;flex:1}
.bm-bar{display:flex;flex-wrap:wrap;gap:8px;align-items:center}
.bm-bar label{display:flex;align-items:center;gap:6px;font-size:13px;color:var(--muted)}
.bm-bar input[type=number],.bm-bar select{background:var(--ink);border:1px solid var(--line);border-radius:8px;color:var(--text);padding:6px 8px;font:14px var(--body)}
.bm-bar input[type=number]{width:70px}
.bm-btn{border:1px solid var(--gold-lo);background:transparent;color:var(--text);border-radius:999px;padding:8px 14px;font:600 14px var(--body);cursor:pointer;min-height:38px}
.bm-btn:hover{border-color:var(--gold)}.bm-btn.on,.bm-btn.go{background:var(--gold);color:var(--ink);border-color:var(--gold)}
.bm-grid-wrap{overflow-x:auto;-webkit-overflow-scrolling:touch;padding-bottom:4px}
.bm-grid{display:grid;grid-template-columns:118px repeat(16,minmax(30px,1fr)) 92px;gap:4px;min-width:760px;align-items:center}
.bm-name{display:flex;align-items:center;gap:6px;font:600 13px var(--body);color:var(--text);white-space:nowrap}
.bm-name button{border:1px solid var(--line);background:none;color:var(--muted);border-radius:6px;font:700 11px var(--mono);padding:3px 6px;cursor:pointer}
.bm-name button.on{background:#7a1f2b;color:#fff;border-color:#7a1f2b}
.bm-cell{height:38px;border-radius:7px;border:1px solid #2c261b;background:#1b1712;cursor:pointer;padding:0;color:var(--ink);font:700 10px var(--mono);position:relative}
.bm-cell.q{background:#221d15}
.bm-cell.on{background:var(--gold);border-color:var(--gold-hi);box-shadow:0 0 10px rgba(212,168,67,.4)}
.bm-cell.on.r2::after,.bm-cell.on.r3::after{content:attr(data-roll);position:absolute;right:3px;top:2px;font-size:9px}
.bm-cell.note{background:#3a2f17;color:var(--gold-hi);border-color:var(--gold-lo)}
.bm-cell.now{outline:2px solid #fff;outline-offset:-2px}
.bm-vol{width:88px;accent-color:var(--gold)}
.bm-notes{display:flex;flex-wrap:wrap;gap:6px;align-items:center}
.bm-notes button{border:1px solid var(--line);background:var(--ink);color:var(--text);border-radius:8px;padding:6px 9px;font:600 12px var(--mono);cursor:pointer;min-height:34px}
.bm-notes button.on{background:var(--gold);color:var(--ink);border-color:var(--gold)}
.bm-tip{font-size:12px;color:var(--muted);margin:0}
@media (max-width:640px){.bm-grid{grid-template-columns:92px repeat(16,30px) 72px;min-width:0}.bm-vol{width:66px}}`;
  document.head.appendChild(css);

  root.innerHTML = `
  <div class="bm-title"><h3>🥁 BEAT MAKER</h3><small class="muted">Tap the squares to make a beat. Then send it to the studio and record over it.</small></div>
  <div class="bm-bar">
    <button class="bm-btn go" type="button" id="bm-play">▶ Play</button>
    <label>BPM <input type="number" id="bm-bpm" min="50" max="200"></label>
    <label>Swing <input type="range" id="bm-swing" min="0" max="0.8" step="0.05" class="bm-vol"></label>
    <label>Key <select id="bm-key">${NOTE_NAMES.map((n, i) => `<option value="${i}">${n}</option>`).join("")}</select></label>
    <label><select id="bm-scale" aria-label="Scale">${Object.entries(SCALE_NAMES).map(([k, n]) => `<option value="${k}">${n}</option>`).join("")}</select></label>
    <label>Keys sound <select id="bm-ksnd"><option value="keys">Keys</option><option value="pad">Pad</option><option value="pluck">Pluck</option></select></label>
    <label>808 length <input type="range" id="bm-blen" min="0.2" max="1.8" step="0.05" class="bm-vol"></label>
    <label><input type="checkbox" id="bm-glide"> 808 glide</label>
  </div>
  <div class="bm-bar"><span class="muted" style="font-size:13px">Start from:</span>
    <button class="bm-btn" type="button" data-preset="trap">Trap</button><button class="bm-btn" type="button" data-preset="drill">Drill</button>
    <button class="bm-btn" type="button" data-preset="boombap">Boom Bap</button><button class="bm-btn" type="button" data-preset="rnb">R&amp;B</button>
    <button class="bm-btn" type="button" data-preset="clear">Clear</button></div>
  <div class="bm-notes" id="bm-notes"></div>
  <div class="bm-grid-wrap"><div class="bm-grid" id="bm-grid"></div></div>
  <p class="bm-tip">Hi-Hat: tap a lit square again for a roll (x2, then x3). 808 Bass and Keys: pick a note above, then tap the squares to place it. Tap a placed note again to remove it.</p>
  <div class="bm-bar">
    <label>Length <select id="bm-bars"><option value="4">4 bars</option><option value="8">8 bars</option><option value="16">16 bars</option><option value="32">32 bars</option></select></label>
    <button class="bm-btn go" type="button" id="bm-send">➕ Send to Studio</button>
    <button class="bm-btn" type="button" id="bm-dl">⬇ Download WAV</button>
    <small class="muted" id="bm-st"></small>
  </div>`;
  const $ = (s) => root.querySelector(s);

  function paintNotes() {
    const bass = ROWS.find((r) => r.id === "bass"), deg = SCALES[S.scale].length * 2;
    $("#bm-notes").innerHTML = '<span class="muted" style="font-size:13px">Note:</span>' + Array.from({ length: deg }, (_, d) => `<button type="button" data-deg="${d}" class="${d === curDeg ? "on" : ""}">${noteLabel(bass, d).replace(/\d+$/, "")}${d >= SCALES[S.scale].length ? "↑" : ""}</button>`).join("");
  }
  function paintGrid() {
    $("#bm-grid").innerHTML = ROWS.map((r) => {
      const cells = S.steps[r.id].map((v, s) => {
        const q = Math.floor(s / 4) % 2 ? " q" : "";
        if (r.kind === "note") return `<button type="button" class="bm-cell${q}${v != null ? " on note" : ""}" data-r="${r.id}" data-s="${s}" aria-label="${r.name} step ${s + 1}${v != null ? ", " + noteLabel(r, v) : ""}">${v != null ? noteLabel(r, v).replace(/\d+$/, "") : ""}</button>`;
        return `<button type="button" class="bm-cell${q}${v ? " on" : ""}${v >= 2 ? " r" + v : ""}" data-roll="x${v}" data-r="${r.id}" data-s="${s}" aria-label="${r.name} step ${s + 1}${v ? " on" : ""}" aria-pressed="${!!v}"></button>`;
      }).join("");
      return `<div class="bm-name">${r.name}<button type="button" data-mute="${r.id}" class="${S.mute[r.id] ? "on" : ""}" aria-label="Mute ${r.name}">M</button></div>${cells}<input type="range" class="bm-vol" min="0" max="1.2" step="0.05" value="${S.vol[r.id]}" data-vol="${r.id}" aria-label="${r.name} volume">`;
    }).join("");
  }
  function paintTransport() { const b = $("#bm-play"); b.textContent = playing ? "■ Stop" : "▶ Play"; b.classList.toggle("on", playing); }
  function paint() {
    $("#bm-bpm").value = S.bpm; $("#bm-swing").value = S.swing; $("#bm-key").value = S.key; $("#bm-scale").value = S.scale; $("#bm-ksnd").value = S.keysSound;
    $("#bm-blen").value = S.bassLen; $("#bm-glide").checked = !!S.glide; $("#bm-bars").value = S.bars;
    paintNotes(); paintGrid(); paintTransport();
  }

  root.addEventListener("click", async (e) => {
    const b = e.target.closest("button"); if (!b) return;
    if (b.id === "bm-play") { playing ? stop() : play(); return; }
    if (b.dataset.preset) { if (b.dataset.preset === "clear") { S.steps = empty(); save(); paint(); } else preset(b.dataset.preset); return; }
    if (b.dataset.deg != null) { curDeg = +b.dataset.deg; paintNotes(); const r = ROWS.find((x) => x.id === "keys"); live(); hit(ctx, out, r, ctx.currentTime + 0.01, curDeg, stepDur(), null); return; }
    if (b.dataset.mute) { S.mute[b.dataset.mute] = !S.mute[b.dataset.mute]; save(); paintGrid(); return; }
    if (b.dataset.r) {
      const row = ROWS.find((r) => r.id === b.dataset.r), s = +b.dataset.s, arr = S.steps[row.id];
      if (row.kind === "note") arr[s] = arr[s] === curDeg ? null : curDeg;
      else if (row.kind === "hat") arr[s] = (arr[s] + 1) % 4;   // off → on → roll x2 → roll x3 → off
      else arr[s] = arr[s] ? 0 : 1;
      // let them hear what they placed
      const val = arr[s]; if ((row.kind === "note" && val != null) || (row.kind !== "note" && val)) { live(); hit(ctx, out, row, ctx.currentTime + 0.01, val, stepDur(), null); }
      save(); paintGrid(); return;
    }
    if (b.id === "bm-send" || b.id === "bm-dl") {
      if (!hasNotes()) { say("Tap some squares first (or pick a preset) to make a beat."); return; }
      const st = $("#bm-st"), bars = +S.bars || 8; b.disabled = true; st.textContent = "Making your beat...";
      try {
        const buf = await renderBeat(bars), name = "Beat " + S.bpm + " BPM";
        if (b.id === "bm-dl") {
          const a = document.createElement("a"); a.href = URL.createObjectURL(wav(buf)); a.download = "meechies-world-beat-" + S.bpm + "bpm.wav"; document.body.appendChild(a); a.click(); a.remove();
          setTimeout(() => URL.revokeObjectURL(a.href), 30000); st.textContent = "Saved " + bars + " bars as a WAV file.";
        } else if (window.MW_STUDIO && window.MW_STUDIO.addBeat(name, buf, S.bpm)) {
          stop(); st.textContent = "Sent! It's on a track in the studio below."; document.getElementById("bl-root")?.scrollIntoView({ behavior: "smooth", block: "start" }); say("Your beat is in the studio");
        } else st.textContent = "The studio is full. Delete a track below, then send it again.";
      } catch (err) { st.textContent = "Couldn't make the beat: " + (err.message || err); }
      b.disabled = false;
    }
  });
  root.addEventListener("input", (e) => {
    const t = e.target;
    if (t.dataset.vol) { S.vol[t.dataset.vol] = +t.value; save(); return; }
    if (t.id === "bm-swing") S.swing = +t.value; else if (t.id === "bm-blen") S.bassLen = +t.value; else return; save();
  });
  root.addEventListener("change", (e) => {
    const t = e.target;
    if (t.id === "bm-bpm") { S.bpm = Math.max(50, Math.min(200, +t.value || 140)); t.value = S.bpm; }
    else if (t.id === "bm-key") S.key = +t.value;
    else if (t.id === "bm-scale") { S.scale = t.value; curDeg = Math.min(curDeg, SCALES[S.scale].length * 2 - 1); }
    else if (t.id === "bm-ksnd") S.keysSound = t.value;
    else if (t.id === "bm-glide") S.glide = t.checked;
    else if (t.id === "bm-bars") S.bars = +t.value;
    else return;
    save(); paintNotes(); paintGrid();
  });
  // space bar plays/stops while you're using the beat maker (not while typing in a box)
  root.addEventListener("keydown", (e) => {
    if (e.code !== "Space" || /input|textarea|select/i.test(e.target.tagName)) return;
    e.preventDefault(); playing ? stop() : play();
  });
  // stop when leaving the Studio page
  const view = document.getElementById("v-studio");
  if (view) new MutationObserver(() => { if (view.hidden) stop(); }).observe(view, { attributes: true, attributeFilter: ["hidden"] });
  document.addEventListener("visibilitychange", () => { if (document.hidden) stop(); });

  if (!hasNotes()) { const keep = S; preset("trap"); S.bpm = keep.bpm || 140; } // first visit: start with a trap beat to play with
  paint();
  window.MW_BEAT = { render: renderBeat, state: () => S }; // for testing
})();
