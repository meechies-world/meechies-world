/* ============================================================================
   v2 WATCH THE SETUP — the spectator booth (MAP Law 12, Phase 2).

   The booth itself, built a second time for the room: the same markup
   and classes the owner console uses, in the booth's own order —
   master screen, UP NEXT queue band, decks A B | X cluster | C D,
   MASTER FX — painted from the shared station state with the booth's
   own formulas (posOf for position, the paintXfPads math for the X
   dot, the pan readout, the FX values). It is RENDERED from state,
   never a capture, and it has zero control hooks: every control-
   looking surface carries .ws-ctl, whose only click path runs the
   upsell card with Law 12's verbatim prices. Watching and listening
   are free forever; the master screen is a real engine screen, so
   the video mix and the live share land on it like everywhere else.

   Phase 2 is the read path: an existing free trial paints as on
   (read from the member doc), but STARTING a trial writes state and
   is deferred to the commerce phase — the button says so in the
   modal's own note slot rather than faking a save. Flagged in the
   differences list.
   ============================================================================ */

import { DECKS, posOf, xfGain, pairXGain, vmixTargets, vsBroadcast, stationLive, fmt, esc } from "../station.js";
import { getEngine } from "../engine.js";
import { mountMini } from "../mini.js";

const okUrl = (u) => typeof u === "string" && /^https?:\/\//.test(u);
const gName = (g) => { const n = ((g && g.name) || "").trim(); return n ? (n.includes("@") ? n.split("@")[0] : n) : "Guest DJ"; };

const MARKUP = `
<div class="wrap">
  <div class="section-head">
    <div><p class="eyebrow">Meechie's World Radio</p><h2>👀 Watch the Setup</h2></div>
    <p class="muted">Meechie's own DJ booth, live — the same tables he sees, working the way he works them: the master screen, all four decks, the X fader, the FX and the queue. Watching and listening are free for everyone. The controls answer to Meechie only.</p>
  </div>
  <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:12px">
    <button type="button" class="btn sm" id="wb-sound">🔇 Sound off — tap for sound</button>
    <span class="muted" style="font-size:13px">The station sound rides along with the picture. Tap any deck, the fader or the FX and you will see whose tables these are.</span>
  </div>
  <div id="ws-body"><p class="muted">Loading the setup...</p></div>
  <p style="margin-top:14px"><a class="btn ghost sm" href="#radio" data-go="radio">🎧 Back to the radio</a> <a class="btn ghost sm" href="#mwtv" data-go="mwtv">📺 MW TV</a></p>
</div>`;

