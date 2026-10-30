/* ============================================================================
   v2 MW TV — the TV station's own fullscreen channel (MAP Law 1/2,
   Phase 2). The TV screen and nothing else: the same engine screen as
   every other surface, over the channel's own standby slate (the TV
   poster — Law 9, never swapped with the radio poster).

   Paint rules ported from the live tvApply/tvPaint/tvSlatePaint:
   - the slate speaks only from a real snapshot: a cold tab reads
     "TV: connecting…", never a false off-air;
   - the badge reads 🔴 LIVE for a share, ON AIR for the mix;
   - the sound button is the station's TUNE IN (the engine's one
     listening switch); Watch jumps to Watch the Setup; ⛶ fullscreens
     the channel shell.
   The guest wall already defers on this view (core, Law 10), and the
   mini never doubles up here (its onTV gate).

   THE POP-OUT AD BAR rides this view: the phone dock pops out to MW
   TV, and the popped-out screen carries a slim house-ad bar at the
   bottom of its frame (owner, 2026-10-30 — see the house-ad block
   below for the inventory, the rules, and the never-cover contract).
   ============================================================================ */

import { vmixTargets } from "../station.js";
import { getEngine } from "../engine.js";
import { mountMini } from "../mini.js";

/* ---------------- the POP-OUT AD BAR (owner, 2026-10-30 10:12:
   "when people pop up the screen i want a small add at the bottom
   of it") ----------------------------------------------------------
   The dock pops out to THIS view, and the popped-out screen carries
   a slim ad bar riding the bottom of its frame. The inventory and
   the rules are the live house ads (js/house-ads.js) exactly:
   Printify from /api/store + Shopify from /api/shopify (https
   product urls only; a digital product taps through to its buy
   link), one shuffled deck, a fresh pick every 12 s (never while
   the tab is hidden), and the shared mw_ad_hide stamp — closing
   the bar hides house ads everywhere for 24 hours. The small
   DOCKED state never carries the bar (mini.js has no ad code at
   all), and when nothing is eligible — no products back, or ads
   hidden for the day — the bar renders NOTHING: the element stays
   hidden and no space is reserved. The bar never covers the
   screen: it owns a strip at the bottom of the shell and the stage
   box gives up exactly the bar height (the tw-has-ad class in
   mwtv.css), so the top control bar and the stage's own chip /
   pause button stay clear by construction. The pure inventory +
   eligibility logic is exported bare for the harness. */
export const TW_AD_ROTATE_MS = 12000;
export const TW_AD_HIDE_MS = 24 * 3600 * 1000;
export const TW_AD_HIDE_KEY = "mw_ad_hide";

export function houseAdProducts(printify, shopify) {
  const pf = (Array.isArray(printify) ? printify : []).map((p) => ({ title: p.title, img: p.img, price: p.price, url: p.url, src: "Printify" }));
  const sh = (Array.isArray(shopify) ? shopify : []).filter((p) => /^https:\/\//.test(p.url || "")).map((p) => ({ title: p.title, img: p.img, price: p.price, url: (p.digital && p.buy) ? p.buy : p.url, src: "Shopify" }));
  return pf.concat(sh);
}
export function houseAdsHiddenAt(now, raw) { return now < (+raw || 0); }
export function twAdEligible(products, now, rawHide) {
  return !!(products && products.length) && !houseAdsHiddenAt(now, rawHide);
}
export function nextAdIndex(cur, len) { return len > 0 ? (cur + 1) % len : 0; }

let adTimer = 0, adSeq = 0;
function teardownTwAd() { if (adTimer) { clearInterval(adTimer); adTimer = 0; } adSeq++; }

function shuffleAds(a) { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); const t = a[i]; a[i] = a[j]; a[j] = t; } return a; }

