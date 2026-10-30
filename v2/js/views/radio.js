/* ============================================================================
   v2 RADIO VIEW — the RADIO station's viewer surface (MAP §4.3 viewer,
   Phase 2 read path).

   The station stage is an engine screen; this module owns only the
   markup and the card paint (the live paintStation, viewer half):
   the ON AIR lamp, the ticker, Now On Air, who's listening, the host
   line, the latest recorded show, RECENTLY PLAYED, and the stage box
   that carries the video mix + the master-screen share.

   The rest of the live radio view — the Library and its player, song
   requests, Pick-a-Song, the apps/poll/offline cards — are write or
   library-player surfaces of later phases and are not rebuilt here
   (see the Phase 2 differences list). Watching and listening are
   never gated (Law 12).
   ============================================================================ */

import { DECKS, vmixTargets, vsBroadcast, stationLive, esc } from "../station.js";
import { getEngine } from "../engine.js";
import { mountRails } from "../rails.js";

const agoT = (at) => new Date(at).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: "America/New_York" });
const gName = (g) => { const n = ((g && g.name) || "").trim(); return n ? (n.includes("@") ? n.split("@")[0] : n) : "Guest DJ"; };
const okUrl = (u) => typeof u === "string" && /^https?:\/\//.test(u);

const MARKUP = `
<div class="wrap">
  <div class="section-head">
    <div><p class="eyebrow">Meechie's World Radio</p><h2>Radio &amp; Music</h2></div>
    <p class="muted">Tune in to the station and hear the same song as everybody else at the same moment, or pick any track from the library and play it yourself.</p>
  </div>
  <div class="radio-top">
    <div class="onair" id="onair">
      <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:12px;flex-wrap:wrap">
        <span class="onair-flag off" id="onair-flag">● OFF AIR</span>
        <span class="muted" style="font-size:13px" id="listeners">0 listening</span>
      </div>
      <div class="freq">MWR 24/7<small>MEECHIE'S WORLD RADIO • CONSCIENTIA</small></div>
      <div class="now">
        <div class="cover" id="air-cover"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" style="color:var(--gold)"><circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="2.5"/></svg></div>
        <div><span class="eyebrow">Now on air</span><b id="air-title">The station starts when the first track is added</b><span id="air-artist"></span></div>
      </div>
      <div style="display:flex;gap:16px;align-items:center;flex-wrap:wrap">
        <button class="btn" type="button" id="tune-in">▶ Tune in</button>
        <div class="bars" aria-hidden="true"><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i></div>
      </div>
    </div>
  </div>
  <div class="station" id="dj-station">
    <div style="display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap"><h3>📻 Meechie's World Radio</h3><span style="display:flex;gap:8px;align-items:center"><span class="onair-lamp" id="st-lamp"><span class="dot"></span>CONNECTING</span><button class="btn ghost sm" type="button" id="st-fold" aria-label="Fold the station panel">▾</button></span></div>
    <div id="st-body">
    <div class="ticker" id="st-ticker" hidden><span id="st-ticker-t"></span></div>
    <div id="st-now" class="muted" style="font-size:14px">Connecting to the station…</div>
    <div id="st-online" class="muted" style="font-size:13px"></div>
    <div id="st-host" style="font-size:13.5px;font-weight:700;color:#ff8b8f" hidden></div>
    <button class="btn ghost sm" type="button" id="st-watch" style="margin:6px 0" hidden>👀 Watch Meechie's setup — live, look only</button>
    <div id="st-show"></div>
    <div id="st-ytbox" hidden><b style="font-size:12px;letter-spacing:.1em">📺 ON AIR — MUSIC VIDEO</b><div class="stage-row"><aside class="srail" id="st-rail-l" aria-label="From the shop"></aside><div class="stage-mid"><div class="vstage"><div class="vslot" id="st-vs1"></div><div class="vslot" id="st-vs2"></div><div class="vstandby" id="st-vstandby" style="white-space:pre-line">Meechie is live on the tables — the video mix lands here the moment a music video plays.</div><div class="vposter" id="st-vposter"><img src="/img/radio-promo-640.webp" alt="Meechie's World Radio" loading="lazy" decoding="async"></div><div class="vchip" id="st-vchip" hidden></div></div><div class="st-shout" id="st-shout" hidden></div><div class="stage-bar"><button class="btn" type="button" data-rqopen="st">🎤 SONG REQUEST / SHOUT-OUT</button><span class="rq-mystat" id="st-mystat"></span></div><div class="rq-form2" id="st-rqform" hidden><div class="dj-search"><input type="text" id="st-rq-song" maxlength="100" placeholder="Type a song — Meechie AI finds the video" aria-label="Song to request"><input type="text" id="st-rq-shout" maxlength="140" placeholder="Shout-out (optional) — it shows when your song plays" aria-label="Shout-out"></div><div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap"><button class="btn sm" type="button" data-rqgo="st">🎵 Request it</button><small class="muted">One request at a time. It joins the DJ queue and plays right after the current song — and its video takes the screen.</small></div><div class="rq-results" id="st-rqres"></div></div></div><aside class="srail" id="st-rail-r" aria-label="Promotions"></aside></div><div class="stage-strip" id="st-strip"></div></div>
    <div><b style="font-size:13px;letter-spacing:.1em">RECENTLY PLAYED</b><div class="loglist" id="st-log" style="margin-top:6px"></div></div>
    </div>
  </div>
</div>`;