/* ---------- the spectator booth build (live wbBuild, verbatim) ---------- */
const WB_DK = { A: "#f0cf78", B: "#38bdf8", C: "#4ade80", D: "#f472b6" };
function wbDeckHTML(k) {
  return `<div class="deck ws-ctl" data-deck="${k}" style="--dk:${WB_DK[k]}"><h4>DECK ${k}</h4><div class="platter" id="wb-pl-${k}"></div>
    <canvas class="wave" id="wb-wv-${k}" width="520" height="84"></canvas>
    <div class="wb-yt" id="wb-yt-${k}" hidden>🎬 MUSIC VIDEO — playing on the master screen above</div>
    <div class="ttl" id="wb-ttl-${k}">Load a song</div><div class="tm" id="wb-tm-${k}">0:00</div>
    <div class="beatbox"><span class="bpmv" id="wb-bpm-${k}">BPM —</span><span class="keyv" id="wb-key-${k}"></span><span class="bdots" id="wb-dots-${k}"><i></i><i></i><i></i><i></i></span></div>
    <div class="row"><button class="btn sm" type="button" id="wb-play-${k}">▶ Play</button><button class="btn ghost sm" type="button">⏮ Cue</button><button class="btn ghost sm" type="button">🛑 Brake</button></div>
    <label class="lab">Pitch <span id="wb-pitv-${k}">0.0%</span><input type="range" min="0.92" max="1.08" step="0.001" value="1" id="wb-pit-${k}" disabled></label>
    <label class="lab">Volume<input type="range" min="0" max="2" step="0.01" value="0.9" id="wb-vol-${k}" disabled></label></div>`;
}
function wbFxCell(id, lab, min, max, step) {
  return `<div class="fxcell"><small>${lab} · <span id="wb-fxv-${id}"></span></small><input type="range" min="${min}" max="${max}" step="${step}" value="${min}" id="wb-fx-${id}" disabled></div>`;
}
function wbBuild(body) {
  const deckA = wbDeckHTML("A"), deckB = wbDeckHTML("B"), deckC = wbDeckHTML("C"), deckD = wbDeckHTML("D");
  const xv = (k) => `<div class="xv" id="wb-xv-${k}" style="--dk:${WB_DK[k]}"><i></i><span>VOL ${k}</span><b id="wb-xvb-${k}">90%</b></div>`;
  body.innerHTML = `<div id="wb-root">
    <div class="wb-top"><span class="onair-lamp" id="wb-lamp"><span class="dot"></span>OFF AIR</span><span class="wb-now" id="wb-now"></span></div>
    <div class="dj-screen"><small>📺 MASTER SCREEN — MUSIC VIDEO · EVERYONE SEES THIS SCREEN LIVE</small>
    <div class="vstage" id="wb-stage"><div class="vslot" id="wb-vs1"></div><div class="vslot" id="wb-vs2"></div><div class="vstandby" id="wb-vstandby">Meechie is live on the tables — the video mix lands here the moment a music video plays.</div><div class="vposter" id="wb-vposter"><img src="/img/radio-promo.jpg" alt="Meechie's World Radio" loading="lazy" decoding="async"></div><div class="vchip" id="wb-vchip" hidden></div></div></div>
    <div class="dj-panel wb-band"><h4>🎶 UP NEXT — THE QUEUE</h4><div class="dj-list" id="wb-queue"></div></div>
    <div class="dj-decks wb-decks">${deckA}${deckB}
    <div class="mixer xfbar ws-ctl"><div class="xfrow"><div class="xfvols">${xv("A")}${xv("B")}</div><div class="xfpad big"><span class="xfpl tl">A</span><span class="xfpl tr">B</span><span class="xfpl bl">C</span><span class="xfpl br">D</span><div class="xfdot" id="wb-xfdot"></div></div><div class="xfvols">${xv("C")}${xv("D")}</div></div>
    <small>✕ THE X FADER — slide toward a corner deck to give it the volume; the center is all even, and the master screen up top blends with it</small>
    <div style="display:flex;gap:8px;align-items:center;justify-content:center"><small id="wb-pan-read">A 100% · B 100% · C 100% · D 100%</small></div>
    <div class="xfcurve" role="group" aria-label="Crossfader curve"><span>CURVE</span><button type="button" class="wb-xfc" data-v="smooth">Smooth</button><button type="button" class="wb-xfc" data-v="sharp">Sharp</button><button type="button" class="wb-xfc" data-v="cut">Cut</button></div></div>
    ${deckC}${deckD}</div>
    <div class="dj-panel ws-ctl"><h4>🎛️ MASTER FX</h4><div class="fxgrid">
    ${wbFxCell("boost", "🔊 BOOST", 1, 2, 0.01)}
    ${wbFxCell("mf", "FILTER", 0, 100, 1)}
    ${wbFxCell("echo", "ECHO", 0, 0.6, 0.02)}
    ${wbFxCell("fb", "ECHO REPEAT", 0, 0.7, 0.02)}
    ${wbFxCell("verb", "REVERB", 0, 0.7, 0.02)}
    ${wbFxCell("fla", "FLANGER", 0, 1, 0.02)}
    ${wbFxCell("pha", "PHASER", 0, 1, 0.02)}
    ${wbFxCell("noise", "NOISE", 0, 1, 0.02)}
    ${wbFxCell("crush", "GRIT (CRUSH)", 0, 100, 1)}
    <div class="fxcell wide"><small>TRANSFORMER (CHOP)</small><div style="display:flex;gap:5px"><button class="btn ghost sm gatebtn wb-gate" type="button" data-v="0">OFF</button><button class="btn ghost sm gatebtn wb-gate" type="button" data-v="2">SLOW</button><button class="btn ghost sm gatebtn wb-gate" type="button" data-v="4">MED</button><button class="btn ghost sm gatebtn wb-gate" type="button" data-v="8">FAST</button></div></div>
    </div></div>
    </div>`;
}

