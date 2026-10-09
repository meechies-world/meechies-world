/* Videos tab: a player plus member-shared YouTube and TikTok videos (collection "videos"). */
(function () {
  "use strict";
  const view = document.getElementById("v-videos");
  if (!view) return;
  const $v = (s) => view.querySelector(s);
  const E = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const say = (t) => (typeof toast === "function" ? toast(t) : null);
  let vids = [], sort = "new", current = null, db = null;

  function ytId(url) {
    const s = String(url || "").trim();
    if (/^[\w-]{11}$/.test(s)) return s;
    try {
      const u = new URL(s.startsWith("http") ? s : "https://" + s);
      const h = u.hostname.replace(/^www\.|^m\.|^music\./, "");
      if (h === "youtu.be") return (u.pathname.slice(1).match(/^[\w-]{11}/) || [])[0] || null;
      if (h === "youtube.com" || h === "youtube-nocookie.com") {
        if (u.searchParams.get("v")) return (u.searchParams.get("v").match(/^[\w-]{11}/) || [])[0] || null;
        const m = u.pathname.match(/^\/(?:shorts|live|embed|v)\/([\w-]{11})/);
        return m ? m[1] : null;
      }
    } catch (_) {}
    return null;
  }
  const isTT = (s) => /tiktok\.com/i.test(String(s || ""));
  const ttDirect = (s) => (String(s || "").match(/tiktok\.com\/.*\/(?:video|photo)\/(\d{8,25})/i) || [])[1] || null;
  const thumb = (v) => v.tt ? (v.thumb || "") : `https://i.ytimg.com/vi/${v.yt}/hqdefault.jpg`;
  const pic = (v) => thumb(v) ? `<img src="${E(thumb(v))}" alt="" loading="lazy" onerror="this.remove()">` : "";
  const linkOf = (v) => v.tt ? `https://www.tiktok.com/@${v.ttUser || "meechiesworldinc"}/video/${v.tt}` : "https://youtu.be/" + v.yt;
  async function ttLookup(url) {
    const r = await fetch("/api/tiktok?url=" + encodeURIComponent(url.trim())).catch(() => null);
    const j = r ? await r.json().catch(() => null) : null;
    if (j && j.id) return j;
    const id = ttDirect(url); return id ? { id, title: "", author: "", thumb: "" } : null;
  }
  const who = (id) => (typeof handleOf === "function" ? handleOf(id) : "Member");

  function play(v, scroll) {
    current = v;
    try { if (typeof media !== "undefined" && media && !media.paused) media.pause(); } catch (_) {}
    const src = v.tt ? `https://www.tiktok.com/player/v1/${v.tt}?autoplay=1&rel=0&description=1&music_info=1` : `https://www.youtube-nocookie.com/embed/${v.yt}?autoplay=1&rel=0&modestbranding=1`;
    $v("#yt-frame").classList.toggle("tall", !!v.tt);
    $v("#yt-frame").innerHTML = `<iframe src="${src}" title="${E(v.title)}" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share; fullscreen" allowfullscreen referrerpolicy="strict-origin-when-cross-origin"></iframe>`;
    $v("#yt-now").innerHTML = `<b>${E(v.title)}</b><small>Shared by ${E(who(v.authorId))}${v.note ? " · " + E(v.note) : ""}</small>`;
    if (scroll) $v(".yt-stage").scrollIntoView({ behavior: "smooth", block: "start" });
    render();
  }
  function render() {
    const list = [...vids].sort((a, b) => (b.featured ? 1 : 0) - (a.featured ? 1 : 0) || (sort === "top" ? (b.likes || []).length - (a.likes || []).length : b.createdAt - a.createdAt));
    const meId = typeof me !== "undefined" ? me : null, owner = typeof isOwner !== "undefined" && isOwner;
    $v("#yt-grid").innerHTML = list.length ? list.map((v) => {
      const liked = (v.likes || []).includes(meId);
      return `<article class="yt-card ${current && current.id === v.id ? "on" : ""}">
  <button type="button" class="yt-thumb${v.tt ? " tt" : ""}" data-play="${v.id}" aria-label="Play ${E(v.title)}">${pic(v)}${v.tt ? '<span class="badge yt-src">TikTok</span>' : ""}<span class="yt-pl">▶</span>${v.featured ? '<span class="badge yt-feat">Featured</span>' : ""}</button>
  <div class="yt-meta"><b>${E(v.title)}</b><small>${E(who(v.authorId))}${v.note ? " · " + E(v.note) : ""}</small>
  <div class="yt-acts"><button type="button" class="act" data-like="${v.id}">${liked ? "❤️" : "🤍"} ${(v.likes || []).length}</button><button type="button" class="act" data-share="${v.id}">Share</button>${owner ? `<button type="button" class="act" data-feat="${v.id}">${v.featured ? "Unfeature" : "Feature"}</button>` : ""}${(v.authorId === meId || owner) ? `<button type="button" class="act" data-del="${v.id}">Delete</button>` : ""}</div></div></article>`;
    }).join("") : `<div class="empty">No videos yet. Paste a YouTube or TikTok link above to share the first one.</div>`;
    if (!current && list.length) {
      const v = list[0]; current = v;
      $v("#yt-frame").classList.toggle("tall", !!v.tt);
      $v("#yt-frame").innerHTML = `<button type="button" class="yt-poster" data-play="${v.id}" aria-label="Play ${E(v.title)}">${pic(v)}<span class="yt-pl big">▶</span></button>`;
      $v("#yt-now").innerHTML = `<b>${E(v.title)}</b><small>Shared by ${E(who(v.authorId))}</small>`;
    }
  }

  /* Home page: Meechie's TikToks as phone-friendly cards that play right on the page */
  const grids = [...document.querySelectorAll(".htt-grid")];
  const fresh = {};
  function renderHome() { grids.forEach(renderGrid); }
  function renderGrid(hgrid) {
    const mine = vids.filter((v) => v.tt && (v.ttUser || "").toLowerCase() === "meechiesworldinc").sort((a, b) => (b.featured ? 1 : 0) - (a.featured ? 1 : 0) || (b.ttTime || b.createdAt) - (a.ttTime || a.createdAt)).slice(0, 40);
    if (hgrid.querySelector(".htt.playing")) return; // don't interrupt a video that's playing
    hgrid.innerHTML = mine.length ? mine.map((v) => `<button type="button" class="htt" data-htt="${E(v.id)}" aria-label="Play ${E(v.title)}">${fresh[v.tt] || v.thumb ? `<img src="${E(fresh[v.tt] || v.thumb)}" alt="" loading="lazy" data-ttid="${E(v.tt)}">` : ""}<span class="pl">▶</span><span class="cap">${E(v.title)}</span></button>`).join("")
      : `<a class="btn" href="https://www.tiktok.com/@meechiesworldinc" target="_blank" rel="noopener">Watch Meechie on TikTok</a>`;
    // TikTok cover links expire after a while; quietly fetch fresh ones when an image fails
    hgrid.querySelectorAll("img[data-ttid]").forEach((im) => im.addEventListener("error", async () => {
      const id = im.dataset.ttid; if (fresh[id] === "") { im.remove(); return; } fresh[id] = "";
      const r = await fetch("/api/tiktok?url=" + encodeURIComponent("https://www.tiktok.com/@meechiesworldinc/video/" + id)).then((x) => x.json()).catch(() => null);
      if (r && r.thumb) { fresh[id] = r.thumb; im.src = r.thumb; } else im.remove();
    }));
    // arrows for computers; phones just swipe
    const wrap = hgrid.parentElement;
    if (mine.length > 1 && wrap && !wrap.querySelector(".htt-nav")) {
      wrap.insertAdjacentHTML("beforeend", '<button class="htt-nav l" type="button" aria-label="Previous">‹</button><button class="htt-nav r" type="button" aria-label="Next">›</button>');
      wrap.querySelector(".l").onclick = () => hgrid.scrollBy({ left: -hgrid.clientWidth * 0.8, behavior: "smooth" });
      wrap.querySelector(".r").onclick = () => hgrid.scrollBy({ left: hgrid.clientWidth * 0.8, behavior: "smooth" });
    }
    // swiping while a video plays moves playback to the next video you land on
    if (!hgrid._io) {
      hgrid._io = new IntersectionObserver((ents) => ents.forEach((en) => {
        if (en.isIntersecting && en.intersectionRatio > 0.85 && hgrid._auto && !en.target.classList.contains("playing")) playCard(hgrid, en.target);
      }), { root: hgrid, threshold: [0.85] });
    }
    hgrid.querySelectorAll(".htt").forEach((c) => hgrid._io.observe(c));
  }
  function playCard(hgrid, b) {
    const v = vids.find((x) => x.id === b.dataset.htt); if (!v) return;
    grids.forEach((g) => g.querySelectorAll(".htt.playing").forEach((x) => { x.classList.remove("playing"); x.querySelector("iframe")?.remove(); }));
    try { if (typeof media !== "undefined" && !media.paused) media.pause(); } catch (_) {}
    b.classList.add("playing"); hgrid._auto = true;
    b.insertAdjacentHTML("beforeend", `<iframe src="https://www.tiktok.com/player/v1/${v.tt}?autoplay=1&rel=0&music_info=1&description=1" allow="autoplay; encrypted-media; fullscreen; picture-in-picture" allowfullscreen title="${E(v.title)}"></iframe>`);
  }
  grids.forEach((hgrid) => hgrid.addEventListener("click", (e) => {
    const b = e.target.closest("[data-htt]"); if (!b || b.classList.contains("playing")) return;
    playCard(hgrid, b); b.scrollIntoView({ behavior: "smooth", inline: "center", block: "nearest" });
  }));

  view.addEventListener("click", async (e) => {
    const b = e.target.closest("button"); if (!b) return;
    const find = (id) => vids.find((x) => x.id === id);
    if (b.dataset.play) { play(find(b.dataset.play), !!b.closest(".yt-card")); return; }
    if (b.dataset.like) {
      if (typeof needMember === "function" && !needMember()) return;
      const v = find(b.dataset.like), s = new Set(v.likes || []); s.has(me) ? s.delete(me) : s.add(me);
      db.doc("videos/" + v.id).update({ likes: [...s] }).catch((err) => say(err.message || err.code)); return;
    }
    if (b.dataset.share) {
      const v = find(b.dataset.share), url = linkOf(v);
      if (navigator.share) navigator.share({ title: v.title, text: "Watch on Meechie's World", url }).catch(() => {});
      else navigator.clipboard?.writeText(url).then(() => say("Link copied")).catch(() => say(url));
      return;
    }
    if (b.dataset.feat) { const v = find(b.dataset.feat); db.doc("videos/" + v.id).update({ featured: !v.featured }).catch((err) => say(err.message || err.code)); return; }
    if (b.dataset.del) {
      if (!b.dataset.confirm) { b.dataset.confirm = "1"; b.textContent = "Tap again"; return; }
      db.doc("videos/" + b.dataset.del).delete().then(() => { if (current && current.id === b.dataset.del) current = null; }).catch((err) => say(err.message || err.code)); return;
    }
  });
  $v("#yt-sort").addEventListener("click", (e) => { const b = e.target.closest("[data-sort]"); if (!b) return; sort = b.dataset.sort; view.querySelectorAll("#yt-sort .chip").forEach((x) => x.setAttribute("aria-pressed", x === b)); render(); });
  $v("#yt-url").addEventListener("input", () => {
    const val = $v("#yt-url").value, id = ytId(val), p = $v("#yt-preview");
    if (isTT(val)) { p.hidden = false; p.innerHTML = '<small class="muted">TikTok link ✓ — tap Share video.</small>'; return; }
    p.hidden = !id; if (id) p.innerHTML = `<img src="https://i.ytimg.com/vi/${id}/hqdefault.jpg" alt="Video preview">`;
  });
  $v("#yt-form").addEventListener("submit", async (e) => {
    e.preventDefault(); if (typeof needMember === "function" && !needMember()) return;
    const url = $v("#yt-url").value, btn = $v("#yt-form button[type=submit]");
    let doc;
    if (isTT(url)) {
      btn.disabled = true; const t = await ttLookup(url); btn.disabled = false;
      if (!t) { say("Couldn't read that TikTok link. Open the video in TikTok, tap Share, then Copy link."); return; }
      if (vids.some((v) => v.tt === t.id)) { say("That video is already shared. Tap it to watch."); return; }
      doc = { tt: t.id, ttTime: (() => { try { return Number(BigInt(t.id) >> 32n) * 1000; } catch (_) { return Date.now(); } })(), ttUser: t.author || "", thumb: t.thumb || "", title: ($v("#yt-title").value.trim() || t.title || "TikTok video").slice(0, 100) };
    } else {
      const id = ytId(url);
      if (!id) { say("That doesn't look like a YouTube or TikTok link. Copy it from the Share button."); return; }
      if (vids.some((v) => v.yt === id)) { say("That video is already shared. Tap it to watch."); return; }
      doc = { yt: id, title: ($v("#yt-title").value.trim() || "YouTube video").slice(0, 100) };
    }
    try {
      await db.collection("videos").add({ authorId: me, ...doc, note: $v("#yt-note").value.trim().slice(0, 80), likes: [], featured: false, createdAt: Date.now() });
      $v("#yt-form").reset(); $v("#yt-preview").hidden = true; say("Video shared with the community");
    } catch (err) { say("Couldn't share: " + (err.message || err.code)); }
  });

  async function init() {
    if (!window.claude) return;
    db = await window.claude.use("db"); if (!db) return;
    db.collection("videos").orderBy("createdAt", "desc").limit(120).onSnapshot((s) => { vids = s.docs.map((d) => ({ id: d.id, ...d.data() })).filter((v) => /^[\w-]{11}$/.test(v.yt || "") || /^\d{8,25}$/.test(v.tt || "")); render(); renderHome(); }, () => {});
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init); else init();
})();
