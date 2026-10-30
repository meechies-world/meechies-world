/* ============================================================================
   v2 VIEW — MEECHIE'S BOOK (#community). MAP §4.4: "THE social surface —
   the Facebook-look feed app-core.js + fb-feed.js + fb-feed-plus.js +
   stories.js + book-plus.js build on #v-community."

   A faithful port of the live Book onto the shell: the same posts /
   stories / members / gifts / follows / friends collections through the
   shared social layer (js/social.js), so a post made here shows on the
   live site and vice versa. The owner's count rules stand exactly as
   written (Law 11: like counts under 25 hidden; comment counts under 3
   hidden; the owner seat sees both).

   Facebook chrome note: on the live site #fb-top / #fb-tabs / #fb-left /
   #fb-right are body-level furniture the fb-feed batches put on EVERY
   view (the owner's rule). The v2 shell only lets a view own its own
   section, so here they live and die with the Book view — flagged in the
   Phase 3 differences list.
   ============================================================================ */
import { createSocial, esc, safeUrl, safeImg, initial, ago, say, compress, GIFTS, OWNER_ID, likeCountVisible, commentCountVisible, sortFeed, trendingIds, storyGroups, STORY_BGS, emailHash } from "../social.js";
import { openGift, paintDailyCard } from "../commerce.js";

const REACTS = [["👍", "Like"], ["❤️", "Love"], ["🤗", "Care"], ["😂", "Haha"], ["😮", "Wow"], ["😢", "Sad"], ["😡", "Angry"]];
const REACT_NAMES = Object.fromEntries(REACTS);
const RULES = ["Be real. Verified people only — no fake accounts.", "Respect the community. No harassment or hate.", "Meechie reviews reports and can remove posts or members.", "Support each other — this is a movement, not just an app."];
const $ = (s, r) => (r || document).querySelector(s);
const $$ = (s, r) => [...(r || document).querySelectorAll(s)];

let cur = null; // the live instance, for destroy()
export function destroy() { if (cur) { cur.teardown(); cur = null; } }