/* ---------- the upsell (live wsEnsureModals, verbatim copy/prices) ---------- */
let wsUpsellAt = 0, wsTrialAt = 0, wsTrialChecked = false;
function wsEnsureModals() {
  if (!document.getElementById("ws-upsell")) {
    const u = document.createElement("div"); u.id = "ws-upsell"; u.className = "ws-modal"; u.hidden = true;
    u.innerHTML = `<div class="ws-card"><button type="button" class="btn ghost sm ws-x wsu-x" aria-label="Close">✕</button><h3 style="margin:0 0 8px">👀 You are watching Meechie's setup</h3><p style="margin:0 0 10px">This is Meechie's live DJ setup. You can watch everything he does on it — the controls answer to Meechie only.</p><p style="margin:0 0 14px">Want tables of your own? The <b>basic setup is FREE</b>, and the <b>full setup is free for 30 days</b>. After the trial, Basic is <b>$5/month</b>. Paid plans run <b>$20, $50, $100, $350 and $500</b> a month.</p><div style="display:flex;gap:8px;flex-wrap:wrap"><button type="button" class="btn wsu-free">Use the free basic setup</button><button type="button" class="btn ghost wsu-plans">See plans</button></div></div>`;
    document.body.appendChild(u);
  }
  if (!document.getElementById("ws-plans")) {
    const p = document.createElement("div"); p.id = "ws-plans"; p.className = "ws-modal"; p.hidden = true;
    p.innerHTML = `<div class="ws-card"><button type="button" class="btn ghost sm ws-x wpl-x" aria-label="Close">✕</button><h3 style="margin:0 0 6px">🎛️ Run your own setup</h3><p class="muted" style="margin:0 0 6px">Watching and listening to Meechie live is always free. Plans are only for running your own tables.</p><div class="wpl-row"><div class="wpl-nm"><b>Basic</b><span>The free basic setup — your own tables, any time</span></div><b class="wpl-pr">FREE</b></div><div class="wpl-row"><div class="wpl-nm"><b>Full setup — 30-day free trial</b><span>Free for 30 days. After the trial, Basic continues at $5/month</span></div><b class="wpl-pr">$0</b></div><div id="wpl-trial-note"></div><div style="display:flex;gap:8px;flex-wrap:wrap;margin:4px 0 6px"><button type="button" class="btn wpl-trial" id="wpl-trial">Start my 30-day free trial</button><button type="button" class="btn ghost wpl-free">Use the free basic setup</button></div><div class="wpl-row"><div class="wpl-nm"><b>Basic</b><span>After the free trial</span></div><b class="wpl-pr">$5/month</b></div><div class="wpl-row"><div class="wpl-nm"><b>Paid plan</b><span>For DJs who want more</span></div><b class="wpl-pr">$20/month</b></div><div class="wpl-row"><div class="wpl-nm"><b>Paid plan</b><span>For DJs who want more</span></div><b class="wpl-pr">$50/month</b></div><div class="wpl-row"><div class="wpl-nm"><b>Paid plan</b><span>For DJs who want more</span></div><b class="wpl-pr">$100/month</b></div><div class="wpl-row"><div class="wpl-nm"><b>Paid plan</b><span>For DJs who want more</span></div><b class="wpl-pr">$350/month</b></div><div class="wpl-row"><div class="wpl-nm"><b>Paid plan</b><span>For DJs who want more</span></div><b class="wpl-pr">$500/month</b></div></div>`;
    document.body.appendChild(p);
  }
}
function wsModal(id, show) { wsEnsureModals(); const m = document.getElementById(id); if (m) m.hidden = !show; if (show && id === "ws-plans") wsTrialPaint(); }
function wsUpsell() { const now = Date.now(); if (now - wsUpsellAt < 60000) return; wsUpsellAt = now; wsModal("ws-upsell", true); }
function wsGoBasic() { location.hash = "#dj"; }
function wsTrialPaint() {
  if (!wsTrialAt) return;
  const note = document.getElementById("wpl-trial-note"); const btn = document.getElementById("wpl-trial");
  if (btn) { btn.disabled = true; btn.textContent = "✅ Trial on"; }
  if (note) note.innerHTML = `<p style="margin:6px 0">✅ Your 30-day free trial is on — Basic continues at $5/month after. We will remind you before it ends.</p>`;
}
let modalWireCtx = null;
function wsWireModals(ctx) {
  modalWireCtx = ctx;
  if (document.body._wsWired) return;
  document.body._wsWired = true;
  document.addEventListener("click", (e) => {
    const t = e.target;
    if (!t || !t.closest) return;
    if (t.closest(".wsu-x")) { wsModal("ws-upsell", false); return; }
    if (t.closest(".wsu-plans")) { wsModal("ws-upsell", false); wsModal("ws-plans", true); wsPaintPlans(); return; }
    if (t.closest(".wsu-free")) { wsModal("ws-upsell", false); wsGoBasic(); return; }
    if (t.closest(".wpl-x")) { wsModal("ws-plans", false); return; }
    if (t.closest(".wpl-free")) { wsModal("ws-plans", false); wsGoBasic(); return; }
    if (t.closest(".wpl-trial")) { wsStartTrial(); return; }
  });
}
async function wsPaintPlans() {
  if (wsTrialChecked || !modalWireCtx) return;
  const u = modalWireCtx.session.user();
  const uid = u && u.id;
  if (!uid) return;
  wsTrialChecked = true;
  const data = await modalWireCtx.gateway.readDoc("members/" + uid).catch(() => null);
  if (data && data.trial_started_at) { wsTrialAt = +data.trial_started_at || 0; wsTrialPaint(); }
}
function wsStartTrial() {
  /* read path (Phase 2): an existing trial already paints as on via
     wsPaintPlans. Starting one stamps the member doc — a write, held
     for the commerce phase; the note slot says so plainly. */
  if (wsTrialAt) { wsTrialPaint(); return; }
  const note = document.getElementById("wpl-trial-note");
  const u = modalWireCtx && modalWireCtx.session.user();
  if (!u) { if (note) note.innerHTML = `<p style="margin:6px 0">Join free first — the trial rides on your free account.</p>`; return; }
  if (note) note.innerHTML = `<p style="margin:6px 0">Trials start on the main site while the new build is being tested — watching Meechie here stays free.</p>`;
}

