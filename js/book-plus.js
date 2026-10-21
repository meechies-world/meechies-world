/* Meechie's Book extras (better than FB):
 * - Feed filters: All · Friends · 🔖 Saved · 🎬 Videos · 📷 Photos, plus search, plus tap any #hashtag to see only those posts
 * - ⋯ menu on every post: Save, Hide, Copy link, Report, Delete (your own posts)
 * - Double-tap a photo to like it (with a gold heart burst)
 * - Links to a single post (meechiesworldinc.com/#post-ID) open right to it
 * Saved and hidden posts are kept on this device only (private). */
(function () {
  "use strict";
  const view = document.getElementById("v-community"); const feed = document.getElementById("feed"); if (!view || !feed) return;
  const E = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const say = (t) => (typeof toast === "function" ? toast(t) : null);
  const ME = () => { try { return typeof me !== "undefined" ? me : null; } catch (_) { return null; } };
  const OWNER = () => { try { return typeof isOwner !== "undefined" && !!isOwner; } catch (_) { return false; } };
  const POSTS = () => { try { return typeof posts !== "undefined" ? posts : []; } catch (_) { return []; } };
  const NAME = (id) => { try { return typeof handleOf === "function" ? handleOf(id) : ""; } catch (_) { return ""; } };
  const OWNER_ID = "9c4f7de6-bd82-46f9-88af-7fac069fe0e9";
  const load = (k) => { try { return new Set(JSON.parse(localStorage.getItem(k) || "[]")); } catch (_) { return new Set(); } };
  const store = (k, s) => { try { localStorage.setItem(k, JSON.stringify([...s].slice(-500))); } catch (_) {} };
  const saved = load("mw_saved_posts"), hidden = load("mw_hidden_posts");
  let filter = "all", tag = "", q = "";

  const css = document.createElement("style");
  css.textContent = `#bk-bar{display:grid;gap:8px;margin:0 0 14px}
#bk-bar .chips{display:flex;gap:6px;overflow-x:auto;scrollbar-width:none;padding-bottom:2px}#bk-bar .chips::-webkit-scrollbar{display:none}
#bk-bar .chips button{flex:none;border:1px solid rgba(214,170,74,.45);background:rgba(10,8,5,.7);color:#e9dfc6;border-radius:999px;padding:7px 13px;font:700 13px system-ui;cursor:pointer}
#bk-bar .chips button[aria-pressed=true]{background:linear-gradient(172deg,#fff6cf,#ffd76a 30%,#e0a93a 60%,#ffe08a);color:#130e04;border-color:#ffe08a}
#bk-bar input{width:100%;border-radius:999px!important;padding:10px 14px!important;font:15px system-ui}
@media(max-width:760px){#bk-bar{padding:0 12px}}
.bk-more{margin-left:6px;width:34px;height:34px;flex:none;border-radius:50%;border:0;background:transparent;color:inherit;font:900 18px/1 system-ui;cursor:pointer;opacity:.8}
.bk-more:hover{background:rgba(214,170,74,.15);opacity:1}
.bk-menu{position:absolute;z-index:30;right:12px;top:52px;min-width:210px;display:grid;padding:6px;border-radius:14px;background:#120f09;border:1px solid rgba(214,170,74,.55);box-shadow:0 18px 40px rgba(0,0,0,.6)}
.bk-menu button{display:flex;gap:10px;align-items:center;text-align:left;border:0;background:none;color:#f3ecdc;padding:10px 12px;border-radius:10px;font:600 14px system-ui;cursor:pointer}.bk-menu button:hover{background:rgba(214,170,74,.14)}
#feed .post{position:relative}
#feed .post.bk-off{display:none!important}
.bk-tag{color:#ffd76a;font-weight:700;cursor:pointer;text-decoration:none}
.bk-heart{position:absolute;left:50%;top:50%;font-size:96px;pointer-events:none;transform:translate(-50%,-50%) scale(.2);opacity:0;animation:bkHeart .9s ease-out forwards;filter:drop-shadow(0 6px 18px rgba(0,0,0,.5));z-index:5}
@keyframes bkHeart{30%{transform:translate(-50%,-50%) scale(1.15);opacity:1}70%{transform:translate(-50%,-50%) scale(1);opacity:1}100%{transform:translate(-50%,-60%) scale(.9);opacity:0}}
#bk-empty{text-align:center;padding:24px;color:#bbb}`;
  document.head.appendChild(css);

  // the filter bar goes right above the feed
  const bar = document.createElement("div"); bar.id = "bk-bar";
  bar.innerHTML = `<div class="chips" role="tablist">${[["all", "🏠 All"], ["friends", "👥 Friends"], ["saved", "🔖 Saved"], ["videos", "🎬 Videos"], ["photos", "📷 Photos"]].map(([k, n]) => `<button type="button" data-bk="${k}" aria-pressed="${k === "all"}">${n}</button>`).join("")}<button type="button" data-bk-tag hidden></button></div>
<input type="search" id="bk-q" placeholder="🔍 Search posts and people" aria-label="Search posts" autocomplete="off">`;
  feed.before(bar);
  const empty = document.createElement("div"); empty.id = "bk-empty"; empty.hidden = true; feed.after(empty);

  const idOf = (el) => (el.querySelector("[data-rbox]") || {}).dataset?.rbox || "";
  const friends = () => { try { return new Set(window.MW_FRIENDS && MW_FRIENDS.list ? MW_FRIENDS.list() : []); } catch (_) { return new Set(); } };
  function apply() {
    const byId = new Map(POSTS().map((p) => [p.id, p])), fr = friends(); let shown = 0;
    feed.querySelectorAll(":scope > .post").forEach((el) => {
      const id = idOf(el), p = byId.get(id) || {}; let ok = !hidden.has(id);
      if (ok && filter === "friends") ok = fr.has(p.authorId) || p.authorId === ME();
      if (ok && filter === "saved") ok = saved.has(id);
      if (ok && filter === "videos") ok = /^https:\/\//.test(p.video || "");
      if (ok && filter === "photos") ok = !!p.photo;
      if (ok && tag) ok = new RegExp("#" + tag + "\\b", "i").test(p.text || "");
      if (ok && q) ok = (String(p.text || "") + " " + NAME(p.authorId)).toLowerCase().includes(q);
      el.classList.toggle("bk-off", !ok); if (ok) shown++;
    });
    empty.hidden = shown > 0 || !feed.querySelector(".post");
    empty.textContent = filter === "saved" ? "Nothing saved yet. Tap ⋯ on a post and choose Save." : filter === "friends" ? "No posts from friends yet. Add friends in Friends." : "No posts match.";
  }
  function decorate() {
    feed.querySelectorAll(":scope > .post").forEach((el) => {
      const head = el.querySelector(".post-head"); if (head && !head.querySelector(".bk-more")) { const b = document.createElement("button"); b.type = "button"; b.className = "bk-more"; b.setAttribute("aria-label", "More options"); b.textContent = "⋯"; head.appendChild(b); }
      const t = el.querySelector(".post-text"); if (t && !t.dataset.bkDone) { t.dataset.bkDone = 1; t.innerHTML = t.innerHTML.replace(/(^|\s)#([A-Za-z0-9_]{2,40})/g, (m, sp, h) => `${sp}<a class="bk-tag" href="#community" data-bk-hash="${h}">#${h}</a>`); }
    });
    apply();
  }
  function closeMenu() { document.querySelectorAll(".bk-menu").forEach((m) => m.remove()); }
  function menu(el) {
    closeMenu(); const id = idOf(el), p = POSTS().find((x) => x.id === id) || {}; const mine = p.authorId === ME();
    const m = document.createElement("div"); m.className = "bk-menu"; m.setAttribute("role", "menu");
    m.innerHTML = `<button type="button" data-bkm="save">${saved.has(id) ? "🔖 Remove from saved" : "🔖 Save post"}</button><button type="button" data-bkm="link">🔗 Copy link</button>${mine ? "" : `<button type="button" data-bkm="hide">🙈 Hide this post</button><button type="button" data-bkm="report">⚑ Report post</button>`}${mine || OWNER() ? `<button type="button" data-bkm="del">🗑 Delete post</button>` : ""}`;
    m.dataset.id = id; el.appendChild(m);
  }
  document.addEventListener("click", async (e) => {
    const t = e.target;
    if (!t.closest(".bk-menu") && !t.closest(".bk-more")) closeMenu();
    const c = t.closest("[data-bk]"); if (c) { filter = c.dataset.bk; tag = ""; bar.querySelector("[data-bk-tag]").hidden = true; bar.querySelectorAll("[data-bk]").forEach((b) => b.setAttribute("aria-pressed", String(b === c))); return apply(); }
    const h = t.closest("[data-bk-hash]"); if (h) { e.preventDefault(); e.stopPropagation(); tag = h.dataset.bkHash; const tb = bar.querySelector("[data-bk-tag]"); tb.hidden = false; tb.textContent = "#" + tag + " ✕"; tb.setAttribute("aria-pressed", "true"); bar.querySelectorAll("[data-bk]").forEach((b) => b.setAttribute("aria-pressed", "false")); filter = "all"; apply(); bar.scrollIntoView({ behavior: "smooth", block: "start" }); return; }
    if (t.closest("[data-bk-tag]")) { tag = ""; t.closest("[data-bk-tag]").hidden = true; bar.querySelector('[data-bk="all"]').click(); return; }
    const mb = t.closest(".bk-more"); if (mb) { e.preventDefault(); const el = mb.closest(".post"); if (el.querySelector(".bk-menu")) return closeMenu(); return menu(el); }
    const it = t.closest("[data-bkm]"); if (!it) return;
    const id = it.closest(".bk-menu").dataset.id, p = POSTS().find((x) => x.id === id) || {}; closeMenu();
    const k = it.dataset.bkm;
    if (k === "save") { if (saved.has(id)) { saved.delete(id); say("Removed from saved"); } else { saved.add(id); say("Saved 🔖 Find it under Saved"); } store("mw_saved_posts", saved); apply(); }
    if (k === "hide") { hidden.add(id); store("mw_hidden_posts", hidden); apply(); say("Post hidden"); }
    if (k === "link") { const u = location.origin + "/#post-" + id; try { await navigator.clipboard.writeText(u); say("Link copied"); } catch (_) { prompt("Copy this link:", u); } }
    if (k === "report") { const why = prompt("What's wrong with this post? (spam, hateful, nudity, scam, someone under 18…)"); if (!why) return; try { const r = await MW.sb.from("dms").insert({ recipient: OWNER_ID, body: `⚑ Report on a Meechie's Book post by ${NAME(p.authorId)} (post ${id}): ${why.slice(0, 300)}` }); if (r.error) throw r.error; hidden.add(id); store("mw_hidden_posts", hidden); apply(); say("Thanks. Meechie will look at it. It's hidden for you."); } catch (er) { say(er.message || "Couldn't send the report."); } }
    if (k === "del") { if (!confirmDel(it)) return; try { const db = await claude.use("db"); await db.doc("posts/" + id).delete(); say("Post deleted"); } catch (er) { say(er.message || er.code); } }
  }, true); // capture: the feed's own click handlers stop some clicks before they bubble up
  function confirmDel() { return window.confirm("Delete this post for everyone?"); }
  // double-tap a photo to like it
  let lastTap = 0, lastEl = null;
  feed.addEventListener("click", (e) => {
    const img = e.target.closest(".post img.photo"); if (!img) return;
    const now = Date.now(); if (lastEl === img && now - lastTap < 320) {
      e.preventDefault(); e.stopPropagation(); const el = img.closest(".post"); const like = el.querySelector("[data-like]");
      if (like && !like.classList.contains("on")) like.click();
      const hz = document.createElement("span"); hz.className = "bk-heart"; hz.textContent = "💛"; img.parentElement.style.position = "relative"; img.parentElement.appendChild(hz); setTimeout(() => hz.remove(), 950);
      lastTap = 0; return;
    }
    lastTap = now; lastEl = img;
  }, true);
  bar.addEventListener("input", (e) => { if (e.target.id === "bk-q") { q = e.target.value.trim().toLowerCase(); clearTimeout(bar._t); bar._t = setTimeout(apply, 180); } });
  // #post-ID links
  function deep() { const m = /^#post-([A-Za-z0-9_-]{4,64})$/.exec(location.hash); if (!m) return; if (typeof go === "function") go("community"); let n = 0; const iv = setInterval(() => { const el = document.querySelector(`[data-rbox="${m[1]}"]`); if (el || ++n > 30) { clearInterval(iv); if (el) { const post = el.closest(".post"); post.classList.remove("bk-off"); post.scrollIntoView({ behavior: "smooth", block: "center" }); post.style.boxShadow = "0 0 0 2px #ffd76a, 0 0 30px rgba(255,200,90,.4)"; setTimeout(() => (post.style.boxShadow = ""), 3500); } } }, 400); }
  addEventListener("hashchange", deep); setTimeout(deep, 1500);
  let t = null; new MutationObserver(() => { clearTimeout(t); t = setTimeout(decorate, 80); }).observe(feed, { childList: true, subtree: true });
  document.addEventListener("mw-posts", () => setTimeout(decorate, 50));
  decorate();
})();
