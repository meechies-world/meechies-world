/* ============================================================================
   v2 STAGE RAILS + SONG REQUEST SLOT (Phase 5 follow-on, mirroring
   the live build of 2026-10-30, PR #427 — same contracts, same
   words): the Radio stage and the Watch master screen wear his
   shop and promos on both sides (the shop union, Printify first),
   folding to one slim strip under the screen under 1024px; the
   poster and the live share FILL their frame (cover-fit, in
   engine.css). The 🎤 slot under the screen joins the DJ SETUP'S
   OWN QUEUE through the existing listener-pick path — there is no
   separate listener queue: Meechie AI finds the video through
   /api/ytsearch (playability-filtered), the top playable result is
   enqueued as a YouTube pick {kind:"pick", yt, shoutout, rqid},
   the pick waits at the head of the queue line, and when it plays
   its video takes the master screen through the normal vmix flow.
   The shout-out rides the pick into S.shout and shows on both
   stages while the song plays. Position = the requester's place
   among the picks in the line; notices fire on line-entry, up-next
   and start. One active request per listener (the station door
   answers 409 one_at_a_time for guests; members are held to the
   same rule by the slot itself).
   The same promo rotation paints the pop-out ad bar (mountAdBar):
   MW TV's slim bottom strip — the small docked state stays ad-free.
   ============================================================================ */

import { loadShopFeed, toast as say } from "./commerce.js";
import { firestore, esc as E } from "./platform.js";

/* FIFO position of one pick in the line: picks are the pending
   listener-pick docs sorted oldest-first; position is 1-based,
   0 when the pick is not in the line. Pure — harness-tested. */
export function pickPosition(picks, rqid) {
  if (!rqid || !Array.isArray(picks)) return 0;
  const i = picks.findIndex((x) => x && x.rqid && x.rqid === rqid);
  return i >= 0 ? i + 1 : 0;
}

export const RAIL_PROMOS = [
  { tag: "MEECHIE'S WORLD TV", html: "<b>MW TV</b> — the master screen, full-screen. Whatever Meechie puts on it takes over the station.", href: "#mwtv" },
  { tag: "THE GAMES", html: "<b>Coin Jackpot</b> — play the games, win coins, cash out real money.", href: "#games" },
  { tag: "FROM THE STORES", html: "<b>New drops land in the Shop first</b> — apparel, books and more, straight from Meechie's World.", href: "#shop" },
  { tag: "THE RADIO", html: "<b>Requests are open</b> — tap the request button under the screen and Meechie AI lines your song up in the DJ queue.", href: "#radio" },
];

/* ---------------- rails data: the shop union, shuffled once ------- */
let railData = null, railIx = 0, railBusy = false;
const painters = new Set();
async function railLoad() {
  if (railData || railBusy) return; railBusy = true;
  try {
    const feed = await loadShopFeed();
    const mix = (feed || []).map((x) => ({ title: x.title, img: x.img, price: x.price, url: x.url, src: x.src }));
    for (let i = mix.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); const t = mix[i]; mix[i] = mix[j]; mix[j] = t; }
    railData = mix;
  } catch (_) { if (!railData) railData = []; }
  railBusy = false; paintAll();
}
function railCard(x) { return `<a class="srcard" href="${E(x.url)}" target="_blank" rel="noopener">${x.img ? `<img src="${E(x.img)}" alt="" loading="lazy" decoding="async">` : ""}<span class="srcard-b"><span class="srcard-t">🛍️ ${E(x.src || "SHOP")}</span><span class="srcard-n">${E(x.title)}</span>${x.price ? `<span class="srcard-p">${E(x.price)}</span>` : ""}</span></a>`; }
function railPromo(pr) { return `<a class="srpromo" href="${pr.href}"><span class="srcard-t">${E(pr.tag)}</span><br>${pr.html}</a>`; }
function railAnnounce() { try { const bar = document.getElementById("announce"), t = document.getElementById("announce-text"); if (bar && !bar.hidden && t && t.textContent.trim()) return { tag: "📣 FROM MEECHIE", html: E(t.textContent.trim().slice(0, 160)), href: "#home" }; } catch (_) {} return null; }
function paintStrip(el) {
  if (!el) return;
  const prods = railData || [];
  const item = prods.length ? prods[railIx % prods.length] : null;
  const pr = RAIL_PROMOS[railIx % RAIL_PROMOS.length];
  if (item && railIx % 2 === 0) { el.innerHTML = `<a href="${E(item.url)}" target="_blank" rel="noopener">${item.img ? `<img src="${E(item.img)}" alt="" loading="lazy" decoding="async">` : ""}<span>🛍️ ${E(item.title)}${item.price ? " · " + E(item.price) : ""}</span></a>`; el.classList.add("on"); }
  else { el.innerHTML = `<a href="${pr.href}"><span>${E(pr.tag)} — ${pr.html.replace(/<[^>]+>/g, "")}</span></a>`; el.classList.add("on"); }
}
function paintAll() { painters.forEach((p) => { try { p(); } catch (_) {} }); }
setInterval(() => {
  if (document.hidden || !painters.size) return;
  if (!railData) { railLoad(); return; }
  railIx++; paintAll();
}, 12000);