let unsubs = [];
let engineRef = null, scrRef = null;
export function render(root, ctx) {
  root.innerHTML = MARKUP;
  const engine = getEngine(ctx);
  engineRef = engine;
  const feed = engine.feed;
  /* the cement band is shell furniture — core binds it at boot on
     every view; views no longer mount it themselves */
  const scr = engine.createScreen({
    kind: "stage",
    stageEl: root.querySelector("#st-ytbox .vstage"),
    slotEls: [root.querySelector("#st-vs1"), root.querySelector("#st-vs2")],
    standbyEl: root.querySelector("#st-vstandby"),
    chipEl: root.querySelector("#st-vchip"),
    posterEl: root.querySelector("#st-vposter"),
  });
  scrRef = scr;

  const tuneBtn = root.querySelector("#tune-in");
  const paintTune = () => { tuneBtn.textContent = engine.listening ? "❚❚ Stop the radio" : "▶ Tune in"; };
  tuneBtn.addEventListener("click", () => { engine.toggleListening(); });
  unsubs.push(engine.onListenChange(paintTune));
  paintTune();
  root.querySelector("#st-watch").addEventListener("click", () => { location.hash = "#watch"; });
  root.querySelector("#st-fold").addEventListener("click", () => { const b = root.querySelector("#st-body"); b.hidden = !b.hidden; });

  engine.addSurface("stage", async () => {
    /* the live stageApply, viewer branch: the box shows when the mix
       or a share exists, or the station is live; the slate is the
       table lineup while live with no video up */
    const S = feed.S;
    const has = vmixTargets(S).length > 0 || !!((S.vstream || {}).on && (S.vstream || {}).meeting);
    const box = root.querySelector("#st-ytbox"); if (box) box.hidden = !(has || S.live);
    if (has) await engine.renderSurface(scr);
    else if (S.live) {
      const sb = root.querySelector("#st-vstandby");
      if (sb) sb.textContent = stSlate(S);
      await engine.renderScreen(scr, true, 1, 1);
    } else {
      scr.slots.forEach((sl) => { sl.deck = ""; if (sl.p) { try { sl.p.pauseVideo(); } catch (_) {} } });
    }
  });

  const paint = () => paintStation(root, ctx, feed);
  unsubs.push(feed.subscribe(paint));
  paint();
  /* stage rails + the song request slot (js/rails.js; the live
     PR #427 contracts — the slot joins the DJ queue itself) */
  unsubs.push(mountRails(root, ctx, { prefix: "st", getS: () => feed.S }));
}

export function destroy() {
  unsubs.forEach((u) => { try { u(); } catch (_) {} });
  unsubs = [];
  if (engineRef) { engineRef.removeSurface("stage"); engineRef.destroyScreen(scrRef); }
  engineRef = null; scrRef = null;
}

/* PERSISTENT STAGE (Phase 5): Radio is a keep-alive view — the shell
   hides its section instead of destroying it, so the station stage
   and its sound never stop when the visitor navigates away (Law 5).
   Nothing suspends: the stage surface keeps rendering while hidden,
   exactly as the live site's always-mounted sections behave. */
export function suspend() {}
export function resume() {}

/* the member master screen never vanishes while Meechie is live: with
   no video playing yet it shows the table lineup (live stSlate) */
function stSlate(S) {
  const rows = DECKS.filter((k) => S[k] && (S[k].title || S[k].yt)).map((k) => "DECK " + k + " — " + (S[k].title || "Music video") + (S[k].playing ? " ▶ PLAYING" : ""));
  return "🔴 MEECHIE IS LIVE ON THE TABLES\n" + (rows.length ? rows.join("\n") : "Setting up the decks…") + "\nThe video mix appears right here the moment a music video plays.";
}

function renderLog(box, S) {
  if (!box) return;
  const lg = S.log || [];
  const sig = lg.length + ":" + (lg.length ? lg[0].at : 0) + ":" + Math.floor(Date.now() / 60000);
  if (box._logSig === sig) return;
  box._logSig = sig;
  box.innerHTML = lg.length ? lg.map((x) => `<div><span>${esc(x.t)}${x.live ? ' <small style="color:#ff8b8f">● LIVE</small>' : ""}</span><time>${agoT(x.at)}</time></div>`).join("") : '<small class="muted">Nothing played yet this session.</small>';
}

/* the live paintStation, viewer half (no state seen yet = never paint
   OFF AIR from default state) */
