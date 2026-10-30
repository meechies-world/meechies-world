/* ============================================================================
   v2 ADS VIEW (Phase 5) — the live Community Ad Board: member
   shops (store links from member profiles), the free ads board
   (the ads collection; sponsored first; owner Promote toggle;
   tap-again delete that also removes the video), category chips,
   and the post-an-ad dialog (photo via the compress door, video
   via the social layer's uploadVideo — the live doors). The
   dialog markup is the live one, verbatim.
   ============================================================================ */

import { MARKUP } from "./ads-markup.js";
import { firestore, esc } from "../platform.js";
import { toast as say } from "../commerce.js";
import { compress, createSocial } from "../social.js";

const DIALOG = `<dialog id="ad-dialog">
  <form id="ad-form" method="dialog">
    <h3 style="font-size:22px">Post a free ad</h3>
    <div class="field"><label for="a-title">Headline</label><input type="text" id="a-title" maxlength="70" required></div>
    <div class="field"><label for="a-cat">Category</label><select id="a-cat"><option>Business</option><option>Event</option><option>Service</option><option>For Sale</option><option>Hiring</option></select></div>
    <div class="field"><label for="a-desc">Details</label><textarea id="a-desc" maxlength="600" required></textarea></div>
    <div class="field"><label for="a-contact">How people reach you</label><input type="text" id="a-contact" maxlength="120" required></div>
    <div class="field"><label for="a-photo">Photo (optional)</label><input type="file" id="a-photo" accept="image/*"></div>
    <div class="field"><label for="a-video">Video (optional, up to 50 MB)</label><input type="file" id="a-video" accept="video/*"><small class="muted">Phone trouble? <a href="/post-video#ad">Use the simple video poster</a>.</small><div class="vid-pick" id="a-vwrap" hidden><small class="muted" id="a-vinfo"></small><div class="vid-bar"><i id="a-vbar"></i></div></div></div>
    <div style="display:flex;gap:10px;justify-content:flex-end"><button class="btn ghost" type="button" id="ad-cancel">Cancel</button><button class="btn" type="submit">Post ad</button></div>
  </form>
</dialog>`;

