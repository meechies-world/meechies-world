/* ============================================================================
   v2 DJ VIEW — THE BOOTH (Rebuild Phase 4). The owner booth, the member
   station card, the granted-guest table and the SANDBOX playground, as
   one lazy module on the shell. It drives the SAME shared radio/dj doc
   through djstate.js (the typed write layer), plays through djdecks.js
   (the audio half), publishes through djshare.js, and paints its master
   screen through the Phase 2 engine — no duplicated machinery.

   The laws this file is built under (MAP Constitution):
   - Law 0 PARITY: the layout below is a DATA declaration of the live
     booth's arrangement. Deck order A B | X cluster | C D never
     changes; the TOP zone is fixed furniture in exactly his order;
     the BELOW-DECKS zone renders the shipped panel priority, every
     panel collapsible, draggable only when he unlocks (default
     LOCKED), Customize Reset restores the shipped order.
   - The booth FILLS the screen by scaling (boothFit zoom, floor 0.5),
     never scrolls itself, never grows its natural width; text ×1.25
     rides in css/dj.css exactly as the live booth ships it.
   - Law 7 (fader law): the X pad writes S.panX; deck knobs sweep to
     200%, YouTube decks cap at their own 100 + boost ≤ 1.5×; the
     crossfaders' home is CENTER and automated blends settle home.
   - Queue law: manual picks load STOPPED (gentle load — a YouTube
     pick on a silent deck does not even build its player until Play);
     the queue path auto-loads; draws shuffle with no repeats until
     empty; Play-the-queue stocks ALL FOUR decks; loading another deck
     never stops or lags the playing deck.
   - Automation: 5 s blend lead, preload in the final 15 s, HORNS OFF
     unless S.hornOn === true, AUTO-DJ switch at the TOP default ON,
     the position stall watchdog, and the 10 s dead-air rescue.
   - NO-SKIP and the two-station rules ride on the shared state; the
     master screen takes over the radio while a share is up.
   - Multi-screen: ONE leader drives (leadDrive); mirrors render live
     and any performance tap on a mirror takes control for real first.
   - SANDBOX (?playdj=1): the full booth, zero writes to radio/brain.
   - LAW 22 (scroll/touch never touches the music): this view installs
     NO wheel handlers and no scroll listeners; every booth surface
     carries touch-action:pan-y (css/dj.css ships the owner's rules),
     platter/X-pad/waveform drags engage only on deliberate horizontal
     movement and never preventDefault a vertical scroll.
   ============================================================================ */
import { DECKS, PAIR, fmt, esc, getFeed, posOf, vmixTargets } from "../station.js";
import {
  OWNER_ID, ROT, DROP_TEXTS, createBoothStore, mergeBooth, qKeyOf, stockValid,
  drawFromQueue, blendDue, preloadDue, dropDue, stallStep, daGate, isCorpse,
} from "../djstate.js";
import { createDeckEngine } from "../djdecks.js";
import { createSharePublisher } from "../djshare.js";
import { getEngine } from "../engine.js";
import { FREE_MEDIA } from "../djfree.js";

const SANDBOX = (() => { try { return new URLSearchParams(location.search).has("playdj") || (location.hash || "").includes("playdj"); } catch (_) { return false; } })();

/* ---------- LAYOUT AS DATA (Law 6) ----------
   top:    the fixed furniture, in his order, never rearranged.
   decks:  A B | X cluster | C D — the X cluster rides between B and C.
   panels: the below-decks shipped priority; the organize pass renders
           exactly this order unless he has dragged (while unlocked)
           a personal order, and Reset restores this. */
export const LAYOUT = {
  top: ["topbar", "setups", "screen", "edit", "browser"],
  decks: ["A", "B", "X", "C", "D"],
  panels: [
    ["door", "🚪 THE DOOR"], ["brain", "🧠 BRAIN"], ["reports", "📋 REPORTS"],
    ["livereq", "🎛️ LIVE DJ REQUESTS"], ["autodj", "🤖 AUTO-DJ"], ["mic", "🎤 LIVE MIC"],
    ["record", "⏺️ RECORD THE SHOW"], ["fx", "🎚️ MASTER FX"], ["vfx", "✨ VIDEO FX"],
    ["pads", "🔊 JINGLE / SPOT BOARD"], ["midi", "🎹 MIDI"], ["log", "📜 PROGRAM LOG"],
    ["reqdrops", "📥 REQUESTS & DROPS"], ["campro", "📷 CAMERA PRO"], ["battles", "⚔️ BATTLES"],
    ["afterhours", "🌙 AFTER HOURS"],
  ],
};
const PANEL_TITLES = Object.fromEntries(LAYOUT.panels.map(([id, t]) => [id, t]));

/* ---------- small helpers ---------- */
const $ = (root, s) => root.querySelector(s);
const $$ = (root, s) => Array.from(root.querySelectorAll(s));
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
let toastEl = null, toastT = null;
function say(msg) {
  if (!toastEl) { toastEl = document.createElement("div"); toastEl.className = "dj-say"; document.body.appendChild(toastEl); }
  toastEl.textContent = msg; toastEl.classList.add("on");
  clearTimeout(toastT); toastT = setTimeout(() => toastEl && toastEl.classList.remove("on"), 3600);
}
const ytIdOf = (tok) => { tok = String(tok || ""); if (tok.startsWith("dm:") || tok.startsWith("vm:")) return ""; return tok; };
const bareYt = (u) => { const m = String(u || "").match(/(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/shorts\/)([\w-]{6,})/); return m ? m[1] : (/^[\w-]{6,}$/.test(String(u || "").trim()) ? String(u).trim() : ""); };

/* age/embed lock list (live brain/ytblock): local set + server post on
   conviction; a locked id is never drawn, stocked or auto-loaded */
const ageSet = new Set();
try { (JSON.parse(localStorage.getItem("mw-ytblock") || "[]")).forEach((x) => ageSet.add(x)); } catch (_) {}
const ageIsLocked = (tok) => { const id = ytIdOf(tok); return !!id && ageSet.has(id); };
function ageMarkLocked(tok, session) {
  const id = ytIdOf(tok); if (!id || ageSet.has(id)) return;
  ageSet.add(id);
  try { localStorage.setItem("mw-ytblock", JSON.stringify(Array.from(ageSet).slice(-500))); } catch (_) {}
  const s = session && session.get && session.get();
  fetch("/api/brain/block", { method: "POST", headers: { "content-type": "application/json", ...(s && s.access_token ? { authorization: "Bearer " + s.access_token } : {}) }, body: JSON.stringify({ id }) }).catch(() => {});
}

/* ---------- deck markup (live deckHTML, verbatim structure) ---------- */
function deckHTML(k) {
  const secs = (() => { try { return Object.assign({ tempo: 1, cues: 0, sound: 1 }, JSON.parse(localStorage.getItem("mw-dsec-v1") || "{}")); } catch (_) { return { tempo: 1, cues: 0, sound: 1 }; } })();
  const sec = (id, title, body) => `<div class="dsec"><button type="button" class="dsec-h" data-dsec="${k}:${id}">${title}<span>${secs[id] ? "▾" : "▸"}</span></button><div class="dsec-b" ${secs[id] ? "" : "hidden"}>${body}</div></div>`;
  return `<div class="deck" data-deck="${k}">
  <h4>DECK ${k}</h4>
  <div class="decktop">
    ${SANDBOX ? "" : `<div class="dpads" id="dpads-${k}"></div>`}
    <div class="platter" id="pl-${k}"><div class="pl-dot"></div></div>
    <div class="drail">
      <button type="button" data-play="${k}">▶ Play</button>
      <button type="button" data-cue0="${k}">⏮ Cue</button>
      <button type="button" data-brake="${k}">🛑 Brake</button>
    </div>
  </div>
  <canvas class="wave" id="wv-${k}" width="520" height="84"></canvas>
  <div class="ytbox" id="ytw-${k}" hidden><div id="yt-${k}"></div></div>
  <div class="ttl" id="ttl-${k}"></div>
  <div class="tm" id="tm-${k}">0:00 / 0:00</div>
  <div class="beatbox"><span id="bpm-${k}"></span><span id="key-${k}"></span><span class="dots" id="dots-${k}"></span></div>
  ${sec("tempo", "⏱ TEMPO", `
    <button type="button" data-tap="${k}">TAP</button>
    <button type="button" data-bpmadj="${k}:-0.1">−0.1</button>
    <button type="button" data-bpmadj="${k}:0.1">+0.1</button>
    <button type="button" data-bpmx="${k}:2">×2</button>
    <button type="button" data-bpmx="${k}:0.5">÷2</button>
    <button type="button" data-nudge="${k}:-1">◀ Nudge</button>
    <button type="button" data-nudge="${k}:1">Nudge ▶</button>`)}
  ${sec("cues", "🎯 CUES & LOOPS", `
    ${[1, 2, 3].map((n) => `<button type="button" data-hot="${k}:${n}">Hot ${n}</button>`).join("")}
    <button type="button" data-loopb="${k}:4">Loop 4</button>
    <button type="button" data-loopb="${k}:8">Loop 8</button>
    <button type="button" data-sync="${k}">SYNC</button>
    <button type="button" data-roll="${k}:4">Roll 4</button>
    <button type="button" data-roll="${k}:8">Roll 8</button>
    <button type="button" data-bjump="${k}:-16">−16</button>
    <button type="button" data-bjump="${k}:-4">−4</button>
    <button type="button" data-bjump="${k}:4">+4</button>
    <button type="button" data-bjump="${k}:16">+16</button>`)}
  ${sec("sound", "🎚 SOUND", `
    <button type="button" data-vcut="${k}">Vocal cut</button>
    <button type="button" data-bcut="${k}">Bass cut</button>
    <button type="button" data-slip="${k}">Slip</button>
    <button type="button" data-spin="${k}">Spinback</button>
    <label class="dslider">Pitch <input type="range" min="0.92" max="1.08" step="0.001" value="1" data-pitch="${k}"><span id="pit-v-${k}">1.00×</span></label>
    <label class="dslider">Vinyl <input type="checkbox" data-vinyl="${k}"></label>
    <label class="dslider">EQ Lo <input type="range" min="-24" max="24" step="0.5" value="0" data-eq="${k}:lo"></label>
    <label class="dslider">EQ Mid <input type="range" min="-24" max="24" step="0.5" value="0" data-eq="${k}:mid"></label>
    <label class="dslider">EQ Hi <input type="range" min="-24" max="24" step="0.5" value="0" data-eq="${k}:hi"></label>
    <label class="dslider">Filter <input type="range" min="0" max="100" step="1" value="50" data-flt="${k}"></label>
    <label class="dslider">Volume <input type="range" min="0" max="2" step="0.01" value="0.9" data-vol="${k}"></label>`)}
  </div>`;
}

/* the X cluster: rendered in the top zone, MOVED into .dj-decks
   before deck C at build — exactly the live build's move */
function xfbarHTML() {
  return `<div id="dj-xfbar">
    <div class="xfvols"><span>VOL A</span><input type="range" class="xv" min="0" max="2" step="0.01" value="0.9" data-xvol="A"><span>VOL B</span><input type="range" class="xv" min="0" max="2" step="0.01" value="0.9" data-xvol="B"></div>
    <div class="xfpad big" id="dj-xfpad"><span class="xfc tl">A·B</span><span class="xfc tr">C·D</span><span class="xfc bl">◀ AB</span><span class="xfc br">CD ▶</span><div id="dj-xfdot"></div></div>
    <div class="xfvols"><span>VOL C</span><input type="range" class="xv" min="0" max="2" step="0.01" value="0.9" data-xvol="C"><span>VOL D</span><input type="range" class="xv" min="0" max="2" step="0.01" value="0.9" data-xvol="D"></div>
    <div id="dj-pan-read">X: CENTER</div>
    <button type="button" class="btn ghost sm" id="dj-pan-center">Center the X</button>
    <div class="xfcurve"><button type="button" data-xfc="smooth">Smooth</button><button type="button" data-xfc="sharp">Sharp</button><button type="button" data-xfc="cut">Cut</button></div>
  </div>`;
}

function panelHTML(id) {
  return `<section class="dj-panel" data-panel="${id}">
    <h3 class="dj-panel-h"><button type="button" class="org-grip" data-grip="${id}" title="Drag to rearrange (unlock first)">⠿</button>${PANEL_TITLES[id]}<button type="button" class="btn ghost sm org-fold" data-fold="${id}">▾</button></h3>
    <div class="dj-panel-b" data-panelbody="${id}"></div>
  </section>`;
}