export async function render(root, ctx) {
  const S = createSocial(ctx);
  const me = S.me();
  const state = {
    posts: [], stories: [], gifts: [], admin: false,
    openReplies: new Set(), replyWatchers: new Map(),
    saved: new Set(JSON.parse(localStorage.getItem("mw_saved_posts") || "[]")),
    hidden: new Set(JSON.parse(localStorage.getItem("mw_hidden_posts") || "[]")),
    seenStories: new Set(JSON.parse(localStorage.getItem("mw_story_seen") || "[]")),
    seenNotes: new Set(JSON.parse(localStorage.getItem("mw_fb_seen") || "[]")),
    filter: { chip: "all", q: "", tag: "" },
    pendingPhoto: "", pendingVideo: null, uploading: false,
    myReacts: {}, refreshTimer: null,
  };
  const saveSet = (key, set) => { try { localStorage.setItem(key, JSON.stringify([...set].slice(-400))); } catch (_) {} };
  const isOwnerSeat = () => state.admin;

  /* ---------------- skeleton (the live #v-community markup) ------------- */
  root.innerHTML = `
  <div class="fb-top" id="fb-top">
    <span class="wm">meechie's book</span>
    <button type="button" data-fb="search" aria-label="Search people">🔍</button>
    <button type="button" data-fb="msgs" aria-label="Messenger">💬<i hidden></i></button>
    <button type="button" data-fb="radio" aria-label="Live radio">📻<i hidden></i></button>
    <button type="button" data-fb="me" aria-label="My profile">👤</button>
  </div>
  <div class="fb-tabs" id="fb-tabs" role="tablist" aria-label="Meechie's Book">
    ${[["home", "🏠", "Home"], ["friends", "👥", "Friends"], ["video", "📺", "Video"], ["market", "🛍️", "Marketplace"], ["notes", "🔔", "Notifications"], ["menu", "☰", "Menu"]].map(([k, ic, n]) => `<button type="button" data-fbt="${k}" aria-label="${n}" aria-pressed="${k === "home"}">${ic}<i hidden></i><small>${n}</small></button>`).join("")}
  </div>
  <div class="fb-notes" id="fb-notes" hidden></div>
  <img class="book-poster" src="/img/book-cover.jpg" alt="Meechie's Book — Meechie with his dogs" onerror="this.remove()">
  <div class="section-head"><div><p class="kicker">The community</p><h2>Meechie's Book</h2></div>
  <p class="muted">Real people only. Post, comment, gift coins and go live — this is the neighborhood.</p></div>
  <div class="grid-2">
    <div class="main-col">
      <div class="fb-mind" id="fb-mind" hidden>
        <span data-mind-av></span>
        <button type="button" class="fb-mind-in" data-mind>What's on your mind?</button>
        <div class="fb-mind-row">
          <button type="button" data-mind-act="live">🔴 Live video</button>
          <button type="button" data-mind-act="media">🖼️ Photo/video</button>
          <button type="button" data-mind-act="feel">😊 Feeling/activity</button>
        </div>
      </div>
      <div class="fb-stories" id="fb-stories" hidden></div>
      <form class="card composer" id="composer" hidden>
        <div class="row"><b data-composer-who>Post to Meechie's Book</b>
          <label class="fl-btn" id="announce-wrap" hidden><input type="checkbox" id="p-announce"> 📣 Announcement (shows on the home page)</label></div>
        <textarea id="p-text" rows="3" maxlength="2000" placeholder="What's on your mind?" aria-label="Write a post"></textarea>
        <img class="preview-img" id="p-preview" alt="Your photo" hidden>
        <div class="vid-pick" id="vid-pick" hidden></div>
        <div class="row">
          <span style="display:flex;gap:8px;flex-wrap:wrap">
            <label class="btn ghost sm file-btn">📷 Photo<input type="file" id="p-photo" accept="image/*" hidden></label>
            <label class="btn ghost sm file-btn">🎬 Video<input type="file" id="p-video" accept="video/*" hidden></label>
          </span>
          <button class="btn" id="p-post" type="submit">Post</button>
        </div>
      </form>
      <div class="bk-bar" id="bk-bar" hidden>
        <div class="bk-chips" role="tablist" aria-label="Filter the feed">
          <button type="button" class="bk-chip on" data-bk="all">All</button>
          <button type="button" class="bk-chip" data-bk="friends">Friends</button>
          <button type="button" class="bk-chip" data-bk="saved">🔖 Saved</button>
          <button type="button" class="bk-chip" data-bk="videos">🎬 Videos</button>
          <button type="button" class="bk-chip" data-bk="photos">📷 Photos</button>
          <span class="bk-tagchip" data-bk-tagchip hidden>#<b></b><button type="button" data-bk-tagx aria-label="Clear tag filter">✕</button></span>
        </div>
        <input class="bk-search" id="bk-q" type="search" placeholder="Search posts…" aria-label="Search posts">
        <span class="bk-count" id="bk-count"></span>
      </div>
      <div class="feed" id="feed"><p class="muted">Loading the Book…</p></div>
    </div>
    <aside class="side">
      <div class="card" id="me-card" hidden></div>
      <div class="card" id="daily-card" hidden></div>
      <div class="card"><h3 style="margin-top:0">Recent gifts</h3><div class="gift-feed" id="gift-feed"><p class="muted">No gifts yet.</p></div></div>
      <div class="card"><h3 style="margin-top:0">Newest members</h3><div class="member-list" id="member-list"></div></div>
      <div class="card"><h3 style="margin-top:0">Community rules</h3><ol class="steps">${RULES.map((r) => `<li>${esc(r)}</li>`).join("")}</ol></div>
    </aside>
  </div>
  <div class="card" id="join-card" hidden>
    <h3 style="margin-top:0">You're signed in — one step left</h3>
    <p class="muted">Pick the name everyone sees and you're a member. Free forever.</p>
    <form id="join-form" style="display:grid;gap:10px">
      <input class="bk-search" id="j-handle" maxlength="40" placeholder="Your name or handle" aria-label="Your name or handle" required>
      <input class="bk-search" id="j-bio" maxlength="120" placeholder="One line about you (optional)" aria-label="One line about you">
      <button class="btn" type="submit">Join free</button>
    </form>
  </div>
  <div class="card" id="signed-out" hidden>
    <h3 style="margin-top:0">You're browsing free</h3>
    <p class="muted">Members can post, comment, gift and message. Joining is free.</p>
    <a class="btn" href="/">Join free / Sign in</a>
  </div>
  <dialog id="profile-dialog">
    <form method="dialog" class="card" id="profile-form" style="display:grid;gap:10px;min-width:min(420px,86vw)">
      <h3 style="margin:0">Edit profile</h3>
      <label>Name <input class="bk-search" id="pf-handle" maxlength="40"></label>
      <label>Bio <input class="bk-search" id="pf-bio" maxlength="120"></label>
      <label>Photo <input type="file" id="pf-photo" accept="image/*"></label>
      <label>Printify store link <input class="bk-search" id="pf-printify" placeholder="https://…"></label>
      <label>Shopify store link <input class="bk-search" id="pf-shopify" placeholder="https://…"></label>
      <label>Other store link <input class="bk-search" id="pf-other" placeholder="https://…"></label>
      <div class="row" style="display:flex;gap:8px;justify-content:flex-end"><button class="btn ghost" value="cancel" formnovalidate>Cancel</button><button class="btn" id="pf-save" value="default">Save</button></div>
    </form>
  </dialog>`;

  /* ---------------- data load ------------------------------------------ */
  state.admin = await S.isAdmin();
  await S.loadMembers();
  await S.loadLists();
  const refreshData = async () => {
    const [posts, stories, gifts] = await Promise.all([
      S.docs("posts", { field: "createdAt", limit: 100 }),
      S.docs("stories", { field: "createdAt", limit: 150 }),
      S.docs("gifts", { field: "createdAt", limit: 300 }),
    ]);
    state.posts = posts; state.stories = stories; state.gifts = gifts;
    state.myReacts = {}; if (me) for (const p of posts) if (p.reacts && p.reacts[me]) state.myReacts[p.id] = p.reacts[me];
  };
  paintDailyCard(root.querySelector("#daily-card"), ctx).catch(() => {});
  await refreshData();

  /* keep my email fingerprint current (find-by-email, live email-find.js) */
  (async () => {
    if (!me || !S.myDoc) return;
    try {
      if (S.myDoc.emailFind === false) { if (S.myDoc.emailHash) await S.mergeDoc("members/" + me, { emailHash: "" }); return; }
      const u = S.user(); const h = u && u.email ? await emailHash(u.email) : "";
      if (h && S.myDoc.emailHash !== h) await S.mergeDoc("members/" + me, { emailHash: h });
    } catch (_) {}
  })();

  /* ---------------- sidebar cards -------------------------------------- */
  function renderSide() {
    const prof = S.myDoc;
    const meCard = $("#me-card", root);
    if (me && prof) {
      meCard.hidden = false;
      meCard.innerHTML = `<div style="display:flex;gap:12px;align-items:center">${S.avatarOf(me)}<div><b>${esc(prof.handle || "Member")}</b><div class="muted" style="font-size:13px">${+(prof.giftsReceived || 0)} gifts received</div></div></div>
      <div style="display:flex;gap:8px;margin-top:12px;flex-wrap:wrap"><button class="btn sm" type="button" data-golive>🔴 Go Live</button><button class="btn ghost sm" type="button" data-editprof>Edit profile</button></div>`;
    } else meCard.hidden = true;
    $("#join-card", root).hidden = !(me && !prof);
    $("#signed-out", root).hidden = !!me;
    const gf = $("#gift-feed", root);
    gf.innerHTML = state.gifts.length ? state.gifts.slice(0, 12).map((g) => { const G = GIFTS.find((x) => x[0] === g.kind) || GIFTS[0]; return `<div><span style="font-size:18px">${G[1]}</span> <b>${esc(S.handleOf(g.from))}</b> → <b>${esc(S.handleOf(g.to))}</b>${g.note ? ` <span class="muted">“${esc(g.note)}”</span>` : ""}</div>`; }).join("") : `<p class="muted">No gifts yet.</p>`;
    const ids = Object.keys(S.members).slice(0, 8);
    $("#member-list", root).innerHTML = ids.map((id) => `<div>${S.avatarOf(id)}<span><b>${esc(S.handleOf(id))}</b></span>${id !== me ? `<button class="btn ghost sm" type="button" data-dm="${esc(id)}">Message</button>` : ""}</div>`).join("");
  }

  /* ---------------- the feed ------------------------------------------- */
  const feedEl = $("#feed", root);
  const following = () => S.following();
  const linkTags = (t) => esc(t).replace(/#([\p{L}\p{N}_]+)/gu, (m, tag) => `<a href="#" class="bk-tag" data-tag="${esc(tag)}">#${esc(tag)}</a>`);
  const ordered = () => sortFeed(state.posts.filter((p) => !state.hidden.has(p.id)), following());
  let trendCache = null;
  const trend = () => trendCache || (trendCache = trendingIds(state.posts, Date.now()));

  function sumRow(p) {
    const rx = p.reacts || {}, em = [...new Set(Object.values(rx))];
    const n = Math.max((p.likes || []).length, Object.keys(rx).length);
    if (!em.length && !(p.likes || []).length) return "";
    const top = (em.length ? em : ["👍"]).slice(0, 3).map((e) => `<span class="fbx-rem">${e}</span>`).join("");
    const cnt = likeCountVisible(n, isOwnerSeat()) ? `<span>${n}</span>` : "";
    const cc = +p.replyCount || 0;
    const cmt = commentCountVisible(cc, isOwnerSeat()) ? `<button type="button" data-comments="${esc(p.id)}">${cc} comment${cc === 1 ? "" : "s"}</button>` : `<button type="button" data-comments="${esc(p.id)}">View comments</button>`;
    return `<div class="fbx-sum">${top}${cnt}<span class="fbx-c">${cmt}</span></div>`;
  }

  function postCard(p) {
    const mine = p.authorId === me, tr = trend();
    const followed = following().has(p.authorId);
    const head = `<div class="post-head">${S.avatarOf(p.authorId)}<div class="who"><b>${esc(S.handleOf(p.authorId))}</b><small>${ago(p.createdAt)} · 🌐</small></div>
      ${mine ? "" : p.announce ? `<div style="margin-left:auto;text-align:right"><span class="tag">From Meechie</span><div class="muted" style="font-size:11px">Everyone</div></div>` : p.sponsored ? `<span class="tag" style="margin-left:auto">Promoted</span>` : `<span style="margin-left:auto"></span><button class="fl-btn${followed ? " on" : ""}" type="button" data-follow="${esc(p.authorId)}">${followed ? "Following" : "+ Follow"}</button><button class="fl-btn" type="button" data-dm="${esc(p.authorId)}">Message</button>`}
      <button class="bk-dots" type="button" data-menu="${esc(p.id)}" aria-label="Post options">⋯</button></div>
      ${mine && S.shopLinks(S.myDoc || {}).length ? `<div class="muted" style="font-size:12px">Your shop: ${S.shopLinks(S.myDoc).map(([n, u]) => `<a href="${esc(safeUrl(u))}" target="_blank" rel="noopener">${esc(n)}</a>`).join(" · ")}</div>` : ""}`;
    const likeN = Math.max((p.likes || []).length, Object.keys(p.reacts || {}).length);
    const myR = state.myReacts[p.id];
    const likeLbl = myR ? `${myR} ${REACT_NAMES[myR] || "Like"}` : "👍 Like";
    const acts = `<div class="post-actions">
      <button class="act${(p.likes || []).includes(me) || myR ? " on" : ""}" type="button" data-like="${esc(p.id)}">${likeLbl}${likeCountVisible(likeN, isOwnerSeat()) ? ` · ${likeN}` : ""}</button>
      <button class="act" type="button" data-replies="${esc(p.id)}">💬 Comment${commentCountVisible(+p.replyCount || 0, isOwnerSeat()) ? ` · ${+p.replyCount}` : ""}</button>
      <button class="act" type="button" data-share="${esc(p.id)}">↗ Share</button>
      ${mine ? "" : `<button class="act" type="button" data-gift="${esc(p.authorId)}">🎁 Gift</button>`}
      ${state.admin ? `<button class="act" type="button" data-pin="${esc(p.id)}">${p.sponsored ? "📌 Promoted" : "📌 Pin as promoted"}</button>` : ""}
      ${mine || state.admin ? `<button class="act" type="button" data-del="${esc(p.id)}">Delete</button>` : ""}
    </div>`;
    return `<article class="post${p.sponsored ? " sponsored" : ""}" data-id="${esc(p.id)}" data-author="${esc(p.authorId)}">
      <div class="post-body">${head}
      ${tr.has(p.id) ? `<span class="trend-badge">🔥 Trending</span>` : ""}
      ${p.text ? `<p class="post-text${!p.photo && !p.video && !p.audio && p.text.length <= 120 ? " big" : ""}">${linkTags(p.text)}</p>` : ""}
      ${p.photo ? `<img class="photo" src="${esc(p.photo)}" alt="Post photo" loading="lazy">` : ""}
      ${p.video ? `<video class="vid" src="${esc(p.video)}#t=0.1" controls playsinline preload="metadata"></video>` : ""}
      ${p.audio ? `<audio class="aud" src="${esc(p.audio)}" controls preload="metadata"></audio>` : ""}
      </div>${sumRow(p)}${acts}
      <div class="replies" data-rbox="${esc(p.id)}" ${state.openReplies.has(p.id) ? "" : "hidden"}><div class="r-list"></div>
      ${me ? `<form class="reply-form" data-rform="${esc(p.id)}">${S.avatarOf(me)}<label class="fl-btn r-pic" title="Add a photo">📷<input type="file" accept="image/*" hidden data-rphoto="${esc(p.id)}"></label><img class="r-prev" data-rprev="${esc(p.id)}" alt="" hidden><input maxlength="500" placeholder="Write a comment…" aria-label="Write a comment" data-rin="${esc(p.id)}"><button class="btn sm" type="submit">Reply</button></form>` : `<p class="muted">Sign in to join the conversation.</p>`}
      </div></article>`;
  }

  function pymkCard() {
    const cands = Object.keys(S.members).filter((id) => id !== me && S.friendStatus(id) === "none").slice(0, 12);
    if (!me || cands.length < 2) return "";
    return `<div class="card pymk"><h3>People you may know</h3><div class="pymk-row">${cands.map((id) => { const m = S.members[id]; return `<div class="pymk-c">${S.avatarOf(id)}<b>${esc(m.handle || "Member")}</b>${m.bio ? `<small>${esc(m.bio)}</small>` : ""}<button class="btn sm" type="button" data-addfriend="${esc(id)}">Add friend</button></div>`; }).join("")}</div></div>`;
  }

  function renderFeed() {
    trendCache = null;
    const list = ordered();
    if (!list.length) { feedEl.innerHTML = `<div class="empty">No posts yet. Be the first to say something.</div>`; }
    else {
      let html = "", pymkDone = false;
      list.forEach((p, i) => { html += postCard(p); if (i === 1 && !pymkDone) { html += pymkCard(); pymkDone = true; } });
      feedEl.innerHTML = html;
    }
    applyFilters();
    for (const id of state.openReplies) loadReplies(id);
  }

  /* book-plus filter bar: chips + search + hashtag, device-local */
  function applyFilters() {
    const f = state.filter;
    const friendsOf = new Set([...S.friendIds(), ...following()]);
    let shown = 0, total = 0;
    $$(".post", feedEl).forEach((el) => {
      total++;
      const p = state.posts.find((x) => x.id === el.dataset.id); if (!p) { el.classList.add("bk-off"); return; }
      let ok = true;
      if (f.chip === "saved") ok = state.saved.has(p.id);
      else if (f.chip === "videos") ok = !!p.video;
      else if (f.chip === "photos") ok = !!p.photo;
      else if (f.chip === "friends") ok = friendsOf.has(p.authorId) || p.authorId === me;
      if (ok && f.tag) ok = new RegExp("#" + f.tag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "(\\s|$)", "i").test(p.text || "");
      if (ok && f.q) { const q = f.q.toLowerCase(); ok = (p.text || "").toLowerCase().includes(q) || S.handleOf(p.authorId).toLowerCase().includes(q); }
      el.classList.toggle("bk-off", !ok); if (ok) shown++;
    });
    const c = $("#bk-count", root); if (c) c.textContent = f.chip === "all" && !f.q && !f.tag ? (total ? total + " posts" : "") : shown + " of " + total + " shown";
    const tc = $("[data-bk-tagchip]", root);
    if (tc) { tc.hidden = !f.tag; if (f.tag) tc.querySelector("b").textContent = f.tag; }
  }

  /* ---------------- replies -------------------------------------------- */
  async function loadReplies(id) {
    const box = $(`[data-rbox="${CSS.escape(id)}"]`, root); if (!box) return;
    const reps = await S.docs("posts/" + id + "/replies", { field: "createdAt", asc: true, limit: 200 });
    const list = box.querySelector(".r-list");
    list.innerHTML = reps.map((r) => `<div class="reply">${S.avatarOf(r.authorId)}<div class="r-main"><div class="r-bub"><b>${esc(S.handleOf(r.authorId))}</b> <span>${esc(r.text || "")}</span>${r.photo ? `<img class="r-img" src="${esc(r.photo)}" alt="Comment photo" loading="lazy">` : ""}</div><div class="r-time">${ago(r.createdAt)}</div></div></div>`).join("");
    if (!state.replyWatchers.has(id)) {
      state.replyWatchers.set(id, S.bus.watch(["posts/" + id + "/replies"], () => loadReplies(id)));
    }
  }
  async function toggleReplies(id) {
    const box = $(`[data-rbox="${CSS.escape(id)}"]`, root); if (!box) return;
    if (box.hidden) { box.hidden = false; state.openReplies.add(id); await loadReplies(id); const inp = box.querySelector("input[data-rin]"); if (inp) inp.focus(); }
    else { box.hidden = true; state.openReplies.delete(id); }
  }

  /* ---------------- reactions (fb-feed-plus) ---------------------------- */
  let rbar = null, rbarFor = null, pressTimer = null, hoverTimer = null;
  function closeRbar() { if (rbar) { rbar.remove(); rbar = null; rbarFor = null; } }
  function openRbar(btn, id) {
    closeRbar();
    rbarFor = id;
    rbar = document.createElement("div"); rbar.id = "fbx-rbar";
    rbar.innerHTML = REACTS.map(([e, n]) => `<button type="button" data-rem="${e}" title="${n}">${e}</button>`).join("");
    document.body.appendChild(rbar);
    const r = btn.getBoundingClientRect();
    rbar.style.left = Math.max(6, Math.min(innerWidth - rbar.offsetWidth - 6, r.left)) + "px";
    rbar.style.top = Math.max(6, r.top - rbar.offsetHeight - 6 + scrollY) + "px";
    rbar.addEventListener("click", (e) => { const b = e.target.closest("[data-rem]"); if (b) { react(id, b.dataset.rem); closeRbar(); } });
  }
  async function react(id, emoji) {
    if (!S.needMember()) return;
    const p = state.posts.find((x) => x.id === id); if (!p) return;
    p.reacts = p.reacts || {}; p.likes = p.likes || [];
    const cur = p.reacts[me];
    if (emoji && cur !== emoji) { p.reacts[me] = emoji; if (!p.likes.includes(me)) p.likes.push(me); state.myReacts[id] = emoji; }
    else { delete p.reacts[me]; p.likes = p.likes.filter((x) => x !== me); delete state.myReacts[id]; }
    try { await S.mergeDoc("posts/" + id, { reacts: p.reacts, likes: p.likes }); } catch (e) { say(e.message); }
    renderFeed();
  }
  async function like(id) {
    if (!S.needMember()) return;
    const p = state.posts.find((x) => x.id === id); if (!p) return;
    p.likes = p.likes || [];
    if (p.likes.includes(me)) p.likes = p.likes.filter((x) => x !== me); else p.likes.push(me);
    try { await S.mergeDoc("posts/" + id, { likes: p.likes }); } catch (e) { say(e.message); }
    renderFeed();
  }

  /* ---------------- stories (stories.js, ported) ----------------------- */
  const storiesEl = $("#fb-stories", root);
  let storyViews = {};
  async function loadStoryViews() {
    const rows = await S.docs("storyviews", { field: "at", limit: 400 });
    storyViews = {}; rows.forEach((v) => { (storyViews[v.story] = storyViews[v.story] || new Set()).add(v.authorId); });
  }
  const storyThumb = (s) => s.kind === "text" ? `<span class="txt" style="background:${STORY_BGS[s.bg] || STORY_BGS.gold}">${esc(String(s.text || "").slice(0, 60))}</span>` : "";
  function renderStories() {
    const gs = storyGroups(state.stories, state.seenStories, me, new Set(S.friendIds()));
    const myG = gs.find((g) => g.uid === me);
    const myPhoto = S.myDoc ? safeImg(S.myDoc.photo) : "";
    storiesEl.hidden = false;
    storiesEl.innerHTML = `<button type="button" class="st add" data-st-new><div class="top"${myPhoto ? ` style="background-image:url('${esc(myPhoto)}')"` : ""}>${myPhoto ? "" : "📷"}</div><span class="plus">+</span><b>${myG ? "Add to story" : "Create story"}</b></button>` +
      gs.map((g, i) => { const s = g.list[g.list.length - 1]; const bg = s.kind === "photo" ? ` style="background-image:url('${esc(safeImg(s.url) || s.url)}')"` : "";
        return `<button type="button" class="st${g.unseen ? "" : " seen"}" data-st-open="${i}"${bg}>${s.kind === "video" ? `<video src="${esc(s.url)}#t=0.5" muted playsinline preload="metadata" style="position:absolute;inset:0;width:100%;height:100%;object-fit:cover"></video>` : ""}${storyThumb(s)}<span class="ring">${S.avatarOf(g.uid)}</span><b>${g.uid === me ? "Your story" : esc(S.handleOf(g.uid))}</b></button>`; }).join("");
    storiesEl._groups = gs;
  }

  /* the viewer: live show()/tick()/pause() semantics — 6s photos and
     text, video for its length capped at 30s, hold to pause, swipe
     down to close */
  const V = { on: false, gs: [], gi: 0, si: 0, t0: 0, paused: false, pausedAt: 0, dur: 6000, timer: null };
  const curStory = () => (V.gs[V.gi] || {}).list ? V.gs[V.gi].list[V.si] : null;
  function closeViewer() {
    if (V.timer) clearInterval(V.timer);
    V.on = false;
    document.documentElement.style.overflow = "";
    const el = $("#st-view", root); if (el) el.remove();
  }
  function markSeen(s) {
    if (!me || s.authorId === me) return;
    if (storyViews[s.id] && storyViews[s.id].has(me)) return;
    (storyViews[s.id] = storyViews[s.id] || new Set()).add(me);
    S.setDoc("storyviews/" + (s.id + "_" + me.replace(/-/g, "")).slice(0, 64), { authorId: me, story: s.id, owner: s.authorId, at: Date.now() }).catch(() => {});
  }
  function pauseStory(on) {
    if (!V.on) return;
    if (on && !V.paused) { V.paused = true; V.pausedAt = Date.now(); const v = $("#st-view video", root); if (v) v.pause(); }
    else if (!on && V.paused) { V.paused = false; V.t0 += Date.now() - V.pausedAt; const v = $("#st-view video", root); if (v) v.play().catch(() => {}); }
  }
  function tickStory() {
    if (!V.on || V.paused) return;
    const el = $("#st-view", root); if (!el) return;
    const b = el.querySelectorAll(".bars b")[V.si];
    const el2 = Date.now() - V.t0;
    if (b) b.style.width = Math.min(100, el2 / V.dur * 100) + "%";
    if (el2 >= V.dur) { V.si++; V.si < V.gs[V.gi].list.length ? showStory() : closeViewer(); }
  }
  function showStory() {
    const g = V.gs[V.gi], s = curStory(); if (!s) return closeViewer();
    const el = $("#st-view", root); if (!el) return;
    const mineStory = s.authorId === me;
    V.t0 = Date.now(); V.paused = false; V.dur = 6000;
    const stage = el.querySelector(".stage");
    if (s.kind === "video") {
      stage.innerHTML = `<video src="${esc(s.url)}" playsinline autoplay></video>`;
      const v = stage.querySelector("video");
      v.addEventListener("loadedmetadata", () => { if (V.on) V.dur = Math.min(30000, (v.duration || 6) * 1000); });
      v.play().catch(() => { v.muted = true; v.play().catch(() => {}); });
    } else if (s.kind === "text") stage.innerHTML = `<div class="text" style="background:${STORY_BGS[s.bg] || STORY_BGS.gold}">${esc(s.text || "")}</div>`;
    else stage.innerHTML = `<img src="${esc(s.url)}" alt="" draggable="false">`;
    const cap = el.querySelector(".cap"); cap.hidden = !s.caption; cap.textContent = s.caption || "";
    el.querySelector(".bars").innerHTML = g.list.map((_, k) => `<i><b style="width:${k < V.si ? 100 : 0}%"></b></i>`).join("");
    const mins = Math.floor((Date.now() - s.createdAt) / 6e4), agoS = mins < 1 ? "now" : mins < 60 ? mins + "m" : Math.floor(mins / 60) + "h";
    el.querySelector(".who").innerHTML = `${S.avatarOf(g.uid)}<span>${mineStory ? "Your story" : esc(S.handleOf(g.uid))} <small>${agoS}</small></span>`;
    const foot = el.querySelector(".foot");
    if (mineStory) {
      const n = (storyViews[s.id] || new Set()).size;
      foot.innerHTML = `<div class="own"><button type="button" class="ghost" data-st-seen>👁 Seen by ${n}</button><button type="button" class="ghost" data-st-del>🗑 Delete</button><button type="button" data-st-new>＋ Add</button></div>`;
    } else {
      foot.innerHTML = `<div class="reacts">${["😍", "🔥", "😂", "👏", "💯", "👑"].map((r) => `<button type="button" data-st-react="${r}" aria-label="React ${r}">${r}</button>`).join("")}</div><form data-st-replyform><input maxlength="300" placeholder="Reply to ${esc(S.handleOf(g.uid))}…" aria-label="Reply"><button type="submit">Send</button></form>`;
      markSeen(s);
    }
    state.seenStories.add(s.id); saveSet("mw_story_seen", state.seenStories);
  }
  function openViewer(gi) {
    const gs = storiesEl._groups || storyGroups(state.stories, state.seenStories, me, new Set(S.friendIds()));
    if (!gs[gi]) return;
    closeViewer();
    V.on = true; V.gs = gs; V.gi = gi;
    V.si = gs[gi].list.findIndex((s) => !state.seenStories.has(s.id)); if (V.si < 0) V.si = 0;
    const el = document.createElement("div"); el.id = "st-view"; el.setAttribute("role", "dialog"); el.setAttribute("aria-label", "Story");
    el.innerHTML = `<div class="stage"></div><div class="bars"></div><div class="who"></div><button type="button" class="x" data-st-x aria-label="Close">×</button><div class="tap l" data-st-prev></div><div class="tap r" data-st-next></div><div class="cap" hidden></div><div class="foot"></div>`;
    root.appendChild(el);
    document.documentElement.style.overflow = "hidden";
    let y0 = null, held = null;
    el.addEventListener("pointerdown", (e) => { if (e.target.closest("button,input,form,#st-seen")) return; y0 = e.clientY; held = setTimeout(() => pauseStory(true), 180); });
    el.addEventListener("pointerup", (e) => { clearTimeout(held); if (y0 != null && e.clientY - y0 > 90) { closeViewer(); return; } if (V.paused) pauseStory(false); y0 = null; });
    showStory();
    V.timer = setInterval(tickStory, 80);
  }
  function toggleSeenPanel() {
    const el = $("#st-view", root); if (!el) return;
    const old = $("#st-seen", el); if (old) { old.remove(); return; }
    const s = curStory(); if (!s) return;
    const ids = [...(storyViews[s.id] || new Set())];
    const p = document.createElement("div"); p.id = "st-seen";
    p.innerHTML = ids.length ? ids.map((id) => `<div>${S.avatarOf(id)}<span>${esc(S.handleOf(id))}</span></div>`).join("") : `<div>No views yet.</div>`;
    el.appendChild(p);
  }

  /* story composer (#st-new, the live dialog) */
  function openStoryComposer() {
    if (!me) return say("Sign in to post a story.");
    if (!S.myDoc) return say("Join free first. Pick a handle above.");
    closeStoryDialog();
    const d = document.createElement("dialog"); d.id = "st-new"; root.appendChild(d);
    const draft = { kind: "photo", file: null, bg: "gold" };
    d.innerHTML = `<form id="st-form"><h3 style="margin:0">✨ Create a story</h3><p class="muted" style="margin:0;font-size:13px">Stories disappear after 24 hours.</p>
    <div class="tabs"><button type="button" data-st-kind="photo" aria-pressed="true">📷 Photo / video</button><button type="button" data-st-kind="text" aria-pressed="false">Aa Text</button></div>
    <div class="prev" id="st-prev"><span class="muted">Pick a photo or video</span></div>
    <input type="file" id="st-file" accept="image/*,video/*" hidden>
    <div id="st-photo-row"><button type="button" class="btn ghost" style="width:100%" data-st-pick>📁 Choose from your phone</button></div>
    <div id="st-text-row" hidden><textarea id="st-text" maxlength="200" rows="3" placeholder="Start typing…"></textarea><div class="bgs" style="margin-top:8px">${Object.entries(STORY_BGS).map(([k, v]) => `<button type="button" data-st-bg="${k}" style="background:${v}" aria-pressed="${k === "gold"}" aria-label="${k}"></button>`).join("")}</div></div>
    <input type="text" id="st-cap" maxlength="140" placeholder="Add a caption (optional)">
    <div class="st-bar-wrap" hidden><div class="st-upbar"></div></div>
    <div style="display:flex;gap:8px;justify-content:flex-end"><button type="button" class="btn ghost" data-st-cancel>Cancel</button><button class="btn" type="submit" id="st-share">Share to story</button></div></form>`;
    d.showModal();
    const paintPrev = () => {
      const p = $("#st-prev", d); if (!p) return;
      if (draft.kind === "text") { const t = $("#st-text", d).value; p.innerHTML = `<div class="text" style="background:${STORY_BGS[draft.bg]}">${esc(t || "Start typing…")}</div>`; }
      else if (draft.file) { const u = URL.createObjectURL(draft.file); p.innerHTML = /^video\//.test(draft.file.type) ? `<video src="${u}" muted autoplay loop playsinline></video>` : `<img src="${u}" alt="">`; }
      else p.innerHTML = `<span class="muted">Pick a photo or video</span>`;
    };
    d.addEventListener("click", (e) => {
      if (e.target === d) { closeStoryDialog(); return; }
      const k = e.target.closest("[data-st-kind]");
      if (k) { draft.kind = k.dataset.stKind; $$("[data-st-kind]", d).forEach((x) => x.setAttribute("aria-pressed", String(x === k))); $("#st-photo-row", d).hidden = draft.kind !== "photo"; $("#st-text-row", d).hidden = draft.kind !== "text"; paintPrev(); return; }
      const bgB = e.target.closest("[data-st-bg]");
      if (bgB) { draft.bg = bgB.dataset.stBg; $$("[data-st-bg]", d).forEach((x) => x.setAttribute("aria-pressed", String(x === bgB))); paintPrev(); return; }
      if (e.target.closest("[data-st-pick]")) { $("#st-file", d).click(); return; }
      if (e.target.closest("[data-st-cancel]")) closeStoryDialog();
    });
    $("#st-file", d).addEventListener("change", (e) => { draft.file = e.target.files[0] || null; paintPrev(); });
    $("#st-text", d).addEventListener("input", paintPrev);
    $("#st-form", d).addEventListener("submit", async (e) => {
      e.preventDefault();
      const btn = $("#st-share", d); btn.disabled = true;
      try {
        let s = { authorId: me, createdAt: Date.now(), caption: $("#st-cap", d).value.trim() };
        if (draft.kind === "text") { const t = $("#st-text", d).value.trim(); if (!t) { say("Write something first."); btn.disabled = false; return; } s = { ...s, kind: "text", text: t, bg: draft.bg }; }
        else if (draft.file && /^video\//.test(draft.file.type)) { const up = await S.uploadVideo(draft.file, (f) => { $(".st-bar-wrap", d).hidden = false; $(".st-upbar", d).style.width = Math.round(f * 100) + "%"; }); s = { ...s, kind: "video", url: up.url }; }
        else if (draft.file) { const durl = await compress(draft.file, 1440); const blob = await (await fetch(durl)).blob(); const up = await S.uploadMedia(blob, { type: "image/jpeg", ext: "jpg" }); s = { ...s, kind: "photo", url: up.url }; }
        else { say("Pick a photo or video first."); btn.disabled = false; return; }
        await S.addDoc("stories", s);
        say("Story posted — gone in 24 hours ⏳");
        closeStoryDialog(); await refreshData(); renderStories();
      } catch (err) { say(err.message || "Story failed."); btn.disabled = false; }
    });
  }
  function closeStoryDialog() { const d = $("#st-new", root); if (d) { try { d.close(); } catch (_) {} d.remove(); } }

  /* ---------------- composer -------------------------------------------- */
  const composer = $("#composer", root);
  function syncComposer() {
    const show = !!(me && S.myDoc);
    composer.hidden = !show;
    $("#fb-mind", root).hidden = !show;
    $("#bk-bar", root).hidden = false;
    if (show) {
      $("[data-composer-who]", root).textContent = "Post to Meechie's Book";
      const first = (S.myDoc.handle || "").split(" ")[0];
      $("[data-mind]", root).textContent = "What's on your mind" + (first ? ", " + first : "") + "?";
      $("[data-mind-av]", root).innerHTML = S.avatarOf(me);
      $("#announce-wrap", root).hidden = !state.admin;
    }
  }
  $("#p-photo", root).addEventListener("change", async (e) => {
    const f = e.target.files[0]; if (!f) return;
    try { state.pendingPhoto = await compress(f); const pv = $("#p-preview", root); pv.src = state.pendingPhoto; pv.hidden = false; } catch (err) { say(err.message); }
    e.target.value = "";
  });
  $("#p-video", root).addEventListener("change", async (e) => {
    const f = e.target.files[0]; if (!f || state.uploading) return;
    state.uploading = true;
    const pick = $("#vid-pick", root); pick.hidden = false;
    pick.innerHTML = `<span>🎬 ${esc(f.name)}</span><div class="vid-bar"><i style="width:2%"></i></div><span class="muted">Converting for phones, then uploading — keep this open…</span>`;
    const bar = pick.querySelector(".vid-bar i"), note = pick.querySelector(".muted");
    try {
      state.pendingVideo = await S.uploadVideo(f, (fr) => { bar.style.width = Math.round(2 + fr * 96) + "%"; });
      bar.style.width = "100%"; note.textContent = "Video ready — it'll post with your words when you tap Post.";
    } catch (err) { pick.innerHTML = ""; pick.hidden = true; state.pendingVideo = null; say(err.message); }
    state.uploading = false; e.target.value = "";
  });
  composer.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (!S.needMember()) return;
    if (state.uploading) return say("Wait for the video to finish uploading.");
    const ann = state.admin && $("#p-announce", root).checked;
    const data = {
      authorId: me, text: $("#p-text", root).value.trim(), photo: state.pendingPhoto || "",
      ...(state.pendingVideo ? { video: state.pendingVideo.url, videoPath: state.pendingVideo.path } : {}),
      likes: [], replyCount: 0, sponsored: ann, announce: ann, createdAt: Date.now(),
    };
    if (!data.text && !data.photo && !data.video) return say("Write something or add a photo or video first.");
    try { await S.addDoc("posts", data); }
    catch (err) { if (state.pendingVideo) S.deleteMedia(state.pendingVideo.path); say(err.message || "Post failed."); return; }
    $("#p-text", root).value = ""; state.pendingPhoto = ""; state.pendingVideo = null;
    $("#p-preview", root).hidden = true; const pick = $("#vid-pick", root); pick.innerHTML = ""; pick.hidden = true;
    $("#p-announce", root).checked = false;
    say("Posted to Meechie's Book 📖");
    await refreshData(); renderFeed(); updateNotesBadge();
  });

  /* ---------------- notifications (fb-feed noteList, ported) ------------- */
  function noteList() {
    if (!me) return [];
    const out = [];
    for (const u of S.friendRequests()) out.push({ k: "f:" + u, who: u, html: `<b>${esc(S.handleOf(u))}</b> sent you a friend request.`, sub: "Tap to accept", go: "friends" });
    for (const p of state.posts.filter((x) => x.authorId === me).slice(0, 40)) {
      const snip = esc(String(p.text || (p.photo ? "your photo" : p.video ? "your video" : "your post")).slice(0, 50));
      const rx = p.reacts && typeof p.reacts === "object" ? Object.entries(p.reacts).filter(([u, e]) => u !== me && e) : [];
      const likers = Array.isArray(p.likes) ? p.likes.filter((u) => u !== me && !(p.reacts && p.reacts[u])) : [];
      for (const [u, e] of rx) out.push({ k: "r:" + p.id + ":" + u, who: u, emo: e, html: `<b>${esc(S.handleOf(u))}</b> reacted ${esc(e)} to your post: “${snip}”`, post: p.id });
      for (const u of likers) out.push({ k: "r:" + p.id + ":" + u, who: u, emo: "👍", html: `<b>${esc(S.handleOf(u))}</b> liked your post: “${snip}”`, post: p.id });
      if (+p.replyCount > 0) out.push({ k: "c:" + p.id + ":" + p.replyCount, emo: "💬", html: `<b>${+p.replyCount} comment${+p.replyCount > 1 ? "s" : ""}</b> on your post: “${snip}”`, post: p.id });
    }
    return out.slice(0, 60);
  }
  function setTab(k) { $$("#fb-tabs [data-fbt]", root).forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.fbt === k))); }
  function updateNotesBadge() {
    if (!me) return;
    const list = noteList(), fresh = list.filter((n) => !state.seenNotes.has(n.k)).length;
    const bell = $('#fb-tabs [data-fbt="notes"] i', root); if (bell) { bell.hidden = !fresh; bell.textContent = fresh > 9 ? "9+" : String(fresh); }
    const rq = S.friendRequests().length;
    const fb = $('#fb-tabs [data-fbt="friends"] i', root); if (fb) { fb.hidden = !rq; fb.textContent = String(rq); }
    const box = $("#fb-notes", root); if (box && !box.hidden) paintNotes();
  }
  function paintNotes() {
    const box = $("#fb-notes", root); if (!box) return;
    const list = noteList();
    box.innerHTML = `<h3>Notifications</h3>` + (me ? (list.length ? list.map((n, i) => `<button type="button" class="n${state.seenNotes.has(n.k) ? "" : " new"}" data-note="${i}">${n.who ? S.avatarOf(n.who) : `<span class="e">${n.emo || "🔔"}</span>`}<span>${n.html}${n.sub ? `<small>${esc(n.sub)}</small>` : ""}</span></button>`).join("") : `<div class="empty">Nothing yet. When people react to or comment on your posts, it shows up here.</div>`) : `<div class="empty">Sign in to see your notifications.</div>`);
    box._list = list;
  }
  function toggleNotes() {
    const box = $("#fb-notes", root);
    if (!box.hidden) { box.hidden = true; setTab("home"); return; }
    paintNotes(); box.hidden = false; setTab("notes");
    setTimeout(() => { noteList().forEach((n) => state.seenNotes.add(n.k)); saveSet("mw_fb_seen", state.seenNotes); updateNotesBadge(); }, 1500);
  }

  /* ---------------- post ⋯ menu + lightbox (book-plus) ------------------- */
  let menuEl = null, lightEl = null;
  function closeMenu() { if (menuEl) { menuEl.remove(); menuEl = null; } }
  function openMenu(btn, id) {
    closeMenu();
    const p = state.posts.find((x) => x.id === id); if (!p) return;
    const minePost = p.authorId === me;
    menuEl = document.createElement("div"); menuEl.className = "bk-menu";
    menuEl.innerHTML = `
      <button type="button" data-mi="save">${state.saved.has(id) ? "✓ Saved — tap to unsave" : "🔖 Save post"}</button>
      <button type="button" data-mi="copy">🔗 Copy link</button>
      <button type="button" data-mi="hide">🙈 Hide post</button>
      ${minePost || state.admin ? "" : `<button type="button" data-mi="report">⚑ Report post</button>`}
      ${minePost || state.admin ? `<button type="button" data-mi="del">🗑 Delete post</button>` : ""}`;
    document.body.appendChild(menuEl);
    const r = btn.getBoundingClientRect();
    menuEl.style.top = (r.bottom + scrollY + 4) + "px";
    menuEl.style.left = Math.max(6, Math.min(innerWidth - 190, r.right - 180)) + "px";
    menuEl.addEventListener("click", async (e) => {
      const b = e.target.closest("[data-mi]"); if (!b) return;
      const act = b.dataset.mi; closeMenu();
      if (act === "save") { state.saved.has(id) ? state.saved.delete(id) : state.saved.add(id); saveSet("mw_saved_posts", state.saved); say(state.saved.has(id) ? "Saved 🔖 — find it under Saved in the filter bar." : "Removed from Saved."); applyFilters(); }
      if (act === "copy") { const link = location.origin + "/#post-" + id; try { await navigator.clipboard.writeText(link); say("Link copied 🔗"); } catch (_) { say(link); } }
      if (act === "hide") { state.hidden.add(id); saveSet("mw_hidden_posts", state.hidden); renderFeed(); say("Hidden 🙈 — it'll stay hidden on this device."); }
      if (act === "report") {
        if (!me) return say("Sign in to report.");
        const why = prompt("What's wrong with this post? Meechie reviews every report."); if (why == null) return;
        try { await S.dmInsert(OWNER_ID, `⚑ Report on a Meechie's Book post by ${S.handleOf(me)} (post ${id}): ${String(why).slice(0, 300)}`); say("Reported ⚑ — Meechie will take a look. Thank you."); }
        catch (err) { say(err.message || "Report failed."); }
      }
      if (act === "del") deletePost(id);
    });
  }
  async function deletePost(id) {
    if (!confirm("Delete this post for everyone?")) return;
    try {
      const reps = await S.docs("posts/" + id + "/replies", { field: "createdAt", limit: 500 });
      for (const r of reps) await S.delDoc("posts/" + id + "/replies/" + r.id).catch(() => {});
      await S.delDoc("posts/" + id);
      state.posts = state.posts.filter((p) => p.id !== id); renderFeed(); say("Post deleted.");
    } catch (e) { say(e.message); }
  }
  function openLight(src) {
    closeLight();
    lightEl = document.createElement("div"); lightEl.id = "fbx-light";
    lightEl.innerHTML = `<img src="${esc(src)}" alt="Post photo, full size">`;
    lightEl.addEventListener("click", closeLight);
    document.body.appendChild(lightEl);
  }
  function closeLight() { if (lightEl) { lightEl.remove(); lightEl = null; } }

  /* ---------------- events ------------------------------------------------ */
  const replyPhotos = new Map();
  const dmTo = (uid) => { try { sessionStorage.setItem("mw2-dm-target", uid); } catch (_) {} location.hash = "#messages"; };
  const docClick = (e) => { if (rbar && !e.target.closest("#fbx-rbar") && !e.target.closest("[data-like]")) closeRbar(); if (menuEl && !e.target.closest(".bk-menu") && !e.target.closest("[data-menu]")) closeMenu(); };
  document.addEventListener("click", docClick);

  root.addEventListener("click", async (e) => {
    const t = e.target;
    const dm = t.closest("[data-dm]"); if (dm) return dmTo(dm.dataset.dm);
    const fol = t.closest("[data-follow]");
    if (fol) { if (!me) return say("Sign in to follow people."); const id = fol.dataset.follow; const on = following().has(id); try { await S.setList("follows", on ? [...following()].filter((x) => x !== id) : [...following(), id]); say(on ? "Unfollowed." : "Following " + S.handleOf(id) + " ⭐"); renderFeed(); } catch (err) { say(err.message); } return; }
    const af = t.closest("[data-addfriend]");
    if (af) { const id = af.dataset.addfriend; try { await S.ensureList("friends"); await S.setList("friends", [...(S.friends[me] || []), id]); say("Friend request sent to " + S.handleOf(id) + " 🤝"); renderFeed(); } catch (err) { say(err.message); } return; }
    const likeBtn = t.closest("[data-like]");
    if (likeBtn) { if (rbarFor === likeBtn.dataset.like && rbar) { closeRbar(); return; } if (state.myReacts[likeBtn.dataset.like]) react(likeBtn.dataset.like, ""); else like(likeBtn.dataset.like); return; }
    const rep = t.closest("[data-replies],[data-comments]"); if (rep) return toggleReplies(rep.dataset.replies || rep.dataset.comments);
    const sh = t.closest("[data-share]");
    if (sh) { const p = state.posts.find((x) => x.id === sh.dataset.share); const txt = p ? (p.text || "A post on Meechie's Book") : "Meechie's Book"; const url = location.origin + "/#community"; if (navigator.share) navigator.share({ title: "Meechie's Book", text: txt, url }).catch(() => {}); else { try { await navigator.clipboard.writeText(txt + " " + url); say("Link copied — share it anywhere 🔗"); } catch (_) { say(url); } } return; }
    const gf = t.closest("[data-gift]"); if (gf) { openGift(ctx, gf.dataset.gift, S.handleOf(gf.dataset.gift)); return; }
    const pin = t.closest("[data-pin]");
    if (pin) { const p = state.posts.find((x) => x.id === pin.dataset.pin); if (p) { try { await S.mergeDoc("posts/" + p.id, { sponsored: !p.sponsored }); p.sponsored = !p.sponsored; renderFeed(); say(p.sponsored ? "Pinned as promoted 📌" : "Unpinned."); } catch (err) { say(err.message); } } return; }
    const del = t.closest("[data-del]");
    if (del) { if (del.dataset.arm) { deletePost(del.dataset.del); } else { del.dataset.arm = "1"; del.textContent = "Tap again to delete"; setTimeout(() => { del.dataset.arm = ""; del.textContent = "Delete"; }, 2600); } return; }
    const mn = t.closest("[data-menu]"); if (mn) return openMenu(mn, mn.dataset.menu);
    const tag = t.closest(".bk-tag"); if (tag) { e.preventDefault(); state.filter.tag = tag.dataset.tag; applyFilters(); $("#bk-bar", root).scrollIntoView({ behavior: "smooth", block: "start" }); return; }
    const ph = t.closest(".post .photo"); if (ph && !t.closest(".bk-menu")) { openLight(ph.src); return; }
    const sc = t.closest("[data-st-new]"); if (sc) { if (V.on) closeViewer(); return openStoryComposer(); }
    const so = t.closest("[data-st-open]"); if (so) return openViewer(+so.dataset.stOpen);
    if (t.closest("[data-st-x]")) return closeViewer();
    if (t.closest("[data-st-prev]")) { V.si = Math.max(0, V.si - 1); showStory(); return; }
    if (t.closest("[data-st-next]")) { V.si++; V.si < (V.gs[V.gi] || { list: [] }).list.length ? showStory() : closeViewer(); return; }
    if (t.closest("[data-st-seen]")) { toggleSeenPanel(); return; }
    const sd = t.closest("[data-st-del]"); if (sd) { const s = curStory(); if (s) { try { await S.delDoc("stories/" + s.id); say("Story deleted."); closeViewer(); await refreshData(); renderStories(); } catch (err) { say(err.message); } } return; }
    const sr = t.closest("[data-st-react]");
    if (sr) { const s = curStory(); if (s && S.needMember()) { try { await S.dmInsert(s.authorId, sr.dataset.stReact + " reacted to your story"); say("Sent " + sr.dataset.stReact); } catch (err) { say(err.message); } } return; }
    if (t.closest("[data-golive]")) { location.hash = "#live"; return; }
    if (t.closest("[data-editprof]")) {
      const p = S.myDoc || {}; const d = $("#profile-dialog", root);
      $("#pf-handle", root).value = p.handle || ""; $("#pf-bio", root).value = p.bio || "";
      $("#pf-printify", root).value = p.printify || ""; $("#pf-shopify", root).value = p.shopify || ""; $("#pf-other", root).value = p.store || "";
      d.showModal(); return;
    }
    if (t.closest("#fb-top .wm")) { scrollTo({ top: 0, behavior: "smooth" }); return; }
    const fb = t.closest("[data-fb]");
    if (fb) { const k = fb.dataset.fb; if (k === "msgs") location.hash = "#messages"; else if (k === "search") location.hash = "#friends"; else if (k === "radio") location.hash = "#radio"; else if (k === "me") location.hash = "#friends"; return; }
    const tab = t.closest("[data-fbt]");
    if (tab) { const k = tab.dataset.fbt;
      if (k === "home") { $("#fb-notes", root).hidden = true; setTab("home"); root.scrollIntoView({ behavior: "smooth" }); }
      else if (k === "notes") toggleNotes();
      else if (k === "friends") location.hash = "#friends";
      else if (k === "video") location.hash = "#videos";
      else if (k === "market") location.hash = "#shop";
      else if (k === "menu") { const m = document.getElementById("hdr-menu") || document.getElementById("app-more"); if (m) m.click(); else $(".side", root).scrollIntoView({ behavior: "smooth" }); }
      return; }
    const note = t.closest("[data-note]");
    if (note) { const box = $("#fb-notes", root); const n = box && box._list ? box._list[+note.dataset.note] : null; if (n) { if (n.go) { location.hash = "#" + n.go; return; } box.hidden = true; setTab("home"); const el = n.post ? feedEl.querySelector(`.post[data-id="${CSS.escape(n.post)}"]`) : null; if (el) el.scrollIntoView({ behavior: "smooth", block: "center" }); } return; }
    const chip = t.closest("[data-bk]"); if (chip) { state.filter.chip = chip.dataset.bk; $$("[data-bk]", root).forEach((c) => c.classList.toggle("on", c === chip)); applyFilters(); return; }
    if (t.closest("[data-bk-tagx]")) { state.filter.tag = ""; applyFilters(); return; }
    const mind = t.closest("[data-mind]"); if (mind) { $("#p-text", root).focus(); composer.scrollIntoView({ behavior: "smooth", block: "center" }); return; }
    const ma = t.closest("[data-mind-act]");
    if (ma) { const k = ma.dataset.mindAct; if (k === "live") location.hash = "#live"; if (k === "media") $("#p-photo", root).click(); if (k === "feel") { const ta = $("#p-text", root); ta.value += " 😊"; ta.focus(); } return; }
  });

  /* like-button press & hover → the reaction bar (fb-feed-plus) */
  feedEl.addEventListener("pointerdown", (e) => { const b = e.target.closest("[data-like]"); if (!b) return; clearTimeout(pressTimer); pressTimer = setTimeout(() => openRbar(b, b.dataset.like), 450); });
  ["pointerup", "pointerleave", "pointercancel"].forEach((ev) => feedEl.addEventListener(ev, () => clearTimeout(pressTimer)));
  if (matchMedia("(hover:hover) and (pointer:fine)").matches) {
    feedEl.addEventListener("pointerover", (e) => { const b = e.target.closest("[data-like]"); if (!b) return; clearTimeout(hoverTimer); hoverTimer = setTimeout(() => openRbar(b, b.dataset.like), 600); });
    feedEl.addEventListener("pointerout", (e) => { if (e.target.closest("[data-like]")) clearTimeout(hoverTimer); });
  }
  feedEl.addEventListener("dblclick", (e) => { const img = e.target.closest(".post .photo"); if (img) { const art = img.closest(".post"); if (art) { like(art.dataset.id); const b = document.createElement("span"); b.className = "bk-burst"; b.textContent = "💛"; img.parentElement.appendChild(b); setTimeout(() => b.remove(), 750); } } });
  $("#bk-q", root).addEventListener("input", (e) => { state.filter.q = e.target.value.trim(); applyFilters(); });

  /* reply forms (submit + photo) */
  root.addEventListener("submit", async (e) => {
    const f = e.target.closest("[data-rform]"); if (!f) return;
    e.preventDefault();
    if (!S.needMember()) return;
    const id = f.dataset.rform, inp = f.querySelector("input[data-rin]");
    const text = inp.value.trim(), photo = replyPhotos.get(id) || "";
    if (!text && !photo) return;
    try {
      await S.addDoc("posts/" + id + "/replies", { authorId: me, text, ...(photo ? { photo } : {}), createdAt: Date.now() });
      const p = state.posts.find((x) => x.id === id);
      if (p) { p.replyCount = (+p.replyCount || 0) + 1; S.mergeDoc("posts/" + id, { replyCount: p.replyCount }).catch(() => {}); }
      inp.value = ""; replyPhotos.delete(id); const pv = f.querySelector("[data-rprev]"); if (pv) pv.hidden = true;
      loadReplies(id); renderFeed();
    } catch (err) { say(err.message); }
  });
  root.addEventListener("change", async (e) => {
    const inp = e.target.closest("[data-rphoto]"); if (!inp) return;
    const f = inp.files[0]; if (!f) return;
    try { const d = await compress(f); replyPhotos.set(inp.dataset.rphoto, d); const pv = $(`[data-rprev="${CSS.escape(inp.dataset.rphoto)}"]`, root); if (pv) { pv.src = d; pv.hidden = false; } } catch (err) { say(err.message); }
    inp.value = "";
  });
  /* story replies ride the same submit delegation */
  root.addEventListener("submit", async (e) => {
    const f = e.target.closest("[data-st-replyform]"); if (!f) return;
    e.preventDefault();
    const s = curStory(); if (!s) return;
    if (!S.needMember()) return;
    const inp = f.querySelector("input"), text = inp.value.trim(); if (!text) return;
    try { await S.dmInsert(s.authorId, "↩️ Replied to your story: " + text); inp.value = ""; say("Reply sent 💬"); } catch (err) { say(err.message); }
  });

  /* join + profile forms */
  $("#join-form", root).addEventListener("submit", async (e) => {
    e.preventDefault();
    const handle = $("#j-handle", root).value.trim(); if (!handle) return;
    const u = S.user() || {}; const md = u.user_metadata || {};
    const photo = [md.avatar_url, md.picture, md.photo].find((x) => typeof x === "string" && /^https:\/\//.test(x)) || "";
    try {
      await S.setDoc("members/" + me, { handle, bio: $("#j-bio", root).value.trim(), joinedAt: Date.now(), ...(photo ? { photo } : {}) });
      say("You're in! Welcome to Meechie's World 🎉");
      await S.loadMembers(); renderSide(); syncComposer(); renderFeed(); renderStories();
    } catch (err) { say(err.message); }
  });
  $("#profile-form", root).addEventListener("submit", async (e) => {
    e.preventDefault();
    const clean = (v) => { v = v.trim(); return /^https:\/\//i.test(v) ? v : ""; };
    const patch = { handle: $("#pf-handle", root).value.trim(), bio: $("#pf-bio", root).value.trim(), printify: clean($("#pf-printify", root).value), shopify: clean($("#pf-shopify", root).value), store: clean($("#pf-other", root).value) };
    try {
      const pf = $("#pf-photo", root).files[0];
      if (pf) { const d = await compress(pf, 512); const blob = await (await fetch(d)).blob(); const up = await S.uploadMedia(blob, { type: "image/jpeg", ext: "jpg" }); patch.photo = up.url; }
      await S.mergeDoc("members/" + me, patch);
      $("#profile-dialog", root).close(); say("Profile saved");
      await S.loadMembers(); renderSide(); renderFeed(); renderStories();
    } catch (err) { say(err.message); }
  });

  /* ---------------- FB side rails (in-view; see the header note) -------- */
  const left = document.createElement("nav"); left.id = "fb-left"; left.setAttribute("aria-label", "Shortcuts");
  left.innerHTML = `${me && S.myDoc ? `<button type="button" data-rail="#community">${S.avatarOf(me)}<span>${esc(S.myDoc.handle || "Member")}</span></button>` : ""}
    ${[["#community", "📖", "Meechie's Book"], ["#friends", "👥", "Friends"], ["#radio", "📻", "Live Radio"], ["#mwtv", "📺", "MW TV"], ["#shop", "🛍️", "Shop"], ["#messages", "💬", "Messages"], ["#clips", "🎬", "Clips"], ["#live", "🔴", "Go Live"]].map(([h, e2, n]) => `<button type="button" data-rail="${h}"><span class="fb-li">${e2}</span><span>${n}</span></button>`).join("")}
    <div class="fb-lh">Your shortcuts</div>
    <button type="button" data-rail="#community">📖<span>Meechie's Book</span></button>`;
  root.appendChild(left);
  const right = document.createElement("aside"); right.id = "fb-right"; right.setAttribute("aria-label", "Contacts");
  root.appendChild(right);
  const paintContacts = () => {
    const last = ctx.presence.last || {};
    const users = last.users || [];
    right.innerHTML = `<div class="fb-rh">ON THE SITE NOW</div>` +
      (users.length ? users.map((u) => `<div class="fb-contact"><span class="avatar sm">${esc(initial(u.name))}</span><span>${esc(u.name || "Member")}</span><span class="fb-on"></span></div>`).join("") : `<p class="muted" style="font-size:13px">Just you right now.</p>`) +
      `<div class="fb-rfoot">${last.online || 0} online · ${last.listening || 0} listening 📻</div>`;
  };
  paintContacts();
  const contactsTimer = setInterval(paintContacts, 15000);
  root.addEventListener("click", (e) => { const b = e.target.closest("[data-rail]"); if (b) location.hash = b.dataset.rail; });

  /* ---------------- first paint + live refresh --------------------------- */
  renderSide(); syncComposer(); renderFeed();
  await loadStoryViews(); renderStories();
  updateNotesBadge();
  /* arriving from Clips' 💬 button: open that post with its comments out */
  try {
    const openId = sessionStorage.getItem("mw2-open-post");
    if (openId) {
      sessionStorage.removeItem("mw2-open-post");
      const el = feedEl.querySelector(`.post[data-id="${CSS.escape(openId)}"]`);
      if (el) { el.scrollIntoView({ block: "center" }); toggleReplies(openId); }
    }
  } catch (_) {}
  let refreshQueued = false;
  S.bus.watch(["posts", "stories", "members", "gifts", "follows", "friends", "storyviews"], () => {
    if (refreshQueued) return; refreshQueued = true;
    state.refreshTimer = setTimeout(async () => {
      refreshQueued = false;
      await S.loadMembers(); await S.loadLists(); await refreshData(); await loadStoryViews();
      renderSide(); syncComposer(); renderFeed(); renderStories(); updateNotesBadge();
    }, 900);
  });

  cur = {
    teardown() {
      document.removeEventListener("click", docClick);
      clearTimeout(state.refreshTimer); clearInterval(contactsTimer);
      closeRbar(); closeMenu(); closeLight(); closeViewer(); closeStoryDialog();
      S.destroy();
    },
  };
}
