/* ============================================================================
   v2 CREATORS VIEW (Phase 5) — the live Creators view: the Wardrobe
   (fits shared from the Virtual World, rendered with the world's
   own avatarSVG; Try on wears the fit, likes follow the <25-hidden
   count rule), the Design Studio (js/designstudio.js), the designs
   wall with 🔥 votes + the owner's Select-for-store, and the team
   application form (builds the message, copies it for a DM — the
   live flow). Markup is the live section's own.
   ============================================================================ */

import { MARKUP } from "./creators-markup.js";
import { mountDesignStudio } from "../designstudio.js";
import { firestore, esc as E } from "../platform.js";
import { toast } from "../commerce.js";
import { avatarSVG, lookState } from "./world.js";

let cleanup = [];
export function render(root, ctx) {
  root.innerHTML = MARKUP;
  const db = firestore(ctx);
  const me = db.base.me();
  const isOwner = db.base.isOwner();
  const names = {};
  const handleOf = (id) => names[id] || "Member";
  db.base.listDocs("members", { limit: 200 }).then((rows) => { rows.forEach((m) => { names[m.id] = m.handle || m.name || "Member"; }); paintWardrobe(); paintDesigns(); }).catch(() => {});
  const stopStudio = mountDesignStudio(root, ctx);
  if (typeof stopStudio === "function") cleanup.push(stopStudio);

  /* ---------------- Wardrobe ---------------- */
  let wardrobe = [];
  const wbox = root.querySelector("#wardrobe");
  function paintWardrobe() {
    if (!wbox || !wardrobe.length) return;
    wbox.innerHTML = wardrobe.map((w) => {
      const liked = (w.likes || []).includes(me);
      const n = (w.likes || []).length;
      return `<div class="fit"><div class="fit-stage">${avatarSVG({ ...lookState.current, ...w.fit, photo: false }, "stand", "")}</div><b>${E(handleOf(w.authorId))}'s fit</b>
    <div class="fit-acts"><button class="btn sm" type="button" data-try="${w.id}">Try on</button><button class="act ${liked ? "on" : ""}" type="button" data-wlike="${w.id}">♥ ${(n < 25 && !isOwner) ? "" : n || ""}</button>${w.authorId === me || isOwner ? `<button class="act" type="button" data-wdel="${w.id}">Delete</button>` : ""}</div></div>`;
    }).join("");
  }
  if (wbox) wbox.addEventListener("click", (e) => {
    const b = e.target.closest("button"); if (!b) return;
    if (b.dataset.try) { const w = wardrobe.find((x) => x.id === b.dataset.try); if (!w) return; Object.assign(lookState.current, w.fit); try { localStorage.setItem("mw-look", JSON.stringify(lookState.current)); } catch (_) {} toast("You're wearing it. Head to the Virtual World."); }
    if (b.dataset.wlike) { if (!me) { toast("Join free to like fits."); return; } const w = wardrobe.find((x) => x.id === b.dataset.wlike); const st = new Set(w.likes || []); st.has(me) ? st.delete(me) : st.add(me); db.doc("wardrobe/" + w.id).update({ likes: [...st] }).catch((err) => toast(err.message || err.code)); }
    if (b.dataset.wdel) { if (!b.dataset.confirm) { b.dataset.confirm = "1"; b.textContent = "Tap again"; return; } db.doc("wardrobe/" + b.dataset.wdel).delete().catch((err) => toast(err.message || err.code)); }
  });
  const un1 = db.collection("wardrobe").orderBy("createdAt", "desc").limit(60).onSnapshot((s) => { wardrobe = s.docs.map((d) => ({ id: d.id, ...d.data() })); paintWardrobe(); }, () => {});

  /* ---------------- Designs wall ---------------- */
  let designs = [], dSort = "top";
  const dbox = root.querySelector("#designs");
  function paintDesigns() {
    if (!dbox || !designs.length) return;
    const list = [...designs].sort((a, b) => (b.selected ? 1 : 0) - (a.selected ? 1 : 0) || (dSort === "top" ? (b.votes || []).length - (a.votes || []).length : (b.createdAt || 0) - (a.createdAt || 0)));
    dbox.innerHTML = list.map((d) => {
      const v = (d.votes || []).includes(me);
      return `<article class="design ${d.selected ? "picked" : ""}"><img src="${E(d.img)}" data-front="${E(d.img)}" ${d.img2 ? `data-back="${E(d.img2)}"` : ""} alt="${E(d.title)}">${d.selected ? '<span class="badge pick">Selected for the store</span>' : ""}
    <div class="dz"><b>${E(d.title)}</b><small class="muted">by ${E(handleOf(d.authorId))}</small>${d.note ? `<small class="muted">${E(d.note)}</small>` : ""}
    <div class="fit-acts">${d.img2 ? `<button class="act" type="button" data-flip="${d.id}">Flip</button>` : ""}${/^data:image\/(png|jpe?g|webp);base64,[A-Za-z0-9+/=]+$/.test(d.art || "") && (d.authorId === me || isOwner) ? `<a class="act" download="${E(d.title)}" href="${E(d.art)}">Art file</a>` : ""}<button class="btn sm ${v ? "" : "ghost"}" type="button" data-vote="${d.id}">🔥 ${(d.votes || []).length}</button>${isOwner ? `<button class="act" type="button" data-pick="${d.id}">${d.selected ? "Unselect" : "Select for store"}</button>` : ""}${d.authorId === me || isOwner ? `<button class="act" type="button" data-ddel="${d.id}">Delete</button>` : ""}</div></div></article>`;
    }).join("");
  }
  const sortBar = root.querySelector("#dg-sort");
  if (sortBar) sortBar.addEventListener("click", (e) => { const b = e.target.closest("[data-sort]"); if (!b) return; dSort = b.dataset.sort; sortBar.querySelectorAll(".chip").forEach((x) => x.setAttribute("aria-pressed", x === b)); paintDesigns(); });
  if (dbox) dbox.addEventListener("click", (e) => {
    const b = e.target.closest("button"); if (!b) return;
    if (b.dataset.flip) { const im = b.closest(".design").querySelector("img"); const back = im.dataset.back; im.src = im.src === back ? im.dataset.front : back; return; }
    if (b.dataset.vote) { if (!me) { toast("Join free to vote."); return; } const d = designs.find((x) => x.id === b.dataset.vote); const st = new Set(d.votes || []); st.has(me) ? st.delete(me) : st.add(me); db.doc("designs/" + d.id).update({ votes: [...st] }).catch((err) => toast(err.message || err.code)); }
    if (b.dataset.pick) { const d = designs.find((x) => x.id === b.dataset.pick); db.doc("designs/" + d.id).update({ selected: !d.selected }).then(() => toast(d.selected ? "Unselected" : "Selected for the store")).catch((err) => toast(err.message || err.code)); }
    if (b.dataset.ddel) { if (!b.dataset.confirm) { b.dataset.confirm = "1"; b.textContent = "Tap again"; return; } db.doc("designs/" + b.dataset.ddel).delete().catch((err) => toast(err.message || err.code)); }
  });
  const un2 = db.collection("designs").orderBy("createdAt", "desc").limit(120).onSnapshot((s) => { designs = s.docs.map((d) => ({ id: d.id, ...d.data() })); paintDesigns(); }, () => {});

  /* ---------------- Team form ---------------- */
  const tf = root.querySelector("#team-form");
  if (tf) tf.addEventListener("submit", (e) => {
    e.preventDefault();
    const v = (id) => (root.querySelector("#" + id).value || "").trim();
    const msg = `Meechie's World team application\nName: ${v("tm-name")}\nRole: ${root.querySelector("#tm-role").value}\nReach me: ${v("tm-contact")}\nWork: ${v("tm-link") || "none"}\nMy idea: ${v("tm-idea")}`;
    root.querySelector("#team-msg").textContent = msg;
    const ready = root.querySelector("#team-ready"); ready.hidden = false;
    if (navigator.clipboard) navigator.clipboard.writeText(msg).then(() => toast("Copied. Paste it in a DM to us.")).catch(() => { const r = document.createRange(); r.selectNodeContents(root.querySelector("#team-msg")); const sel = getSelection(); sel.removeAllRanges(); sel.addRange(r); toast("Selected. Copy it and DM us."); });
    ready.scrollIntoView({ behavior: "smooth", block: "center" });
  });
  cleanup.push(() => { [un1, un2].forEach((u) => { if (typeof u === "function") u(); }); db.base.stop(); });
}
export function destroy() { cleanup.forEach((f) => { try { f(); } catch (_) {} }); cleanup = []; }