let cleanup = [];
export function render(root, ctx) {
  root.innerHTML = MARKUP + DIALOG;
  const db = firestore(ctx);
  const soc = createSocial(ctx);
  const me = db.base.me();
  const isOwner = db.base.isOwner();
  const $ = (s) => root.querySelector(s);
  const $$ = (s) => [...root.querySelectorAll(s)];
  const needMember = () => soc.needMember();
  const shopLinks = (m) => [["Printify", m.printify], ["Shopify", m.shopify], ["Store", m.store]].filter((x) => x[1]);
  const initial = (h) => (h || "M").slice(0, 1).toUpperCase();
  const safeUrl = (u) => (/^https:\/\//.test(u || "") ? u : "#");
  db.base.listDocs("members", { limit: 200 }).then((rows) => {
    const list = rows.filter((m) => shopLinks(m).length);
    const box = $("#shops"); if (!box) return;
    box.innerHTML = list.length ? list.map((m) => `<div class="shop"><span class="avatar">${esc(initial(m.handle))}</span><div><b>${esc(m.handle)}</b><br><small class="muted">${esc(m.bio || "")}</small><div class="links">${shopLinks(m).map(([n, u]) => `<a class="shop-link" href="${esc(safeUrl(u))}" target="_blank" rel="noopener">${n}</a>`).join("")}</div></div></div>`).join("") : '<p class="muted" style="margin:0">Linked stores show up here. Add yours under Community → Edit profile &amp; shops.</p>';
  }).catch(() => {});

  let ads = [], adCat = "all", pendingAdPhoto = "", pendingAdVideo = null;
  function renderAds() {
    const list = ads.filter((a) => adCat === "all" || a.cat === adCat).sort((a, b) => (b.sponsored ? 1 : 0) - (a.sponsored ? 1 : 0));
    const empty = $("#ads-empty"); if (empty) empty.hidden = list.length > 0;
    const box = $("#ads"); if (!box) return;
    box.innerHTML = list.map((a) => `<article class="ad ${a.sponsored ? "sponsored" : ""}">${/^https:\/\//.test(a.video || "") ? `<video src="${esc(a.video)}#t=0.1" controls playsinline preload="metadata"${a.photo ? ` poster="${esc(a.photo)}"` : ""}></video>` : a.photo ? `<img src="${esc(a.photo)}" alt="">` : ""}
    <div class="body"><span class="cat">${esc(a.cat)}${a.sponsored ? ' · <span class="badge">Promoted</span>' : ""}</span><h3>${esc(a.title)}</h3><p>${esc(a.desc)}</p></div>
    <div class="foot"><span class="muted">${esc(a.contact)}</span><span style="display:flex;gap:4px">${isOwner ? `<button class="act" data-asp="${a.id}">${a.sponsored ? "Unpromote" : "Promote"}</button>` : ""}${(a.authorId === me || isOwner) ? `<button class="act" data-adel="${a.id}">Delete</button>` : ""}</span></div></article>`).join("");
  }
  const un = db.collection("ads").orderBy("createdAt", "desc").limit(200).onSnapshot((s) => { ads = s.docs.map((d) => ({ id: d.id, ...d.data() })); renderAds(); }, () => {});
  $("#ad-filters").addEventListener("click", (e) => { const c = e.target.closest("[data-cat]"); if (!c) return; adCat = c.dataset.cat; $$("#ad-filters .chip").forEach((x) => x.setAttribute("aria-pressed", x === c)); renderAds(); });
  $("#ads").addEventListener("click", (e) => {
    const t = e.target.closest("button"); if (!t) return;
    if (t.dataset.asp) { const a = ads.find((x) => x.id === t.dataset.asp); db.doc("ads/" + a.id).update({ sponsored: !a.sponsored }).catch((err) => say(err.message || err.code)); }
    if (t.dataset.adel) { if (t.dataset.confirm) { const vp = (ads.find((x) => x.id === t.dataset.adel) || {}).videoPath; db.doc("ads/" + t.dataset.adel).delete().then(() => { if (vp) soc.deleteMedia(vp); }); } else { t.dataset.confirm = "1"; t.textContent = "Tap again"; } }
  });
  const pickVideo = (f, info, wrap) => { if (!f) return null; if (f.size > 50 * 1048576) say("Big video: it will be shrunk to 720p before posting."); $(info).textContent = f.name + " · " + (f.size / 1048576).toFixed(1) + " MB"; $(wrap).hidden = false; return f; };
  $("#new-ad").addEventListener("click", () => { if (needMember()) $("#ad-dialog").showModal(); });
  $("#ad-cancel").addEventListener("click", () => $("#ad-dialog").close());
  $("#a-photo").addEventListener("change", async (e) => { const f = e.target.files[0]; if (f) { try { pendingAdPhoto = await compress(f, 900); } catch (err) { say(err.message); } } });
  $("#a-video").addEventListener("change", (e) => { pendingAdVideo = pickVideo(e.target.files[0], "#a-vinfo", "#a-vwrap"); if (!pendingAdVideo) e.target.value = ""; $("#a-vbar").style.width = "0"; });
  $("#ad-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const b = $("#ad-form button[type=submit]"); if (b.disabled) return; b.disabled = true; let vid = null;
    try {
      if (pendingAdVideo) { b.textContent = "Uploading 0%"; vid = await soc.uploadVideo(pendingAdVideo, (f) => { const n = Math.round(f * 100); b.textContent = "Uploading " + n + "%"; $("#a-vbar").style.width = n + "%"; }); b.textContent = "Posting..."; }
      await db.collection("ads").add({ authorId: me, title: $("#a-title").value.trim(), cat: $("#a-cat").value, desc: $("#a-desc").value.trim(), contact: $("#a-contact").value.trim(), photo: pendingAdPhoto, ...(vid ? { video: vid.url, videoPath: vid.path } : {}), sponsored: false, createdAt: Date.now() });
      $("#ad-form").reset(); pendingAdPhoto = ""; pendingAdVideo = null; $("#a-vwrap").hidden = true; $("#ad-dialog").close(); say("Your ad is live");
    } catch (err) { if (vid) soc.deleteMedia(vid.path); say("Couldn't post ad: " + (err.message || err.code)); }
    b.disabled = false; b.textContent = "Post ad";
  });
  cleanup.push(() => { if (typeof un === "function") un(); db.base.stop(); soc.destroy(); });
}
export function destroy() { cleanup.forEach((f) => { try { f(); } catch (_) {} }); cleanup = []; }