/* ---------- the view ---------- */
let unsubs = [];
let engineRef = null, scrRef = null, paintIv = null, wbBuilt = false, wbQSsig = "", wbWaveSig = {};
function stSlate(S) {
  const rows = DECKS.filter((k) => S[k] && (S[k].title || S[k].yt)).map((k) => "DECK " + k + " — " + (S[k].title || "Music video") + (S[k].playing ? " ▶ PLAYING" : ""));
  return "🔴 MEECHIE IS LIVE ON THE TABLES\n" + (rows.length ? rows.join("\n") : "Setting up the decks…") + "\nThe video mix appears right here the moment a music video plays.";
}
export function render(root, ctx) {
  root.innerHTML = MARKUP;
  const engine = getEngine(ctx);
  engineRef = engine;
  const feed = engine.feed;
  mountMini(ctx);
  wsEnsureModals();
  wsWireModals(ctx);
  wbBuilt = false; wbQSsig = ""; wbWaveSig = {};
  const body = root.querySelector("#ws-body");
  wbBuild(body); wbBuilt = true;
  const scr = engine.createScreen({
    kind: "watch",
    stageEl: root.querySelector("#wb-stage"),
    slotEls: [root.querySelector("#wb-vs1"), root.querySelector("#wb-vs2")],
    standbyEl: root.querySelector("#wb-vstandby"),
    chipEl: root.querySelector("#wb-vchip"),
    posterEl: root.querySelector("#wb-vposter"),
  });
  scrRef = scr;
  root.querySelector("#wb-sound").addEventListener("click", () => { engine.toggleListening(); });
  root.addEventListener("click", (e) => { if (e.target.closest && e.target.closest(".ws-ctl")) wsUpsell(); });

  engine.addSurface("watch", async () => {
    /* the live watchApply: the spectator screen renders only while
       the view is open; the standby earns its words from state */
    const S = feed.S;
    if (!feed.seen) { const sb = root.querySelector("#wb-vstandby"); if (sb) sb.textContent = "TV: connecting…"; }
    else if (!vmixTargets(S).length && S.live) { const sb = root.querySelector("#wb-vstandby"); if (sb) sb.textContent = stSlate(S); }
    else if (!vmixTargets(S).length && !S.live && !(S.vstream || {}).on) { const sb = root.querySelector("#wb-vstandby"); if (sb) sb.textContent = "Meechie is off air — the radio is always on."; }
    await engine.renderSurface(scr);
    const lv = root.querySelector("#wb-stage video.vslive");
    if (lv && lv.paused && (lv.srcObject || lv.currentSrc)) { try { const p = lv.play(); if (p && p.catch) p.catch(() => {}); } catch (_) {} }
  });

  const paint = () => paintWatch(root, ctx, engine, feed);
  unsubs.push(feed.subscribe(paint));
  paintIv = setInterval(paint, 1000);
  paint();
}
export function destroy() {
  unsubs.forEach((u) => { try { u(); } catch (_) {} });
  unsubs = [];
  if (paintIv) { clearInterval(paintIv); paintIv = null; }
  if (engineRef) { engineRef.removeSurface("watch"); engineRef.destroyScreen(scrRef); }
  engineRef = null; scrRef = null;
  const u = document.getElementById("ws-upsell"); if (u) u.hidden = true;
  const p = document.getElementById("ws-plans"); if (p) p.hidden = true;
}

