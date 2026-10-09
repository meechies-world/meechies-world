/* Videos tab: a YouTube player plus member-shared YouTube videos (collection "videos"). */
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
  const thumb = (id) => `https://i.ytimg.com/vi/${id}/hqdefault.jpg`;
  const who = (id) => (typeof handleOf === "function" ? handleOf(id) : "Member");

  function play(v, scroll) {
    current = v;
    try { if (typeof media !== "undefined" && media && !media.paused) media.pause(); } catch (_) {}
    $v("#yt-frame").innerHTML = `<iframe src="https://www.youtube-nocookie.com/embed/${v.yt}?autoplay=1&rel=0&modestbranding=1" title="${E(v.title)}" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share" allowfullscreen referrerpolicy="strict-origin-when-cross-origin"></iframe>`;
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
  <button type="button" class="yt-thumb" data-play="${v.id}" aria-label="Play ${E(v.title)}"><img src="${thumb(v.yt)}" alt="" loading="lazy"><span class="yt-pl">▶</span>${v.featured ? '<span class="badge yt-feat">Featured</span>' : ""}</button>
  <div class="yt-meta"><b>${E(v.title)}</b><small>${E(who(v.authorId))}${v.note ? " · " + E(v.note) : ""}</small>
  <div class="yt-acts"><button type="button" class="act" data-like="${v.id}">${liked ? "❤️" : "🤍"} ${(v.likes || []).length}</button><button type="button" class="act" data-share="${v.id}">Share</button>${owner ? `<button type="button" class="act" data-feat="${v.id}">${v.featured ? "Unfeature" : "Feature"}</button>` : ""}${(v.authorId === meId || owner) ? `<button type="button" class="act" data-del="${v.id}">Delete</button>` : ""}</div></div></article>`;
    }).join("") : `<div class="empty">No videos yet. Paste a YouTube link above to share the first one.</div>`;
    if (!current && list.length) {
      const v = list[0]; current = v;
      $v("#yt-frame").innerHTML = `<button type="button" class="yt-poster" data-play="${v.id}" style="background-image:url('${thumb(v.yt)}')"><span class="yt-pl big">▶</span></button>`;
      $v("#yt-now").innerHTML = `<b>${E(v.title)}</b><small>Shared by ${E(who(v.authorId))}</small>`;
    }
  }

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
      const v = find(b.dataset.share), url = "https://youtu.be/" + v.yt;
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
    const id = ytId($v("#yt-url").value), p = $v("#yt-preview");
    p.hidden = !id; if (id) p.innerHTML = `<img src="${thumb(id)}" alt="Video preview">`;
  });
  $v("#yt-form").addEventListener("submit", async (e) => {
    e.preventDefault(); if (typeof needMember === "function" && !needMember()) return;
    const id = ytId($v("#yt-url").value);
    if (!id) { say("That doesn't look like a YouTube link. Copy it from the Share button on YouTube."); return; }
    if (vids.some((v) => v.yt === id)) { say("That video is already shared. Tap it to watch."); return; }
    const title = $v("#yt-title").value.trim() || "YouTube video";
    try {
      await db.collection("videos").add({ authorId: me, yt: id, title: title.slice(0, 100), note: $v("#yt-note").value.trim().slice(0, 80), likes: [], featured: false, createdAt: Date.now() });
      $v("#yt-form").reset(); $v("#yt-preview").hidden = true; say("Video shared with the community");
    } catch (err) { say("Couldn't share: " + (err.message || err.code)); }
  });

  async function init() {
    if (!window.claude) return;
    db = await window.claude.use("db"); if (!db) return;
    db.collection("videos").orderBy("createdAt", "desc").limit(120).onSnapshot((s) => { vids = s.docs.map((d) => ({ id: d.id, ...d.data() })).filter((v) => /^[\w-]{11}$/.test(v.yt || "")); render(); }, () => {});
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init); else init();
})();
