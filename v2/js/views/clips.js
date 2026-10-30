/* ============================================================================
   v2 VIEW — CLIPS (#clips). MAP §4.4: "CLIPS (clips.js): the community
   posts that have a playable https video (old Supabase links excluded)
   become a full-screen snap feed; post a clip = upload (converted) +
   a posts write."

   The live clips view, ported: vertical snap feed, lazy video attach,
   one clip sounds at a time (they start muted; the first tap anywhere
   can turn the sound on), tap to play/pause, like + comment counts
   under the owner's rules, and the 9-second watchdog that skips a clip
   whose video never becomes playable. The + button posts through the
   shared uploadVideo conversion, exactly like the live site.
   ============================================================================ */
import { createSocial, esc, say, clipList, likeCountVisible } from "../social.js";

const $ = (s, r) => (r || document).querySelector(s);
const $$ = (s, r) => [...(r || document).querySelectorAll(s)];

let cur = null;
export function destroy() { if (cur) { cur.teardown(); cur = null; } }

export async function render(root, ctx) {
  const S = createSocial(ctx);
  const me = S.me();
  const admin = await S.isAdmin();
  await S.loadMembers();

  root.innerHTML = `
  <div class="clips" data-clips>
    <div class="clips-empty"><h2>🎬 Clips</h2><p>Loading clips…</p></div>
  </div>
  <button class="clip-snd" type="button" data-snd aria-label="Toggle sound">🔇 Sound</button>
  <button class="clip-add" type="button" data-add aria-label="Post a clip">+</button>
  <div class="clip-up" data-up hidden>
    <b>Post a clip</b>
    <input type="text" maxlength="300" placeholder="Say what this is…" data-cap aria-label="Caption">
    <div class="clip-bar"><i data-bar></i></div>
    <p class="muted" data-note style="font-size:13px"></p>
    <div style="display:flex;gap:8px;justify-content:flex-end">
      <button class="btn ghost sm" type="button" data-cancel>Cancel</button>
      <button class="btn sm" type="button" data-pick>Choose video</button>
    </div>
    <input type="file" accept="video/*" hidden data-file>
  </div>`;

  const wrap = $("[data-clips]", root);
  let soundOn = false, active = null, io = null, posts = [];

  const esc2 = (s) => esc(s);
  function paint(posts) {
    const list = clipList(posts);
    if (!list.length) {
      wrap.innerHTML = `<div class="clips-empty"><h2>🎬 Clips</h2><p>No clips yet</p><p class="muted">Be the first. Tap + to post a video.</p></div>`;
      return;
    }
    wrap.innerHTML = list.map((c) => {
      const likeN = (c.likes || []).length;
      return `<div class="clip" data-id="${esc2(c.id)}">
        <video playsinline loop preload="none" muted data-src="${esc2(c.video)}"></video>
        <div class="clip-shade"></div><div class="clip-bigplay">▶</div>
        <div class="clip-cap"><b>@${esc2(S.handleOf(c.authorId))}</b><span>${esc2(c.text || "")}</span></div>
        <div class="clip-rail">
          <span class="clip-av">${S.avatarOf(c.authorId)}</span>
          <button class="clip-act" type="button" data-clike="${esc2(c.id)}"><span>${(c.likes || []).includes(me) ? "💛" : "🤍"}</span><small data-clike-n>${likeCountVisible(likeN, admin) ? likeN : ""}</small></button>
          <button class="clip-act" type="button" data-cmt="${esc2(c.id)}"><span>💬</span><small>${+c.replyCount || 0}</small></button>
          <button class="clip-act" type="button" data-cshare="${esc2(c.id)}"><span>↗️</span><small>Share</small></button>
        </div></div>`;
    }).join("");
    wire();
  }

  function arm(video) {
    if (!video || video.dataset.armed) return;
    video.dataset.armed = "1";
    if (!video.src && video.dataset.src) video.src = video.dataset.src;
    video.muted = !soundOn;
    video.play().then(() => {
      setTimeout(() => {
        if (video.closest(".clip") === active && video.readyState < 2) {
          const all = $$(".clip", wrap); const i = all.indexOf(video.closest(".clip"));
          const dead = video.closest(".clip"); if (dead) dead.remove();
          const nxt = all[i + 1] || all[0];
          if (nxt) nxt.scrollIntoView();
        }
      }, 9000);
    }).catch(() => {});
  }
  function wire() {
    if (io) io.disconnect();
    io = new IntersectionObserver((es) => {
      es.forEach((en) => {
        const v = en.target.querySelector("video"); if (!v) return;
        if (en.intersectionRatio > 0.6) { active = en.target; arm(v); const nx = en.target.nextElementSibling; if (nx) { const nv = nx.querySelector("video"); if (nv && !nv.src && nv.dataset.src) { nv.preload = "metadata"; nv.src = nv.dataset.src; } } }
        else if (v && !v.paused) v.pause();
      });
    }, { root: wrap, threshold: [0, 0.6, 1] });
    $$(".clip", wrap).forEach((c) => io.observe(c));
  }
  const fit = () => { wrap.style.height = ""; };
  fit();
  addEventListener("resize", fit);

  /* sound: clips start muted; the first tap anywhere can turn it on */
  const sndBtn = $("[data-snd]", root);
  const setSound = (on) => {
    soundOn = on;
    sndBtn.textContent = on ? "🔊 Sound" : "🔇 Sound";
    $$("video", wrap).forEach((v) => { v.muted = !on; });
  };
  sndBtn.addEventListener("click", (e) => { e.stopPropagation(); setSound(!soundOn); });

  wrap.addEventListener("click", async (e) => {
    const lk = e.target.closest("[data-clike]");
    if (lk) {
      if (!S.needMember()) return;
      const c = posts.find((x) => x.id === lk.dataset.clike); if (!c) return;
      c.likes = c.likes || [];
      const on = !c.likes.includes(me);
      c.likes = on ? [...c.likes, me] : c.likes.filter((x) => x !== me);
      lk.querySelector("span").textContent = on ? "💛" : "🤍";
      const nEl = lk.querySelector("[data-clike-n]"); if (nEl) nEl.textContent = likeCountVisible(c.likes.length, admin) ? c.likes.length : "";
      try { await S.mergeDoc("posts/" + c.id, { likes: c.likes }); } catch (err) { say(err.message); }
      return;
    }
    const cm = e.target.closest("[data-cmt]");
    if (cm) { try { sessionStorage.setItem("mw2-open-post", cm.dataset.cmt); } catch (_) {} location.hash = "#community"; return; }
    const cs = e.target.closest("[data-cshare]");
    if (cs) { const url = location.origin + "/#clips"; const txt = "Clips on Meechie's World 🎬"; if (navigator.share) navigator.share({ title: "Meechie's World Clips", text: txt, url }).catch(() => {}); else { try { await navigator.clipboard.writeText(url); say("Link copied 🔗"); } catch (_) { say(url); } } return; }
    const v = e.target.closest(".clip video");
    if (v) { if (!soundOn) setSound(true); const big = v.closest(".clip").querySelector(".clip-bigplay"); if (v.paused) { v.muted = !soundOn; v.play().catch(() => {}); big.style.opacity = "0"; } else { v.pause(); big.style.opacity = "1"; } }
  });

  /* post a clip */
  const up = $("[data-up]", root), fileInp = $("[data-file]", root);
  $("[data-add]", root).addEventListener("click", () => {
    if (!S.needMember()) return;
    up.hidden = false; $("[data-note]", root).textContent = ""; $("[data-bar]", root).style.width = "0%";
  });
  $("[data-cancel]", root).addEventListener("click", () => { up.hidden = true; });
  $("[data-pick]", root).addEventListener("click", () => fileInp.click());
  fileInp.addEventListener("change", async () => {
    const f = fileInp.files[0]; if (!f) return;
    const note = $("[data-note]", root), bar = $("[data-bar]", root);
    note.textContent = "Shrinking it for phones, then uploading — keep this open…";
    try {
      const u = await S.uploadVideo(f, (fr) => { bar.style.width = Math.round(fr * 100) + "%"; });
      note.textContent = "Posting…";
      await S.addDoc("posts", { authorId: me, text: $("[data-cap]", root).value.trim(), photo: "", video: u.url, videoPath: u.path, likes: [], replyCount: 0, sponsored: false, announce: false, createdAt: Date.now() });
      bar.style.width = "100%"; $("[data-cap]", root).value = ""; up.hidden = true;
      say("Your clip is live 🎬");
      load();
    } catch (err) { note.textContent = ""; say(err.message); }
    fileInp.value = "";
  });

  async function load() {
    posts = await S.docs("posts", { field: "createdAt", limit: 100 });
    paint(posts);
  }
  await load();
  S.bus.watch(["posts", "members"], async () => { await S.loadMembers(); load(); });

  cur = { teardown() { if (io) io.disconnect(); removeEventListener("resize", fit); S.destroy(); } };
}
