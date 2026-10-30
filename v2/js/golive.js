/* v2 GO LIVE (Phase 5) — the live js/golive.js, ported: camera
   go-live with WebRTC peer-to-peer video (cap 12 viewers), live
   chat, flying gifts, and battles, signalling over the platform
   room (the live lobby's on/emit shape over the changes-feed
   room). The radio bed under a watched live rides the engine's
   listening switch — the station stream IS the bed in v2; the
   live file's separate bed gain (MW.setMixVol) has no v2 engine
   equivalent yet and is noted for Gate T. The sender crop/quality
   pipeline ports as written. Styles live in css/live.css. */
import { firestore } from "./platform.js";
import { toast } from "./commerce.js";
import { getEngine } from "./engine.js";
import { videoSound } from "./platform.js";

export function mountGolive(viewRoot, ctx) {
  const fdb = firestore(ctx);
  const names = {};
  fdb.base.listDocs("members", { limit: 200 }).then((rows) => { rows.forEach((m) => { names[m.id] = m.handle || m.name || "Member"; }); }).catch(() => {});
  const eng = getEngine(ctx);
  const vs = videoSound(eng);
  const setBed = (on) => { try { eng.setListening(on); } catch (_) {} };
  /* the live lobby room shape over the platform room: on/emit with
     self-filtering (the feed echoes the sender's own events) */
  function liveRoom(fdb2, name, peerId) {
    const room = fdb2.base.room(name);
    const handlers = {};
    room.onBroadcast(({ event, data }) => { if (data && data.__from === peerId) return; (handlers[event] || []).forEach((cb) => { try { cb({ data }); } catch (_) {} }); });
    return {
      on(ev, cb) { (handlers[ev] = handlers[ev] || []).push(cb); },
      emit(ev, data) { room.broadcast(ev, { ...data, __from: peerId }); },
      leave() { room.leave(); },
    };
  }

  "use strict";
  const root = viewRoot.querySelector("#gl-root");
  if (!root) return;
  const E = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const say = toast;
  const ME = () => fdb.base.me();
  const DB = () => fdb;
  const HANDLE = (id) => { const h = names[id] || "Member"; if (h !== "Member") return h; const l = lives.find((x) => x.id === id); return l && l.host ? "Meechie" : (id === ME() && fdb.base.isOwner() ? "Meechie" : h); };
  const ICE = { iceServers: [{ urls: ["stun:stun.l.google.com:19302", "stun:stun1.l.google.com:19302", "stun:stun.cloudflare.com:3478"] }] };
  const VAL = { rose: 1, mic: 5, gold: 10, fire: 20, crown: 50, diamond: 100 };
  const EMO = { rose: "🌹", heart: "💛", mic: "🎤", gg: "👏", gold: "🪙", fire: "🔥", crown: "👑", cash: "💵", diamond: "💎", chain: "⛓️", moneygun: "💸", lion: "🦁", ride: "🚘", jet: "🛩️", mansion: "🏰", world: "🌍" };
  const MAX_VIEWERS = 12;
  const myPeer = Math.random().toString(36).slice(2, 12);
  let lives = [], battles = [], hosting = null, watching = {}, chatLog = [], titleDraft = "", shellKey = "", statusMsg = "";
  function status(t) { statusMsg = t || ""; const el = root.querySelector("#gl-status"); if (el) { el.textContent = statusMsg; el.style.display = statusMsg ? "" : "none"; } if (t) say(t); }

  

  const isLive = (l) => l.onsite && Date.now() - (l.beat || l.startedAt || 0) < 90e3;
  const myBattle = (uid) => battles.find((b) => (b.a === uid || b.b === uid) && Date.now() < (b.end || 0) + 15000);
  const giftScore = (uid, from, to) => (typeof giftLog !== "undefined" ? giftLog : []).filter((g) => g.to === uid && g.createdAt >= from && g.createdAt <= to).reduce((n, g) => n + (g.paid && g.coins ? Math.round(g.coins / 10) : (VAL[g.kind] || 1)), 0);

  /* ---------- page ---------- */
  function render() {
    if (!ME()) { root.innerHTML = `<div class="empty"><h3>Sign in to go live or watch</h3><button class="btn" type="button" data-auth="signup" style="margin-top:12px">Join free</button></div>`; return; }
    const key = ME() + "|" + !!hosting + "|" + Object.keys(watching).join(",");
    if (key === shellKey && root.querySelector("#gl-list")) { paintList(); paintBattle(); return; }
    shellKey = key;
    root.innerHTML = `
      <div class="gl-host-ctrl">${hosting ? `<button class="btn" type="button" id="gl-end" style="background:#e5484d;color:#fff">■ End my live</button><button class="btn ghost" type="button" id="gl-flip">🔄 Flip camera</button><button class="btn ghost" type="button" id="gl-battle">⚔️ Start a battle</button><span class="muted" id="gl-vc">0 watching</span><div style="flex-basis:100%;display:flex;gap:14px;flex-wrap:wrap;align-items:center;margin-top:4px"><label class="muted" style="display:flex;gap:6px;align-items:center">🎙️ Your voice <input type="range" id="gl-voice" min="0" max="1.5" step="0.05" value="${hosting.voiceVol ?? 1}" style="width:110px"></label><label class="muted" style="display:flex;gap:6px;align-items:center"><input type="checkbox" id="gl-rad" ${hosting.radioOn ? "checked" : ""} style="width:auto"> 🎧 Station music on my stream</label><label class="muted" style="display:flex;gap:6px;align-items:center">🎵 Music for viewers <input type="range" id="gl-radvol" min="0" max="1" step="0.05" value="${hosting.radioVol ?? 0.7}" style="width:110px"></label><small class="muted">Your voice and the station, balanced by you — the music dips on its own while you talk.</small></div>` : `<input type="text" id="gl-title" maxlength="80" placeholder="What's your live about?" value="${E(titleDraft)}" style="flex:1;min-width:200px;background:var(--ink);border:1px solid var(--line);border-radius:12px;padding:11px;color:var(--text);font:16px var(--body)"><button class="btn" type="button" id="gl-go" style="background:#e5484d;color:#fff">🎥 Go live</button>`}</div>
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
    el.innerHTML = on.map((l) => l.obs && l.url
      ? `<button class="gl-card" type="button" data-obs="${E(l.id)}"><span><span class="dot"></span><b>${E(HANDLE(l.id))}</b>${l.host ? ' <span class="badge">Host</span>' : ""} <span class="badge">📡 OBS</span></span><small class="muted">${E(l.title || "Live")}</small><span style="color:var(--gold-hi);font-weight:700">Watch →</span></button>`
      : `<button class="gl-card" type="button" data-watch="${E(l.id)}"><span><span class="dot"></span><b>${E(HANDLE(l.id))}</b>${l.host ? ' <span class="badge">Host</span>' : ""}</span><small class="muted">${E(l.title || "Live")}</small><span style="color:var(--gold-hi);font-weight:700">${watching[l.id] ? "Watching ✓ (tap to leave)" : "Watch →"}</span></button>`).join("") || '<p class="muted">Nobody else is live right now. Be the first!</p>';
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
    if (hosting) { const b = box(ME(), "You", true); st.appendChild(b); const v = b.querySelector("video"); v.srcObject = hosting.stream; fitBox(v); }
    for (const [id, w] of Object.entries(watching)) { const b = box(id, HANDLE(id), false); st.appendChild(b); if (w.stream) attach(b, w); }
    paintChat();
  }
  // the frame takes the camera's own shape (tall phone or wide laptop), so nothing gets cut off or zoomed in
  function fitBox(v) {
    const set = () => { if (v.videoWidth && v.videoHeight) { const bx = v.closest(".gl-box"); if (bx) bx.style.setProperty("--ar", v.videoWidth + "/" + v.videoHeight); } };
    v.addEventListener("loadedmetadata", set); v.addEventListener("resize", set); set();
  }
  // widest view the camera allows (some phones start the front camera zoomed in), sharp picture
  async function widen(stream) {
    const t = stream && stream.getVideoTracks()[0]; if (!t) return;
    try { t.contentHint = "detail"; } catch (_) {}
    try { const c = t.getCapabilities ? t.getCapabilities() : {}; const adv = {};
      if (c.zoom && typeof c.zoom.min === "number") adv.zoom = c.zoom.min;
      if (c.resizeMode && c.resizeMode.includes && c.resizeMode.includes("none")) adv.resizeMode = "none";
      if (Object.keys(adv).length) await t.applyConstraints({ advanced: [adv] });
    } catch (_) {}
  }
  // ask the connection to send a high-quality picture (up to ~2.5 Mbps), keeping it sharp rather than smooth-but-blurry
  function hiQuality(pc) {
    pc.getSenders().forEach((snd) => { if (!snd.track || snd.track.kind !== "video") return;
      try { const p = snd.getParameters(); if (!p.encodings || !p.encodings.length) p.encodings = [{}];
        p.encodings[0].maxBitrate = 2500000; p.encodings[0].maxFramerate = 30; p.encodings[0].scaleResolutionDownBy = 1; p.degradationPreference = "maintain-resolution";
        snd.setParameters(p).catch(() => {}); } catch (_) {} });
  }
  function attach(b, w) {
    const v = b.querySelector("video"); v.srcObject = w.stream; v.muted = !w.sound; fitBox(v);
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
  async function joinRoom(id) { if (!ME()) throw new Error("Sign in to use Live."); return liveRoom(fdb, "lv-" + id, myPeer); }
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
      <div class="gi-hero" style="font-size:44px">🎥🎤</div><h3 style="margin:0;font-size:21px">Allow camera &amp; microphone</h3>${body}
      ${inApp ? "" : `<button class="btn" type="button" id="gl-perm-ok" style="background:#e5484d;color:#fff;font-size:17px;padding:13px">${state === "denied" ? "I turned it on — reload" : "Allow camera"}</button>`}
      <button class="btn ghost" type="button" id="gl-perm-no">Not now</button></div>`;
    m.hidden = false; m.dataset.from = "live";
    m.querySelector("#gl-perm-no").onclick = () => { m.hidden = true; };
    const ok = m.querySelector("#gl-perm-ok"); if (ok) ok.onclick = () => (state === "denied" ? location.reload() : requestCam(true));
  }
  /* The Live page's camera pop-up belongs to the Live page: close it when the visitor goes to another page */
  // (the menu switches pages without changing the address, so watch the Live page itself being hidden)
  const closeLivePerm = () => { const m = document.getElementById("gl-perm"); if (m && !m.hidden && m.dataset.from === "live" && !root.isConnected) m.hidden = true; };
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
        <div class="gi-hero" style="font-size:44px">🎥🎤</div><h3 style="margin:0;font-size:21px">Turn on your camera &amp; mic?</h3>
        <p>Meechie's World uses your <b>camera</b> and <b>microphone</b> to go live, record in the Studio, send voice messages, and talk to Meechie's AI.</p>
        <p class="muted" style="font-size:14px;margin:0">Nothing turns on until you use one of those. When your phone asks, tap <b>Allow</b>.</p>
        <button class="btn" type="button" id="gl-perm-ok" style="font-size:17px;padding:13px">Allow camera &amp; mic</button>
        <button class="btn ghost" type="button" id="gl-perm-no">Not now</button></div>`;
      m.hidden = false; m.dataset.from = "site";
      m.querySelector("#gl-perm-no").onclick = () => { m.hidden = true; };
      m.querySelector("#gl-perm-ok").onclick = async () => { if (await requestCam(false)) say("You're all set! 🎉"); else { const st2 = await camState(); if (st2 === "denied") permModal("denied"); else m.hidden = true; } };
    });
  }
  /* no longer pops up on its own: the camera is asked for only when someone uses Live, Studio, voice or the AI (it was covering the whole phone screen) */
  void siteAsk;

  async function autoAsk() {
    if (askedThisVisit || hosting || !ME() || !root.isConnected) return;
    askedThisVisit = true;
    if (inApp) { permModal("prompt"); return; }
    const st = await camState();
    if (st === "granted") return;
    if (st === "denied") { permModal("denied"); return; }
    // ask the phone right away; if it needs a tap first, show our pop-up with the big button
    permModal("prompt");
    // if they answer the browser's box after leaving Live, don't leave the Live pop-up over another page
    requestCam(false).then(() => { const m = document.getElementById("gl-perm"); if (m && !root.isConnected && m.dataset.from === "live") m.hidden = true; });
  }

  /* ---------- hosting ---------- */
  let facing = "user";
  async function goLive() {
    if (!ME()) { toast("Join free to go live."); location.hash = "#community"; return; }
    if (hosting) return;
    if (!window.isSecureContext || !navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      status("This browser can't use the camera. If you opened the link inside TikTok, Instagram, Snapchat or Facebook, tap ⋯ and choose Open in Safari or Chrome."); return;
    }
    const btn = root.querySelector("#gl-go"); if (btn) { btn.disabled = true; btn.textContent = "Starting camera…"; }
    status(""); const el0 = root.querySelector("#gl-status"); if (el0) { el0.style.display = ""; el0.textContent = "Asking for your camera… if a box pops up, tap Allow."; }
    const reset = () => { if (btn && btn.isConnected) { btn.disabled = false; btn.textContent = "🎥 Go live"; } };
    let stream = null, lastErr = null;
    const tries = [
      { video: { facingMode: facing, width: { ideal: 1920 }, height: { ideal: 1080 }, frameRate: { ideal: 30 } }, audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } },
      { video: { facingMode: facing, width: { ideal: 1280 }, height: { ideal: 720 } }, audio: { echoCancellation: true, noiseSuppression: true } },
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
    status(""); await widen(stream);
    if (!stream.getAudioTracks().length) say("Going live without sound: the microphone wasn't allowed.");
    let room;
    try { room = await joinRoom(ME()); } catch (e) { stream.getTracks().forEach((t) => t.stop()); reset(); status(e.message || "Couldn't connect. Try again."); return; }
    // pro stream mix: the mic runs through a voice gain before it reaches viewers,
    // so the host balances VOICE vs MUSIC for the audience, not just at the phone
    let sendStream = stream, actx = null, voiceGain = null;
    try {
      if (stream.getAudioTracks().length) {
        const AC = window.AudioContext || window.webkitAudioContext;
        actx = new AC();
        const msrc = actx.createMediaStreamSource(stream);
        voiceGain = actx.createGain(); voiceGain.gain.value = 1;
        const mdst = actx.createMediaStreamDestination();
        msrc.connect(voiceGain); voiceGain.connect(mdst);
        const vt = stream.getVideoTracks()[0], at = mdst.stream.getAudioTracks()[0];
        sendStream = new MediaStream([vt, at].filter(Boolean));
      }
    } catch (_) { sendStream = stream; actx = null; voiceGain = null; }
    hosting = { stream, sendStream, actx, voiceGain, voiceVol: 1, radioOn: false, radioVol: 0.7, room, peers: {}, title: titleDraft.trim() || "Live with " + HANDLE(ME()) };
    wireChat(room, ME());
    room.on("want", async ({ data }) => {
      if (!hosting || !data || !data.peer) return;
      if (Object.keys(hosting.peers).length >= MAX_VIEWERS && !hosting.peers[data.peer]) { room.emit("full", { to: data.peer }); return; }
      if (hosting.peers[data.peer]) return;
      const pc = new RTCPeerConnection(ICE); hosting.peers[data.peer] = pc;
      (hosting.sendStream || hosting.stream).getTracks().forEach((t) => pc.addTrack(t, hosting.sendStream || hosting.stream));
      pc.onicecandidate = (e) => { if (e.candidate) room.emit("ice", { to: data.peer, from: "host", c: e.candidate.toJSON() }); };
      pc.onconnectionstatechange = () => { if (/failed|closed|disconnected/.test(pc.connectionState)) { try { pc.close(); } catch (_) {} delete hosting?.peers[data.peer]; count(); } else count(); };
      hiQuality(pc);
      const offer = await pc.createOffer(); await pc.setLocalDescription(offer);
      room.emit("offer", { to: data.peer, sdp: pc.localDescription.toJSON() });
    });
    room.on("answer", async ({ data }) => { const pc = hosting && hosting.peers[data && data.from]; if (pc && data.sdp) { try { await pc.setRemoteDescription(data.sdp); } catch (_) {} } });
    room.on("ice", async ({ data }) => { if (!data || data.to !== "host") return; const pc = hosting && hosting.peers[data.from]; if (pc && data.c) { try { await pc.addIceCandidate(data.c); } catch (_) {} } });
    room.on("bye", ({ data }) => { const pc = hosting && hosting.peers[data && data.from]; if (pc) { try { pc.close(); } catch (_) {} delete hosting.peers[data.from]; count(); } });
    let saved = true;
    await DB().doc("live/" + ME()).set({ title: hosting.title.slice(0, 80), url: "", onsite: true, host: fdb.base.isOwner(), startedAt: Date.now(), beat: Date.now(), radioOn: hosting.radioOn, radioVol: hosting.radioVol }).catch((e) => { saved = false; say("You're live, but we couldn't list you on the Live page: " + (e.message || e.code)); });
    hosting.beat = setInterval(() => DB().doc("live/" + ME()).update({ beat: Date.now() }).catch(() => {}), 30000);
    room.emit("hello", {}); if (saved) say("You're live! Share the site so people can watch.");
    shellKey = ""; render();
  }
  function count() { const n = hosting ? Object.values(hosting.peers).filter((p) => p.connectionState === "connected").length : 0; const el = root.querySelector("#gl-vc"); if (el) el.textContent = n + " watching"; const c = root.querySelector(`[data-cnt="${CSS.escape(ME() || "")}"]`); if (c) c.textContent = "👁 " + n; }
  async function endLive() {
    if (!hosting) return;
    clearInterval(hosting.beat); hosting.room.emit("ended", {});
    Object.values(hosting.peers).forEach((p) => { try { p.close(); } catch (_) {} });
    if (hosting.actx) { try { hosting.actx.close(); } catch (_) {} } hosting.stream.getTracks().forEach((t) => t.stop()); try { hosting.room.leave(); } catch (_) {}
    hosting = null; shellKey = ""; await DB().doc("live/" + ME()).delete().catch(() => {}); say("Your live has ended."); render();
  }
  async function flip() {
    if (!hosting) return; facing = facing === "user" ? "environment" : "user";
    try {
      const s = await navigator.mediaDevices.getUserMedia({ video: { facingMode: facing, width: { ideal: 1920 }, height: { ideal: 1080 }, frameRate: { ideal: 30 } } }); await widen(s); const nt = s.getVideoTracks()[0];
      const old = hosting.stream.getVideoTracks()[0]; hosting.stream.removeTrack(old); old.stop(); hosting.stream.addTrack(nt);
      Object.values(hosting.peers).forEach((pc) => { const snd = pc.getSenders().find((x) => x.track && x.track.kind === "video"); if (snd) snd.replaceTrack(nt).then(() => hiQuality(pc)).catch(() => {}); });
      paintStage();
    } catch (_) { say("Couldn't switch cameras."); }
  }

  /* ---------- watching ---------- */
  async function watch(id) {
    if (watching[id]) return;
    vs.start();
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
  function stopWatch(id) { const w = watching[id]; if (!w) return; try { w.room.emit("bye", { from: myPeer }); w.pc.close(); w.room.leave(); } catch (_) {} delete watching[id]; if (!Object.keys(watching).length) vs.end(); shellKey = ""; render(); }

  /* ---------- station music bed for viewers ----------
   * When a host turns the station on for their stream, viewers hear the radio
   * (the DJ tables) under the host's voice, at the level the host set — and it
   * dips itself while the host is talking. */
  let bedFor = null, bedCtx = null, bedAn = null, bedStream = null, bedLevel = 0, bedTarget = 0.7;
  function closeBedAn() { if (bedCtx) { try { bedCtx.close(); } catch (_) {} } bedCtx = null; bedAn = null; bedStream = null; }
  function syncBed() {
    const MW = window.MW_DJ; if (!MW) return;
    let drive = null;
    for (const [id, w] of Object.entries(watching)) { const l = lives.find((x) => x.id === id); if (l && l.radioOn && w.sound) { drive = { id, l, w }; break; } }
    if (!drive) { if (bedFor) { setBed(false); bedFor = null; } closeBedAn(); return; }
    if (bedFor !== drive.id) { bedFor = drive.id; bedLevel = drive.l.radioVol ?? 0.7; setBed(true); }
    bedTarget = drive.l.radioVol ?? 0.7;
    if (drive.w.stream && drive.w.stream.getAudioTracks().length) {
      if (bedStream !== drive.w.stream) { closeBedAn(); bedStream = drive.w.stream;
        try { const AC = window.AudioContext || window.webkitAudioContext; bedCtx = new AC(); const src = bedCtx.createMediaStreamSource(drive.w.stream); bedAn = bedCtx.createAnalyser(); bedAn.fftSize = 512; const z = bedCtx.createGain(); z.gain.value = 0; src.connect(bedAn); bedAn.connect(z); z.connect(bedCtx.destination); if (bedCtx.state === "suspended") bedCtx.resume().catch(() => {}); } catch (_) { closeBedAn(); }
      }
    } else closeBedAn();
    if (!bedAn) { /* v2: the bed is the station stream itself; its level is the listener's volume — no separate bed gain yet (Gate T) */ }
  }
  setInterval(() => { if (!root.isConnected) return; syncBed(); if (bedAn && bedFor) { const a = new Uint8Array(bedAn.fftSize); bedAn.getByteTimeDomainData(a); let m = 0; for (let i = 0; i < a.length; i++) m = Math.max(m, Math.abs(a[i] - 128) / 128); const t = m > 0.055 ? bedTarget * 0.32 : bedTarget; bedLevel += (t - bedLevel) * 0.35; window.MW_DJ?.setMixVol(Math.max(0, Math.min(1, bedLevel))); } }, 300);

  /* ---------- battles (TikTok-style) ----------
   * Two hosts, 1/3/5 minutes. Points = coins of paid gifts sent to each side during the battle.
   * Shows each side's top 3 gifters, the MVP, a 🔥 final-30-seconds rush, a winner screen and a Rematch button. */
  const QUICK = [["rose", "🌹", 1], ["fire", "🔥", 25], ["crown", "👑", 50], ["diamond", "💎", 199]];
  const battleGifts = (b, uid) => (typeof giftLog !== "undefined" ? giftLog : []).filter((g) => g.paid && g.to === uid && g.createdAt >= b.start && g.createdAt <= b.end);
  const tops = (list) => { const m = {}; list.forEach((g) => (m[g.from] = (m[g.from] || 0) + (g.coins || 0))); return Object.entries(m).sort((a, z) => z[1] - a[1]); };
  const av = (id) => (typeof avatarOf === "function" ? avatarOf(id) : "");
  const bcss = document.createElement("style");
  bcss.textContent = `.bt{border-radius:18px;padding:14px;display:grid;gap:10px;background:linear-gradient(165deg,rgba(30,10,12,.95),rgba(8,10,30,.95));border:1px solid rgba(255,224,138,.45);position:relative;overflow:hidden}
.bt .hd{display:flex;align-items:center;justify-content:space-between;gap:8px;font:800 15px system-ui}
.bt .clock{font:900 18px system-ui;color:#fff;background:rgba(0,0,0,.45);border-radius:999px;padding:4px 12px}
.bt .clock.rush{color:#ffd76a;animation:btPulse .8s infinite}@keyframes btPulse{50%{transform:scale(1.12)}}
.bt .bar{height:28px;border-radius:999px;overflow:hidden;display:flex;font:900 13px system-ui;box-shadow:inset 0 0 0 1px rgba(255,255,255,.2)}
.bt .bar i{display:flex;align-items:center;padding:0 10px;color:#fff;font-style:normal;transition:flex-grow .6s;min-width:46px}
.bt .bar .a{background:linear-gradient(90deg,#ff3b5c,#ff7a59);justify-content:flex-start}.bt .bar .b{background:linear-gradient(90deg,#3b82f6,#38bdf8);justify-content:flex-end}
.bt .sides{display:grid;grid-template-columns:1fr 1fr;gap:10px}
.bt .side{display:grid;gap:6px;align-content:start;min-width:0}.bt .side h4{margin:0;font:800 14px system-ui;display:flex;align-items:center;gap:6px;min-width:0;overflow:hidden;white-space:nowrap}
.bt .side.a h4{color:#ff8a9a}.bt .side.b h4{color:#8ec5ff;justify-content:flex-end}
.bt .side h4 .avatar{width:28px;height:28px;margin:0;flex:none}
.bt .gifters{display:flex;gap:4px}.bt .side.b .gifters{justify-content:flex-end}
.bt .gifters span{position:relative}.bt .gifters .avatar{width:30px;height:30px;margin:0}.bt .gifters b{position:absolute;bottom:-4px;right:-4px;background:#ffd76a;color:#130e04;border-radius:999px;font:900 9px system-ui;padding:1px 4px}
.bt .qg{display:flex;gap:4px;flex-wrap:wrap}.bt .side.b .qg{justify-content:flex-end}
.bt .qg button{border:0;border-radius:12px;background:rgba(255,255,255,.12);color:#fff;font:800 12px system-ui;padding:6px 8px;cursor:pointer}.bt .qg button:active{transform:scale(.92)}
.bt .mvp{font:700 13px system-ui;color:#ffe08a;text-align:center}
.bt .win{position:absolute;inset:0;display:grid;place-items:center;text-align:center;background:radial-gradient(70% 60% at 50% 45%,rgba(255,200,90,.35),rgba(0,0,0,.82));animation:btIn .5s ease-out}
@keyframes btIn{from{opacity:0;transform:scale(1.1)}}.bt .win b{display:block;font:400 clamp(30px,8vw,48px)/1.05 var(--brush,system-ui);color:#ffe08a;text-shadow:0 0 18px rgba(255,190,60,.8)}
.bt .win .crown{font-size:56px;animation:btCrown 1.4s ease-in-out infinite}@keyframes btCrown{50%{transform:translateY(-6px) rotate(-6deg)}}`;
  document.head.appendChild(bcss);
  let lastWin = "";
  function paintBattle() {
    const el = root.querySelector("#gl-battlebox"); if (!el) return;
    const ids = [hosting ? ME() : null, ...Object.keys(watching)].filter(Boolean);
    const b = ids.map(myBattle).find(Boolean);
    window.MW_BATTLE_ID = b && Date.now() < b.end ? b.id : "";
    if (!b) { el.innerHTML = ""; return; }
    const ga = battleGifts(b, b.a), gb = battleGifts(b, b.b);
    const sa = ga.reduce((n, g) => n + (g.coins || 0), 0), sb = gb.reduce((n, g) => n + (g.coins || 0), 0);
    const left = Math.max(0, Math.ceil((b.end - Date.now()) / 1000)), done = left === 0;
    const all = tops([...ga, ...gb]), mvp = all[0];
    const side = (k, uid, list) => `<div class="side ${k}"><h4>${k === "a" ? av(uid) : ""}${E(HANDLE(uid))}${k === "b" ? av(uid) : ""}</h4>
      <div class="gifters">${tops(list).slice(0, 3).map(([id, c], i) => `<span title="${E(HANDLE(id))}: ${c} coins">${av(id)}<b>${i + 1}</b></span>`).join("") || `<small class="muted">No gifts yet</small>`}</div>
      ${done ? "" : uid === ME() ? `<small class="muted">${k === "a" ? "" : ""}Your side · ask your fans for gifts!</small>` : `<div class="qg">${QUICK.map(([kd, e, c]) => `<button type="button" data-bq="${kd}" data-bto="${E(uid)}" title="${c} coins">${e} ${c}</button>`).join("")}<button type="button" data-giftlive="${E(uid)}">🎁 More</button></div>`}</div>`;
    const mm = Math.floor(left / 60), ss = String(left % 60).padStart(2, "0");
    let win = "";
    if (done) {
      const w = sa === sb ? null : sa > sb ? b.a : b.b;
      win = `<div class="win"><div><div class="crown">${w ? "👑" : "🤝"}</div><b>${w ? E(HANDLE(w)) + " wins!" : "It's a tie!"}</b><div style="color:#fff;margin-top:6px">${sa.toLocaleString()} – ${sb.toLocaleString()}${mvp ? ` · MVP: ${E(HANDLE(mvp[0]))}` : ""}</div>${(b.a === ME() || b.b === ME()) ? `<button class="btn" type="button" data-rematch="${E(b.a === ME() ? b.b : b.a)}" style="margin-top:12px">⚔️ Rematch</button>` : ""}</div></div>`;
      if (lastWin !== b.id && Date.now() - b.end < 20000) { lastWin = b.id; try { if (window.MW_GIFTS && w) MW_GIFTS.fx("crown", w); } catch (_) {} }
    }
    el.innerHTML = `<div class="bt"><div class="hd"><span>⚔️ BATTLE</span><span class="clock${!done && left <= 30 ? " rush" : ""}">${done ? "Done" : (left <= 30 ? "🔥 " : "") + mm + ":" + ss}</span></div>
      <div class="bar"><i class="a" style="flex-grow:${sa + 1}">${sa.toLocaleString()}</i><i class="b" style="flex-grow:${sb + 1}">${sb.toLocaleString()}</i></div>
      <div class="sides">${side("a", b.a, ga)}${side("b", b.b, gb)}</div>
      ${mvp && !done ? `<div class="mvp">⭐ MVP so far: ${E(HANDLE(mvp[0]))} (${mvp[1].toLocaleString()} coins)</div>` : ""}
      ${!done && ((!watching[b.a] && b.a !== ME()) || (!watching[b.b] && b.b !== ME())) ? `<div style="display:flex;gap:6px;justify-content:center">${!watching[b.a] && b.a !== ME() ? `<button class="btn ghost sm" type="button" data-watch="${E(b.a)}">Watch ${E(HANDLE(b.a))}</button>` : ""}${!watching[b.b] && b.b !== ME() ? `<button class="btn ghost sm" type="button" data-watch="${E(b.b)}">Watch ${E(HANDLE(b.b))}</button>` : ""}</div>` : ""}
      ${win}</div>`;
  }
  setInterval(() => { if (!!root.isConnected) paintBattle(); }, 1000);
  async function startBattle(oppId) {
    const others = lives.filter((l) => isLive(l) && l.id !== ME());
    if (!others.length) { say("Nobody else is live to battle right now."); return; }
    let opp = oppId ? others.find((l) => l.id === oppId) : null;
    if (!opp) { const name = prompt("Battle who? Type their name:\n" + others.map((l) => "• " + HANDLE(l.id)).join("\n"), HANDLE(others[0].id)); if (!name) return; opp = others.find((l) => HANDLE(l.id).toLowerCase() === name.trim().toLowerCase()); }
    if (!opp) { say("They're not live right now."); return; }
    const mins = +prompt("How long? Type 1, 3 or 5 (minutes)", "3"); const len = [1, 3, 5].includes(mins) ? mins : 3;
    const start = Date.now();
    await DB().collection("battles").add({ authorId: ME(), a: ME(), b: opp.id, start, end: start + len * 60000, createdAt: start }).catch((e) => say(e.message || e.code));
    say(`Battle on! ${len} minute${len > 1 ? "s" : ""}. Most gift points wins. ⚔️`);
  }
  window.MW_LIVE_IDS = () => [hosting ? ME() : null, ...Object.keys(watching)].filter(Boolean);

  /* ---------- clicks ---------- */
  root.addEventListener("click", (e) => {
    const b = e.target.closest("button"); if (!b) return;
    if (b.dataset.unmute !== undefined) { const bx = b.closest("[data-box]"), w = watching[bx.dataset.box]; if (w) { w.sound = true; attach(bx, w); } setTimeout(syncBed, 60); return; }
    if (b.id === "gl-go") return goLive();
    if (b.id === "gl-end") return endLive();
    if (b.id === "gl-flip") return flip();
    if (b.id === "gl-battle") return startBattle();
    if (b.dataset.rematch) return startBattle(b.dataset.rematch);
    if (b.dataset.bq) { if (!window.MW_GIFTS) return; b.disabled = true; MW_GIFTS.quick(b.dataset.bto, b.dataset.bq, window.MW_BATTLE_ID).then((ok) => { b.disabled = false; if (ok) { const r = b.dataset.bto === ME() ? hosting && hosting.room : (watching[b.dataset.bto] || {}).room; if (r) r.emit("gift", { uid: ME(), kind: b.dataset.bq }); fly(b.dataset.bto, b.dataset.bq); paintBattle(); } }); return; }
    if (b.dataset.watch) return watching[b.dataset.watch] ? stopWatch(b.dataset.watch) : watch(b.dataset.watch);
    if (b.dataset.giftlive) {
      const to = b.dataset.giftlive; if (typeof openGift !== "function") return;
      openGift(to);
      const dlg = document.getElementById("gift-dialog"); if (!dlg || !dlg.open) return; // not opened (not a member, or gifting yourself)
      // only after the gift really went through (paid gifts can fail for not enough coins)
      const sent = (ev) => { const d = ev.detail || {}; if (d.to !== to) return; document.removeEventListener("mw-gift-sent", sent); const g = d.kind || "rose"; const r = to === ME() ? hosting && hosting.room : (watching[to] || {}).room; if (r) r.emit("gift", { uid: ME(), kind: g }); fly(to, g); };
      document.addEventListener("mw-gift-sent", sent);
      dlg.addEventListener("close", () => setTimeout(() => document.removeEventListener("mw-gift-sent", sent), 50), { once: true });
    }
  });
  root.addEventListener("input", (e) => {
    if (e.target.id === "gl-title") titleDraft = e.target.value;
    if (!hosting) return;
    if (e.target.id === "gl-voice") { hosting.voiceVol = +e.target.value; if (hosting.voiceGain && hosting.actx) { try { hosting.voiceGain.gain.setTargetAtTime(hosting.voiceVol, hosting.actx.currentTime, 0.03); } catch (_) { hosting.voiceGain.gain.value = hosting.voiceVol; } } }
    if (e.target.id === "gl-radvol") { hosting.radioVol = +e.target.value; DB()?.doc("live/" + ME()).update({ radioVol: hosting.radioVol }).catch(() => {}); }
    if (e.target.id === "gl-rad") { hosting.radioOn = e.target.checked; DB()?.doc("live/" + ME()).update({ radioOn: hosting.radioOn, radioVol: hosting.radioVol }).catch(() => {}); say(hosting.radioOn ? "🎧 The station is on your stream — viewers hear the music too, at the level of the Music slider." : "Station music off your stream."); }
  });
  root.addEventListener("keydown", (e) => { if (e.target.id === "gl-title" && e.key === "Enter") { e.preventDefault(); goLive(); } });
  root.addEventListener("submit", (e) => {
    const f = e.target.closest("[data-chatform]"); if (!f) return; e.preventDefault();
    const id = f.dataset.chatform, inp = f.querySelector("input"), text = inp.value.trim(); if (!text) return; inp.value = "";
    const r = id === ME() ? hosting && hosting.room : (watching[id] || {}).room; if (!r) return;
    r.emit("chat", { uid: ME(), text: text.slice(0, 150) }); chatLog.push({ room: id, uid: ME(), text }); paintChat();
  });
  addEventListener("pagehide", () => { if (hosting) { try { navigator.sendBeacon && 0; } catch (_) {} endLive(); } Object.keys(watching).forEach(stopWatch); });

  async function init() {
    const d = fdb;
    d.collection("live").limit(100).onSnapshot((s) => { lives = s.docs.map((x) => ({ id: x.id, ...x.data() })); if (!!root.isConnected) render(); document.querySelectorAll('[data-go="live"]').forEach((a) => a.classList.toggle("has-live", lives.some(isLive))); }, () => {});
    d.collection("battles").orderBy("createdAt", "desc").limit(20).onSnapshot((s) => { battles = s.docs.map((x) => ({ id: x.id, ...x.data() })); paintBattle(); }, () => {});
    try { navigator.permissions && navigator.permissions.query({ name: "camera" }).then((p) => { const chk = () => { if (p.state === "denied" && !hosting) status("Your camera is blocked for this site. Tap the 🔒 or aA next to the web address → Website settings → allow Camera and Microphone, then reload."); else if (statusMsg.startsWith("Your camera is blocked")) status(""); }; chk(); p.onchange = chk; }).catch(() => {}); } catch (_) {}
    if (!!root.isConnected) setTimeout(autoAsk, 800);
    render();
  }
  init();
  return () => { try { if (hosting) endLive(); } catch (_) {} try { Object.keys(watching).forEach(stopWatch); } catch (_) {} try { fdb.base.stop(); } catch (_) {} };

}