/* ---------- the whole booth root (live structure) ---------- */
function boothMarkup(showBooth) {
  return `
  <div class="dj-banner">
    <b>🔴 LIVE DJ SET</b><span class="muted">The tables ARE the radio.</span>
    <button type="button" class="btn sm" id="bn-listen">▶ Listen</button>
    <button type="button" class="btn ghost sm" data-act="blackout">⬛ Blackout</button>
    <button type="button" class="btn ghost sm" data-act="bubble">🫧 Bubble</button>
    <button type="button" class="btn ghost sm" data-act="capture">🖥 Capture My Screen</button>
    <button type="button" class="btn ghost sm" data-act="hide" id="bn-hide" hidden>🙈 Hide Share</button>
  </div>
  <div class="station" id="dj-station">
    <div class="st-head"><span class="lamp" id="st-lamp">OFF AIR</span><b>MEECHIE'S WORLD RADIO</b><span class="muted" id="st-online"></span></div>
    <div class="st-ticker" id="st-ticker" hidden></div>
    <div class="st-now" id="st-now">Nothing on the tables yet.</div>
    <div class="muted" id="st-host"></div>
    <button type="button" class="btn ghost sm" id="st-watch" hidden>👀 Watch Meechie's setup — live, look only</button>
    <div id="st-battle"></div>
    <div id="st-show"></div>
    <div id="st-ytbox"><b style="font-size:12px;letter-spacing:.1em">📺 ON AIR — MUSIC VIDEO</b>
      <div class="vstage"><div class="vslot" id="st-vs1"></div><div class="vslot" id="st-vs2"></div>
      <div class="vstandby" id="st-vstandby" style="white-space:pre-line">The video mix lands here the moment a music video plays.</div>
      <div class="vposter" id="st-vposter"><img src="/img/radio-promo.jpg" alt="Meechie's World Radio" loading="lazy" decoding="async"></div>
      <div class="vchip" id="st-vchip" hidden></div></div>
    </div>
    <div><b style="font-size:13px;letter-spacing:.1em">RECENTLY PLAYED</b><div class="loglist" id="st-log" style="margin-top:6px"></div></div>
    <div id="st-guest"></div>
  </div>
  ${showBooth ? `
  <div class="dj" id="dj-owner">
    <div class="dj-top">
      <span class="lamp" id="dj-lamp">OFF AIR</span>
      <span id="dj-lead" class="muted"></span><span id="dj-online" class="muted"></span>
      <span id="dj-clock" class="muted"></span><span id="dj-showtime" class="muted"></span>
      <label class="dj-sw">🔴 GO LIVE <input type="checkbox" id="dj-golive"></label>
      <label class="dj-sw">🤖 AUTO-DJ <input type="checkbox" id="dj-ad-top" checked></label>
      <label class="dj-sw">📣 HORNS <input type="checkbox" id="dj-horn-top"></label>
      <button type="button" class="btn ghost sm" id="dj-reports-btn">📋 REPORTS <span id="dj-reports-badge" hidden></span></button>
      <button type="button" class="btn ghost sm" id="dj-takecontrol" hidden>🎛 TAKE CONTROL</button>
      <button type="button" class="btn ghost sm" data-act="blackout">⬛ Blackout</button>
      <button type="button" class="btn ghost sm" data-act="bubble">🫧 Bubble</button>
      <button type="button" class="btn ghost sm" data-act="capture">🖥 Capture My Screen</button>
      <button type="button" class="btn ghost sm" data-act="hide" id="dj-hide2" hidden>🙈 Hide Share</button>
      <button type="button" class="btn ghost sm" id="dj-customize-btn">🛠 Customize</button>
    </div>
    <div class="dj-rotate muted">↻ On a phone? Turn it sideways — the full console fits.</div>
    <div class="dj-setups"><b>SETUPS</b>
      <button type="button" class="btn ghost sm" data-pop="loud">🔊 Loud &amp; Clear</button>
      <button type="button" class="btn ghost sm" data-pop="radio">📻 Radio</button>
      <button type="button" class="btn ghost sm" data-pop="club">🎉 Club</button>
      <button type="button" class="btn ghost sm" data-pop="scratch">💿 Scratch</button>
      <button type="button" class="btn ghost sm" data-pop="chop">🔪 Chop</button>
    </div>
    <div id="dj-screen">
      <div class="vstage" id="dj-vstage"><div class="vslot" id="dj-vs1"></div><div class="vslot" id="dj-vs2"></div>
        <div class="vstandby" id="dj-vstandby">Master screen — the video mix, your camera, or your shared screen lands here.</div>
        <div class="vposter" id="dj-vposter"><img src="/img/tv-poster.jpg" alt="Meechie's World TV" loading="lazy" decoding="async"></div>
        <div class="vchip" id="dj-vchip" hidden></div>
        <div id="dj-camwrap" hidden><video id="dj-camvid" autoplay muted playsinline></video><div id="dj-camph">Camera off</div><div id="dj-camtag">📷 CAM</div><div id="dj-cambanner" hidden></div></div>
      </div>
      <div id="dj-vskiprow"><span class="muted" id="dj-vstatus"></span><button type="button" class="btn ghost sm" id="dj-vskip" hidden>⏭ Skip video</button></div>
      <div class="vmixrow">
        <button type="button" class="btn ghost sm" data-vmix="auto">Auto mix</button>
        <button type="button" class="btn ghost sm" data-vmix="cut">Cut</button>
        <button type="button" class="btn ghost sm" data-vmix="fade">Fade</button>
        <button type="button" class="btn ghost sm" id="dj-cambtn">📷 Camera</button>
        <button type="button" class="btn ghost sm" id="dj-vlivebtn">📹 Live Video</button>
        ${DECKS.map((k) => `<button type="button" class="btn ghost sm" data-vsrc="${k}">Deck ${k}</button>`).join("")}
      </div>
    </div>
    <div id="dj-edit"><b>🎬 VIDEO &amp; AUDIO EDITING</b><div class="dj-edit-grid" id="dj-edit-grid"></div></div>
    ${xfbarHTML()}
    <div id="dj-phset"></div>
    <div class="dj-decks">
      ${deckHTML("A")}${deckHTML("B")}
      <div class="mixer m1">
        <button type="button" class="talk" id="dj-talk">🎤 TALK</button>
        <div class="mix-sec"><b>BEAT ENGINE</b>
          <label class="dj-sw">Quantize <input type="checkbox" id="dj-quant" checked></label>
          <label class="dj-sw">Jog FX <input type="checkbox" id="dj-jogf"></label>
          <label class="dj-sw">FX Sync <input type="checkbox" id="dj-fxsync" checked></label>
          <div class="pairwave"><canvas id="pw-AB" width="260" height="40"></canvas><div id="ph-AB"></div></div>
        </div>
        <div class="mix-sec"><b>MASTER</b>
          <label class="dslider">Master <input type="range" id="dj-master" min="0" max="1.5" step="0.01" value="0.95"></label>
          <label class="dslider">Boost <input type="range" id="dj-boost" min="1" max="2" step="0.01" value="1"><span id="dj-boost-v">1.00×</span></label>
          <label class="dslider">Filter <input type="range" id="dj-filter" min="0" max="100" step="1" value="100"></label>
          <label class="dslider">Echo <input type="range" id="dj-echo" min="0" max="1" step="0.01" value="0"></label>
          <label class="dslider">Echo Repeat <input type="range" id="dj-fb" min="0" max="0.9" step="0.01" value="0.34"></label>
          <div class="edivrow">${[0.25, 0.5, 0.75, 1, 1.5].map((v) => `<button type="button" class="btn ghost sm" data-ediv="${v}">${v} beat</button>`).join("")}</div>
          <label class="dslider">Reverb <input type="range" id="dj-verb" min="0" max="1" step="0.01" value="0"></label>
          <label class="dslider">Flanger <input type="range" id="dj-fla" min="0" max="1" step="0.01" value="0"></label>
          <label class="dslider">Phaser <input type="range" id="dj-pha" min="0" max="1" step="0.01" value="0"></label>
          <label class="dslider">Noise <input type="range" id="dj-noise" min="0" max="1" step="0.01" value="0"></label>
          <div class="gaterow">${[0, 2, 4, 8, 16].map((v) => `<button type="button" class="btn ghost sm" data-gate="${v}">${v === 0 ? "Gate off" : "Gate " + v}</button>`).join("")}</div>
        </div>
      </div>
      <div class="mixer m2"><div class="pairwave"><canvas id="pw-CD" width="260" height="40"></canvas><div id="ph-CD"></div></div>
        <label class="dslider">Crush <input type="range" id="dj-crush" min="0" max="100" step="1" value="0"></label>
      </div>
      <div class="swapbar"><button type="button" class="btn ghost sm" data-swap="1:C">⇄ C</button><button type="button" class="btn ghost sm" data-swap="1:M">⇄ M</button><button type="button" class="btn ghost sm" data-swap="1:D">⇄ D</button></div>
      ${deckHTML("C")}${deckHTML("D")}
    </div>
    <div id="dj-browser">
      <div class="browbox"><h3>🎬 VIDEO SEARCH</h3><div class="browbody" data-foldbody="yt-body">
        <form id="dj-ytform"><input id="dj-ytq" type="search" placeholder="Search YouTube — results are pre-checked playable"><button class="btn sm" type="submit">Search</button></form>
        <div class="ytload"><input id="dj-yt" type="url" placeholder="Paste a YouTube link">${DECKS.map((k) => `<button type="button" class="btn ghost sm" data-ytload="${k}">${k}</button>`).join("")}<button type="button" class="btn ghost sm" data-ytqueue="1">＋Q</button></div>
        <div class="vtabrow"><button type="button" class="btn ghost sm" data-vtab="yt">YouTube</button><button type="button" class="btn ghost sm" data-vtab="ia">Archive</button></div>
        <div class="dj-list" id="dj-ytres"></div>
      </div></div>
      <div class="browbox"><h3>⏭ UP NEXT — THE QUEUE</h3><div class="browbody" data-foldbody="queue-body">
        <div class="dj-list" id="dj-queue"></div>
        <div class="qrow"><button type="button" class="btn sm" data-qact="play">▶ Play the queue</button><button type="button" class="btn ghost sm" data-qact="save">💾 Save as playlist</button><button type="button" class="btn ghost sm" data-qact="open">📂 Playlists</button><button type="button" class="btn ghost sm" data-qact="clear">Clear</button></div>
        <div class="dj-list" id="dj-playlists" hidden></div>
      </div></div>
      <div class="browbox"><h3>🗓 SCHEDULE</h3><div class="browbody" data-foldbody="sched-body">
        <div class="dj-list" id="dj-sched-list"></div>
        <div class="qrow"><input type="time" id="sched-time"><select id="sched-sel"></select><button type="button" class="btn ghost sm" data-sched="add">＋ Add</button></div>
      </div></div>
      <div class="browbox"><h3>🎵 MUSIC</h3><div class="browbody" data-foldbody="music-body">
        <div class="browtabs">${[["lib", "Library"], ["net", "Net"], ["cur", "On decks"], ["prep", "Prep"], ["free", "Free shelf"]].map(([t, n]) => `<button type="button" class="btn ghost sm" data-browtab="${t}">${n}</button>`).join("")}</div>
        <div data-browpane="lib"><form id="dj-libform"><input id="dj-libq" type="search" placeholder="Search the library"><button class="btn sm" type="submit">Go</button></form><div class="dj-list" id="dj-lib"></div></div>
        <div data-browpane="net" hidden><form id="dj-sf"><input id="dj-q" type="search" placeholder="Search the Internet Archive"><button class="btn sm" type="submit">Go</button></form><div class="dj-list" id="dj-net"></div></div>
        <div data-browpane="cur" hidden><div class="dj-list" id="dj-cur"></div></div>
        <div data-browpane="prep" hidden><div class="dj-list" id="dj-prep"></div><div class="dj-list" id="dj-hist"></div></div>
        <div data-browpane="free" hidden><b>🎵 FREE MUSIC</b><div class="dj-list" id="dj-freem"></div><b>🎬 FREE VIDEOS</b><div class="dj-list" id="dj-freev"></div></div>
      </div></div>
    </div>
    <div class="dj-grid2" id="dj-grid2"></div>
    <div id="dj-customize" hidden></div>
  </div>` : ""}`;
}

/* ============================================================================
   MODULE STATE + RENDER
   ============================================================================ */
let R = null; // the live mount record; null when destroyed
const blankDeckRec = () => ({ src: "", yt: "", title: "", cover: "", start: 0, pos: 0, playing: false, vol: 0.9, rate: 1, dur: 0, bpm: 0, beat0: 0, key: "", cam: "", vcut: false, bcut: false, loop: null, loopBeats: 0, cues: null });

export function render(root, ctx) {
  const user = ctx.session.user && ctx.session.user();
  const ownerSeat = SANDBOX || (!!user && user.id === OWNER_ID);
  root.innerHTML = boothMarkup(ownerSeat);
  const feed = getFeed(ctx);
  const store = createBoothStore(ctx, { sandbox: SANDBOX, say, onDeckEnded: (k) => deckEnded(k) });
  const m = {
    root, ctx, feed, store, ownerSeat,
    S: () => store.S,
    decksEng: null, share: null, scr: null,
    unsubs: [], timers: [],
    handoverBusy: false, handoverAt: 0, preLoad: null, lastEndedK: "A",
    wd: {}, daSt: null, xfAnim: null, xfTouchedAt: 0, hornHeard: 0,
    reqCache: [], net: [], libItems: null, camStream: null, camOn: false,
    micStream: null, micHot: 0, rec: null, sesRec: null,
    startedAt: Date.now(), paintSig: "",
  };
  R = m;
  // the deck engine (audio half) — created now, woken on first gesture
  m.decksEng = createDeckEngine(() => store.S, {
    onEnded: (k) => deckEnded(k),
    onLocked: (k, vid) => { ageMarkLocked(vid, ctx.session); },
    onTitle: (k, t, dur) => { const s = store.S[k]; if (s && dur > 0 && (!s.dur || Math.abs(s.dur - dur) > 2)) { s.dur = dur; store.save(); } },
    isListenerSeat: () => false,
  });
  for (const k of DECKS) { const d = m.decksEng.decks[k]; d.onEnded = (kk) => deckEnded(kk); }
  // share publisher (owner seat only; the sandbox never publishes)
  if (ownerSeat && !SANDBOX) {
    m.share = createSharePublisher(ctx, store, {
      say,
      togglePlay: (k) => togglePlay(k),
      onPaint: () => paintShareBtns(),
      getCamTrack: () => (m.camStream && m.camStream.getVideoTracks()[0]) || null,
    });
  }
  // the booth master screen rides the Phase 2 engine like every stage
  const eng = getEngine(ctx);
  m.eng = eng;
  m.scr = eng.createScreen({
    kind: "stage",
    stageEl: root.querySelector("#dj-vstage") || root.querySelector("#st-ytbox .vstage"),
    slotEls: [root.querySelector("#dj-vs1") || root.querySelector("#st-vs1"), root.querySelector("#dj-vs2") || root.querySelector("#st-vs2")],
    standbyEl: root.querySelector("#dj-vstandby") || root.querySelector("#st-vstandby"),
    chipEl: root.querySelector("#dj-vchip") || root.querySelector("#st-vchip"),
    posterEl: root.querySelector("#dj-vposter") || root.querySelector("#st-vposter"),
  });
  eng.addSurface("djstage", async () => {
    if (!R) return;
    const S = store.S;
    if (m.share && m.share.active && m.share.localStream) { paintLocalShare(); return; }
    const has = vmixTargets(S).length > 0 || !!((S.vstream || {}).on && (S.vstream || {}).meeting);
    if (has) await eng.renderSurface(m.scr);
    else await eng.renderScreen(m.scr, true, 1, 1);
  });
  // state feed: adopt remote truth under the store's echo rules, repaint
  m.unsubs.push(feed.subscribe(() => {
    store.adopt(feed.S);
    paintStation(); paintOwner(); paintQueue(); paintBattle(); paintDoor(); paintBrainAi();
  }));
  store.startHeartbeat(() => !!root.querySelector("#dj-owner") && document.visibilityState === "visible");
  buildPanels(root);
  wireEvents(root);
  paintStation(); paintOwner(); paintQueue(); paintShareBtns();
  // the 500 ms booth tick + the 1 s dead-air rescue (its own interval, live rule)
  m.timers.push(setInterval(() => { try { boothTick(); } catch (_) {} }, 500));
  m.timers.push(setInterval(() => { try { daRescueTick(); } catch (_) {} }, 1000));
  m.timers.push(setInterval(() => { try { reportsBtnTick(); } catch (_) {} }, 60000));
  reportsBtnTick();
  loadRequests();
  if (ownerSeat) loadBrainPanel();
  boothFit();
}

export function destroy() {
  if (!R) return;
  const m = R; R = null;
  m.unsubs.forEach((u) => { try { u(); } catch (_) {} });
  m.timers.forEach((t) => clearInterval(t));
  try { m.store.destroy(); } catch (_) {}
  try { m.share && m.share.destroy(); } catch (_) {}
  try { m.eng && m.eng.removeSurface("djstage"); m.eng && m.eng.destroyScreen(m.scr); } catch (_) {}
  try { m.camStream && m.camStream.getTracks().forEach((t) => t.stop()); } catch (_) {}
  try { m.micStream && m.micStream.getTracks().forEach((t) => t.stop()); } catch (_) {}
  if (toastEl) { toastEl.classList.remove("on"); }
}