function wbWave(root, S, k) {
  const cv = root.querySelector("#wb-wv-" + k); if (!cv) return;
  const s = S[k] || {}; const dur = +s.dur || 0, pos = posOf(S, k, Date.now());
  const sig = (s.title || "") + "|" + Math.floor(pos * 4) + "|" + dur + "|" + (s.playing ? 1 : 0);
  if (wbWaveSig[k] === sig) return; wbWaveSig[k] = sig;
  const g = cv.getContext("2d"); if (!g) return;
  const W = cv.width, H = cv.height, frac = dur > 0 ? Math.max(0, Math.min(1, pos / dur)) : 0;
  const seed = k.charCodeAt(0) * 131 + (s.title || "").length * 17 + ((s.title || " ").charCodeAt(0) || 0);
  g.clearRect(0, 0, W, H);
  const n = 72, bw = W / n;
  for (let i = 0; i < n; i++) {
    const v = 0.25 + 0.75 * Math.abs(Math.sin(seed + i * 1.7) * Math.cos(seed * 0.3 + i * 0.53));
    const h = Math.max(2, v * (H - 10));
    g.fillStyle = i / n <= frac ? "#f7b928" : "rgba(230,220,195,.28)";
    g.fillRect(i * bw + 0.5, (H - h) / 2, Math.max(1, bw - 1.5), h);
  }
  if (dur > 0) { g.fillStyle = "#fff"; g.fillRect(Math.max(0, frac * W - 1), 0, 2, H); }
}

