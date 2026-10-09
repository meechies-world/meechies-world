/* Pitch tools for the Studio (no outside services, runs on the phone or computer).
 *  MWPitch.autotune(buffer, { key: 0-11, scale: "chromatic"|"major"|"minor", strength: 0..1, speed: 0..1 }) -> AudioBuffer
 *     strength 1 + speed 0 = the hard "T-Pain" robot sound; lower = natural correction.
 *  MWPitch.shift(buffer, semitones) -> AudioBuffer   (changes the key without changing the speed)
 * Method: pitch detection (YIN on a 12 kHz copy) + TD-PSOLA resynthesis. */
(function () {
  "use strict";
  const SCALES = { chromatic: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11], major: [0, 2, 4, 5, 7, 9, 11], minor: [0, 2, 3, 5, 7, 8, 10] };
  const tick = () => new Promise((r) => setTimeout(r, 0));

  function mono(buf) {
    const n = buf.length, out = new Float32Array(n);
    for (let c = 0; c < buf.numberOfChannels; c++) { const d = buf.getChannelData(c); for (let i = 0; i < n; i++) out[i] += d[i] / buf.numberOfChannels; }
    return out;
  }
  // pitch track: one value per hop (in samples of the original rate), 0 = no clear pitch
  async function track(x, sr, hop) {
    const ds = Math.max(1, Math.round(sr / 12000)), sr2 = sr / ds, n2 = Math.floor(x.length / ds);
    const y = new Float32Array(n2); for (let i = 0; i < n2; i++) { let s = 0; for (let k = 0; k < ds; k++) s += x[i * ds + k]; y[i] = s / ds; }
    const W = 512, minLag = Math.floor(sr2 / 1000), maxLag = Math.ceil(sr2 / 70), hop2 = hop / ds;
    const frames = Math.ceil(x.length / hop), f0 = new Float32Array(frames), d = new Float32Array(maxLag + 1);
    for (let f = 0; f < frames; f++) {
      const c = Math.floor(f * hop2) - W / 2; if (c < 0 || c + W + maxLag >= n2) continue;
      let e = 0; for (let i = 0; i < W; i++) e += y[c + i] * y[c + i]; if (e / W < 1e-5) continue; // silence
      for (let lag = 1; lag <= maxLag; lag++) { let s = 0; for (let i = 0; i < W; i++) { const v = y[c + i] - y[c + i + lag]; s += v * v; } d[lag] = s; }
      // YIN cumulative mean normalised difference
      const nd = new Float32Array(maxLag + 2); let run = 0; nd[0] = 1;
      for (let lag = 1; lag <= maxLag; lag++) { run += d[lag]; nd[lag] = run ? d[lag] * lag / run : 1; }
      let best = -1;
      for (let lag = minLag; lag <= maxLag; lag++) { if (nd[lag] < 0.15) { while (lag + 1 <= maxLag && nd[lag + 1] < nd[lag]) lag++; best = lag; break; } }
      if (best > 1 && best < maxLag) { const a = nd[best - 1], b = nd[best], cc = nd[best + 1]; const den = a - 2 * b + cc; const fine = den ? best + (a - cc) / (2 * den) : best; f0[f] = sr2 / fine; }
      if (f % 400 === 0) await tick();
    }
    // tidy: median of 5 and drop lone blips
    const out = new Float32Array(frames);
    for (let f = 0; f < frames; f++) { const w = []; for (let k = -2; k <= 2; k++) { const v = f0[f + k]; if (v) w.push(v); } out[f] = w.length >= 3 ? w.sort((p, q) => p - q)[w.length >> 1] : 0; }
    return out;
  }
  // overlap-add grains at new spacing (TD-PSOLA). ratioAt(sampleIndex) gives the pitch change at that point (1 = none).
  async function psola(x, sr, f0, hop, ratioAt) {
    const n = x.length, out = new Float32Array(n), wsum = new Float32Array(n);
    const periodAt = (i) => { const f = f0[Math.min(f0.length - 1, Math.floor(i / hop))]; return f ? sr / f : 0; };
    // analysis marks: one per pitch period on voiced parts (snapped to the strongest peak), fixed spacing elsewhere
    const marks = []; let i = 0;
    while (i < n) {
      const P = periodAt(i);
      if (P) { const r = Math.floor(P / 2); let bi = i, bv = -1; for (let k = Math.max(0, i - r); k < Math.min(n, i + r); k++) { const v = Math.abs(x[k]); if (v > bv) { bv = v; bi = k; } } if (marks.length && bi <= marks[marks.length - 1]) bi = marks[marks.length - 1] + Math.max(1, Math.floor(P * 0.5)); marks.push(bi); i = bi + Math.max(32, Math.round(P)); }
      else { marks.push(i); i += 256; }
    }
    let ts = marks[0] || 0, mi = 0, steps = 0;
    while (ts < n) {
      while (mi + 1 < marks.length && Math.abs(marks[mi + 1] - ts) <= Math.abs(marks[mi] - ts)) mi++;
      const m = marks[mi], Pa = periodAt(m) || 256, voiced = !!periodAt(m), r = voiced ? ratioAt(m) : 1;
      const L = Math.round(Pa); // grain half-length
      for (let k = -L; k < L; k++) {
        const src = m + k, dst = Math.round(ts) + k; if (src < 0 || src >= n || dst < 0 || dst >= n) continue;
        const w = 0.5 - 0.5 * Math.cos(Math.PI * (k + L) / L); out[dst] += x[src] * w; wsum[dst] += w;
      }
      ts += voiced ? Pa / r : Pa;
      if (++steps % 2000 === 0) await tick();
    }
    for (let k = 0; k < n; k++) out[k] = wsum[k] > 0.15 ? out[k] / wsum[k] : out[k];
    return out;
  }
  function toBuffer(ctxLike, data, sr) {
    const AC = window.OfflineAudioContext || window.webkitOfflineAudioContext;
    const b = new AudioBuffer({ length: data.length, numberOfChannels: 2, sampleRate: sr });
    b.copyToChannel(data, 0); b.copyToChannel(data, 1); return b;
  }
  const snap = (midi, key, scale) => {
    const pcs = SCALES[scale] || SCALES.chromatic; let best = midi, bd = 99;
    for (let o = -1; o <= 1; o++) for (const pc of pcs) { const base = Math.floor(midi / 12) * 12 + o * 12 + ((pc + key) % 12); const dd = Math.abs(base - midi); if (dd < bd) { bd = dd; best = base; } }
    return best;
  };
  async function autotune(buf, o = {}) {
    const sr = buf.sampleRate, x = mono(buf), hop = Math.round(sr * 0.005);
    const f0 = await track(x, sr, hop);
    const key = o.key | 0, scale = o.scale || "chromatic", strength = o.strength ?? 1, speed = o.speed ?? 0;
    // desired pitch ratio per frame, glided by "retune speed" (0 = instant snap)
    const ratio = new Float32Array(f0.length).fill(1); let prev = 0;
    for (let f = 0; f < f0.length; f++) {
      if (!f0[f]) { prev = 0; continue; }
      const midi = 69 + 12 * Math.log2(f0[f] / 440), tgt = snap(midi, key, scale), want = (tgt - midi) * strength;
      const cur = prev && speed > 0 ? prev + (want - prev) * (1 - speed * 0.92) : want; prev = cur || 1e-9;
      ratio[f] = Math.pow(2, cur / 12);
    }
    const y = await psola(x, sr, f0, hop, (i) => ratio[Math.min(ratio.length - 1, Math.floor(i / hop))]);
    return toBuffer(null, y, sr);
  }
  async function shift(buf, semis) {
    const sr = buf.sampleRate, x = mono(buf), hop = Math.round(sr * 0.005);
    const f0 = await track(x, sr, hop), r = Math.pow(2, semis / 12);
    const y = await psola(x, sr, f0, hop, () => r);
    return toBuffer(null, y, sr);
  }
  window.MWPitch = { autotune, shift, SCALES };
})();
