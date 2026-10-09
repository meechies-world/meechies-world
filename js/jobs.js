/* Jobs: companies list jobs, workers post "for hire" profiles, and people message each other to apply or hire.
 * Collections: jobs { authorId, kind:"job"|"worker", title, company, location, pay, type, desc, skills, createdAt, sponsored } */
(function () {
  "use strict";
  const view = document.getElementById("v-jobs");
  if (!view) return;
  const root = view.querySelector("#jb-root");
  const E = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const say = (t) => (typeof toast === "function" ? toast(t) : null);
  const ME = () => (typeof me !== "undefined" ? me : null);
  const DB = () => (typeof db !== "undefined" ? db : null);
  const OWNER = () => typeof isOwner !== "undefined" && isOwner;
  let items = [], tab = "job", q = "", formOpen = false;

  const css = document.createElement("style");
  css.textContent = `
#jb-root{display:grid;gap:16px}
.jb-top{display:flex;gap:8px;flex-wrap:wrap;align-items:center}
.jb-top input{flex:1;min-width:180px;background:var(--ink);border:1px solid var(--line);border-radius:12px;padding:11px;color:var(--text);font:16px var(--body)}
.jb-list{display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:12px}
.jb{border:1px solid var(--line);border-radius:16px;padding:16px;background:linear-gradient(180deg,#17130c,#0f0d09);display:grid;gap:8px}
.jb.sp{border-color:var(--gold);box-shadow:0 0 0 1px var(--gold-lo)}
.jb h3{margin:0;font-size:18px}.jb .co{color:var(--gold-hi);font-weight:700}
.jb .tags{display:flex;gap:6px;flex-wrap:wrap}.jb .tags span{font-size:12px;border:1px solid var(--line);border-radius:999px;padding:3px 9px;color:var(--muted)}
.jb p{margin:0;font-size:14px;line-height:1.5;color:var(--text);white-space:pre-wrap;max-height:9em;overflow:hidden}
.jb .acts{display:flex;gap:6px;flex-wrap:wrap;align-items:center}
.jb-form{display:grid;gap:10px;border:1px solid var(--gold-lo);border-radius:16px;padding:16px}
.jb-form .row{display:grid;grid-template-columns:1fr 1fr;gap:10px}
.jb-form input,.jb-form select,.jb-form textarea{width:100%;background:var(--ink);border:1px solid var(--line);border-radius:10px;padding:10px;color:var(--text);font:16px var(--body)}
@media (max-width:640px){.jb-form .row{grid-template-columns:1fr}}`;
  document.head.appendChild(css);

  function render() {
    const list = items.filter((x) => (x.kind || "job") === tab && (!q || [x.title, x.company, x.location, x.desc, x.skills].join(" ").toLowerCase().includes(q)))
      .sort((a, b) => (b.sponsored ? 1 : 0) - (a.sponsored ? 1 : 0) || b.createdAt - a.createdAt);
    const who = (id) => (typeof handleOf === "function" ? handleOf(id) : "Member");
    const ago2 = (t) => (typeof ago === "function" ? ago(t) : "");
    const keep = document.activeElement && document.activeElement.id === "jb-q";
    root.innerHTML = `<div class="jb-top"><button class="chip" type="button" data-jtab="job" aria-pressed="${tab === "job"}">💼 Jobs</button><button class="chip" type="button" data-jtab="worker" aria-pressed="${tab === "worker"}">🙋 Workers for hire</button>
      <input type="search" id="jb-q" value="${E(q)}" placeholder="${tab === "job" ? "Search jobs, companies, towns" : "Search skills, trades, towns"}" aria-label="Search">
      <button class="btn" type="button" id="jb-new">${tab === "job" ? "＋ Post a job" : "＋ I'm for hire"}</button></div>
      ${formOpen ? form() : ""}
      <div class="jb-list">${list.map((x) => `<article class="jb ${x.sponsored ? "sp" : ""}">
        ${x.sponsored ? '<span class="badge" style="justify-self:start">Featured</span>' : ""}
        <h3>${E(x.title)}</h3>${x.company ? `<span class="co">${E(x.company)}</span>` : `<span class="co">${E(who(x.authorId))}</span>`}
        <div class="tags">${[x.location && "📍 " + x.location, x.pay && "💵 " + x.pay, x.type && "🕒 " + x.type].filter(Boolean).map((t) => `<span>${E(t)}</span>`).join("")}</div>
        ${x.skills ? `<div class="tags">${String(x.skills).split(/,\s*/).slice(0, 8).map((t) => `<span>${E(t)}</span>`).join("")}</div>` : ""}
        <p>${E(x.desc)}</p>
        <div class="acts"><small class="muted">${E(ago2(x.createdAt))} · by ${E(who(x.authorId))}</small><span style="flex:1"></span>
          ${x.authorId !== ME() ? `<button class="btn sm" type="button" data-dm="${E(x.authorId)}">${tab === "job" ? "Apply / Message" : "Hire / Message"}</button>` : ""}
          ${OWNER() ? `<button class="act" type="button" data-jsp="${E(x.id)}">${x.sponsored ? "Unfeature" : "Feature"}</button>` : ""}
          ${x.authorId === ME() || OWNER() ? `<button class="act" type="button" data-jdel="${E(x.id)}">Delete</button>` : ""}</div></article>`).join("") || `<div class="empty"><h3>${tab === "job" ? "No jobs posted yet" : "No workers listed yet"}</h3><p>Be the first.</p></div>`}</div>
      <p class="muted" style="font-size:13px;margin:0">Want your listing seen first? <a href="#promote" data-go="promote">Promote it</a> and it gets the gold Featured spot.</p>`;
    if (keep) { const i = root.querySelector("#jb-q"); i.focus(); i.setSelectionRange(i.value.length, i.value.length); }
  }
  function form() {
    const job = tab === "job";
    return `<form class="jb-form" id="jb-form"><b>${job ? "Post a job" : "List yourself for hire"}</b>
      <input id="jf-title" maxlength="90" required placeholder="${job ? "Job title (e.g. Line cook, Barber, Laborer)" : "What you do (e.g. Electrician, Braider, Driver)"}">
      <div class="row">${job ? '<input id="jf-co" maxlength="80" placeholder="Company name" required>' : '<input id="jf-co" maxlength="80" placeholder="Your business name (optional)">'}<input id="jf-loc" maxlength="80" placeholder="Town or area (or Remote)" required></div>
      <div class="row"><input id="jf-pay" maxlength="60" placeholder="${job ? "Pay (e.g. $18/hr)" : "Your rate (e.g. $50/job)"}"><select id="jf-type"><option>Full time</option><option>Part time</option><option>Gig / one-time</option><option>Contract</option><option>Remote</option></select></div>
      <input id="jf-skills" maxlength="160" placeholder="${job ? "Skills wanted, separated by commas" : "Your skills, separated by commas"}">
      <textarea id="jf-desc" maxlength="1500" rows="5" required placeholder="${job ? "What the job is, hours, and how to apply" : "Your experience and when you're available"}"></textarea>
      <small class="muted">Never send money to get a job, and never share your Social Security number in messages.</small>
      <div style="display:flex;gap:8px;justify-content:flex-end"><button class="btn ghost" type="button" id="jf-cancel">Cancel</button><button class="btn" type="submit">Post</button></div></form>`;
  }
  root.addEventListener("click", async (e) => {
    const b = e.target.closest("button"); if (!b) return;
    if (b.dataset.jtab) { tab = b.dataset.jtab; formOpen = false; render(); return; }
    if (b.id === "jb-new") { if (typeof needMember === "function" && !needMember()) return; formOpen = true; render(); root.querySelector("#jf-title").focus(); return; }
    if (b.id === "jf-cancel") { formOpen = false; render(); return; }
    if (b.dataset.jsp) { const x = items.find((i) => i.id === b.dataset.jsp); DB().doc("jobs/" + x.id).update({ sponsored: !x.sponsored }).catch((er) => say(er.message || er.code)); return; }
    if (b.dataset.jdel) { if (!b.dataset.confirm) { b.dataset.confirm = 1; b.textContent = "Tap again"; return; } DB().doc("jobs/" + b.dataset.jdel).delete().catch((er) => say(er.message || er.code)); return; }
  });
  root.addEventListener("input", (e) => { if (e.target.id === "jb-q") { q = e.target.value.trim().toLowerCase(); clearTimeout(root._t); root._t = setTimeout(render, 250); } });
  root.addEventListener("submit", async (e) => {
    if (e.target.id !== "jb-form") return; e.preventDefault();
    const v = (id) => root.querySelector("#" + id).value.trim();
    try {
      await DB().collection("jobs").add({ authorId: ME(), kind: tab, title: v("jf-title").slice(0, 90), company: v("jf-co").slice(0, 80), location: v("jf-loc").slice(0, 80), pay: v("jf-pay").slice(0, 60), type: v("jf-type"), skills: v("jf-skills").slice(0, 160), desc: v("jf-desc").slice(0, 1500), sponsored: false, createdAt: Date.now() });
      formOpen = false; say(tab === "job" ? "Your job is posted" : "You're listed for hire");
    } catch (er) { say("Couldn't post: " + (er.message || er.code)); }
  });
  async function init() {
    if (!window.claude) return;
    const d = await claude.use("db"); if (!d) { render(); return; }
    d.collection("jobs").orderBy("createdAt", "desc").limit(300).onSnapshot((s) => { items = s.docs.map((x) => ({ id: x.id, ...x.data() })); if (!view.hidden) render(); }, () => {});
    new MutationObserver(() => { if (!view.hidden) render(); }).observe(view, { attributes: true, attributeFilter: ["hidden"] });
    render();
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init); else init();
})();
