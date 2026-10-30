/* ============================================================================
   v2 JOBS VIEW (Phase 5) — the live js/jobs.js, ported: the jobs
   collection ({authorId, kind:"job"|"worker", title, company,
   location, pay, type, desc, skills, photos, sponsored, createdAt}),
   Jobs / Workers tabs, search, the post form with picture uploads
   (gateway uploadMedia), owner Feature toggle, tap-again delete.
   Message buttons route to the Book's DM surface via the profile.
   ============================================================================ */

import { MARKUP } from "./jobs-markup.js";
import { firestore, esc as E } from "../platform.js";
import { toast as say } from "../commerce.js";
import { compress } from "../social.js";

let cleanup = [];
export function render(root, ctx) {
  root.innerHTML = MARKUP;
  const db = firestore(ctx);
  const ME = () => db.base.me();
  const OWNER = () => db.base.isOwner();
  const names = {};
  const who = (id) => names[id] || "Member";
  const ago2 = (t) => { const s = Math.max(1, (Date.now() - (t || 0)) / 1000); if (s < 90) return "just now"; if (s < 5400) return Math.round(s / 60) + "m ago"; if (s < 129600) return Math.round(s / 3600) + "h ago"; return Math.round(s / 86400) + "d ago"; };
  db.base.listDocs("members", { limit: 200 }).then((rows) => { rows.forEach((m) => { names[m.id] = m.handle || m.name || "Member"; }); paint(); }).catch(() => {});
  let items = [], tab = "job", q = "", formOpen = false, jfPics = [];
  const box = root.querySelector("#jb-root");

  function form() {
    const job = tab === "job";
    return `<form class="jb-form" id="jb-form"><b>${job ? "Post a job" : "List yourself for hire"}</b>
      <input id="jf-title" maxlength="90" required placeholder="${job ? "Job title (e.g. Line cook, Barber, Laborer)" : "What you do (e.g. Electrician, Braider, Driver)"}">
      <div class="row">${job ? '<input id="jf-co" maxlength="80" placeholder="Company name" required>' : '<input id="jf-co" maxlength="80" placeholder="Your business name (optional)">'}<input id="jf-loc" maxlength="80" placeholder="Town or area (or Remote)" required></div>
      <div class="row"><input id="jf-pay" maxlength="60" placeholder="${job ? "Pay (e.g. $18/hr)" : "Your rate (e.g. $50/job)"}"><select id="jf-type"><option>Full time</option><option>Part time</option><option>Gig / one-time</option><option>Contract</option><option>Remote</option></select></div>
      <input id="jf-skills" maxlength="160" placeholder="${job ? "Skills wanted, separated by commas" : "Your skills, separated by commas"}">
      <textarea id="jf-desc" maxlength="1500" rows="5" required placeholder="${job ? "What the job is, hours, and how to apply" : "Your experience and when you're available"}"></textarea>
      <label style="display:grid;gap:5px;font-weight:700;font-size:14px">📷 Pictures <span class="muted" style="font-weight:400;font-size:12px">(optional, up to 4: your logo, your work, the job site)</span><input type="file" id="jf-pics" accept="image/*" multiple></label>
      <div id="jf-prev" style="display:flex;gap:6px;flex-wrap:wrap"></div>
      <small class="muted">Never send money to get a job, and never share your Social Security number in messages.</small>
      <div style="display:flex;gap:8px;justify-content:flex-end"><button class="btn ghost" type="button" id="jf-cancel">Cancel</button><button class="btn" type="submit">Post</button></div></form>`;
  }
  function paint() {
    if (!box) return;
    const list = items.filter((x) => (x.kind || "job") === tab && (!q || [x.title, x.company, x.location, x.desc, x.skills].join(" ").toLowerCase().includes(q)))
      .sort((a, b) => (b.sponsored ? 1 : 0) - (a.sponsored ? 1 : 0) || (b.createdAt || 0) - (a.createdAt || 0));
    const keep = document.activeElement && document.activeElement.id === "jb-q";
    box.innerHTML = `<div class="jb-top"><button class="chip" type="button" data-jtab="job" aria-pressed="${tab === "job"}">💼 Jobs</button><button class="chip" type="button" data-jtab="worker" aria-pressed="${tab === "worker"}">🙋 Workers for hire</button>
      <input type="search" id="jb-q" value="${E(q)}" placeholder="${tab === "job" ? "Search jobs, companies, towns" : "Search skills, trades, towns"}" aria-label="Search">
      <button class="btn" type="button" id="jb-new">${tab === "job" ? "＋ Post a job" : "＋ I'm for hire"}</button></div>
      ${formOpen ? form() : ""}
      <div class="jb-list">${list.map((x) => `<article class="jb ${x.sponsored ? "sp" : ""}">
        ${x.sponsored ? '<span class="badge" style="justify-self:start">Featured</span>' : ""}
        <h3>${E(x.title)}</h3>${x.company ? `<span class="co">${E(x.company)}</span>` : `<span class="co">${E(who(x.authorId))}</span>`}
        <div class="tags">${[x.location && "📍 " + x.location, x.pay && "💵 " + x.pay, x.type && "🕒 " + x.type].filter(Boolean).map((t) => `<span>${E(t)}</span>`).join("")}</div>
        ${x.skills ? `<div class="tags">${String(x.skills).split(/,\s*/).slice(0, 8).map((t) => `<span>${E(t)}</span>`).join("")}</div>` : ""}
        ${(Array.isArray(x.photos) ? x.photos : []).filter((u) => /^https:\/\//.test(u)).length ? `<div style="display:flex;gap:6px;overflow-x:auto">${x.photos.filter((u) => /^https:\/\//.test(u)).slice(0, 4).map((u) => `<img src="${E(u)}" alt="" loading="lazy" style="width:120px;height:120px;object-fit:cover;border-radius:10px;flex:none">`).join("")}</div>` : ""}
        <p>${E(x.desc)}</p>
        <div class="acts"><small class="muted">${E(ago2(x.createdAt))} · by ${E(who(x.authorId))}</small><span style="flex:1"></span>
          ${x.authorId !== ME() ? `<button class="btn sm" type="button" data-profile="${E(x.authorId)}">${tab === "job" ? "Apply / Message" : "Hire / Message"}</button>` : ""}
          ${OWNER() ? `<button class="act" type="button" data-jsp="${E(x.id)}">${x.sponsored ? "Unfeature" : "Feature"}</button>` : ""}
          ${x.authorId === ME() || OWNER() ? `<button class="act" type="button" data-jdel="${E(x.id)}">Delete</button>` : ""}</div></article>`).join("") || `<div class="empty"><h3>${tab === "job" ? "No jobs posted yet" : "No workers listed yet"}</h3><p>Be the first.</p></div>`}</div>
      <p class="muted" style="font-size:13px;margin:0">Want your listing seen first? <a href="#promote" data-go="promote">Promote it</a> and it gets the gold Featured spot.</p>`;
    if (keep) { const i = box.querySelector("#jb-q"); i.focus(); i.setSelectionRange(i.value.length, i.value.length); }
  }
  box.addEventListener("click", async (e) => {
    const b = e.target.closest("button"); if (!b) return;
    if (b.dataset.jtab) { tab = b.dataset.jtab; formOpen = false; paint(); return; }
    if (b.id === "jb-new") { if (!ME()) { say("Join free to post."); return; } formOpen = true; paint(); const t = box.querySelector("#jf-title"); if (t) t.focus(); return; }
    if (b.id === "jf-cancel") { jfPics = []; formOpen = false; paint(); return; }
    if (b.dataset.jsp) { const x = items.find((i) => i.id === b.dataset.jsp); if (x) db.doc("jobs/" + x.id).update({ sponsored: !x.sponsored }).catch((er) => say(er.message || er.code)); return; }
    if (b.dataset.jdel) { if (!b.dataset.confirm) { b.dataset.confirm = 1; b.textContent = "Tap again"; return; } db.doc("jobs/" + b.dataset.jdel).delete().catch((er) => say(er.message || er.code)); return; }
  });
  box.addEventListener("change", async (e) => {
    if (e.target.id !== "jf-pics") return;
    const files = [...e.target.files].slice(0, 4 - jfPics.length); e.target.value = ""; if (!files.length) return;
    say("Adding your pictures…");
    for (const f of files) { try { const small = await compress(f, 1280); const blob = small ? await (await fetch(small)).blob() : f; const up = await db.base.uploadMedia(blob, { type: "image/jpeg", ext: "jpg" }); if (up && /^https:\/\//.test(up.url)) jfPics.push(up.url); } catch (er) { say("Couldn't add a picture: " + (er.message || er)); } }
    const pv = box.querySelector("#jf-prev"); if (pv) pv.innerHTML = jfPics.map((u) => `<img src="${E(u)}" alt="" style="width:64px;height:64px;object-fit:cover;border-radius:8px">`).join("");
  });
  box.addEventListener("input", (e) => { if (e.target.id === "jb-q") { q = e.target.value.trim().toLowerCase(); clearTimeout(box._t); box._t = setTimeout(paint, 250); } });
  box.addEventListener("submit", async (e) => {
    if (e.target.id !== "jb-form") return; e.preventDefault();
    const v = (id) => box.querySelector("#" + id).value.trim();
    try {
      await db.collection("jobs").add({ authorId: ME(), kind: tab, title: v("jf-title").slice(0, 90), company: v("jf-co").slice(0, 80), location: v("jf-loc").slice(0, 80), pay: v("jf-pay").slice(0, 60), type: v("jf-type"), skills: v("jf-skills").slice(0, 160), desc: v("jf-desc").slice(0, 1500), photos: jfPics.slice(0, 4), sponsored: false, createdAt: Date.now() });
      jfPics = []; formOpen = false; paint(); say(tab === "job" ? "Your job is posted" : "You're listed for hire");
    } catch (er) { say("Couldn't post: " + (er.message || er.code)); }
  });
  const unsub = db.collection("jobs").orderBy("createdAt", "desc").limit(300).onSnapshot((s) => { items = s.docs.map((x) => ({ id: x.id, ...x.data() })); if (!(formOpen && box.querySelector("#jb-form"))) paint(); }, () => {});
  paint();
  cleanup.push(() => { if (typeof unsub === "function") unsub(); db.base.stop(); });
}
export function destroy() { cleanup.forEach((f) => { try { f(); } catch (_) {} }); cleanup = []; }