/* the live paintWatch, ported: values and formulas are the booth's own */
function paintWatch(root, ctx, engine, feed) {
  const body = root.querySelector("#ws-body"); if (!body) return;
  const S = feed.S;
  if (!wbBuilt || !root.querySelector("#wb-root")) { wbBuild(body); wbBuilt = true; }
  const live = stationLive(S);
  const lamp = root.querySelector("#wb-lamp");
  if (lamp) { lamp.classList.toggle("on", live); const lt = live ? "ON AIR" : "OFF AIR"; if (lamp.lastChild && lamp.lastChild.textContent !== lt) lamp.lastChild.textContent = lt; }
  const nowEl = root.querySelector("#wb-now");
  if (nowEl) {
    const tvLive = vsBroadcast(S) && !(S.vstream || {}).hidden;
    const playing = DECKS.filter((k) => S[k] && S[k].playing && S[k].title).map((k) => S[k].title);
    const gN = S.djGuest && S.djGuest.until > Date.now() ? gName(S.djGuest) : null;
    nowEl.textContent = tvLive && !playing.length && !gN ? "📺 Meechie is live on the master screen — the tables pick back up when the share ends." : live ? (playing.length ? "🎧 Live now: " + playing.join("  ×  ") : gN ? "🎧 " + gN + " is live on the decks." : "🎧 Meechie is live on the decks.") : "The station is on the playlist right now — the booth wakes up the moment Meechie goes live.";
  }
  const sb = root.querySelector("#wb-sound");
  if (sb) { const t = engine.listening ? "🔊 Sound on — tap to mute" : "🔇 Sound off — tap for sound"; if (sb.textContent !== t) sb.textContent = t; }
  DECKS.forEach((k) => {
    const s = S[k] || {};
    const ttl = root.querySelector("#wb-ttl-" + k);
    if (ttl) { const t = s.title || "Load a song"; if (ttl.textContent !== t) ttl.textContent = t; const card = ttl.closest(".deck"); if (card) card.classList.toggle("playing", !!s.playing); }
    const pl = root.querySelector("#wb-pl-" + k);
    if (pl) { pl.classList.toggle("spin", !!s.playing); pl.classList.toggle("has-cover", okUrl(s.cover)); if (okUrl(s.cover)) pl.style.setProperty("--cv", `url("${s.cover}")`); }
    const yt = root.querySelector("#wb-yt-" + k); if (yt) yt.hidden = !s.yt;
    const pb = root.querySelector("#wb-play-" + k); if (pb) { const t = s.playing ? "⏸ Pause" : "▶ Play"; if (pb.textContent !== t) pb.textContent = t; }
    const tm = root.querySelector("#wb-tm-" + k);
    if (tm) { const dur = +s.dur || 0, pos = posOf(S, k, Date.now()); tm.textContent = fmt(pos) + (dur ? " / " + fmt(dur) + " · −" + fmt(Math.max(0, dur - pos)) : ""); }
    const bp = root.querySelector("#wb-bpm-" + k); if (bp) { const t = s.bpm > 0 ? (+s.bpm).toFixed(1) + " BPM" : "BPM —"; if (bp.textContent !== t) bp.textContent = t; }
    const kv = root.querySelector("#wb-key-" + k); if (kv) { const t = s.cam ? s.cam + (s.key ? " · " + s.key : "") : ""; if (kv.textContent !== t) kv.textContent = t; }
    const dots = root.querySelector("#wb-dots-" + k);
    if (dots) { const on = s.playing && s.bpm > 0 ? Math.floor(posOf(S, k, Date.now()) / (60 / s.bpm)) % 4 : -1; const kids = dots.children; for (let i = 0; i < kids.length; i++) kids[i].classList.toggle("on", i === on); }
    const pit = root.querySelector("#wb-pit-" + k); if (pit) pit.value = s.rate || 1;
    const pv = root.querySelector("#wb-pitv-" + k); if (pv) pv.textContent = (((s.rate || 1) - 1) * 100).toFixed(1).replace("-", "−") + "%";
    const vol = root.querySelector("#wb-vol-" + k); if (vol) vol.value = s.vol ?? 0.9;
    const kn = root.querySelector("#wb-xv-" + k); if (kn) kn.style.setProperty("--rot", (-135 + ((s.vol || 0) / 2) * 270) + "deg");
    const xb = root.querySelector("#wb-xvb-" + k); if (xb) xb.textContent = Math.round((s.vol || 0) * 100) + "%";
    wbWave(root, S, k);
  });
  const dot = root.querySelector("#wb-xfdot");
  if (dot) { const xfv = S.panX == null ? 0.5 : S.panX; dot.style.left = (50 + (xfv - 0.5) * 84) + "%"; dot.style.top = (50 + (S.panY || 0) * 42) + "%"; }
  const rd = root.querySelector("#wb-pan-read");
  if (rd) { const py = S.panY || 0, ab = py > 0 ? 1 - py : 1, cd = py < 0 ? 1 + py : 1; const g = { A: xfGain(S.xf, "A", S.xfCurve) * ab * pairXGain(S.panX, false), B: xfGain(S.xf, "B", S.xfCurve) * ab * pairXGain(S.panX, false), C: xfGain(S.xf2 ?? 0.5, "A", S.xfCurve) * cd * pairXGain(S.panX, true), D: xfGain(S.xf2 ?? 0.5, "B", S.xfCurve) * cd * pairXGain(S.panX, true) }; const mx = Math.max(g.A, g.B, g.C, g.D, 0.0001); rd.textContent = ["A", "B", "C", "D"].map((k) => k + " " + Math.round(g[k] / mx * 100) + "%").join(" · "); }
  root.querySelectorAll(".wb-xfc").forEach((x) => x.classList.toggle("on", x.dataset.v === (S.xfCurve || "smooth")));
  const fx = S.fx || {};
  const fxSet = (id, v, lab) => { const el = root.querySelector("#wb-fx-" + id); if (el) el.value = v; const t = root.querySelector("#wb-fxv-" + id); if (t) t.textContent = lab; };
  fxSet("boost", fx.boost || 1, Math.round((fx.boost || 1) * 100) + "%");
  fxSet("mf", fx.mf == null ? 100 : fx.mf, Math.round(fx.mf == null ? 100 : fx.mf) + "%");
  fxSet("echo", fx.echo || 0, Math.round((fx.echo || 0) * 100) + "%");
  fxSet("fb", fx.fb == null ? 0.34 : fx.fb, Math.round((fx.fb == null ? 0.34 : fx.fb) * 100) + "%");
  fxSet("verb", fx.verb || 0, Math.round((fx.verb || 0) * 100) + "%");
  fxSet("fla", fx.fla || 0, Math.round((fx.fla || 0) * 100) + "%");
  fxSet("pha", fx.pha || 0, Math.round((fx.pha || 0) * 100) + "%");
  fxSet("noise", fx.noise || 0, Math.round((fx.noise || 0) * 100) + "%");
  fxSet("crush", fx.crush || 0, String(fx.crush || 0));
  root.querySelectorAll(".wb-gate").forEach((x) => x.classList.toggle("on", +x.dataset.v === (+fx.gate || 0)));
  const q = Array.isArray(S.queue) ? S.queue : [];
  const qsig = q.length + "|" + q.map((x) => ((x || {}).title || "")).join("~");
  if (qsig !== wbQSsig) { wbQSsig = qsig; const qEl = root.querySelector("#wb-queue"); if (qEl) qEl.innerHTML = q.length ? q.map((x, i) => `<div class="dj-item"><span>${i + 1}. ${(x || {}).yt ? "🎬 " : ""}${esc((x || {}).title || "Untitled")}</span></div>`).join("") : `<small class="muted">The queue is empty — Auto-DJ pulls from the full rotation.</small>`; }
}