function paintTwAd(bar, p) {
  bar.innerHTML = "";
  const a = document.createElement("a");
  a.className = "tw-ad-link"; a.href = p.url; a.target = "_blank"; a.rel = "noopener";
  if (p.img) { const img = document.createElement("img"); img.src = p.img; img.alt = ""; img.loading = "lazy"; a.appendChild(img); }
  const mid = document.createElement("span"); mid.className = "tw-ad-mid";
  const tag = document.createElement("span"); tag.className = "tw-ad-tag"; tag.textContent = "Meechie's World Merch · " + (p.src || "Ad");
  const ttl = document.createElement("span"); ttl.className = "tw-ad-title"; ttl.textContent = p.title || "";
  mid.append(tag, ttl); a.appendChild(mid);
  if (p.price) { const pr = document.createElement("span"); pr.className = "tw-ad-price"; pr.textContent = p.price; a.appendChild(pr); }
  const cta = document.createElement("span"); cta.className = "tw-ad-cta"; cta.textContent = "Shop now →"; a.appendChild(cta);
  const x = document.createElement("button");
  x.className = "tw-ad-x"; x.type = "button"; x.setAttribute("aria-label", "Hide ads for a day"); x.textContent = "×";
  x.addEventListener("click", () => {
    try { localStorage.setItem(TW_AD_HIDE_KEY, String(Date.now() + TW_AD_HIDE_MS)); } catch (_) {}
    teardownTwAd();
    const shell = bar.closest("#tw-shell"); if (shell) shell.classList.remove("tw-has-ad");
    bar.hidden = true; bar.innerHTML = "";
  });
  bar.append(a, x);
}

async function mountTwAdBar(root) {
  const bar = root.querySelector("#tw-adbar"); if (!bar) return;
  let rawHide = null; try { rawHide = localStorage.getItem(TW_AD_HIDE_KEY); } catch (_) {}
  if (houseAdsHiddenAt(Date.now(), rawHide)) return; /* hidden for the day: nothing renders */
  const seq = ++adSeq;
  let pf = [], sh = [];
  try { const r = await fetch("/api/store"); const j = await r.json().catch(() => null); pf = (j && j.products) || []; } catch (_) {}
  try { const r = await fetch("/api/shopify"); const j = await r.json().catch(() => null); sh = (j && j.products) || []; } catch (_) {}
  if (seq !== adSeq || !bar.isConnected) return; /* the view went away while fetching */
  let raw2 = null; try { raw2 = localStorage.getItem(TW_AD_HIDE_KEY); } catch (_) {}
  const products = shuffleAds(houseAdProducts(pf, sh));
  if (!twAdEligible(products, Date.now(), raw2)) return; /* no ad eligible: nothing renders */
  const shell = root.querySelector("#tw-shell");
  let ix = 0;
  paintTwAd(bar, products[ix]);
  bar.hidden = false;
  if (shell) shell.classList.add("tw-has-ad");
  if (products.length > 1) adTimer = setInterval(() => { if (document.hidden) return; ix = nextAdIndex(ix, products.length); paintTwAd(bar, products[ix]); }, TW_AD_ROTATE_MS);
}

const MARKUP = `
<div id="tw-shell">
  <div id="tw-stagebox">
    <div class="vstage" id="tw-stage">
      <div class="vslot" id="tw-vs1"></div>
      <div class="vslot" id="tw-vs2"></div>
      <div class="vstandby" id="tw-vstandby"><img class="tw-sb-art" src="/img/tv-poster.jpg" alt="" loading="eager" fetchpriority="high" decoding="async"><div class="tw-sb"><div class="tw-sb-logo">📺 MW TV</div><p>TV: connecting…</p></div></div>
      <div class="vchip" id="tw-vchip" hidden></div>
    </div>
  </div>
  <div id="tw-adbar" hidden></div>
  <div id="tw-bar">
    <span class="tw-mark">📺 MW TV</span>
    <span id="tw-live" class="tw-live" hidden>🔴 LIVE</span>
    <span id="tw-what" class="tw-what"></span>
    <span class="tw-sp"></span>
    <button type="button" class="btn ghost sm" id="tw-sound">🔇 Radio off — tap for sound</button>
    <button type="button" class="btn ghost sm" id="tw-watch">👀 Watch the setup</button>
    <button type="button" class="btn ghost sm" id="tw-fs" aria-label="Full screen">⛶</button>
    <a class="btn ghost sm" href="#home" data-go="home">← Meechie's World</a>
  </div>
</div>`;

