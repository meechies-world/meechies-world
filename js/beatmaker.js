/* Meechie's World Beat Maker Pro — make full beats right in the Studio.
 *
 *  • 4 drum kits (Trap 808, Drill, Boom Bap, Lo-Fi) and 11 instruments: kick, snare, clap, hi-hat, open hat, rim,
 *    perc, crash, 808 bass (with glide), keys (single notes or chords) and lead.
 *  • Paint steps as Normal, Accent, Soft or hi-hat Rolls (x2 / x3). 16 or 32 steps per pattern.
 *  • Patterns A–D and a Song mode that chains them (A A B A ...). Copy patterns, randomize hats, humanize.
 *  • Every instrument has volume, pan, pitch, length, reverb and delay, plus mute/solo.
 *  • Master effects: reverb, tempo-synced delay, lo-fi, sidechain pump, master volume, and a level meter.
 *  • Drum pads you can tap (or play with keys 1–8) and record live into the pattern.
 *  • Tap tempo, undo/redo, a beat library saved on this device, Download WAV and Send to Studio.
 *  All sounds are made live in the browser (no samples, so nothing to license). */
(function () {
  "use strict";
  const root = document.getElementById("bm-root");
  if (!root) return;
  const say = (t) => (typeof toast === "function" ? toast(t) : null);
  const E = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const clone = (o) => JSON.parse(JSON.stringify(o));

  /* ================= instruments, kits, scales ================= */
  const ROWS = [
    { id: "kick", name: "Kick", kind: "drum", key: "1" },
    { id: "snare", name: "Snare", kind: "drum", key: "2" },
    { id: "clap", name: "Clap", kind: "drum", key: "3" },
    { id: "hat", name: "Hi-Hat", kind: "hat", key: "4" },
    { id: "ohat", name: "Open Hat", kind: "drum", key: "5" },
    { id: "rim", name: "Rim", kind: "drum", key: "6" },
    { id: "perc", name: "Perc", kind: "drum", key: "7" },
    { id: "crash", name: "Crash", kind: "drum", key: "8" },
    { id: "bass", name: "808 Bass", kind: "note", oct: 1 },
    { id: "keys", name: "Keys", kind: "note", oct: 4 },
    { id: "lead", name: "Lead", kind: "note", oct: 5 },
  ];
  const DRUMS = ROWS.filter((r) => r.kind !== "note");
  const KITS = {
    trap: { name: "Trap 808", kick: [165, 40, 0.11, 0.5], snareF: 1900, snareDec: 0.2, hatF: 7800, hatDec: 0.045, tone: 1 },
    drill: { name: "Drill", kick: [150, 38, 0.13, 0.55], snareF: 2300, snareDec: 0.17, hatF: 8400, hatDec: 0.035, tone: 1.1 },
    boombap: { name: "Boom Bap", kick: [120, 52, 0.07, 0.3], snareF: 1500, snareDec: 0.26, hatF: 6400, hatDec: 0.06, tone: 0.9 },
    lofi: { name: "Lo-Fi", kick: [110, 48, 0.08, 0.32], snareF: 1300, snareDec: 0.22, hatF: 5200, hatDec: 0.07, tone: 0.8 },
  };
  const NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
  const SCALES = { minor: [0, 2, 3, 5, 7, 8, 10], major: [0, 2, 4, 5, 7, 9, 11], dark: [0, 1, 3, 5, 7, 8, 10], harmonic: [0, 2, 3, 5, 7, 8, 11], blues: [0, 3, 5, 6, 7, 10] };
  const SCALE_NAMES = { minor: "Minor", major: "Major", dark: "Dark (Phrygian)", harmonic: "Harmonic minor", blues: "Blues" };
  const PAINTS = [["normal", "● Normal"], ["accent", "▲ Accent"], ["soft", "○ Soft"], ["roll2", "x2 Roll"], ["roll3", "x3 Roll"], ["erase", "✕ Erase"]];
  const VEL = { normal: 0.8, accent: 1, soft: 0.45 };
  const PATS = ["A", "B", "C", "D"];

  /* ================= the beat (state) ================= */
  const emptyPattern = (n) => Object.fromEntries(ROWS.map((r) => [r.id, Array(n).fill(null)]));
  const rowDefaults = () => Object.fromEntries(ROWS.map((r) => [r.id, {
    vol: { keys: 0.55, lead: 0.45, rim: 0.6, perc: 0.6, crash: 0.5 }[r.id] ?? 0.85, pan: { hat: 0.15, ohat: 0.2, rim: -0.2, perc: -0.25, lead: 0.15 }[r.id] ?? 0,
    pitch: 0, decay: 1, rev: { snare: 0.15, clap: 0.2, keys: 0.3, lead: 0.35, crash: 0.25 }[r.id] ?? 0, dly: { lead: 0.25, keys: 0.1 }[r.id] ?? 0, mute: false, solo: false }]));
  const def = () => ({ v: 2, bpm: 140, swing: 0, key: 0, scale: "minor", kit: "trap", len: 16, pat: "A", mode: "pattern",
    patterns: Object.fromEntries(PATS.map((p) => [p, emptyPattern(16)])), song: ["A", "A", "B", "A"],
    rows: rowDefaults(), fx: { rev: 0.35, dly: 0.25, lofi: 0, pump: 0.25, master: 0.9 },
    keysMode: "chords", keysSound: "keys", leadSound: "bell", bassLen: 0.9, glide: true, bars: 8, repeats: 2 });
  let S = def();

  // load the last beat (and upgrade beats saved by the first beat maker)
  function upgrade(s) {
    if (!s) return null;
    if (s.v === 2) { const d = def(); return { ...d, ...s, rows: { ...d.rows, ...(s.rows || {}) }, fx: { ...d.fx, ...(s.fx || {}) }, patterns: { ...d.patterns, ...(s.patterns || {}) } }; }
    if (s.steps) { // first beat maker: one 16-step pattern, numbers for drums, scale steps for notes
      const n = def(); n.bpm = s.bpm || 140; n.swing = s.swing || 0; n.key = s.key || 0; n.scale = s.scale || "minor"; n.keysMode = "single";
      ROWS.forEach((r) => { const old = s.steps[r.id]; if (!old) return;
        n.patterns.A[r.id] = old.map((x) => (r.kind === "note" ? (x == null ? null : { n: x, v: 0.8 }) : x ? { v: 0.8, r: x >= 2 ? x : 1 } : null)); });
      return n;
    }
    return null;
  }
  try { const s = upgrade(JSON.parse(localStorage.getItem("mw_beat") || "null")); if (s) S = s; } catch (_) {}
  // make sure every pattern has every row at the right length
  function normalize() { PATS.forEach((p) => { S.patterns[p] = S.patterns[p] || emptyPattern(S.len); ROWS.forEach((r) => { let a = S.patterns[p][r.id] || []; a = a.slice(0, S.len); while (a.length < S.len) a.push(null); S.patterns[p][r.id] = a; }); }); }
  normalize();
  let saveT = 0; const save = () => { clearTimeout(saveT); saveT = setTimeout(() => { try { localStorage.setItem("mw_beat", JSON.stringify(S)); } catch (_) {} }, 250); };

  // undo / redo
  const undoStack = [], redoStack = [];
  const snap = () => { undoStack.push(JSON.stringify(S)); if (undoStack.length > 60) undoStack.shift(); redoStack.length = 0; };
  const undo = () => { if (!undoStack.length) return say("Nothing to undo"); redoStack.push(JSON.stringify(S)); S = JSON.parse(undoStack.pop()); normalize(); save(); paint(); };
  const redo = () => { if (!redoStack.length) return say("Nothing to redo"); undoStack.push(JSON.stringify(S)); S = JSON.parse(redoStack.pop()); normalize(); save(); paint(); };

  let curDeg = 0, paintMode = "normal", selRow = null, padRec = false;
  const pattern = (p) => S.patterns[p || S.pat];
  const sc = () => SCALES[S.scale] || SCALES.minor;
  const midiOf = (row, deg) => { const s = sc(), o = Math.floor(deg / s.length); return 12 * (row.oct + 1) + S.key + s[((deg % s.length) + s.length) % s.length] + 12 * o; };
  const hz = (m) => 440 * Math.pow(2, (m - 69) / 12);
  const noteLabel = (row, deg) => NOTE_NAMES[midiOf(row, deg) % 12];

  /* ================= presets ================= */
  function setHits(p, id, hits, v = 0.8, r = 1) { hits.forEach((i) => { if (i < S.len) p[id][i] = { v, r }; }); }
  function setNotes(p, id, map, v = 0.8) { Object.entries(map).forEach(([i, n]) => { if (+i < S.len) p[id][+i] = { n, v }; }); }
  function preset(name) {
    snap(); S.len = 16; S.patterns = Object.fromEntries(PATS.map((x) => [x, emptyPattern(16)])); const A = S.patterns.A, B = S.patterns.B;
    if (name === "trap") {
      Object.assign(S, { bpm: 140, swing: 0, kit: "trap", keysMode: "chords", keysSound: "keys", leadSound: "bell" });
      setHits(A, "kick", [0, 7, 10], 1); setHits(A, "clap", [8], 1); setHits(A, "snare", [8], 0.7);
      [0, 2, 4, 8, 10, 15].forEach((i) => (A.hat[i] = { v: 0.8, r: 1 })); A.hat[6] = { v: 0.8, r: 2 }; A.hat[12] = { v: 0.9, r: 3 }; [1, 3, 9, 11, 13].forEach((i) => (A.hat[i] = { v: 0.45, r: 1 }));
      setHits(A, "ohat", [14], 0.6); setHits(A, "crash", [0], 0.7);
      setNotes(A, "bass", { 0: 0, 7: 0, 10: 3 }); setNotes(A, "keys", { 0: 0, 8: 5 }, 0.7); setNotes(A, "lead", { 0: 7, 3: 9, 6: 11, 10: 9, 12: 8 }, 0.6);
      Object.assign(B, clone(A)); setHits(B, "kick", [0, 3, 7, 10, 13], 1); B.crash[0] = null; setNotes(B, "bass", { 0: 0, 3: 0, 7: 2, 10: 3, 13: 4 }); setNotes(B, "keys", { 0: 3, 8: 4 }, 0.7);
      S.song = ["A", "A", "B", "A"];
    } else if (name === "drill") {
      Object.assign(S, { bpm: 142, swing: 0, kit: "drill", keysMode: "single", keysSound: "pad", leadSound: "flute" });
      setHits(A, "kick", [0, 10], 1); setHits(A, "snare", [8], 1); setHits(A, "clap", [8], 0.6); setHits(A, "rim", [3, 13], 0.7); setHits(A, "perc", [6, 14], 0.5);
      [0, 3, 6, 10, 13].forEach((i) => (A.hat[i] = { v: 0.8, r: 1 })); A.hat[8] = { v: 0.8, r: 2 }; A.hat[14] = { v: 0.9, r: 3 }; setHits(A, "ohat", [6], 0.5);
      setNotes(A, "bass", { 0: 0, 10: 1, 13: 2 }); setNotes(A, "keys", { 0: 7, 4: 8, 8: 7, 12: 5 }, 0.65); setNotes(A, "lead", { 2: 11, 6: 10, 14: 8 }, 0.5);
      Object.assign(B, clone(A)); setHits(B, "kick", [0, 6, 10], 1); setNotes(B, "bass", { 0: 0, 6: 3, 10: 1, 13: 2 }); S.song = ["A", "B", "A", "B"];
    } else if (name === "boombap") {
      Object.assign(S, { bpm: 90, swing: 0.5, kit: "boombap", keysMode: "chords", keysSound: "keys", leadSound: "bell" });
      setHits(A, "kick", [0, 3, 10], 1); setHits(A, "snare", [4, 12], 1); [0, 2, 4, 6, 8, 10, 12, 14].forEach((i) => (A.hat[i] = { v: i % 4 ? 0.5 : 0.8, r: 1 })); setHits(A, "ohat", [7], 0.6); setHits(A, "rim", [15], 0.5); setHits(A, "perc", [11], 0.5);
      setNotes(A, "bass", { 0: 0, 3: 0, 10: 4 }); setNotes(A, "keys", { 0: 0, 8: 3 }, 0.7); setNotes(A, "lead", { 6: 9, 14: 8 }, 0.5);
      Object.assign(B, clone(A)); setHits(B, "kick", [0, 3, 8, 10], 1); setNotes(B, "keys", { 0: 5, 8: 4 }, 0.7); S.song = ["A", "A", "B", "B"];
    } else if (name === "rnb") {
      Object.assign(S, { bpm: 72, swing: 0.25, kit: "lofi", keysMode: "chords", keysSound: "pad", leadSound: "bell" });
      setHits(A, "kick", [0, 6, 9], 1); setHits(A, "snare", [4, 12], 0.9); setHits(A, "clap", [12], 0.6); [0, 2, 4, 6, 8, 10, 12, 14].forEach((i) => (A.hat[i] = { v: 0.5, r: 1 })); A.hat[15] = { v: 0.5, r: 2 }; setHits(A, "rim", [7], 0.5);
      setNotes(A, "bass", { 0: 0, 6: 2, 9: 4 }); setNotes(A, "keys", { 0: 0, 8: 5 }, 0.7); setNotes(A, "lead", { 2: 9, 4: 11, 10: 9 }, 0.45);
      Object.assign(B, clone(A)); setNotes(B, "keys", { 0: 3, 8: 4 }, 0.7); setNotes(B, "bass", { 0: 3, 6: 3, 9: 4 }); S.song = ["A", "B", "A", "B"];
    } else if (name === "clear") { /* everything empty */ }
    S.pat = "A"; normalize(); save(); paint();
  }

  /* ================= sounds ================= */
  const noiseCache = new WeakMap();
  function noise(ctx) {
    let b = noiseCache.get(ctx); if (b) return b;
    b = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate); const d = b.getChannelData(0); for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    noiseCache.set(ctx, b); return b;
  }
  const env = (g, t, peak, a, d) => { g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(Math.max(0.0002, peak), t + a); g.gain.exponentialRampToValueAtTime(0.0001, t + a + d); };
  function nz(ctx, out, t, dur, type, freq, q, peak) {
    const s = ctx.createBufferSource(); s.buffer = noise(ctx); s.playbackRate.value = 0.9 + Math.random() * 0.2;
    const f = ctx.createBiquadFilter(); f.type = type; f.frequency.value = freq; if (q) f.Q.value = q;
    const g = ctx.createGain(); env(g, t, peak, 0.002, dur); s.connect(f); f.connect(g); g.connect(out); s.start(t, Math.random() * 0.5); s.stop(t + dur + 0.05);
  }
  function osc(ctx, out, t, type, f0, f1, glideT, peak, a, d) {
    const o = ctx.createOscillator(); o.type = type; o.frequency.setValueAtTime(f0, t); if (f1 && f1 !== f0) o.frequency.exponentialRampToValueAtTime(f1, t + glideT);
    const g = ctx.createGain(); env(g, t, peak, a, d); o.connect(g); g.connect(out); o.start(t); o.stop(t + a + d + 0.05); return o;
  }
  const satCurve = (() => { const c = new Float32Array(1024); for (let i = 0; i < 1024; i++) { const x = i / 511.5 - 1; c[i] = Math.tanh(2.4 * x); } return c; })();

  // the mixer for one audio context: drum bus + melodic bus (ducks on the kick), reverb, delay, lo-fi, compressor, meter
  function buildMixer(ctx) {
    const M = {};
    M.master = ctx.createGain(); M.master.gain.value = S.fx.master;
    M.lofiLP = ctx.createBiquadFilter(); M.lofiLP.type = "lowpass"; M.lofiSh = ctx.createWaveShaper();
    M.comp = ctx.createDynamicsCompressor(); M.comp.threshold.value = -12; M.comp.knee.value = 8; M.comp.ratio.value = 4; M.comp.attack.value = 0.004; M.comp.release.value = 0.16;
    M.limit = ctx.createDynamicsCompressor(); M.limit.threshold.value = -1.5; M.limit.knee.value = 0; M.limit.ratio.value = 20; M.limit.attack.value = 0.001; M.limit.release.value = 0.08;
    M.drums = ctx.createGain(); M.synth = ctx.createGain(); M.duck = ctx.createGain();
    M.drums.connect(M.lofiSh); M.synth.connect(M.duck); M.duck.connect(M.lofiSh);
    M.lofiSh.connect(M.lofiLP); M.lofiLP.connect(M.comp); M.comp.connect(M.master); M.master.connect(M.limit); M.limit.connect(ctx.destination);
    // reverb: a generated room
    M.verb = ctx.createConvolver(); const len = Math.floor(ctx.sampleRate * 2.4), ir = ctx.createBuffer(2, len, ctx.sampleRate);
    for (let c = 0; c < 2; c++) { const d = ir.getChannelData(c); for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 2.6); }
    M.verb.buffer = ir; M.verbOut = ctx.createGain(); M.verbIn = ctx.createGain(); M.verbIn.connect(M.verb); M.verb.connect(M.verbOut); M.verbOut.connect(M.comp);
    // delay: dotted eighth, with a darkening feedback loop
    M.dlyIn = ctx.createGain(); M.dly = ctx.createDelay(2); M.fb = ctx.createGain(); M.dlyLP = ctx.createBiquadFilter(); M.dlyLP.type = "lowpass"; M.dlyLP.frequency.value = 3200; M.dlyOut = ctx.createGain();
    M.dlyIn.connect(M.dly); M.dly.connect(M.dlyLP); M.dlyLP.connect(M.fb); M.fb.connect(M.dly); M.dlyLP.connect(M.dlyOut); M.dlyOut.connect(M.comp);
    if (ctx.createAnalyser) { M.meter = ctx.createAnalyser(); M.meter.fftSize = 1024; M.limit.connect(M.meter); }
    applyFx(M); return M;
  }
  function applyFx(M) {
    if (!M) return; const f = S.fx;
    M.master.gain.value = f.master; M.verbOut.gain.value = f.rev * 0.9; M.dlyOut.gain.value = f.dly * 0.8; M.fb.gain.value = 0.25 + f.dly * 0.35;
    M.dly.delayTime.value = Math.min(1.9, (60 / S.bpm) * 0.75);
    M.lofiLP.frequency.value = f.lofi > 0 ? 18000 - f.lofi * 14500 : 20000;
    if (f.lofi > 0) { const n = 1024, c = new Float32Array(n), steps = Math.round(64 - f.lofi * 52); for (let i = 0; i < n; i++) { const x = i / (n / 2) - 1; c[i] = Math.round(x * steps) / steps; } M.lofiSh.curve = c; } else M.lofiSh.curve = null;
  }

  const kit = () => KITS[S.kit] || KITS.trap;
  const soloOn = () => ROWS.some((r) => S.rows[r.id].solo);
  // play one step of one instrument
  function hit(ctx, M, row, t, cell, sd, prevBass) {
    const rs = S.rows[row.id]; if (!rs || rs.mute || (soloOn() && !rs.solo)) return;
    const vel = cell.v ?? 0.8, vol = rs.vol * vel; if (vol <= 0) return;
    const p = Math.pow(2, (rs.pitch || 0) / 12), dk = rs.decay || 1, K = kit();
    const g = ctx.createGain(); g.gain.value = vol;
    const pan = ctx.createStereoPanner ? ctx.createStereoPanner() : null; if (pan) { pan.pan.value = rs.pan || 0; g.connect(pan); }
    const out = pan || g, bus = row.kind === "note" && row.id !== "bass" ? M.synth : row.id === "bass" ? M.synth : M.drums;
    out.connect(bus);
    if (rs.rev > 0) { const s = ctx.createGain(); s.gain.value = rs.rev; out.connect(s); s.connect(M.verbIn); }
    if (rs.dly > 0) { const s = ctx.createGain(); s.gain.value = rs.dly; out.connect(s); s.connect(M.dlyIn); }
    switch (row.id) {
      case "kick": {
        const [f0, f1, sw, dec] = K.kick; osc(ctx, g, t, "sine", f0 * p, f1 * p, sw, 1, 0.003, dec * dk); nz(ctx, g, t, 0.012, "highpass", 3000, 0, 0.25);
        if (S.fx.pump > 0) { const d = M.duck.gain, depth = Math.min(0.9, S.fx.pump); d.cancelScheduledValues(t); d.setValueAtTime(1 - depth, t); d.linearRampToValueAtTime(1, t + 0.06 + 0.22 * (60 / S.bpm)); }
        break;
      }
      case "snare": nz(ctx, g, t, K.snareDec * dk, "bandpass", K.snareF * p, 0.8, 0.9); nz(ctx, g, t, 0.12 * dk, "highpass", 5000, 0, 0.35); osc(ctx, g, t, "triangle", 210 * p * K.tone, 170 * p, 0.08, 0.5, 0.002, 0.11 * dk); break;
      case "clap": [0, 0.011, 0.022].forEach((d) => nz(ctx, g, t + d, 0.03, "bandpass", 1500 * p, 1.2, 0.8)); nz(ctx, g, t + 0.03, 0.2 * dk, "bandpass", 1300 * p, 0.9, 0.6); break;
      case "hat": { const n = cell.r >= 2 ? cell.r : 1; for (let k = 0; k < n; k++) nz(ctx, g, t + (k * sd) / n, K.hatDec * dk, "highpass", K.hatF * p, 0, n > 1 ? 0.45 : 0.55); break; }
      case "ohat": nz(ctx, g, t, 0.32 * dk, "highpass", (K.hatF - 900) * p, 0, 0.45); break;
      case "rim": osc(ctx, g, t, "square", 1700 * p, 900 * p, 0.02, 0.35, 0.001, 0.04 * dk); nz(ctx, g, t, 0.03, "bandpass", 2600 * p, 2, 0.4); break;
      case "perc": osc(ctx, g, t, "sine", 340 * p, 220 * p, 0.12, 0.8, 0.002, 0.22 * dk); nz(ctx, g, t, 0.02, "bandpass", 1800 * p, 1.5, 0.2); break;
      case "crash": nz(ctx, g, t, 1.6 * dk, "highpass", 5200 * p, 0, 0.5); nz(ctx, g, t, 0.9 * dk, "bandpass", 9000 * p, 0.6, 0.25); break;
      case "bass": {
        const f = hz(midiOf(row, cell.n)) * p, from = S.glide && prevBass != null && prevBass !== cell.n ? hz(midiOf(row, prevBass)) * p : f * 1.02;
        const sat = ctx.createWaveShaper(); sat.curve = satCurve; const lp = ctx.createBiquadFilter(); lp.type = "lowpass"; lp.frequency.value = 900; sat.connect(lp); lp.connect(g);
        osc(ctx, sat, t, "sine", from, f, S.glide ? 0.07 : 0.03, 0.9, 0.004, S.bassLen * dk); break;
      }
      case "keys": {
        const s = sc(), degs = S.keysMode === "chords" ? [cell.n, cell.n + 2, cell.n + 4] : [cell.n];
        const lp = ctx.createBiquadFilter(); lp.type = "lowpass"; lp.connect(g); const each = 1 / Math.sqrt(degs.length);
        degs.forEach((dg) => { const f = hz(midiOf(row, dg)) * p;
          if (S.keysSound === "pad") { lp.frequency.value = 1800; osc(ctx, lp, t, "sawtooth", f, 0, 0, 0.16 * each, 0.08, 1.4 * dk); osc(ctx, lp, t, "sawtooth", f * 1.006, 0, 0, 0.16 * each, 0.08, 1.4 * dk); }
          else if (S.keysSound === "pluck") { lp.frequency.value = 2600; osc(ctx, lp, t, "square", f, 0, 0, 0.2 * each, 0.002, 0.22 * dk); osc(ctx, lp, t, "triangle", f * 2, 0, 0, 0.1 * each, 0.002, 0.15 * dk); }
          else if (S.keysSound === "organ") { lp.frequency.value = 3600; [1, 2, 3, 4].forEach((h, i) => osc(ctx, lp, t, "sine", f * h, 0, 0, (0.22 / (i + 1)) * each, 0.01, 0.9 * dk)); }
          else { lp.frequency.value = 3200; osc(ctx, lp, t, "triangle", f, 0, 0, 0.42 * each, 0.004, 0.75 * dk); osc(ctx, lp, t, "sine", f * 2, 0, 0, 0.16 * each, 0.003, 0.5 * dk); osc(ctx, lp, t, "sine", f * 4, 0, 0, 0.04 * each, 0.002, 0.2 * dk); }
        });
        void s; break;
      }
      case "lead": {
        const f = hz(midiOf(row, cell.n)) * p, lp = ctx.createBiquadFilter(); lp.type = "lowpass"; lp.connect(g);
        if (S.leadSound === "flute") { lp.frequency.value = 2600; const o = osc(ctx, lp, t, "sine", f, 0, 0, 0.45, 0.04, 0.5 * dk); const lfo = ctx.createOscillator(), lg = ctx.createGain(); lfo.frequency.value = 5.5; lg.gain.value = f * 0.008; lfo.connect(lg); lg.connect(o.frequency); lfo.start(t); lfo.stop(t + 0.6 * dk); nz(ctx, lp, t, 0.08, "bandpass", f * 2, 2, 0.05); }
        else if (S.leadSound === "saw") { lp.frequency.value = 2400; osc(ctx, lp, t, "sawtooth", f, 0, 0, 0.22, 0.01, 0.35 * dk); osc(ctx, lp, t, "sawtooth", f * 1.008, 0, 0, 0.18, 0.01, 0.35 * dk); }
        else { lp.frequency.value = 6000; osc(ctx, lp, t, "sine", f, 0, 0, 0.4, 0.002, 0.9 * dk); osc(ctx, lp, t, "sine", f * 3.01, 0, 0, 0.12, 0.002, 0.35 * dk); osc(ctx, lp, t, "sine", f * 5.4, 0, 0, 0.05, 0.001, 0.15 * dk); }
        break;
      }
    }
  }

  /* ================= timing ================= */
  const stepDur = () => 60 / S.bpm / 4;
  // which pattern plays on bar b (pattern mode: always the current one)
  const patAt = (b) => (S.mode === "song" && S.song.length ? S.song[b % S.song.length] : S.pat);
  // time of step s inside a bar (odd steps are pushed back by the swing amount)
  function stepTime(s) { const sd = stepDur(); return s * sd + (s % 2 ? S.swing * sd * 0.5 : 0); }
  // play step s of bar `bar`, where barStart is when that bar begins.
  // Humanize adds a tiny saved push/drag per cell (h), so a saved WAV matches what you heard.
  function scheduleStep(ctx, M, bar, s, barStart) {
    const L = S.len, P = pattern(patAt(bar)), sd = stepDur();
    ROWS.forEach((row) => {
      const cell = P[row.id][s]; if (!cell) return;
      let prev = null; if (row.id === "bass") for (let k = 1; k < L; k++) { const c = P.bass[(s - k + L) % L]; if (c) { prev = c.n; break; } }
      hit(ctx, M, row, Math.max(barStart, barStart + stepTime(s) + (cell.h || 0)), cell, sd, prev);
    });
  }

  /* ================= live playback ================= */
  let ctx = null, MX = null, playing = false, timer = 0, raf = 0;
  let curBar = 0, curStep = 0, barStart = 0; // what's being scheduled next, and when that bar starts
  const live = () => {
    if (!ctx) { ctx = new (window.AudioContext || window.webkitAudioContext)(); MX = buildMixer(ctx); }
    if (ctx.state === "suspended") ctx.resume(); return ctx;
  };
  // bars of the current position, for the playhead (scheduling runs a little ahead of what you hear)
  const heard = []; // [{bar, start}] for the bars scheduled so far
  function play() {
    live(); try { if (typeof media !== "undefined" && !media.paused) media.pause(); } catch (_) {}
    applyFx(MX); playing = true; curBar = 0; curStep = 0; barStart = ctx.currentTime + 0.08; heard.length = 0; heard.push({ bar: 0, start: barStart });
    const loop = () => {
      if (!playing) return;
      while (barStart + stepTime(curStep) < ctx.currentTime + 0.15) {
        scheduleStep(ctx, MX, curBar, curStep, barStart); curStep++;
        // next bar: its start uses the tempo at that moment, so BPM changes take effect smoothly
        if (curStep >= S.len) { barStart += S.len * stepDur(); curStep = 0; curBar++; heard.push({ bar: curBar, start: barStart }); if (heard.length > 8) heard.shift(); }
      }
      timer = setTimeout(loop, 25);
    };
    loop(); tick(); paintTransport();
  }
  function stop() { playing = false; clearTimeout(timer); cancelAnimationFrame(raf); root.querySelectorAll(".bm-cell.now,.bm-slot.now").forEach((c) => c.classList.remove("now")); paintTransport(); }
  let lastShownPat = null;
  function tick() {
    if (!playing) return;
    const now = ctx.currentTime; let h = heard[0]; for (const x of heard) if (x.start <= now) h = x;
    let s = Math.floor((now - h.start) / stepDur()); s = Math.max(0, Math.min(S.len - 1, s));
    const bar = h.bar, showPat = patAt(bar);
    if (S.mode === "song" && showPat !== S.pat && showPat !== lastShownPat) { lastShownPat = showPat; S.pat = showPat; paintPats(); paintGrid(); }
    root.querySelectorAll(".bm-cell.now").forEach((c) => c.classList.remove("now"));
    root.querySelectorAll(`.bm-cell[data-s="${s}"]`).forEach((c) => c.classList.add("now"));
    if (S.mode === "song") root.querySelectorAll(".bm-slot").forEach((x, i) => x.classList.toggle("now", i === bar % S.song.length));
    meter(); raf = requestAnimationFrame(tick);
  }
  // level meter
  let meterBuf = null;
  function meter() {
    const cv = root.querySelector("#bm-meter"); if (!cv || !MX || !MX.meter) return;
    if (!meterBuf) meterBuf = new Float32Array(MX.meter.fftSize); MX.meter.getFloatTimeDomainData(meterBuf);
    let pk = 0; for (let i = 0; i < meterBuf.length; i++) pk = Math.max(pk, Math.abs(meterBuf[i]));
    const g = cv.getContext("2d"), w = cv.width, h = cv.height; g.clearRect(0, 0, w, h);
    const lv = Math.min(1, pk); g.fillStyle = lv > 0.95 ? "#e5484d" : lv > 0.75 ? "#f0cf78" : "#6fbf8b"; g.fillRect(0, 0, w * lv, h);
  }

  /* ================= pads (tap or keys 1–8, record into the pattern) ================= */
  function pad(rowId) {
    const row = ROWS.find((r) => r.id === rowId); live(); applyFx(MX);
    const vel = VEL[paintMode] ?? 0.8, cell = { v: vel, r: paintMode === "roll2" ? 2 : paintMode === "roll3" ? 3 : 1 };
    hit(ctx, MX, row, ctx.currentTime + 0.005, cell, stepDur(), null);
    const el = root.querySelector(`.bm-pad[data-pad="${rowId}"]`); if (el) { el.classList.add("hit"); setTimeout(() => el.classList.remove("hit"), 110); }
    if (padRec && playing) { // drop it on the nearest step of the bar you're hearing
      const now = ctx.currentTime; let h = heard[0]; for (const x of heard) if (x.start <= now) h = x;
      const s = ((Math.round((now - h.start) / stepDur()) % S.len) + S.len) % S.len;
      snap(); pattern(patAt(h.bar))[rowId][s] = cell; save(); paintGrid();
    }
  }
  document.addEventListener("keydown", (e) => {
    if (document.getElementById("v-studio")?.hidden || /input|textarea|select/i.test(e.target.tagName) || e.ctrlKey || e.metaKey || e.altKey) return;
    const row = DRUMS.find((r) => r.key === e.key); if (row && !e.repeat) { e.preventDefault(); pad(row.id); return; }
    if (!root.contains(document.activeElement) && document.activeElement !== document.body) return;
    if (e.code === "Space") { e.preventDefault(); playing ? stop() : play(); }
    if ((e.key === "z" || e.key === "Z") && e.shiftKey) { e.preventDefault(); redo(); }
  });
  document.addEventListener("keydown", (e) => { if (document.getElementById("v-studio")?.hidden) return; if ((e.ctrlKey || e.metaKey) && (e.key === "z" || e.key === "Z")) { if (/input|textarea/i.test(e.target.tagName)) return; e.preventDefault(); e.shiftKey ? redo() : undo(); } });

  // tap tempo
  let taps = [];
  function tap() { const n = performance.now(); taps = taps.filter((x) => n - x < 2500); taps.push(n); if (taps.length >= 2) { const iv = (taps[taps.length - 1] - taps[0]) / (taps.length - 1); S.bpm = Math.max(50, Math.min(200, Math.round(60000 / iv))); save(); root.querySelector("#bm-bpm").value = S.bpm; applyFx(MX); } }

  /* ================= saving a beat as audio ================= */
  async function renderBars(bars) {
    const sr = 44100, barLen = S.len * stepDur(), len = bars * barLen + 2.5;
    const oc = new OfflineAudioContext(2, Math.ceil(len * sr), sr), M = buildMixer(oc);
    for (let b = 0; b < bars; b++) for (let s = 0; s < S.len; s++) scheduleStep(oc, M, b, s, 0.02 + b * barLen);
    return oc.startRendering();
  }
  // how many bars to save: pattern mode uses Length; song mode plays the arrangement N times
  const exportBars = () => (S.mode === "song" ? Math.max(1, S.song.length) * (S.repeats || 1) : +S.bars || 8);
  function wav(buf) {
    const ch = buf.numberOfChannels, n = buf.length, ab = new ArrayBuffer(44 + n * ch * 2), v = new DataView(ab), w = (o, s) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
    w(0, "RIFF"); v.setUint32(4, 36 + n * ch * 2, true); w(8, "WAVE"); w(12, "fmt "); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, ch, true); v.setUint32(24, buf.sampleRate, true);
    v.setUint32(28, buf.sampleRate * ch * 2, true); v.setUint16(32, ch * 2, true); v.setUint16(34, 16, true); w(36, "data"); v.setUint32(40, n * ch * 2, true);
    const data = Array.from({ length: ch }, (_, c) => buf.getChannelData(c)); let p = 44;
    for (let i = 0; i < n; i++) for (let c = 0; c < ch; c++) { const x = Math.max(-1, Math.min(1, data[c][i])); v.setInt16(p, x < 0 ? x * 0x8000 : x * 0x7fff, true); p += 2; }
    return new Blob([ab], { type: "audio/wav" });
  }
  const hasNotes = () => PATS.some((p) => ROWS.some((r) => S.patterns[p][r.id].some(Boolean)));

  /* ================= beat library (on this device) ================= */
  const lib = () => { try { return JSON.parse(localStorage.getItem("mw_beats") || "[]"); } catch (_) { return []; } };
  const setLib = (l) => { try { localStorage.setItem("mw_beats", JSON.stringify(l.slice(0, 40))); } catch (_) { say("Couldn't save: this device is out of space."); } };

  /* ================= screen ================= */
  const css = document.createElement("style");
  css.textContent = `
#bm-root{margin-bottom:22px;border:1px solid var(--gold-lo);border-radius:16px;background:linear-gradient(180deg,#17130c,#0d0b08);padding:14px;display:grid;gap:12px}
#bm-root .bm-title{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
#bm-root .bm-title h3{margin:0;font-family:var(--display);color:var(--gold-hi);letter-spacing:.06em}
#bm-root .bm-title .pro{font:700 11px var(--mono);letter-spacing:.12em;color:var(--ink);background:var(--gold);border-radius:999px;padding:3px 8px}
.bm-bar{display:flex;flex-wrap:wrap;gap:8px;align-items:center}
.bm-bar label{display:flex;align-items:center;gap:6px;font-size:13px;color:var(--muted)}
.bm-bar input[type=number],.bm-bar input[type=text],.bm-bar select{background:var(--ink);border:1px solid var(--line);border-radius:8px;color:var(--text);padding:6px 8px;font:14px var(--body);min-height:36px}
.bm-bar input[type=number]{width:70px}
.bm-btn{border:1px solid var(--gold-lo);background:transparent;color:var(--text);border-radius:999px;padding:8px 14px;font:600 14px var(--body);cursor:pointer;min-height:38px}
.bm-btn:hover{border-color:var(--gold)}.bm-btn.on,.bm-btn.go{background:var(--gold);color:var(--ink);border-color:var(--gold)}
.bm-btn.rec.on{background:#e5484d;border-color:#e5484d;color:#fff}
.bm-btn:disabled{opacity:.5;cursor:default}
.bm-sec{border-top:1px solid #2a2419;padding-top:10px;display:grid;gap:8px}
.bm-sec>b{font:700 12px var(--mono);letter-spacing:.16em;color:var(--gold)}
.bm-chip{border:1px solid var(--line);background:var(--ink);color:var(--text);border-radius:8px;padding:6px 10px;font:600 13px var(--body);cursor:pointer;min-height:36px}
.bm-chip.on{background:var(--gold);color:var(--ink);border-color:var(--gold)}
.bm-slot{border:1px solid var(--gold-lo);background:#221d15;color:var(--gold-hi);border-radius:8px;width:40px;min-height:38px;font:700 15px var(--mono);cursor:pointer}
.bm-slot.now{outline:2px solid #fff}
.bm-grid-wrap{overflow-x:auto;-webkit-overflow-scrolling:touch;padding-bottom:4px}
.bm-grid{display:grid;gap:4px;align-items:center}
.bm-name{display:flex;align-items:center;gap:4px;white-space:nowrap}
.bm-name .nm{flex:1;min-width:0;text-align:left;background:none;border:0;color:var(--text);font:600 13px var(--body);cursor:pointer;padding:6px 2px;overflow:hidden;text-overflow:ellipsis}
.bm-name .nm.sel{color:var(--gold-hi);text-decoration:underline}
.bm-name .ms{border:1px solid var(--line);background:none;color:var(--muted);border-radius:6px;font:700 11px var(--mono);padding:4px 6px;cursor:pointer;min-width:26px;min-height:28px}
.bm-name .ms.m.on{background:#7a1f2b;color:#fff;border-color:#7a1f2b}.bm-name .ms.s.on{background:#2f6b45;color:#fff;border-color:#2f6b45}
.bm-cell{height:36px;align-self:center;display:flex;align-items:center;justify-content:center;line-height:1;margin:0;border-radius:7px;border:1px solid #2c261b;background:#1b1712;cursor:pointer;padding:0;color:var(--ink);font:700 10px var(--mono);position:relative;vertical-align:top}
.bm-cell.q{background:#221d15}
.bm-cell.on{background:var(--gold);border-color:var(--gold-hi)}
.bm-cell.on.acc{background:#ffe08a;box-shadow:0 0 10px rgba(240,207,120,.6)}
.bm-cell.on.soft{background:#8c6d26}
.bm-cell.on.rl::after{content:attr(data-roll);position:absolute;right:3px;top:2px;font-size:9px}
.bm-cell.note{color:#1a1206}
.bm-cell.now{outline:2px solid #fff;outline-offset:-2px}
.bm-row-set{grid-column:1/-1;display:flex;flex-wrap:wrap;gap:10px 16px;align-items:center;background:#120f0a;border:1px solid #2a2419;border-radius:10px;padding:10px}
.bm-row-set label{display:flex;align-items:center;gap:6px;font-size:12px;color:var(--muted)}
.bm-rng{width:96px;accent-color:var(--gold)}
.bm-notes{display:flex;flex-wrap:wrap;gap:6px;align-items:center}
.bm-notes button{border:1px solid var(--line);background:var(--ink);color:var(--text);border-radius:8px;padding:6px 9px;font:600 12px var(--mono);cursor:pointer;min-height:34px}
.bm-notes button.on{background:var(--gold);color:var(--ink);border-color:var(--gold)}
.bm-pads{display:grid;grid-template-columns:repeat(8,1fr);gap:8px}
.bm-pad{aspect-ratio:1.4/1;border-radius:12px;border:1px solid var(--gold-lo);background:linear-gradient(180deg,#2a2213,#16120b);color:var(--gold-hi);font:700 13px var(--body);cursor:pointer;display:grid;place-items:center;gap:2px;transition:transform .06s,background .06s;touch-action:manipulation}
.bm-pad small{color:var(--muted);font:500 11px var(--mono)}
.bm-pad.hit{background:var(--gold);color:var(--ink);transform:scale(.96)}
.bm-fx{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px}
.bm-fx label{display:grid;gap:4px;font-size:12px;color:var(--muted)}
.bm-fx input{width:100%;accent-color:var(--gold)}
#bm-meter{width:160px;height:10px;border-radius:5px;background:#1b1712;border:1px solid #2c261b}
.bm-lib{display:grid;gap:6px}
.bm-lib div{display:flex;gap:8px;align-items:center;background:#120f0a;border:1px solid #2a2419;border-radius:10px;padding:6px 10px}
.bm-lib div b{flex:1;font-size:14px}
.bm-tip{font-size:13px;color:var(--muted);margin:0}
@media (max-width:640px){.bm-pads{grid-template-columns:repeat(4,1fr)}.bm-rng{width:80px}#bm-meter{width:110px}}`;
  document.head.appendChild(css);

  root.innerHTML = `
  <div class="bm-title"><h3>🥁 BEAT MAKER</h3><span class="pro">PRO</span><small class="muted" style="flex:1">Make the beat, then send it to the studio and record over it.</small><canvas id="bm-meter" width="160" height="10" aria-label="Output level"></canvas></div>
  <div class="bm-bar">
    <button class="bm-btn go" type="button" id="bm-play">▶ Play</button>
    <button class="bm-btn" type="button" id="bm-mode" aria-pressed="false">Pattern</button>
    <label>BPM <input type="number" id="bm-bpm" min="50" max="200"></label>
    <button class="bm-btn" type="button" id="bm-tap">Tap tempo</button>
    <label>Swing <input type="range" id="bm-swing" min="0" max="0.8" step="0.05" class="bm-rng"></label>
    <label>Kit <select id="bm-kit">${Object.entries(KITS).map(([k, v]) => `<option value="${k}">${v.name}</option>`).join("")}</select></label>
    <label>Key <select id="bm-key">${NOTE_NAMES.map((n, i) => `<option value="${i}">${n}</option>`).join("")}</select></label>
    <label><select id="bm-scale" aria-label="Scale">${Object.entries(SCALE_NAMES).map(([k, n]) => `<option value="${k}">${n}</option>`).join("")}</select></label>
    <label>Steps <select id="bm-len"><option value="16">16</option><option value="32">32</option></select></label>
    <button class="bm-btn" type="button" id="bm-undo" aria-label="Undo">↶ Undo</button><button class="bm-btn" type="button" id="bm-redo" aria-label="Redo">↷ Redo</button>
  </div>
  <div class="bm-bar"><span class="muted" style="font-size:13px">Start from:</span>
    <button class="bm-btn" type="button" data-preset="trap">Trap</button><button class="bm-btn" type="button" data-preset="drill">Drill</button>
    <button class="bm-btn" type="button" data-preset="boombap">Boom Bap</button><button class="bm-btn" type="button" data-preset="rnb">R&amp;B / Lo-Fi</button>
    <button class="bm-btn" type="button" data-preset="clear">Blank</button></div>

  <div class="bm-sec"><b>PATTERNS &amp; SONG</b>
    <div class="bm-bar" id="bm-pats"></div>
    <div class="bm-bar"><span class="muted" style="font-size:13px">Song order:</span><span id="bm-song" style="display:flex;gap:6px;flex-wrap:wrap"></span>
      <button class="bm-chip" type="button" id="bm-song-add">＋</button><button class="bm-chip" type="button" id="bm-song-del">－</button>
      <small class="muted">Tap a box to change its pattern. Switch to Song to play the whole order.</small></div>
  </div>

  <div class="bm-sec"><b>PAINT</b>
    <div class="bm-bar" id="bm-paint">${PAINTS.map(([k, n]) => `<button class="bm-chip" type="button" data-paint="${k}">${n}</button>`).join("")}</div>
    <div class="bm-notes" id="bm-notes"></div>
    <div class="bm-bar"><label>Keys <select id="bm-kmode"><option value="chords">Chords</option><option value="single">Single notes</option></select></label>
      <label><select id="bm-ksnd" aria-label="Keys sound"><option value="keys">Electric piano</option><option value="pad">Pad</option><option value="pluck">Pluck</option><option value="organ">Organ</option></select></label>
      <label>Lead <select id="bm-lsnd"><option value="bell">Bell</option><option value="flute">Flute</option><option value="saw">Synth</option></select></label>
      <label>808 length <input type="range" id="bm-blen" min="0.2" max="1.8" step="0.05" class="bm-rng"></label>
      <label><input type="checkbox" id="bm-glide"> 808 glide</label></div>
  </div>

  <div class="bm-grid-wrap"><div class="bm-grid" id="bm-grid"></div></div>
  <p class="bm-tip">Tap a square to paint it with the mode above (tap the same kind again to erase). 808, Keys and Lead use the note you pick. Tap an instrument's name for its volume, pan, pitch, length, reverb and delay. M = mute, S = solo.</p>

  <div class="bm-sec"><b>DRUM PADS</b>
    <div class="bm-pads" id="bm-pads">${DRUMS.map((r) => `<button class="bm-pad" type="button" data-pad="${r.id}">${r.name}<small>${r.key}</small></button>`).join("")}</div>
    <div class="bm-bar"><button class="bm-btn rec" type="button" id="bm-rec" aria-pressed="false">● Record pads</button><small class="muted">Press play, turn on Record, and tap the pads (or keys 1–8). Hits land on the nearest step.</small></div>
  </div>

  <div class="bm-sec"><b>PATTERN TOOLS</b>
    <div class="bm-bar"><label>Copy this pattern to <select id="bm-copyto">${PATS.map((p) => `<option>${p}</option>`).join("")}</select></label><button class="bm-btn" type="button" id="bm-copy">Copy</button>
      <button class="bm-btn" type="button" id="bm-rand">🎲 New hi-hats</button><button class="bm-btn" type="button" id="bm-human">🤚 Humanize</button><button class="bm-btn" type="button" id="bm-clearpat">Clear pattern</button></div>
  </div>

  <div class="bm-sec"><b>MASTER EFFECTS</b>
    <div class="bm-fx">
      <label>Reverb <input type="range" data-fx="rev" min="0" max="1" step="0.01"></label>
      <label>Delay <input type="range" data-fx="dly" min="0" max="1" step="0.01"></label>
      <label>Lo-Fi <input type="range" data-fx="lofi" min="0" max="1" step="0.01"></label>
      <label>Sidechain pump <input type="range" data-fx="pump" min="0" max="0.9" step="0.01"></label>
      <label>Master volume <input type="range" data-fx="master" min="0" max="1.2" step="0.01"></label>
    </div>
  </div>

  <div class="bm-sec"><b>SAVE &amp; EXPORT</b>
    <div class="bm-bar"><input type="text" id="bm-name" maxlength="40" placeholder="Name this beat" aria-label="Beat name"><button class="bm-btn" type="button" id="bm-save">💾 Save to my beats</button></div>
    <div class="bm-lib" id="bm-lib"></div>
    <div class="bm-bar">
      <label id="bm-bars-l">Length <select id="bm-bars"><option value="4">4 bars</option><option value="8">8 bars</option><option value="16">16 bars</option><option value="32">32 bars</option></select></label>
      <label id="bm-rep-l">Play the song <select id="bm-rep"><option value="1">1 time</option><option value="2">2 times</option><option value="3">3 times</option><option value="4">4 times</option></select></label>
      <button class="bm-btn go" type="button" id="bm-send">➕ Send to Studio</button>
      <button class="bm-btn" type="button" id="bm-dl">⬇ Download WAV</button>
      <small class="muted" id="bm-st"></small>
    </div>
  </div>`;
  const $ = (s) => root.querySelector(s);

  /* ---------- painting the screen ---------- */
  function paintPats() {
    $("#bm-pats").innerHTML = '<span class="muted" style="font-size:13px">Editing:</span>' + PATS.map((p) => {
      const used = ROWS.some((r) => S.patterns[p][r.id].some(Boolean));
      return `<button class="bm-chip${p === S.pat ? " on" : ""}" type="button" data-pat="${p}" aria-pressed="${p === S.pat}">${p}${used ? "" : " ·"}</button>`;
    }).join("");
    $("#bm-song").innerHTML = S.song.map((p, i) => `<button class="bm-slot" type="button" data-slot="${i}" aria-label="Song part ${i + 1}: pattern ${p}">${p}</button>`).join("");
    const m = $("#bm-mode"); m.textContent = S.mode === "song" ? "Song" : "Pattern"; m.classList.toggle("on", S.mode === "song"); m.setAttribute("aria-pressed", S.mode === "song");
    $("#bm-bars-l").hidden = S.mode === "song"; $("#bm-rep-l").hidden = S.mode !== "song";
  }
  function paintNotes() {
    const row = ROWS.find((r) => r.id === (selRow && ROWS.find((x) => x.id === selRow)?.kind === "note" ? selRow : "keys")), n = sc().length * 2;
    $("#bm-notes").innerHTML = '<span class="muted" style="font-size:13px">Note:</span>' + Array.from({ length: n }, (_, d) => `<button type="button" data-deg="${d}" class="${d === curDeg ? "on" : ""}">${noteLabel(row, d)}${d >= sc().length ? "↑" : ""}</button>`).join("");
  }
  function cellHtml(row, c, s) {
    const q = Math.floor(s / 4) % 2 ? " q" : "";
    if (!c) return `<button type="button" class="bm-cell${q}" data-r="${row.id}" data-s="${s}" aria-label="${row.name} step ${s + 1}"></button>`;
    const lvl = c.v >= 0.95 ? " acc" : c.v <= 0.5 ? " soft" : "";
    if (row.kind === "note") return `<button type="button" class="bm-cell${q} on note${lvl}" data-r="${row.id}" data-s="${s}" aria-label="${row.name} step ${s + 1}, ${noteLabel(row, c.n)}">${noteLabel(row, c.n)}</button>`;
    const rl = c.r >= 2 ? ` rl" data-roll="x${c.r}` : "";
    return `<button type="button" class="bm-cell${q} on${lvl}${rl}" data-r="${row.id}" data-s="${s}" aria-label="${row.name} step ${s + 1} on" aria-pressed="true"></button>`;
  }
  function paintGrid() {
    const L = S.len, P = pattern(), phone = matchMedia("(max-width:640px)").matches, cw = L === 32 ? (phone ? 28 : 26) : phone ? 34 : 32, nw = phone ? 112 : 150;
    $("#bm-grid").style.gridTemplateColumns = `${nw}px repeat(${L},${cw}px)`;
    $("#bm-grid").style.width = nw + L * (cw + 4) + "px";
    $("#bm-grid").innerHTML = ROWS.map((r) => {
      const rs = S.rows[r.id];
      let h = `<div class="bm-name"><button type="button" class="nm${selRow === r.id ? " sel" : ""}" data-sel="${r.id}" aria-expanded="${selRow === r.id}">${r.name}</button><button type="button" class="ms m${rs.mute ? " on" : ""}" data-mute="${r.id}" aria-label="Mute ${r.name}">M</button><button type="button" class="ms s${rs.solo ? " on" : ""}" data-solo="${r.id}" aria-label="Solo ${r.name}">S</button></div>`
        + P[r.id].map((c, s) => cellHtml(r, c, s)).join("");
      if (selRow === r.id) h += `<div class="bm-row-set" data-set="${r.id}">
        <b style="color:var(--gold-hi);font-size:13px">${r.name}</b>
        <label>Volume <input type="range" class="bm-rng" min="0" max="1.3" step="0.01" data-rs="vol" value="${rs.vol}"></label>
        <label>Pan <input type="range" class="bm-rng" min="-1" max="1" step="0.05" data-rs="pan" value="${rs.pan}"></label>
        <label>Pitch <input type="range" class="bm-rng" min="-12" max="12" step="1" data-rs="pitch" value="${rs.pitch}"><span>${rs.pitch > 0 ? "+" : ""}${rs.pitch}</span></label>
        <label>Length <input type="range" class="bm-rng" min="0.3" max="2.5" step="0.05" data-rs="decay" value="${rs.decay}"></label>
        <label>Reverb <input type="range" class="bm-rng" min="0" max="1" step="0.01" data-rs="rev" value="${rs.rev}"></label>
        <label>Delay <input type="range" class="bm-rng" min="0" max="1" step="0.01" data-rs="dly" value="${rs.dly}"></label>
        <button class="bm-chip" type="button" data-rowclear="${r.id}">Clear row</button><button class="bm-chip" type="button" data-rowtry="${r.id}">▶ Hear it</button></div>`;
      return h;
    }).join("");
  }
  function paintLib() {
    const l = lib();
    $("#bm-lib").innerHTML = l.length ? l.map((b, i) => `<div><b>${E(b.name)}</b><small class="muted">${b.bpm || ""} BPM</small><button class="bm-chip" type="button" data-load="${i}">Open</button><button class="bm-chip" type="button" data-libdel="${i}" aria-label="Remove ${E(b.name)} from my beats">✕</button></div>`).join("") : '<small class="muted">Beats you save show up here (on this device).</small>';
  }
  function paintTransport() { const b = $("#bm-play"); b.textContent = playing ? "■ Stop" : "▶ Play"; b.classList.toggle("on", playing); const r = $("#bm-rec"); r.classList.toggle("on", padRec); r.setAttribute("aria-pressed", padRec); }
  function paint() {
    $("#bm-bpm").value = S.bpm; $("#bm-swing").value = S.swing; $("#bm-kit").value = S.kit; $("#bm-key").value = S.key; $("#bm-scale").value = S.scale; $("#bm-len").value = S.len;
    $("#bm-kmode").value = S.keysMode; $("#bm-ksnd").value = S.keysSound; $("#bm-lsnd").value = S.leadSound; $("#bm-blen").value = S.bassLen; $("#bm-glide").checked = !!S.glide;
    $("#bm-bars").value = S.bars; $("#bm-rep").value = S.repeats || 1;
    root.querySelectorAll("[data-fx]").forEach((i) => (i.value = S.fx[i.dataset.fx]));
    root.querySelectorAll("[data-paint]").forEach((b) => b.classList.toggle("on", b.dataset.paint === paintMode));
    paintPats(); paintNotes(); paintGrid(); paintLib(); paintTransport(); applyFx(MX);
  }

  /* ---------- painting a cell ---------- */
  function paintCell(row, s) {
    const P = pattern(), cur = P[row.id][s];
    if (paintMode === "erase") { if (!cur) return; snap(); P[row.id][s] = null; }
    else {
      const v = VEL[paintMode] ?? 0.8, r = row.kind === "hat" && paintMode.startsWith("roll") ? +paintMode.slice(4) : 1;
      const want = row.kind === "note" ? { n: curDeg, v } : { v, r };
      const same = cur && (row.kind === "note" ? cur.n === want.n && Math.abs(cur.v - want.v) < 0.01 : Math.abs(cur.v - want.v) < 0.01 && (cur.r || 1) === want.r);
      snap(); P[row.id][s] = same ? null : want;
      if (!same) { live(); applyFx(MX); let prev = null; hit(ctx, MX, row, ctx.currentTime + 0.01, want, stepDur(), prev); }
    }
    save(); paintGrid(); paintPats();
  }

  /* ---------- clicks ---------- */
  root.addEventListener("click", async (e) => {
    const b = e.target.closest("button"); if (!b) return;
    const d = b.dataset;
    if (b.id === "bm-play") return playing ? stop() : play();
    if (b.id === "bm-mode") { S.mode = S.mode === "song" ? "pattern" : "song"; save(); paintPats(); if (playing) { stop(); play(); } return; }
    if (b.id === "bm-tap") return tap();
    if (b.id === "bm-undo") return undo();
    if (b.id === "bm-redo") return redo();
    if (b.id === "bm-rec") { padRec = !padRec; if (padRec && !playing) play(); paintTransport(); return; }
    if (d.preset) return preset(d.preset);
    if (d.pat) { S.pat = d.pat; save(); paintPats(); paintGrid(); return; }
    if (d.slot != null) { snap(); const i = +d.slot; S.song[i] = PATS[(PATS.indexOf(S.song[i]) + 1) % PATS.length]; save(); paintPats(); return; }
    if (b.id === "bm-song-add") { if (S.song.length >= 32) return say("That's the longest song order."); snap(); S.song.push(S.song[S.song.length - 1] || "A"); save(); paintPats(); return; }
    if (b.id === "bm-song-del") { if (S.song.length <= 1) return; snap(); S.song.pop(); save(); paintPats(); return; }
    if (d.paint) { paintMode = d.paint; root.querySelectorAll("[data-paint]").forEach((x) => x.classList.toggle("on", x.dataset.paint === paintMode)); return; }
    if (d.deg != null) { curDeg = +d.deg; paintNotes(); const r = ROWS.find((x) => x.id === (selRow && ROWS.find((y) => y.id === selRow).kind === "note" ? selRow : "keys")); live(); applyFx(MX); hit(ctx, MX, r, ctx.currentTime + 0.01, { n: curDeg, v: 0.8 }, stepDur(), null); return; }
    if (d.sel) { selRow = selRow === d.sel ? null : d.sel; paintGrid(); paintNotes(); return; }
    if (d.mute) { snap(); S.rows[d.mute].mute = !S.rows[d.mute].mute; save(); paintGrid(); return; }
    if (d.solo) { snap(); S.rows[d.solo].solo = !S.rows[d.solo].solo; save(); paintGrid(); return; }
    if (d.rowclear) { snap(); pattern()[d.rowclear] = Array(S.len).fill(null); save(); paintGrid(); return; }
    if (d.rowtry) { const r = ROWS.find((x) => x.id === d.rowtry); live(); applyFx(MX); hit(ctx, MX, r, ctx.currentTime + 0.01, r.kind === "note" ? { n: curDeg, v: 0.85 } : { v: 0.9, r: 1 }, stepDur(), null); return; }
    if (d.r) return paintCell(ROWS.find((r) => r.id === d.r), +d.s);
    if (d.pad) return pad(d.pad);
    if (b.id === "bm-copy") { const to = $("#bm-copyto").value; if (to === S.pat) return say("Pick a different pattern to copy to."); snap(); S.patterns[to] = clone(pattern()); save(); paintPats(); say("Copied " + S.pat + " to " + to); return; }
    if (b.id === "bm-clearpat") { snap(); S.patterns[S.pat] = emptyPattern(S.len); save(); paintGrid(); paintPats(); return; }
    if (b.id === "bm-rand") { // new hi-hat groove: 8ths with random 16ths, accents and the odd roll
      snap(); const h = Array(S.len).fill(null);
      for (let i = 0; i < S.len; i++) { const strong = i % 4 === 0, eighth = i % 2 === 0; const r = Math.random();
        if (eighth || r < 0.35) h[i] = { v: strong ? 1 : eighth ? 0.75 : 0.45, r: !strong && r < 0.12 ? (r < 0.05 ? 3 : 2) : 1 }; }
      pattern().hat = h; save(); paintGrid(); return;
    }
    if (b.id === "bm-human") { // small random changes in loudness and timing, like a real drummer
      snap(); const P = pattern();
      DRUMS.forEach((r) => P[r.id].forEach((c) => { if (!c) return; c.v = Math.max(0.3, Math.min(1, (c.v || 0.8) + (Math.random() - 0.5) * 0.18)); c.h = +((Math.random() - 0.5) * 0.014).toFixed(4); }));
      save(); paintGrid(); say("Humanized: small changes in loudness and timing."); return;
    }
    if (b.id === "bm-save") {
      const name = ($("#bm-name").value.trim() || "Beat " + S.bpm + " BPM").slice(0, 40), l = lib(), i = l.findIndex((x) => x.name === name), entry = { name, bpm: S.bpm, at: Date.now(), beat: S };
      if (i >= 0) l[i] = entry; else l.unshift(entry); setLib(l); paintLib(); say("Saved \"" + name + "\" to my beats"); return;
    }
    if (d.load != null) { const x = lib()[+d.load]; if (!x) return; snap(); const s = upgrade(x.beat); if (s) { S = s; normalize(); save(); stop(); paint(); $("#bm-name").value = x.name; say("Opened \"" + x.name + "\""); } return; }
    if (d.libdel != null) { if (b.dataset.sure !== "1") { b.dataset.sure = "1"; b.textContent = "Tap again"; return; } const l = lib(); l.splice(+d.libdel, 1); setLib(l); paintLib(); return; }
    if (b.id === "bm-send" || b.id === "bm-dl") {
      if (!hasNotes()) return say("Tap some squares first (or pick a starting beat) to make a beat.");
      const st = $("#bm-st"), bars = exportBars(); b.disabled = true; st.textContent = "Making your beat (" + bars + " bars)...";
      try {
        const buf = await renderBars(bars), name = ($("#bm-name").value.trim() || "Beat " + S.bpm + " BPM").slice(0, 24);
        if (b.id === "bm-dl") {
          const a = document.createElement("a"); a.href = URL.createObjectURL(wav(buf)); a.download = "meechies-world-" + name.toLowerCase().replace(/[^a-z0-9]+/g, "-") + ".wav"; document.body.appendChild(a); a.click(); a.remove();
          setTimeout(() => URL.revokeObjectURL(a.href), 30000); st.textContent = "Saved " + bars + " bars as a WAV file.";
        } else if (window.MW_STUDIO && window.MW_STUDIO.addBeat(name, buf, S.bpm)) {
          stop(); st.textContent = "Sent! It's on a track in the studio below."; document.getElementById("bl-root")?.scrollIntoView({ behavior: "smooth", block: "start" }); say("Your beat is in the studio");
        } else st.textContent = "The studio is full. Delete a track below, then send it again.";
      } catch (err) { st.textContent = "Couldn't make the beat: " + (err.message || err); }
      b.disabled = false;
    }
  });
  // sliders
  root.addEventListener("input", (e) => {
    const t = e.target;
    if (t.dataset.fx) { S.fx[t.dataset.fx] = +t.value; applyFx(MX); save(); return; }
    if (t.dataset.rs) { const id = t.closest("[data-set]").dataset.set; S.rows[id][t.dataset.rs] = +t.value; if (t.dataset.rs === "pitch") t.nextElementSibling.textContent = (t.value > 0 ? "+" : "") + t.value; save(); return; }
    if (t.id === "bm-swing") S.swing = +t.value; else if (t.id === "bm-blen") S.bassLen = +t.value; else return; save();
  });
  root.addEventListener("change", (e) => {
    const t = e.target, id = t.id;
    if (t.dataset.rs || t.dataset.fx) { snap(); return; } // slider released: make it undoable
    if (id === "bm-bpm") { S.bpm = Math.max(50, Math.min(200, +t.value || 140)); t.value = S.bpm; applyFx(MX); }
    else if (id === "bm-kit") S.kit = t.value;
    else if (id === "bm-key") S.key = +t.value;
    else if (id === "bm-scale") { S.scale = t.value; curDeg = Math.min(curDeg, sc().length * 2 - 1); }
    else if (id === "bm-len") { snap(); const n = +t.value; if (n > S.len) PATS.forEach((p) => ROWS.forEach((r) => { S.patterns[p][r.id] = S.patterns[p][r.id].concat(S.patterns[p][r.id]).slice(0, n); })); S.len = n; normalize(); } // going to 32 repeats the first 16
    else if (id === "bm-kmode") S.keysMode = t.value;
    else if (id === "bm-ksnd") S.keysSound = t.value;
    else if (id === "bm-lsnd") S.leadSound = t.value;
    else if (id === "bm-glide") S.glide = t.checked;
    else if (id === "bm-bars") S.bars = +t.value;
    else if (id === "bm-rep") S.repeats = +t.value;
    else return;
    save(); paintNotes(); paintGrid();
  });

  // stop when leaving the Studio or hiding the page
  const view = document.getElementById("v-studio");
  if (view) new MutationObserver(() => { if (view.hidden) { stop(); padRec = false; paintTransport(); } }).observe(view, { attributes: true, attributeFilter: ["hidden"] });
  document.addEventListener("visibilitychange", () => { if (document.hidden) stop(); });

  if (!hasNotes()) { preset("trap"); undoStack.length = 0; } // first visit: start with a trap beat to play with
  paint();
  window.MW_BEAT = { render: renderBars, exportBars, state: () => S, set: (s) => { S = upgrade(s) || S; normalize(); paint(); }, preset, undo, redo }; // also used for testing
})();
