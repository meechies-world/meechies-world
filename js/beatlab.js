/* Meechie's World Studio: record music right in the browser (like a simple BandLab).
 * Free: up to 4 tracks, record vocals over beats, import beats (your files or the radio library), volume, pan, mute, solo,
 *       metronome, and export a WAV or post your song to the Community feed.
 * Plugin pack (paid, unlocked by Meechie after payment): Reverb, Echo, Vocal Polish, Bass Boost, Pitch (key) shift, and up to 12 tracks. */
(function () {
  "use strict";
  const view = document.getElementById("v-studio");
  if (!view) return;
  const root = view.querySelector("#bl-root");
  const E = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const say = (t) => (typeof toast === "function" ? toast(t) : null);
  const ME = () => (typeof me !== "undefined" ? me : null);
  const DB = () => (typeof db !== "undefined" ? db : null);
  const PRO = () => { try { return !!(typeof isOwner !== "undefined" && isOwner) || !!(typeof members !== "undefined" && members[ME()]?.pro); } catch (_) { return false; } };
  const FREE_TRACKS = 4, PRO_TRACKS = 12;
  const PLUGINS = [["reverb", "Reverb"], ["echo", "Echo"], ["polish", "Vocal Polish"], ["bass", "Bass Boost"], ["pitch", "Key Shift"]];
  const COLORS = ["#d4a843", "#3de0ff", "#ff5c8a", "#7b5cff", "#6fbf8b", "#ff9f43", "#e8e2d5", "#b0263a"];

  let ctx = null, tracks = [], playing = false, recording = false, startAt = 0, playhead = 0, sources = [], raf = 0, bpm = 90, metro = false, metroNodes = [], nextId = 1;
  let rec = null, recChunks = [], recStream = null, recTrack = null, recBegin = 0;
  const audio = () => { if (!ctx) ctx = new (window.AudioContext || window.webkitAudioContext)(); if (ctx.state === "suspended") ctx.resume(); return ctx; };
  const PX = 60; // pixels per second on the timeline

  const css = document.createElement("style");
  css.textContent = `
#bl-root{display:grid;gap:14px}
.bl-bar{display:flex;flex-wrap:wrap;gap:8px;align-items:center;padding:12px;border:1px solid var(--line);border-radius:16px;background:linear-gradient(180deg,#1b160d,#0f0d09);position:sticky;top:64px;z-index:5}
.bl-bar .t{font:800 20px ui-monospace,monospace;color:var(--gold-hi);min-width:84px;text-align:center}
.bl-btn{border:1px solid var(--line);background:#0c0a07;color:var(--text);border-radius:12px;padding:10px 14px;font:800 14px var(--body);cursor:pointer;min-width:44px}
.bl-btn.rec{border-color:#e5484d;color:#ff8b8f}.bl-btn.rec.on{background:#e5484d;color:#fff;animation:blp 1s infinite}
.bl-btn.on{background:var(--gold);color:#0b0a08;border-color:var(--gold)}
@keyframes blp{50%{box-shadow:0 0 0 6px rgba(229,72,77,.3)}}
.bl-bar label{display:flex;align-items:center;gap:6px;font-size:13px;color:var(--muted)}
.bl-bar input[type=number]{width:62px;background:#0c0a07;border:1px solid var(--line);border-radius:8px;color:var(--text);padding:6px;font:16px var(--body)}
.bl-tracks{border:1px solid var(--line);border-radius:16px;overflow:hidden;background:#0a0907}
.bl-scroll{overflow-x:auto;position:relative}
.bl-ruler{height:22px;position:relative;border-bottom:1px solid var(--line);background:#100e0a;cursor:pointer;margin-left:var(--hw)}
.bl-ruler span{position:absolute;top:3px;font:600 10px ui-monospace,monospace;color:var(--muted);transform:translateX(-50%)}
.bl-row{display:grid;grid-template-columns:var(--hw) 1fr;border-bottom:1px solid #1d1a14;min-height:92px}
.bl-head{position:sticky;left:0;z-index:2;background:#13110c;border-right:1px solid var(--line);padding:8px;display:grid;gap:6px;align-content:start}
.bl-head input[type=text]{width:100%;background:transparent;border:0;color:var(--text);font:700 14px var(--body);padding:0}
.bl-head .r{display:flex;gap:4px;flex-wrap:wrap}
.bl-head .r button{border:1px solid var(--line);background:#0c0a07;color:var(--text);border-radius:8px;padding:4px 8px;font:800 11px var(--body);cursor:pointer}
.bl-head .r button.on{background:var(--gold);color:#0b0a08}
.bl-head input[type=range]{width:100%;accent-color:var(--gold)}
.bl-lane{position:relative;cursor:pointer}
.bl-clip{position:absolute;top:8px;bottom:8px;border-radius:8px;overflow:hidden;border:1px solid rgba(255,255,255,.18);cursor:grab;touch-action:none}
.bl-clip canvas{width:100%;height:100%;display:block}
.bl-clip.rec{background:rgba(229,72,77,.25);border-color:#e5484d}
.bl-ph{position:absolute;top:0;bottom:0;width:2px;background:#ff5c5c;pointer-events:none;z-index:3;box-shadow:0 0 8px #ff5c5c}
.bl-fx{display:flex;flex-wrap:wrap;gap:4px}
.bl-fx button{border:1px dashed #5a4a26;background:transparent;color:var(--muted);border-radius:999px;padding:3px 8px;font:700 11px var(--body);cursor:pointer}
.bl-fx button.on{border-style:solid;border-color:var(--gold);color:var(--gold-hi)}
.bl-fx button.lock::after{content:" 🔒"}
.bl-add{display:flex;flex-wrap:wrap;gap:8px;padding:10px}
.bl-file{position:relative;overflow:hidden}.bl-file input{position:absolute;inset:0;opacity:0;cursor:pointer}
.bl-pro{border:1px solid var(--gold);border-radius:16px;padding:16px;background:radial-gradient(ellipse at 0 0,#2a2112,#0f0d09 70%);display:grid;gap:8px}
.bl-lib{display:grid;gap:6px;max-height:240px;overflow:auto}
.bl-lib div{display:flex;justify-content:space-between;gap:8px;align-items:center;padding:8px;border:1px solid var(--line);border-radius:10px;font-size:14px}
.bl-lib span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
#bl-root{--hw:170px}
@media (max-width:640px){#bl-root{--hw:118px}.bl-bar{top:56px}.bl-head .r button{padding:4px 6px}}`;
  document.head.appendChild(css);

  root.innerHTML = `
  <div class="bl-bar">
    <button class="bl-btn" type="button" id="bl-home" aria-label="Back to start">⏮</button>
    <button class="bl-btn" type="button" id="bl-play" aria-label="Play">▶</button>
    <button class="bl-btn rec" type="button" id="bl-rec" aria-label="Record">● REC</button>
    <span class="t" id="bl-time">0:00.0</span>
    <label>BPM <input type="number" id="bl-bpm" min="40" max="220" value="90"></label>
    <button class="bl-btn" type="button" id="bl-metro" aria-label="Metronome">🥁 Click</button>
    <span style="flex:1"></span>
    <button class="bl-btn" type="button" id="bl-export">⬇ Save WAV</button>
    <button class="bl-btn on" type="button" id="bl-post">📣 Post my song</button>
  </div>
  <div class="bl-tracks"><div class="bl-scroll" id="bl-scroll"><div class="bl-ruler" id="bl-ruler"></div><div id="bl-rows"></div><div class="bl-ph" id="bl-ph"></div></div>
    <div class="bl-add">
      <button class="bl-btn" type="button" id="bl-new">＋ Vocal track</button>
      <label class="bl-btn bl-file">📂 Import a beat or sound<input type="file" id="bl-import" accept="audio/*,.mp3,.wav,.m4a,.aac,.ogg" aria-label="Import audio"></label>
      <button class="bl-btn" type="button" id="bl-libbtn">📻 Beats from the radio library</button>
      <small class="muted" id="bl-st" style="align-self:center">Tap ＋ Vocal track, then ● REC. Use headphones so the beat doesn't get into your mic.</small>
    </div>
    <div class="bl-lib" id="bl-lib" hidden style="padding:0 10px 10px"></div>
  </div>
  <div class="bl-pro" id="bl-pro">
    <b style="font-size:18px;color:var(--gold-hi)">🔌 Plugin Pack</b>
    <span class="muted">Reverb, Echo, Vocal Polish (studio compressor + EQ), Bass Boost, Key Shift, and up to ${PRO_TRACKS} tracks. Recording, mixing and posting stay free.</span>
    <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center" id="bl-pro-row"><a class="btn pay-btn" data-pay="plugins" href="#" hidden>Unlock the Plugin Pack</a><small class="muted" id="bl-pro-note">After you pay, Meechie unlocks your plugins (usually same day).</small></div>
    <div id="bl-owner" hidden style="display:grid;gap:6px;margin-top:8px;border-top:1px solid var(--line);padding-top:10px"><b>Owner: unlock a member</b><div style="display:flex;gap:8px"><input type="search" id="bl-uq" placeholder="Member name" aria-label="Member name" style="flex:1;min-width:0;background:var(--ink);border:1px solid var(--line);border-radius:10px;padding:8px;color:var(--text);font:16px var(--body)"></div><div id="bl-ulist" style="display:grid;gap:6px"></div></div>
  </div>`;
  const $ = (s) => root.querySelector(s);

  /* ---------- tracks ---------- */
  function addTrack(name, buffer, offset) {
    const max = PRO() ? PRO_TRACKS : FREE_TRACKS;
    if (tracks.length >= max) { say(PRO() ? "That's the most tracks for one song." : "Free studio has " + FREE_TRACKS + " tracks. Unlock the Plugin Pack for up to " + PRO_TRACKS + "."); return null; }
    const t = { id: nextId++, name: name || "Track " + (tracks.length + 1), buffer: buffer || null, offset: offset || 0, vol: 0.85, pan: 0, mute: false, solo: false, fx: {}, color: COLORS[tracks.length % COLORS.length], armed: !buffer };
    tracks.forEach((x) => { if (!buffer) x.armed = false; });
    tracks.push(t); draw(); return t;
  }
  function songLen() { return Math.max(30, ...tracks.map((t) => (t.buffer ? t.offset + t.buffer.duration : 0))) + 4; }
  function peaks(buf, w) {
    const d = buf.getChannelData(0), step = Math.max(1, Math.floor(d.length / w)), out = new Float32Array(w);
    for (let i = 0; i < w; i++) { let m = 0; for (let j = i * step, e = Math.min(d.length, j + step); j < e; j += 8) { const v = Math.abs(d[j]); if (v > m) m = v; } out[i] = m; }
    return out;
  }
  function drawWave(cv, t) {
    const w = Math.max(10, Math.round(t.buffer.duration * PX)), h = 76; cv.width = w; cv.height = h;
    const g = cv.getContext("2d"); g.fillStyle = t.color + "33"; g.fillRect(0, 0, w, h); g.fillStyle = t.color;
    const p = peaks(t.buffer, w); for (let x = 0; x < w; x++) { const y = p[x] * h * 0.48; g.fillRect(x, h / 2 - y, 1, Math.max(1, y * 2)); }
  }
  function draw() {
    const len = songLen(), W = Math.ceil(len * PX);
    $("#bl-ruler").style.width = W + "px";
    $("#bl-ruler").innerHTML = Array.from({ length: Math.ceil(len) }, (_, s) => (s % 5 === 0 ? `<span style="left:${s * PX}px">${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}</span>` : "")).join("");
    const pro = PRO();
    $("#bl-rows").innerHTML = tracks.map((t) => `<div class="bl-row" data-t="${t.id}">
      <div class="bl-head"><input type="text" value="${E(t.name)}" maxlength="24" data-name="${t.id}" aria-label="Track name">
        <div class="r"><button type="button" class="${t.armed ? "on" : ""}" data-arm="${t.id}" title="Record on this track">●</button><button type="button" class="${t.mute ? "on" : ""}" data-mute="${t.id}">M</button><button type="button" class="${t.solo ? "on" : ""}" data-solo="${t.id}">S</button><button type="button" data-del="${t.id}" aria-label="Delete track">🗑</button></div>
        <input type="range" min="0" max="1.2" step="0.01" value="${t.vol}" data-vol="${t.id}" aria-label="Volume">
        <input type="range" min="-1" max="1" step="0.05" value="${t.pan}" data-pan="${t.id}" aria-label="Pan left or right">
        <div class="bl-fx">${PLUGINS.map(([k, n]) => `<button type="button" class="${t.fx[k] ? "on" : ""} ${pro ? "" : "lock"}" data-fx="${k}" data-tid="${t.id}">${n}</button>`).join("")}</div>
      </div>
      <div class="bl-lane" data-lane="${t.id}" style="width:${W}px">${t.buffer ? `<div class="bl-clip" data-clip="${t.id}" style="left:${t.offset * PX}px;width:${t.buffer.duration * PX}px"><canvas></canvas></div>` : ""}${recording && recTrack === t ? `<div class="bl-clip rec" id="bl-recclip" style="left:${recBegin * PX}px;width:2px"></div>` : ""}</div></div>`).join("") || `<div style="padding:28px;text-align:center" class="muted">Your song starts here. Add a vocal track or import a beat.</div>`;
    tracks.forEach((t) => { const c = root.querySelector(`[data-clip="${t.id}"] canvas`); if (c && t.buffer) drawWave(c, t); });
    $("#bl-pro").hidden = false; $("#bl-pro-note").textContent = pro ? "✅ Your Plugin Pack is unlocked. Tap any effect on a track." : "After you pay, Meechie unlocks your plugins (usually same day).";
    movePH();
  }
  function movePH() { const hw = parseFloat(getComputedStyle(root).getPropertyValue("--hw")) || 170; $("#bl-ph").style.left = hw + playhead * PX + "px"; $("#bl-time").textContent = Math.floor(playhead / 60) + ":" + (playhead % 60).toFixed(1).padStart(4, "0"); }

  /* ---------- effects ---------- */
  function impulse(c, sec, decay) { const n = Math.floor(c.sampleRate * sec), b = c.createBuffer(2, n, c.sampleRate); for (let ch = 0; ch < 2; ch++) { const d = b.getChannelData(ch); for (let i = 0; i < n; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / n, decay); } return b; }
  function chain(c, t, src) {
    let node = src; const pro = PRO();
    if (pro && t.fx.pitch) { try { src.detune.value = 200; } catch (_) {} }
    if (pro && t.fx.polish) { const hp = c.createBiquadFilter(); hp.type = "highpass"; hp.frequency.value = 90; const pres = c.createBiquadFilter(); pres.type = "peaking"; pres.frequency.value = 3500; pres.gain.value = 4; const comp = c.createDynamicsCompressor(); comp.threshold.value = -22; comp.ratio.value = 4; comp.attack.value = 0.005; comp.release.value = 0.15; node.connect(hp); hp.connect(pres); pres.connect(comp); node = comp; }
    if (pro && t.fx.bass) { const ls = c.createBiquadFilter(); ls.type = "lowshelf"; ls.frequency.value = 120; ls.gain.value = 8; node.connect(ls); node = ls; }
    const g = c.createGain(); g.gain.value = t.vol; node.connect(g); node = g;
    const p = c.createStereoPanner ? c.createStereoPanner() : null; if (p) { p.pan.value = t.pan; node.connect(p); node = p; }
    const out = c.createGain(); node.connect(out);
    if (pro && t.fx.reverb) { const cv = c.createConvolver(); cv.buffer = impulse(c, 2.4, 2.6); const wet = c.createGain(); wet.gain.value = 0.32; node.connect(cv); cv.connect(wet); wet.connect(out); }
    if (pro && t.fx.echo) { const dl = c.createDelay(2); dl.delayTime.value = 60 / bpm * 0.75; const fb = c.createGain(); fb.gain.value = 0.35; const wet = c.createGain(); wet.gain.value = 0.35; node.connect(dl); dl.connect(fb); fb.connect(dl); dl.connect(wet); wet.connect(out); }
    return out;
  }
  function audible(t) { const solo = tracks.some((x) => x.solo); return t.buffer && !t.mute && (!solo || t.solo); }

  /* ---------- transport ---------- */
  function play(fromRec) {
    const c = audio(); stopSources();
    startAt = c.currentTime + 0.06 - playhead;
    tracks.forEach((t) => {
      if (!audible(t) || (fromRec && t === recTrack)) return;
      const src = c.createBufferSource(); src.buffer = t.buffer;
      const begin = t.offset - playhead;
      if (begin + t.buffer.duration <= 0) return;
      chain(c, t, src).connect(c.destination);
      if (begin >= 0) src.start(c.currentTime + 0.06 + begin); else src.start(c.currentTime + 0.06, -begin);
      sources.push(src);
    });
    if (metro) scheduleMetro(c);
    try { if (typeof media !== "undefined" && !media.paused) media.pause(); } catch (_) {}
    playing = true; $("#bl-play").textContent = "⏸"; tick();
  }
  function scheduleMetro(c) {
    const beat = 60 / bpm, first = Math.ceil(playhead / beat) * beat;
    for (let b = first; b < playhead + 600; b += beat) {
      const o = c.createOscillator(), g = c.createGain(), at = startAt + b; if (at < c.currentTime) continue;
      o.frequency.value = Math.round(b / beat) % 4 === 0 ? 1600 : 1000; g.gain.setValueAtTime(0.25, at); g.gain.exponentialRampToValueAtTime(0.001, at + 0.05);
      o.connect(g).connect(c.destination); o.start(at); o.stop(at + 0.06); metroNodes.push(o);
      if (metroNodes.length > 1200) break;
    }
  }
  function stopSources() { sources.forEach((s) => { try { s.stop(); } catch (_) {} }); sources = []; metroNodes.forEach((o) => { try { o.stop(); } catch (_) {} }); metroNodes = []; }
  function stop() { if (recording) stopRec(); stopSources(); if (playing && ctx) playhead = Math.max(0, ctx.currentTime - startAt); playing = false; cancelAnimationFrame(raf); $("#bl-play").textContent = "▶"; movePH(); }
  function tick() {
    if (!playing) return; playhead = Math.max(0, ctx.currentTime - startAt); movePH();
    if (recording) { const rc = root.querySelector("#bl-recclip"); if (rc) rc.style.width = Math.max(2, (playhead - recBegin) * PX) + "px"; }
    const sc = $("#bl-scroll"), x = playhead * PX; if (x > sc.scrollLeft + sc.clientWidth - 120 || x < sc.scrollLeft) sc.scrollLeft = Math.max(0, x - 80);
    if (!recording && playhead > songLen()) { stop(); playhead = 0; movePH(); return; }
    raf = requestAnimationFrame(tick);
  }

  /* ---------- recording ---------- */
  async function startRec() {
    if (typeof needMember === "function" && !needMember()) return;
    let t = tracks.find((x) => x.armed) || tracks.find((x) => !x.buffer);
    if (!t) t = addTrack("Vocals"); if (!t) return;
    if (t.buffer && !confirm("Record over \"" + t.name + "\"? The old take will be replaced.")) return;
    try { recStream = recStream || await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false } }); }
    catch (_) { say("Allow the microphone to record."); return; }
    const c = audio();
    const type = ["audio/webm;codecs=opus", "audio/mp4", "audio/webm"].find((x) => window.MediaRecorder && MediaRecorder.isTypeSupported(x)) || "";
    rec = new MediaRecorder(recStream, type ? { mimeType: type } : undefined); recChunks = [];
    rec.ondataavailable = (e) => e.data.size && recChunks.push(e.data);
    recTrack = t; recBegin = playhead; recording = true;
    $("#bl-rec").classList.add("on"); $("#bl-st").textContent = "Recording on " + t.name + "... tap ● again to stop.";
    rec.start(); play(true); draw();
  }
  async function stopRec() {
    if (!rec) return; const r = rec; rec = null; recording = false; $("#bl-rec").classList.remove("on");
    await new Promise((res) => { r.onstop = res; try { r.stop(); } catch (_) { res(); } });
    $("#bl-st").textContent = "Processing your take...";
    try {
      const buf = await audio().decodeAudioData(await new Blob(recChunks, { type: r.mimeType }).arrayBuffer());
      const lat = Math.min(0.4, (ctx.baseLatency || 0) + (ctx.outputLatency || 0.05)); // line the take up with the beat
      recTrack.buffer = buf; recTrack.offset = Math.max(0, recBegin - lat); recTrack.armed = false;
      $("#bl-st").textContent = "Got it. Drag the take to move it, or tap ● on a track to record again.";
    } catch (_) { $("#bl-st").textContent = "That take couldn't be saved. Try again."; }
    draw();
  }

  /* ---------- import ---------- */
  async function importArrayBuffer(ab, name) {
    try { const buf = await audio().decodeAudioData(ab); const t = addTrack(name.slice(0, 24), buf, 0); if (t) $("#bl-st").textContent = "Added " + name + ". Now add a vocal track and record over it."; }
    catch (_) { say("That file isn't audio we can open. Try an MP3 or WAV."); }
  }
  $("#bl-import").addEventListener("change", async (e) => { const f = e.target.files[0]; e.target.value = ""; if (!f) return; if (f.size > 60 * 1048576) { say("That file is too big (over 60 MB)."); return; } $("#bl-st").textContent = "Opening " + f.name + "..."; importArrayBuffer(await f.arrayBuffer(), f.name.replace(/\.[^.]+$/, "")); });
  $("#bl-libbtn").addEventListener("click", () => {
    const lib = $("#bl-lib"), rad = (window.MW_TRACKS ? window.MW_TRACKS() : []) || []; // the radio library (main page)
    lib.hidden = !lib.hidden; if (lib.hidden) return;
    lib.innerHTML = rad && rad.length ? rad.map((t, i) => `<div><span>${E(t.title)}</span><button class="btn ghost sm" type="button" data-rl="${i}">Use</button></div>`).join("") : '<small class="muted">The radio library is empty.</small>';
    lib.onclick = async (e) => { const b = e.target.closest("[data-rl]"); if (!b) return; const t = rad[+b.dataset.rl]; b.disabled = true; b.textContent = "Loading..."; try { const ab = await (await fetch(MW.assetUrl(t.assetId))).arrayBuffer(); await importArrayBuffer(ab, t.title); lib.hidden = true; } catch (_) { say("Couldn't load that song."); b.disabled = false; b.textContent = "Use"; } };
  });

  /* ---------- export ---------- */
  async function render() {
    const len = Math.max(1, ...tracks.filter(audible).map((t) => t.offset + t.buffer.duration)) + 1.5;
    const sr = 44100, oc = new OfflineAudioContext(2, Math.ceil(len * sr), sr);
    tracks.forEach((t) => { if (!audible(t)) return; const s = oc.createBufferSource(); s.buffer = t.buffer; chain(oc, t, s).connect(oc.destination); s.start(t.offset); });
    return oc.startRendering();
  }
  function wav(buf) {
    const ch = 2, sr = buf.sampleRate, n = buf.length, out = new DataView(new ArrayBuffer(44 + n * ch * 2)); let o = 0;
    const w = (s) => { for (let i = 0; i < s.length; i++) out.setUint8(o++, s.charCodeAt(i)); }, u32 = (v) => { out.setUint32(o, v, true); o += 4; }, u16 = (v) => { out.setUint16(o, v, true); o += 2; };
    w("RIFF"); u32(36 + n * ch * 2); w("WAVE"); w("fmt "); u32(16); u16(1); u16(ch); u32(sr); u32(sr * ch * 2); u16(ch * 2); u16(16); w("data"); u32(n * ch * 2);
    const L = buf.getChannelData(0), R = buf.numberOfChannels > 1 ? buf.getChannelData(1) : L;
    for (let i = 0; i < n; i++) { for (const d of [L, R]) { const v = Math.max(-1, Math.min(1, d[i])); out.setInt16(o, v < 0 ? v * 0x8000 : v * 0x7fff, true); o += 2; } }
    return new Blob([out], { type: "audio/wav" });
  }
  $("#bl-export").addEventListener("click", async () => {
    if (!tracks.some(audible)) { say("Record or import something first."); return; }
    $("#bl-st").textContent = "Mixing your song..."; const blob = wav(await render());
    const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = "meechies-world-song.wav"; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 60000);
    $("#bl-st").textContent = "Saved to your device.";
  });
  $("#bl-post").addEventListener("click", async (e) => {
    if (typeof needMember === "function" && !needMember()) return;
    if (!tracks.some(audible)) { say("Record or import something first."); return; }
    const title = prompt("Name your song", "My new song"); if (title === null) return;
    const b = e.currentTarget; b.disabled = true; b.textContent = "Mixing...";
    try {
      const blob = wav(await render());
      if (blob.size > 50 * 1048576) throw new Error("This song is too long to post (over 50 MB). Save the WAV instead.");
      const up = await MW.uploadMedia(blob, { type: "audio/wav", ext: "wav", onProg: (f) => { b.textContent = "Uploading " + Math.round(f * 100) + "%"; } });
      await DB().collection("posts").add({ authorId: ME(), text: "🎤 New song: " + String(title).slice(0, 80) + " (made in the Meechie's World Studio)", photo: "", audio: up.url, audioPath: up.path, likes: [], replyCount: 0, sponsored: false, announce: false, createdAt: Date.now() });
      say("Your song is posted in the Community feed!");
    } catch (err) { say(err.message || "Couldn't post."); }
    b.disabled = false; b.textContent = "📣 Post my song";
  });

  /* ---------- controls ---------- */
  $("#bl-play").addEventListener("click", () => (playing ? stop() : play()));
  $("#bl-home").addEventListener("click", () => { const p = playing; stop(); playhead = 0; movePH(); $("#bl-scroll").scrollLeft = 0; if (p) play(); });
  $("#bl-rec").addEventListener("click", () => (recording ? stop() : (playing && stop(), startRec())));
  $("#bl-metro").addEventListener("click", (e) => { metro = !metro; e.currentTarget.classList.toggle("on", metro); if (playing) { stop(); play(); } });
  $("#bl-bpm").addEventListener("change", (e) => { bpm = Math.max(40, Math.min(220, +e.target.value || 90)); e.target.value = bpm; });
  $("#bl-new").addEventListener("click", () => { const t = addTrack("Vocals " + (tracks.filter((x) => /vocal/i.test(x.name)).length + 1)); if (t) $("#bl-st").textContent = "New track ready. Tap ● REC to record."; });
  $("#bl-ruler").addEventListener("click", (e) => { const r = e.currentTarget.getBoundingClientRect(); const p = playing; stop(); playhead = Math.max(0, (e.clientX - r.left) / PX); movePH(); if (p) play(); });
  root.addEventListener("input", (e) => {
    const t = tracks.find((x) => x.id === +(e.target.dataset.vol || e.target.dataset.pan || e.target.dataset.name)); if (!t) return;
    if (e.target.dataset.vol) t.vol = +e.target.value; if (e.target.dataset.pan) t.pan = +e.target.value; if (e.target.dataset.name) t.name = e.target.value;
  });
  root.addEventListener("change", (e) => { if ((e.target.dataset.vol || e.target.dataset.pan) && playing) { stop(); play(); } });
  root.addEventListener("click", (e) => {
    const b = e.target.closest("button"); if (!b) return;
    const id = +(b.dataset.arm || b.dataset.mute || b.dataset.solo || b.dataset.del || b.dataset.tid || 0); const t = tracks.find((x) => x.id === id); if (!t) return;
    if (b.dataset.arm) { tracks.forEach((x) => (x.armed = x === t ? !x.armed : false)); draw(); }
    if (b.dataset.mute) { t.mute = !t.mute; draw(); if (playing) { stop(); play(); } }
    if (b.dataset.solo) { t.solo = !t.solo; draw(); if (playing) { stop(); play(); } }
    if (b.dataset.del) { if (!b.dataset.confirm) { b.dataset.confirm = 1; b.textContent = "Sure?"; return; } stop(); tracks = tracks.filter((x) => x !== t); draw(); }
    if (b.dataset.fx) {
      if (!PRO()) { root.querySelector("#bl-pro").scrollIntoView({ behavior: "smooth", block: "center" }); say("That's in the Plugin Pack. Unlock it below."); return; }
      t.fx[b.dataset.fx] = !t.fx[b.dataset.fx]; draw(); if (playing) { stop(); play(); }
    }
  });
  // drag a clip to move it in time
  root.addEventListener("pointerdown", (e) => {
    const cl = e.target.closest(".bl-clip[data-clip]"); if (!cl) return;
    const t = tracks.find((x) => x.id === +cl.dataset.clip); if (!t) return;
    e.preventDefault(); cl.setPointerCapture(e.pointerId); const x0 = e.clientX, o0 = t.offset;
    const mv = (ev) => { t.offset = Math.max(0, o0 + (ev.clientX - x0) / PX); cl.style.left = t.offset * PX + "px"; };
    const up = () => { cl.removeEventListener("pointermove", mv); cl.removeEventListener("pointerup", up); cl.removeEventListener("pointercancel", up); if (playing) { stop(); play(); } };
    cl.addEventListener("pointermove", mv); cl.addEventListener("pointerup", up); cl.addEventListener("pointercancel", up);
  });
  // owner: unlock the Plugin Pack for members who paid
  function ownerPanel() {
    const own = typeof isOwner !== "undefined" && isOwner, box = $("#bl-owner"); box.hidden = !own; if (!own) return;
    const q = ($("#bl-uq").value || "").toLowerCase(), mem = typeof members !== "undefined" ? members : {};
    const rows = Object.entries(mem).filter(([id, m]) => m && m.handle && (q ? m.handle.toLowerCase().includes(q) : m.pro)).slice(0, 12);
    $("#bl-ulist").innerHTML = rows.map(([id, m]) => `<div style="display:flex;justify-content:space-between;gap:8px;align-items:center"><span>${E(m.handle)}${m.pro ? " ✅" : ""}</span><button class="btn ${m.pro ? "ghost" : ""} sm" type="button" data-unlock="${E(id)}" data-on="${m.pro ? 0 : 1}">${m.pro ? "Remove" : "Unlock"}</button></div>`).join("") || `<small class="muted">${q ? "No one by that name." : "Type a member's name to unlock their plugins."}</small>`;
  }
  $("#bl-uq").addEventListener("input", ownerPanel);
  $("#bl-ulist").addEventListener("click", async (e) => { const b = e.target.closest("[data-unlock]"); if (!b) return; try { await DB().doc("members/" + b.dataset.unlock).update({ pro: b.dataset.on === "1" }); say(b.dataset.on === "1" ? "Plugins unlocked" : "Plugins removed"); setTimeout(ownerPanel, 600); } catch (err) { say(err.message || err.code); } });
  // stop when leaving the page
  new MutationObserver(() => { if (view.hidden && (playing || recording)) stop(); if (!view.hidden) { draw(); ownerPanel(); } }).observe(view, { attributes: true, attributeFilter: ["hidden"] });
  draw();
})();