let unsubs = [];
let engineRef = null, scrRef = null, tvSig = "", twSlateSig = "";
export function render(root, ctx) {
  root.innerHTML = MARKUP;
  const engine = getEngine(ctx);
  engineRef = engine;
  const feed = engine.feed;
  mountMini(ctx);
  tvSig = ""; twSlateSig = "";
  const scr = engine.createScreen({
    kind: "tv",
    stageEl: root.querySelector("#tw-stage"),
    slotEls: [root.querySelector("#tw-vs1"), root.querySelector("#tw-vs2")],
    standbyEl: root.querySelector("#tw-vstandby"),
    chipEl: root.querySelector("#tw-vchip"),
    posterEl: null,
  });
  scrRef = scr;

  mountTwAdBar(root);
  root.querySelector("#tw-sound").addEventListener("click", () => { engine.toggleListening(); tvSig = ""; tvPaint(root, engine, feed); });
  root.querySelector("#tw-watch").addEventListener("click", () => { engine.setListening(true); location.hash = "#watch"; });
  root.querySelector("#tw-fs").addEventListener("click", () => {
    const sh = root.querySelector("#tw-shell");
    try { if (document.fullscreenElement) document.exitFullscreen(); else if (sh && sh.requestFullscreen) sh.requestFullscreen(); } catch (_) {}
  });
  unsubs.push(engine.onListenChange(() => { tvSig = ""; }));

  engine.addSurface("tv", async () => {
    tvSlatePaint(root, feed);
    await engine.renderSurface(scr);
    // leaving any view pauses its <video> elements in the live shell —
    // if that caught the live stream on the way out, set it playing again
    const lv = root.querySelector("#tw-stage video.vslive");
    if (lv && lv.paused && (lv.srcObject || lv.currentSrc)) { try { const p = lv.play(); if (p && p.catch) p.catch(() => {}); } catch (_) {} }
    tvPaint(root, engine, feed);
  });
}

export function destroy() {
  teardownTwAd();
  unsubs.forEach((u) => { try { u(); } catch (_) {} });
  unsubs = [];
  if (engineRef) { engineRef.removeSurface("tv"); engineRef.destroyScreen(scrRef); }
  engineRef = null; scrRef = null;
}

/* the live tvSlatePaint: the slate's words are earned only by a
   snapshot — connecting, off-air, or live-on-the-tables */
function tvSlatePaint(root, feed) {
  const p = root.querySelector("#tw-vstandby .tw-sb p"); if (!p) return;
  const S = feed.S;
  const txt = !feed.seen ? "TV: connecting…" : (!S.live && !(S.vstream || {}).on && !vmixTargets(S).length) ? "Meechie is off air — the radio is always on." : "🔴 Meechie is live on the tables — the video mix appears here the moment a music video plays.";
  if (txt !== twSlateSig) { twSlateSig = txt; p.textContent = txt; }
}

function tvPaint(root, engine, feed) {
  const S = feed.S;
  const vs = S.vstream || {};
  let mode = "", label = "";
  if (vs.on && vs.meeting && !vs.hidden) { mode = "live"; label = vs.kind === "cam" ? "Meechie — live camera" : "Meechie — live screen"; }
  else { const tg = vmixTargets(S); if (tg.length) { mode = "mix"; label = "The video mix" + (S[tg[0].k] && S[tg[0].k].title ? " — " + S[tg[0].k].title : ""); } }
  const sig = mode + "|" + label + "|" + (engine.listening ? 1 : 0);
  if (sig === tvSig) return; tvSig = sig;
  const bd = root.querySelector("#tw-live"), wt = root.querySelector("#tw-what"), sb = root.querySelector("#tw-sound");
  if (bd) { bd.hidden = !mode; bd.classList.toggle("mix", mode === "mix"); bd.textContent = mode === "live" ? "🔴 LIVE" : "ON AIR"; }
  if (wt) wt.textContent = label;
  if (sb) sb.textContent = engine.listening ? "🔊 Radio on — tap to mute" : "🔇 Radio off — tap for sound";
}
