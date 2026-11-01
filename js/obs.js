/* Stream with OBS, right into Meechie's World (Cloudflare RealtimeKit under the hood).
 * A signed-in member gets a private streaming address + key, pastes them into OBS
 * (Settings -> Stream -> Custom), and the broadcast plays live on this page for everyone.
 * The listing reuses the same "live" docs as camera lives, flagged obs:true with the HLS
 * playback URL in url; golive.js renders those cards with data-obs and this file plays them. */
(function () {
  "use strict";
  const view = document.getElementById("v-live");
  if (!view) return;
  const wrap = view.querySelector(".wrap"), glRoot = view.querySelector("#gl-root");
  if (!wrap || !glRoot) return;
  const E = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const say = (t) => (typeof toast === "function" ? toast(t) : null);
  const ME = () => (typeof me !== "undefined" ? me : null);
  const HANDLE = (id) => (typeof handleOf === "function" ? handleOf(id) : "Member");
  const tok = () => { try { const s = typeof MW !== "undefined" && MW.session && MW.session(); return s && s.access_token; } catch (_) { return null; } };

  const css = document.createElement("style");
  css.textContent = `
.obs-card{border:1px solid var(--line);border-radius:18px;padding:18px;background:linear-gradient(180deg,#17130c,#0f0d09);display:grid;gap:12px;margin-bottom:16px}
.obs-card h3{margin:2px 0 0;font-size:24px}
.obs-key{display:grid;gap:4px}.obs-key label{font:700 12px var(--body);letter-spacing:.06em;text-transform:uppercase;color:var(--muted)}
.obs-key .row{display:flex;gap:8px}.obs-key input{flex:1;min-width:0;background:var(--ink);border:1px solid var(--line);border-radius:10px;padding:10px;color:var(--text);font:14px ui-monospace,Menlo,monospace}
.obs-steps{margin:0;padding-left:20px;display:grid;gap:4px;font-size:14.5px;line-height:1.45}
.obs-status{font:700 15px var(--body)}.obs-status .dot{display:inline-block;width:9px;height:9px;border-radius:50%;background:#e5484d;margin-right:6px;animation:obsp 1s infinite}
@keyframes obsp{50%{opacity:.3}}
.obs-stage{margin-bottom:16px}.obs-box{position:relative;border-radius:18px;overflow:hidden;background:#000;border:1px solid #e5484d;aspect-ratio:16/9;max-height:82vh}
.obs-box video{width:100%;height:100%;display:block;background:#000}
.obs-box .tag{position:absolute;left:10px;top:10px;background:rgba(0,0,0,.55);color:#fff;border-radius:999px;padding:5px 10px;font:700 12px var(--body);z-index:2}
.obs-box .tag b{color:#ff6b70}
.obs-box .x{position:absolute;right:10px;top:10px;z-index:2;border:0;border-radius:999px;background:rgba(0,0,0,.65);color:#fff;font:800 13px var(--body);padding:7px 12px;cursor:pointer}`;
  document.head.appendChild(css);

  const stage = document.createElement("div");
  stage.className = "obs-stage"; stage.id = "obs-stage"; stage.hidden = true;
  stage.innerHTML = `<div class="obs-box"><span class="tag"><b>● LIVE</b> <span id="obs-tag"></span></span><button class="x" type="button" id="obs-close">✕ Close</button><video id="obs-video" playsinline controls></video></div>`;
  glRoot.before(stage);
  const panel = document.createElement("div");
  panel.className = "obs-card"; panel.id = "obs-panel";
  glRoot.before(panel);

  let configured = null;           // null = still checking, false = owner hasn't switched it on
  let mine = null;                 // {id, ingest_server, stream_key, playback_url, title, live, startedAt}
  let pollT = null, beatT = null, hls = null, watchingUid = null;
  let odb = null;
  const DB = async () => { if (!odb) odb = await claude.use("db"); return odb; };
  const docs = {};                 // uid -> live doc (obs ones only)

  function saveMine() { try { mine ? localStorage.setItem("mw_obs", JSON.stringify(mine)) : localStorage.removeItem("mw_obs"); } catch (_) {} }
  function loadMine() { try { const m = JSON.parse(localStorage.getItem("mw_obs") || "null"); if (m && m.id && m.playback_url) mine = m; } catch (_) {} }

  async function api(body) {
    const r = await fetch("/api/streams", { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer " + (tok() || "") }, body: JSON.stringify(body) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.message || "Something went wrong. Try again.");
    return j;
  }

  /* ---------- streamer panel ---------- */
  function paint() {
    if (configured === null) { panel.innerHTML = `<p class="eyebrow" style="margin:0">For streamers</p><h3>📡 Stream with OBS</h3><small class="muted">Checking…</small>`; return; }
    if (!configured) {
      panel.innerHTML = `<p class="eyebrow" style="margin:0">For streamers</p><h3>📡 Stream with OBS</h3>
        <p class="muted" style="margin:0">Broadcast from OBS on your computer straight into Meechie's World — no Twitch, no YouTube in the middle. This is being switched on right now; check back shortly.</p>
        ${typeof isOwner !== "undefined" && isOwner ? `<p style="margin:0;font-size:14px">Owner note: three Cloudflare settings switch this on (Realtime app + token in Pages). Amani has your step-by-step.</p>` : ""}`;
      return;
    }
    if (!ME()) {
      panel.innerHTML = `<p class="eyebrow" style="margin:0">For streamers</p><h3>📡 Stream with OBS</h3>
        <p class="muted" style="margin:0">Sign in and you'll get your own private stream key for OBS. Your broadcast plays live right here for the whole community.</p>
        <div><button class="btn" type="button" data-auth="signup">Join free to stream</button></div>`;
      return;
    }
    if (!mine) {
      panel.innerHTML = `<p class="eyebrow" style="margin:0">For streamers</p><h3>📡 Stream with OBS</h3>
        <p class="muted" style="margin:0">Stream from your computer with OBS and it plays live on this page — your games, your studio session, your show. Free while we're in the free tier.</p>
        <form id="obs-form" style="display:flex;gap:8px;flex-wrap:wrap"><input type="text" id="obs-title" maxlength="80" placeholder="What's your stream about?" style="flex:1;min-width:200px;background:var(--ink);border:1px solid var(--line);border-radius:12px;padding:11px;color:var(--text);font:16px var(--body)"><button class="btn" type="submit" style="background:#e5484d;color:#fff">🔑 Get my stream key</button></form>`;
      return;
    }
    panel.innerHTML = `<p class="eyebrow" style="margin:0">Your OBS stream</p><h3>📡 ${E(mine.title || "My stream")}</h3>
      <div class="obs-key"><label>Server</label><div class="row"><input readonly value="${E(mine.ingest_server)}" id="obs-server"><button class="btn ghost sm" type="button" data-copy="#obs-server">Copy</button></div></div>
      <div class="obs-key"><label>Stream key — keep it private, it's your password to go live</label><div class="row"><input readonly type="password" value="${E(mine.stream_key)}" id="obs-key"><button class="btn ghost sm" type="button" id="obs-show">Show</button><button class="btn ghost sm" type="button" data-copy="#obs-key">Copy</button></div></div>
      <ol class="obs-steps"><li>Open <b>OBS</b> → <b>Settings</b> → <b>Stream</b>.</li><li>Service: pick <b>Custom…</b></li><li>Paste the <b>Server</b> and <b>Stream key</b> above → <b>OK</b>.</li><li>Click <b>Start Streaming</b> in OBS. You appear under “Live now” below within a few seconds.</li></ol>
      <div class="obs-status" id="obs-status">${mine.live ? '<span class="dot"></span>You are LIVE on Meechie\'s World' : "⚪ Not streaming yet — start in OBS when you're ready."}</div>
      <div style="display:flex;gap:8px;flex-wrap:wrap"><button class="btn" type="button" id="obs-end" style="background:#e5484d;color:#fff">■ End stream &amp; retire this key</button></div>
      <small class="muted">Keep this tab open while you stream — it keeps you listed on the Live page. Ending the stream retires the key for good; you'll get a fresh one next time.</small>`;
  }

  async function publish() {
    if (!mine || !ME()) return;
    const d = await DB(); if (!d) return;
    await d.doc("live/" + ME()).set({ title: (mine.title || "Live").slice(0, 80), url: mine.playback_url, obs: true, onsite: true, host: typeof isOwner !== "undefined" && !!isOwner, startedAt: mine.startedAt || Date.now(), beat: Date.now() }).catch(() => {});
  }
  async function unpublish() { try { const d = await DB(); if (d && ME()) await d.doc("live/" + ME()).delete().catch(() => {}); } catch (_) {} }

  function startTimers() {
    stopTimers();
    pollT = setInterval(poll, 6000); poll();
    beatT = setInterval(async () => { if (mine && mine.live) { const d = await DB().catch(() => null); if (d && ME()) d.doc("live/" + ME()).update({ beat: Date.now() }).catch(() => {}); } }, 30000);
  }
  function stopTimers() { if (pollT) clearInterval(pollT); if (beatT) clearInterval(beatT); pollT = beatT = null; }

  async function poll() {
    if (!mine) return;
    let s; try { s = await api({ action: "status", id: mine.id }); } catch (_) { return; }
    const el = panel.querySelector("#obs-status");
    if (s.status === "LIVE" && !mine.live) {
      mine.live = true; mine.startedAt = mine.startedAt || Date.now(); saveMine();
      await publish(); paint(); say("You're live on Meechie's World! 🔴");
    } else if (s.status !== "LIVE" && mine.live) {
      // OBS stopped sending: unlist and wind down quietly, the key stays until they retire it
      mine.live = false; saveMine(); await unpublish();
      if (el) el.textContent = "⚪ Stream ended in OBS. Start again any time, or retire the key below.";
    } else if (el && s.status === "LIVE") {
      el.innerHTML = '<span class="dot"></span>You are LIVE on Meechie\'s World';
    }
  }

  async function endMine() {
    if (!mine) return;
    const id = mine.id; stopTimers(); mine = null; saveMine();
    await unpublish(); paint();
    api({ action: "stop", id }).catch(() => {});
    say("Stream ended and your key is retired.");
  }

  panel.addEventListener("submit", async (e) => {
    if (e.target.id !== "obs-form") return;
    e.preventDefault();
    const title = (panel.querySelector("#obs-title").value || "").trim() || "Live with " + HANDLE(ME());
    const btn = e.target.querySelector("button[type=submit]"); btn.disabled = true; btn.textContent = "Getting your key…";
    try {
      const j = await api({ action: "create", title });
      mine = { id: j.id, ingest_server: j.ingest_server, stream_key: j.stream_key, playback_url: j.playback_url, title, live: false, startedAt: 0 };
      saveMine(); paint(); startTimers();
      say("Your stream key is ready. Paste it into OBS to go live.");
    } catch (err) { btn.disabled = false; btn.textContent = "🔑 Get my stream key"; say(err.message); }
  });
  panel.addEventListener("click", async (e) => {
    const cp = e.target.closest("[data-copy]");
    if (cp) { const inp = panel.querySelector(cp.dataset.copy); if (!inp) return; inp.type = "text"; inp.select(); try { await navigator.clipboard.writeText(inp.value); say("Copied."); } catch (_) { document.execCommand && document.execCommand("copy"); } if (inp.id === "obs-key") inp.type = "password"; return; }
    if (e.target.id === "obs-show") { const inp = panel.querySelector("#obs-key"); const show = inp.type === "password"; inp.type = show ? "text" : "password"; e.target.textContent = show ? "Hide" : "Show"; return; }
    if (e.target.id === "obs-end") { e.target.disabled = true; endMine(); }
  });

  /* ---------- viewer ---------- */
  function stopWatching() {
    const v = stage.querySelector("#obs-video");
    try { v.pause(); v.removeAttribute("src"); v.load(); } catch (_) {}
    if (hls) { try { hls.destroy(); } catch (_) {} hls = null; }
    watchingUid = null; stage.hidden = true;
    if (window.MW_videoSound) MW_videoSound.end();
  }
  function attachHls(v, url) {
    if (v.canPlayType("application/vnd.apple.mpegurl")) { v.src = url; return; }
    const go = () => { if (watchingUid && window.Hls && Hls.isSupported()) { hls = new Hls({ maxBufferLength: 90, maxMaxBufferLength: 120, backBufferLength: 60, liveSyncDurationCount: 8, liveMaxLatencyDurationCount: 24, fragLoadingMaxRetry: 6, fragLoadingRetryDelay: 1000, levelLoadingMaxRetry: 6, levelLoadingRetryDelay: 1000, manifestLoadingMaxRetry: 6, manifestLoadingRetryDelay: 1000 }); hls.loadSource(url); hls.attachMedia(v); } else if (watchingUid) { v.src = url; } };
    if (window.Hls) go();
    else { const stamp = (document.querySelector('meta[name="mw-build"]') || {}).content || ""; const s = document.createElement("script"); s.src = "js/vendor/hls.min.js" + (stamp ? "?v=" + stamp : ""); s.onload = go; s.onerror = () => { const s2 = document.createElement("script"); s2.src = "https://cdn.jsdelivr.net/npm/hls.js@1.5.13/dist/hls.min.js"; s2.onload = go; s2.onerror = () => { if (watchingUid) v.src = url; }; document.head.appendChild(s2); }; document.head.appendChild(s); } // P4: self-hosted hls.js (stamped, skeleton-cached), CDN as fallback
  }
  function watchObs(uid) {
    const doc = docs[uid]; if (!doc || !doc.url) return;
    if (watchingUid === uid) { stopWatching(); return; }
    stopWatching();
    watchingUid = uid;
    stage.querySelector("#obs-tag").textContent = HANDLE(uid) + " · " + (doc.title || "Live");
    stage.hidden = false;
    if (window.MW_videoSound) MW_videoSound.start();
    const v = stage.querySelector("#obs-video");
    attachHls(v, doc.url);
    v.play().catch(() => { v.muted = true; v.play().catch(() => {}); });
    stage.scrollIntoView({ behavior: "smooth", block: "start" });
  }
  stage.querySelector("#obs-close").addEventListener("click", stopWatching);
  view.addEventListener("click", (e) => { const b = e.target.closest("[data-obs]"); if (b) watchObs(b.dataset.obs); });

  /* ---------- init ---------- */
  async function init() {
    paint();
    try { const j = await fetch("/api/streams").then((r) => r.json()); configured = !!j.configured; } catch (_) { configured = false; }
    loadMine();
    if (mine && !ME()) mine = null;            // a saved key belongs to whoever was signed in
    if (mine && !configured) { mine = null; saveMine(); }
    paint();
    if (mine) startTimers();
    try {
      const d = await DB();
      if (d) d.collection("live").limit(100).onSnapshot((s) => { s.docs.forEach((x) => { const v = x.data(); if (v && v.obs && v.url) docs[x.id] = v; else delete docs[x.id]; }); if (watchingUid && !docs[watchingUid]) stopWatching(); }, () => {});
    } catch (_) {}
    new MutationObserver(() => { if (!view.hidden) paint(); }).observe(view, { attributes: true, attributeFilter: ["hidden"] });
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init); else init();
})();