/* ---------- painters ---------- */
function paintStation() {
  if (!R) return;
  const root = R.root, S = R.S();
  const lamp = $(root, "#st-lamp");
  if (lamp) { const live = !!S.live || !!((S.vstream || {}).on && !(S.vstream || {}).hidden); lamp.textContent = live ? "🔴 ON AIR" : "OFF AIR"; lamp.classList.toggle("on", live); }
  const now = $(root, "#st-now");
  if (now) {
    const playing = DECKS.filter((k) => S[k].playing && (S[k].title || S[k].yt));
    now.textContent = playing.length ? "🎵 " + playing.map((k) => S[k].title || "Music video").join("  ·  ") : (S.live ? "Live on the tables — picking the next one…" : "Nothing on the tables yet.");
  }
  const tk = $(root, "#st-ticker");
  if (tk) { tk.hidden = !S.ticker; tk.textContent = S.ticker || ""; }
  const on = $(root, "#st-online");
  const pres = R.ctx.presence && R.ctx.presence.last;
  if (on && pres && typeof pres.online === "number") on.textContent = pres.online + " on the site";
  const lg = $(root, "#st-log");
  if (lg) {
    const log = (S.log || []).slice(0, 8);
    lg.innerHTML = log.length ? log.map((e) => `<div class="dj-item"><span>${esc(e.title || "")}</span><small class="muted">${e.at ? new Date(e.at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) : ""}</small></div>`).join("") : '<small class="muted">Nothing yet.</small>';
  }
  paintGuestPanel();
}
function paintGuestPanel() {
  if (!R || R.ownerSeat) return;
  const box = $(R.root, "#st-guest"); if (!box) return;
  const S = R.S(), user = R.ctx.session.user && R.ctx.session.user();
  const g = S.djGuest || {};
  const mine = user && g.uid === user.id && (g.until || 0) > Date.now();
  if (mine) {
    box.innerHTML = `<div class="ws-card"><p>✅ <b>Meechie put you on!</b> Your live slot runs until ${new Date(g.until).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}. Open your table and flip GO LIVE — the whole station hears your mix.</p><a class="btn" href="?playdj=1#dj">🎛 Open your table</a> <button type="button" class="btn ghost" id="guest-golive">${typeof sessionStorage !== "undefined" && sessionStorage.getItem("mw-guestlive") === "1" ? "⏹ Stop — take me off the radio" : "🔴 GO LIVE on the radio"}</button></div>`;
    const b = $(box, "#guest-golive");
    if (b) b.addEventListener("click", () => {
      try { if (sessionStorage.getItem("mw-guestlive") === "1") sessionStorage.removeItem("mw-guestlive"); else sessionStorage.setItem("mw-guestlive", "1"); } catch (_) {}
      paintGuestPanel();
    });
    return;
  }
  box.innerHTML = `<div class="ws-card"><p>🎛 <b>Want a live slot?</b> Ask Meechie for the decks — if he puts you on, your table drives the radio for your slot.</p><button type="button" class="btn ghost" id="guest-ask">Ask for a live slot</button></div>`;
  const b = $(box, "#guest-ask");
  if (b) b.addEventListener("click", async () => {
    if (!user) { say("Join free first — then ask for a slot."); return; }
    try {
      await R.ctx.gateway.call("rest", { table: "docs", op: "insert", values: { path: "requests/" + Math.random().toString(36).slice(2, 12), coll: "requests", owner: user.id, data: { kind: "djlive", uid: user.id, name: user.name || "", at: Date.now() } } });
      say("🎛 Asked — Meechie sees it in his LIVE DJ REQUESTS panel.");
    } catch (_) { say("That ask didn't go through — try again in a moment."); }
  });
}
function paintShareBtns() {
  if (!R) return;
  const S = R.S(), vs = S.vstream || {};
  const show = !!vs.on;
  ["#bn-hide", "#dj-hide2"].forEach((s) => { const b = $(R.root, s); if (b) { b.hidden = !show; b.textContent = vs.hidden ? "👁 Unhide Share" : "🙈 Hide Share"; } });
  const st = $(R.root, "#dj-vstatus");
  if (st) st.textContent = vs.on ? (vs.hidden ? "Share is HIDDEN — viewers see the mix" : "🔴 Master screen is LIVE for everyone") : "";
}
function paintLocalShare() {
  if (!R || !R.share) return;
  const stage = $(R.root, "#dj-vstage"); if (!stage) return;
  let v = stage.querySelector("video.vslive");
  if (!v) { v = document.createElement("video"); v.className = "vslive"; v.autoplay = true; v.muted = true; v.playsInline = true; stage.appendChild(v); }
  if (v.srcObject !== R.share.localStream) { v.srcObject = R.share.localStream; v.play().catch(() => {}); }
  stage.classList.add("vs-on");
}
function paintOwner() {
  if (!R || !R.ownerSeat) return;
  const root = R.root, S = R.S(), store = R.store;
  const lamp = $(root, "#dj-lamp");
  if (lamp) { lamp.textContent = S.live ? "🔴 ON AIR" : "OFF AIR"; lamp.classList.toggle("on", !!S.live); }
  const gl = $(root, "#dj-golive"); if (gl && document.activeElement !== gl) gl.checked = !!S.live;
  const ad = $(root, "#dj-ad-top"); if (ad && document.activeElement !== ad) ad.checked = S.autodj !== false;
  const hn = $(root, "#dj-horn-top"); if (hn && document.activeElement !== hn) hn.checked = S.hornOn === true;
  const lead = $(root, "#dj-lead");
  if (lead) lead.textContent = SANDBOX ? "🧸 PLAYGROUND — nothing here touches the real station" : (store.serverMirror() ? "🪞 Mirror — another screen is driving" : (store.leadDrive() ? "🎛 This screen is driving" : ""));
  const tc = $(root, "#dj-takecontrol"); if (tc) tc.hidden = !store.serverMirror();
  for (const k of DECKS) {
    const s = S[k], d = R.decksEng.decks[k];
    const ttl = $(root, "#ttl-" + k); if (ttl) ttl.textContent = s.title || (s.yt ? "Music video" : s.src ? "Audio file" : "— empty —");
    const deck = $(root, `.deck[data-deck="${k}"]`); if (deck) deck.classList.toggle("playing", !!s.playing);
    const ytw = $(root, "#ytw-" + k); if (ytw) ytw.hidden = !s.yt;
    const vol = $(root, `[data-vol="${k}"]`); if (vol && document.activeElement !== vol) vol.value = s.vol == null ? 0.9 : s.vol;
    if (d) d.applyDeckFx(s);
  }
  paintXfPads();
  // master FX sliders follow S unless he is holding them
  const fx = S.fx || {};
  const sync = (sel, v) => { const el = $(root, sel); if (el && document.activeElement !== el && v != null) el.value = v; };
  sync("#dj-boost", fx.boost); sync("#dj-filter", fx.mf); sync("#dj-echo", fx.echo); sync("#dj-fb", fx.fb);
  sync("#dj-verb", fx.verb); sync("#dj-fla", fx.fla); sync("#dj-pha", fx.pha); sync("#dj-noise", fx.noise); sync("#dj-crush", fx.crush);
  const bv = $(root, "#dj-boost-v"); if (bv) bv.textContent = (fx.boost || 1).toFixed(2) + "×";
  paintShareBtns();
}
function paintXfPads() {
  if (!R) return;
  const S = R.S(), dot = $(R.root, "#dj-xfdot");
  if (dot) { dot.style.left = ((S.panX == null ? 0.5 : S.panX) * 100) + "%"; dot.style.top = "50%"; }
  const rd = $(R.root, "#dj-pan-read");
  if (rd) { const p = S.panX == null ? 0.5 : S.panX; rd.textContent = "X: " + (Math.abs(p - 0.5) < 0.02 ? "CENTER" : p < 0.5 ? "A·B " + Math.round((0.5 - p) * 200) + "%" : "C·D " + Math.round((p - 0.5) * 200) + "%"); }
}
function paintQueue() {
  if (!R || !R.ownerSeat) return;
  const box = $(R.root, "#dj-queue"); if (!box) return;
  const q = R.store.queue;
  box.innerHTML = q.length ? q.map((it, i) => `<div class="dj-item"><span title="${esc(it.title || "")}">${i + 1}. ${esc(it.title || "Untitled")}</span><button type="button" class="btn ghost sm" data-qup="${i}">▲</button><button type="button" class="btn ghost sm" data-qdn="${i}">▼</button><button type="button" class="btn ghost sm" data-qx="${i}">✕</button></div>`).join("") : '<small class="muted">Queue is empty — add from search, the library, or Play the queue stocks the decks from the pool.</small>';
  const adq = $(R.root, "#ad-queue"); if (adq) adq.textContent = q.length + " in the queue";
  const sel = $(R.root, "#sched-sel");
  if (sel && !sel.options.length) sel.innerHTML = q.map((it, i) => `<option value="${i}">${esc(it.title || "Untitled")}</option>`).join("");
  const sl = $(R.root, "#dj-sched-list");
  if (sl) { const sq = R.S().schedQ || []; sl.innerHTML = sq.length ? sq.map((e, i) => `<div class="dj-item"><span>${esc(e.time || "")} — ${esc(e.title || "")}</span><button type="button" class="btn ghost sm" data-schedx="${i}">✕</button></div>`).join("") : '<small class="muted">Nothing scheduled.</small>'; }
}

/* ============================================================================
   TRANSPORT + QUEUE + AUTOMATION (live discipline, ported)
   ============================================================================ */
const brainPlay = (k) => { if (!R) return; const s = R.S()[k]; R.store.brainEmit({ type: "play", deck: k, yt: s.yt || "", src: s.src || "", title: s.title || "", at: Date.now() }); };
const brainClose = (k, why) => { if (!R) return; const s = R.S()[k]; if (s && (s.yt || s.src)) R.store.brainEmit({ type: why === "load" ? "skip" : "end", deck: k, yt: s.yt || "", src: s.src || "", title: s.title || "", at: Date.now() }); };
const brainDraw = (it) => { if (!R || !it) return; R.store.brainEmit({ type: "draw", yt: it.yt || "", src: it.src || "", title: it.title || "", at: Date.now() }); };
function logPlay(k) {
  const S = R.S(), s = S[k];
  S.log = [{ title: s.title || "Music video", yt: s.yt || "", src: s.src || "", at: Date.now() }].concat(S.log || []).slice(0, 40);
}
function histPush(item) {
  try { const h = JSON.parse(localStorage.getItem("mw-dj-hist") || "[]"); h.unshift({ title: item.title || "", src: item.src || "", yt: item.yt || "", at: Date.now() }); localStorage.setItem("mw-dj-hist", JSON.stringify(h.slice(0, 30))); } catch (_) {}
}
const qSet = (k, it) => { if (!R) return; R.S().qStock[k] = { src: it.src || "", yt: it.yt || "", title: it.title || "", at: Date.now() }; };
const qClear = (k) => { if (!R) return; if (R.S().qStock) delete R.S().qStock[k]; };

async function load(k, item, opts) {
  if (!R) return;
  opts = opts || {};
  const store = R.store, S = store.S, d = R.decksEng.decks[k];
  qClear(k); brainClose(k, "load");
  const wasSounding = !!(d.el && !d.el.paused && !d.el.ended) || !!S[k].playing;
  if (!store.leadDrive() && !SANDBOX) {
    // mirror window: write the shared deck record only — the sound
    // window picks it up; this screen never builds a player for it
    S[k] = Object.assign(blankDeckRec(), S[k], { src: item.src || "", yt: item.yt || "", title: item.title || "", cover: item.cover || "", dur: item.dur || 0, playing: false, pos: 0 });
    say("📀 Loaded on deck " + k + " — the screen driving the sound has it.");
    paintOwner(); store.save(true); return;
  }
  const keep = { vol: S[k].vol, rate: S[k].rate };
  S[k] = Object.assign(blankDeckRec(), keep, { src: item.src || "", yt: item.yt || "", title: item.title || "", cover: item.cover || "", dur: item.dur || 0, bpm: item.bpm || 0, key: item.key || "" });
  histPush(item);
  if (item.yt) {
    if (ageIsLocked(item.yt)) { say("🔞 That video is on the age/embed block list — it can never play on the station."); S[k] = Object.assign(blankDeckRec(), keep); paintOwner(); store.save(true); return; }
    // GENTLE LOAD: a manual pick on a silent deck does not build the
    // player at click — it builds at Play, so the playing deck never lags.
    // Automation mounts explicitly (opts.mount): preloads and stocking
    // need the player ready before the blend, not at it.
    if (opts.cue && !wasSounding && !opts.mount) { d.clearYt(); paintOwner(); R.decksEng.levels(); store.save(true); return; }
    const shim = await d.setYt(item.yt, $(R.root, "#yt-" + k));
    if (!shim) { say("That video would not load here — try another."); S[k] = Object.assign(blankDeckRec(), keep); paintOwner(); store.save(true); return; }
    if (shim._locked) { ageMarkLocked(item.yt, R.ctx.session); say("🔞 That video is age- or embed-locked — noted, and it won't be picked again."); S[k] = Object.assign(blankDeckRec(), keep); paintOwner(); store.save(true); return; }
    if (opts.cue) { const pauseAt = () => { try { d.el.pause(); } catch (_) {} }; pauseAt(); setTimeout(pauseAt, 350); setTimeout(pauseAt, 900); }
  } else if (item.src) {
    d.clearYt();
    try { d.set(item.src); } catch (_) { say("That file would not load — try another."); S[k] = Object.assign(blankDeckRec(), keep); paintOwner(); store.save(true); return; }
  }
  paintOwner(); R.decksEng.levels(); store.save(true);
}

async function togglePlay(k) {
  if (!R) return;
  const store = R.store, S = store.S, s = S[k], d = R.decksEng.decks[k];
  if (!store.leadDrive() && !SANDBOX) {
    // mirror: flip the shared state only — the driver performs it
    if (s.playing) { s.pos = posOf(S, k, Date.now()); s.playing = false; if (S.live && !DECKS.some((x) => S[x].playing)) S.pausedAt = Date.now(); }
    else {
      s.start = Date.now() - (s.pos || 0) * 1000; s.playing = true; S.pausedAt = 0;
      if (!S.live) { S.live = true; S.liveSince = Date.now(); }
      logPlay(k);
    }
    paintOwner(); store.save(true); return;
  }
  if (s.playing) {
    try { d.el.pause(); } catch (_) {}
    s.pos = d.el && d.el.currentTime ? d.el.currentTime : posOf(S, k, Date.now());
    s.playing = false;
    if (S.live && !DECKS.some((x) => S[x].playing)) S.pausedAt = Date.now(); // deliberate pause, respected 30 min
  } else {
    if (s.yt) {
      if (!d.shim) {
        const shim = await d.setYt(s.yt, $(R.root, "#yt-" + k));
        if (!shim || shim._locked) { if (shim && shim._locked) ageMarkLocked(s.yt, R.ctx.session); say("⏭ That one would not play — rolling the next."); return; }
      }
    } else if (s.src) {
      if (!d.shim && d.el && d.el.src !== s.src) d.set(s.src);
    } else { say("Deck " + k + " is empty — load something first."); return; }
    try {
      if (d.el && typeof d.el.currentTime === "number" && Math.abs(d.el.currentTime - (s.pos || 0)) > 0.4) d.el.seekTo ? d.el.seekTo(s.pos || 0) : (d.el.currentTime = s.pos || 0);
      if (!d.shim && d.el) { d.el.playbackRate = s.rate || 1; d.el.preservesPitch = !s.vinyl; }
      await d.el.play();
    } catch (_) {}
    s.start = Date.now() - (s.pos || 0) * 1000;
    s.playing = true; S.pausedAt = 0;
    if (!S.live) { S.live = true; S.liveSince = Date.now(); say("🔴 You're LIVE — the tables are the radio."); }
    logPlay(k); brainPlay(k);
  }
  paintOwner(); R.decksEng.levels(); store.save(true);
}

function deckEnded(k) {
  if (!R || !R.ownerSeat) return;
  const store = R.store, S = store.S;
  if (!S[k].playing) return;
  brainClose(k, "ended"); // BEFORE the wipe — the brain needs the record
  S[k].playing = false; S[k].pos = 0; R.lastEndedK = k;
  paintOwner(); store.save(true);
  const otherPlaying = DECKS.some((x) => x !== k && S[x].playing && !isCorpse(S, x, Date.now()));
  if (S.live && (S.autodj || store.queue.length) && !otherPlaying && store.leadDrive()) autoNext(k, true);
}

/* ---- picks: listener picks → his queue → (Auto-DJ) pool / library ---- */
async function iaSearch(q) {
  const query = `(${q}) AND mediatype:audio AND licenseurl:*creativecommons*`;
  const u = "https://archive.org/advancedsearch.php?q=" + encodeURIComponent(query) + "&fl[]=identifier&fl[]=title&fl[]=creator&sort[]=downloads+desc&rows=25&output=json";
  const r = await fetch(u); const j = await r.json();
  return (j.response && j.response.docs || []).map((d) => ({ id: String(d.identifier), title: [].concat(d.title || d.identifier)[0] + (d.creator ? " · " + [].concat(d.creator)[0] : "") }));
}
async function iaFile(id) {
  try {
    const j = await (await fetch("https://archive.org/metadata/" + encodeURIComponent(id))).json();
    const f = (j.files || []).find((x) => /mp3/i.test(x.format || "") && /\.mp3$/i.test(x.name)) || (j.files || []).find((x) => /\.(mp3|ogg|m4a)$/i.test(x.name));
    return f ? "https://archive.org/download/" + encodeURIComponent(id) + "/" + f.name.split("/").map(encodeURIComponent).join("/") : "";
  } catch (_) { return ""; }
}
async function iaMulti(qs) {
  const seen = new Set(), out = [];
  const rs = await Promise.allSettled(qs.map((q) => iaSearch(q)));
  for (const r of rs) if (r.status === "fulfilled") for (const n of r.value) if (!seen.has(n.id)) { seen.add(n.id); out.push(n); }
  return out;
}
let poolCache = null, bagCache = [], mixFlip = false;
async function nextFromPool() {
  if (!poolCache) {
    const fromState = (R.S().pool || []).filter((p) => p && (p.src || p.iaId));
    if (fromState.length) poolCache = fromState;
    else {
      const nodes = await iaMulti(['creator:"Johnny Cash"', 'creator:"Miles Davis"', 'creator:"Grateful Dead"', 'creator:"James Brown"', 'creator:"Bob Marley"', 'creator:"Duke Ellington"', 'creator:"John Coltrane"', 'creator:"Marvin Gaye"', 'creator:"Hank Williams"', 'creator:"Muddy Waters"', 'creator:"Billie Holiday"', 'creator:"Louis Armstrong"']);
      poolCache = nodes.map((n) => ({ iaId: n.id, title: n.title, cover: "https://archive.org/services/img/" + encodeURIComponent(n.id) }));
    }
  }
  if (!poolCache.length) return null;
  const n = poolCache[Math.floor(Math.random() * poolCache.length)];
  const src = n.src || (await iaFile(n.iaId));
  return src ? { src, title: n.title, cover: n.cover || "" } : null;
}
function nextFromLibrary() {
  if (!bagCache.length) bagCache = FREE_MEDIA.music.map((t) => ({ src: t.src, title: t.t + " — " + t.a, cover: t.cover, dur: t.dur }));
  if (!bagCache.length) return null;
  const i = Math.floor(Math.random() * bagCache.length);
  return bagCache.splice(i, 1)[0];
}
async function pickNextItem() {
  if (!R) return null;
  const store = R.store, S = store.S;
  // (1) listener picks first — oldest unplayed, consumed on use
  let used = [];
  try { used = JSON.parse(localStorage.getItem("mw-dj-usedpicks") || "[]"); } catch (_) {}
  const pick = R.reqCache.find((r) => r.data && r.data.kind === "pick" && !used.includes(r.id));
  if (pick) {
    used.push(pick.id);
    try { localStorage.setItem("mw-dj-usedpicks", JSON.stringify(used.slice(-200))); } catch (_) {}
    const p = pick.data;
    R.ctx.gateway.call("rest", { table: "docs", op: "delete", filters: [["path", "eq", "requests/" + pick.id]] }).catch(() => {});
    say("🎵 Listener pick up next: " + (p.title || ""));
    if (p.src) return { src: p.src, title: p.title || "", cover: p.cover || "", dur: p.dur || 0 };
    if (p.iaId) { const src = await iaFile(p.iaId); if (src) return { src, title: p.title || "", cover: p.cover || "" }; }
  }
  // (2) his queue — shuffle draw, no repeats, age-locked skipped
  while (store.queue.length) {
    const it = drawFromQueue(store.queue);
    if (!it) break;
    if (it.yt && ageIsLocked(it.yt)) { say("🔞 Skipped an age-locked video in the queue."); continue; }
    store.saveQueuePaintOnly(); paintQueue(); brainDraw(it);
    return it;
  }
  // (3) Auto-DJ only beyond this line
  if (!S.autodj) return null;
  mixFlip = !mixFlip;
  const it = mixFlip ? (await nextFromPool()) || nextFromLibrary() : nextFromLibrary() || (await nextFromPool());
  if (it) brainDraw(it);
  return it;
}

