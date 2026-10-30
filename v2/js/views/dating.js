/* v2 DATING VIEW (Phase 5) — the live js/dating.js, ported: dating
   profiles (dating/<id>) + likes/passes/blocks (datelikes/<id>,
   each member writes only their own doc), the swipe deck with the
   same fit rules and same-city sort, matches, and the safety
   copy. Styles live in css/dating.css. */
import { MARKUP } from "./dating-markup.js";
import { firestore } from "../platform.js";
import { createSocial } from "../social.js";
import { toast } from "../commerce.js";

let stopFn = null;
export function render(viewRoot, ctx) {
  viewRoot.innerHTML = MARKUP;
  const fdb = firestore(ctx);
  const soc = createSocial(ctx);

  "use strict";
  const root = viewRoot.querySelector("#dt-root");
  if (!root) return;
  const E = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const say = toast;
  const ME = () => fdb.base.me();
  const DB = () => fdb;
  const okUrl = (u) => /^https:\/\/[^\s"'<>()]+$/i.test(u || "") && !/supabase\.co/i.test(u || ""); // old Supabase storage is shut off; its photos/videos are dead
  let likesLoaded = false, profiles = {}, likes = {}, tab = "discover", editing = false, photoIdx = {}, busy = false;

  

  const my = () => profiles[ME()];
  const L = (id) => likes[id] || { liked: [], passed: [], blocked: [] };
  const fits = (a, b) => !a.seeking || a.seeking === "everyone" || (a.seeking === "men" && b.gender === "man") || (a.seeking === "women" && b.gender === "woman");
  function deck() {
    const p = my(); if (!p) return [];
    const mine = L(ME()), seen = new Set([...mine.liked, ...mine.passed, ...mine.blocked]);
    return Object.entries(profiles).filter(([id, x]) => id !== ME() && x.active !== false && x.age >= 18 && !seen.has(id) && !L(id).blocked.includes(ME()) && fits(p, x) && fits(x, p) && (x.photos || []).some(okUrl))
      .sort((a, b) => (sameCity(b[1]) - sameCity(a[1])) || (b[1].updatedAt || 0) - (a[1].updatedAt || 0)).map(([id]) => id);
  }
  function sameCity(x) { const c = (my()?.city || "").toLowerCase().split(",")[0].trim(); return c && (x.city || "").toLowerCase().includes(c) ? 1 : 0; }
  const matches = () => L(ME()).liked.filter((id) => L(id).liked.includes(ME()) && profiles[id] && !L(ME()).blocked.includes(id) && !L(id).blocked.includes(ME()));
  const likedMe = () => Object.keys(likes).filter((id) => id !== ME() && L(id).liked.includes(ME()) && !L(ME()).liked.includes(id) && !L(ME()).passed.includes(id)).length;

  // Your own likes/passes/blocks must be loaded before saving, or a save would wipe them (slow phone, or not in the first page of results).
  async function ensureMine() {
    if (likes[ME()]) return true;
    try { const s = await DB().doc("datelikes/" + ME()).get(); const v = (s.exists && s.data()) || {}; if (!likes[ME()]) likes[ME()] = { liked: (v.liked || []).filter((i) => typeof i === "string"), passed: (v.passed || []).filter((i) => typeof i === "string"), blocked: (v.blocked || []).filter((i) => typeof i === "string") }; return true; }
    catch (_) { say("Still loading. Try again in a moment."); return false; }
  }
  async function saveLikes(patch) { const cur = L(ME()); const next = { liked: cur.liked, passed: cur.passed, blocked: cur.blocked, ...patch }; likes[ME()] = next; await DB().doc("datelikes/" + ME()).set(next).catch((e) => say(e.message || e.code)); }

  function render() {
    if (!ME()) { root.innerHTML = `<div class="empty"><h3>Sign in to use Dating</h3><button class="btn" type="button" data-auth="signup" style="margin-top:12px">Join free</button></div>`; return; }
    const p = my();
    if (!p || editing) { root.innerHTML = form(p); return; }
    const nm = matches().length;
    let html = `<div class="dt-tabs">${[["discover", "🔥 Discover"], ["matches", "💘 Matches" + (nm ? " (" + nm + ")" : "")], ["profile", "👤 My profile"]].map(([k, n]) => `<button class="chip" type="button" data-dtab="${k}" aria-pressed="${tab === k}">${n}</button>`).join("")}</div>`;
    if (tab === "discover") {
      const d = deck(); const lm = likedMe();
      html += lm ? `<p class="muted" style="text-align:center;margin:0">💗 ${lm} ${lm === 1 ? "person likes" : "people like"} you. Keep swiping to find them.</p>` : "";
      if (!d.length) html += `<div class="empty"><h3>You've seen everyone for now</h3><p>New people join every day. Check back soon, or share Meechie's World with your friends.</p></div>`;
      else { const id = d[0], x = profiles[id], ph = (x.photos || []).filter(okUrl), i = Math.min(photoIdx[id] || 0, ph.length - (okUrl(x.video) ? 0 : 1));
        const showVid = okUrl(x.video) && i === ph.length;
        html += `<div class="dt-deck"><div class="dt-card" id="dt-top" data-id="${E(id)}">
          ${showVid ? `<video src="${E(x.video)}" autoplay muted loop playsinline></video>` : `<div class="ph" style="background-image:url('${E(ph[i] || "")}')"></div>`}
          <div class="bars">${ph.concat(okUrl(x.video) ? ["v"] : []).map((_, k) => `<i class="${k === i ? "on" : ""}"></i>`).join("")}</div>
          <span class="tapL" data-nav="-1"></span><span class="tapR" data-nav="1"></span>
          <button class="menu" type="button" data-menu="${E(id)}" aria-label="Report or block">⋯</button>
          <span class="stamp like">LIKE</span><span class="stamp nope">NOPE</span>
          <div class="info"><b>${E(x.name)}, ${E(x.age)}</b><div class="tag">📍 ${E(x.city || "")}</div>${x.bio ? `<p>${E(x.bio)}</p>` : ""}</div></div></div>
          <div class="dt-acts"><button class="no" type="button" data-pass="${E(id)}" aria-label="Pass">✕</button><button class="yes" type="button" data-like="${E(id)}" aria-label="Like">♥</button></div>`; }
    }
    if (tab === "matches") {
      const ms = matches();
      html += ms.length ? `<div class="dt-matches">${ms.map((id) => { const x = profiles[id]; return `<div class="dt-m"><div class="ph" style="background-image:url('${E((x.photos || []).find(okUrl) || "")}')"></div><div class="b"><b>${E(x.name)}, ${E(x.age)}</b><small class="muted">📍 ${E(x.city || "")}</small><button class="btn sm" type="button" data-dm="${E(id)}">Message</button><button class="act" type="button" data-unmatch="${E(id)}">Unmatch</button></div></div>`; }).join("")}</div>` : `<div class="empty"><h3>No matches yet</h3><p>When someone you liked likes you back, they show up here.</p></div>`;
    }
    if (tab === "profile") {
      html += `<div class="dt-matches" style="grid-template-columns:repeat(auto-fill,minmax(120px,1fr))">${(p.photos || []).filter(okUrl).map((u) => `<div class="dt-m"><div class="ph" style="background-image:url('${E(u)}')"></div></div>`).join("")}</div>
        <div class="card" style="display:grid;gap:6px"><b style="font-size:20px">${E(p.name)}, ${E(p.age)}</b><span class="muted">📍 ${E(p.city)} · ${E(p.gender)} · interested in ${E(p.seeking)}</span>${p.bio ? `<p style="margin:0">${E(p.bio)}</p>` : ""}
        <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:6px"><button class="btn sm" type="button" data-edit="1">Edit profile</button><button class="btn ghost sm" type="button" data-pause="1">${p.active === false ? "Show me in Dating again" : "Hide me from Dating"}</button><button class="act" type="button" data-delprof="1">Delete my dating profile</button></div></div>`;
    }
    html += `<p class="dt-safe">Stay safe: meet in public places, tell a friend where you're going, and never send money to someone you met online. Tap ⋯ on any profile to report or block. Dating is for adults 18 and over.</p>`;
    root.innerHTML = html; wireSwipe();
  }

  function form(p) {
    p = p || {}; const ph = draft(); // the photos you uploaded so far, even if you left and came back
    const handle = (typeof members !== "undefined" && members[ME()]?.handle) || "";
    return `<form class="dt-form" id="dt-form"><h3 style="margin:0">${my() ? "Edit your dating profile" : "Make your dating profile"}</h3>
      <div class="dt-photos" id="dt-photos">${[0, 1, 2, 3, 4, 5].map((i) => ph[i] ? `<div style="background-image:url('${E(ph[i])}')"><button type="button" data-rmph="${i}" aria-label="Remove photo">×</button></div>` : `<div>＋<input type="file" accept="image/*" data-addph="${i}" aria-label="Add photo"></div>`).join("")}</div>
      <small class="muted">Add 1 to 6 photos of you. The first one is your main photo.</small>
      <label>Short video (optional, up to 50 MB)<input type="file" accept="video/*" id="dt-video">${okUrl(p.video) ? '<small class="muted">✓ You have a video. Pick a new one to replace it.</small>' : ""}</label>
      <div class="row"><label>Name<input type="text" id="dt-name" maxlength="30" required value="${E(p.name || handle)}"></label><label>Age<input type="number" id="dt-age" min="18" max="99" required value="${E(p.age || "")}"></label></div>
      <div class="row"><label>I am a<select id="dt-gender">${[["man", "Man"], ["woman", "Woman"], ["nonbinary", "Non-binary"]].map(([v, n]) => `<option value="${v}" ${p.gender === v ? "selected" : ""}>${n}</option>`).join("")}</select></label>
        <label>Interested in<select id="dt-seek">${[["women", "Women"], ["men", "Men"], ["everyone", "Everyone"]].map(([v, n]) => `<option value="${v}" ${p.seeking === v ? "selected" : ""}>${n}</option>`).join("")}</select></label></div>
      <label>City or area (no street address)<input type="text" id="dt-city" maxlength="60" required placeholder="e.g. Uniontown, PA" value="${E(p.city || "")}"></label>
      <label>About me<textarea id="dt-bio" maxlength="400" rows="4" placeholder="What you're about and what you're looking for">${E(p.bio || "")}</textarea></label>
      <label style="display:flex;gap:8px;align-items:center"><input type="checkbox" id="dt-18" style="width:auto" ${p.age ? "checked" : ""} required> I'm 18 or older and these photos are of me.</label>
      <div style="display:flex;gap:8px;justify-content:flex-end">${my() ? '<button class="btn ghost" type="button" data-cancel="1">Cancel</button>' : ""}<button class="btn" type="submit" id="dt-save">Save profile</button></div>
      <small class="muted" id="dt-st"></small></form>`;
  }
  let draftPhotos = null;
  function draft() { if (!draftPhotos) draftPhotos = ((my() || {}).photos || []).filter(okUrl); return draftPhotos; }
  root.addEventListener("change", async (e) => {
    const i = e.target.dataset.addph; if (i == null) return;
    const f = e.target.files[0]; if (!f) return; const st = root.querySelector("#dt-st"); st.textContent = "Uploading photo...";
    try {
      const dataUrl = await (typeof compress === "function" ? compress(f, 1280) : null);
      const blob = dataUrl ? await (await fetch(dataUrl)).blob() : f;
      const up = await fdb.base.uploadMedia(blob, { type: blob.type || "image/jpeg" });
      draft().push(up.url); st.textContent = "Photo added."; refreshPhotos();
    } catch (err) { st.textContent = err.message || "Couldn't upload that photo."; }
  });
  function refreshPhotos() { const box = root.querySelector("#dt-photos"); if (!box) return; const ph = draft(); box.innerHTML = [0, 1, 2, 3, 4, 5].map((i) => ph[i] ? `<div style="background-image:url('${E(ph[i])}')"><button type="button" data-rmph="${i}" aria-label="Remove photo">×</button></div>` : `<div>＋<input type="file" accept="image/*" data-addph="${i}" aria-label="Add photo"></div>`).join(""); }

  root.addEventListener("submit", async (e) => {
    if (e.target.id !== "dt-form") return; e.preventDefault(); if (busy) return;
    const st = root.querySelector("#dt-st"), age = +root.querySelector("#dt-age").value;
    if (!(age >= 18 && age <= 99)) { st.textContent = "You must be 18 or older to use Dating."; return; }
    if (!draft().length) { st.textContent = "Add at least one photo."; return; }
    busy = true; root.querySelector("#dt-save").disabled = true;
    try {
      let video = (my() || {}).video || "";
      const vf = root.querySelector("#dt-video").files[0];
      if (vf) { st.textContent = "Uploading video..."; const v = await soc.uploadVideo(vf, (f) => (st.textContent = "Uploading video " + Math.round(f * 100) + "%")); video = v.url; }
      const doc = { name: root.querySelector("#dt-name").value.trim().slice(0, 30), age, gender: root.querySelector("#dt-gender").value, seeking: root.querySelector("#dt-seek").value,
        city: root.querySelector("#dt-city").value.trim().slice(0, 60), bio: root.querySelector("#dt-bio").value.trim().slice(0, 400), photos: draft().slice(0, 6), video, active: (my() || {}).active !== false, updatedAt: Date.now() };
      await DB().doc("dating/" + ME()).set(doc); profiles[ME()] = doc; editing = false; draftPhotos = null; tab = "discover"; say("Your dating profile is live"); render();
    } catch (err) { st.textContent = err.message || "Couldn't save."; }
    busy = false; const sv = root.querySelector("#dt-save"); if (sv) sv.disabled = false;
  });

  root.addEventListener("click", async (e) => {
    const b = e.target.closest("button,[data-nav]"); if (!b) return;
    if (b.dataset.dtab) { tab = b.dataset.dtab; render(); return; }
    if (b.dataset.rmph != null) { draft().splice(+b.dataset.rmph, 1); refreshPhotos(); return; }
    if (b.dataset.cancel) { editing = false; draftPhotos = null; render(); return; }
    if (b.dataset.edit) { editing = true; draftPhotos = null; render(); return; }
    if (b.dataset.pause) { const p = { ...my(), active: my().active === false, updatedAt: Date.now() }; await DB().doc("dating/" + ME()).set(p); profiles[ME()] = p; render(); say(p.active ? "You're back in Dating" : "You're hidden from Dating"); return; }
    if (b.dataset.delprof) { if (!b.dataset.confirm) { b.dataset.confirm = 1; b.textContent = "Tap again to delete"; return; } await DB().doc("dating/" + ME()).delete().catch(() => {}); delete profiles[ME()]; say("Dating profile deleted"); render(); return; }
    if (b.dataset.nav) { const card = root.querySelector("#dt-top"), id = card.dataset.id, x = profiles[id], n = (x.photos || []).filter(okUrl).length + (okUrl(x.video) ? 1 : 0); photoIdx[id] = Math.max(0, Math.min(n - 1, (photoIdx[id] || 0) + +b.dataset.nav)); render(); return; }
    if (b.dataset.like) return decide(b.dataset.like, true);
    if (b.dataset.pass) return decide(b.dataset.pass, false);
    if (b.dataset.unmatch) { if (!b.dataset.confirm) { b.dataset.confirm = 1; b.textContent = "Tap again"; return; } if (!(await ensureMine())) return; const c = L(ME()); await saveLikes({ liked: c.liked.filter((x) => x !== b.dataset.unmatch), passed: [...c.passed, b.dataset.unmatch] }); render(); return; }
    if (b.dataset.menu) {
      const id = b.dataset.menu, what = prompt("Type REPORT to report this profile, or BLOCK to block them.", "BLOCK"); if (!what) return;
      if (/block/i.test(what)) { if (!(await ensureMine())) return; const c = L(ME()); await saveLikes({ blocked: [...new Set([...c.blocked, id])] }); say("Blocked. You won't see each other."); render(); }
      else if (/report/i.test(what)) { const why = prompt("What's wrong with this profile? (fake, underage, rude, scam...)") || ""; await DB().collection("reports").add({ from: ME(), target: id, kind: "dating", reason: why.slice(0, 300), createdAt: Date.now() }).catch(() => {}); if (!(await ensureMine())) return; const c = L(ME()); await saveLikes({ blocked: [...new Set([...c.blocked, id])] }); say("Thanks. Meechie will review it, and you won't see them again."); render(); }
    }
  });
  async function decide(id, like) {
    const card = root.querySelector("#dt-top"); if (card) { card.style.transform = `translateX(${like ? 140 : -140}%) rotate(${like ? 18 : -18}deg)`; card.style.opacity = "0"; }
    if (!(await ensureMine())) { render(); return; } const c = L(ME());
    await saveLikes(like ? { liked: [...new Set([...c.liked, id])] } : { passed: [...new Set([...c.passed, id])] });
    if (like && L(id).liked.includes(ME())) matchPop(id);
    setTimeout(render, 220);
  }
  function matchPop(id) {
    const x = profiles[id] || {}; const d = document.createElement("div"); d.className = "dt-match-pop";
    d.innerHTML = `<div><h2>It's a match! 💘</h2><p style="font-size:18px">You and ${E(x.name)} like each other.</p><div style="display:flex;gap:10px;justify-content:center;margin-top:16px"><button class="btn" type="button" data-dm="${E(id)}">Send a message</button><button class="btn ghost" type="button" data-close="1">Keep swiping</button></div></div>`;
    d.addEventListener("click", (e) => { if (e.target === d || e.target.closest("[data-close],[data-dm]")) setTimeout(() => d.remove(), 50); });
    document.body.appendChild(d);
  }
  function wireSwipe() {
    const card = root.querySelector("#dt-top"); if (!card) return;
    let x0 = null, dx = 0;
    card.addEventListener("pointerdown", (e) => { if (e.target.closest("button")) return; x0 = e.clientX; dx = 0; card.style.transition = "none"; });
    card.addEventListener("pointermove", (e) => { if (x0 == null) return; dx = e.clientX - x0; if (Math.abs(dx) > 8 && !card.hasPointerCapture(e.pointerId)) card.setPointerCapture(e.pointerId); /* capture only a real drag, so taps on a photo side still work */ card.style.transform = `translateX(${dx}px) rotate(${dx / 18}deg)`; card.querySelector(".stamp.like").style.opacity = Math.max(0, dx / 120); card.querySelector(".stamp.nope").style.opacity = Math.max(0, -dx / 120); });
    const end = () => { if (x0 == null) return; x0 = null; card.style.transition = ""; if (Math.abs(dx) > 110) decide(card.dataset.id, dx > 0); else { card.style.transform = ""; card.querySelectorAll(".stamp").forEach((s) => (s.style.opacity = 0)); } };
    card.addEventListener("pointerup", end); card.addEventListener("pointercancel", end);
  }

  async function init() {
    if (!window.claude) return;
    const d = await claude.use("db"); if (!d) { render(); return; }
    let dtLoaded = false;
    d.collection("dating").limit(1000).onSnapshot((s) => { const first = !dtLoaded; dtLoaded = true; profiles = {}; s.docs.forEach((x) => { const v = x.data(); if (v && v.age >= 18) profiles[x.id] = v; }); if (!editing && (first || !root.querySelector("#dt-form"))) render(); }, () => {}); // after the first load, don't wipe a profile someone is filling in
    d.collection("datelikes").limit(2000).onSnapshot((s) => { const before = likesLoaded ? matches().length : Infinity; likesLoaded = true; likes = {}; s.docs.forEach((x) => { const v = x.data() || {}; likes[x.id] = { liked: (v.liked || []).filter((i) => typeof i === "string"), passed: (v.passed || []).filter((i) => typeof i === "string"), blocked: (v.blocked || []).filter((i) => typeof i === "string") }; }); if (!editing && tab !== "discover" && !root.querySelector("#dt-form")) render(); if (ME() && matches().length > before && false /* v2: no hidden-view match toast; the match shows in the Matches tab */) say("💘 You have a new Dating match!"); }, () => {});
    setTimeout(render, 1200);
  }
  init();
  stopFn = () => { try { fdb.base.stop(); } catch (_) {} };

}
export function destroy() { if (stopFn) { try { stopFn(); } catch (_) {} stopFn = null; } }
