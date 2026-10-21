/* Feed upgrades, Facebook-style (owner: "make the fb section better"):
 *  - Reactions: press and hold Like (or hover on a computer) → 👍 ❤️ 😂 😮 😢 😡
 *  - "View comments" link under posts that have comments
 *  - Tap a photo → full-screen viewer
 *  - Stories open full screen and play one after another (tap right = next, left = back)
 *  - "People you may know" row between posts
 * Works on top of the existing feed in index.html (posts, members, me, db are its globals). */
(function () {
  "use strict";
  const view = document.getElementById("v-community"), feed = document.getElementById("feed");
  if (!view || !feed) return;
  // the feed's own globals from index.html
  const GL = { posts: () => (typeof posts !== "undefined" ? posts : []), me: () => (typeof me !== "undefined" ? me : null), members: () => (typeof members !== "undefined" ? members : {}), db: () => (typeof db !== "undefined" ? db : null), isOwner: () => (typeof isOwner !== "undefined" ? isOwner : false) };
  const G = (n) => { try { return GL[n](); } catch (_) { return undefined; } };
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const REACTS = [["👍", "Like"], ["❤️", "Love"], ["🤗", "Care"], ["😂", "Haha"], ["😮", "Wow"], ["😢", "Sad"], ["😡", "Angry"]];
  const nameOf = (e) => (REACTS.find((r) => r[0] === e) || REACTS[0])[1];

  const css = document.createElement("style");
  css.textContent = `
#fbx-rbar{position:fixed;z-index:10050;display:flex;gap:4px;background:#242526;border:1px solid #3e4042;border-radius:999px;padding:6px 8px;box-shadow:0 8px 24px rgba(0,0,0,.5);animation:fbxPop .16s ease-out}
#fbx-rbar button{border:0;background:none;font-size:30px;line-height:1;cursor:pointer;transition:transform .12s;padding:2px}
#fbx-rbar button:hover,#fbx-rbar button:focus{transform:scale(1.35) translateY(-4px)}
@keyframes fbxPop{from{transform:scale(.6);opacity:0}}
.fbx-sum{display:flex;align-items:center;gap:6px;margin:0 16px;color:#b0b3b8;font:400 14px system-ui;min-height:4px}
.fbx-sum .em{display:inline-flex}.fbx-sum .em span{margin-left:-3px;font-size:15px;filter:drop-shadow(0 0 1px #242526)}
.fbx-sum .cm{margin-left:auto;background:none;border:0;color:#b0b3b8;font:400 14px system-ui;cursor:pointer;padding:0}
.fbx-sum .cm:hover{text-decoration:underline}
#fbx-light{position:fixed;inset:0;z-index:10060;background:rgba(0,0,0,.94);display:grid;place-items:center}
#fbx-light img{max-width:100vw;max-height:100vh;object-fit:contain}
#fbx-light button,#fbx-story .x{z-index:3;position:absolute;top:calc(env(safe-area-inset-top,0px) + 12px);right:12px;width:40px;height:40px;border-radius:50%;border:0;background:#3a3b3c;color:#fff;font-size:22px;cursor:pointer}
#fbx-story{position:fixed;inset:0;z-index:10060;background:#000;display:grid;place-items:center}
#fbx-story .media{position:absolute;inset:0;margin:auto;max-width:min(100vw,calc(100vh*9/16));width:100%;height:100%;object-fit:contain;background:#000}
#fbx-story .bars{z-index:2;position:absolute;top:calc(env(safe-area-inset-top,0px) + 8px);left:10px;right:10px;display:flex;gap:4px}
#fbx-story .bars i{flex:1;height:3px;border-radius:2px;background:rgba(255,255,255,.35);overflow:hidden}
#fbx-story .bars i b{display:block;height:100%;width:0;background:#fff}
#fbx-story .who{position:absolute;top:calc(env(safe-area-inset-top,0px) + 22px);z-index:2;left:14px;display:flex;align-items:center;gap:8px;color:#fff;font:700 15px system-ui;text-shadow:0 1px 4px #000}
#fbx-story .who .avatar{width:36px;height:36px;margin:0}
#fbx-story .tap{z-index:1;position:absolute;top:70px;bottom:80px;width:40%;cursor:pointer}#fbx-story .tap.l{left:0}#fbx-story .tap.r{right:0}
#fbx-story .sreply{z-index:2;position:absolute;bottom:calc(env(safe-area-inset-bottom,0px) + 18px);left:16px;right:16px;display:flex;gap:8px}
#fbx-story .sreply button{flex:1;border:1px solid rgba(255,255,255,.5);background:rgba(0,0,0,.4);color:#fff;border-radius:999px;padding:11px;font:600 15px system-ui;cursor:pointer}
.fbx-pymk{background:#242526;border-radius:10px;padding:12px 0 14px;box-shadow:0 1px 2px rgba(0,0,0,.3)}
.fbx-pymk h4{margin:0 16px 10px;color:#e4e6eb;font:700 16px system-ui}
.fbx-pymk .row{display:flex;gap:8px;overflow-x:auto;padding:0 16px;scrollbar-width:none}.fbx-pymk .row::-webkit-scrollbar{display:none}
.fbx-pymk .c{flex:none;width:150px;border:1px solid #3e4042;border-radius:10px;overflow:hidden;background:#18191a}
.fbx-pymk .ph{height:150px;background:#3a3b3c center/cover;display:grid;place-items:center;font-size:54px;cursor:pointer}
.fbx-pymk .c b{display:block;margin:8px 10px 6px;color:#e4e6eb;font:600 15px system-ui;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.fbx-pymk .c button{display:block;width:calc(100% - 20px);margin:0 10px 10px;border:0;border-radius:6px;padding:8px;font:600 14px system-ui;cursor:pointer;background:#263951;color:#4599ff}
.fbx-pymk .c button.done{background:#3a3b3c;color:#e4e6eb}
#v-community .post img.photo{cursor:zoom-in}`;
  document.head.appendChild(css);

  /* ---------- reactions ---------- */
  let bar = null, barFor = null, hold = null;
  const postById = (id) => (G("posts") || []).find((p) => p.id === id);
  function closeBar() { if (bar) bar.remove(); bar = null; barFor = null; }
  function openBar(btn) {
    closeBar(); barFor = btn.dataset.like;
    bar = document.createElement("div"); bar.id = "fbx-rbar"; bar.setAttribute("role", "menu");
    bar.innerHTML = REACTS.map(([e, n]) => `<button type="button" data-r="${e}" title="${n}" aria-label="${n}">${e}</button>`).join("");
    document.body.appendChild(bar);
    const r = btn.getBoundingClientRect(), w = bar.offsetWidth;
    bar.style.left = Math.max(8, Math.min(innerWidth - w - 8, r.left)) + "px"; bar.style.top = Math.max(8, r.top - 58) + "px";
  }
  async function react(id, emoji) {
    const p = postById(id), me = G("me"), db = G("db");
    if (!p || !me || !db) { if (typeof needMember === "function") needMember(); return; }
    const reacts = { ...(p.reacts || {}) }, likes = new Set(p.likes || []);
    if (emoji && reacts[me] !== emoji) { reacts[me] = emoji; likes.add(me); } else { delete reacts[me]; likes.delete(me); }
    try { await db.doc("posts/" + id).update({ reacts, likes: [...likes] }); } catch (e) { if (typeof toast === "function") toast(e.message || "Couldn't react"); }
  }
  feed.addEventListener("pointerdown", (e) => { const b = e.target.closest("[data-like]"); if (!b) return; hold = setTimeout(() => { hold = "open"; openBar(b); }, 450); });
  feed.addEventListener("pointerup", () => { if (hold && hold !== "open") clearTimeout(hold); });
  feed.addEventListener("pointerleave", () => { if (hold && hold !== "open") clearTimeout(hold); }, true);
  // after a long press, don't also do the normal Like tap
  feed.addEventListener("click", (e) => { if (hold === "open" && e.target.closest("[data-like]")) { e.stopPropagation(); e.preventDefault(); hold = null; } }, true);
  // a plain tap on Like when you already reacted removes your reaction
  feed.addEventListener("click", (e) => { const b = e.target.closest("[data-like]"); if (!b) return; const p = postById(b.dataset.like), me = G("me"); if (p && me && p.reacts && p.reacts[me]) { e.stopPropagation(); e.preventDefault(); react(p.id, null); } }, true);
  if (matchMedia("(hover:hover)").matches) {
    let ht = null;
    feed.addEventListener("mouseover", (e) => { const b = e.target.closest("[data-like]"); if (!b || barFor === b.dataset.like) return; clearTimeout(ht); ht = setTimeout(() => openBar(b), 600); });
    feed.addEventListener("mouseout", (e) => { if (e.target.closest("[data-like]")) clearTimeout(ht); });
  }
  document.addEventListener("click", (e) => { const r = e.target.closest("#fbx-rbar [data-r]"); if (r) { const id = barFor; closeBar(); react(id, r.dataset.r); return; } if (bar && !e.target.closest("#fbx-rbar")) closeBar(); });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") { closeBar(); closeLight(); closeStory(); } });

  /* ---------- paint: reaction label, summary line, comment link, people you may know ---------- */
  function paint() {
    const me = G("me"), list = G("posts") || [], min = window.MW_SHOW_MIN || 25, owner = !!G("isOwner");
    for (const art of feed.querySelectorAll("article.post")) {
      const lb = art.querySelector("[data-like]"); if (!lb) continue;
      const p = postById(lb.dataset.like); if (!p) continue;
      const mine = me && p.reacts && p.reacts[me];
      if (mine) { const want = `${mine} ${nameOf(mine)}`; if (lb.textContent !== want) lb.textContent = want; if (!lb.classList.contains("on")) lb.classList.add("on"); }
      let sum = art.querySelector(".fbx-sum");
      if (!sum) { sum = document.createElement("div"); sum.className = "fbx-sum"; art.querySelector(".post-actions").before(sum); }
      const ems = Object.values(p.reacts || {}); const top = [...new Set(ems.length ? ems : (p.likes || []).length ? ["👍"] : [])].slice(0, 3);
      const n = Math.max((p.likes || []).length, ems.length), rc = +p.replyCount || 0;
      const sig = JSON.stringify([top, n, rc]); if (sum._sig === sig) continue; sum._sig = sig;
      // counts follow the site's rule: small numbers stay hidden until they're worth showing (owner always sees them)
      const showN = n && (n >= min || owner), showC = rc && (rc >= 3 || owner);
      sum.innerHTML = (top.length ? `<span class="em">${top.map((e) => `<span>${e}</span>`).join("")}</span>${showN ? `<span>${n}</span>` : ""}` : "") +
        (rc ? `<button type="button" class="cm" data-fbx-cm="${esc(p.id)}">${showC ? rc + " comment" + (rc > 1 ? "s" : "") : "View comments"}</button>` : "");
    }
    pymk();
  }
  feed.addEventListener("click", (e) => { const c = e.target.closest("[data-fbx-cm]"); if (c) { const b = feed.querySelector(`[data-replies="${CSS.escape(c.dataset.fbxCm)}"]`); if (b) b.click(); } });

  let pymkEl = null;
  function pymk() {
    const me = G("me"), mem = G("members") || {}, F = window.MW_FRIENDS;
    if (!me || !F) { if (pymkEl) pymkEl.remove(); return; }
    const ids = Object.keys(mem).filter((id) => id !== me && mem[id] && mem[id].handle && F.status && F.status(id) === "none").slice(0, 12);
    if (ids.length < 2) { if (pymkEl) pymkEl.remove(); return; }
    if (!pymkEl) { pymkEl = document.createElement("div"); pymkEl.className = "fbx-pymk"; }
    const sig = ids.join(","); if (pymkEl._sig !== sig) {
      pymkEl._sig = sig;
      pymkEl.innerHTML = `<h4>People you may know</h4><div class="row">${ids.map((id) => { const m = mem[id], ph = typeof safeImg === "function" ? safeImg(m.photo) : ""; return `<div class="c"><div class="ph" data-fbx-prof="${esc(id)}" style="${ph ? `background-image:url('${esc(ph)}')` : ""}">${ph ? "" : "👤"}</div><b>${esc(m.handle)}</b><button type="button" data-fbx-add="${esc(id)}">Add friend</button></div>`; }).join("")}</div>`;
    }
    const posts = feed.querySelectorAll("article.post"), after = posts[1] || posts[0];
    if (after && pymkEl.previousElementSibling !== after) after.after(pymkEl);
  }
  feed.addEventListener("click", async (e) => {
    const a = e.target.closest("[data-fbx-add]"); if (a && window.MW_FRIENDS) { a.disabled = true; const ok = await window.MW_FRIENDS.add(a.dataset.fbxAdd); a.textContent = ok ? "Request sent" : "Add friend"; a.classList.toggle("done", !!ok); a.disabled = !!ok; return; }
    const pr = e.target.closest("[data-fbx-prof]"); if (pr && window.MW_profilePage) window.MW_profilePage.open(pr.dataset.fbxProf);
  });

  /* ---------- photo viewer ---------- */
  let light = null;
  function closeLight() { if (light) light.remove(); light = null; }
  feed.addEventListener("click", (e) => {
    const img = e.target.closest("article.post img.photo"); if (!img) return;
    closeLight(); light = document.createElement("div"); light.id = "fbx-light"; light.setAttribute("role", "dialog"); light.setAttribute("aria-label", "Photo");
    light.innerHTML = `<img src="${esc(img.src)}" alt="${esc(img.alt || "Photo")}"><button type="button" aria-label="Close">×</button>`;
    light.addEventListener("click", (ev) => { if (ev.target.tagName !== "IMG") closeLight(); });
    document.body.appendChild(light);
  });

  /* ---------- stories, full screen ---------- */
  let story = null, sIdx = 0, sItems = [], sTimer = null, sStart = 0;
  const DUR = 6000;
  function closeStory() { clearInterval(sTimer); if (story) story.remove(); story = null; }
  function showStory(i) {
    if (i < 0) i = 0; if (i >= sItems.length) { closeStory(); return; }
    sIdx = i; const it = sItems[i];
    story.querySelector(".stage").innerHTML = it.vid ? `<video class="media" src="${esc(it.vid)}" autoplay playsinline muted></video>` : `<img class="media" src="${esc(it.bg)}" alt="">`;
    story.querySelector(".who").innerHTML = `${it.av || ""}<span>${esc(it.name)}</span>`;
    story.querySelectorAll(".bars b").forEach((b, k) => (b.style.width = k < i ? "100%" : "0"));
    sStart = Date.now();
  }
  function openStories(items, start) {
    if (!items || !items.length) return;
    closeStory(); sItems = items;
    story = document.createElement("div"); story.id = "fbx-story"; story.setAttribute("role", "dialog"); story.setAttribute("aria-label", "Stories");
    story.innerHTML = `<div class="stage" style="display:contents"></div><div class="bars">${items.map(() => "<i><b></b></i>").join("")}</div><div class="who"></div>
<div class="tap l" aria-label="Previous"></div><div class="tap r" aria-label="Next"></div><button type="button" class="x" aria-label="Close">×</button>
<div class="sreply"><button type="button" data-st="post">See post</button><button type="button" data-st="msg">💬 Message</button></div>`;
    story.addEventListener("click", (e) => {
      if (e.target.closest(".x")) return closeStory();
      if (e.target.closest(".tap.l")) return showStory(sIdx - 1);
      if (e.target.closest(".tap.r")) return showStory(sIdx + 1);
      const b = e.target.closest("[data-st]"); if (!b) return; const it = sItems[sIdx]; closeStory();
      if (b.dataset.st === "post" && it.el) it.el.scrollIntoView({ behavior: "smooth", block: "start" });
      if (b.dataset.st === "msg") { const uid = it.el && it.el.querySelector(".post-head .avatar[data-uid]"); if (uid && window.MW_openChat) window.MW_openChat(uid.dataset.uid); else if (typeof go === "function") go("messages"); }
    });
    document.body.appendChild(story); showStory(start || 0);
    sTimer = setInterval(() => { if (!story) return; const f = Math.min(1, (Date.now() - sStart) / DUR); const b = story.querySelectorAll(".bars b")[sIdx]; if (b) b.style.width = f * 100 + "%"; if (f >= 1) showStory(sIdx + 1); }, 100);
  }
  // take over the story cards made by fb-feed.js
  view.addEventListener("click", (e) => {
    const s = e.target.closest("[data-story]"); if (!s) return;
    const box = document.getElementById("fb-stories"); if (!box || !box._items) return;
    e.stopImmediatePropagation(); e.preventDefault(); openStories(box._items, +s.dataset.story);
  }, true);

  /* ---------- keep it painted ---------- */
  let t = null; const later = () => { clearTimeout(t); t = setTimeout(paint, 150); };
  new MutationObserver(later).observe(feed, { childList: true, subtree: true, characterData: false });
  setInterval(() => { if (!view.hidden) paint(); }, 4000);
})();