/* ---- stocking: Play-the-queue fills ALL FOUR decks ---- */
async function stockDeck(k, it) {
  await load(k, it, { cue: true });
  const S = R.S(), d = R.decksEng.decks[k];
  if (it.yt && d && !d.shim) {
    const shim = await d.setYt(it.yt, $(R.root, "#yt-" + k));
    if (!shim || shim._locked) { if (shim && shim._locked) ageMarkLocked(it.yt, R.ctx.session); return; }
    try { d.el.pause(); } catch (_) {}
  }
  if (S[k] && (S[k].yt || S[k].src)) qSet(k, it);
}
async function playQueueStock() {
  if (!R) return;
  const store = R.store, S = store.S;
  let startedK = "", stocked = [];
  for (const k of DECKS) {
    if (S[k].playing) continue;
    const it = await pickNextItem();
    if (!it) break;
    if (k === "A" && !DECKS.some((x) => S[x].playing)) {
      await load(k, it); await togglePlay(k);
      if (S.A.playing) startedK = "A";
      else if (S[k] && (S[k].yt || S[k].src)) { qSet(k, it); stocked.push(k); }
    } else { await stockDeck(k, it); if (S.qStock[k]) stocked.push(k); }
  }
  paintQueue();
  if (startedK) say("🎶 Queue on the decks — A playing" + (stocked.length ? ", " + stocked.join(" ") + " loaded and ready" : "") + ".");
  else if (stocked.length) say("🎶 Queue loaded onto the decks — " + stocked.join(" ") + " ready.");
  else say("🎶 Every deck is playing — each one refills from the queue as it finishes.");
}

/* ---- autoNext: the automated handover (live structure) ---- */
async function autoNext(endedK, force, fadeMs) {
  if (!R) return;
  const store = R.store, S = store.S;
  if ((!S.autodj && !force) || !store.leadDrive()) return;
  if (R.handoverBusy && Date.now() - R.handoverAt < 20000) return;
  R.handoverBusy = true; R.handoverAt = Date.now();
  try {
    let target = PAIR[endedK] || "A";
    // voice drops: every 3rd automated transition, one line, his words
    let dropFired = false;
    if (!SANDBOX && S.dropsOn !== false) {
      S.dropN = (S.dropN || 0) + 1;
      if (dropDue(S.dropN)) { const ix = (S.dropIx || 0) % DROP_TEXTS.length; S.dropIx = ix + 1; S.voice = { id: "drop" + ix + "-" + Date.now(), text: DROP_TEXTS[ix], at: Date.now() }; dropFired = true; }
    }
    if (!dropFired) { const idPad = (S.pads || [])[0]; if (idPad && idPad.url) S.voice = { id: idPad.id, url: idPad.url, at: Date.now() }; }
    // stocked rotation first: next stocked deck in A→B→C→D→A order
    let started = false, attempts = 0;
    if (!SANDBOX) {
      let cand = ROT[endedK];
      for (let step = 0; step < 3 && !started && attempts < 4; step++) {
        if (stockValid(S.qStock[cand], S[cand])) {
          if (ageIsLocked((S.qStock[cand] || {}).yt || "")) qClear(cand);
          else {
            attempts++;
            try { await togglePlay(cand); } catch (_) {}
            started = !!S[cand].playing;
            if (started && R.decksEng.decks[cand].shim && R.decksEng.decks[cand].shim._locked) { try { R.decksEng.decks[cand].el.pause(); } catch (_) {} S[cand].playing = false; started = false; }
            if (started) target = cand; else say("⏭ That one would not play — rolling the next.");
            qClear(cand);
          }
        }
        cand = ROT[cand];
      }
    }
    // a preloaded pair deck skips pick + load entirely
    let preItem = null;
    if (R.preLoad && R.preLoad.item && R.preLoad.target === target && (S[target].yt || "") === (R.preLoad.item.yt || "") && (S[target].src || "") === (R.preLoad.item.src || "") && !(R.preLoad.item.yt && ageIsLocked(R.preLoad.item.yt))) { preItem = R.preLoad.item; R.preLoad = null; }
    for (let attempt = attempts; attempt < 4 && !started; attempt++) {
      const item = attempt === 0 && preItem ? preItem : await pickNextItem();
      if (!item) break;
      if (!(attempt === 0 && preItem)) { try { await load(target, item); } catch (_) {} }
      try { await togglePlay(target); } catch (_) {}
      started = !!S[target].playing;
      if (started && R.decksEng.decks[target].shim && R.decksEng.decks[target].shim._locked) { try { R.decksEng.decks[target].el.pause(); } catch (_) {} S[target].playing = false; started = false; }
      if (!started) say("⏭ That one would not play — rolling the next.");
    }
    if (started) {
      if (S.hornOn === true) S.fxHornAt = Date.now(); // horns OFF unless he turns them on (2026-10-29)
      const fullAt = (k) => (k === "B" || k === "D") ? 1 : 0;
      const eKey = (endedK === "C" || endedK === "D") ? "xf2" : "xf", tKey = (target === "C" || target === "D") ? "xf2" : "xf";
      const moves = [{ key: tKey, from: S[tKey] == null ? 0.5 : S[tKey], to: fullAt(target) }];
      if (eKey !== tKey) { moves.push({ key: eKey, from: S[eKey] == null ? 0.5 : S[eKey], to: 1 - fullAt(endedK) }); if (Math.abs((S.panX == null ? 0.5 : S.panX) - 0.5) > 0.01) moves.push({ key: "panX", from: S.panX == null ? 0.5 : S.panX, to: 0.5 }); }
      const t0 = performance.now(), dur = Math.max(800, fadeMs || 3500), touch0 = R.xfTouchedAt;
      clearInterval(R.xfAnim);
      R.xfAnim = setInterval(() => {
        const p = Math.min(1, (performance.now() - t0) / dur);
        moves.forEach((mv) => { S[mv.key] = mv.from + (mv.to - mv.from) * p; });
        R.decksEng.levels(); paintXfPads();
        if (p >= 1) { clearInterval(R.xfAnim); R.xfAnim = null; store.save(true); xfSettleKeys(moves.map((mv) => mv.key), touch0); }
      }, 100);
      // refill the deck that just ended, cued and stocked (bounded re-check)
      const refill = async (tries) => {
        if (!R) return;
        const eS = R.S();
        if (!eS[endedK].playing && !stockValid(eS.qStock[endedK], eS[endedK])) {
          const it = await pickNextItem();
          if (it && !R.S()[endedK].playing) { await stockDeck(endedK, it); store.save(true); }
        } else if (tries < 3) setTimeout(() => refill(tries + 1), 3000);
      };
      setTimeout(() => refill(0), 2500);
    }
  } finally { R.handoverBusy = false; }
}
/* faders ease home to center over 2.2 s unless a hand touched them */
function xfSettleKeys(keys, touch0) {
  if (!R) return;
  const S = R.S(), store = R.store;
  const from = {}; keys.forEach((k) => { from[k] = S[k] == null ? 0.5 : S[k]; });
  const t0 = performance.now();
  const iv = setInterval(() => {
    if (!R || R.xfTouchedAt !== touch0) { clearInterval(iv); return; }
    const p = Math.min(1, (performance.now() - t0) / 2200);
    keys.forEach((k) => { S[k] = from[k] + (0.5 - from[k]) * p; });
    R.decksEng.levels(); paintXfPads();
    if (p >= 1) { clearInterval(iv); store.save(true); }
  }, 100);
}
function xfFollowGuard() {
  if (!R || !R.S().autodj || !R.store.leadDrive()) return;
  if (Date.now() - R.xfTouchedAt < 8000) return;
  const S = R.S();
  const playing = DECKS.filter((k) => S[k].playing);
  if (playing.length !== 1) return;
  const k = playing[0], cd = k === "C" || k === "D", key = cd ? "xf2" : "xf";
  const g = (k === "B" || k === "D") ? S[key] : 1 - S[key];
  if (g < 0.2) xfSettleKeys([key], R.xfTouchedAt);
}

/* ============================================================================
   THE BOOTH TICK (500 ms) + DEAD-AIR RESCUE (1 s) + SIDE LOADS
   ============================================================================ */
const wdKeyOf = (k) => { const s = R.S()[k]; return (s.yt ? "yt:" + s.yt : "src:" + (s.src || "")) + "|" + (s.title || ""); };
async function wdReload(k) {
  const S = R.S(), s = S[k], d = R.decksEng.decks[k];
  const pos = posOf(S, k, Date.now());
  if (s.yt) {
    d.clearYt();
    const shim = await d.setYt(s.yt, $(R.root, "#yt-" + k));
    if (shim) { try { d.el.seekTo(pos); await d.el.play(); } catch (_) {} }
  } else if (s.src) {
    try { d.el.pause(); d.set(s.src); d.el.addEventListener("loadedmetadata", () => { try { d.el.currentTime = pos; d.el.play(); } catch (_) {} }, { once: true }); } catch (_) {}
  }
  s.start = Date.now() - pos * 1000;
}
function boothTick() {
  if (!R) return;
  const root = R.root, S = R.S(), store = R.store, now = Date.now();
  const clk = $(root, "#dj-clock");
  if (clk) clk.textContent = new Date().toLocaleTimeString("en-US", { timeZone: "America/New_York", hour: "numeric", minute: "2-digit" }) + " ET";
  const sht = $(root, "#dj-showtime");
  if (sht) sht.textContent = S.live && S.liveSince ? "On air " + fmt((now - S.liveSince) / 1000) : "";
  const lead = store.leadDrive();
  let anyPlaying = false, onlyK = "";
  for (const k of DECKS) {
    const s = S[k], d = R.decksEng.decks[k], el = d.el;
    const pos = lead && el ? (typeof el.currentTime === "number" ? el.currentTime : posOf(S, k, now)) : posOf(S, k, now);
    const durT = s.dur || (el && el.duration) || 0;
    const tm = $(root, "#tm-" + k);
    if (tm) tm.textContent = fmt(pos) + " / " + fmt(durT);
    const pl = $(root, "#pl-" + k);
    if (pl) pl.style.transform = s.playing ? `rotate(${(pos * 40) % 360}deg)` : "";
    if (s.playing) { anyPlaying = true; onlyK = onlyK ? "" : k; }
    if (!R.ownerSeat || !lead) continue;
    // end detection: element end, wall-clock end, hard end (live rules)
    const elDone = d.shim ? (el.paused && durT > 0 && pos >= durT - 0.5) : (el.ended || el.paused);
    if (s.playing && el.ended) { deckEnded(k); continue; }
    if (s.playing && durT > 0 && posOf(S, k, now) > durT + 2 && elDone) { deckEnded(k); continue; }
    if (s.playing && durT > 0 && posOf(S, k, now) > durT + 15) { deckEnded(k); continue; }
    // loop wrap
    if (s.playing && s.loop && s.loop.b > s.loop.a && pos >= s.loop.b) { try { if (el.seekTo) el.seekTo(s.loop.a); else el.currentTime = s.loop.a; } catch (_) {} s.start = now - s.loop.a * 1000; }
    // the position stall watchdog
    if (S.live && s.playing && !S.pausedAt) {
      const excluded = !!(el.seeking || el.ended || (durT > 0 && pos >= durT - 0.75));
      const res = stallStep(R.wd[k], { now, playing: true, pausedAt: 0, pos, key: wdKeyOf(k), excluded });
      R.wd[k] = res.mem;
      if (res.action === "kick") { try { el.play(); } catch (_) {} R.store.brainEmit({ type: "stall", deck: k, at: now }); }
      else if (res.action === "reload") { wdReload(k); R.store.brainEmit({ type: "stall", deck: k, at: now }); }
      else if (res.action === "handover") { R.store.brainEmit({ type: "stall", deck: k, at: now }); deckEnded(k); continue; }
    } else R.wd[k] = null;
    // preload the pair deck in the final 15 s; hand over in the final 5
    if (S.live && (S.autodj || store.queue.length) && s.playing) {
      const rem = durT - posOf(S, k, now);
      const pair = PAIR[k];
      if (durT > 0 && preloadDue(rem) && !S[pair].playing && !(R.handoverBusy && now - R.handoverAt < 20000) && !(R.preLoad && R.preLoad.forStart === s.start) && (SANDBOX || !stockValid(S.qStock[ROT[k]], S[ROT[k]]))) {
        R.preLoad = { target: pair, forStart: s.start, item: null };
        pickNextItem().then(async (item) => {
          if (!R || !item) return;
          R.preLoad = { target: pair, forStart: s.start, item };
          if (!R.S()[pair].playing) await load(pair, item, { cue: true, mount: true });
        });
      }
      if (durT > 0 && blendDue(rem) && onlyK === k) autoNext(k, true, Math.max(1200, rem * 1000));
    }
  }
  // booth dead-air backstop (the rescue below is the second net)
  if (R.ownerSeat && lead && !store.serverMirror() && S.live && (S.autodj || store.queue.length) && !S.pausedAt && !anyPlaying && !(S.vstream || {}).on) {
    if (!R.deadAirAt) R.deadAirAt = now;
    else if (now - R.deadAirAt > 5000) { R.deadAirAt = 0; R.handoverBusy = false; autoNext(R.lastEndedK, true); }
  } else R.deadAirAt = 0;
  xfFollowGuard();
  // sound: levels + FX follow the state; mic meter drives the duck
  if (R.decksEng) {
    const bpmDeck = DECKS.find((k) => S[k].playing && S[k].bpm);
    R.decksEng.applyFx(bpmDeck ? S[bpmDeck].bpm : 0);
    R.decksEng.levels();
    R.decksEng.setMicHot(R.micHot || 0);
  }
  voiceWatch();
  paintWaveforms();
}
function paintWaveforms() {
  if (!R || !R.decksEng) return;
  for (const k of DECKS) {
    const cv = $(R.root, "#wv-" + k); if (!cv) continue;
    const d = R.decksEng.decks[k]; if (!d || d.shim || !d.an) continue;
    const c2 = cv.getContext("2d"); if (!c2) continue;
    const a = new Uint8Array(d.an.fftSize); d.an.getByteTimeDomainData(a);
    c2.clearRect(0, 0, cv.width, cv.height);
    c2.strokeStyle = "rgba(240,207,120,.85)"; c2.beginPath();
    for (let x = 0; x < cv.width; x++) { const v = a[Math.floor(x / cv.width * a.length)] / 255; const y = v * cv.height; x === 0 ? c2.moveTo(x, y) : c2.lineTo(x, y); }
    c2.stroke();
  }
}
/* station voice drops + pad IDs: a fresh S.voice plays once here */
let lastVoiceId = "";
function voiceWatch() {
  if (!R) return;
  const v = R.S().voice;
  if (!v || !v.id || v.id === lastVoiceId) return;
  lastVoiceId = v.id;
  R.decksEng.setVoicePlaying(true);
  const done = () => R && R.decksEng.setVoicePlaying(false);
  if (v.url) {
    const a = new Audio(v.url);
    a.addEventListener("ended", done); a.addEventListener("error", done);
    a.play().catch(done);
    setTimeout(done, 15000);
    return;
  }
  if (v.text) {
    // the site voice (server TTS); speechSynthesis is the local fallback
    const ses = R.ctx.session.get && R.ctx.session.get();
    fetch("/api/ai", { method: "POST", headers: { "content-type": "application/json", ...(ses && ses.access_token ? { authorization: "Bearer " + ses.access_token } : {}) }, body: JSON.stringify({ tts: v.text }) })
      .then((r) => { if (!r.ok) throw new Error("tts"); return r.blob(); })
      .then((b) => { const a = new Audio(URL.createObjectURL(b)); a.addEventListener("ended", done); a.play().catch(done); setTimeout(done, 20000); })
      .catch(() => {
        try { const u = new SpeechSynthesisUtterance(v.text); u.addEventListener("end", done); speechSynthesis.speak(u); setTimeout(done, 20000); }
        catch (_) { done(); }
      });
  }
}
function daRescueTick() {
  if (!R || !R.ownerSeat) return;
  const S = R.S(), store = R.store, now = Date.now();
  let sounding = DECKS.some((k) => S[k].playing);
  if (!sounding && R.decksEng) sounding = DECKS.some((k) => { const el = R.decksEng.decks[k].el; return el && !el.paused && !el.ended; });
  const sig = DECKS.map((k) => (S[k].yt || "") + "|" + (S[k].src || "") + "|" + (S[k].title || "")).join("¦");
  const res = daGate(R.daSt, {
    now, sandbox: SANDBOX, owner: store.isOwner() || SANDBOX, lead: store.leadDrive(), mirror: store.serverMirror(),
    live: !!S.live, autodj: S.autodj !== false, shareOn: !!((S.vstream || {}).on),
    sounding, pausedAt: S.pausedAt || 0, sig, handoverAge: R.handoverBusy ? now - R.handoverAt : null,
  });
  R.daSt = res.st;
  if (res.fire) { say("🛟 Dead air — Auto-DJ is restarting the music."); autoNext(R.lastEndedK, true); }
  // battles: the booth ticks the server advance while a battle runs
  if (S.battle && S.battle.on && store.leadDrive()) {
    if (!R._battleTickAt || now - R._battleTickAt > 5000) { R._battleTickAt = now; battleApi({ action: "advance" }).catch(() => {}); }
  }
}
/* ---- side loads: requests + reports ---- */
async function loadRequests() {
  if (!R || !R.ownerSeat || SANDBOX) return;
  try {
    const { data } = await R.ctx.gateway.rest({ table: "docs", select: "path,data", filters: [["coll", "eq", "requests"]], limit: 100 });
    if (Array.isArray(data)) {
      R.reqCache = data.map((r) => ({ id: String(r.path || "").split("/").pop(), data: r.data || {} }));
      renderReqPanels();
    }
  } catch (_) {}
  if (R) R.timers.push(setTimeout(loadRequests, 20000));
}
async function reportsBtnTick() {
  if (!R || !R.ownerSeat || SANDBOX) return;
  try {
    const idx = await R.ctx.gateway.readDoc("reports/index");
    const n = idx && Array.isArray(idx.ids) ? idx.ids.length : 0;
    R.reportCount = n;
    const badge = $(R.root, "#dj-reports-badge");
    if (badge) { badge.hidden = !n; badge.textContent = n ? String(n) : ""; }
    const btn = $(R.root, "#dj-reports-btn");
    if (btn) btn.firstChild.textContent = "📋 REPORTS ";
  } catch (_) {}
}
async function battleApi(body) {
  const ses = R.ctx.session.get && R.ctx.session.get();
  const r = await fetch("/api/battle", { method: "POST", headers: { "content-type": "application/json", ...(ses && ses.access_token ? { authorization: "Bearer " + ses.access_token } : {}) }, body: JSON.stringify(body) });
  return r.json().catch(() => null);
}

