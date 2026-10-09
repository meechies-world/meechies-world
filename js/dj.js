/* DJ table for the Radio page.
 * Owner: two decks + crossfader, load songs from the Library or free (Creative Commons) music from the Internet Archive,
 *        a Talk button that records your voice and sends it out over the music to everyone listening,
 *        and a Go Live switch.
 * Listeners: when Meechie is live on the decks, the site plays the same mix in sync (doc radio/dj). */
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

  /* ---------- a deck: one audio element with its own gain ---------- */
  let ctx = null;
  function actx() { if (!ctx) { try { ctx = new (window.AudioContext || window.webkitAudioContext)(); } catch (_) { ctx = null; } } if (ctx && ctx.state === "suspended") ctx.resume().catch(() => {}); return ctx; }
  function Deck() {
    const d = { el: new Audio(), gain: null, src: "", level: 1, cors: true };
    d.el.preload = "auto"; d.el.playsInline = true; d.el.crossOrigin = "anonymous";
    d.set = (src) => new Promise((res) => {
      if (d.src === src) return res(true);
      d.src = src; d.cors = true; d.el.crossOrigin = "anonymous"; d.el.src = src;
      const ok = () => { clean(); wire(); res(true); };
      const bad = () => { clean(); if (d.cors) { d.cors = false;
          if (d.gain) { const old = d.el; old.pause(); d.el = new Audio(); d.el.preload = "auto"; d.el.playsInline = true; d.gain = null; d.onswap && d.onswap(old); }
          d.el.removeAttribute("crossorigin"); d.el.src = src; d.el.addEventListener("loadedmetadata", () => res(true), { once: true }); d.el.addEventListener("error", () => res(false), { once: true }); } else res(false); };
      const clean = () => { d.el.removeEventListener("loadedmetadata", ok); d.el.removeEventListener("error", bad); };
      d.el.addEventListener("loadedmetadata", ok); d.el.addEventListener("error", bad);
    });
    function wire() { const c = actx(); if (!c || d.gain || !d.cors) return; try { const s = c.createMediaElementSource(d.el); d.gain = c.createGain(); s.connect(d.gain).connect(c.destination); } catch (_) { d.gain = null; } d.apply(); }
    d.vol = (v) => { d.level = Math.max(0, Math.min(1, v)); d.apply(); };
    d.apply = () => { if (d.gain) { d.gain.gain.value = d.level; d.el.volume = 1; } else d.el.volume = d.level; };
    d.stop = () => { try { d.el.pause(); } catch (_) {} };
    return d;
  }
  const xfGain = (xf, side) => Math.cos((side === "A" ? xf : 1 - xf) * Math.PI / 2); // equal-power crossfade

  /* ---------- shared state ---------- */
  const blank = () => ({ src: "", title: "", cover: "", start: 0, pos: 0, playing: false, vol: 0.9 });
  let S = { live: false, xf: 0.5, duck: false, A: blank(), B: blank(), voice: null, updatedAt: 0 };
  const posOf = (k) => { const s = S[k]; return s.playing ? Math.max(0, (Date.now() - s.start) / 1000) : (s.pos || 0); };
  let saveT = null;
  function save(now) { if (!OWNER()) return; clearTimeout(saveT); const run = () => { S.updatedAt = Date.now(); DB()?.doc("radio/dj").set(JSON.parse(JSON.stringify(S))).catch((e) => say(e.message || e.code)); }; if (now) run(); else saveT = setTimeout(run, 250); }

  /* ---------- styles ---------- */
  const css = document.createElement("style");
  css.textContent = `
.dj{margin-top:40px;border:1px solid var(--gold-lo);border-radius:20px;padding:18px;background:radial-gradient(ellipse at 50% 0,#2a2112 0,#100d08 60%);box-shadow:0 20px 50px rgba(0,0,0,.5)}
.dj-top{display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap;margin-bottom:14px}
.dj-top h3{margin:0;font-size:26px}
.dj-live{display:flex;align-items:center;gap:8px;font-weight:700}
.dj-live input{width:20px;height:20px;accent-color:#e5484d}
.dj-decks{display:grid;grid-template-columns:1fr 150px 1fr;gap:14px;align-items:stretch}
.deck{background:#0c0a07;border:1px solid var(--line);border-radius:16px;padding:14px;display:grid;gap:10px;justify-items:center;text-align:center;min-width:0}
.deck h4{margin:0;font:800 13px var(--body);letter-spacing:.18em;color:var(--gold-hi)}
.platter{width:min(150px,36vw);aspect-ratio:1;border-radius:50%;background:repeating-radial-gradient(circle,#111 0 2px,#1b1b1b 2px 4px);border:3px solid #2a2418;position:relative;box-shadow:inset 0 0 20px #000,0 8px 20px rgba(0,0,0,.6)}
.platter::after{content:"";position:absolute;inset:34%;border-radius:50%;background:var(--gold) center/cover;box-shadow:0 0 0 3px #0c0a07}
.platter.has-cover::after{background-image:var(--cv)}
.platter.spin{animation:djspin 1.8s linear infinite}
@keyframes djspin{to{transform:rotate(360deg)}}
.deck .ttl{font-weight:700;font-size:14px;max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.deck .tm{font:600 12px ui-monospace,monospace;color:var(--muted)}
.deck .row{display:flex;gap:8px;justify-content:center;flex-wrap:wrap}
.deck input[type=range],.mixer input[type=range]{width:100%;accent-color:var(--gold)}
.mixer{background:#0c0a07;border:1px solid var(--line);border-radius:16px;padding:14px 10px;display:grid;gap:12px;align-content:center;justify-items:center;text-align:center}
.mixer small{color:var(--muted);font-size:11px;letter-spacing:.12em}
.talk{width:96px;height:96px;border-radius:50%;border:3px solid #e5484d;background:#2a0f10;color:#fff;font:800 14px var(--body);cursor:pointer;touch-action:none;user-select:none;-webkit-user-select:none}
.talk.on{background:#e5484d;box-shadow:0 0 0 8px rgba(229,72,77,.25),0 0 30px #e5484d}
.dj-src{display:grid;grid-template-columns:1fr 1fr;gap:14px;margin-top:14px}
.dj-src .card{display:grid;gap:10px;min-width:0;grid-template-columns:minmax(0,1fr)}
.dj-list{display:grid;gap:6px;max-height:260px;overflow:auto}
.dj-item{display:grid;grid-template-columns:minmax(0,1fr) auto auto;gap:6px;align-items:center;padding:8px;border:1px solid var(--line);border-radius:10px;font-size:14px}
.dj-item span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dj-search{display:flex;gap:8px}.dj-search input{flex:1;min-width:0;background:var(--ink);border:1px solid var(--line);border-radius:10px;padding:10px;color:var(--text);font:16px var(--body)}
.dj-banner{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;margin-top:20px;padding:14px 16px;border-radius:14px;border:1px solid #e5484d;background:linear-gradient(90deg,#2a0f10,#15130f)}
.dj-banner b{color:#ff8b8f}
@media (max-width:760px){.dj-decks{grid-template-columns:1fr 1fr}.mixer{grid-column:1/-1;grid-row:2}.dj-src{grid-template-columns:1fr}}`;
  document.head.appendChild(css);

  root.innerHTML = `
<div class="dj-banner" id="dj-banner" hidden><span><b>● LIVE DJ SET</b> &nbsp;Meechie is on the decks right now</span><button class="btn sm" type="button" id="dj-listen">🎧 Listen live</button></div>
<div class="dj" id="dj-owner" hidden>
  <div class="dj-top"><div><p class="eyebrow" style="margin:0">Owner only</p><h3>DJ Table</h3></div>
    <label class="dj-live"><input type="checkbox" id="dj-golive"> Go live (everyone listening hears your mix)</label></div>
  <div class="dj-decks">
    ${["A", "B"].map((k) => `<div class="deck" data-deck="${k}"><h4>DECK ${k}</h4><div class="platter" id="pl-${k}"></div>
      <div class="ttl" id="ttl-${k}">Load a song</div><div class="tm" id="tm-${k}">0:00</div>
      <div class="row"><button class="btn sm" type="button" data-play="${k}">▶ Play</button><button class="btn ghost sm" type="button" data-cue="${k}">⏮ Cue</button></div>
      <label style="width:100%;font-size:12px;color:var(--muted)">Volume<input type="range" min="0" max="1" step="0.01" value="0.9" data-vol="${k}" aria-label="Deck ${k} volume"></label></div>`).join("")}
    <div class="mixer"><small>MIC</small>
      <button class="talk" type="button" id="dj-talk" aria-label="Hold to talk">🎙️<br>HOLD TO TALK</button>
      <small id="dj-talk-st">Hold, talk, let go</small>
      <small>CROSSFADER</small><input type="range" min="0" max="1" step="0.01" value="0.5" id="dj-xf" aria-label="Crossfader">
      <div style="display:flex;justify-content:space-between;width:100%;font:700 11px var(--body);color:var(--gold-hi)"><span>A</span><span>B</span></div></div>
  </div>
  <div class="dj-src">
    <div class="card"><b>Your Library</b><div class="dj-list" id="dj-lib"></div></div>
    <div class="card"><b>Free music from the internet</b><form class="dj-search" id="dj-sf"><input type="search" id="dj-q" placeholder="Search: hip hop, jazz, beats..." aria-label="Search free music"><button class="btn sm" type="submit">Search</button></form>
      <small class="muted">Creative Commons music from the Internet Archive, free to play on your station.</small><div class="dj-list" id="dj-net"></div></div>
  </div>
</div>`;
  const $ = (s) => root.querySelector(s);
  const decks = { A: null, B: null };
  const deck = (k) => decks[k] || (decks[k] = Deck());
  const fmt = (s) => { s = Math.max(0, Math.floor(s || 0)); return Math.floor(s / 60) + ":" + String(s % 60).padStart(2, "0"); };

  /* ---------- apply state to the local decks (owner and listeners) ---------- */
  let listening = false, voiceEl = null, heardVoice = "";
  function levels() {
    const duck = S.duck || (voiceEl && !voiceEl.paused) ? 0.28 : 1;
    ["A", "B"].forEach((k) => { if (decks[k]) decks[k].vol((S[k].vol ?? 0.9) * xfGain(S.xf, k) * duck); });
  }
  async function follow(k) {
    const s = S[k], d = deck(k);
    if (!okUrl(s.src)) { d.stop(); return; }
    await d.set(s.src);
    const want = posOf(k);
    if (s.playing) {
      if (d.el.duration && want >= d.el.duration - 0.3) { d.el.pause(); levels(); return; } // song is over; don't loop the last second
      if (!d.el.seeking && d.el.readyState >= 3 && Math.abs(d.el.currentTime - want) > 4) { try { d.el.currentTime = want; } catch (_) {} }
      if (d.el.paused) d.el.play().catch(() => {});
    }
    else { d.el.pause(); if (Math.abs(d.el.currentTime - want) > 0.5) { try { d.el.currentTime = want; } catch (_) {} } }
    levels();
  }
  function playVoice() {
    const v = S.voice; if (!v || !okUrl(v.url) || heardVoice === v.id || Date.now() - (v.at || 0) > 90000) return;
    heardVoice = v.id; if (!listening) return; // only people listening to the live set hear it (the owner already heard himself)
    voiceEl = new Audio(v.url); voiceEl.playsInline = true; levels();
    voiceEl.addEventListener("ended", levels); voiceEl.addEventListener("error", levels); voiceEl.play().catch(levels);
  }
  function paintOwner() {
    ["A", "B"].forEach((k) => {
      const s = S[k], pl = $("#pl-" + k);
      $("#ttl-" + k).textContent = s.title || "Load a song";
      pl.classList.toggle("spin", !!s.playing);
      pl.classList.toggle("has-cover", okUrl(s.cover)); if (okUrl(s.cover)) pl.style.setProperty("--cv", `url("${s.cover}")`);
      root.querySelector(`[data-play="${k}"]`).textContent = s.playing ? "⏸ Pause" : "▶ Play";
      root.querySelector(`[data-vol="${k}"]`).value = s.vol ?? 0.9;
    });
    $("#dj-xf").value = S.xf; $("#dj-golive").checked = !!S.live;
  }
  setInterval(() => { ["A", "B"].forEach((k) => { const el = $("#tm-" + k); if (el && decks[k]) el.textContent = fmt(decks[k].el.currentTime) + (decks[k].el.duration ? " / " + fmt(decks[k].el.duration) : ""); }); if (listening) { follow("A"); follow("B"); } }, 1000);

  /* ---------- listeners ---------- */
  function isLive() { return S.live && Date.now() - (S.updatedAt || 0) < 3 * 60e3; }
  setInterval(() => { if (OWNER() && S.live) save(true); }, 60000); // heartbeat so listeners know the set is still on
  setInterval(() => { if (!OWNER() && S.live) { const l = isLive(); $("#dj-banner").hidden = !l; if (!l && listening) endSet(); } }, 30000);
  function startListening() {
    listening = true; actx();
    try { if (typeof media !== "undefined") media.pause(); if (typeof mode !== "undefined") mode = "dj"; } catch (_) {}
    $("#dj-listen").textContent = "⏹ Stop listening"; follow("A"); follow("B");
    try { if (typeof showBar === "function") showBar({ title: "LIVE DJ SET", artist: "Meechie", cover: "" }, "Live on the decks"); } catch (_) {}
    try { navigator.mediaSession.playbackState = "playing"; } catch (_) {}
    try { if ("mediaSession" in navigator) navigator.mediaSession.metadata = new MediaMetadata({ title: "LIVE DJ SET", artist: "Meechie", album: "Meechie's World Radio", artwork: [{ src: location.origin + "/img/icon-512.png", sizes: "512x512", type: "image/png" }] }); } catch (_) {}
  }
  function stopListening() { listening = false; ["A", "B"].forEach((k) => decks[k]?.stop()); voiceEl?.pause(); $("#dj-listen").textContent = "🎧 Listen live"; try { navigator.mediaSession.playbackState = "paused"; } catch (_) {} }
  let autoMoved = false;
  function endSet() { stopListening(); if (autoMoved) { autoMoved = false; try { if (typeof tuneIn === "function") tuneIn(); } catch (_) {} } }
  window.MW_DJ = { start: () => { if (isLive()) startListening(); }, stop: stopListening };
  // anything else starting on the main player ends DJ listening
  if (typeof media !== "undefined") media.addEventListener("play", () => { if (listening) { listening = false; ["A", "B"].forEach((k) => decks[k]?.stop()); voiceEl?.pause(); $("#dj-listen").textContent = "🎧 Listen live"; } });
  $("#dj-listen").addEventListener("click", () => (listening ? stopListening() : startListening()));

  let ownerLoaded = false;
  function onState(d) {
    // the owner's screen is the source of truth once loaded; only restore from the saved state the first time
    if (OWNER() && ownerLoaded) return;
    if (OWNER()) ownerLoaded = true;
    const was = isLive();
    S = Object.assign({ live: false, xf: 0.5, duck: false, A: blank(), B: blank(), voice: null }, d || {});
    S.A = Object.assign(blank(), S.A || {}); S.B = Object.assign(blank(), S.B || {});
    const live = isLive();
    $("#dj-banner").hidden = !live || OWNER();
    if (!live && listening) endSet();
    // people already listening to the station move over to the live set automatically
    if (live && !was && !OWNER() && typeof mode !== "undefined" && mode === "radio" && typeof media !== "undefined" && !media.paused) { autoMoved = true; startListening(); }
    if (listening) { follow("A"); follow("B"); }
    playVoice();
  }

  /* ---------- owner controls ---------- */
  function libList() {
    const list = TRACKS();
    $("#dj-lib").innerHTML = list.length ? list.map((t, i) => `<div class="dj-item"><span title="${E(t.title)}">${E(t.title)}</span><button class="btn ghost sm" type="button" data-load="A" data-lib="${i}">A</button><button class="btn ghost sm" type="button" data-load="B" data-lib="${i}">B</button></div>`).join("") : '<small class="muted">No songs in your library yet.</small>';
  }
  let net = [];
  async function load(k, item) {
    const d = deck(k); actx();
    S[k] = Object.assign(blank(), { src: item.src, title: item.title, cover: item.cover || "", vol: S[k].vol ?? 0.9 });
    paintOwner(); $("#ttl-" + k).textContent = "Loading " + item.title + "...";
    const ok = await d.set(item.src);
    if (!ok) { say("That song couldn't load. Try another one."); S[k] = blank(); paintOwner(); return; }
    d.el.currentTime = 0; paintOwner(); levels(); save();
  }
  root.addEventListener("click", async (e) => {
    const b = e.target.closest("button"); if (!b || !OWNER()) return;
    if (b.dataset.load) {
      if (b.dataset.lib != null) { const t = TRACKS()[+b.dataset.lib]; if (t) load(b.dataset.load, { src: URLOF(t), title: t.title, cover: t.cover }); }
      else if (b.dataset.net != null) { const n = net[+b.dataset.net]; if (!n) return; b.disabled = true; const src = await iaFile(n.id); b.disabled = false; if (!src) { say("No playable file in that one. Pick another."); return; } load(b.dataset.load, { src, title: n.title, cover: "https://archive.org/services/img/" + encodeURIComponent(n.id) }); }
      return;
    }
    if (b.dataset.play) {
      const k = b.dataset.play, s = S[k], d = deck(k); if (!okUrl(s.src)) { say("Load a song on deck " + k + " first."); return; }
      actx(); try { if (typeof media !== "undefined" && !media.paused) media.pause(); } catch (_) {}
      if (s.playing) { s.pos = d.el.currentTime; s.playing = false; d.el.pause(); }
      else { await d.set(s.src); try { d.el.currentTime = s.pos || 0; } catch (_) {} await d.el.play().catch(() => {}); s.start = Date.now() - d.el.currentTime * 1000; s.playing = true; }
      paintOwner(); levels(); save(true); return;
    }
    if (b.dataset.cue) { const k = b.dataset.cue, s = S[k], d = deck(k); s.pos = 0; s.start = Date.now(); try { d.el.currentTime = 0; } catch (_) {} save(true); return; }
  });
  root.addEventListener("input", (e) => {
    if (!OWNER()) return;
    if (e.target.dataset.vol) { S[e.target.dataset.vol].vol = +e.target.value; levels(); save(); }
    if (e.target.id === "dj-xf") { S.xf = +e.target.value; levels(); save(); }
  });
  $("#dj-golive").addEventListener("change", (e) => { S.live = e.target.checked; save(true); say(S.live ? "You're live. Everyone on the radio hears your mix." : "Live DJ set ended."); });
  // keep the shared clock honest if a deck reaches the end
  ["A", "B"].forEach((k) => setTimeout(() => deck(k).el.addEventListener("ended", () => { if (OWNER() && !listening) { S[k].playing = false; S[k].pos = 0; paintOwner(); save(true); } }), 0));

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

  /* Talk over the music: hold the button, talk, let go. Your voice goes out to everyone listening. */
  let rec = null, chunks = [], micStream = null, talkStart = 0;
  const talkBtn = $("#dj-talk"), talkSt = $("#dj-talk-st");
  async function talkDown(e) {
    e.preventDefault(); if (!OWNER() || rec) return;
    try {
      micStream = micStream || await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
      const type = ["audio/webm;codecs=opus", "audio/mp4", "audio/webm"].find((t) => window.MediaRecorder && MediaRecorder.isTypeSupported(t)) || "";
      rec = new MediaRecorder(micStream, type ? { mimeType: type } : undefined); chunks = [];
      rec.ondataavailable = (ev) => ev.data.size && chunks.push(ev.data);
      rec.start(); talkStart = Date.now(); talkBtn.classList.add("on"); talkSt.textContent = "Talking... let go to send";
      S.duck = true; levels(); save(true);
    } catch (err) { say("Allow the microphone to talk over the music."); rec = null; }
  }
  async function talkUp() {
    if (!rec) return; const r = rec; rec = null; talkBtn.classList.remove("on");
    const long = Date.now() - talkStart;
    await new Promise((res) => { r.onstop = res; r.stop(); });
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

  /* ---------- start ---------- */
  async function init() {
    if (!window.claude) return;
    const d = await claude.use("db"); if (!d) return;
    d.doc("radio/dj").onSnapshot((snap) => onState(snap.exists ? snap.data() : null), () => {});
    const show = () => { const own = OWNER(); $("#dj-owner").hidden = !own; if (own) { libList(); paintOwner(); } };
    show(); setTimeout(show, 1500); setTimeout(show, 5000);
    setInterval(() => { if (OWNER() && !$("#dj-owner").hidden && $("#dj-lib").children.length !== TRACKS().length) libList(); }, 4000);
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init); else init();
})();
