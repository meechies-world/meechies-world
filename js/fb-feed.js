/* The Feed, laid out the way people know from Facebook (owner's request): it's the 2nd tab after Home.
 * - top strip: Meechie's World wordmark + Search, Messenger, Notifications
 * - Stories row (latest photo/video posts), "What's on your mind?" box with Live video / Photo/video / Feeling
 * - post cards edge-to-edge on phones, Like · Comment · Share across the full width
 * - computers: shortcuts on the left, feed in the middle, contacts/profile on the right
 * Uses the existing feed underneath (posting, likes, comments, sharing all stay the same). No Facebook logo or name. */
(function () {
  "use strict";
  const view = document.getElementById("v-community"); if (!view) return;
  const $ = (s, r = document) => r.querySelector(s);
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const go = (v) => { if (typeof window.go === "function") window.go(v); else location.hash = v; };
  const myId = () => { try { return typeof me !== "undefined" ? me : null; } catch (_) { return null; } };
  const myProf = () => { try { return typeof profileMe !== "undefined" && profileMe ? profileMe : null; } catch (_) { return null; } };
  const myAv = () => { const id = myId(); try { if (id && typeof avatarOf === "function") return avatarOf(id); } catch (_) {} return '<span class="avatar">👤</span>'; };

  const css = document.createElement("style");
  css.textContent = `
#v-community{--fb-bg:#18191a;--fb-card:#242526;--fb-hover:#3a3b3c;--fb-text:#e4e6eb;--fb-mute:#b0b3b8;--fb-line:#3e4042;--fb-blue:#2d88ff;background:var(--fb-bg)!important}
body[data-view=community]{background:#18191a}
#v-community .section-head{display:none}
#v-community .wrap{padding-top:0!important}
#fb-top{position:relative;z-index:15;display:flex;align-items:center;gap:8px;background:var(--fb-card);border-bottom:1px solid var(--fb-line);margin:0 calc(-1 * clamp(16px,3.2vw,56px)) 14px;padding:8px clamp(16px,3.2vw,56px)}
#fb-top .wm{font:800 24px/1 var(--display,system-ui);color:var(--gold-hi,#f0cf78);letter-spacing:-.5px;margin-right:auto;white-space:nowrap}
#fb-top button{width:40px;height:40px;border-radius:50%;border:0;background:var(--fb-hover);color:var(--fb-text);font-size:18px;display:grid;place-items:center;cursor:pointer;position:relative}
#fb-top button i{position:absolute;top:-2px;right:-2px;min-width:18px;height:18px;border-radius:9px;background:#e41e3f;color:#fff;font:700 11px/18px system-ui;font-style:normal;padding:0 4px}
#fb-cols{display:grid;grid-template-columns:minmax(0,1fr);gap:20px;align-items:start}
@media(min-width:1100px){#fb-cols{grid-template-columns:260px minmax(0,680px) 300px;justify-content:center}}
#fb-left{display:none}
@media(min-width:1100px){#fb-left{display:grid;gap:2px;position:sticky;top:70px}}
#fb-left a{display:flex;align-items:center;gap:12px;padding:9px 10px;border-radius:8px;color:var(--fb-text);text-decoration:none;font:600 15px system-ui}
#fb-left a:hover{background:var(--fb-hover)}
#fb-left a span{width:36px;height:36px;border-radius:50%;display:grid;place-items:center;background:var(--fb-hover);font-size:19px;overflow:hidden}
#fb-left a span .avatar{width:36px;height:36px;margin:0}
#v-community #fb-cols>.grid-2{display:contents}
#v-community aside.side{display:none}
@media(min-width:1100px){#v-community aside.side{display:grid;gap:14px;position:sticky;top:70px}}
#v-community .card,#v-community .post{background:var(--fb-card)!important;border:0!important;border-radius:10px!important;color:var(--fb-text);box-shadow:0 1px 2px rgba(0,0,0,.3)}
#v-community .card h3{color:var(--fb-mute);font:700 15px system-ui;letter-spacing:0}
#v-community .muted{color:var(--fb-mute)!important}
#fb-stories{display:flex;gap:8px;overflow-x:auto;scrollbar-width:none;padding:2px 0 4px;margin-bottom:14px}
#fb-stories::-webkit-scrollbar{display:none}
.fb-story{flex:none;width:112px;height:196px;border-radius:12px;position:relative;overflow:hidden;background:#3a3b3c center/cover;cursor:pointer;border:0;padding:0;color:#fff;text-align:left;box-shadow:0 1px 2px rgba(0,0,0,.3)}
.fb-story::after{content:"";position:absolute;inset:0;background:linear-gradient(180deg,rgba(0,0,0,.35),transparent 30%,transparent 65%,rgba(0,0,0,.6))}
.fb-story .av{position:absolute;left:8px;top:8px;z-index:1;width:38px;height:38px;border-radius:50%;border:3px solid var(--fb-blue);overflow:hidden;display:grid;place-items:center;background:#242526}
.fb-story .av .avatar{width:32px;height:32px;margin:0}
.fb-story b{position:absolute;left:8px;right:8px;bottom:8px;z-index:1;font:700 13px/1.2 system-ui;text-shadow:0 1px 3px #000}
.fb-story.make{background:var(--fb-card)}
.fb-story.make::after{display:none}
.fb-story.make .top{height:140px;background:#3a3b3c center/cover;display:grid;place-items:center;font-size:40px}
.fb-story.make .plus{position:absolute;left:50%;top:124px;transform:translateX(-50%);width:36px;height:36px;border-radius:50%;background:var(--fb-blue);border:4px solid var(--fb-card);display:grid;place-items:center;font:800 22px/1 system-ui;color:#fff}
.fb-story.make b{color:var(--fb-text);text-align:center;text-shadow:none}
#fb-mind{padding:12px 16px 8px!important;margin-bottom:14px}
#fb-mind .r1{display:flex;gap:8px;align-items:center;padding-bottom:10px;border-bottom:1px solid var(--fb-line)}
#fb-mind .r1 .avatar{width:40px;height:40px;margin:0;flex:none}
#fb-mind .pill{text-transform:none!important;letter-spacing:0!important;flex:1;text-align:left;border:0;border-radius:999px;background:var(--fb-hover);color:var(--fb-mute);font:400 16px system-ui;padding:10px 14px;cursor:pointer}
#fb-mind .r2{display:flex;padding-top:6px}
#fb-mind .r2 button{text-transform:none!important;letter-spacing:0!important;flex:1;display:flex;align-items:center;justify-content:center;gap:6px;border:0;background:none;color:var(--fb-mute);font:600 14px system-ui;padding:9px 4px;border-radius:8px;cursor:pointer}
#fb-mind .r2 button:hover{background:var(--fb-hover)}
#v-community #composer{margin-bottom:14px}
#v-community:not(.fb-writing) #composer{display:none!important}
#v-community .feed{gap:14px!important;margin-top:0!important}
#v-community .post{padding:12px 0 4px!important;gap:10px!important}
#v-community .post-body>*{margin-left:16px;margin-right:16px}
#v-community .post-body>.photo,#v-community .post-body>.vid{margin-left:0;margin-right:0;width:100%;border-radius:0!important;max-height:none}
#v-community .post-head .who b{color:var(--fb-text);font:600 15px system-ui}
#v-community .post-head .who small{color:var(--fb-mute)}
#v-community .post-text{font:400 15px/1.35 system-ui;color:var(--fb-text)}
#v-community .post-actions{display:flex!important;flex-wrap:wrap;margin:0 12px;border-top:1px solid var(--fb-line);padding-top:4px;gap:0!important}
#v-community .post-actions .act{flex:1 1 0;justify-content:center;display:flex;align-items:center;gap:6px;border:0!important;background:none!important;color:var(--fb-mute)!important;font:600 14px system-ui!important;padding:9px 4px!important;border-radius:6px}
#v-community .post-actions .act:hover{background:var(--fb-hover)!important}
#v-community .post-actions .act.on{color:var(--fb-blue)!important}
#v-community .post-actions .trend-badge{flex-basis:100%;margin:2px 4px 4px}
#v-community .replies{margin:0 16px 10px}
#v-community .reply{background:var(--fb-hover);border-radius:18px;padding:8px 12px;color:var(--fb-text);margin-bottom:6px}
#v-community .reply b{display:block;font:600 13px system-ui}
#v-community .reply-form input{border-radius:999px;background:var(--fb-hover);border:0;color:var(--fb-text)}
@media(max-width:760px){
  #v-community .wrap{padding-inline:0!important}
  #fb-top{margin:0 0 8px;padding:8px 12px}
  #fb-stories{padding-inline:12px}
  #v-community .card,#v-community .post{border-radius:0!important}
  #fb-mind{margin-bottom:8px}
  #v-community .feed{gap:8px!important}
}`;
  document.head.appendChild(css);

  const wrap = view.querySelector(".wrap");
  const grid = view.querySelector(".grid-2");
  const main = grid && grid.firstElementChild;
  if (!wrap || !grid || !main) return;

  // top strip
  const top = document.createElement("div"); top.id = "fb-top";
  top.innerHTML = `<span class="wm">meechie's world</span>
<button type="button" data-fb="search" aria-label="Search people">🔍</button>
<button type="button" data-fb="msgs" aria-label="Messenger">💬<i hidden></i></button>
<button type="button" data-fb="me" aria-label="My profile">👤</button>`;
  wrap.prepend(top);

  // columns: shortcuts | feed | right side
  const cols = document.createElement("div"); cols.id = "fb-cols";
  grid.before(cols);
  const left = document.createElement("nav"); left.id = "fb-left"; left.setAttribute("aria-label", "Shortcuts");
  cols.append(left, grid);
  function paintLeft() {
    const p = myProf();
    left.innerHTML = `<a href="#" data-fb="me"><span>${myAv()}</span>${esc((p && p.handle) || "Your profile")}</a>
<a href="#friends" data-go="friends"><span>👥</span>Friends</a>
<a href="#messages" data-go="messages"><span>💬</span>Messenger</a>
<a href="#videos" data-go="videos"><span>📺</span>Video</a>
<a href="#shop" data-go="shop"><span>🛍️</span>Marketplace</a>
<a href="#dating" data-go="dating"><span>💘</span>Dating</a>
<a href="#live" data-go="live"><span>🔴</span>Live</a>
<a href="#clips" data-go="clips"><span>🎬</span>Clips</a>
<a href="#books" data-go="books"><span>📚</span>Books</a>
<a href="#radio" data-go="radio"><span>📻</span>Radio</a>
<a href="#jobs" data-go="jobs"><span>💼</span>Jobs</a>`;
  }

  // stories + "what's on your mind?"
  const stories = document.createElement("div"); stories.id = "fb-stories"; stories.setAttribute("aria-label", "Stories");
  const mind = document.createElement("div"); mind.className = "card"; mind.id = "fb-mind";
  main.prepend(mind, stories);
  function paintMind() {
    const p = myProf(), first = ((p && p.handle) || "").split(/\s+/)[0];
    mind.innerHTML = `<div class="r1">${myAv()}<button type="button" class="pill" data-fb="write">What's on your mind${first ? ", " + esc(first) : ""}?</button></div>
<div class="r2"><button type="button" data-fb="live"><span style="color:#f3425f">🎥</span>Live video</button><button type="button" data-fb="photo"><span style="color:#45bd62">🖼️</span>Photo/video</button><button type="button" data-fb="feel"><span style="color:#f7b928">😊</span>Feeling</button></div>`;
  }
  function paintStories() {
    const items = [...view.querySelectorAll("#feed .post")].map((el) => {
      const img = el.querySelector("img.photo"), vid = el.querySelector("video.vid");
      if (!img && !vid) return null;
      const name = (el.querySelector(".who b") || {}).textContent || "";
      const av = el.querySelector(".post-head .avatar");
      return { el, name, av: av ? av.outerHTML : "", bg: img ? img.src : "", vid: vid ? vid.src : "" };
    }).filter(Boolean).slice(0, 12);
    const seen = new Set(); const uniq = items.filter((s) => (seen.has(s.name) ? false : seen.add(s.name)));
    stories.innerHTML = `<button type="button" class="fb-story make" data-fb="photo"><div class="top">📷</div><span class="plus">+</span><b>Create story</b></button>` +
      uniq.map((s, i) => `<button type="button" class="fb-story" data-story="${i}" style="${s.bg ? `background-image:url('${esc(s.bg)}')` : ""}">${!s.bg && s.vid ? `<video src="${esc(s.vid)}#t=0.5" muted playsinline preload="metadata" style="position:absolute;inset:0;width:100%;height:100%;object-fit:cover"></video>` : ""}<span class="av">${s.av}</span><b>${esc(s.name)}</b></button>`).join("");
    stories._items = uniq;
  }

  function startWriting(focus) {
    const comp = $("#composer");
    if (!comp || comp.hidden) { const j = $('[data-auth="signup"]'); if (j) j.click(); else if (typeof needMember === "function") needMember(); return false; }
    view.classList.add("fb-writing");
    comp.scrollIntoView({ behavior: "smooth", block: "center" });
    if (focus) setTimeout(() => { const t = $("#p-text"); if (t) t.focus(); }, 250);
    return true;
  }
  view.addEventListener("click", (e) => {
    const s = e.target.closest("[data-story]");
    if (s && stories._items) { const it = stories._items[+s.dataset.story]; if (it) it.el.scrollIntoView({ behavior: "smooth", block: "start" }); return; }
    const b = e.target.closest("[data-fb]"); if (!b) return;
    e.preventDefault();
    const k = b.dataset.fb;
    if (k === "write") startWriting(true);
    else if (k === "photo") { if (startWriting(false)) { const f = $("#p-photo"); if (f) f.click(); } }
    else if (k === "feel") { if (startWriting(true)) { const t = $("#p-text"); if (t && !/feeling/i.test(t.value)) { t.value = (t.value ? t.value + " " : "") + "— feeling 😊 "; t.focus(); } } }
    else if (k === "live") go("live");
    else if (k === "msgs") go("messages");
    else if (k === "search") go("friends");
    else if (k === "me") { if (window.MW_profilePage && window.MW_profilePage.mine) window.MW_profilePage.mine(); else go("friends"); }
  });
  // close the writing box after posting
  document.addEventListener("click", (e) => { if (e.target.closest("#p-post")) setTimeout(() => { const t = $("#p-text"); if (t && !t.value.trim()) view.classList.remove("fb-writing"); }, 1500); });

  // unread badge on the Messenger button mirrors the site's message dot
  function paintBadge() { const dot = document.querySelector(".dm-dot"), i = top.querySelector("[data-fb=msgs] i"); if (i) i.hidden = !dot || dot.hidden; if (i && !i.hidden) i.textContent = "•"; }

  let t = null; const repaint = () => { clearTimeout(t); t = setTimeout(() => { paintStories(); paintBadge(); }, 300); };
  const feed = $("#feed"); if (feed) new MutationObserver(repaint).observe(feed, { childList: true });
  const dot = document.querySelector(".dm-dot"); if (dot) new MutationObserver(paintBadge).observe(dot, { attributes: true });
  const paintAll = () => { paintLeft(); paintMind(); paintStories(); paintBadge(); };
  paintAll();
  // repaint names/photos once the signed-in profile loads, and whenever the Feed is opened
  new MutationObserver(() => { if (!view.hidden) paintAll(); }).observe(view, { attributes: true, attributeFilter: ["hidden"] });
  let n = 0; const iv = setInterval(() => { if (myProf() || ++n > 20) { clearInterval(iv); paintAll(); } }, 1500);
})();