/* ============================================================================
   BELOW-DECKS PANELS (Law 6: shipped order, collapsible, drag when
   unlocked, LOCK default, Reset restores) + panel painters
   ============================================================================ */
function panelOrder() {
  let saved = [];
  try { saved = JSON.parse(localStorage.getItem("mw-v2-panel-order") || "[]"); } catch (_) {}
  const ids = LAYOUT.panels.map(([id]) => id);
  const out = saved.filter((id) => ids.includes(id));
  for (const id of ids) if (!out.includes(id)) out.push(id);
  return out;
}
function buildPanels(root) {
  const grid = $(root, "#dj-grid2"); if (!grid) return;
  const hidden = (() => { try { return new Set(JSON.parse(localStorage.getItem("mw-v2-hidden-panels") || "[]")); } catch (_) { return new Set(); } })();
  const folds = (() => { try { return JSON.parse(localStorage.getItem("mw-v2-folds") || "{}"); } catch (_) { return {}; } })();
  grid.innerHTML = panelOrder().filter((id) => !hidden.has(id)).map((id) => panelHTML(id)).join("");
  for (const id of panelOrder()) {
    if (folds[id]) { const b = $(grid, `[data-panelbody="${id}"]`); if (b) b.hidden = true; }
    paintPanel(id);
  }
  paintCustomize();
}
function paintPanel(id) {
  if (!R) return;
  const body = $(R.root, `[data-panelbody="${id}"]`); if (!body) return;
  const S = R.S();
  switch (id) {
    case "door": paintDoor(); break;
    case "brain": paintBrain(body); break;
    case "reports": paintReports(body); break;
    case "livereq": body.innerHTML = `<div class="dj-list" id="djreq-list"></div><div class="muted" id="djguest-now"></div>`; renderReqPanels(); break;
    case "autodj":
      body.innerHTML = `<label class="dj-sw">Auto-DJ <input type="checkbox" id="ad-on" ${S.autodj !== false ? "checked" : ""}></label>
        <label class="dj-sw">Voice drops <input type="checkbox" id="ad-drops" ${S.dropsOn !== false ? "checked" : ""}></label>
        <div class="muted" id="ad-queue"></div><b>Drop rotation</b><div class="dj-list" id="ad-drops-list">${DROP_TEXTS.map((t, i) => `<div class="dj-item"><span title="${esc(t)}">${i + 1}. ${esc(t)}</span></div>`).join("")}</div>`;
      paintQueue(); break;
    case "mic":
      body.innerHTML = `<button type="button" class="btn sm" id="mic-on">🎤 Mic on</button>
        <label class="dj-sw">Monitor <input type="checkbox" id="mic-mon"></label>
        <label class="dj-sw">Auto-duck music <input type="checkbox" id="mic-duck" checked></label>
        <div class="miclvl"><div id="mic-lvl"></div></div>`; break;
    case "record":
      body.innerHTML = `<button type="button" class="btn sm" id="rec-btn">⏺ Record the show (audio)</button> <span class="muted" id="rec-st"></span><div id="rec-out"></div>
        <button type="button" class="btn ghost sm" id="ses-btn">🎥 Record session video</button> <span class="muted" id="ses-st"></span><div id="ses-out"></div>`; break;
    case "fx":
      body.innerHTML = `<small class="muted">The full Master FX chain lives in the center mixer — same controls, same caps (reverb ≤ 0.30, flanger ≤ 0.25, crush ≤ 12 on air).</small>
        <div class="qrow">${[["loud", "🔊 Loud & Clear"], ["radio", "📻 Radio"], ["club", "🎉 Club"], ["scratch", "💿 Scratch"], ["chop", "🔪 Chop"]].map(([p, n]) => `<button type="button" class="btn ghost sm" data-pop="${p}">${n}</button>`).join("")}</div>`; break;
    case "vfx":
      body.innerHTML = `<div class="qrow">${["", "flash", "strobe", "invert", "zoom"].map((v) => `<button type="button" class="btn ghost sm" data-vfx="${v}">${v || "None"}</button>`).join("")}</div><small class="muted">Video effects stamp onto the master screen for every viewer at once.</small>`; break;
    case "pads": paintPads(body); break;
    case "midi":
      body.innerHTML = `<div class="muted" id="dj-midi-stat">MIDI is off.</div>
        <button type="button" class="btn sm" id="dj-midi-on">🎹 Enable MIDI</button>
        <button type="button" class="btn ghost sm" id="dj-midi-learn">Learn</button>
        <button type="button" class="btn ghost sm" id="dj-midi-clear">Clear map</button>
        <div class="dj-list" id="dj-midi-list"></div>`; break;
    case "log":
      body.innerHTML = `<div class="dj-list" id="dj-log"></div>
        <div class="qrow"><input id="dj-ticker-in" placeholder="Ticker text for the station card" maxlength="140"><button type="button" class="btn ghost sm" id="dj-ticker-set">Set ticker</button></div>`;
      paintLog(); break;
    case "reqdrops": body.innerHTML = `<div class="dj-list" id="rq-list"></div>`; renderReqPanels(); break;
    case "campro": paintCampro(body); break;
    case "battles": body.innerHTML = `<div id="battle-box"></div>`; paintBattle(); break;
    case "afterhours":
      body.innerHTML = `<small class="muted">🌙 After Hours is the booth-only explicit-version shelf — it never shows on the member side. The shelf rides the same browser: search results here stay on this screen only.</small>`; break;
  }
}
function paintLog() {
  if (!R) return;
  const box = $(R.root, "#dj-log"); if (!box) return;
  const log = R.S().log || [];
  box.innerHTML = log.length ? log.slice(0, 20).map((e) => `<div class="dj-item"><span>${esc(e.title || "")}</span><small class="muted">${e.at ? new Date(e.at).toLocaleTimeString() : ""}</small></div>`).join("") : '<small class="muted">Nothing played yet.</small>';
}
function paintDoor() {
  if (!R) return;
  const body = $(R.root, '[data-panelbody="door"]'); if (!body) return;
  const pres = R.ctx.presence && R.ctx.presence.last;
  const users = (pres && pres.users) || [];
  const online = pres && typeof pres.online === "number" ? pres.online : users.length;
  const sig = online + ":" + users.map((u) => u.uid || u.name).join(",");
  if (body._sig === sig) return; body._sig = sig;
  const guests = Math.max(0, online - users.length);
  body.innerHTML = `<div class="muted" id="door-bell-state">${online} on the site — ${users.length} member${users.length === 1 ? "" : "s"}, ${guests} guest${guests === 1 ? "" : "s"}</div>
    <div class="dj-list" id="door-list">${users.length ? users.map((u) => `<div class="dj-item"><span>🟢 ${esc(u.name || "Member")}</span><small class="muted">${u.since ? "since " + new Date(u.since).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) : ""}</small></div>`).join("") : '<small class="muted">No members on right now.</small>'}</div>
    <button type="button" class="btn ghost sm" id="door-bell">🔔 Doorbell: check</button>`;
  const bell = $(body, "#door-bell");
  if (bell) bell.addEventListener("click", async () => {
    const d = await R.ctx.gateway.readDoc("site/doorbell").catch(() => null);
    say(d && d.ring ? "🔔 The doorbell is ON — new arrivals ring your screens." : "🔕 The doorbell doc says off — it rings from the booth's Turn On in your owner screens.");
  });
}
/* ---- BRAIN panel + the AI-DJ C2 section ---- */
async function loadBrainPanel() {
  if (!R || SANDBOX) return;
  try {
    const t = await R.ctx.gateway.readDoc("brain/taste");
    if (R) R.taste = t;
    const blk = await R.ctx.gateway.readDoc("brain/ytblock");
    if (blk && Array.isArray(blk.ids)) blk.ids.forEach((id) => ageSet.add(id));
  } catch (_) {}
  paintBrain($(R.root, '[data-panelbody="brain"]'));
}
function paintBrain(body) {
  if (!body) return;
  const S = R.S(), t = R.taste || {};
  const tops = t.topArtists || t.artists || [];
  body.innerHTML = `
    <div class="muted">The site brain folds every play, skip and stall into your taste — the keeper's picks and the AI-DJ both read it. Plays ${t.plays || 0} · Skips ${t.skips || 0} · Tracks ${t.tracks || 0}</div>
    ${tops.length ? `<div class="dj-list">${tops.slice(0, 8).map((a) => `<div class="dj-item"><span>${esc(a.name || a)}</span><small class="muted">${a.plays || ""}</small></div>`).join("")}</div>` : '<small class="muted">Taste is still learning — it builds as the station plays.</small>'}
    <div class="brain-aidj">
      <b>🤖 AI DJ</b>
      <label class="dj-sw">AI-DJ on <input type="checkbox" id="brain-aidj" ${S.aiDj !== false ? "checked" : ""}></label>
      <small class="muted">When the booth has been closed 30+ minutes and YOUR queue is empty, the robot stocks up to 4 picks from what you have searched and played — your picks, the schedule and your queue always outrank it, and every robot pick still passes the playable filter.</small>
      <div id="brain-aiq"></div>
    </div>`;
  const tg = $(body, "#brain-aidj");
  if (tg) tg.addEventListener("change", () => { R.S().aiDj = tg.checked; R.store.save(true); say(tg.checked ? "🤖 AI-DJ is ON — it stocks the station when you're away." : "🤖 AI-DJ is OFF — the robot won't pick."); });
  paintBrainAi();
}
function paintBrainAi() {
  if (!R) return;
  const box = $(R.root, "#brain-aiq"); if (!box) return;
  const aiQ = R.S().aiQ || [];
  const sig = aiQ.map((x) => x.yt || x.title).join("|");
  if (box._sig === sig) return; box._sig = sig;
  box.innerHTML = aiQ.length ? `<small class="muted">Robot stock right now:</small>` + aiQ.map((x) => `<div class="dj-item"><span>${esc(x.title || "Music video")}</span><small class="muted">AI pick</small></div>`).join("") : '<small class="muted">No robot stock right now.</small>';
}
/* ---- REPORTS panel ---- */
async function paintReports(body) {
  if (!body || SANDBOX) { if (body) body.innerHTML = '<small class="muted">Reports live on the real station.</small>'; return; }
  body.innerHTML = '<small class="muted">Loading reports…</small>';
  try {
    const idx = await R.ctx.gateway.readDoc("reports/index");
    const ids = idx && Array.isArray(idx.ids) ? idx.ids.slice(-20).reverse() : [];
    if (!ids.length) { body.innerHTML = '<small class="muted">No reports waiting.</small>'; return; }
    const docs = await Promise.all(ids.map((id) => R.ctx.gateway.readDoc("reports/" + id).catch(() => null)));
    body.innerHTML = docs.map((d, i) => d ? `<div class="dj-item"><span>${esc(d.kind || "report")} — ${esc(d.text || d.message || "")}</span><small class="muted">${d.at ? new Date(d.at).toLocaleString() : ""} · ${esc(d.fromName || d.name || "")}</small></div>` : "").join("") || '<small class="muted">No reports waiting.</small>';
  } catch (_) { body.innerHTML = '<small class="muted">Reports could not load right now.</small>'; }
}
/* ---- requests (listener picks + guest-DJ asks) ---- */
function renderReqPanels() {
  if (!R) return;
  const reqs = R.reqCache || [];
  const list = $(R.root, "#djreq-list");
  if (list) {
    const asks = reqs.filter((r) => r.data && r.data.kind === "djlive");
    list.innerHTML = asks.length ? asks.map((r) => `<div class="dj-item"><span>🎛 ${esc(r.data.name || "A member")} wants a live slot</span><button type="button" class="btn sm" data-grant="${r.id}">Put them on</button></div>`).join("") : '<small class="muted">No live-slot asks right now.</small>';
  }
  const now = $(R.root, "#djguest-now");
  if (now) { const g = R.S().djGuest; now.textContent = g && g.uid ? `On the decks: ${g.name || "a guest"} until ${g.until ? new Date(g.until).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) : ""}` : "No guest DJ on right now."; }
  const rq = $(R.root, "#rq-list");
  if (rq) {
    const picks = reqs.filter((r) => r.data && (r.data.kind === "pick" || r.data.kind === "song"));
    rq.innerHTML = picks.length ? picks.map((r) => `<div class="dj-item"><span>🎵 ${esc(r.data.title || "Song request")}</span><small class="muted">${esc(r.data.name || "")}</small></div>`).join("") : '<small class="muted">No song requests waiting.</small>';
  }
}
/* ---- pads: the jingle board + the per-deck pads (same sounds) ---- */
function paintPads(body) {
  if (!body) return;
  const pads = R.S().pads || [];
  body.innerHTML = `<div class="pads" id="dj-pads">${pads.length ? pads.map((p, i) => `<button type="button" class="pad" data-pad="${i}">${esc(p.name || "Pad " + (i + 1))}</button>`).join("") : '<small class="muted">No pads yet — the first pad is your station ID: it fires on automated transitions when no voice drop is due.</small>'}</div>
    <form id="pad-form" class="qrow"><input id="pad-name" placeholder="Pad name"><input id="pad-url" placeholder="Sound file URL"><button class="btn ghost sm" type="submit">＋ Add pad</button></form>`;
  paintDeckPads();
}
function paintDeckPads() {
  if (!R) return;
  const pads = R.S().pads || [];
  for (const k of DECKS) {
    const box = $(R.root, "#dpads-" + k); if (!box) continue;
    box.innerHTML = pads.map((p, i) => `<button type="button" class="dpad" data-pad="${i}" title="${esc(p.name || "")}">${i + 1}</button>`).join("");
  }
}
let padAudioCtx = null;
function padPlay(i) {
  if (!R) return;
  const S = R.S(), pad = (S.pads || [])[i];
  S.padHit = { id: pad ? pad.id || ("pad" + i) : "pad" + i, at: Date.now() };
  R.store.save(true); // a mirror's pad hit is the ONE write a mirror may make
  if (!pad || !pad.url) { say("That pad has no sound yet."); return; }
  try {
    if (!padAudioCtx) padAudioCtx = R.decksEng.graph.ctx;
    fetch(pad.url).then((r) => r.arrayBuffer()).then((ab) => padAudioCtx.decodeAudioData(ab)).then((buf) => {
      const src = padAudioCtx.createBufferSource(); src.buffer = buf;
      src.connect(R.decksEng.graph.masterIn); src.start();
      R.decksEng.setVoicePlaying(true);
      src.addEventListener("ended", () => R && R.decksEng.setVoicePlaying(false));
    }).catch(() => say("That pad sound would not load."));
  } catch (_) {}
}
/* ---- camera pro (compact): looks ride the booth cam preview ---- */
function paintCampro(body) {
  if (!body) return;
  body.innerHTML = `${[["cp-b", "Brightness", 100], ["cp-c", "Contrast", 100], ["cp-s", "Saturate", 100]].map(([id, n, v]) => `<label class="dslider">${n} <input type="range" id="${id}" min="0" max="200" value="${v}"></label>`).join("")}
    <div class="qrow"><input id="cp-banner-in" placeholder="Camera banner text"><button type="button" class="btn ghost sm" id="cp-banner-set">Set banner</button></div>
    <small class="muted">Looks apply to your camera preview on the master screen.</small>`;
}
/* ---- battles ---- */
function paintBattle() {
  if (!R) return;
  const S = R.S(), bt = S.battle || {};
  const card = $(R.root, "#st-battle");
  if (card) {
    card.innerHTML = bt.on ? `<div class="ws-card"><b>⚔️ DJ BATTLE — Round ${bt.round || 1} of ${bt.rounds || 3}</b><div>${esc((bt.p1 || {}).name || "Player 1")} vs ${esc((bt.p2 || {}).name || "Player 2")}</div><div class="muted">${bt.phase === "off" ? "" : (bt.turn ? "On the decks: " + esc(bt.turn === (bt.p1 || {}).uid ? (bt.p1 || {}).name : (bt.p2 || {}).name) : "")} ${bt.winner ? "· 🏆 " + esc(bt.winner) : ""}</div></div>` : "";
  }
  const box = $(R.root, "#battle-box"); if (!box) return;
  if (!R.ownerSeat) return;
  box.innerHTML = bt.on
    ? `<div>⚔️ <b>Battle running</b> — Round ${bt.round || 1}/${bt.rounds || 3}, phase ${esc(bt.phase || "")}${bt.winner ? `, winner ${esc(bt.winner)}` : ""}</div><button type="button" class="btn ghost sm" id="battle-end">End battle</button>`
    : `<form id="battle-form" class="qrow"><input id="battle-p2" placeholder="Opponent name"><input id="battle-rounds" type="number" min="1" max="9" value="3" style="width:70px"><button class="btn sm" type="submit">⚔️ Start battle</button></form><small class="muted">Battles run on the shared battle state — the crowd gifts and likes on the station card, most gift coins wins.</small>`;
  const end = $(box, "#battle-end");
  if (end) end.addEventListener("click", async () => { await battleApi({ action: "end" }).catch(() => {}); say("⚔️ Battle ended."); });
  const form = $(box, "#battle-form");
  if (form) form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const name = $(box, "#battle-p2").value.trim(); if (!name) return;
    const rounds = clamp(parseInt($(box, "#battle-rounds").value || "3", 10) || 3, 1, 9);
    const j = await battleApi({ action: "start", p2name: name, rounds }).catch(() => null);
    say(j && j.ok ? "⚔️ Battle on!" : "The battle would not start — check the opponent and try again.");
  });
}

