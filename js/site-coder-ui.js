/* "🛠 AI coder" box inside the owner's Edit-site panel. Talks to /api/site-coder.
 * Step 1: describe a change → the AI explains what it understood, its plan, the risk, and any questions.
 * Step 2: "Build it" → it writes the code on a separate copy and gives a Preview link + an Approve link.
 * Nothing goes live until Meechie merges it on GitHub. */
(function () {
  "use strict";
  const E = (t) => String(t ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  let state = null;
  function mount(bar) {
    if (bar.querySelector("#mw-coder")) return;
    const box = document.createElement("div"); box.className = "r"; box.id = "mw-coder"; box.style.cssText = "display:grid;gap:8px";
    box.innerHTML = `<b style="color:#f0cf78">🛠 AI coder: bigger changes to the real code</b>
<span style="color:#a99f8b;font-size:13px">Describe a new feature or fix. It thinks it through first, then makes a preview copy. Nothing goes live until you approve it.</span>
<div style="display:flex;gap:8px"><input type="text" id="mw-cd-in" placeholder="e.g. Add a 'Book a haircut' button on the Services page that texts me" style="flex:1;min-width:0"><button class="p" type="button" id="mw-cd-go">Plan it</button></div>
<div id="mw-cd-out" hidden style="background:#1d1a14;border:1px solid #3a3223;border-radius:10px;padding:10px 12px;display:grid;gap:8px"></div>`;
    const ai = bar.querySelector("#mw-ai-out"); (ai ? ai.parentElement : bar.firstElementChild).after(box);
    box.querySelector("#mw-cd-go").addEventListener("click", plan);
    box.querySelector("#mw-cd-in").addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); e.stopPropagation(); plan(); } });
    box.addEventListener("click", (e) => { if (e.target.id === "mw-cd-build") build(); if (e.target.id === "mw-cd-again") plan(); if (e.target.id === "mw-cd-x") { state = null; out().hidden = true; } });
  }
  const out = () => document.getElementById("mw-cd-out");
  async function call(body) {
    const s = window.MW && MW.session && MW.session(); if (!s) throw new Error("Sign in first.");
    const r = await fetch("/api/site-coder", { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer " + s.access_token }, body: JSON.stringify(body) });
    const j = await r.json().catch(() => ({}));
    if (j.error === "needs_token") throw new Error("One-time setup needed: the AI coder needs a GitHub key saved in Cloudflare (GITHUB_TOKEN). Ask Claude for the 2-minute steps.");
    if (!r.ok || j.error) throw new Error(j.error === "owner_only" ? "Only the owner can use this." : j.error || "Something went wrong.");
    return j;
  }
  async function plan() {
    const q = document.getElementById("mw-cd-in").value.trim(); if (!q) return;
    const o = out(); o.hidden = false; o.innerHTML = "<span style='color:#a99f8b'>Thinking it through…</span>";
    const answers = (document.getElementById("mw-cd-ans") || {}).value || "";
    try {
      const j = await call({ step: "plan", request: q, answers });
      const p = j.plan || {}; state = { request: q, answers, plan: p };
      const qs = (p.questions || []).filter(Boolean);
      o.innerHTML = `<div><b>What I understood:</b> ${E(p.understanding)}</div>
${(p.plan || []).length ? `<div><b>My plan:</b><ol style="margin:4px 0 0;padding-left:20px">${p.plan.map((s) => `<li>${E(s)}</li>`).join("")}</ol></div>` : ""}
${p.risk ? `<div><b>Watch out for:</b> ${E(p.risk)}</div>` : ""}
${(p.files || []).length ? `<div style="color:#a99f8b;font-size:13px">Files: ${p.files.map(E).join(", ")}</div>` : ""}
${qs.length ? `<div><b>Questions for you:</b><ul style="margin:4px 0;padding-left:20px">${qs.map((s) => `<li>${E(s)}</li>`).join("")}</ul><input type="text" id="mw-cd-ans" placeholder="Type your answers, then tap Plan again" value="${E(answers)}" style="width:100%"></div>` : ""}
<div style="display:flex;gap:8px;flex-wrap:wrap">${qs.length ? `<button type="button" id="mw-cd-again">Plan again with my answers</button>` : ""}<button class="p" type="button" id="mw-cd-build" ${(p.files || []).length ? "" : "disabled"}>Build it (preview only)</button><button type="button" id="mw-cd-x">Cancel</button></div>`;
    } catch (e) { o.innerHTML = `<span style="color:#ff9b8a">${E(e.message)}</span>`; }
  }
  async function build() {
    if (!state) return; const o = out();
    o.insertAdjacentHTML("beforeend", "<div id='mw-cd-wait' style='color:#a99f8b'>Writing the code on a preview copy… (about a minute)</div>");
    try {
      const j = await call({ step: "build", request: state.request, answers: state.answers, plan: state.plan.plan, files: state.plan.files, search: state.plan.search });
      o.innerHTML = `<div style="color:#8fd6a8"><b>Ready to look at ✓</b></div><div>${E(j.summary)}</div>
${(j.notes || []).length ? `<div style="color:#f0cf78;font-size:13px">Notes: ${j.notes.map(E).join("; ")}</div>` : ""}
<div style="color:#a99f8b;font-size:13px">1) Open the preview (give it a minute to build) and check it on your phone. 2) If it's right, tap Approve and then "Squash and merge". If not, close it. Nothing on your live site changed.</div>
<div style="display:flex;gap:8px;flex-wrap:wrap"><a class="p" href="${E(j.preview)}" target="_blank" rel="noopener" style="text-decoration:none;padding:8px 12px;border-radius:8px;background:#d4a843;color:#0b0a08;font-weight:700">👀 Preview</a><a href="${E(j.pr)}" target="_blank" rel="noopener" style="text-decoration:none;padding:8px 12px;border-radius:8px;border:1px solid #3a3223;color:#f3ecdc;font-weight:700">✅ Approve on GitHub</a><button type="button" id="mw-cd-x">Done</button></div>`;
    } catch (e) { const w = document.getElementById("mw-cd-wait"); if (w) w.remove(); o.insertAdjacentHTML("beforeend", `<div style="color:#ff9b8a">${E(e.message)}</div>`); }
  }
  const tryMount = () => { const bar = document.getElementById("mw-bar"); if (bar) mount(bar); };
  new MutationObserver(tryMount).observe(document.documentElement, { childList: true, subtree: false });
  if (document.body) new MutationObserver(tryMount).observe(document.body, { childList: true });
  tryMount();
})();
