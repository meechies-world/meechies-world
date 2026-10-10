/* Clips: a TikTok-style full-screen vertical feed of member videos (community posts that have a video). */
(function () {
  "use strict";
  const view = document.getElementById("v-clips");
  if (!view) return;
  const box = document.getElementById("clips");
  const E = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const say = (t) => (typeof toast === "function" ? toast(t) : null);
  let muted = true, els = new Map(), file = null, io = null;

  const css = document.createElement("style");
  css.textContent = `
#v-clips .clips-wrap{position:relative;max-width:520px;margin:0 auto}
#v-clips .clips{height:calc(100dvh - 150px);min-height:420px;overflow-y:auto;scroll-snap-type:y mandatory;border-radius:18px;background:#000;border:1px solid var(--line);scrollbar-width:none;overscroll-behavior:contain}
#v-clips .clips::-webkit-scrollbar{display:none}
#v-clips .clip{position:relative;height:100%;scroll-snap-align:start;scroll-snap-stop:always;display:grid;place-items:center;overflow:hidden;background:#000}
#v-clips .clip video{width:100%;height:100%;object-fit:cover;background:#000}
#v-clips .clip .shade{position:absolute;inset:auto 0 0 0;height:45%;background:linear-gradient(transparent,rgba(0,0,0,.75));pointer-events:none}
#v-clips .clip .cap{position:absolute;left:14px;right:84px;bottom:18px;color:#fff;text-shadow:0 1px 3px #000;display:grid;gap:4px}
#v-clips .clip .cap b{font-size:16px}#v-clips .clip .cap p{margin:0;font-size:14px;line-height:1.35;max-height:5.4em;overflow:hidden}
#v-clips .rail{position:absolute;right:10px;bottom:22px;display:grid;gap:16px;justify-items:center}
#v-clips .rail button,#v-clips .rail a{display:grid;justify-items:center;gap:2px;background:none;border:0;color:#fff;font:700 12px system-ui,sans-serif;cursor:pointer;text-shadow:0 1px 3px #000;text-decoration:none}
#v-clips .rail .ic{width:46px;height:46px;border-radius:50%;display:grid;place-items:center;font-size:22px;background:rgba(0,0,0,.35);backdrop-filter:blur(6px)}
#v-clips .rail .on .ic{color:#ff3d5a}
#v-clips .rail .avatar{width:46px;height:46px;border:2px solid var(--gold);font-size:18px}
#v-clips .snd{position:absolute;top:14px;right:14px;border:0;border-radius:999px;background:rgba(0,0,0,.5);color:#fff;padding:8px 12px;font:700 13px system-ui,sans-serif;cursor:pointer}
#v-clips .paused-ic{position:absolute;font-size:64px;color:rgba(255,255,255,.85);pointer-events:none;text-shadow:0 2px 12px #000}
#v-clips .clip-empty{height:100%;display:grid;place-content:center;text-align:center;color:var(--muted);padding:24px}
#v-clips .clip-add{display:grid;place-items:center;position:absolute;left:50%;transform:translateX(-50%);bottom:14px;width:58px;height:40px;border-radius:12px;border:0;background:linear-gradient(90deg,#25f4ee 0 12%,#fff 12% 88%,#fe2c55 88%);color:#000;font:800 26px/1 system-ui,sans-serif;cursor:pointer;overflow:hidden}
#v-clips .clip-add input{position:absolute;inset:0;opacity:0;cursor:pointer}
#v-clips .clip-up{position:absolute;left:12px;right:12px;bottom:66px;background:var(--panel);border:1px solid var(--gold);border-radius:14px;padding:14px;display:grid;gap:10px;z-index:5}
#v-clips .clip-up input[type=text]{width:100%;background:var(--ink);border:1px solid var(--line);border-radius:10px;padding:10px;color:var(--text);font:16px system-ui,sans-serif}
@media (max-width:640px){#v-clips .clips{height:calc(100dvh - 120px);border-radius:0;border:0}}
body.has-player #v-clips .clips{height:calc(100dvh - 230px - env(safe-area-inset-bottom,0px))}
body.has-player #v-clips .rail{bottom:70px}`;
  document.head.appendChild(css);

  const P = () => (typeof posts !== "undefined" ? posts : []);
  const ME = () => (typeof me !== "undefined" ? me : null);
  const DB = () => (typeof db !== "undefined" ? db : null);
  const HANDLE = (id) => (typeof handleOf === "function" ? handleOf(id) : "Member");
  const AV = (id) => (typeof avatarOf === "function" ? avatarOf(id) : "");
  function clips() {
    return P().filter((p) => /^https:\/\//.test(p.video || "")).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  }
  function render() {
    const list = clips(), uid = ME();
    if (!list.length) { if (!box.querySelector(".clip-empty")) box.innerHTML = '<div class="clip-empty"><h3>No clips yet</h3><p>Be the first. Tap + to post a video.</p></div>'; els.clear(); return; }
    box.querySelector(".clip-empty")?.remove();
    const keep = new Set(list.map((p) => p.id));
    for (const [id, el] of els) if (!keep.has(id)) { el.remove(); els.delete(id); }
    let prev = null;
    list.forEach((p) => {
      let el = els.get(p.id);
      if (!el) {
        el = document.createElement("div"); el.className = "clip"; el.dataset.id = p.id;
        el.innerHTML = `<video playsinline loop preload="none" muted></video><div class="shade"></div><button class="snd" type="button"></button><div class="cap"></div><div class="rail"></div>`;
        el.querySelector("video").dataset.src = p.video;
        els.set(p.id, el); io && io.observe(el);
      }
      const liked = (p.likes || []).includes(uid);
      el.querySelector(".snd").textContent = muted ? "🔇 Tap for sound" : "🔊";
      el.querySelector(".cap").innerHTML = `<b>@${E(HANDLE(p.authorId))}</b>${p.text ? `<p>${E(p.text)}</p>` : ""}`;
      el.querySelector(".rail").innerHTML = `<span>${AV(p.authorId)}</span>
        <button type="button" class="${liked ? "on" : ""}" data-clike="${E(p.id)}" aria-label="Like"><span class="ic">♥</span>${(p.likes || []).length || ""}</button>
        <button type="button" data-ccom="${E(p.id)}" aria-label="Comments"><span class="ic">💬</span>${p.replyCount || ""}</button>
        <button type="button" data-cshare="${E(p.id)}" aria-label="Share"><span class="ic">↗</span>Share</button>`;
      if (prev ? prev.nextSibling !== el : box.firstChild !== el) (prev ? prev.after(el) : box.prepend(el));
      prev = el;
    });
  }
  function activate(el) {
    els.forEach((x) => { const v = x.querySelector("video"); if (x !== el && !v.paused) v.pause(); });
    const v = el.querySelector("video");
    if (!v.src) v.src = v.dataset.src;
    // preload the next clip
    const n = el.nextElementSibling?.querySelector("video"); if (n && !n.src) { n.preload = "metadata"; n.src = n.dataset.src; }
    v.muted = muted;
    try { if (typeof media !== "undefined" && !muted && !media.paused) media.pause(); } catch (_) {}
    v.play().catch(() => {});
  }
  function setupIO() {
    io = new IntersectionObserver((ents) => ents.forEach((en) => { if (en.isIntersecting && en.intersectionRatio > 0.6 && !view.hidden) activate(en.target); else en.target.querySelector("video").pause(); }), { root: box, threshold: [0, 0.6, 1] });
    els.forEach((el) => io.observe(el));
  }

  box.addEventListener("click", (e) => {
    const b = e.target.closest("button");
    const d = DB(), uid = ME(), list = P();
    if (b && b.classList.contains("snd")) { muted = !muted; els.forEach((x) => { x.querySelector("video").muted = muted; x.querySelector(".snd").textContent = muted ? "🔇 Tap for sound" : "🔊"; }); if (!muted) { try { if (!media.paused) media.pause(); } catch (_) {} } return; }
    if (b && b.dataset.clike) { if (typeof needMember === "function" && !needMember()) return; const p = list.find((x) => x.id === b.dataset.clike); if (!p) return; const s = new Set(p.likes || []); s.has(uid) ? s.delete(uid) : s.add(uid); d.doc("posts/" + p.id).update({ likes: [...s] }).catch((err) => say(err.message || err.code)); return; }
    if (b && b.dataset.ccom) { const id = b.dataset.ccom; try { openReplies.add(id); subReplies(id); } catch (_) {} if (typeof go === "function") go("community"); setTimeout(() => { renderFeed && renderFeed(); document.querySelector(`[data-rbox="${id}"]`)?.closest(".post")?.scrollIntoView({ behavior: "smooth", block: "center" }); }, 250); return; }
    if (b && b.dataset.cshare) { const url = location.origin + "/#clips"; if (navigator.share) navigator.share({ title: "Meechie's World Clips", url }).catch(() => {}); else navigator.clipboard?.writeText(url).then(() => say("Link copied")); return; }
    if (b) return;
    const clip = e.target.closest(".clip"); if (!clip) return;
    const v = clip.querySelector("video"); if (!v.src) return activate(clip);
    if (v.paused) { v.play().catch(() => {}); clip.querySelector(".paused-ic")?.remove(); }
    else { v.pause(); const i = document.createElement("span"); i.className = "paused-ic"; i.textContent = "▶"; clip.appendChild(i); }
  });

  // posting a clip
  const fi = document.getElementById("clip-file"), up = document.getElementById("clip-up");
  fi.addEventListener("click", (e) => { if (typeof needMember === "function" && !needMember()) e.preventDefault(); });
  fi.addEventListener("change", (e) => {
    const f = e.target.files[0]; e.target.value = ""; if (!f) return;
    if (f.size > (MW.VIDEO_MAX || 52428800)) say("Big video: it will be shrunk to 720p before posting (takes about as long as the video).");
    file = f; up.hidden = false; document.getElementById("clip-st").textContent = f.name + " · " + (f.size / 1048576).toFixed(1) + " MB"; document.getElementById("clip-bar").style.width = "0";
  });
  document.getElementById("clip-cancel").addEventListener("click", () => { file = null; up.hidden = true; });
  document.getElementById("clip-go").addEventListener("click", async (e) => {
    const b = e.currentTarget; if (!file || b.disabled) return; b.disabled = true; let vid = null;
    const d = DB(), uid = ME();
    try {
      vid = await MW.uploadVideo(file, (f) => { const n = Math.round(f * 100); document.getElementById("clip-bar").style.width = n + "%"; b.textContent = n + "%"; });
      await d.collection("posts").add({ authorId: uid, text: document.getElementById("clip-cap").value.trim(), photo: "", video: vid.url, videoPath: vid.path, likes: [], replyCount: 0, sponsored: false, announce: false, createdAt: Date.now() });
      file = null; up.hidden = true; document.getElementById("clip-cap").value = ""; say("Clip posted"); box.scrollTo({ top: 0, behavior: "smooth" });
    } catch (err) { if (vid) MW.deleteVideo(vid.path); document.getElementById("clip-st").textContent = err.message || "Couldn't post."; }
    b.disabled = false; b.textContent = "Post";
  });

  /* Phones: the feed starts partway down the page (under the menu and banner), so a fixed height pushed the
     + button and the posting box off the bottom of the screen, behind the player bar and bottom menu.
     Fit the feed to the space that's actually visible, and keep + and the posting box above the bottom bars. */
  const addBtn = document.getElementById("clip-add");
  function bottomUI() { // how much of the screen bottom is covered by the fixed player bar / bottom menu
    let top = innerHeight;
    // the bottom menu sits at the screen's edge and the player bar sits right on top of it, so count both
    document.querySelectorAll("nav.apptab, #player-bar, .apptab").forEach((el) => { if (el.hidden || getComputedStyle(el).display === "none") return; const r = el.getBoundingClientRect(); if (r.height > 0 && r.bottom > innerHeight * 0.6) top = Math.min(top, r.top); });
    return Math.max(0, innerHeight - top);
  }
  function fit() {
    if (view.hidden) return;
    const phone = matchMedia("(max-width:640px)").matches, under = bottomUI();
    if (!phone) { box.style.height = ""; addBtn.style.cssText = ""; up.style.cssText = ""; return; }
    const hdr = document.querySelector("header.bar")?.getBoundingClientRect().height || 0;
    box.style.height = Math.max(360, innerHeight - hdr - under) + "px";
    addBtn.style.cssText = `position:fixed;bottom:${under + 12}px;z-index:31`;
    up.style.cssText = `position:fixed;left:12px;right:12px;bottom:${under + 62}px;z-index:32`;
  }
  function snapIntoView() { // line the feed up right under the menu so the whole video shows
    if (!matchMedia("(max-width:640px)").matches) return;
    const hdr = document.querySelector("header.bar")?.getBoundingClientRect().height || 0;
    window.scrollTo({ top: box.getBoundingClientRect().top + scrollY - hdr, behavior: "instant" });
  }
  addEventListener("resize", fit);
  new MutationObserver(fit).observe(document.body, { attributes: true, attributeFilter: ["class"] }); // player bar showing or hiding
  const pbar = document.getElementById("player-bar"); if (pbar) new MutationObserver(fit).observe(pbar, { attributes: true, attributeFilter: ["hidden", "style", "class"] });
  setInterval(() => { if (!view.hidden && !document.hidden) fit(); }, 1500); // catch anything else that moves the bottom bars
  new MutationObserver(() => { if (!view.hidden) setTimeout(() => { fit(); snapIntoView(); }, 60); }).observe(view, { attributes: true, attributeFilter: ["hidden"] });
  if (!view.hidden) setTimeout(() => { fit(); snapIntoView(); }, 300);

  // pause everything when leaving the page
  new MutationObserver(() => { if (view.hidden) els.forEach((x) => x.querySelector("video").pause()); else { render(); const first = [...els.values()].find((x) => { const r = x.getBoundingClientRect(), br = box.getBoundingClientRect(); return r.top >= br.top - 5 && r.top < br.bottom - 50; }); first && activate(first); } }).observe(view, { attributes: true, attributeFilter: ["hidden"] });
  document.addEventListener("visibilitychange", () => { if (document.hidden) els.forEach((x) => x.querySelector("video").pause()); });
  document.addEventListener("mw-posts", render);
  setupIO(); render();
})();