/* ============================================================================
   FIT + CUSTOMIZE + ORGANIZE (Law 6 mechanics)
   ============================================================================ */
function boothFit() {
  if (!R) return;
  const owner = $(R.root, "#dj-owner"); if (!owner) return;
  const parent = owner.parentElement; if (!parent) return;
  const avail = parent.clientWidth || window.innerWidth;
  owner.style.zoom = "1";
  const natural = owner.scrollWidth;
  if (natural > avail) owner.style.zoom = String(clamp(avail / natural, 0.5, 1));
  else owner.style.zoom = "";
}
let orgUnlocked = false; // per-visit only; the LOCK is the default (live rule)
function paintCustomize() {
  if (!R) return;
  const box = $(R.root, "#dj-customize"); if (!box) return;
  let hidden = new Set();
  try { hidden = new Set(JSON.parse(localStorage.getItem("mw-v2-hidden-panels") || "[]")); } catch (_) {}
  box.innerHTML = `<b>🛠 Customize — this device only</b>
    <div class="qrow"><button type="button" class="btn ghost sm" id="org-lock">${orgUnlocked ? "🔓 Panels unlocked — tap to lock" : "🔒 Panels locked — tap to unlock dragging"}</button>
    <button type="button" class="btn ghost sm" id="org-reset">Reset panel order</button></div>
    ${LAYOUT.panels.map(([id, t]) => `<label class="dj-sw">${t} <input type="checkbox" data-cust="${id}" ${hidden.has(id) ? "" : "checked"}></label>`).join("")}`;
  const lock = $(box, "#org-lock");
  if (lock) lock.addEventListener("click", () => { orgUnlocked = !orgUnlocked; paintCustomize(); say(orgUnlocked ? "🔓 Drag panels by their ⠿ grip." : "🔒 Panels locked in place."); });
  const reset = $(box, "#org-reset");
  if (reset) reset.addEventListener("click", () => { try { localStorage.removeItem("mw-v2-panel-order"); } catch (_) {} buildPanels(R.root); say("Panel order is back to the shipped layout."); });
  $$(box, "[data-cust]").forEach((cb) => cb.addEventListener("change", () => {
    const h = new Set(); try { JSON.parse(localStorage.getItem("mw-v2-hidden-panels") || "[]").forEach((x) => h.add(x)); } catch (_) {}
    if (cb.checked) h.delete(cb.dataset.cust); else h.add(cb.dataset.cust);
    try { localStorage.setItem("mw-v2-hidden-panels", JSON.stringify(Array.from(h))); } catch (_) {}
    buildPanels(R.root);
  }));
}
/* panel drag: grip pointerdown, only while unlocked; vertical drag
   reorders; a vertical PAGE scroll is never hijacked (Law 22) — the
   grip is a small deliberate handle, and drag starts on pointerdown on
   the grip itself, exactly like the live organize pass */
function gripDrag(e, grip) {
  if (!orgUnlocked) { say("🔒 Panels are locked — open 🛠 Customize to unlock dragging."); return; }
  const panel = grip.closest(".dj-panel"); if (!panel) return;
  e.preventDefault();
  const grid = panel.parentElement;
  const startY = e.clientY;
  const move = (ev) => {
    const dy = ev.clientY - startY;
    if (Math.abs(dy) < 30) return;
    const sib = dy > 0 ? panel.nextElementSibling : panel.previousElementSibling;
    if (sib) { dy > 0 ? grid.insertBefore(sib, panel) : grid.insertBefore(panel, sib); }
  };
  const up = () => {
    removeEventListener("pointermove", move); removeEventListener("pointerup", up);
    const order = Array.from(grid.querySelectorAll(".dj-panel")).map((p) => p.dataset.panel);
    try { localStorage.setItem("mw-v2-panel-order", JSON.stringify(order)); } catch (_) {}
  };
  addEventListener("pointermove", move); addEventListener("pointerup", up);
}
/* Law 22 gesture intent, as a pure classifier (fixture-pinned in the
   harness): a drag is one of three things —
   "scroll": vertical-dominant movement; the gesture belongs to the
     page and the control is never engaged, so a scroll that starts
     on or crosses a deck, slider, knob or platter scrolls the page
     and cannot seek, scratch, or change a rate;
   "wait":   movement too small to judge yet;
   "engage": a deliberate horizontal-dominant drag of the control
     itself (the X pad, a pairwave fader, the disc worked as a disc).
   Once engaged, a drag stays engaged until it ends. */
export function classifyDrag(dx, dy, engaged) {
  if (engaged) return "engage";
  const ax = Math.abs(dx), ay = Math.abs(dy);
  if (ay > ax) return ay > 8 ? "scroll" : "wait";
  if (ax < 6) return "wait";
  return "engage";
}
/* Law 22 drag discipline for the X pad / pairwaves / platters: the
   classifier above decides; "scroll" releases the gesture to the
   page (the browser's own pan takes over — every one of these
   surfaces is touch-action:pan-y in css/dj.css) and the music is
   never touched. */
function horizDrag(el, onDrag, onEnd) {
  if (!el) return;
  el.addEventListener("pointerdown", (e) => {
    const sx = e.clientX, sy = e.clientY;
    let engaged = false;
    const move = (ev) => {
      const dx = ev.clientX - sx, dy = ev.clientY - sy;
      if (!engaged) {
        const intent = classifyDrag(dx, dy, false);
        if (intent === "scroll") { cleanup(); return; } // page scroll wins
        if (intent === "wait") return;
        engaged = true;
        try { el.setPointerCapture(e.pointerId); } catch (_) {}
      }
      onDrag(ev, dx, dy);
    };
    const cleanup = () => { el.removeEventListener("pointermove", move); el.removeEventListener("pointerup", cleanup); el.removeEventListener("pointercancel", cleanup); if (engaged && onEnd) onEnd(); };
    el.addEventListener("pointermove", move); el.addEventListener("pointerup", cleanup); el.addEventListener("pointercancel", cleanup);
  });
}

/* ============================================================================
   EVENT WIRING
   ============================================================================ */