function paintStation(root, ctx, feed) {
  const S = feed.S;
  const lamp = root.querySelector("#st-lamp");
  if (!feed.seen) {
    if (lamp) { lamp.classList.toggle("on", false); if (lamp.lastChild) lamp.lastChild.textContent = "CONNECTING"; }
    /* the on-air card flag too: its static markup reads OFF AIR, so
       leaving it unpainted here was the transient OFF AIR flash on
       every cold entry — no snapshot yet means CONNECTING, never a
       false off-air (the same rule tvSlatePaint states for MW TV) */
    const flag0 = root.querySelector("#onair-flag"); if (flag0) { flag0.classList.toggle("off", true); flag0.textContent = "● CONNECTING"; }
    const now0 = root.querySelector("#st-now"); if (now0) now0.textContent = "Connecting to the station…";
    const sw0 = root.querySelector("#st-watch"); if (sw0) sw0.hidden = true;
    return;
  }
  const tvLive = vsBroadcast(S) && !(S.vstream || {}).hidden;
  const live = stationLive(S);
  if (lamp) { lamp.classList.toggle("on", live); if (lamp.lastChild) lamp.lastChild.textContent = live ? "ON AIR" : "OFF AIR"; }
  const tk = root.querySelector("#st-ticker");
  if (tk) { tk.hidden = !S.ticker; if (S.ticker) root.querySelector("#st-ticker-t").textContent = S.ticker; }
  const now = live ? DECKS.filter((k) => S[k].playing && !(S[k].dur && S[k].start && Date.now() - S[k].start > (S[k].dur + 45) * 1000)).map((k) => S[k].title).filter(Boolean) : [];
  const boothLive = S.boothAt && Date.now() - S.boothAt < 45000;
  const gN = S.djGuest && S.djGuest.until > Date.now() ? gName(S.djGuest) : null;
  const nowEl = root.querySelector("#st-now");
  if (nowEl) nowEl.textContent = tvLive && !now.length && !gN ? "📺 Meechie is live on the master screen — watch it on MW TV. The tables pick back up when the share ends." : live ? (now.length ? (boothLive ? "🎧 Live now: " : S.autodj ? "🤖 Auto-DJ live: " : "🎧 Live now: ") + now.join("  ×  ") : gN ? "🎧 " + gN + " is live on the decks." : "🎧 Meechie is live on the decks.") : "The station is on the playlist right now. When Meechie goes live on the decks, it shows up here.";
  const stWatch = root.querySelector("#st-watch"); if (stWatch) stWatch.hidden = !live;
  const stHost = root.querySelector("#st-host");
  if (stHost) { const hosting = live && !gN && (Date.now() - (S.boothAt || 0) < 90000); if (stHost._h !== hosting) { stHost._h = hosting; stHost.hidden = !hosting; if (hosting) stHost.textContent = "🔴 Meechie is in the booth — hosting live"; } }
  const stShow = root.querySelector("#st-show");
  const showSig = S.show ? String(S.show.url || "") + "|" + (+S.show.at || 0) + "|" + (S.show.video ? "v" : "a") : "";
  if (stShow && stShow._showSig !== showSig) {
    stShow._showSig = showSig;
    stShow.innerHTML = S.show && okUrl(S.show.url) ? "<b style=\"font-size:13px;letter-spacing:.1em\">" + (S.show.video ? "🎬 LATEST SESSION VIDEO" : "🎙️ LATEST RECORDED SHOW") + "</b>" + (S.show.video ? "<video controls preload=\"none\" src=\"" + esc(S.show.url) + "\" style=\"width:100%;margin-top:6px;border-radius:10px;background:#000\"></video>" : "<audio controls preload=\"none\" src=\"" + esc(S.show.url) + "\" style=\"width:100%;margin-top:6px\"></audio>") + "<small class=\"muted\">Recorded " + new Date(S.show.at).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: "America/New_York" }) + "</small>" : "";
  }
  /* presence line (the live paintOnline station-card text) */
  const p = ctx.presence && ctx.presence.last;
  const stOnline = root.querySelector("#st-online");
  if (p && stOnline) {
    const n = Array.isArray(p.users) ? p.users.length : (p.online || 0);
    const l = p.listening || 0;
    stOnline.textContent = l > 0 ? "🎧 " + l + " listening on the decks right now · " + n + " on the site" : n + " on the site right now";
    const li = root.querySelector("#listeners"); if (li) li.textContent = l + " listening";
  }
  /* the on-air card (live index.html #onair, painted by the shell's
     station bar on the live site) */
  const flag = root.querySelector("#onair-flag");
  if (flag) { flag.classList.toggle("off", !live); flag.textContent = live ? "● ON AIR" : "● OFF AIR"; }
  const airTitle = root.querySelector("#air-title");
  if (airTitle && now.length) airTitle.textContent = now.join("  ×  ");
  renderLog(root.querySelector("#st-log"), S);
}
