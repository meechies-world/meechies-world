/* Live on Meechie's World: go live from your camera, people watch right on the site, live chat, gifts that fly
 * across the screen, and battles (two hosts, 3 minutes, most gift points wins).
 * Video goes straight from the host's device to each viewer (WebRTC, peer to peer). Signalling uses the site's
 * realtime rooms. Best for small audiences (a host's upload speed limits how many can watch; we cap at 12). */
(function () {
  "use strict";
  const view = document.getElementById("v-live");
  if (!view) return;
  const root = view.querySelector("#gl-root");
  const E = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const say = (t) => (typeof toast === "function" ? toast(t) : null);
  const ME = () => (typeof me !== "undefined" ? me : null);
  const DB = () => (typeof db !== "undefined" ? db : null);
  const HANDLE = (id) => { const h = typeof handleOf === "function" ? handleOf(id) : "Member"; if (h !== "Member") return h; const l = lives.find((x) => x.id === id); return l && l.host ? "Meechie" : (id === ME() && typeof isOwner !== "undefined" && isOwner ? "Meechie" : h); };
  const ICE = { iceServers: [{ urls: ["stun:stun.l.google.com:19302", "stun:stun1.l.google.com:19302", "stun:stun.cloudflare.com:3478"] }] };
  const VAL = { rose: 1, mic: 5, gold: 10, fire: 20, crown: 50, diamond: 100 };
  const EMO = { rose: "🌹", mic: "🎤", gold: "🪙", crown: "👑", fire: "🔥", diamond: "💎" };
  const MAX_VIEWERS = 12;
  const myPeer = Math.random().toString(36).slice(2, 12);
  let lives = [], battles = [], hosting = null, watching = {}, chatLog = [], titleDraft = "", shellKey = "", statusMsg = "";
  function status(t) { statusMsg = t || ""; const el = root.querySelector("#gl-status"); if (el) { el.textContent = statusMsg; el.style.display = statusMsg ? "" : "none"; } if (t) say(t); }

  const css = document.createElement("style");
  css.textContent = `
#gl-root{display:grid;gap:16px}
.gl-list{display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:12px}
.gl-card{border:1px solid #e5484d;border-radius:16px;padding:14px;background:linear-gradient(180deg,#2a0f10,#0f0d09);display:grid;gap:8px;cursor:pointer;text-align:left;color:var(--text)}
.gl-card .dot{display:inline-block;width:9px;height:9px;border-radius:50%;background:#e5484d;margin-right:6px;animation:glp 1s infinite}
@keyframes glp{50%{opacity:.3}}
.gl-stage{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:10px}
.gl-box{position:relative;border-radius:18px;overflow:hidden;background:#000;aspect-ratio:9/16;max-height:78vh;border:1px solid var(--line)}
.gl-box video{width:100%;height:100%;object-fit:cover;display:block;background:#000}
.gl-box .tag{position:absolute;left:10px;top:10px;background:rgba(0,0,0,.55);color:#fff;border-radius:999px;padding:5px 10px;font:700 12px var(--body)}
.gl-box .tag b{color:#ff6b70}
.gl-box .cnt{position:absolute;right:10px;top:10px;background:rgba(0,0,0,.55);color:#fff;border-radius:999px;padding:5px 10px;font:700 12px var(--body)}
.gl-fly{position:absolute;bottom:90px;left:50%;font-size:46px;pointer-events:none;animation:glfly 2.4s ease-out forwards;z-index:4;text-shadow:0 4px 18px rgba(0,0,0,.6)}
@keyframes glfly{0%{transform:translate(-50%,0) scale(.6);opacity:0}15%{opacity:1;transform:translate(-50%,-30px) scale(1.2)}100%{transform:translate(calc(-50% + var(--dx)),-340px) scale(1);opacity:0}}
.gl-chat{position:absolute;left:8px;right:8px;bottom:58px;max-height:40%;overflow:hidden;display:flex;flex-direction:column;justify-content:flex-end;gap:4px;z-index:3;pointer-events:none;-webkit-mask-image:linear-gradient(transparent,#000 30%)}
.gl-chat div{color:#fff;font:600 13px var(--body);text-shadow:0 1px 3px #000}.gl-chat b{color:var(--gold-hi)}
.gl-bar{position:absolute;left:8px;right:8px;bottom:8px;display:flex;gap:6px;z-index:5}
.gl-bar input{flex:1;min-width:0;background:rgba(0,0,0,.55);border:1px solid rgba(255,255,255,.25);border-radius:999px;color:#fff;padding:9px 12px;font:16px var(--body)}
.gl-bar button{border:0;border-radius:999px;background:var(--gold);color:#0b0a08;font:800 13px var(--body);padding:0 12px;cursor:pointer}
.gl-battle{display:grid;gap:6px}
.gl-score{height:20px;border-radius:999px;overflow:hidden;display:flex;border:1px solid var(--line);font:800 12px var(--body)}
.gl-score i{display:grid;place-items:center;color:#fff;transition:flex-grow .6s}.gl-score .a{background:#e5484d}.gl-score .b{background:#3b82f6}
.gl-host-ctrl{display:flex;gap:8px;flex-wrap:wrap;align-items:center}
.gl-snd{position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);z-index:6;border:0;border-radius:999px;background:rgba(0,0,0,.65);color:#fff;font:800 15px var(--body);padding:12px 18px;cursor:pointer}
.gl-wait{position:absolute;inset:0;display:grid;place-items:center;color:#fff;font:700 14px var(--body);text-align:center;padding:20px;z-index:2}`;
  document.head.appendChild(css);

  const isLive = (l) => l.onsite && Date.now() - (l.beat || l.startedAt || 0) < 90e3;
  const myBattle = (uid) => battles.find((b) => (b.a === uid || b.b === uid) && Date.now() < (b.end || 0) + 15000);
  const giftScore = (uid, from, to) => (typeof giftLog !== "undefined" ? giftLog : []).filter((g) => g.to === uid && g.createdAt >= from && g.createdAt <= to).reduce((n, g) => n + (VAL[g.kind] || 1), 0);

  /* ---------- page ---------- */
  function render() {
    if (!ME()) { root.innerHTML = `<div class="empty"><h3>Sign in to go live or watch</h3><button class="btn" type="button" data-auth="signup" style="margin-top:12px">Join free</button></div>`; return; }
    const key = ME() + "|" + !!hosting + "|" + Object.keys(watching).join(",");
    if (key === shellKey && root.querySelector("#gl-list")) { paintList(); paintBattle(); return; }
    shellKey = key;
    root.innerHTML = `
      <div class="gl-host-ctrl">${hosting ? `<button class="btn" type="button" id="gl-end" style="background:#e5484d;color:#fff">■ End my live</button><button class="btn ghost" type="button" id="gl-flip">🔄 Flip camera</button><button class="btn ghost" type="button" id="gl-battle">⚔️ Start a battle</button><span class="muted" id="gl-vc">0 watching</span>` : `<input type="text" id="gl-title" maxlength="80" placeholder="What's your live about?" value="${E(titleDraft)}" style="flex:1;min-width:200px;background:var(--ink);border:1px solid var(--line);border-radius:12px;padding:11px;color:var(--text);font:16px var(--body)"><button class="btn" type="button" id="gl-go" style="background:#e5484d;color:#fff">🎥 Go live</button>`}</div>
      <div id="gl-status" class="muted" style="font-size:14px;${statusMsg ? "" : "display:none;"}padding:10px 12px;border:1px solid #e5484d;border-radius:12px;background:#1a0d0d;color:#ffd6d6">${E(statusMsg)}</div>
      <div class="gl-stage" id="gl-stage"></div>
      <div id="gl-battlebox"></div>
      <h3 class="sub-h" style="margin:8px 0 0">Live now on Meechie's World</h3>
      <div class="gl-list" id="gl-list"></div>
      <p class="muted" style="font-size:13px;margin:0">Gifts you send count toward battles. Video goes straight from the host to you, so it works best with good Wi-Fi.</p>`;
    paintStage(); paintList(); paintBattle();
  }
  function paintList() {
    const el = root.querySelector("#gl-list"); if (!el) return;
    const on = lives.filter(isLive).filter((l) => l.id !== ME());
    el.innerHTML = on.map((l) => `<button class="gl-card" type="button" data-watch="${E(l.id)}"><span><span class="dot"></span><b>${E(HANDLE(l.id))}</b>${l.host ? ' <span class="badge">Host</span>' : ""}</span><small class="muted">${E(l.title || "Live")}</small><span style="color:var(--gold-hi);font-weight:700">${watching[l.id] ? "Watching ✓ (tap to leave)" : "Watch →"}</span></button>`).join("") || '<p class="muted">Nobody else is live right now. Be the first!</p>';
  }
  function box(id, label, isMe) {
    const b = document.createElement("div"); b.className = "gl-box"; b.dataset.box = id;
    b.innerHTML = `<video playsinline autoplay muted></video>${isMe ? "" : `<div class="gl-wait" data-wait>Connecting to the live…</div><button class="gl-snd" type="button" data-unmute hidden>🔊 Tap for sound</button>`}<span class="tag"><b>● LIVE</b> ${E(label)}</span><span class="cnt" data-cnt="${E(id)}"></span><div class="gl-chat" data-chat="${E(id)}"></div>
      <form class="gl-bar" data-chatform="${E(id)}"><input maxlength="150" placeholder="Say something..." aria-label="Live chat">${isMe ? "" : `<button type="button" data-giftlive="${E(id)}">🎁</button>`}<button type="submit">Send</button></form>`;
    return b;
  }
  function paintStage() {
    const st = root.querySelector("#gl-stage"); if (!st) return;
    st.innerHTML = "";
    if (hosting) { const b = box(ME(), "You", true); st.appendChild(b); b.querySelector("video").srcObject = hosting.stream; }
    for (const [id, w] of Object.entries(watching)) { const b = box(id, HANDLE(id), false); st.appendChild(b); if (w.stream) attach(b, w); }
    paintChat();
  }
  function attach(b, w) {
    const v = b.querySelector("video"); v.srcObject = w.stream; v.muted = !w.sound;
    const wait = b.querySelector("[data-wait]"); if (wait) wait.remove();
    const snd = b.querySelector("[data-unmute]"); if (snd) snd.hidden = !!w.sound;
    v.play().catch(() => { v.muted = true; w.sound = false; if (snd) snd.hidden = false; v.play().catch(() => {}); });
  }
  function paintChat() {
    root.querySelectorAll("[data-chat]").forEach((c) => { const id = c.dataset.chat; c.innerHTML = chatLog.filter((m) => m.room === id).slice(-8).map((m) => `<div><b>${E(HANDLE(m.uid))}</b> ${E(m.text)}</div>`).join(""); });
  }
  function fly(roomId, kind) {
    const b = root.querySelector(`[data-box="${CSS.escape(roomId)}"]`); if (!b) return;
    const s = document.createElement("span"); s.className = "gl-fly"; s.textContent = EMO[kind] || "🎁"; s.style.setProperty("--dx", (Math.random() * 160 - 80) + "px"); b.appendChild(s); setTimeout(() => s.remove(), 2500);
  }

  /* ---------- rooms ---------- */
  async function joinRoom(id) { const lobby = await claude.use("room"); if (!lobby || !lobby.join) throw new Error("Sign in to use Live."); return lobby.join("lv-" + id); }
  function wireChat(room, id) {
    room.on("chat", ({ data }) => { if (data && data.text) { chatLog.push({ room: id, uid: data.uid, text: String(data.text).slice(0, 150) }); chatLog = chatLog.slice(-200); paintChat(); } });
    room.on("gift", ({ data }) => { if (data && data.kind) { fly(id, data.kind); chatLog.push({ room: id, uid: data.uid, text: "sent " + (EMO[data.kind] || "🎁") }); paintChat(); paintBattle(); } });
  }

  /* ---------- camera permission pop-up ----------
   * When someone opens the Live page and the camera isn't allowed yet, the site asks for it right away
   * (the phone's own "Allow camera?" box). If the browser needs a tap first, our pop-up has a big Allow button. */
  const isIOS = /iP(hone|ad|od)/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  const inApp = /FBAN|FBAV|Instagram|TikTok|musical_ly|Snapchat|Line\/|GSA\//i.test(navigator.userAgent);
  let askedThisVisit = false;
  async function camState() { try { return (await navigator.permissions.query({ name: "camera" })).state; } catch (_) { return "unknown"; } }
  function permModal(state, msg) {
    let m = document.getElementById("gl-perm");
    if (!m) { m = document.createElement("div"); m.id = "gl-perm"; m.setAttribute("role", "dialog"); m.setAttribute("aria-modal", "true");
      m.style.cssText = "position:fixed;inset:0;z-index:10060;background:rgba(0,0,0,.72);display:grid;place-items:center;padding:16px"; document.body.appendChild(m); }
    const fix = isIOS ? "Tap <b>aA</b> next to the web address → <b>Website Settings</b> → set <b>Camera</b> and <b>Microphone</b> to <b>Allow</b>. (Also: iPhone Settings → Safari → Camera → Allow.) Then reload the page."
      : "Tap the <b>🔒</b> next to the web address → <b>Permissions</b> → turn on <b>Camera</b> and <b>Microphone</b>. Then reload the page.";
    const body = inApp ? `<p>You opened Meechie's World inside another app, and that app won't share the camera.</p><p>Tap <b>⋯</b> (top or bottom corner) and choose <b>Open in browser</b> / <b>Open in Safari</b> / <b>Open in Chrome</b>.</p>`
      : state === "denied" ? `<p>Your camera is turned off for this site, so your phone won't ask again by itself.</p><p>${fix}</p>`
      : `<p>To go live, Meechie's World needs your <b>camera</b> and <b>microphone</b>. When your phone asks, tap <b>Allow</b>.</p>${msg ? `<p style="color:#ffb4b4">${E(msg)}</p>` : ""}`;
    m.innerHTML = `<div style="width:min(420px,100%);background:#15130f;border:1px solid var(--gold,#d4a843);border-radius:20px;padding:22px;color:var(--text,#f3ecdc);font:16px/1.45 var(--body,system-ui);display:grid;gap:10px;text-align:center">
      <div style="font-size:44px">🎥🎤</div><h3 style="margin:0;font-size:21px">Allow camera &amp; microphone</h3>${body}
      ${inApp ? "" : `<button class="btn" type="button" id="gl-perm-ok" style="background:#e5484d;color:#fff;font-size:17px;padding:13px">${state === "denied" ? "I turned it on — reload" : "Allow camera"}</button>`}
      <button class="btn ghost" type="button" id="gl-perm-no">Not now</button></div>`;
    m.hidden = false; m.dataset.from = "live";
    m.querySelector("#gl-perm-no").onclick = () => { m.hidden = true; };
    const ok = m.querySelector("#gl-perm-ok"); if (ok) ok.onclick = () => (state === "denied" ? location.reload() : requestCam(true));
  }
  /* The Live page's camera pop-up belongs to the Live page: close it when the visitor goes to another page */
  // (the menu switches pages without changing the address, so watch the Live page itself being hidden)
  const closeLivePerm = () => { const m = document.getElementById("gl-perm"); if (m && !m.hidden && m.dataset.from === "live" && view.hidden) m.hidden = true; };
  new MutationObserver(closeLivePerm).observe(view, { attributes: true, attributeFilter: ["hidden"] });
  window.addEventListener("hashchange", () => setTimeout(closeLivePerm, 0));
  async function requestCam(fromTap) {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) { permModal("prompt"); return false; }
    try {
      const s = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
      s.getTracks().forEach((t) => t.stop());
      const m = document.getElementById("gl-perm"); if (m) m.hidden = true;
      status(""); if (fromTap) say("Camera ready! Tap 🎥 Go live when you're set.");
      return true;
    } catch (e) {
      const st = await camState();
      if (e && e.name === "NotAllowedError" && (st === "denied" || fromTap)) permModal(st === "prompt" ? "denied" : st);
      else if (e && e.name === "NotReadableError") permModal("prompt", "Your camera is being used by another app. Close it and tap Allow camera again.");
      else if (e && e.name === "NotFoundError") permModal("prompt", "No camera was found on this device.");
      else permModal(st);
      return false;
    }
  }
  /* Site-wide: shortly after someone opens Meechie's World, ask (once per device) for camera + microphone,
   * so Live, Studio, voice messages and the AI are ready to go. Our pop-up comes first, then the phone's own box. */
  function siteAsk() {
    let seen = null; try { seen = localStorage.getItem("mw-cam-asked"); } catch (_) {}
    if (seen || inApp || !navigator.mediaDevices || !navigator.mediaDevices.getUserMedia || !window.isSecureContext) return;
    camState().then((st) => {
      if (st === "granted" || st === "denied") return;
      if (document.querySelector("dialog[open], #gl-perm:not([hidden])")) { setTimeout(siteAsk, 15000); return; }
      try { localStorage.setItem("mw-cam-asked", "1"); } catch (_) {}
      let m = document.getElementById("gl-perm");
      if (!m) { m = document.createElement("div"); m.id = "gl-perm"; m.setAttribute("role", "dialog"); m.setAttribute("aria-modal", "true");
        m.style.cssText = "position:fixed;inset:0;z-index:10060;background:rgba(0,0,0,.72);display:grid;place-items:center;padding:16px"; document.body.appendChild(m); }
      m.innerHTML = `<div style="width:min(420px,100%);background:#15130f;border:1px solid var(--gold,#d4a843);border-radius:20px;padding:22px;color:var(--text,#f3ecdc);font:16px/1.45 var(--body,system-ui);display:grid;gap:10px;text-align:center">
        <div style="font-size:44px">🎥🎤</div><h3 style="margin:0;font-size:21px">Turn on your camera &amp; mic?</h3>
        <p>Meechie's World uses your <b>camera</b> and <b>microphone</b> to go live, record in the Studio, send voice messages, and talk to Meechie's AI.</p>
        <p class="muted" style="font-size:14px;margin:0">Nothing turns on until you use one of those. When your phone asks, tap <b>Allow</b>.</p>
        <button class="btn" type="button" id="gl-perm-ok" style="font-size:17px;padding:13px">Allow camera &amp; mic</button>
        <button class="btn ghost" type="button" id="gl-perm-no">Not now</button></div>`;
      m.hidden = false; m.dataset.from = "site";
      m.querySelector("#gl-perm-no").onclick = () => { m.hidden = true; };
      m.querySelector("#gl-perm-ok").onclick = async () => { if (await requestCam(false)) say("You're all set! 🎉"); else { const st2 = await camState(); if (st2 === "denied") permModal("denied"); else m.hidden = true; } };
    });
  }
  setTimeout(siteAsk, 5000);

  async function autoAsk() {
    if (askedThisVisit || hosting || !ME() || view.hidden) return;
    askedThisVisit = true;
    if (inApp) { permModal("prompt"); return; }
    const st = await camState();
    if (st === "granted") return;
    if (st === "denied") { permModal("denied"); return; }
    // ask the phone right away; if it needs a tap first, show our pop-up with the big button
    permModal("prompt"); requestCam(false);
  }

  /* ---------- hosting ---------- */
  let facing = "user";
  async function goLive() {
    if (!ME()) { if (typeof openAuth === "function") openAuth("signup"); return; }
    if (hosting) return;
    if (!window.isSecureContext || !navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      status("This browser can't use the camera. If you opened the link inside TikTok, Instagram, Snapchat or Facebook, tap ⋯ and choose Open in Safari or Chrome."); return;
    }
    const btn = root.querySelector("#gl-go"); if (btn) { btn.disabled = true; btn.textContent = "Starting camera…"; }
    status(""); const el0 = root.querySelector("#gl-status"); if (el0) { el0.style.display = ""; el0.textContent = "Asking for your camera… if a box pops up, tap Allow."; }
    const reset = () => { if (btn && btn.isConnected) { btn.disabled = false; btn.textContent = "🎥 Go live"; } };
    let stream = null, lastErr = null;
    const tries = [
      { video: { facingMode: facing, width: { ideal: 720 }, height: { ideal: 1280 } }, audio: { echoCancellation: true, noiseSuppression: true } },
      { video: true, audio: true },
      { video: true, audio: false },
    ];
    for (const c of tries) { try { stream = await navigator.mediaDevices.getUserMedia(c); break; } catch (e) { lastErr = e; if (e && (e.name === "NotAllowedError" || e.name === "SecurityError")) break; } }
    if (!stream) {
      reset(); const n = lastErr && lastErr.name;
      status(n === "NotAllowedError" || n === "SecurityError" ? "Camera is blocked. Tap the 🔒 or aA next to the web address, allow Camera and Microphone, then try again."
        : n === "NotFoundError" ? "No camera was found on this device."
        : n === "NotReadableError" ? "Your camera is being used by another app. Close it (FaceTime, TikTok, Zoom) and try again."
        : "Couldn't start the camera (" + (n || "unknown") + (lastErr && lastErr.message ? ": " + lastErr.message : "") + ")");
      return;
    }
    status("");
    if (!stream.getAudioTracks().length) say("Going live without sound: the microphone wasn't allowed.");
    let room;
    try { room = await joinRoom(ME()); } catch (e) { stream.getTracks().forEach((t) => t.stop()); reset(); status(e.message || "Couldn't connect. Try again."); return; }
    hosting = { stream, room, peers: {}, title: titleDraft.trim() || "Live with " + HANDLE(ME()) };
    wireChat(room, ME());
    room.on("want", async ({ data }) => {
      if (!hosting || !data || !data.peer) return;
      if (Object.keys(hosting.peers).length >= MAX_VIEWERS && !hosting.peers[data.peer]) { room.emit("full", { to: data.peer }); return; }
      if (hosting.peers[data.peer]) return;
      const pc = new RTCPeerConnection(ICE); hosting.peers[data.peer] = pc;
      hosting.stream.getTracks().forEach((t) => pc.addTrack(t, hosting.stream));
      pc.onicecandidate = (e) => { if (e.candidate) room.emit("ice", { to: data.peer, from: "host", c: e.candidate.toJSON() }); };
      pc.onconnectionstatechange = () => { if (/failed|closed|disconnected/.test(pc.connectionState)) { try { pc.close(); } catch (_) {} delete hosting?.peers[data.peer]; count(); } else count(); };
      const offer = await pc.createOffer(); await pc.setLocalDescription(offer);
      room.emit("offer", { to: data.peer, sdp: pc.localDescription.toJSON() });
    });
    room.on("answer", async ({ data }) => { const pc = hosting && hosting.peers[data && data.from]; if (pc && data.sdp) { try { await pc.setRemoteDescription(data.sdp); } catch (_) {} } });
    room.on("ice", async ({ data }) => { if (!data || data.to !== "host") return; const pc = hosting && hosting.peers[data.from]; if (pc && data.c) { try { await pc.addIceCandidate(data.c); } catch (_) {} } });
    room.on("bye", ({ data }) => { const pc = hosting && hosting.peers[data && data.from]; if (pc) { try { pc.close(); } catch (_) {} delete hosting.peers[data.from]; count(); } });
    let saved = true;
    await DB().doc("live/" + ME()).set({ title: hosting.title.slice(0, 80), url: "", onsite: true, host: typeof isOwner !== "undefined" && isOwner, startedAt: Date.now(), beat: Date.now() }).catch((e) => { saved = false; say("You're live, but we couldn't list you on the Live page: " + (e.message || e.code)); });
    hosting.beat = setInterval(() => DB().doc("live/" + ME()).update({ beat: Date.now() }).catch(() => {}), 30000);
    room.emit("hello", {}); if (saved) say("You're live! Share the site so people can watch.");
    shellKey = ""; render();
  }
  function count() { const n = hosting ? Object.values(hosting.peers).filter((p) => p.connectionState === "connected").length : 0; const el = root.querySelector("#gl-vc"); if (el) el.textContent = n + " watching"; const c = root.querySelector(`[data-cnt="${CSS.escape(ME() || "")}"]`); if (c) c.textContent = "👁 " + n; }
  async function endLive() {
    if (!hosting) return;
    clearInterval(hosting.beat); hosting.room.emit("ended", {});
    Object.values(hosting.peers).forEach((p) => { try { p.close(); } catch (_) {} });
    hosting.stream.getTracks().forEach((t) => t.stop()); try { hosting.room.leave(); } catch (_) {}
    hosting = null; shellKey = ""; await DB().doc("live/" + ME()).delete().catch(() => {}); say("Your live has ended."); render();
  }
  async function flip() {
    if (!hosting) return; facing = facing === "user" ? "environment" : "user";
    try {
      const s = await navigator.mediaDevices.getUserMedia({ video: { facingMode: facing } }); const nt = s.getVideoTracks()[0];
      const old = hosting.stream.getVideoTracks()[0]; hosting.stream.removeTrack(old); old.stop(); hosting.stream.addTrack(nt);
      Object.values(hosting.peers).forEach((pc) => { const snd = pc.getSenders().find((x) => x.track && x.track.kind === "video"); if (snd) snd.replaceTrack(nt); });
      paintStage();
    } catch (_) { say("Couldn't switch cameras."); }
  }

  /* ---------- watching ---------- */
  async function watch(id) {
    if (watching[id]) return;
    if (typeof media !== "undefined") { try { media.pause(); } catch (_) {} }
    const room = await joinRoom(id); const pc = new RTCPeerConnection(ICE);
    const w = watching[id] = { room, pc, stream: null };
    pc.addTransceiver("video", { direction: "recvonly" }); pc.addTransceiver("audio", { direction: "recvonly" });
    pc.ontrack = (e) => { w.stream = e.streams[0] || w.stream || new MediaStream([e.track]); if (!w.stream.getTracks().includes(e.track)) w.stream.addTrack(e.track); const b = root.querySelector(`[data-box="${CSS.escape(id)}"]`); if (b) attach(b, w); };
    pc.onconnectionstatechange = () => { if (pc.connectionState === "failed") { const t = root.querySelector(`[data-box="${CSS.escape(id)}"] [data-wait]`); if (t) t.textContent = "Couldn't connect to this live from your network. Try Wi-Fi, or try again in a minute."; } };
    pc.onicecandidate = (e) => { if (e.candidate) room.emit("ice", { to: "host", from: myPeer, c: e.candidate.toJSON() }); };
    room.on("offer", async ({ data }) => {
      if (!data || data.to !== myPeer) return;
      try { await pc.setRemoteDescription(data.sdp); const ans = await pc.createAnswer(); await pc.setLocalDescription(ans); room.emit("answer", { from: myPeer, sdp: pc.localDescription.toJSON() }); w.got = true; } catch (_) {}
    });
    room.on("ice", async ({ data }) => { if (data && data.to === myPeer && data.c) { try { await pc.addIceCandidate(data.c); } catch (_) {} } });
    room.on("full", ({ data }) => { if (data && data.to === myPeer) { say("This live is full right now. Try again in a bit."); stopWatch(id); } });
    room.on("ended", () => { say(HANDLE(id) + "'s live ended."); stopWatch(id); });
    wireChat(room, id);
    let tries = 0;
    const ask = () => { if (!w.got && watching[id]) { if (++tries > 12) { const t = root.querySelector(`[data-box="${CSS.escape(id)}"] [data-wait]`); if (t) t.textContent = "The host isn't answering. Their live may have just ended."; return; } room.emit("want", { peer: myPeer, uid: ME() }); setTimeout(ask, 2500); } };
    setTimeout(ask, 600);
    shellKey = ""; render();
  }
  function stopWatch(id) { const w = watching[id]; if (!w) return; try { w.room.emit("bye", { from: myPeer }); w.pc.close(); w.room.leave(); } catch (_) {} delete watching[id]; shellKey = ""; render(); }

  /* ---------- battles ---------- */
  function paintBattle() {
    const el = root.querySelector("#gl-battlebox"); if (!el) return;
    const ids = [hosting ? ME() : null, ...Object.keys(watching)].filter(Boolean);
    const b = ids.map(myBattle).find(Boolean);
    if (!b) { el.innerHTML = ""; return; }
    const sa = giftScore(b.a, b.start, b.end), sb = giftScore(b.b, b.start, b.end), left = Math.max(0, Math.ceil((b.end - Date.now()) / 1000));
    const done = left === 0, win = sa === sb ? "It's a tie!" : (sa > sb ? HANDLE(b.a) : HANDLE(b.b)) + " wins! 🏆";
    el.innerHTML = `<div class="gl-battle"><b>⚔️ Battle: ${E(HANDLE(b.a))} vs ${E(HANDLE(b.b))} · ${done ? E(win) : left + "s left"}</b>
      <div class="gl-score"><i class="a" style="flex-grow:${sa + 1}">${sa}</i><i class="b" style="flex-grow:${sb + 1}">${sb}</i></div>
      ${!done ? `<div style="display:flex;gap:6px;flex-wrap:wrap"><button class="btn sm" type="button" data-giftlive="${E(b.a)}">🎁 Gift ${E(HANDLE(b.a))}</button><button class="btn sm" type="button" data-giftlive="${E(b.b)}" style="background:#3b82f6;color:#fff">🎁 Gift ${E(HANDLE(b.b))}</button>${!watching[b.a] && b.a !== ME() ? `<button class="btn ghost sm" type="button" data-watch="${E(b.a)}">Watch ${E(HANDLE(b.a))}</button>` : ""}${!watching[b.b] && b.b !== ME() ? `<button class="btn ghost sm" type="button" data-watch="${E(b.b)}">Watch ${E(HANDLE(b.b))}</button>` : ""}</div>` : ""}</div>`;
  }
  setInterval(() => { if (!view.hidden) paintBattle(); }, 1000);
  async function startBattle() {
    const others = lives.filter((l) => isLive(l) && l.id !== ME());
    if (!others.length) { say("Nobody else is live to battle right now."); return; }
    const name = prompt("Battle who? Type their name:\n" + others.map((l) => "• " + HANDLE(l.id)).join("\n"), HANDLE(others[0].id)); if (!name) return;
    const opp = others.find((l) => HANDLE(l.id).toLowerCase() === name.trim().toLowerCase()); if (!opp) { say("They're not live right now."); return; }
    const start = Date.now();
    await DB().collection("battles").add({ authorId: ME(), a: ME(), b: opp.id, start, end: start + 180000, createdAt: start }).catch((e) => say(e.message || e.code));
    say("Battle on! 3 minutes. Most gift points wins.");
  }

  /* ---------- clicks ---------- */
  root.addEventListener("click", (e) => {
    const b = e.target.closest("button"); if (!b) return;
    if (b.dataset.unmute !== undefined) { const bx = b.closest("[data-box]"), w = watching[bx.dataset.box]; if (w) { w.sound = true; attach(bx, w); } return; }
    if (b.id === "gl-go") return goLive();
    if (b.id === "gl-end") return endLive();
    if (b.id === "gl-flip") return flip();
    if (b.id === "gl-battle") return startBattle();
    if (b.dataset.watch) return watching[b.dataset.watch] ? stopWatch(b.dataset.watch) : watch(b.dataset.watch);
    if (b.dataset.giftlive) {
      const to = b.dataset.giftlive; if (typeof openGift !== "function") return;
      openGift(to);
      const form = document.getElementById("gift-form");
      const once = () => { form.removeEventListener("submit", once); setTimeout(() => { const g = (typeof giftKind !== "undefined" ? giftKind : "rose"); const r = to === ME() ? hosting && hosting.room : (watching[to] || {}).room; if (r) r.emit("gift", { uid: ME(), kind: g }); fly(to, g); }, 300); };
      form.addEventListener("submit", once);
    }
  });
  root.addEventListener("input", (e) => { if (e.target.id === "gl-title") titleDraft = e.target.value; });
  root.addEventListener("keydown", (e) => { if (e.target.id === "gl-title" && e.key === "Enter") { e.preventDefault(); goLive(); } });
  root.addEventListener("submit", (e) => {
    const f = e.target.closest("[data-chatform]"); if (!f) return; e.preventDefault();
    const id = f.dataset.chatform, inp = f.querySelector("input"), text = inp.value.trim(); if (!text) return; inp.value = "";
    const r = id === ME() ? hosting && hosting.room : (watching[id] || {}).room; if (!r) return;
    r.emit("chat", { uid: ME(), text: text.slice(0, 150) }); chatLog.push({ room: id, uid: ME(), text }); paintChat();
  });
  addEventListener("pagehide", () => { if (hosting) { try { navigator.sendBeacon && 0; } catch (_) {} endLive(); } Object.keys(watching).forEach(stopWatch); });

  async function init() {
    if (!window.claude) return;
    const d = await claude.use("db"); if (!d) { render(); return; }
    d.collection("live").limit(100).onSnapshot((s) => { lives = s.docs.map((x) => ({ id: x.id, ...x.data() })); if (!view.hidden) render(); document.querySelectorAll('[data-go="live"]').forEach((a) => a.classList.toggle("has-live", lives.some(isLive))); }, () => {});
    d.collection("battles").orderBy("createdAt", "desc").limit(20).onSnapshot((s) => { battles = s.docs.map((x) => ({ id: x.id, ...x.data() })); paintBattle(); }, () => {});
    try { navigator.permissions && navigator.permissions.query({ name: "camera" }).then((p) => { const chk = () => { if (p.state === "denied" && !hosting) status("Your camera is blocked for this site. Tap the 🔒 or aA next to the web address → Website settings → allow Camera and Microphone, then reload."); else if (statusMsg.startsWith("Your camera is blocked")) status(""); }; chk(); p.onchange = chk; }).catch(() => {}); } catch (_) {}
    new MutationObserver(() => { if (!view.hidden) setTimeout(autoAsk, 400); }).observe(view, { attributes: true, attributeFilter: ["hidden"] });
    if (!view.hidden) setTimeout(autoAsk, 800);
    new MutationObserver(() => { if (!view.hidden) render(); }).observe(view, { attributes: true, attributeFilter: ["hidden"] });
    render();
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init); else init();
})();
