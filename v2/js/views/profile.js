/* ============================================================================
   v2 PROFILE VIEW (Phase 5) — member profile pages at #profile/<uid>
   (avatar clicks land here via the shell's data-profile routing).
   The live profile-page.js overlay becomes the routed page with
   the same layout and CSS (css/profile.css): cover with the
   owner's drag-to-reposition editor (coverPos/photoPos on the
   member doc), avatar, friend count + mutuals + friend stack,
   action buttons (Add / Accept / Friends · Message · 🎁 Gift —
   the commerce gift dialog), Intro (bio/work/school/city/
   hometown/relationship/website/phone/joined + interests + app
   links via the shared socUrl), Photos (profile pictures then
   post photos), Friends, and the posts/about/friends/photos
   tabs with the member's posts. Friend add/remove ride the same
   friends list docs the Book uses.
   ============================================================================ */

import { createSocial, esc as E, ago } from "../social.js";
import { socUrl } from "../platform.js";
import { openGift } from "../commerce.js";
import { toast } from "../commerce.js";

const COL = { gold: "#d4a843", royal: "#7b4fd6", red: "#d64545", blue: "#3d7fe0", green: "#2fa866", pink: "#e0559a", white: "#e8e4da" };
const NAMES = { facebook: "Facebook", snapchat: "Snapchat", instagram: "Instagram", tiktok: "TikTok", youtube: "YouTube", x: "X", whatsapp: "WhatsApp", cashapp: "Cash App", threads: "Threads", linkedin: "LinkedIn", spotify: "Spotify", soundcloud: "SoundCloud", applemusic: "Apple Music", twitch: "Twitch", kick: "Kick", discord: "Discord", telegram: "Telegram", pinterest: "Pinterest", reddit: "Reddit", venmo: "Venmo", paypal: "PayPal", linktree: "Linktree", patreon: "Patreon", bluesky: "Bluesky", tumblr: "Tumblr", vimeo: "Vimeo", rumble: "Rumble", lemon8: "Lemon8", triller: "Triller", audiomack: "Audiomack", bandcamp: "Bandcamp", substack: "Substack", medium: "Medium", etsy: "Etsy", depop: "Depop", poshmark: "Poshmark", truthsocial: "Truth Social", mastodon: "Mastodon", signal: "Signal", tidal: "Tidal", amazonmusic: "Amazon Music", clubhouse: "Clubhouse", bereal: "BeReal", messenger: "Messenger", onlinestore: "Online store", other: "Link" };
const img = (u) => (/^https:\/\/[^\s"'()<>\\]+$/.test(u || "") || /^data:image\/(png|jpe?g|webp);base64,[A-Za-z0-9+/=]+$/.test(u || "") ? u : "");
const parsePos = (s) => { const p = String(s || ""); return /^\d{1,3}% \d{1,3}%$/.test(p) ? p : "50% 50%"; };
const posOf = (m, key = "coverPos") => parsePos(m && m[key]);

let S = null, uid = null, tab = "posts", posts = [], viewCtx = null;
export async function render(root, ctx) {
  viewCtx = ctx;
  S = createSocial(ctx);
  uid = ctx.view.arg || "";
  tab = "posts";
  root.innerHTML = `<div class="wrap"><p class="muted">Loading profile…</p></div>`;
  await S.loadMembers(); await S.loadLists();
  posts = await S.docs("posts", { field: "createdAt", limit: 300 }).catch(() => []);
  if (!S.members[uid]) { root.innerHTML = `<div class="wrap"><div class="empty"><h3>That profile isn't available.</h3></div></div>`; return; }
  paint(root);
  wire(root);
}
function friendsOf(id) { const mine = S.friends[id] || []; return mine.filter((x) => (S.friends[x] || []).includes(id) && S.members[x]); }
function apps(m) {
  const s = m.socials || {};
  return Object.entries(s).map(([k, v]) => { const u = socUrl(k, v); return u ? `<a href="${E(u)}" target="_blank" rel="noopener nofollow ugc">${E(NAMES[k] || k)}</a>` : ""; }).join("");
}
function sq(id) { const m = S.members[id] || {}, p = img(m.photo); return `<div class="sq" style="${p ? `background-image:url('${E(p)}')` : ""}">${p ? "" : E(((m.handle || "?").trim()[0] || "?").toUpperCase())}</div>`; }
function paint(root) {
  const m = S.members[uid] || {}, me = S.me(), mine = uid === me, c = COL[m.color] || COL.gold;
  const friends = friendsOf(uid), st = S.friendStatus(uid);
  const myF = !mine && me ? friendsOf(me) : [];
  const mutual = myF.length ? friends.filter((f) => f !== me && myF.includes(f)) : [];
  const ps = posts.filter((p) => p.authorId === uid);
  const profPics = (Array.isArray(m.photos) ? m.photos : []).filter((u) => typeof u === "string" && img(u)).slice(0, 5).map((u) => ({ photo: u }));
  const photos = [...profPics, ...ps.filter((p) => img(p.photo) && !profPics.some((q) => q.photo === p.photo))].slice(0, 30);
  const av = img(m.photo), cover = img(m.cover);
  const btn = mine ? `<button class="btn" type="button" data-pp="edit">✏️ Edit profile</button>`
    : `${st === "friends" ? `<button class="btn ghost" type="button" data-pp="unf">✓ Friends</button>` : st === "sent" ? `<button class="btn ghost" type="button" data-pp="unf">Request sent · Cancel</button>` : st === "request" ? `<button class="btn" type="button" data-pp="add">✓ Accept friend request</button>` : `<button class="btn" type="button" data-pp="add">＋ Add friend</button>`}
       <button class="btn ${st === "friends" ? "" : "ghost"}" type="button" data-dm="${E(uid)}">💬 Message</button><button class="btn ghost" type="button" data-pp="gift">🎁 Gift</button>`;
  const intro = [
    m.bio && ["💼", E(m.bio)], m.work && ["🏢", "Works at <b>" + E(m.work) + "</b>"], m.school && ["🎓", "Went to <b>" + E(m.school) + "</b>"],
    m.city && ["🏠", "Lives in <b>" + E(m.city) + "</b>"], m.hometown && ["📍", "From <b>" + E(m.hometown) + "</b>"], m.relationship && ["❤️", E(m.relationship)],
    /^https?:\/\/[^\s"<>]+$/i.test(m.website || "") && ["🌐", `<a href="${E(m.website)}" target="_blank" rel="noopener nofollow ugc">${E(String(m.website).replace(/^https?:\/\/(www\.)?/i, ""))}</a>`],
    m.phonePublic && m.phone && ["📞", `<a href="tel:${E(String(m.phone).replace(/[^\d+]/g, ""))}">${E(m.phone)}</a>`],
    m.joinedAt && ["🗓️", "Joined " + new Date(m.joinedAt).toLocaleDateString([], { month: "long", year: "numeric" })],
  ].filter(Boolean);
  const introCard = `<div class="pp-card pp-intro"><h3>Intro</h3>${intro.map(([i, t]) => `<div><span>${i}</span><span>${t}</span></div>`).join("") || `<p class="muted" style="margin:0">${mine ? "Add your work, school and city in Edit profile." : "Nothing here yet."}</p>`}
    ${Array.isArray(m.interests) && m.interests.length ? `<b style="font-size:14px">Into</b><div class="pp-apps">${m.interests.slice(0, 22).map((x) => `<span style="border:1px solid var(--line,#333);border-radius:999px;padding:5px 11px;font-size:13px">${E(x)}</span>`).join("")}</div>` : ""}
    ${apps(m) ? `<b style="font-size:14px">Apps</b><div class="pp-apps">${apps(m)}</div>` : ""}</div>`;
  const photoCard = `<div class="pp-card"><div style="display:flex;justify-content:space-between;align-items:baseline;gap:8px"><h3>Photos</h3>${photos.length > 9 ? `<button type="button" class="pp-seeall" data-pptab="photos">See all photos</button>` : ""}</div>${photos.length ? `<div class="pp-grid">${photos.slice(0, 9).map((p) => `<img src="${E(p.photo)}" alt="" loading="lazy" data-ppimg>`).join("")}</div>` : `<p class="muted" style="margin:0">No photos yet.</p>`}</div>`;
  const friendCard = `<div class="pp-card"><div style="display:flex;justify-content:space-between;align-items:baseline;gap:8px"><h3>Friends <small class="muted" style="font-weight:600">${friends.length}</small></h3>${friends.length > 9 ? `<button type="button" class="pp-seeall" data-pptab="friends">See all friends</button>` : ""}</div>${friends.length ? `<div class="pp-fr">${friends.slice(0, 9).map((f) => `<button type="button" data-profile="${E(f)}">${sq(f)}<span>${E((S.members[f] || {}).handle || "Member")}</span></button>`).join("")}</div>` : `<p class="muted" style="margin:0">No friends yet.</p>`}</div>`;
  const postList = ps.length ? ps.map((p) => `<article class="pp-post"><div class="pp-phead"><div class="pp-pav" style="${av ? `background-image:url('${E(av)}')` : ""}">${av ? "" : E(((m.handle || "?").trim()[0] || "?").toUpperCase())}</div><div><b>${E(m.handle || "Member")}</b><br><small>${E(ago(p.createdAt))} · 🌐</small></div></div>${p.text ? `<p>${E(p.text)}</p>` : ""}${img(p.photo) ? `<img src="${E(p.photo)}" alt="" loading="lazy">` : ""}${/^https:\/\//.test(p.video || "") ? `<video src="${E(p.video)}#t=0.1" controls playsinline preload="metadata"></video>` : ""}</article>`).join("") : `<div class="pp-card"><p class="muted" style="margin:0">${mine ? "You haven't posted yet. Share something in Community." : "No posts yet."}</p></div>`;
  let main = "";
  if (tab === "posts") main = `<div class="pp-body"><div style="display:grid;gap:16px;align-content:start">${introCard}${photoCard}${friendCard}</div><div class="pp-main">${postList}</div></div>`;
  if (tab === "about") main = `<div class="pp-body" style="grid-template-columns:1fr">${introCard}</div>`;
  if (tab === "friends") main = `<div class="pp-body" style="grid-template-columns:1fr"><div class="pp-card"><h3>Friends · ${friends.length}</h3><div class="pp-fr" style="grid-template-columns:repeat(auto-fill,minmax(110px,1fr))">${friends.map((f) => `<button type="button" data-profile="${E(f)}">${sq(f)}<span>${E((S.members[f] || {}).handle || "Member")}</span></button>`).join("") || '<p class="muted">No friends yet.</p>'}</div></div></div>`;
  if (tab === "photos") main = `<div class="pp-body" style="grid-template-columns:1fr"><div class="pp-card"><h3>Photos</h3><div class="pp-grid" style="grid-template-columns:repeat(auto-fill,minmax(120px,1fr))">${photos.map((p) => `<img src="${E(p.photo)}" alt="" loading="lazy" data-ppimg>`).join("") || '<p class="muted">No photos yet.</p>'}</div></div></div>`;
  root.innerHTML = `<div id="pp" style="--ppc:${c}"><div class="pp-wrap"><div class="pp-close"><button type="button" data-pp="close" aria-label="Back">←</button><b>${E(m.handle || "Member")}</b></div>
<div class="pp-cover${mine && cover ? " mine-cover" : ""}" style="${cover ? `background-image:url('${E(cover)}');background-position:${E(posOf(m))}` : ""}">${mine && cover ? `<span class="pp-covhint">↕ Drag to position your cover</span>` : ""}${mine ? `<button class="btn sm ghost ed" type="button" data-pp="edit">📷 ${cover ? "Change" : "Add"} cover photo</button>` : ""}</div>
<div class="pp-top"><div class="pp-av${mine && av ? " mine-av" : ""}"${mine ? ` data-pp="edit" role="button" title="Edit profile — or drag to position your picture"` : ""} style="${av ? `background-image:url('${E(av)}');background-position:${E(posOf(m, "photoPos"))}` : ""}">${av ? "" : E(((m.handle || "?").trim()[0] || "?").toUpperCase())}${mine ? `<span class="pp-camb">📷</span>` : ""}</div>
<div class="pp-name"><h2>${E(m.handle || "Member")}</h2>${m.bio ? `<p class="bio">${E(m.bio)}</p>` : ""}<span class="fc">${friends.length} friend${friends.length === 1 ? "" : "s"}</span>${mutual.length ? `<div class="fc" style="font-weight:600">${mutual.length} mutual friend${mutual.length === 1 ? "" : "s"}</div>` : ""}${friends.length ? `<div class="pp-stack">${friends.slice(0, 8).map((f) => { const fm = S.members[f] || {}, fp = img(fm.photo); return `<button type="button" data-profile="${E(f)}" title="${E(fm.handle || "Member")}" style="${fp ? `background-image:url('${E(fp)}')` : ""}">${fp ? "" : E(((fm.handle || "?").trim()[0] || "?").toUpperCase())}</button>`; }).join("")}</div>` : ""}</div></div>
<div class="pp-acts">${btn}</div>
<div class="pp-tabs">${[["posts", "Posts"], ["about", "About"], ["friends", "Friends"], ["photos", "Photos"]].map(([k, n]) => `<button type="button" data-pptab="${k}" aria-pressed="${tab === k}">${n}</button>`).join("")}</div>
${main}</div></div>`;
}
function wire(root) {
  /* the owner's photo-position editor: drag the cover or the
     profile picture (pointer capture, 5px moved threshold — a
     deliberate drag on one's own photo, Law 22), Save/Cancel bar,
     the position stored as background-position percentages */
  let drag = null, swallowClick = false;
  const dragStart = (e, el, url, key, avMode) => {
    const [px, py] = parsePos((S.members[uid] || {})[key]).split(" ").map((v) => parseFloat(v));
    drag = { el, key, avMode, sx: e.clientX, sy: e.clientY, px, py, x: px, y: py, moved: false, nat: null };
    const im = new Image(); im.onload = () => { if (drag) drag.nat = { w: im.naturalWidth, h: im.naturalHeight }; }; im.src = url;
    try { el.setPointerCapture(e.pointerId); } catch (_) {}
  };
  root.addEventListener("pointerdown", (e) => {
    if (!S || uid !== S.me()) return;
    const cov = e.target.closest(".pp-cover.mine-cover");
    if (cov && !e.target.closest("button")) { const m = S.members[uid] || {}; if (img(m.cover)) dragStart(e, cov, img(m.cover), "coverPos", false); return; }
    const avEl = e.target.closest(".pp-av.mine-av");
    if (avEl) { const m = S.members[uid] || {}; if (img(m.photo)) dragStart(e, avEl, img(m.photo), "photoPos", true); }
  });
  root.addEventListener("pointermove", (e) => {
    if (!drag) return;
    const dx = e.clientX - drag.sx, dy = e.clientY - drag.sy;
    if (!drag.moved && Math.hypot(dx, dy) < 5) return;
    drag.moved = true;
    const r = drag.el.getBoundingClientRect();
    let fx = 0, fy = 0;
    if (drag.nat) { const s = Math.max(r.width / drag.nat.w, r.height / drag.nat.h), rw = drag.nat.w * s, rh = drag.nat.h * s; fx = rw > r.width ? dx / (rw - r.width) * 100 : 0; fy = rh > r.height ? dy / (rh - r.height) * 100 : 0; }
    else { fx = dx / r.width * 100; fy = dy / r.height * 100; }
    drag.x = Math.max(0, Math.min(100, drag.px - fx)); drag.y = Math.max(0, Math.min(100, drag.py - fy));
    drag.el.style.backgroundPosition = drag.x + "% " + drag.y + "%";
    const hint = drag.el.querySelector(".pp-covhint"); if (hint) hint.remove();
  });
  const endDrag = () => {
    if (!drag) return; const d = drag; drag = null;
    if (!d.moved) return;
    swallowClick = true; setTimeout(() => { swallowClick = false; }, 350);
    d.el.querySelector(".pp-covbar")?.remove();
    const bar = document.createElement("span"); bar.className = "pp-covbar" + (d.avMode ? " av" : "");
    bar.innerHTML = `<span>${d.avMode ? "Picture" : "Cover"} position</span><button type="button" class="save">Save</button><button type="button" class="cancel">Cancel</button>`;
    bar.querySelector(".save").addEventListener("click", async () => {
      const val = Math.round(d.x) + "% " + Math.round(d.y) + "%";
      try { await S.mergeDoc("members/" + S.me(), { [d.key]: val }); if (S.members[S.me()]) S.members[S.me()][d.key] = val; toast("Position saved"); }
      catch (err) { toast("Couldn't save: " + (err.message || err)); }
      paint(root);
    });
    bar.querySelector(".cancel").addEventListener("click", () => paint(root));
    d.el.appendChild(bar);
  };
  root.addEventListener("pointerup", endDrag); root.addEventListener("pointercancel", endDrag);
  root.addEventListener("click", async (e) => {
    if (swallowClick) { swallowClick = false; e.preventDefault(); e.stopPropagation(); return; }
    const t = e.target.closest("[data-pptab]"); if (t) { tab = t.dataset.pptab; paint(root); return; }
    const im = e.target.closest("[data-ppimg]"); if (im) { window.open(im.src, "_blank", "noopener"); return; }
    const b = e.target.closest("[data-pp]"); if (!b) return;
    const k = b.dataset.pp;
    if (k === "close") { history.back(); return; }
    if (k === "edit") { location.hash = "#community"; toast("Edit your profile from your card in Meechie's Book."); return; }
    if (k === "gift") { openGift(viewCtx, uid, S.handleOf(uid)); return; }
    if (k === "add") { if (!S.needMember()) return; try { await S.ensureList("friends"); await S.setList("friends", [...(S.friends[S.me()] || []), uid]); toast(S.friendStatus(uid) === "friends" ? "You're friends now!" : "Friend request sent"); } catch (err) { toast(err.message || "Couldn't add."); } paint(root); return; }
    if (k === "unf") { if (!b.dataset.confirm) { b.dataset.confirm = "1"; b.textContent = "Tap again to remove"; return; } try { await S.ensureList("friends"); await S.setList("friends", (S.friends[S.me()] || []).filter((x) => x !== uid)); } catch (_) {} paint(root); }
  });
}
export function destroy() { if (S) { try { S.destroy(); } catch (_) {} S = null; } }
