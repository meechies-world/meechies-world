/* ============================================================================
   v2 DJ SHARE — the publish side of the master screen (Phase 4), the
   counterpart of the Phase 2 engine's share watcher. Structure and
   ordering follow the live publisher (dj.js @ main ebc7da70):

   - The RealtimeKit SDK loads ONLY on a publish tap, with a 12 s
     watchdog so a hung CDN resolves as a failure, never a latch.
   - Publish order is LAW (the 2026-10-29 studio race): mint → SDK →
     join (20 s timeout) → write the shared switch S.vstream ON →
     start the supervisor → THEN the user-paced picker/camera prompt.
     A failed start after the switch was written clears its own switch
     — no ghost shares.
   - The supervisor (2 s) owns liveness: it verifies the whole chain
     (meeting joined, published track live) and only THEN stamps
     vstream.at with diag.stage "publishing" — proof-based, never
     optimism. Booth saves never re-stamp it (djstate.save discipline).
   - A screen share PAUSES THE TABLES through the same deliberate-pause
     path as a manual all-pause (S.pausedAt), remembers the decks, and
     every ending — his Stop tap, the browser's stop-sharing bar (the
     raw track's ended event), an explicit stop — resumes exactly
     those decks. A share never ends on its own otherwise.
   - HIDE SHARE: the session stays up, viewers fall back to the mix;
     Capture while hidden swaps the source in the same meeting and
     auto-unhides.
   - Master takeover is the engine's/viewer's law; this module only
     publishes and stamps the switch they all read.
   ============================================================================ */
const VS_SDK_URL = "https://cdn.jsdelivr.net/npm/@cloudflare/realtimekit@2.0.4/dist/browser.js";
let vsSdkP = null;

export function vsLoadSdk() {
  if (window.RealtimeKitClient) return Promise.resolve(true);
  if (!vsSdkP) {
    vsSdkP = new Promise((res) => {
      const s = document.createElement("script");
      let done = false;
      const fin = (ok) => { if (done) return; done = true; if (!ok) vsSdkP = null; res(ok); };
      s.src = VS_SDK_URL;
      s.onload = () => fin(!!window.RealtimeKitClient);
      s.onerror = () => fin(false);
      document.head.appendChild(s);
      setTimeout(() => fin(!!window.RealtimeKitClient), 12000);
    });
  }
  return vsSdkP;
}