/* the pop-out ad bar: the same rotation as a single slim strip.
   Lives on MW TV (the popped-out screen) — never on the dock. */
export function mountAdBar(el) {
  if (!el) return () => {};
  const p = () => paintStrip(el);
  painters.add(p); p(); if (!railData) railLoad();
  return () => painters.delete(p);
}

/* ---------------- the request line (shared by both stages) -------- */
let pkLine = [];
let rqMine = null; try { rqMine = JSON.parse(localStorage.getItem("mw-rq-mine") || "null"); } catch (_) { rqMine = null; }
let rqLastPos = -1, rqGoneAt = 0, rqSnapSeen = false;
const mounts = new Set();
function rqMyPos() { return pickPosition(pkLine, rqMine && rqMine.rqid); }
function playingTitles(getS) { const S = getS() || {}; return ["A", "B", "C", "D"].filter((k) => S[k] && S[k].playing).map((k) => S[k].title || ""); }
function rqPaintMine() {
  rqSnapSeen = true;
  const pos = rqMyPos();
  let txt = "";
  if (rqMine && pos > 0) txt = "🎵 Your request “" + rqMine.title + "” is #" + pos + " in the DJ queue line" + (pos === 1 ? " — up next, right after this song" : "");
  else if (rqMine && rqGoneAt) txt = "🎵 Your request is starting…";
  mounts.forEach((m) => { const el = m.root.querySelector("#" + m.prefix + "-mystat"); if (el && el.textContent !== txt) el.textContent = txt; });
  if (!rqMine) { rqLastPos = 0; rqGoneAt = 0; return; }
  if (rqLastPos === -1) { rqLastPos = pos; if (pos > 0) rqGoneAt = 0; return; }
  if (pos > 0) {
    if (rqLastPos === 0 && !rqGoneAt) say("🎵 You're in the DJ queue line — #" + pos + " for “" + rqMine.title + "”");
    else if (pos === 1 && rqLastPos > 1) say("⏭ Your request is up next in the DJ queue: " + rqMine.title);
    rqGoneAt = 0; rqLastPos = pos; return;
  }
  const anyTitles = [...mounts].some((m) => playingTitles(m.getS).indexOf(rqMine.title) >= 0);
  if (anyTitles) {
    say("▶ Your song is playing now — and its video is on the master screen 📺 " + rqMine.title);
    rqMine = null; try { localStorage.removeItem("mw-rq-mine"); } catch (_) {} rqLastPos = 0; rqGoneAt = 0; return;
  }
  if (rqLastPos > 0 || rqGoneAt) {
    if (!rqGoneAt) rqGoneAt = Date.now();
    else if (Date.now() - rqGoneAt > 20000) { say("Your request left the DJ queue line — if it did not play, request it again."); rqMine = null; try { localStorage.removeItem("mw-rq-mine"); } catch (_) {} rqGoneAt = 0; }
  }
  rqLastPos = 0;
}
function rqPaintShouts() {
  mounts.forEach((m) => {
    const S = m.getS() || {};
    const sh = S.shout;
    const on = !!(sh && sh.text && sh.title && playingTitles(m.getS).indexOf(sh.title) >= 0 && (Date.now() - (sh.at || 0)) < 15 * 60000);
    const html = on ? "📣 <b>" + E(sh.by || "A listener") + "</b> — " + E(sh.text) + " <small class=\"muted\">· with “" + E(sh.title) + "”</small>" : "";
    const el = m.root.querySelector("#" + m.prefix + "-shout");
    if (!el) return;
    if (on) { if (el.innerHTML !== html) el.innerHTML = html; el.hidden = false; } else el.hidden = true;
  });
}
setInterval(() => { if (!mounts.size) return; try { rqPaintShouts(); } catch (_) {} try { if (rqSnapSeen) rqPaintMine(); } catch (_) {} }, 3000);