const SETUPS = {
  loud: { mf: 100, echo: 0, fb: 0.34, verb: 0, fla: 0, pha: 0, noise: 0, crush: 0, gate: 0, boost: 1.25 },
  radio: { mf: 100, echo: 0.08, fb: 0.3, verb: 0.12, fla: 0, pha: 0, noise: 0, crush: 0, gate: 0, boost: 1.1 },
  club: { mf: 100, echo: 0.25, fb: 0.4, verb: 0.3, fla: 0.2, pha: 0.1, noise: 0, crush: 0, gate: 0, boost: 1.3 },
  scratch: { mf: 100, echo: 0.1, fb: 0.25, verb: 0.05, fla: 0, pha: 0, noise: 0, crush: 0, gate: 0, boost: 1.1 },
  chop: { mf: 90, echo: 0.12, fb: 0.3, verb: 0.08, fla: 0, pha: 0, noise: 0, crush: 0, gate: 8, boost: 1.15 },
};
function wireEvents(root) {
  const store = R.store, S = () => R.S();
  const wake = () => { try { R.decksEng.wake(); } catch (_) {} };
  root.addEventListener("pointerdown", wake, { passive: true });

  root.addEventListener("click", async (e) => {
    if (!R) return;
    const t = e.target;
    const act = t.closest("[data-act]");
    if (act) { boothAction(act.dataset.act); return; }
    const play = t.closest("[data-play]"); if (play) { mirrorTap(() => togglePlay(play.dataset.play)); return; }
    const cue = t.closest("[data-cue0]"); if (cue) { const k = cue.dataset.cue0, d = R.decksEng.decks[k]; S()[k].pos = 0; S()[k].start = Date.now(); try { if (d.el.seekTo) d.el.seekTo(0); else d.el.currentTime = 0; } catch (_) {} store.save(true); paintOwner(); return; }
    const brake = t.closest("[data-brake]"); if (brake) { const k = brake.dataset.brake; if (S()[k].playing) mirrorTap(() => togglePlay(k)); brakeFx(k); return; }
    const ytload = t.closest("[data-ytload]"); if (ytload) { const id = bareYt($(root, "#dj-yt").value); if (!id) { say("Paste a YouTube link first."); return; } mirrorTap(() => load(ytload.dataset.ytload, { yt: id, title: "" }, { cue: true })); return; }
    if (t.closest("[data-ytqueue]")) { const id = bareYt($(root, "#dj-yt").value); if (!id) { say("Paste a YouTube link first."); return; } store.queue.push({ yt: id, title: "YouTube video" }); store.saveQueue(); paintQueue(); say("Added to the queue."); return; }
    const qup = t.closest("[data-qup]"), qdn = t.closest("[data-qdn]"), qx = t.closest("[data-qx]");
    if (qup || qdn || qx) {
      const idx = qup ? +qup.dataset.qup : qdn ? +qdn.dataset.qdn : +qx.dataset.qx;
      if (qx) store.queue.splice(idx, 1);
      else { const j = idx + (qup ? -1 : 1); if (j >= 0 && j < store.queue.length) { const tmp = store.queue[idx]; store.queue[idx] = store.queue[j]; store.queue[j] = tmp; } }
      store.saveQueue(); paintQueue(); return;
    }
    const qa = t.closest("[data-qact]");
    if (qa) {
      const a = qa.dataset.qact;
      if (a === "play") mirrorTap(() => playQueueStock());
      else if (a === "clear") { store.queue.length = 0; store.saveQueue(); paintQueue(); }
      else if (a === "save") {
        const name = prompt("Playlist name:"); if (!name) return;
        let all = {}; try { all = JSON.parse(localStorage.getItem("mw-dj-playlists") || "{}"); } catch (_) {}
        all[name] = store.queue.slice();
        try { localStorage.setItem("mw-dj-playlists", JSON.stringify(all)); } catch (_) {}
        say("💾 Saved playlist \"" + name + "\".");
      } else if (a === "open") {
        const box = $(root, "#dj-playlists"); if (!box) return;
        box.hidden = !box.hidden;
        let all = {}; try { all = JSON.parse(localStorage.getItem("mw-dj-playlists") || "{}"); } catch (_) {}
        box.innerHTML = Object.keys(all).length ? Object.keys(all).map((n) => `<div class="dj-item"><span>📂 ${esc(n)} (${all[n].length})</span><button type="button" class="btn ghost sm" data-plload="${esc(n)}">Load</button></div>`).join("") : '<small class="muted">No saved playlists yet.</small>';
      }
      return;
    }
    const pll = t.closest("[data-plload]");
    if (pll) { let all = {}; try { all = JSON.parse(localStorage.getItem("mw-dj-playlists") || "{}"); } catch (_) {} const items = all[pll.dataset.plload] || []; store.queue.push(...items); store.saveQueue(); paintQueue(); say("📂 Playlist loaded into the queue."); return; }
    if (t.closest("[data-sched='add']") || t.closest("[data-sched]")) {
      const time = ($(root, "#sched-time") || {}).value, sel = $(root, "#sched-sel");
      const it = sel && store.queue[+sel.value];
      if (!time) { say("Pick a time first."); return; }
      if (!it) { say("The schedule pulls from the queue — add something first."); return; }
      S().schedQ = (S().schedQ || []).concat([{ time, title: it.title || "", src: it.src || "", yt: it.yt || "", at: Date.now() }]);
      store.save(true); paintQueue(); say("🗓 Scheduled " + (it.title || "") + " at " + time + "."); return;
    }
    const sx = t.closest("[data-schedx]"); if (sx) { S().schedQ.splice(+sx.dataset.schedx, 1); store.save(true); paintQueue(); return; }
    const vm = t.closest("[data-vmix]");
    if (vm) {
      const mode = vm.dataset.vmix;
      if (mode === "auto") S().vmix = Object.assign(S().vmix || {}, { mode: "auto", at: Date.now() });
      else { const tg = vmixTargets(S()); if (tg.length) S().vmix = { mode: "man", a: tg[0].k, b: tg[1] ? tg[1].k : "", t: mode === "cut" ? 1 : 0, tr: mode, trMs: 650, at: Date.now() }; }
      store.save(true); return;
    }
    const vsrc = t.closest("[data-vsrc]"); if (vsrc) { S().vmix = { mode: "man", a: vsrc.dataset.vsrc, b: "", t: 0, tr: "cut", trMs: 650, at: Date.now() }; store.save(true); say("Master screen: deck " + vsrc.dataset.vsrc + "."); return; }
    if (t.closest("#dj-cambtn")) { camToggle(); return; }
    if (t.closest("#dj-vlivebtn")) { if (R.share) R.share.toggle("cam"); else say("Live Video runs on the real station."); return; }
    if (t.closest("#st-watch")) { location.hash = "#watch"; return; }
    if (t.closest("#bn-listen")) { location.hash = "#radio"; return; }
    if (t.closest("#dj-takecontrol")) { await store.takeControl(); say("🎛 This screen is driving now."); paintOwner(); return; }
    if (t.closest("#dj-customize-btn")) { const c = $(root, "#dj-customize"); if (c) c.hidden = !c.hidden; return; }
    if (t.closest("#dj-reports-btn")) { const b = $(root, '[data-panelbody="reports"]'); if (b) { b.scrollIntoView({ block: "center" }); paintReports(b); } return; }
    const pop = t.closest("[data-pop]");
    if (pop) { const p = SETUPS[pop.dataset.pop]; if (p) { S().fx = Object.assign({}, S().fx, p); store.save(true); paintOwner(); say("🎚 Setup applied — crossfaders and deck volumes untouched."); } return; }
    const ed = t.closest("[data-ediv]"); if (ed) { S().fx.ediv = +ed.dataset.ediv; store.save(true); return; }
    const gt = t.closest("[data-gate]"); if (gt) { S().fx.gate = +gt.dataset.gate; store.save(true); paintOwner(); return; }
    const xc = t.closest("[data-xfc]"); if (xc) { S().xfCurve = xc.dataset.xfc; store.save(true); return; }
    if (t.closest("#dj-pan-center")) { S().panX = 0.5; R.xfTouchedAt = Date.now(); store.save(true); paintXfPads(); return; }
    const sw = t.closest("[data-swap]"); if (sw) { say("Deck swap rides the booth's deck-order tools — the layout itself never moves (your arrangement is the spec)."); return; }
    const dsec = t.closest("[data-dsec]");
    if (dsec) {
      const [k, id] = dsec.dataset.dsec.split(":");
      const body = dsec.nextElementSibling; if (body) body.hidden = !body.hidden;
      try { const all = JSON.parse(localStorage.getItem("mw-dsec-v1") || "{}"); all[id] = body ? !body.hidden : 1; localStorage.setItem("mw-dsec-v1", JSON.stringify(all)); } catch (_) {}
      return;
    }
    const hot = t.closest("[data-hot]");
    if (hot) { const [k, n] = hot.dataset.hot.split(":"); hotCue(k, +n, t); return; }
    const loopb = t.closest("[data-loopb]"); if (loopb) { const [k, b] = loopb.dataset.loopb.split(":"); setLoop(k, +b); return; }
    if (t.closest("[data-sync]")) { syncDeck(t.closest("[data-sync]").dataset.sync); return; }
    const roll = t.closest("[data-roll]"); if (roll) { const [k, b] = roll.dataset.roll.split(":"); setLoop(k, +b, true); return; }
    const bj = t.closest("[data-bjump]"); if (bj) { const [k, n] = bj.dataset.bjump.split(":"); beatJump(k, +n); return; }
    const tap = t.closest("[data-tap]"); if (tap) { tapTempo(tap.dataset.tap); return; }
    const ba = t.closest("[data-bpmadj]"); if (ba) { const [k, dv] = ba.dataset.bpmadj.split(":"); S()[k].bpm = Math.max(40, Math.round(((S()[k].bpm || 120) + (+dv)) * 10) / 10); store.save(); paintOwner(); return; }
    const bx = t.closest("[data-bpmx]"); if (bx) { const [k, f] = bx.dataset.bpmx.split(":"); S()[k].bpm = Math.max(40, Math.round((S()[k].bpm || 120) * (+f) * 10) / 10); store.save(); paintOwner(); return; }
    const nu = t.closest("[data-nudge]"); if (nu) { const [k, dv] = nu.dataset.nudge.split(":"); const d = R.decksEng.decks[k]; if (d.el) { try { if (d.el.seekTo) d.el.seekTo(Math.max(0, d.el.currentTime + (+dv) * 0.08)); else d.el.currentTime = Math.max(0, d.el.currentTime + (+dv) * 0.08); } catch (_) {} } return; }
    const vc = t.closest("[data-vcut]"); if (vc) { const k = vc.dataset.vcut; S()[k].vcut = !S()[k].vcut; store.save(); paintOwner(); return; }
    const bc = t.closest("[data-bcut]"); if (bc) { const k = bc.dataset.bcut; S()[k].bcut = !S()[k].bcut; store.save(); paintOwner(); return; }
    if (t.closest("[data-slip]")) { say("Slip rides with the deck's loop tools in this build."); return; }
    if (t.closest("[data-spin]")) { spinback(t.closest("[data-spin]").dataset.spin); return; }
    const fold = t.closest("[data-fold]");
    if (fold) {
      const id = fold.dataset.fold, body = $(root, `[data-panelbody="${id}"]`);
      if (body) { body.hidden = !body.hidden; fold.textContent = body.hidden ? "▸" : "▾"; try { const f = JSON.parse(localStorage.getItem("mw-v2-folds") || "{}"); f[id] = body.hidden ? 1 : 0; localStorage.setItem("mw-v2-folds", JSON.stringify(f)); } catch (_) {} }
      return;
    }
    const grip = t.closest("[data-grip]"); if (grip) { gripDrag(e, grip); return; }
    const bt2 = t.closest("[data-browtab]");
    if (bt2) { const name = bt2.dataset.browtab; $$(root, "[data-browpane]").forEach((p) => { p.hidden = p.dataset.browpane !== name; }); if (name === "cur") paintCurPane(); if (name === "prep") paintPrepPane(); if (name === "lib") paintLibPane(""); return; }
    const pad = t.closest("[data-pad]"); if (pad) { padPlay(+pad.dataset.pad); return; }
    const gr = t.closest("[data-grant]");
    if (gr) {
      const r = (R.reqCache || []).find((x) => x.id === gr.dataset.grant);
      if (r && r.data) {
        S().djGuest = { uid: r.data.uid, name: r.data.name || "", until: Date.now() + 60 * 60000, at: Date.now() };
        store.save(true);
        R.ctx.gateway.call("rest", { table: "docs", op: "delete", filters: [["path", "eq", "requests/" + r.id]] }).catch(() => {});
        say("🎛 " + (r.data.name || "Your guest") + " is on for the next hour.");
        renderReqPanels();
      }
      return;
    }
    const vfx = t.closest("[data-vfx]"); if (vfx) { S().vfx = { kind: vfx.dataset.vfx, at: Date.now() }; store.save(true); say("✨ Video FX stamped for every viewer."); return; }
    if (t.closest("#dj-ticker-set")) { const inp = $(root, "#dj-ticker-in"); S().ticker = (inp.value || "").trim().slice(0, 140); store.save(true); paintStation(); say(S().ticker ? "Ticker is on the station card." : "Ticker cleared."); return; }
    if (t.closest("#mic-on")) { micToggle(); return; }
    if (t.closest("#rec-btn")) { recToggle(); return; }
    if (t.closest("#ses-btn")) { sesToggle(); return; }
    if (t.closest("#dj-midi-on")) { midiEnable(); return; }
    if (t.closest("#dj-midi-learn")) { R.midiLearn = !R.midiLearn; say(R.midiLearn ? "🎹 Learn ON — move a control on your controller, then tap the booth control it should drive." : "🎹 Learn OFF."); return; }
    if (t.closest("#dj-midi-clear")) { try { localStorage.removeItem("mw-v2-midi"); } catch (_) {} R.midiMap = {}; paintMidiList(); return; }
    if (t.closest("#cp-banner-set")) { const v = ($(root, "#cp-banner-in") || {}).value || ""; const b = $(root, "#dj-cambanner"); if (b) { b.hidden = !v; b.textContent = v; } return; }
    const loadBtn = t.closest("[data-load]");
    if (loadBtn) { const item = browserItem(loadBtn); if (item) mirrorTap(() => load(loadBtn.dataset.load, item, { cue: true })); return; }
    const qBtn = t.closest("[data-addq]");
    if (qBtn) { const item = browserItem(qBtn); if (item) { store.queue.push(item); store.saveQueue(); paintQueue(); say("Added to the queue: " + (item.title || "")); } return; }
  });

/* a performance tap on a mirror takes control for real, first (Law:
   mirrors render; a tap claims). Then the action runs as the driver. */
async function mirrorTap(fn) {
  if (!R) return;
  if (R.store.serverMirror()) { await R.store.takeControl(); say("🎛 This screen is driving now."); }
  return fn();
}
function brakeFx(k) {
  const d = R.decksEng.decks[k]; if (!d || d.shim || !d.el) return;
  const el = d.el, r0 = el.playbackRate || 1; let p = 0;
  const iv = setInterval(() => { p += 0.08; try { el.playbackRate = Math.max(0.05, r0 * (1 - p)); } catch (_) {} if (p >= 1) { clearInterval(iv); try { el.pause(); el.playbackRate = R.S()[k].rate || 1; } catch (_) {} } }, 60);
}
function spinback(k) {
  const d = R.decksEng.decks[k]; if (!d || !d.el) return;
  const el = d.el; let n = 0;
  const iv = setInterval(() => { n++; try { if (el.seekTo) el.seekTo(Math.max(0, el.currentTime - 0.12)); else el.currentTime = Math.max(0, el.currentTime - 0.12); } catch (_) {} if (n > 14) clearInterval(iv); }, 50);
}
function hotCue(k, n, btn) {
  const S = R.S(), s = S[k], d = R.decksEng.decks[k];
  s.cues = s.cues || {};
  const key = "h" + n;
  if (s.cues[key] == null) { s.cues[key] = d.el && typeof d.el.currentTime === "number" ? d.el.currentTime : posOf(S, k, Date.now()); if (btn) btn.textContent = "Hot " + n + " ●"; say("🎯 Hot cue " + n + " set on deck " + k + "."); }
  else { try { if (d.el.seekTo) d.el.seekTo(s.cues[key]); else d.el.currentTime = s.cues[key]; } catch (_) {} s.pos = s.cues[key]; s.start = Date.now() - s.cues[key] * 1000; }
  R.store.save();
}
function setLoop(k, beats, roll) {
  const S = R.S(), s = S[k], d = R.decksEng.decks[k];
  if (s.loop) { s.loop = null; say("Loop off on deck " + k + "."); R.store.save(); paintOwner(); return; }
  const bpm = s.bpm || 120, pos = d.el && typeof d.el.currentTime === "number" ? d.el.currentTime : posOf(S, k, Date.now());
  const len = beats * 60 / bpm;
  s.loop = { a: pos, b: pos + len }; s.loopBeats = beats;
  say((roll ? "Roll " : "Loop ") + beats + " on deck " + k + ".");
  R.store.save();
}
function beatJump(k, beats) {
  const S = R.S(), s = S[k], d = R.decksEng.decks[k]; if (!d.el) return;
  const delta = beats * 60 / (s.bpm || 120);
  try { const to = Math.max(0, (d.el.currentTime || 0) + delta); if (d.el.seekTo) d.el.seekTo(to); else d.el.currentTime = to; s.pos = to; s.start = Date.now() - to * 1000; } catch (_) {}
  R.store.save();
}
let tapTimes = [];
function tapTempo(k) {
  const now = performance.now();
  tapTimes = tapTimes.filter((t) => now - t < 2000); tapTimes.push(now);
  if (tapTimes.length > 2) {
    const iv = (tapTimes[tapTimes.length - 1] - tapTimes[0]) / (tapTimes.length - 1);
    R.S()[k].bpm = Math.round(60000 / iv * 10) / 10;
    R.store.save(); paintOwner();
  }
}
function syncDeck(k) {
  const S = R.S();
  const other = DECKS.find((x) => x !== k && S[x].playing && S[x].bpm);
  if (!other) { say("No playing deck to sync to."); return; }
  S[k].bpm = S[other].bpm;
  const d = R.decksEng.decks[k];
  if (d.el && !d.shim) { try { d.el.playbackRate = (S[k].rate || 1); } catch (_) {} }
  R.store.save(); paintOwner(); say("SYNC — deck " + k + " matched to " + S[other].bpm + " BPM.");
}
/* ---------- banner / booth actions ---------- */
function boothAction(act) {
  if (act === "capture") { if (R && R.share) R.share.toggle("screen"); else say("Capture runs on the owner's booth on the real station."); return; }
  if (act === "hide") { if (R && R.share) R.share.toggleHide(); else if (R) { R.S().vstream.hidden = !R.S().vstream.hidden; R.store.save(true); paintShareBtns(); } return; }
  if (act === "blackout") {
    let ov = document.getElementById("dj-blackout");
    if (!ov) {
      ov = document.createElement("div"); ov.id = "dj-blackout"; ov.innerHTML = "";
      document.body.appendChild(ov);
      // tap does NOTHING (his law); desktop exits on any key; a phone
      // exits by locking and returning (visibility round-trip)
      let wentHidden = false;
      document.addEventListener("keydown", () => { if (ov) ov.remove(); ov = null; });
      document.addEventListener("visibilitychange", () => {
        if (document.visibilityState === "hidden") wentHidden = true;
        else if (wentHidden && ov) { ov.remove(); ov = null; }
      });
    }
    return;
  }
  if (act === "bubble") {
    let b = document.getElementById("mw-bubble");
    if (!b) {
      b = document.createElement("button"); b.id = "mw-bubble"; b.textContent = "DJ";
      b.addEventListener("click", () => { b.remove(); window.scrollTo({ top: 0, behavior: "smooth" }); });
      document.body.appendChild(b);
    }
    say("🫧 Bubble is up — tap it to jump back to the booth.");
  }
}
/* ---------- camera + mic + record ---------- */
async function camToggle() {
  if (!R) return;
  const vid = $(R.root, "#dj-camvid"), wrap = $(R.root, "#dj-camwrap");
  if (R.camOn) {
    R.camOn = false;
    try { R.camStream && R.camStream.getTracks().forEach((t) => t.stop()); } catch (_) {}
    R.camStream = null;
    if (wrap) wrap.hidden = true;
    R.S().vcam = { on: false, at: Date.now() }; R.store.save(true);
    return;
  }
  try {
    R.camStream = await navigator.mediaDevices.getUserMedia({ video: { width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false });
    if (vid) vid.srcObject = R.camStream;
    if (wrap) wrap.hidden = false;
    R.camOn = true;
    R.S().vcam = { on: true, at: Date.now() }; R.store.save(true);
  } catch (_) { say("📷 The camera would not open — allow it for this site and try again."); }
}
async function micToggle() {
  if (!R) return;
  const btn = $(R.root, "#mic-on");
  if (R.micStream) {
    try { R.micStream.getTracks().forEach((t) => t.stop()); } catch (_) {}
    R.micStream = null; R.micHot = 0;
    if (btn) btn.textContent = "🎤 Mic on";
    return;
  }
  try {
    R.micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const src = R.decksEng.graph.ctx.createMediaStreamSource(R.micStream);
    src.connect(R.decksEng.graph.micGain);
    if (btn) btn.textContent = "🎤 Mic off";
    say("🎤 Mic is live — it rides the record bus and ducks the music when you talk.");
  } catch (_) { say("🎤 The mic would not open — allow it for this site and try again."); }
}
function recToggle() {
  if (!R) return;
  const btn = $(R.root, "#rec-btn"), st = $(R.root, "#rec-st"), out = $(R.root, "#rec-out");
  if (R.rec) { R.rec.stop(); return; }
  try {
    const mr = new MediaRecorder(R.decksEng.graph.recDest.stream);
    const chunks = [];
    mr.addEventListener("dataavailable", (e) => chunks.push(e.data));
    mr.addEventListener("stop", () => {
      R.rec = null;
      if (btn) btn.textContent = "⏺ Record the show (audio)";
      if (st) st.textContent = "";
      const url = URL.createObjectURL(new Blob(chunks, { type: "audio/webm" }));
      if (out) out.innerHTML = `<a class="btn sm" href="${url}" download="meechies-world-show.webm">⬇ Download the show</a>`;
    });
    mr.start(1000); R.rec = mr;
    if (btn) btn.textContent = "⏹ Stop recording";
    if (st) st.textContent = "Recording…";
  } catch (_) { say("Recording would not start on this browser."); }
}
async function sesToggle() {
  if (!R) return;
  const btn = $(R.root, "#ses-btn"), st = $(R.root, "#ses-st"), out = $(R.root, "#ses-out");
  if (R.sesRec) { R.sesRec.stop(); return; }
  try {
    const stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
    const mr = new MediaRecorder(stream);
    const chunks = [];
    mr.addEventListener("dataavailable", (e) => chunks.push(e.data));
    mr.addEventListener("stop", () => {
      R.sesRec = null;
      stream.getTracks().forEach((t) => t.stop());
      if (btn) btn.textContent = "🎥 Record session video";
      if (st) st.textContent = "";
      const url = URL.createObjectURL(new Blob(chunks, { type: "video/webm" }));
      if (out) out.innerHTML = `<a class="btn sm" href="${url}" download="meechies-world-session.webm">⬇ Download the session video</a>`;
    });
    mr.start(1000); R.sesRec = mr;
    if (btn) btn.textContent = "⏹ Stop session video";
    if (st) st.textContent = "Filming the tab…";
  } catch (_) { say("Session video needs a screen pick — tap again and choose this tab."); }
}
/* ---------- MIDI (compact): CC map + notes, learn-by-next-touch ---- */
function paintMidiList() {
  if (!R) return;
  const box = $(R.root, "#dj-midi-list"); if (!box) return;
  const map = R.midiMap || {};
  const rows = Object.entries(map);
  box.innerHTML = rows.length ? rows.map(([cc, target]) => `<div class="dj-item"><span>CC ${esc(cc)}</span><small class="muted">${esc(target)}</small></div>`).join("") : '<small class="muted">No controls mapped yet. Enable MIDI, turn Learn on, move a knob, then move the booth control it should drive.</small>';
  const st = $(R.root, "#dj-midi-stat");
  if (st) st.textContent = R.midiAccess ? "MIDI is on — " + rows.length + " controls mapped." : "MIDI is off.";
}
async function midiEnable() {
  if (!R) return;
  if (!navigator.requestMIDIAccess) { say("🎹 MIDI needs Chrome or Edge on a computer."); return; }
  try {
    R.midiAccess = await navigator.requestMIDIAccess();
    try { R.midiMap = JSON.parse(localStorage.getItem("mw-v2-midi") || "{}"); } catch (_) { R.midiMap = {}; }
    const hook = () => { R.midiAccess.inputs.forEach((inp) => { inp.onmidimessage = onMidiMsg; }); };
    hook(); R.midiAccess.addEventListener("statechange", hook);
    paintMidiList(); say("🎹 MIDI is on.");
  } catch (_) { say("🎹 MIDI would not open."); }
}
function onMidiMsg(e) {
  if (!R) return;
  const [st, d1, d2] = e.data;
  const cmd = st & 0xf0;
  if (cmd === 0x90 && d2 > 0) { // notes 60-63 = play A-D
    const k = DECKS[d1 - 60];
    if (k) mirrorTap(() => togglePlay(k));
    return;
  }
  if (cmd !== 0xb0) return;
  const cc = String(d1), val = d2 / 127;
  if (R.midiLearn) {
    R.midiPending = cc;
    say("🎹 Got CC " + cc + " — now move the booth control it should drive.");
    return;
  }
  const target = (R.midiMap || {})[cc];
  if (target) midiApply(target, val);
}
function midiApply(target, val) {
  const S = R.S(), store = R.store;
  if (target === "xf") S.xf = val;
  else if (target === "xf2") S.xf2 = val;
  else if (target === "panX") { S.panX = val; R.xfTouchedAt = Date.now(); }
  else if (target === "master") R.decksEng.graph.setMasterVol(val * 1.5);
  else if (target.startsWith("vol:")) S[target.slice(4)].vol = val * 2;
  else if (target.startsWith("fx:")) S.fx[target.slice(3)] = val;
  store.save(); R.decksEng.levels(); paintOwner();
}
function midiLearnBind(target) {
  if (!R || !R.midiLearn || !R.midiPending) return;
  R.midiMap = R.midiMap || {};
  R.midiMap[R.midiPending] = target;
  try { localStorage.setItem("mw-v2-midi", JSON.stringify(R.midiMap)); } catch (_) {}
  say("🎹 CC " + R.midiPending + " now drives " + target + ".");
  R.midiPending = null;
  paintMidiList();
}

  /* ---- switches ---- */
  root.addEventListener("change", (e) => {
    if (!R) return;
    const t = e.target;
    if (t.id === "dj-golive") { S().live = t.checked; if (t.checked && !S().liveSince) S().liveSince = Date.now(); if (!t.checked) S().liveSince = 0; store.save(true); paintOwner(); return; }
    if (t.id === "dj-ad-top") { S().autodj = t.checked; store.save(true); return; }
    if (t.id === "dj-horn-top") { S().hornOn = t.checked; store.save(true); say(t.checked ? "📣 Horns ON for automated transitions." : "📣 Horns OFF."); return; }
    if (t.id === "ad-on") { S().autodj = t.checked; store.save(true); paintOwner(); return; }
    if (t.id === "ad-drops") { S().dropsOn = t.checked; store.save(true); return; }
    if (t.id === "dj-quant") { S().quant = t.checked; store.save(); return; }
    if (t.id === "dj-fxsync") { S().fx.sync = t.checked; store.save(); return; }
    if (t.id === "mic-mon") { try { R.decksEng.graph.micMon.gain.value = t.checked ? 0.9 : 0; } catch (_) {} return; }
    if (t.dataset && t.dataset.vinyl) { S()[t.dataset.vinyl].vinyl = t.checked; store.save(); return; }
  });
  /* ---- sliders (input) ---- */
  root.addEventListener("input", (e) => {
    if (!R) return;
    const t = e.target, v = parseFloat(t.value);
    if (isNaN(v)) return;
    if (t.id === "dj-master") { R.decksEng.graph.setMasterVol(v); midiLearnBind("master"); return; }
    const fxMap = { "dj-boost": "boost", "dj-filter": "mf", "dj-echo": "echo", "dj-fb": "fb", "dj-verb": "verb", "dj-fla": "fla", "dj-pha": "pha", "dj-noise": "noise", "dj-crush": "crush" };
    if (fxMap[t.id]) { S().fx[fxMap[t.id]] = v; R.decksEng.applyFx(0); store.save(); midiLearnBind("fx:" + fxMap[t.id]); return; }
    if (t.dataset.xvol) { S()[t.dataset.xvol].vol = v; R.decksEng.levels(); store.save(); midiLearnBind("vol:" + t.dataset.xvol); return; }
    if (t.dataset.vol) { S()[t.dataset.vol].vol = v; R.decksEng.levels(); store.save(); return; }
    if (t.dataset.eq) { const [k, band] = t.dataset.eq.split(":"); const s = S()[k]; s.eq = s.eq || { lo: 0, mid: 0, hi: 0 }; s.eq[band] = v; R.decksEng.decks[k].applyDeckFx(s); store.save(); return; }
    if (t.dataset.flt) { const k = t.dataset.flt; S()[k].flt = v; R.decksEng.decks[k].applyDeckFx(S()[k]); store.save(); return; }
    if (t.dataset.pitch) { const k = t.dataset.pitch; S()[k].rate = v; const d = R.decksEng.decks[k]; if (d.el && !d.shim) { try { d.el.playbackRate = v; } catch (_) {} } const pv = $(root, "#pit-v-" + k); if (pv) pv.textContent = v.toFixed(2) + "×"; store.save(); return; }
    if (t.id && t.id.startsWith("cp-")) {
      const vid = $(root, "#dj-camvid");
      if (vid) { const b = ($(root, "#cp-b") || {}).value || 100, c = ($(root, "#cp-c") || {}).value || 100, s2 = ($(root, "#cp-s") || {}).value || 100; vid.style.filter = `brightness(${b}%) contrast(${c}%) saturate(${s2}%)`; }
      return;
    }
  });
  /* ---- forms: search, archive, library, pads ---- */
  const ytform = $(root, "#dj-ytform");
  if (ytform) ytform.addEventListener("submit", async (e) => {
    e.preventDefault();
    const q = $(root, "#dj-ytq").value.trim(); if (!q) return;
    const box = $(root, "#dj-ytres"); if (box) box.innerHTML = '<small class="muted">Searching…</small>';
    try {
      const r = await fetch("/api/ytsearch?q=" + encodeURIComponent(q) + "&page=1");
      const j = await r.json().catch(() => null);
      const items = (j && (j.results || j.items || j.videos)) || [];
      R.ytRes = items.map((x) => ({ yt: x.id || x.videoId || "", title: x.title || "", dur: x.duration || x.dur || 0 }));
      if (box) box.innerHTML = R.ytRes.length ? R.ytRes.map((it, i) => rowHTML(it, i)).join("") : '<small class="muted">Nothing playable found — the search only returns videos that can actually play here.</small>';
    } catch (_) { if (box) box.innerHTML = '<small class="muted">Search is busy. Try again in a moment.</small>'; }
  });
  const sf = $(root, "#dj-sf");
  if (sf) sf.addEventListener("submit", async (e) => {
    e.preventDefault();
    const q = $(root, "#dj-q").value.trim(); if (!q) return;
    const box = $(root, "#dj-net"); if (box) box.innerHTML = '<small class="muted">Searching…</small>';
    try { R.net = await iaSearch(q); if (box) box.innerHTML = R.net.length ? R.net.map((n, i) => `<div class="dj-item"><span title="${esc(n.title)}">${esc(n.title)}</span>${DECKS.map((k) => `<button type="button" class="btn ghost sm" data-load="${k}" data-net="${i}">${k}</button>`).join("")}<button type="button" class="btn ghost sm" data-netq="${i}">＋Q</button></div>`).join("") : '<small class="muted">Nothing found. Try another word.</small>'; }
    catch (_) { if (box) box.innerHTML = '<small class="muted">Search is busy. Try again in a moment.</small>'; }
  });
  const libform = $(root, "#dj-libform");
  if (libform) libform.addEventListener("submit", (e) => { e.preventDefault(); paintLibPane($(root, "#dj-libq").value.trim()); });
  const padForm = $(root, "#pad-form");
  if (padForm) padForm.addEventListener("submit", (e) => {
    e.preventDefault();
    const name = $(root, "#pad-name").value.trim(), url = $(root, "#pad-url").value.trim();
    if (!url) { say("Give the pad a sound file URL."); return; }
    S().pads = (S().pads || []).concat([{ id: "pad" + Date.now().toString(36), name: name || "Pad", url }]);
    store.save(true); paintPanel("pads"); say("🔊 Pad added — it shows inside every deck too.");
  });
  /* net rows resolve through the Archive on tap (delegated, async) */
  root.addEventListener("click", async (e) => {
    if (!R) return;
    const nb = e.target.closest("[data-net]"), nq = e.target.closest("[data-netq]");
    if (nb || nq) {
      const node = R.net[nb ? +nb.dataset.net : +nq.dataset.netq];
      if (!node) return;
      const src = await iaFile(node.id);
      if (!src) { say("That Archive item has no playable file."); return; }
      const item = { src, title: node.title, cover: "https://archive.org/services/img/" + encodeURIComponent(node.id) };
      if (nb) mirrorTap(() => load(nb.dataset.load, item, { cue: true }));
      else { store.queue.push(item); store.saveQueue(); paintQueue(); say("Added to the queue."); }
      return;
    }
    const fb = e.target.closest("[data-freeload]");
    if (fb) {
      const [kind, i, k] = fb.dataset.freeload.split(":");
      const t = (kind === "m" ? FREE_MEDIA.music : FREE_MEDIA.videos)[+i];
      if (t) mirrorTap(() => load(k, { src: t.src, title: t.t + " — " + t.a, cover: t.cover, dur: t.dur }, { cue: true }));
      return;
    }
  });
  function rowHTML(it, i) {
    return `<div class="dj-item"><span title="${esc(it.title)}">${esc(it.title)}</span>${DECKS.map((k) => `<button type="button" class="btn ghost sm" data-load="${k}" data-bi="${i}">${k}</button>`).join("")}<button type="button" class="btn ghost sm" data-addq="1" data-bi="${i}">＋Q</button></div>`;
  }
  function browserItem(btn) {
    const i = +(btn.dataset.bi || 0);
    return (R.ytRes || [])[i] || null;
  }
  function paintLibPane(q) {
    const box = $(root, "#dj-lib"); if (!box) return;
    const items = FREE_MEDIA.music.map((t) => ({ src: t.src, title: t.t + " — " + t.a, cover: t.cover, dur: t.dur }))
      .concat((S().pool || []).map((p) => ({ src: p.src || "", iaId: p.iaId, title: p.title || "", cover: p.cover || "" })));
    const f = q ? items.filter((x) => (x.title || "").toLowerCase().includes(q.toLowerCase())) : items;
    R.ytRes = f;
    box.innerHTML = f.length ? f.map((it, i) => rowHTML(it, i)).join("") : '<small class="muted">Nothing on this shelf.</small>';
  }
  function paintCurPane() {
    const box = $(root, "#dj-cur"); if (!box) return;
    box.innerHTML = DECKS.map((k) => { const s = S()[k]; return `<div class="dj-item"><span>DECK ${k} — ${esc(s.title || "empty")}</span><small class="muted">${s.playing ? "▶ playing" : ""}</small></div>`; }).join("");
  }
  function paintPrepPane() {
    const prep = $(root, "#dj-prep"), hist = $(root, "#dj-hist");
    let items = [];
    try { items = JSON.parse(localStorage.getItem("mw-dj-hist") || "[]"); } catch (_) {}
    R.ytRes = items.map((h) => ({ src: h.src || "", yt: h.yt || "", title: h.title || "" }));
    if (hist) hist.innerHTML = "<b>Recently played</b>" + (items.length ? items.map((h, i) => rowHTML(R.ytRes[i], i)).join("") : '<small class="muted">Nothing yet.</small>');
    if (prep) prep.innerHTML = '<small class="muted">Prep list: your recent plays are below — load any of them back onto a deck.</small>';
  }
  // free shelf fill
  const em = $(root, "#dj-freem"), ev = $(root, "#dj-freev");
  if (em) em.innerHTML = FREE_MEDIA.music.map((t, i) => `<div class="dj-item"><span title="${esc(t.t)}">${esc(t.t)} — ${esc(t.a)}</span>${DECKS.map((k) => `<button type="button" class="btn ghost sm" data-freeload="m:${i}:${k}">${k}</button>`).join("")}</div>`).join("");
  if (ev) ev.innerHTML = FREE_MEDIA.videos.map((t, i) => `<div class="dj-item"><span title="${esc(t.t)}">${esc(t.t)}</span>${DECKS.map((k) => `<button type="button" class="btn ghost sm" data-freeload="v:${i}:${k}">${k}</button>`).join("")}</div>`).join("");
  paintLibPane("");
  /* ---- drags: X pad, pair faders (on the pairwaves), platters, waves ---- */
  const xpad = $(root, "#dj-xfpad");
  horizDrag(xpad, (ev) => {
    const r = xpad.getBoundingClientRect();
    S().panX = clamp((ev.clientX - r.left) / r.width, 0, 1);
    R.xfTouchedAt = Date.now();
    R.decksEng.levels(); paintXfPads(); midiLearnBind("panX");
  }, () => store.save(true));
  [["#pw-AB", "xf"], ["#pw-CD", "xf2"]].forEach(([sel, key]) => {
    const cv = $(root, sel); if (!cv) return;
    horizDrag(cv, (ev) => {
      const r = cv.getBoundingClientRect();
      S()[key] = clamp((ev.clientX - r.left) / r.width, 0, 1);
      R.xfTouchedAt = Date.now();
      R.decksEng.levels(); midiLearnBind(key);
    }, () => store.save(true));
  });
  for (const k of DECKS) {
    const pl = $(root, "#pl-" + k); if (!pl) continue;
    let wasPlaying = false;
    horizDrag(pl, (ev, dx) => {
      const d = R.decksEng.decks[k]; if (!d.el) return;
      if (!wasPlaying) wasPlaying = !!S()[k].playing;
      try { const to = Math.max(0, (d.el.currentTime || 0) + dx * 0.004); if (d.el.seekTo) d.el.seekTo(to); else d.el.currentTime = to; } catch (_) {}
    }, () => { const s = S()[k]; s.pos = posOf(S(), k, Date.now()); store.save(); });
    const wv = $(root, "#wv-" + k);
    if (wv) wv.addEventListener("click", (e) => {
      const s = S()[k], d = R.decksEng.decks[k];
      const dur = s.dur || (d.el && d.el.duration) || 0; if (!dur) return;
      const r = wv.getBoundingClientRect();
      const to = clamp((e.clientX - r.left) / r.width, 0, 1) * dur;
      try { if (d.el.seekTo) d.el.seekTo(to); else d.el.currentTime = to; } catch (_) {}
      s.pos = to; s.start = Date.now() - to * 1000; store.save();
    });
  }
  /* ---- talk button: hold to duck ---- */
  const talk = $(root, "#dj-talk");
  if (talk) {
    talk.addEventListener("pointerdown", () => { S().duck = true; store.save(); R.decksEng.levels(); });
    talk.addEventListener("pointerup", () => { S().duck = false; store.save(); R.decksEng.levels(); });
    talk.addEventListener("pointerleave", () => { if (S().duck) { S().duck = false; store.save(); R.decksEng.levels(); } });
  }
  /* ---- mic meter ---- */
  R.timers.push(setInterval(() => {
    if (!R || !R.micStream || !R.decksEng) return;
    const an = R.decksEng.graph.micAn;
    const a = new Uint8Array(an.fftSize); an.getByteTimeDomainData(a);
    let m = 0; for (let i = 0; i < a.length; i++) m = Math.max(m, Math.abs(a[i] - 128) / 128);
    R.micHot = m;
    const lvl = $(root, "#mic-lvl"); if (lvl) lvl.style.width = Math.round(m * 100) + "%";
    const duckOn = ($(root, "#mic-duck") || {}).checked !== false;
    R.decksEng.setMicHot(duckOn ? m : 0);
  }, 200));
  /* ---- fit on resize (never on scroll — Law 22) ---- */
  let fitT = null;
  addEventListener("resize", () => { clearTimeout(fitT); fitT = setTimeout(boothFit, 200); });
}