export function createSharePublisher(ctx, store, hooks) {
  const session = ctx.session;
  const say = hooks.say || (() => {});
  const S = () => store.S;
  let pub = null, busy = false, supIv = null;

  const uid = () => { const u = session.user && session.user(); return u ? u.id : ""; };
  async function vsApi(body) {
    const ses = session.get && session.get();
    const h = { "content-type": "application/json" };
    if (ses && ses.access_token) h.authorization = "Bearer " + ses.access_token;
    try {
      const ctl = typeof AbortController !== "undefined" ? new AbortController() : null;
      const to = ctl ? setTimeout(() => { try { ctl.abort(); } catch (_) {} }, 12000) : 0;
      const r = await fetch("/api/streams", { method: "POST", headers: h, body: JSON.stringify(body), signal: ctl ? ctl.signal : undefined });
      if (to) clearTimeout(to);
      return await r.json().catch(() => null);
    } catch (_) { return null; }
  }

  function proofOk() {
    if (!pub || !pub.meeting) return false;
    const t = pub.pubTrack;
    if (!t || t.readyState !== "live") return false;
    return true;
  }
  function supTick() {
    if (!pub) { supStop(); return; }
    if (proofOk()) {
      pub.strikes = 0;
      const vs = S().vstream;
      if (vs && vs.meeting === pub.mid) {
        vs.at = Date.now();
        vs.diag = { stage: "publishing", at: Date.now(), repairs: pub.repairs || 0 };
        store.save(true);
      }
      return;
    }
    if (pub.starting) return;
    // repair in the same meeting: re-enable the track once per strike
    pub.strikes = (pub.strikes || 0) + 1;
    if (pub.strikes <= 2 && pub.rawTrack && pub.rawTrack.readyState === "live") {
      pub.repairs = (pub.repairs || 0) + 1;
      try { pub.meeting.self.enableVideo(pub.rawTrack); pub.pubTrack = pub.rawTrack; } catch (_) {}
      return;
    }
    if (pub.strikes > 3) {
      say("📹 The live picture could not be kept up — the share has stopped so the station never shows a ghost.");
      stop("The share stopped — the master screen is back to the video mix.");
    }
  }
  function supStart() { if (!supIv) supIv = setInterval(() => { try { supTick(); } catch (_) {} }, 2000); }
  function supStop() { clearInterval(supIv); supIv = null; }

  async function teardown() {
    supStop();
    if (!pub) return;
    const p = pub; pub = null;
    try { p.ownStream && p.ownStream.getTracks().forEach((t) => t.stop()); } catch (_) {}
    try { p.rawStream && p.rawStream.getTracks().forEach((t) => t.stop()); } catch (_) {}
    try { p.meeting && p.meeting.leave(); } catch (_) {}
    try { sessionStorage.removeItem("mw_vspub"); } catch (_) {}
    // resume exactly the decks the share paused (screen shares only)
    if (p.pausedDecks && p.pausedDecks.length && hooks.togglePlay) {
      for (const k of p.pausedDecks) {
        if (!S()[k].playing) { try { await hooks.togglePlay(k); } catch (_) {} }
      }
    }
  }
  function writeOff() {
    const vs = S().vstream || {};
    S().vstream = { on: false, kind: "", at: Date.now(), by: "", meeting: "", hidden: false, stopAt: Date.now(), diag: { stage: "stopped", at: Date.now(), repairs: (vs.diag || {}).repairs || 0 } };
    store.save(true);
  }
  async function stop(msg) {
    await teardown();
    if ((S().vstream || {}).on) writeOff();
    if (msg) say(msg);
    if (hooks.onPaint) hooks.onPaint();
  }

  async function startScreen(meeting) {
    const raw = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
    pub.rawStream = raw;
    const rt = raw.getVideoTracks()[0];
    if (!rt) throw new Error("no screen track");
    pub.rawTrack = rt;
    // the browser's own stop-sharing bar is a sanctioned ending
    rt.addEventListener("ended", () => { if (pub && pub.kind === "screen" && !pub.swapping) stop("🖥 Screen share stopped — the master screen is back to the video mix."); });
    // v2 publishes the raw track (the live canvas-crop pipeline is a
    // flagged Phase 4 remainder — see the differences list)
    await meeting.self.enableVideo(rt);
    pub.pubTrack = rt;
    pub.localStream = new MediaStream([rt]);
    const at = raw.getAudioTracks()[0];
    if (at) { try { await meeting.self.enableAudio(at); pub.pubAudio = at; pub.hadAudio = true; } catch (_) {} }
  }

  async function pubStart(kind) {
    if (store.sandbox) { say("The DJ Playground is a sandbox — live video only runs on the real station."); return; }
    if (!store.isOwner()) { say("Only Meechie can put a live picture on the master screen."); return; }
    if (!store.leadDrive()) { say("📹 Live video runs on the screen that is driving the booth — make this screen the driver first."); return; }
    if (busy) return;
    if (kind === "screen" && !(navigator.mediaDevices && navigator.mediaDevices.getDisplayMedia)) {
      say("🖥 This browser cannot capture your screen — screen capture needs a computer browser (Chrome or Edge). On this device, 📹 Live Video still works for your camera.");
      return;
    }
    if (kind === "cam" && !(navigator.mediaDevices && navigator.mediaDevices.getUserMedia)) { say("📹 This browser cannot reach a camera."); return; }
    busy = true;
    let stateWrote = false, pubMid = "";
    try {
      say(kind === "screen" ? "🖥 Setting up your screen share…" : "📹 Starting live video…");
      const mint = await vsApi({ action: "live_mint", role: "host" });
      if (!mint || !mint.token || !mint.meeting) { say((mint && mint.message) || "📹 Live video could not start — the streaming service did not answer. Nothing else was touched."); return; }
      if (!(await vsLoadSdk())) { say("📹 The live video engine could not load — check your connection and tap again. Nothing else was touched."); return; }
      const meeting = await window.RealtimeKitClient.init({ authToken: mint.token, defaults: { audio: false, video: false } });
      await Promise.race([meeting.join(), new Promise((_, rej) => setTimeout(() => rej(new Error("join timeout")), 20000))]);
      // the switch goes ON before any user-paced await (the studio race)
      pub = { meeting, mid: mint.meeting, kind, ownStream: null, rawStream: null, rawTrack: null, localStream: null, pubTrack: null, pubAudio: null, hadAudio: false, starting: true, strikes: 0, repairs: 0, pausedDecks: null, swapping: false, since: Date.now() };
      S().vstream = { on: true, kind, at: Date.now(), by: uid(), meeting: mint.meeting, hidden: false, stopAt: 0, diag: { stage: "repairing", at: 0, repairs: 0 } };
      pubMid = mint.meeting; stateWrote = true;
      store.save(true);
      try { sessionStorage.setItem("mw_vspub", JSON.stringify({ mid: mint.meeting, kind })); } catch (_) {}
      supStart();
      if (kind === "cam") {
        let track = hooks.getCamTrack ? hooks.getCamTrack() : null;
        if (!track) {
          const s = await navigator.mediaDevices.getUserMedia({ video: { width: { ideal: 1280, max: 1280 }, height: { ideal: 720, max: 720 }, frameRate: { max: 30 } }, audio: false });
          pub.ownStream = s; track = s.getVideoTracks()[0];
        }
        pub.rawTrack = track;
        await meeting.self.enableVideo(track);
        pub.pubTrack = track;
        pub.localStream = new MediaStream([track]);
      } else {
        await startScreen(meeting);
      }
      pub.starting = false;
      try { supTick(); } catch (_) {}
      say(kind === "screen" ? "🖥 Your screen is on the master screen — everyone sees it now. Tap Capture again to stop." : "📹 You are on the master screen in full motion. Tap Live Video again to stop.");
      if (kind === "screen" && hooks.togglePlay) {
        // PAUSE THE TABLES for the share's run (deliberate-pause path)
        const wasPlaying = ["A", "B", "C", "D"].filter((k) => S()[k] && S()[k].playing);
        if (wasPlaying.length) {
          pub.pausedDecks = wasPlaying;
          for (const k of wasPlaying) { try { await hooks.togglePlay(k); } catch (_) {} }
          say("⏸ Tables paused while your screen is up — they pick back up the moment the share stops.");
        }
      }
    } catch (_) {
      await teardown();
      if (stateWrote && (S().vstream || {}).meeting === pubMid) writeOff();
      say(kind === "screen" ? "🖥 Screen share did not start — if you closed the picker, tap Capture and pick the screen you want to show." : "📹 Live video did not start — allow the camera for this site, then tap Live Video again.");
    } finally { busy = false; if (hooks.onPaint) hooks.onPaint(); }
  }

  function toggle(kind) {
    if (pub) {
      if (kind === "screen" && pub.kind === "screen" && (S().vstream || {}).hidden) { swapSource(); return; }
      stop(kind === "screen" ? "🖥 Screen share stopped — the master screen is back to the video mix." : "📹 Live video stopped — the master screen is back to the video mix.");
      return;
    }
    const vs = S().vstream || {};
    if (vs.on && vs.by === uid()) { writeOff(); if (hooks.onPaint) hooks.onPaint(); say("Stopped — the master screen is back to the video mix."); return; }
    pubStart(kind);
  }

  /* HIDE SHARE: session stays up; viewers fall back to the mix */
  function toggleHide() {
    const vs = S().vstream || {};
    if (!vs.on) { say("Nothing is being shared right now."); return; }
    vs.hidden = !vs.hidden;
    store.save(true);
    say(vs.hidden ? "🙈 Share hidden — viewers see the regular station while your share stays up. Tap Capture to change what you are sharing." : "👁 Share is back on the master screen for everyone.");
    if (hooks.onPaint) hooks.onPaint();
  }

  /* Capture while hidden: swap the source in the same meeting, unhide */
  async function swapSource() {
    if (!pub || pub.kind !== "screen") return;
    try {
      pub.swapping = true;
      const raw = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
      try { pub.rawStream && pub.rawStream.getTracks().forEach((t) => t.stop()); } catch (_) {}
      pub.rawStream = raw;
      const rt = raw.getVideoTracks()[0];
      if (!rt) throw new Error("no screen track");
      pub.rawTrack = rt;
      rt.addEventListener("ended", () => { if (pub && pub.kind === "screen" && !pub.swapping) stop("🖥 Screen share stopped — the master screen is back to the video mix."); });
      await pub.meeting.self.enableVideo(rt);
      pub.pubTrack = rt;
      pub.localStream = new MediaStream([rt]);
      const vs = S().vstream; if (vs) vs.hidden = false;
      store.save(true);
      say("🖥 New screen is on the master screen.");
    } catch (_) { say("🖥 Screen swap did not happen — the current share is unchanged."); }
    finally { pub.swapping = false; if (hooks.onPaint) hooks.onPaint(); }
  }

  return {
    toggle, toggleHide, start: pubStart, stop,
    get active() { return !!pub; },
    get localStream() { return pub ? pub.localStream : null; },
    destroy() { supStop(); },
  };
}