/* ---------------- search + enqueue (the live doors) --------------- */
async function ytSearch(q) {
  const r = await fetch("/api/ytsearch?q=" + encodeURIComponent(q) + "&page=1");
  const j = await r.json().catch(() => null);
  const items = (j && (j.results || j.items || j.videos)) || [];
  return items.map((x) => ({ id: x.id || x.videoId || "", title: x.title || "", dur: x.duration || x.dur || 0 })).filter((x) => x.id);
}
async function sendRequest(ctx, fdb, data) {
  if (fdb.base.me()) { try { await fdb.collection("requests").add(data); return; } catch (_) {} }
  const body = { kind: data.kind, title: data.title || "", cover: data.cover || "", dur: +data.dur || 0, text: data.text || "" };
  if (data.yt) { body.yt = data.yt; body.shoutout = data.shoutout || ""; body.by = data.by || ""; body.rqid = data.rqid || ""; }
  if (data.kind === "pick" && !data.yt) { if (!data.src) throw new Error("no src"); body.src = data.src; }
  const r = await fetch("/api/station", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  if (!r.ok) { let code = ""; try { code = (await r.json()).error || ""; } catch (_) {} const err = new Error(code || "request refused"); err.code = code; throw err; }
}

/* mountRails(root, ctx, { prefix: "st"|"wb", getS }) — wires the
   rails, the strip, the request slot and the shout banner inside
   one stage root. Returns the cleanup. */
export function mountRails(root, ctx, opts) {
  const prefix = opts.prefix, getS = opts.getS;
  const fdb = firestore(ctx);
  const m = { root, prefix, getS };
  mounts.add(m);
  const painter = () => {
    const l = root.querySelector("#" + prefix + "-rail-l"), r = root.querySelector("#" + prefix + "-rail-r");
    const prods = railData || [];
    const take = (n, off) => { const out = []; for (let i = 0; i < n && prods.length; i++) out.push(prods[(off + i) % prods.length]); return out; };
    const ann = railAnnounce();
    if (l) l.innerHTML = '<span class="srail-h">🛍️ FROM THE SHOP</span>' + (ann ? railPromo(ann) : "") + take(2, railIx * 2).map(railCard).join("");
    if (r) r.innerHTML = '<span class="srail-h">🔥 PROMOS</span>' + railPromo(RAIL_PROMOS[railIx % RAIL_PROMOS.length]) + take(2, railIx * 2 + 2).map(railCard).join("");
    paintStrip(root.querySelector("#" + prefix + "-strip"));
  };
  painters.add(painter); painter(); if (!railData) railLoad();

  const un = fdb.collection("requests").orderBy("at", "asc").limit(200).onSnapshot((s) => {
    pkLine = s.docs.map((d) => d.data()).filter((d) => d && d.kind === "pick");
    if (rqSnapSeen) rqPaintMine(); else rqPaintMine();
  }, () => {});

  const resCache = {};
  let busy = false;
  async function enqueue(it, shoutout) {
    const rqid = "r" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
    const s = ctx.session.get(); const u = s && s.user;
    const by = u ? String(u.name || u.email || "Member").slice(0, 40) : "Guest";
    const data = { kind: "pick", yt: String(it.id), title: String(it.title || "YouTube video").slice(0, 120), cover: "https://i.ytimg.com/vi/" + it.id + "/hqdefault.jpg", dur: Math.max(0, Math.min(3600, +it.dur || 0)), shoutout: String(shoutout || "").slice(0, 140), by, rqid, at: Date.now() };
    try { await sendRequest(ctx, fdb, data); }
    catch (e) {
      if (e && e.code === "one_at_a_time") { say("One request at a time — you already have one in the DJ queue line 🎵"); return; }
      if (e && e.code === "slow_down") { say("Easy — too many requests at once. Give it a minute."); return; }
      say("That request did not go through — wait a few seconds and try again."); return;
    }
    rqMine = { rqid, title: data.title, shoutout: data.shoutout }; try { localStorage.setItem("mw-rq-mine", JSON.stringify(rqMine)); } catch (_) {}
    say("🎵 Requested: " + data.title + " — it is in the DJ queue line and plays right after the current song.");
  }
  async function submit() {
    if (busy) return;
    const songEl = root.querySelector("#" + prefix + "-rq-song"), shoutEl = root.querySelector("#" + prefix + "-rq-shout"), resEl = root.querySelector("#" + prefix + "-rqres");
    const q = songEl ? songEl.value.trim() : ""; if (!q) { say("Type the song you want first 🎤"); return; }
    if (rqMine) {
      if (rqMyPos() > 0) { say("One request at a time — yours is #" + rqMyPos() + " in the DJ queue line 🎵"); return; }
      if (!rqSnapSeen) { say("Still joining the station — give it a second and tap again."); return; }
      rqMine = null; try { localStorage.removeItem("mw-rq-mine"); } catch (_) {}
    }
    busy = true;
    if (resEl) resEl.innerHTML = '<small class="muted">🤖 Meechie AI is finding the video…</small>';
    try {
      const res = await ytSearch(q);
      if (!res.length) { if (resEl) resEl.innerHTML = '<small class="muted">Meechie AI could not find that song on YouTube. Try the artist and song name.</small>'; say("No playable video found for that — try the artist and song name."); return; }
      const good = res.find((it) => +it.dur >= 45 && +it.dur <= 1200) || res.find((it) => +it.dur > 0);
      if (good) { await enqueue(good, shoutEl ? shoutEl.value : ""); if (songEl) songEl.value = ""; if (shoutEl) shoutEl.value = ""; if (resEl) resEl.innerHTML = ""; }
      else { resCache[prefix] = res.slice(0, 8); if (resEl) resEl.innerHTML = '<small class="muted" style="display:block;margin-bottom:4px">Meechie AI found these but could not confirm a playable length — pick yours and it joins the DJ queue line:</small>' + resCache[prefix].map((it, i) => `<div class="dj-item"><span title="${E(it.title || "")}">${E(it.title || "")}</span><button class="btn sm" type="button" data-rqpick="${i}">🎵 Request this</button></div>`).join(""); }
    } catch (_) { if (resEl) resEl.innerHTML = '<small class="muted">Search is busy — try again in a moment.</small>'; }
    finally { busy = false; }
  }
  const onClick = async (e) => {
    const open = e.target.closest("[data-rqopen]");
    if (open) { const f = root.querySelector("#" + prefix + "-rqform"); if (f) { f.hidden = !f.hidden; if (!f.hidden) { const inp = f.querySelector("input"); if (inp) inp.focus(); } } return; }
    if (e.target.closest("[data-rqgo]")) { submit(); return; }
    const pk = e.target.closest("[data-rqpick]");
    if (pk) { const it = (resCache[prefix] || [])[+pk.dataset.rqpick]; if (!it) return; const shoutEl = root.querySelector("#" + prefix + "-rq-shout"); await enqueue(it, shoutEl ? shoutEl.value : ""); const resEl = root.querySelector("#" + prefix + "-rqres"); if (resEl) resEl.innerHTML = ""; const songEl = root.querySelector("#" + prefix + "-rq-song"); if (songEl) songEl.value = ""; if (shoutEl) shoutEl.value = ""; }
  };
  const onKey = (e) => { if (e.key !== "Enter") return; const inp = e.target.closest && e.target.closest("#" + prefix + "-rq-song,#" + prefix + "-rq-shout"); if (!inp) return; e.preventDefault(); submit(); };
  root.addEventListener("click", onClick);
  root.addEventListener("keydown", onKey);
  return () => { mounts.delete(m); painters.delete(painter); if (typeof un === "function") un(); root.removeEventListener("click", onClick); root.removeEventListener("keydown", onKey); try { fdb.base.stop(); } catch (_) {} };
}
