/* Facebook-style profile pages. Tap anyone's picture or name to open theirs; "My profile" opens yours.
 * Cover photo, big profile picture, name, bio, friend count, Add friend / Message, and tabs:
 * Posts, About (work, school, city, hometown, relationship, website, apps, birthday, languages, intro video), Friends, Photos (+ albums).
 * Your own profile shows how complete it is and what's left to add. */
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
.pp-top{display:grid;grid-template-columns:auto 1fr;gap:16px;align-items:end;padding:0 18px;margin-top:-64px;position:relative}
.pp-av{width:150px;height:150px;border-radius:50%;border:5px solid var(--ink,#0b0a08);outline:3px solid var(--ppc,#d4a843);background:#241d10 center/cover;display:grid;place-items:center;font:800 56px var(--body,system-ui);color:var(--gold-hi,#f0cf78)}
.pp-name{padding-bottom:10px;min-width:0}.pp-name h2{margin:0;font-size:clamp(24px,4vw,32px);overflow-wrap:anywhere}
.pp-name .bio{color:var(--muted,#bbb);margin:2px 0}.pp-name .fc{color:var(--muted,#bbb);font-weight:700;font-size:14px}
.pp-acts{display:flex;gap:8px;flex-wrap:wrap;padding:12px 18px;border-bottom:1px solid var(--line,#333)}
.pp-tabs{display:flex;gap:4px;padding:6px 12px;border-bottom:1px solid var(--line,#333);overflow-x:auto}
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
.pp-meter{margin:12px 18px 0;border:1px solid var(--line,#333);border-radius:14px;padding:10px 12px;display:grid;gap:6px;background:#0f0c08}
.pp-meter .bar{height:10px;border-radius:999px;background:#2a2316;overflow:hidden}.pp-meter .bar i{display:block;height:100%;background:linear-gradient(90deg,#b8862b,#f0cf78)}
.pp-meter small{color:var(--muted,#bbb);font-size:12px}.pp-meter .row{display:flex;gap:8px;align-items:center;justify-content:space-between;flex-wrap:wrap}
.pp-intro-v video{width:100%;max-height:420px;border-radius:12px;background:#000}
.pp-about p{margin:0;white-space:pre-wrap;overflow-wrap:anywhere}
@media (max-width:720px){.pp-body{grid-template-columns:1fr}.pp-top{grid-template-columns:1fr;justify-items:center;text-align:center;margin-top:-80px}.pp-av{width:140px;height:140px}.pp-acts{justify-content:center}}`;
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
    const ps = POSTS().filter((p) => p.authorId === uid);
    // their profile pictures (up to 5) first, then photos from their posts
    const profPics = (Array.isArray(m.photos) ? m.photos : []).filter((u) => typeof u === "string" && img(u)).slice(0, 5).map((u) => ({ photo: u }));
    const photos = [...profPics, ...ps.filter((p) => img(p.photo) && !profPics.some((q) => q.photo === p.photo))].slice(0, 30);
    const av = img(m.photo), cover = img(m.cover);
    const btn = mine ? `<button class="btn" type="button" data-pp="edit">✏️ Edit profile</button>`
      : `${st === "friends" ? `<button class="btn ghost" type="button" data-pp="unf">✓ Friends</button>` : st === "sent" ? `<button class="btn ghost" type="button" data-pp="unf">Request sent · Cancel</button>` : st === "request" ? `<button class="btn" type="button" data-pp="add">✓ Accept friend request</button>` : `<button class="btn" type="button" data-pp="add">＋ Add friend</button>`}
         <button class="btn ${st === "friends" ? "" : "ghost"}" type="button" data-dm="${E(uid)}">💬 Message</button>`;
    const intro = [
      m.bio && ["💼", E(m.bio)], m.work && ["🏢", "Works at <b>" + E(m.work) + "</b>"], m.school && ["🎓", "Went to <b>" + E(m.school) + "</b>"],
      (m.title && !m.work) && ["💼", E(m.title)], (m.title && m.work) && ["🪪", E(m.title)],
      m.college && ["🎓", "Studied at <b>" + E(m.college) + "</b>"], m.highschool && ["🏫", "Went to <b>" + E(m.highschool) + "</b>"],
      m.city && ["🏠", "Lives in <b>" + E(m.city) + "</b>"], m.hometown && ["📍", "From <b>" + E(m.hometown) + "</b>"], m.relationship && ["❤️", E(m.relationship)],
      /^https?:\/\/[^\s"<>]+$/i.test(m.website || "") && ["🌐", `<a href="${E(m.website)}" target="_blank" rel="noopener nofollow ugc">${E(String(m.website).replace(/^https?:\/\/(www\.)?/i, ""))}</a>`],
      m.phonePublic && m.phone && ["📞", `<a href="tel:${E(String(m.phone).replace(/[^\d+]/g, ""))}">${E(m.phone)}</a>`],
      m.languages && ["🗣️", "Speaks " + E(m.languages)], m.pronouns && ["🙂", E(m.pronouns)],
      /^\d{2}-\d{2}$/.test(m.birthday || "") && ["🎂", "Birthday " + E(new Date(2000, +m.birthday.slice(0, 2) - 1, +m.birthday.slice(3)).toLocaleDateString([], { month: "long", day: "numeric" }))],
      m.joinedAt && ["🗓️", "Joined " + new Date(m.joinedAt).toLocaleDateString([], { month: "long", year: "numeric" })],
    ].filter(Boolean);
    const introV = /^https:\/\//.test(m.introVideo || "") ? `<div class="pp-card pp-intro-v"><h3>🎥 Intro video</h3><video src="${E(m.introVideo)}#t=0.1" controls playsinline preload="metadata"></video></div>` : "";
    const aboutCard = m.about ? `<div class="pp-card pp-about"><h3>About me</h3><p>${E(m.about)}</p></div>` : "";
    const albums = (Array.isArray(m.albums) ? m.albums : []).map((a) => ({ name: String((a && a.name) || "Album"), photos: (a && Array.isArray(a.photos) ? a.photos : []).filter((u) => typeof u === "string" && /^https:\/\/[^\s"'()<>\\]+$/i.test(u)) })).filter((a) => a.photos.length);
    const albumCards = albums.map((a) => `<div class="pp-card"><h3>📁 ${E(a.name)} <small class="muted" style="font-weight:600">${a.photos.length}</small></h3><div class="pp-grid" style="grid-template-columns:repeat(auto-fill,minmax(120px,1fr))">${a.photos.map((u) => `<img src="${E(u)}" alt="" loading="lazy" data-ppimg>`).join("")}</div></div>`).join("");
    const sc = mine && window.MW_profileScore ? MW_profileScore(m, true) : null;
    const meterCard = sc && sc.pct < 100 ? `<div class="pp-meter"><div class="row"><b>Your profile is ${sc.pct}% complete</b><button class="btn sm" type="button" data-pp="edit">Finish my profile</button></div><div class="bar"><i style="width:${sc.pct}%"></i></div><small>Still to add: ${sc.missing.map(E).join(" · ")}</small></div>` : "";
    const introCard = `<div class="pp-card pp-intro"><h3>Intro</h3>${intro.map(([i, t]) => `<div><span>${i}</span><span>${t}</span></div>`).join("") || `<p class="muted" style="margin:0">${mine ? "Add your work, school and city in Edit profile." : "Nothing here yet."}</p>`}
      ${Array.isArray(m.interests) && m.interests.length ? `<b style="font-size:14px">Into</b><div class="pp-apps">${m.interests.slice(0, 22).map((x) => `<span style="border:1px solid var(--line,#333);border-radius:999px;padding:5px 11px;font-size:13px">${E(x)}</span>`).join("")}</div>` : ""}
      ${apps(m) ? `<b style="font-size:14px">Apps</b><div class="pp-apps">${apps(m)}</div>` : ""}</div>`;
    const photoCard = `<div class="pp-card"><h3>Photos</h3>${photos.length ? `<div class="pp-grid">${photos.slice(0, 9).map((p) => `<img src="${E(p.photo)}" alt="" loading="lazy" data-ppimg>`).join("")}</div>` : `<p class="muted" style="margin:0">No photos yet.</p>`}</div>`;
    const friendCard = `<div class="pp-card"><h3>Friends <small class="muted" style="font-weight:600">${friends.length}</small></h3>${friends.length ? `<div class="pp-fr">${friends.slice(0, 9).map((f) => `<button type="button" data-profile="${E(f)}">${sq(f)}<span>${E((MEM()[f] || {}).handle || "Member")}</span></button>`).join("")}</div>` : `<p class="muted" style="margin:0">No friends yet.</p>`}</div>`;
    const postList = ps.length ? ps.map((p) => `<article class="pp-post"><small>${typeof ago === "function" ? E(ago(p.createdAt)) : ""}</small>${p.text ? `<p>${E(p.text)}</p>` : ""}${img(p.photo) ? `<img src="${E(p.photo)}" alt="" loading="lazy">` : ""}${/^https:\/\//.test(p.video || "") ? `<video src="${E(p.video)}#t=0.1" controls playsinline preload="metadata"></video>` : ""}</article>`).join("") : `<div class="pp-card"><p class="muted" style="margin:0">${mine ? "You haven't posted yet. Share something in Community." : "No posts yet."}</p></div>`;
    let main = "";
    if (tab === "posts") main = `<div class="pp-body"><div style="display:grid;gap:16px;align-content:start">${introCard}${introV}${photoCard}${friendCard}</div><div class="pp-main">${aboutCard}${postList}</div></div>`;
    if (tab === "about") main = `<div class="pp-body" style="grid-template-columns:1fr">${aboutCard}${introCard}${introV}</div>`;
    if (tab === "friends") main = `<div class="pp-body" style="grid-template-columns:1fr"><div class="pp-card"><h3>Friends · ${friends.length}</h3><div class="pp-fr" style="grid-template-columns:repeat(auto-fill,minmax(110px,1fr))">${friends.map((f) => `<button type="button" data-profile="${E(f)}">${sq(f)}<span>${E((MEM()[f] || {}).handle || "Member")}</span></button>`).join("") || '<p class="muted">No friends yet.</p>'}</div></div></div>`;
    if (tab === "photos") main = `<div class="pp-body" style="grid-template-columns:1fr"><div class="pp-card"><h3>Photos</h3><div class="pp-grid" style="grid-template-columns:repeat(auto-fill,minmax(120px,1fr))">${photos.map((p) => `<img src="${E(p.photo)}" alt="" loading="lazy" data-ppimg>`).join("") || '<p class="muted">No photos yet.</p>'}</div></div>${albumCards}</div>`;
    box.style.setProperty("--ppc", c);
    box.innerHTML = `<div class="pp-wrap"><div class="pp-close"><button type="button" data-pp="close" aria-label="Back">←</button><b>${E(m.handle || "Member")}</b></div>
<div class="pp-cover" style="${cover ? `background-image:url('${E(cover)}')` : ""}">${mine ? `<button class="btn sm ghost ed" type="button" data-pp="edit">📷 ${cover ? "Change" : "Add"} cover photo</button>` : ""}</div>
<div class="pp-top"><div class="pp-av" style="${av ? `background-image:url('${E(av)}')` : ""}">${av ? "" : E(((m.handle || "?").trim()[0] || "?").toUpperCase())}</div>
<div class="pp-name"><h2>${E(m.handle || "Member")}</h2>${m.bio ? `<p class="bio">${E(m.bio)}</p>` : ""}<span class="fc">${friends.length} friend${friends.length === 1 ? "" : "s"}</span></div></div>
<div class="pp-acts">${btn}</div>${meterCard}
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
    box.addEventListener("click", async (e) => {
      const t = e.target.closest("[data-pptab]"); if (t) { tab = t.dataset.pptab; paint(); return; }
      const im = e.target.closest("[data-ppimg]"); if (im) { window.open(im.src, "_blank", "noopener"); return; }
      const b = e.target.closest("[data-pp]"); if (!b) return;
      const k = b.dataset.pp;
      if (k === "close") return close();
      if (k === "edit") { const id = uid; close(); window.MW_profileSetup ? MW_profileSetup.open() : say("Open Edit profile from the menu."); return; }
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
