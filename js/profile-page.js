/* Facebook-style profile pages. Tap anyone's picture or name to open theirs; "My profile" opens yours.
 * Cover photo, big profile picture, name, bio, friend count, Add friend / Message, and tabs:
 * Posts, About (work, school, city, hometown, relationship, website, apps), Friends, Photos. */
(function () {
  "use strict";
  const E = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const say = (t) => (typeof toast === "function" ? toast(t) : null);
  const ME = () => (typeof me !== "undefined" ? me : null);
  const MEM = () => (typeof members !== "undefined" ? members : {});
  const POSTS = () => (typeof posts !== "undefined" ? posts : []);
  const img = (u) => (/^https:\/\//.test(u || "") || /^data:image\/(png|jpe?g|webp);base64,/.test(u || "") ? u : "");
  const COL = { gold: "#d4a843", royal: "#7b4fd6", red: "#d64545", blue: "#3d7fe0", green: "#2fa866", pink: "#e0559a", white: "#e8e4da" };
  const NAMES = { facebook: "Facebook", snapchat: "Snapchat", instagram: "Instagram", tiktok: "TikTok", youtube: "YouTube", x: "X", whatsapp: "WhatsApp", cashapp: "Cash App", threads: "Threads", linkedin: "LinkedIn", spotify: "Spotify", soundcloud: "SoundCloud", applemusic: "Apple Music", twitch: "Twitch", kick: "Kick", discord: "Discord", telegram: "Telegram", pinterest: "Pinterest", reddit: "Reddit", venmo: "Venmo", paypal: "PayPal", linktree: "Linktree", patreon: "Patreon", bluesky: "Bluesky", tumblr: "Tumblr", vimeo: "Vimeo", rumble: "Rumble", lemon8: "Lemon8", triller: "Triller", audiomack: "Audiomack", bandcamp: "Bandcamp", substack: "Substack", medium: "Medium", etsy: "Etsy", depop: "Depop", poshmark: "Poshmark", truthsocial: "Truth Social", mastodon: "Mastodon", signal: "Signal", tidal: "Tidal", amazonmusic: "Amazon Music", clubhouse: "Clubhouse", bereal: "BeReal", messenger: "Messenger", onlinestore: "Online store", other: "Link" };
  const DB = () => (typeof db !== "undefined" ? db : null);
  const parsePos = (s) => { const p = String(s || ""); return /^\d{1,3}% \d{1,3}%$/.test(p) ? p : "50% 50%"; };
  const posOf = (m, key = "coverPos") => parsePos(m && m[key]);
  let uid = null, tab = "posts";

  const css = document.createElement("style");
  css.textContent = `
#pp{position:fixed;inset:0;z-index:9990;background:var(--ink,#0b0a08);overflow:auto;overscroll-behavior:contain}
#pp[hidden]{display:none}
body.pp-open #mw-fab,body.pp-open #ai-fab,body.pp-open #mx-fab,body.pp-open #vz-pill,body.pp-open #mw-show,body.pp-open #mw-show-pill,body.pp-open #mx-heads{display:none!important}
.pp-wrap{max-width:900px;margin:0 auto;padding-bottom:calc(var(--tabbar,0px) + 90px)}
.pp-close{position:sticky;top:0;z-index:3;display:flex;align-items:center;gap:10px;padding:10px 14px;background:rgba(11,10,8,.92);backdrop-filter:blur(8px);border-bottom:1px solid var(--line,#333)}
.pp-close button{background:none;border:0;color:var(--gold-hi,#f0cf78);font-size:22px;cursor:pointer}
.pp-close b{font-size:16px}
.pp-cover{height:clamp(160px,32vw,300px);background:linear-gradient(135deg,var(--ppc,#d4a843),#1a140a 70%) center/cover;border-radius:0 0 14px 14px;position:relative}
.pp-cover .ed{position:absolute;right:12px;bottom:12px}
.pp-cover.mine-cover{cursor:grab;touch-action:none}
.pp-cover.mine-cover:active{cursor:grabbing}
.pp-covhint{position:absolute;left:12px;bottom:12px;background:rgba(11,10,8,.82);border:1px solid var(--line,#333);color:var(--text,#fff);border-radius:999px;padding:6px 11px;font-size:12.5px;font-weight:600;pointer-events:none}
.pp-covbar{position:absolute;left:12px;bottom:12px;display:flex;gap:6px;align-items:center;background:rgba(11,10,8,.9);border:1px solid var(--gold-lo,#8c6d26);border-radius:999px;padding:5px 6px 5px 12px;font-size:12.5px;font-weight:600}
.pp-covbar button{border-radius:999px;border:1px solid var(--gold-lo,#8c6d26);background:#241d10;color:var(--gold-hi,#f0cf78);font:700 12.5px var(--body,system-ui);padding:5px 11px;cursor:pointer}
.pp-covbar button.save{background:var(--gold,#d4a843);color:#0b0a08;border-color:var(--gold,#d4a843)}
.pp-covbar.av{left:50%;transform:translateX(-50%);bottom:-48px;white-space:nowrap;z-index:5}
.pp-av.mine-av{cursor:grab;touch-action:none}.pp-av.mine-av:active{cursor:grabbing}
.pp-top{display:grid;grid-template-columns:auto 1fr;gap:16px;align-items:end;padding:0 18px;margin-top:-64px;position:relative}
.pp-av{width:150px;height:150px;border-radius:50%;border:5px solid var(--ink,#0b0a08);outline:3px solid var(--ppc,#d4a843);background:#241d10 center/cover;display:grid;place-items:center;font:800 56px var(--body,system-ui);color:var(--gold-hi,#f0cf78)}
.pp-name{padding-bottom:10px;min-width:0}.pp-name h2{margin:0;font-size:clamp(24px,4vw,32px);overflow-wrap:anywhere}
.pp-name .bio{color:var(--muted,#bbb);margin:2px 0}.pp-name .fc{color:var(--muted,#bbb);font-weight:700;font-size:14px}
.pp-stack{display:flex;margin-top:8px}.pp-stack button{width:34px;height:34px;border-radius:50%;border:2px solid var(--ink,#0b0a08);margin-left:-8px;background:#241d10 center/cover;color:var(--gold-hi,#f0cf78);font:800 13px var(--body,system-ui);cursor:pointer;padding:0;display:grid;place-items:center}.pp-stack button:first-child{margin-left:0}
.pp-acts{display:flex;gap:8px;flex-wrap:wrap;padding:12px 18px;border-bottom:1px solid var(--line,#333)}
.pp-acts .btn:first-child{flex:1 1 auto}
.pp-seeall{background:none;border:0;color:var(--gold-hi,#f0cf78);font:700 13px var(--body,system-ui);cursor:pointer;padding:0}
.pp-tabs{display:flex;gap:4px;padding:6px 12px;border-bottom:1px solid var(--line,#333);overflow-x:auto;position:sticky;top:47px;z-index:2;background:rgba(11,10,8,.92);backdrop-filter:blur(8px)}
.pp-phead{display:flex;gap:10px;align-items:center}.pp-pav{width:40px;height:40px;border-radius:50%;background:#241d10 center/cover;display:grid;place-items:center;font:800 16px var(--body,system-ui);color:var(--gold-hi,#f0cf78);flex:none}
.pp-av{position:relative}.pp-av[data-pp]{cursor:pointer}.pp-camb{position:absolute;right:2px;bottom:2px;width:34px;height:34px;border-radius:50%;background:#2a2113;border:2px solid var(--ink,#0b0a08);display:grid;place-items:center;font-size:15px}
.pp-tabs button{background:none;border:0;color:var(--muted,#bbb);font:700 15px var(--body,system-ui);padding:10px 14px;border-radius:10px;cursor:pointer;white-space:nowrap}
.pp-tabs button[aria-pressed=true]{color:var(--gold-hi,#f0cf78);box-shadow:inset 0 -3px 0 var(--ppc,#d4a843)}
.pp-body{display:grid;grid-template-columns:minmax(0,320px) minmax(0,1fr);gap:16px;padding:16px}
.pp-card{background:linear-gradient(180deg,#17130c,#0f0d09);border:1px solid var(--line,#333);border-radius:16px;padding:14px;display:grid;gap:10px;align-content:start}
.pp-card h3{margin:0;font-size:18px}
.pp-intro div{display:flex;gap:10px;align-items:flex-start;font-size:15px}.pp-intro a{color:var(--gold-hi,#f0cf78);overflow-wrap:anywhere}
.pp-apps{display:flex;flex-wrap:wrap;gap:6px}.pp-apps a{border:1px solid var(--line,#333);border-radius:999px;padding:5px 11px;font-size:13px;color:var(--text,#fff);text-decoration:none}
.pp-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:6px}.pp-grid img{width:100%;aspect-ratio:1;object-fit:cover;border-radius:8px;cursor:pointer}
.pp-fr{display:grid;grid-template-columns:repeat(3,1fr);gap:8px}.pp-fr button{background:none;border:0;color:var(--text,#fff);display:grid;gap:4px;cursor:pointer;font:600 12px var(--body,system-ui);text-align:left;padding:0}
.pp-fr .sq{aspect-ratio:1;border-radius:10px;background:#241d10 center/cover;display:grid;place-items:center;font:800 26px var(--body,system-ui);color:var(--gold-hi,#f0cf78)}
.pp-fr span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.pp-post{background:linear-gradient(180deg,#17130c,#0f0d09);border:1px solid var(--line,#333);border-radius:16px;padding:14px;display:grid;gap:8px}
.pp-post img,.pp-post video{width:100%;max-height:520px;object-fit:contain;border-radius:12px;background:#000}
.pp-post p{margin:0;white-space:pre-wrap;overflow-wrap:anywhere}.pp-post small{color:var(--muted,#bbb)}
.pp-main{display:grid;gap:12px;align-content:start}
@media (max-width:720px){.pp-body{grid-template-columns:1fr}.pp-top{grid-template-columns:1fr;justify-items:center;text-align:center;margin-top:-80px}.pp-av{width:140px;height:140px}.pp-acts{justify-content:center}.pp-stack{justify-content:center}.pp-body:not([style]) .pp-intro>div:nth-of-type(n+6),.pp-body:not([style]) .pp-intro .pp-apps,.pp-body:not([style]) .pp-intro b{display:none}}`;
  document.head.appendChild(css);

  function apps(m) {
    const s = m.socials || {}; if (!window.MW_socUrl) return "";
    return Object.entries(s).map(([k, v]) => { const u = MW_socUrl(k, v); return u ? `<a href="${E(u)}" target="_blank" rel="noopener nofollow ugc">${E(NAMES[k] || k)}</a>` : ""; }).join("");
  }
  function sq(id) { const m = MEM()[id] || {}, p = img(m.photo); return `<div class="sq" style="${p ? `background-image:url('${E(p)}')` : ""}">${p ? "" : E(((m.handle || "?").trim()[0] || "?").toUpperCase())}</div>`; }

  function paint() {
    const box = document.getElementById("pp"); if (!box || !uid) return;
    const m = MEM()[uid] || {}, mine = uid === ME(), c = COL[m.color] || COL.gold, F = window.MW_FRIENDS;
    const friends = F && F.of ? F.of(uid) : [], st = F && F.status ? F.status(uid) : "none";
    const myF = !mine && ME() && F && F.of ? F.of(ME()) : [];
    const mutual = myF.length ? friends.filter((f) => f !== ME() && myF.includes(f)) : [];
    const ps = POSTS().filter((p) => p.authorId === uid);
    // their profile pictures (up to 5) first, then photos from their posts
    const profPics = (Array.isArray(m.photos) ? m.photos : []).filter((u) => typeof u === "string" && img(u)).slice(0, 5).map((u) => ({ photo: u }));
    const photos = [...profPics, ...ps.filter((p) => img(p.photo) && !profPics.some((q) => q.photo === p.photo))].slice(0, 30);
    const av = img(m.photo), cover = img(m.cover);
    const btn = mine ? `<button class="btn" type="button" data-pp="edit">✏️ Edit profile</button>`
      : `${st === "friends" ? `<button class="btn ghost" type="button" data-pp="unf">✓ Friends</button>` : st === "sent" ? `<button class="btn ghost" type="button" data-pp="unf">Request sent · Cancel</button>` : st === "request" ? `<button class="btn" type="button" data-pp="add">✓ Accept friend request</button>` : `<button class="btn" type="button" data-pp="add">＋ Add friend</button>`}
         <button class="btn ${st === "friends" ? "" : "ghost"}" type="button" data-dm="${E(uid)}">💬 Message</button>${typeof openGift === "function" ? `<button class="btn ghost" type="button" data-pp="gift">🎁 Gift</button>` : ""}`;
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
    const friendCard = `<div class="pp-card"><div style="display:flex;justify-content:space-between;align-items:baseline;gap:8px"><h3>Friends <small class="muted" style="font-weight:600">${friends.length}</small></h3>${friends.length > 9 ? `<button type="button" class="pp-seeall" data-pptab="friends">See all friends</button>` : ""}</div>${friends.length ? `<div class="pp-fr">${friends.slice(0, 9).map((f) => `<button type="button" data-profile="${E(f)}">${sq(f)}<span>${E((MEM()[f] || {}).handle || "Member")}</span></button>`).join("")}</div>` : `<p class="muted" style="margin:0">No friends yet.</p>`}</div>`;
    const postList = ps.length ? ps.map((p) => `<article class="pp-post"><div class="pp-phead"><div class="pp-pav" style="${av ? `background-image:url('${E(av)}')` : ""}">${av ? "" : E(((m.handle || "?").trim()[0] || "?").toUpperCase())}</div><div><b>${E(m.handle || "Member")}</b><br><small>${typeof ago === "function" ? E(ago(p.createdAt)) : ""} · 🌐</small></div></div>${p.text ? `<p>${E(p.text)}</p>` : ""}${img(p.photo) ? `<img src="${E(p.photo)}" alt="" loading="lazy">` : ""}${/^https:\/\//.test(p.video || "") ? `<video src="${E(p.video)}#t=0.1" controls playsinline preload="metadata"></video>` : ""}</article>`).join("") : `<div class="pp-card"><p class="muted" style="margin:0">${mine ? "You haven't posted yet. Share something in Community." : "No posts yet."}</p></div>`;
    let main = "";
    if (tab === "posts") main = `<div class="pp-body"><div style="display:grid;gap:16px;align-content:start">${introCard}${photoCard}${friendCard}</div><div class="pp-main">${postList}</div></div>`;
    if (tab === "about") main = `<div class="pp-body" style="grid-template-columns:1fr">${introCard}</div>`;
    if (tab === "friends") main = `<div class="pp-body" style="grid-template-columns:1fr"><div class="pp-card"><h3>Friends · ${friends.length}</h3><div class="pp-fr" style="grid-template-columns:repeat(auto-fill,minmax(110px,1fr))">${friends.map((f) => `<button type="button" data-profile="${E(f)}">${sq(f)}<span>${E((MEM()[f] || {}).handle || "Member")}</span></button>`).join("") || '<p class="muted">No friends yet.</p>'}</div></div></div>`;
    if (tab === "photos") main = `<div class="pp-body" style="grid-template-columns:1fr"><div class="pp-card"><h3>Photos</h3><div class="pp-grid" style="grid-template-columns:repeat(auto-fill,minmax(120px,1fr))">${photos.map((p) => `<img src="${E(p.photo)}" alt="" loading="lazy" data-ppimg>`).join("") || '<p class="muted">No photos yet.</p>'}</div></div></div>`;
    box.style.setProperty("--ppc", c);
    box.innerHTML = `<div class="pp-wrap"><div class="pp-close"><button type="button" data-pp="close" aria-label="Back">←</button><b>${E(m.handle || "Member")}</b></div>
<div class="pp-cover${mine && cover ? " mine-cover" : ""}" style="${cover ? `background-image:url('${E(cover)}');background-position:${E(posOf(m))}` : ""}">${mine && cover ? `<span class="pp-covhint">↕ Drag to position your cover</span>` : ""}${mine ? `<button class="btn sm ghost ed" type="button" data-pp="edit">📷 ${cover ? "Change" : "Add"} cover photo</button>` : ""}</div>
<div class="pp-top"><div class="pp-av${mine && av ? " mine-av" : ""}"${mine ? ` data-pp="edit" role="button" title="Edit profile — or drag to position your picture"` : ""} style="${av ? `background-image:url('${E(av)}');background-position:${E(posOf(m, "photoPos"))}` : ""}">${av ? "" : E(((m.handle || "?").trim()[0] || "?").toUpperCase())}${mine ? `<span class="pp-camb">📷</span>` : ""}</div>
<div class="pp-name"><h2>${E(m.handle || "Member")}</h2>${m.bio ? `<p class="bio">${E(m.bio)}</p>` : ""}<span class="fc">${friends.length} friend${friends.length === 1 ? "" : "s"}</span>${mutual.length ? `<div class="fc" style="font-weight:600">${mutual.length} mutual friend${mutual.length === 1 ? "" : "s"}</div>` : ""}${friends.length ? `<div class="pp-stack">${friends.slice(0, 8).map((f) => { const fm = MEM()[f] || {}, fp = img(fm.photo); return `<button type="button" data-profile="${E(f)}" title="${E(fm.handle || "Member")}" style="${fp ? `background-image:url('${E(fp)}')` : ""}">${fp ? "" : E(((fm.handle || "?").trim()[0] || "?").toUpperCase())}</button>`; }).join("")}</div>` : ""}</div></div>
<div class="pp-acts">${btn}</div>
<div class="pp-tabs">${[["posts", "Posts"], ["about", "About"], ["friends", "Friends"], ["photos", "Photos"]].map(([k, n]) => `<button type="button" data-pptab="${k}" aria-pressed="${tab === k}">${n}</button>`).join("")}</div>
${main}</div>`;
  }

  function open(id) {
    if (!id || !MEM()[id]) { say("That profile isn't available."); return; }
    uid = id; tab = "posts";
    let box = document.getElementById("pp");
    if (!box) { box = document.createElement("div"); box.id = "pp"; box.setAttribute("role", "dialog"); box.setAttribute("aria-label", "Profile"); document.body.appendChild(box); wire(box); }
    box.hidden = false; box.scrollTop = 0; document.documentElement.style.overflow = "hidden"; document.body.classList.add("pp-open"); paint();
    try { history.pushState({ pp: id }, "", "#u/" + id); } catch (_) {}
  }
  function close() { const b = document.getElementById("pp"); if (b) b.hidden = true; document.documentElement.style.overflow = ""; document.body.classList.remove("pp-open"); uid = null; if (/^#u\//.test(location.hash)) try { history.back(); } catch (_) {} }
  function wire(box) {
    /* photo positioning: drag your own cover or profile picture to frame it (Facebook-style), then Save.
     * Position is stored as background-position percentages ("50% 30%") on the member doc
     * (coverPos / photoPos) and honored everywhere the photo renders. */
    let drag = null, swallowClick = false;
    const dragStart = (e, el, url, key, avMode) => {
      const [px, py] = parsePos((MEM()[uid] || {})[key]).split(" ").map((v) => parseFloat(v));
      drag = { el, key, avMode, sx: e.clientX, sy: e.clientY, px, py, x: px, y: py, moved: false, nat: null };
      const im = new Image(); im.onload = () => { if (drag) drag.nat = { w: im.naturalWidth, h: im.naturalHeight }; }; im.src = url;
      try { el.setPointerCapture(e.pointerId); } catch (_) {}
    };
    box.addEventListener("pointerdown", (e) => {
      if (uid !== ME()) return;
      const cov = e.target.closest(".pp-cover.mine-cover");
      if (cov && !e.target.closest("button")) { const m = MEM()[uid] || {}; if (img(m.cover)) dragStart(e, cov, img(m.cover), "coverPos", false); return; }
      const av = e.target.closest(".pp-av.mine-av");
      if (av) { const m = MEM()[uid] || {}; if (img(m.photo)) dragStart(e, av, img(m.photo), "photoPos", true); }
    });
    box.addEventListener("pointermove", (e) => {
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
        try { const d2 = DB(); if (!d2) throw new Error("no db"); await d2.doc("members/" + ME()).update({ [d.key]: val }); if (MEM()[ME()]) MEM()[ME()][d.key] = val; say("Position saved"); }
        catch (err) { say("Couldn't save: " + (err.message || err)); }
        paint();
      });
      bar.querySelector(".cancel").addEventListener("click", () => paint());
      d.el.appendChild(bar);
    };
    box.addEventListener("pointerup", endDrag); box.addEventListener("pointercancel", endDrag);
    box.addEventListener("click", async (e) => {
      if (swallowClick) { swallowClick = false; e.preventDefault(); e.stopPropagation(); return; } // the click after a position drag isn't a tap
      const t = e.target.closest("[data-pptab]"); if (t) { tab = t.dataset.pptab; paint(); return; }
      const im = e.target.closest("[data-ppimg]"); if (im) { window.open(im.src, "_blank", "noopener"); return; }
      const b = e.target.closest("[data-pp]"); if (!b) return;
      const k = b.dataset.pp;
      if (k === "close") return close();
      if (k === "edit") { const id = uid; close(); window.MW_profileSetup ? MW_profileSetup.open() : say("Open Edit profile from the menu."); return; }
      if (k === "gift") { if (typeof openGift === "function") openGift(uid); return; }
      if (k === "add") { if (typeof needMember === "function" && !needMember()) return; if (await MW_FRIENDS.add(uid)) say(MW_FRIENDS.status(uid) === "friends" ? "You're friends now!" : "Friend request sent"); paint(); return; }
      if (k === "unf") { if (!b.dataset.confirm) { b.dataset.confirm = 1; b.textContent = "Tap again to remove"; return; } await MW_FRIENDS.remove(uid); paint(); }
    });
  }
  window.addEventListener("popstate", () => { const b = document.getElementById("pp"); if (b && !b.hidden && !/^#u\//.test(location.hash)) { b.hidden = true; document.documentElement.style.overflow = ""; document.body.classList.remove("pp-open"); uid = null; } });
  // Messages from the profile page close it first
  document.addEventListener("click", (e) => {
    const dm = e.target.closest("#pp [data-dm]"); if (dm) { const b = document.getElementById("pp"); if (b) b.hidden = true; document.documentElement.style.overflow = ""; document.body.classList.remove("pp-open"); return; }
    if (e.target.closest("#me-av, #me-handle, [data-myprofile]")) { e.preventDefault(); if (ME()) open(ME()); return; }
    const p = e.target.closest("[data-profile], .avatar[data-uid], .post-head .who b");
    if (!p || e.target.closest("button[data-dm],button[data-add],button[data-acc]")) return;
    let id = p.dataset.profile || p.dataset.uid;
    if (!id && p.matches(".post-head .who b")) id = p.closest(".post-head")?.querySelector(".avatar[data-uid]")?.dataset.uid;
    if (!id) return;
    e.preventDefault(); open(id);
  });
  document.addEventListener("mw-posts", () => { if (uid) paint(); });
  window.MW_profilePage = { open, mine: () => ME() && open(ME()) };
  if (/^#u\/[\w-]+$/.test(location.hash)) setTimeout(() => open(location.hash.slice(3)), 2500);
})();
