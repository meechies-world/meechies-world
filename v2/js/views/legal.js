/* v2 LEGAL VIEW (Phase 5) — the live js/legal.js, ported: Legal
   Help for people representing themselves — the local case draft
   (this device only), document picker, real case law from
   CourtListener, the AI draft via /api/legal, verify-before-you-
   file guidance, deadline tracking, and the hire-Meechie request
   (sent as a private message through the site's DM door; the fee
   preview math is the live one: $20 processing + $20 a document,
   no payment collected here). Styles live in css/legal.css. */
import { MARKUP } from "./legal-markup.js";
import { OWNER_ID } from "../platform.js";
import { toast } from "../commerce.js";

export function render(viewRoot, ctx) {
  viewRoot.innerHTML = MARKUP;


  const $ = (s) => viewRoot.querySelector(s);
  const E = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const CL = "https://www.courtlistener.com";
  const KEY = "mw_legal_case_v1";
  const tok = () => { const s = ctx.session.get(); return (s && s.access_token) || ""; };
  const say = toast;

  const DOCS = {
    "Criminal": ["Motion to Dismiss", "Motion to Suppress Evidence", "Motion for Discovery / Brady Material", "Motion to Compel Discovery", "Motion for Bond Reduction / Pretrial Release", "Motion for Speedy Trial", "Motion to Dismiss for Speedy Trial Violation", "Motion for Continuance", "Motion in Limine", "Motion for a Bill of Particulars", "Motion for Appointment of New Counsel", "Motion to Withdraw Guilty Plea", "Motion for Reconsideration of Sentence", "Motion for Sentence Reduction", "Motion for Judgment of Acquittal", "Motion for New Trial"],
    "Post-conviction & appeals": ["Petition for Writ of Habeas Corpus", "Motion to Vacate Sentence (28 U.S.C. § 2255)", "Notice of Appeal", "Motion for Extension of Time to File Appeal", "Petition for Writ of Mandamus", "Motion for Expungement / Record Sealing"],
    "Civil & civil rights": ["Civil Rights Complaint (42 U.S.C. § 1983)", "Complaint (general civil)", "Answer to Complaint", "Motion to Dismiss (civil)", "Motion for Summary Judgment", "Response in Opposition to Motion", "Motion for Default Judgment", "Motion to Proceed In Forma Pauperis (fee waiver)", "Motion for Appointment of Counsel", "Motion for Preliminary Injunction / TRO", "Small Claims Complaint", "Answer to Eviction / Unlawful Detainer"],
    "Family": ["Petition for Custody / Visitation", "Motion to Modify Child Support", "Petition for Protective Order Response", "Motion for Contempt"],
    "Other papers": ["Affidavit / Sworn Declaration", "Letter to the Judge", "Letter to the Clerk of Court", "Prison Grievance", "Notice of Change of Address", "Certificate of Service", "Freedom of Information / Records Request", "Other (describe in instructions)"],
  };
  // CourtListener court ids: [state high court(s), federal circuit]
  const COURTS = { Alabama: ["ala", "ca11"], Alaska: ["alaska", "ca9"], Arizona: ["ariz", "ca9"], Arkansas: ["ark", "ca8"], California: ["cal", "ca9"], Colorado: ["colo", "ca10"], Connecticut: ["conn", "ca2"], Delaware: ["del", "ca3"], "District of Columbia": ["dc", "cadc"], Florida: ["fla", "ca11"], Georgia: ["ga", "ca11"], Hawaii: ["haw", "ca9"], Idaho: ["idaho", "ca9"], Illinois: ["ill", "ca7"], Indiana: ["ind", "ca7"], Iowa: ["iowa", "ca8"], Kansas: ["kan", "ca10"], Kentucky: ["ky", "ca6"], Louisiana: ["la", "ca5"], Maine: ["me", "ca1"], Maryland: ["md", "ca4"], Massachusetts: ["mass", "ca1"], Michigan: ["mich", "ca6"], Minnesota: ["minn", "ca8"], Mississippi: ["miss", "ca5"], Missouri: ["mo", "ca8"], Montana: ["mont", "ca9"], Nebraska: ["neb", "ca8"], Nevada: ["nev", "ca9"], "New Hampshire": ["nh", "ca1"], "New Jersey": ["nj", "ca3"], "New Mexico": ["nm", "ca10"], "New York": ["ny", "ca2"], "North Carolina": ["nc", "ca4"], "North Dakota": ["nd", "ca8"], Ohio: ["ohio", "ca6"], Oklahoma: ["okla oklacrimapp", "ca10"], Oregon: ["or", "ca9"], Pennsylvania: ["pa pasuperct", "ca3"], "Rhode Island": ["ri", "ca1"], "South Carolina": ["sc", "ca4"], "South Dakota": ["sd", "ca8"], Tennessee: ["tenn tenncrimapp", "ca6"], Texas: ["tex texcrimapp", "ca5"], Utah: ["utah", "ca10"], Vermont: ["vt", "ca2"], Virginia: ["va", "ca4"], Washington: ["wash", "ca9"], "West Virginia": ["wva", "ca4"], Wisconsin: ["wis", "ca7"], Wyoming: ["wyo", "ca10"] };

  

  // fill the pickers
  $("#lg-doc").innerHTML = Object.entries(DOCS).map(([g, list]) => `<optgroup label="${E(g)}">${list.map((d) => `<option>${E(d)}</option>`).join("")}</optgroup>`).join("");
  $("#lg-state").innerHTML = '<option value="">Pick a state</option>' + Object.keys(COURTS).map((s) => `<option>${E(s)}</option>`).join("");

  /* ---------- the case file: saved only on this device ---------- */
  const FIELDS = ["system", "state", "county", "court", "caseNo", "type", "judge", "name", "role", "other", "otherCounsel", "charges", "status", "address", "contact", "facts", "relief", "issues", "instructions", "doc", "draft"];
  const el = (k) => viewRoot.querySelector(`[data-k="${k}"]`);
  function read() { const o = {}; FIELDS.forEach((k) => { const x = el(k); if (x) o[k] = x.value; }); return o; }
  function write(o) { FIELDS.forEach((k) => { const x = el(k); if (x && o && o[k] != null) x.value = o[k]; }); }
  /* several cases, each saved on this device: { cur, cases: { id: { data, updated } } } */
  const CKEY = "mw_legal_cases_v2";
  let store = { cur: "", cases: {} };
  try { store = JSON.parse(localStorage.getItem(CKEY) || "null") || store; } catch (_) {}
  if (!store.cases || !Object.keys(store.cases).length) { // first time: bring over the one saved case
    let old = null; try { old = JSON.parse(localStorage.getItem(KEY) || "null"); } catch (_) {}
    const id = "c" + Date.now().toString(36); store = { cur: id, cases: { [id]: { data: old || {}, updated: Date.now() } } };
  }
  if (!store.cases[store.cur]) store.cur = Object.keys(store.cases)[0];
  try { const ov = localStorage.getItem("mw_legal_versions_v1"); if (ov) { const nk = "mw_legal_versions_v1_" + Object.keys(store.cases)[0]; if (!localStorage.getItem(nk)) localStorage.setItem(nk, ov); localStorage.removeItem("mw_legal_versions_v1"); } } catch (_) {} // bring over the saved versions from before there were several cases
  const titleOf = (d) => (d && (d.caseNo || d.name || d.doc)) ? [d.name, d.caseNo, d.doc].filter(Boolean).join(" · ").slice(0, 60) : "Untitled case";
  function persist() { try { localStorage.setItem(CKEY, JSON.stringify(store)); } catch (_) {} }
  function save() { store.cases[store.cur] = { data: read(), updated: Date.now() }; persist(); paintCases(); track(); }
  function paintCases() {
    const sel = $("#lg-cases"); if (!sel) return;
    const ids = Object.keys(store.cases).sort((a, b) => (store.cases[b].updated || 0) - (store.cases[a].updated || 0));
    sel.innerHTML = ids.map((id) => `<option value="${E(id)}"${id === store.cur ? " selected" : ""}>${E(titleOf(store.cases[id].data))}</option>`).join("");
  }
  function blank() { FIELDS.forEach((k) => { const x = el(k); if (!x) return; if (x.tagName === "SELECT") x.selectedIndex = 0; else x.value = ""; }); }
  let vgen = 0; // a newer citation check (or switching cases) stops an older one from adding rows
  function openCase(id) { vgen++; store.cur = id; persist(); blank(); write(store.cases[id].data || {}); paintCases(); paintVers(); track(); $("#lg-res").innerHTML = ""; $("#lg-ver").innerHTML = ""; $("#lg-review").hidden = true; }
  write(store.cases[store.cur].data || {}); paintCases();
  let st = 0; viewRoot.addEventListener("input", () => { clearTimeout(st); st = setTimeout(save, 400); });
  const caseObj = () => { const o = read(); return { system: o.system, state: o.state, county: o.county, court: o.court, caseNo: o.caseNo, type: o.type, judge: o.judge, name: o.name, role: o.role, other: o.other, otherCounsel: o.otherCounsel, charges: o.charges, status: o.status, address: o.address, contact: o.contact }; };

  $("#lg-export").addEventListener("click", () => {
    const blob = new Blob([JSON.stringify({ meechiesWorldCase: 1, savedAt: new Date().toISOString(), ...read() }, null, 2)], { type: "application/json" });
    const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = "my-case-" + (el("caseNo").value || "file").replace(/[^\w-]+/g, "_") + ".json"; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  });
  $("#lg-import").addEventListener("change", async (e) => {
    const f = e.target.files[0]; e.target.value = ""; if (!f) return;
    try { const o = JSON.parse(await f.text()); if (!o || typeof o !== "object") throw 0; save(); const id = "c" + Date.now().toString(36); store.cases[id] = { data: o, updated: Date.now() }; openCase(id); persist(); say("Case file opened as a new case"); } catch (_) { say("That file isn't a saved case file."); }
  });
  // "Start a new case" now erases just this case (the others stay saved)
  $("#lg-clear").textContent = "Erase this case";
  $("#lg-clear").addEventListener("click", (e) => {
    const b = e.currentTarget; if (!b.dataset.sure) { b.dataset.sure = "1"; b.textContent = "Tap again to erase"; setTimeout(() => { delete b.dataset.sure; b.textContent = "Erase this case"; }, 3000); return; }
    delete b.dataset.sure; b.textContent = "Erase this case";
    try { localStorage.removeItem(HKEY()); } catch (_) {}
    delete store.cases[store.cur];
    if (!Object.keys(store.cases).length) { const id = "c" + Date.now().toString(36); store.cases[id] = { data: {}, updated: Date.now() }; }
    openCase(Object.keys(store.cases)[0]); persist(); say("Case erased from this device");
  });
  $("#lg-cases").addEventListener("change", (e) => { const id = e.target.value; save(); if (store.cases[id]) openCase(id); });
  $("#lg-newcase").addEventListener("click", () => { save(); const id = "c" + Date.now().toString(36); store.cases[id] = { data: {}, updated: Date.now() }; openCase(id); persist(); $("#lg-c1").scrollIntoView({ behavior: "smooth", block: "start" }); say("New case started. Your other cases are still saved."); });
  // a made-up example so people can see how it works
  $("#lg-example").addEventListener("click", () => {
    save(); const id = "c" + Date.now().toString(36);
    store.cases[id] = { updated: Date.now(), data: { system: "State court", state: "West Virginia", county: "Example County", court: "Circuit Court of Example County, West Virginia", caseNo: "EX-26-F-001", type: "Criminal", judge: "", name: "John Q. Sample", role: "Defendant", other: "State of West Virginia", otherCounsel: "Example County Prosecuting Attorney", charges: "Possession with intent to deliver", status: "Pretrial; next hearing not yet set",
      facts: "On January 5, 2026 around 11 p.m. I was driving home when an officer pulled me over, saying my license plate light was out. He took my license and ran it, and it came back clean. He then told me to get out of the car and asked if he could search it. I said no. He made me wait about 25 minutes for a drug dog. The dog walked around the car, and the officer said it alerted. He searched the trunk and found a backpack that isn't mine. I was arrested.",
      relief: "Suppress (throw out) everything found in the search and anything I said after the stop, because the stop was dragged out without reasonable suspicion.",
      issues: "traffic stop extended for drug dog without reasonable suspicion", doc: "Motion to Suppress Evidence", instructions: "", draft: "" } };
    openCase(id); persist(); $("#lg-c3").scrollIntoView({ behavior: "smooth", block: "start" });
    say("Example case loaded (made up). Tap Find real case law, then Draft my document.");
  });

  /* ---------- progress tracker ---------- */
  function track() {
    const o = read(), done = [!!(o.state && (o.court || o.caseNo || o.name)), !!(o.facts.trim() && o.relief.trim()), !!(o.doc && (viewRoot.querySelector("#lg-res input:checked") || o.draft.trim())), !!o.draft.trim()];
    const next = done.indexOf(false);
    viewRoot.querySelectorAll("#lg-track a").forEach((a, i) => { a.classList.toggle("done", done[i]); a.classList.toggle("next", i === next); });
  }
  $("#lg-track").addEventListener("click", (e) => { const a = e.target.closest("[data-to]"); if (!a) return; e.preventDefault(); document.getElementById(a.dataset.to)?.scrollIntoView({ behavior: "smooth", block: "start" }); });
  setTimeout(track, 0);

  /* ---------- case law research (CourtListener) ---------- */
  let found = [];
  const clean = (t) => String(t || "").replace(/<\/?mark>/g, "").replace(/\s+/g, " ").trim();
  async function clSearch(q, courts) {
    const u = CL + "/api/rest/v4/search/?type=o&highlight=on&order_by=score%20desc&q=" + encodeURIComponent(q) + (courts ? "&court=" + encodeURIComponent(courts) : "");
    const r = await fetch(u); if (!r.ok) throw new Error("search " + r.status);
    return (await r.json()).results || [];
  }
  function keywords() {
    const o = read(); const doc = o.doc || "";
    const base = { "Motion to Suppress Evidence": "suppress evidence fourth amendment", "Motion for Speedy Trial": "speedy trial", "Motion to Dismiss for Speedy Trial Violation": "speedy trial dismissal", "Motion for Bond Reduction / Pretrial Release": "bail excessive pretrial release", "Motion for Discovery / Brady Material": "Brady exculpatory evidence disclosure", "Motion to Compel Discovery": "compel discovery", "Petition for Writ of Habeas Corpus": "habeas corpus", "Motion to Vacate Sentence (28 U.S.C. § 2255)": "2255 ineffective assistance", "Civil Rights Complaint (42 U.S.C. § 1983)": "1983 civil rights", "Motion for Summary Judgment": "summary judgment genuine dispute material fact", "Motion to Withdraw Guilty Plea": "withdraw guilty plea", "Motion for Appointment of New Counsel": "substitute counsel conflict", "Motion in Limine": "motion in limine", "Motion for Preliminary Injunction / TRO": "preliminary injunction irreparable harm" }[doc] || doc.replace(/\(.*?\)|\/.*$/g, "").replace(/^(Motion|Petition) (to|for)\s*/i, "");
    return ((o.issues || "").slice(0, 120) + " " + base).trim();
  }
  $("#lg-find").addEventListener("click", async () => {
    const box = $("#lg-res"), msg = $("#lg-find-msg"), st = el("state").value, fed = /federal/i.test(el("system").value);
    const q = ($("#lg-q").value || keywords()).trim(); $("#lg-q").value = q;
    if (!q) { msg.textContent = "Type what the case law should be about (for example: warrantless car search)."; return; }
    msg.textContent = "Searching real court opinions...";
    const c = COURTS[st]; const courts = ["scotus", c ? (fed ? c[1] : c[0] + " " + c[1]) : ""].join(" ").trim();
    let res = [];
    try { res = await clSearch(q, courts); if (res.length < 4) res = res.concat(await clSearch(q, "")); } catch (e) { try { res = await clSearch(q, ""); } catch (_) {} }
    const seen = new Set();
    found = res.filter((x) => x.citation && x.citation.length && x.caseName).filter((x) => !seen.has(x.cluster_id) && seen.add(x.cluster_id)).slice(0, 12).map((x) => ({
      name: clean(x.caseName), cite: pickCite(x.citation), court: x.court_citation_string || x.court || "", courtId: x.court_id, year: String(x.dateFiled || "").slice(0, 4),
      url: CL + x.absolute_url, snippet: clean((x.opinions && x.opinions[0] && x.opinions[0].snippet) || x.syllabus || "").replace(/^.{0,40}?(Appeal:|Doc:|Filed:|Pg:).*?(PUBLISHED|UNPUBLISHED)\s*/i, "").slice(0, 700), cited: x.citeCount || 0 }));
    if (!found.length) { msg.textContent = "No published cases matched. Try fewer, simpler words."; box.innerHTML = ""; return; }
    msg.textContent = found.length + " real cases found. Check the ones to give the AI, then draft. Tap a name to read the case.";
    box.innerHTML = found.map((f, i) => `<label><input type="checkbox" data-i="${i}" ${i < 6 ? "checked" : ""}><span><b><a href="${E(f.url)}" target="_blank" rel="noopener">${E(f.name)}</a></b><small>${E(f.cite)} · ${E(f.court)} ${E(f.year)}${f.cited ? " · cited " + f.cited + " times" : ""}</small>${f.snippet ? `<small style="display:block;margin-top:4px">${E(f.snippet)}</small>` : ""}</span></label>`).join("");
  });
  function pickCite(list) { // prefer official reporters
    const order = [/ U\.S\. /, / S\. ?Ct\. /, / F\.4th /, / F\.3d /, / F\.2d /, / F\. Supp/, / S\.E\.2d /, / N\.E\.2d /, / N\.W\.2d /, / A\.3d /, / A\.2d /, / P\.3d /, / So\. ?3d /, / S\.W\.3d /];
    for (const re of order) { const c = list.find((x) => re.test(" " + x + " ")); if (c) return c; }
    return list.find((x) => !/LEXIS|WL/.test(x)) || list[0];
  }
  const chosen = () => [...viewRoot.querySelectorAll("#lg-res input:checked")].map((x) => found[+x.dataset.i]).filter(Boolean);

  /* ---------- earlier versions (last 8, this device only) ---------- */
  const HKEY = () => "mw_legal_versions_v1_" + store.cur;
  const vers = () => { try { return JSON.parse(localStorage.getItem(HKEY()) || "[]"); } catch (_) { return []; } };
  // an AI draft that finished after you switched cases goes back to the case it was for (old draft kept in its history)
  function saveToCase(cid, t, label) {
    const c = store.cases[cid]; if (!c) { say("That case was erased, so the new draft wasn't saved."); return; }
    const old = (c.data && c.data.draft) || "";
    if (old.trim()) { try { const k = "mw_legal_versions_v1_" + cid, v = JSON.parse(localStorage.getItem(k) || "[]").filter((x) => x.text !== old); v.unshift({ at: Date.now(), label, text: old }); localStorage.setItem(k, JSON.stringify(v.slice(0, 8))); } catch (_) {} }
    store.cases[cid] = { data: { ...(c.data || {}), draft: t }, updated: Date.now() }; persist(); paintCases();
    say("Your new draft was saved in the case you started it from.");
  }
  function keepVersion(label) { const t = el("draft").value; if (!t.trim()) return; const v = vers().filter((x) => x.text !== t); v.unshift({ at: Date.now(), label, text: t }); try { localStorage.setItem(HKEY(), JSON.stringify(v.slice(0, 8))); } catch (_) {} paintVers(); }
  function paintVers() { $("#lg-hist").innerHTML = '<option value="">Earlier versions</option>' + vers().map((v, i) => `<option value="${i}">${E(new Date(v.at).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }))} · ${E(v.label)}</option>`).join(""); }
  paintVers();
  $("#lg-hist").addEventListener("change", (e) => { const v = vers()[+e.target.value]; e.target.value = ""; if (!v) return; keepVersion("before restoring"); el("draft").value = v.text; save(); verify(); say("Restored that version"); });

  /* ---------- AI: draft / revise / review / ask ---------- */
  async function callAI(body, btn, msgEl, wait) {
    if (!tok()) { toast("Sign in first — it is free."); location.hash = "#community"; return null; }
    btn.classList.add("busy"); msgEl.textContent = wait;
    const t0 = Date.now(); const tick = setInterval(() => { msgEl.textContent = wait + " (" + Math.round((Date.now() - t0) / 1000) + "s)"; }, 1000);
    try {
      const r = await fetch("/api/legal", { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer " + tok() }, body: JSON.stringify(body) });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || !j.text) { msgEl.textContent = j.error === "limit" && j.message ? j.message : j.error === "busy" ? "The AI is busy right now. Wait a minute and try again." : j.error === "sign_in" ? "Sign in first." : "Couldn't finish. Try again."; return null; }
      msgEl.textContent = "Done."; return j.text;
    } catch (_) { msgEl.textContent = "Couldn't connect. Check your internet and try again."; return null; }
    finally { clearInterval(tick); btn.classList.remove("busy"); }
  }
  $("#lg-go").addEventListener("click", async (e) => {
    const o = read();
    if (!o.facts.trim()) { $("#lg-go-msg").textContent = "Fill in step 2 (what happened) first."; el("facts").focus(); return; }
    if (!o.relief.trim()) { $("#lg-go-msg").textContent = "Say what you want the court to do (step 2)."; el("relief").focus(); return; }
    const cid = store.cur;
    const t = await callAI({ mode: "draft", docType: o.doc, case: caseObj(), facts: o.facts, relief: o.relief, issues: o.issues, instructions: o.instructions, research: chosen() }, e.currentTarget, $("#lg-go-msg"), "Meechie's AI is writing your " + o.doc + "... this can take a minute");
    if (t && store.cur !== cid) { saveToCase(cid, t, "before new draft"); return; }
    if (t) { keepVersion("before new draft"); el("draft").value = t; keepVersion("AI draft: " + o.doc); save(); $("#lg-ver").innerHTML = ""; $("#lg-fact-out").hidden = true; $("#lg-draft-card").scrollIntoView({ behavior: "smooth", block: "start" }); verify(); }
  });
  $("#lg-revise").addEventListener("click", async (e) => {
    const ins = $("#lg-rev-ins").value.trim(); if (!ins) { $("#lg-tools-msg").textContent = "Type what to change, then tap Revise."; $("#lg-rev-ins").focus(); return; }
    if (!el("draft").value.trim()) { $("#lg-tools-msg").textContent = "Draft a document first."; return; }
    const cid = store.cur;
    const t = await callAI({ mode: "revise", case: caseObj(), draft: el("draft").value, instructions: ins, research: chosen() }, e.currentTarget, $("#lg-tools-msg"), "Revising...");
    if (t && store.cur !== cid) { saveToCase(cid, t, "before revise"); return; }
    if (t) { keepVersion("before revise"); el("draft").value = t; keepVersion("revised: " + ins.slice(0, 30)); $("#lg-rev-ins").value = ""; save(); verify(); }
  });
  $("#lg-suggest").addEventListener("click", async (e) => {
    const o = read(); if (!o.facts.trim()) { $("#lg-sug-msg").textContent = "Fill in step 2 (what happened) first."; el("facts").focus(); return; }
    const options = Object.values(DOCS).flat().join("; ");
    const t = await callAI({ mode: "suggest", case: caseObj(), facts: o.facts, relief: o.relief, options }, e.currentTarget, $("#lg-sug-msg"), "Thinking about your case...");
    if (!t) return;
    const all = Object.values(DOCS).flat(), box = $("#lg-sug"); box.innerHTML = "";
    t.split("\n").map((l) => l.trim()).filter(Boolean).forEach((l) => {
      const m = l.match(/^DOCUMENT:\s*(.+?)\s*\|\s*WHY:\s*(.+?)(?:\s*\|\s*TIMING:\s*(.+))?$/i);
      const d = document.createElement("div"); d.className = "info";
      if (m) { const name = all.find((x) => x.toLowerCase() === m[1].toLowerCase()) || all.find((x) => x.toLowerCase().includes(m[1].toLowerCase().slice(0, 18))); d.innerHTML = `<span>📄</span><span><b>${E(m[1])}</b> — ${E(m[2])}${m[3] ? `<br><small>⏰ ${E(m[3])}</small>` : ""}${name ? `<br><button class="btn sm" type="button" data-pick="${E(name)}" style="margin-top:6px">Use this</button>` : ""}</span>`; }
      else d.innerHTML = `<span>💡</span><span>${E(l.replace(/^ALSO:\s*/i, ""))}</span>`;
      box.appendChild(d);
    });
  });
  $("#lg-sug").addEventListener("click", (e) => { const b = e.target.closest("[data-pick]"); if (!b) return; el("doc").value = b.dataset.pick; save(); $("#lg-q").value = ""; say("Picked: " + b.dataset.pick); $("#lg-find").click(); });

  // second opinion on every legal statement (uses Claude when the owner has connected it)
  $("#lg-fact").addEventListener("click", async (e) => { const btn = e.currentTarget;
    if (!el("draft").value.trim()) { $("#lg-tools-msg").textContent = "Draft or paste a document first."; return; }
    if (!$("#lg-ver").children.length) await verify();
    const checks = [...viewRoot.querySelectorAll("#lg-ver div")].map((d) => d.textContent.replace(/\s+/g, " ").trim()).join("\n");
    const t = await callAI({ mode: "factcheck", case: caseObj(), draft: el("draft").value, checks, research: chosen() }, btn, $("#lg-tools-msg"), "Double-checking every legal statement...");
    if (t) { const o = $("#lg-fact-out"); o.hidden = false; o.textContent = t; o.scrollIntoView({ behavior: "smooth", block: "nearest" }); }
  });
  $("#lg-check").addEventListener("click", async (e) => {
    if (!el("draft").value.trim()) { $("#lg-tools-msg").textContent = "Draft or paste a document first."; return; }
    const t = await callAI({ mode: "review", case: caseObj(), draft: el("draft").value, research: chosen() }, e.currentTarget, $("#lg-tools-msg"), "Reviewing your document...");
    if (t) { $("#lg-review").hidden = false; $("#lg-review").textContent = t; }
  });
  $("#lg-ask-go").addEventListener("click", async (e) => { const btn = e.currentTarget;
    const q = $("#lg-ask").value.trim(); if (!q) { $("#lg-ask-msg").textContent = "Type your question."; return; }
    let research = [];
    try { const st = el("state").value, c = COURTS[st]; const res = await clSearch(q.slice(0, 120), ["scotus", c ? c[0] + " " + c[1] : ""].join(" ").trim()); research = res.filter((x) => x.citation && x.citation.length).slice(0, 6).map((x) => ({ name: clean(x.caseName), cite: pickCite(x.citation), court: x.court_citation_string || "", year: String(x.dateFiled || "").slice(0, 4), snippet: clean(x.syllabus || "").slice(0, 300), url: CL + x.absolute_url })); } catch (_) {}
    const t = await callAI({ mode: "ask", question: q, case: caseObj(), research }, btn, $("#lg-ask-msg"), "Looking into it...");
    if (t) { const out = $("#lg-ask-out"); out.hidden = false; out.textContent = t + (research.length ? "\n\nCases found:\n" + research.map((r, i) => "[" + (i + 1) + "] " + r.name + ", " + r.cite + " — " + r.url).join("\n") : ""); }
  });

  /* ---------- verify citations against the court database ---------- */
  const CITE_RE = /\b(\d{1,4})\s+(U\.\s?S\.|S\.\s?Ct\.|L\.\s?Ed\.(?:\s?2d)?|F\.(?:\s?(?:2d|3d|4th))?|F\.\s?Supp\.(?:\s?(?:2d|3d))?|F\.\s?App'?x|S\.E\.(?:2d)?|N\.E\.(?:2d|3d)?|N\.W\.(?:2d)?|S\.W\.(?:2d|3d)?|So\.(?:\s?(?:2d|3d))?|A\.(?:2d|3d)?|P\.(?:2d|3d)?|Cal\.\s?Rptr\.(?:\s?(?:2d|3d))?|N\.Y\.S\.(?:2d|3d)?|W\.\s?Va\.|Md\.|Pa\.|Va\.)\s+(\d{1,5})\b/g;
  const STAT_RE = /\b(\d{1,2})\s+U\.S\.C\.?\s*§+\s*([\d\w.-]+)/g;
  async function verify() {
    const g = ++vgen;
    const text = el("draft").value, box = $("#lg-ver"); box.innerHTML = "";
    const cites = [...new Set([...text.matchAll(CITE_RE)].map((m) => (m[1] + " " + m[2].replace(/\s+/g, " ") + " " + m[3]).replace(/\s+/g, " ")))].slice(0, 25);
    const stats = [...new Set([...text.matchAll(STAT_RE)].map((m) => m[1] + "|" + m[2].replace(/[.,;:]$/, "")))].slice(0, 15);
    const need = (text.match(/\[CITATION NEEDED[^\]]*\]/gi) || []).length, holes = [...new Set(text.match(/\[[A-Z][A-Z0-9 ,'/&-]{2,60}\]/g) || [])].filter((x) => !/CITATION NEEDED|VERIFY HOLDING/i.test(x));
    if (!cites.length && !stats.length) box.innerHTML = '<div class="info">No case citations found in the document to check.</div>';
    for (const c of cites) {
      const row = document.createElement("div"); row.className = "info"; row.innerHTML = `<span>⏳</span><span><b>${E(c)}</b> — checking the court database...</span>`; box.appendChild(row);
      try {
        const j = await fetch(CL + "/api/rest/v4/search/?type=o&q=" + encodeURIComponent('citation:("' + c + '")')).then((r) => { if (!r.ok) throw new Error("http " + r.status); return r.json(); });
        if (g !== vgen) return;
        const hit = j.results && j.results[0];
        if (hit) {
          // what case name did the document put next to this citation?
          const at = text.indexOf(c.split(" ")[0] + " " + c.split(" ")[1]); const before = text.slice(Math.max(0, at - 140), at);
          const realName = clean(hit.caseName), first = realName.split(/\s+v\.?\s+/i)[0].split(/[\s,]+/).filter((w) => w.length > 2 && !/^(the|state|united|states|people|of|in|re|ex|rel|commonwealth|city|county)$/i.test(w))[0] || "";
          const nameOk = !first || new RegExp(first.replace(/[^\w]/g, ""), "i").test(before);
          row.className = nameOk ? "ok" : "bad";
          row.innerHTML = `<span>${nameOk ? "✅" : "⚠️"}</span><span><b>${E(c)}</b> is real: <a href="${E(CL + hit.absolute_url)}" target="_blank" rel="noopener">${E(realName)}</a> (${E(hit.court_citation_string || hit.court || "")} ${E(String(hit.dateFiled || "").slice(0, 4))}).${nameOk ? " Read it to make sure it says what your document says." : " But the case name in your document doesn't match. Fix the name or the citation."}</span>`;
        } else { row.className = "bad"; row.innerHTML = `<span>❌</span><span><b>${E(c)}</b> NOT FOUND in the court database. It may be wrong or made up. Look it up before filing, or remove it.</span>`; }
      } catch (_) { if (g !== vgen) return; row.innerHTML = `<span>❔</span><span><b>${E(c)}</b> couldn't be checked right now. Try Verify again.</span>`; }
      await new Promise((r) => setTimeout(r, 250)); if (g !== vgen) return;
    }
    // every quote next to a citation: is that exact wording really in that case?
    const quotes = [];
    for (const c of cites) {
      const reC = new RegExp(c.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/ /g, "\\s+"), "g"); let m;
      while ((m = reC.exec(text))) {
        const win = text.slice(Math.max(0, m.index - 420), Math.min(text.length, m.index + 260));
        for (const q of win.matchAll(/[“"]([^”"]{25,400})[”"]/g)) { const w = q[1].replace(/[^\w\s'-]/g, " ").split(/\s+/).filter(Boolean); if (w.length >= 5) quotes.push({ cite: c, quote: q[1], probe: w.slice(1, 10).join(" ") }); }
      }
    }
    const seenQ = new Set();
    for (const q of quotes.filter((q) => !seenQ.has(q.probe) && seenQ.add(q.probe)).slice(0, 15)) {
      const row = document.createElement("div"); row.className = "info"; row.innerHTML = `<span>⏳</span><span>Checking the quote “${E(q.quote.slice(0, 80))}…”</span>`; box.appendChild(row);
      try {
        const j = await fetch(CL + "/api/rest/v4/search/?type=o&q=" + encodeURIComponent('"' + q.probe + '" AND citation:("' + q.cite + '")')).then((r) => { if (!r.ok) throw new Error("http " + r.status); return r.json(); });
        if (g !== vgen) return;
        if (j.count > 0) { row.className = "ok"; row.innerHTML = `<span>✅</span><span>Quote found word for word in ${E(q.cite)}: “${E(q.quote.slice(0, 120))}${q.quote.length > 120 ? "…" : ""}”</span>`; }
        else { row.className = "bad"; row.innerHTML = `<span>❌</span><span><b>Quote NOT IN THE CASE</b> ${E(q.cite)}: “${E(q.quote.slice(0, 120))}${q.quote.length > 120 ? "…" : ""}”. Those words aren't in that opinion. Remove the quote marks and describe the case in your own words, or find the real wording.</span>`; }
      } catch (_) { if (g !== vgen) return; row.innerHTML = `<span>❔</span><span>Couldn't check the quote “${E(q.quote.slice(0, 60))}…” right now.</span>`; }
      await new Promise((r) => setTimeout(r, 300)); if (g !== vgen) return;
    }
    const vh = (text.match(/\[VERIFY HOLDING\]/gi) || []).length;
    if (vh) { const row = document.createElement("div"); row.className = "bad"; row.innerHTML = `<span>📖</span><span>${vh} case${vh > 1 ? "s are" : " is"} marked [VERIFY HOLDING]. Open each case and make sure it really says what your document says, then delete the mark.</span>`; box.appendChild(row); }
    for (const s of stats) { const [t, sec] = s.split("|"); const row = document.createElement("div"); row.className = "info"; row.innerHTML = `<span>📘</span><span><b>${E(t)} U.S.C. § ${E(sec)}</b> — <a href="https://www.law.cornell.edu/uscode/text/${E(t)}/${E(sec.replace(/\(.*$/, ""))}" target="_blank" rel="noopener">read the law</a> to check it says what your document says.</span>`; box.appendChild(row); }
    if (need) { const row = document.createElement("div"); row.className = "bad"; row.innerHTML = `<span>📝</span><span>${need} spot${need > 1 ? "s" : ""} marked [CITATION NEEDED]. Use "Find real case law" above, or remove the point.</span>`; box.appendChild(row); }
    if (holes.length) { const row = document.createElement("div"); row.className = "bad"; row.innerHTML = `<span>✏️</span><span>Fill in before filing: ${holes.slice(0, 20).map(E).join(", ")}</span>`; box.appendChild(row); }
  }
  $("#lg-verify").addEventListener("click", verify);

  /* ---------- copy / PDF / print ---------- */
  const body = () => el("draft").value.split(/\n-{3,}\s*NOTES FOR YOU[\s\S]*$/i)[0].trim();
  $("#lg-copy").addEventListener("click", () => navigator.clipboard?.writeText(body()).then(() => say("Copied (without the notes)")).catch(() => say("Select the text and copy it")));
  function loadPdfLib() { return window.jspdf ? Promise.resolve() : new Promise((res, rej) => { const s = document.createElement("script"); s.src = "https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js"; s.onload = res; s.onerror = rej; document.head.appendChild(s); }); }
  $("#lg-pdf").addEventListener("click", async () => {
    const txt = body(); if (!txt) { say("Draft a document first."); return; }
    try { await loadPdfLib(); } catch (_) { say("Couldn't load the PDF maker. Use Print instead."); return; }
    const { jsPDF } = window.jspdf; const doc = new jsPDF({ unit: "pt", format: "letter" });
    const M = 72, W = 612 - 2 * M, H = 792, dbl = $("#lg-dbl").checked; doc.setFont("times", "normal"); doc.setFontSize(12);
    let y = M, page = 1;
    const foot = () => { doc.setFontSize(10); doc.text(String(page), 306, H - 36, { align: "center" }); doc.setFontSize(12); };
    const lines = txt.split("\n");
    let inCaption = true;
    for (const raw of lines) {
      const line = raw.replace(/\t/g, "    ");
      if (inCaption && /^(INTRODUCTION|STATEMENT OF FACTS|COMES NOW|NOW COMES|I\.\s)/i.test(line.trim())) inCaption = false;
      const lh = inCaption || !dbl ? 15 : 26;
      const centered = line.trim() && line.trim() === line.trim().toUpperCase() && line.trim().length < 70 && /[A-Z]/.test(line);
      const wrapped = line.trim() ? doc.splitTextToSize(line.trim(), W) : [""];
      for (const w of wrapped) {
        if (y > H - M) { foot(); doc.addPage(); page++; y = M; }
        doc.setFont("times", centered ? "bold" : "normal");
        if (centered) doc.text(w, 306, y, { align: "center" }); else doc.text(w, M, y);
        y += w ? lh : lh * 0.6;
      }
    }
    foot();
    doc.save(((el("doc").value || "document").replace(/[^\w]+/g, "-").replace(/-+$/, "")) + ".pdf");
  });
  $("#lg-print").addEventListener("click", () => {
    const txt = body(); if (!txt) { say("Draft a document first."); return; }
    const w = window.open("", "_blank"); if (!w) { say("Allow pop-ups to print."); return; }
    w.document.write(`<!doctype html><meta charset="utf-8"><title>${E(el("doc").value)}</title><style>body{font:12pt/2 "Times New Roman",Times,serif;margin:1in;white-space:pre-wrap;color:#000}@page{margin:1in}</style><body>${E(txt)}</body>`);
    w.document.close(); w.focus(); setTimeout(() => w.print(), 300);
  });
  /* ---------- paid document preparation: $20 case processing + $20 per delivered document ---------- */
  $("#lg-hire-go").addEventListener("click", async (e) => { const btn = e.currentTarget;
    const msg = $("#lg-hire-msg"), o = read(), n = +$("#lg-hire-n").value || 1, how = $("#lg-hire-how").value.trim();
    if (!tok()) { toast("Sign in first — it is free."); location.hash = "#community"; return; }
    if (!how) { msg.textContent = "Add the best way to reach you."; $("#lg-hire-how").focus(); return; }
    if (!o.facts.trim()) { msg.textContent = "Fill in step 2 (what happened) so Meechie knows the case."; el("facts").focus(); return; }
    const deliveryTotal = n * 20, requestTotal = 20 + deliveryTotal;
    const lines = ["⚖️ LEGAL DOCUMENT REQUEST — " + n + " document" + (n > 1 ? "s" : "") + " (estimated total $" + requestTotal + ")",
      "Fee stages: $20 case-processing fee after intake; $20 per document ($" + deliveryTotal + " delivery total) when the prepared document is ready.",
      "Document: " + o.doc, o.name && "Name: " + o.name + (o.role ? " (" + o.role + ")" : ""),
      [o.court, o.county, o.state].filter(Boolean).length && "Court: " + [o.court, o.county, o.state].filter(Boolean).join(", ") + " (" + o.system + ")",
      o.caseNo && "Case no.: " + o.caseNo, o.judge && "Judge: " + o.judge, o.other && "Other side: " + o.other + (o.otherCounsel ? " — " + o.otherCounsel : ""),
      o.charges && "Charges/claims: " + o.charges, o.status && "Status: " + o.status, "Reach me: " + how,
      "", "WHAT HAPPENED:", o.facts.trim().slice(0, 2500), "", "WANTS THE COURT TO: " + o.relief.trim().slice(0, 600),
      o.issues && "ISSUES: " + o.issues.trim().slice(0, 500), $("#lg-hire-note").value.trim() && "NOTE: " + $("#lg-hire-note").value.trim().slice(0, 600)].filter(Boolean).join("\n").slice(0, 4800);
    btn.classList.add("busy"); msg.textContent = "Sending...";
    try {
      /* the request goes to Meechie as a private message — the
         v2 door is the same dms table the Messages view runs on
         (the live file's MW.sb path is a dead Supabase trace) */
      const { error } = await ctx.gateway.call("rest", { table: "dms", op: "insert", values: { recipient: OWNER_ID, body: lines } });
      if (error) throw new Error(error.message || "Couldn't send. Try again.");
      msg.textContent = "Request sent privately. The intended fees are $20 to process your case, then $20 per document when it is ready. No payment was collected here; secure checkout must be connected before either fee can be charged.";
    } catch (err) { msg.textContent = (err && err.message) || "Couldn't send. Try again."; }
    finally { btn.classList.remove("busy"); }
  });
  /* Fee preview: one case-processing fee plus a delivery fee for each document. */
  const feeCount = $("#lg-hire-n"), feeTotal = $("#lg-fee-total"), feeBreakdown = $("#lg-fee-breakdown");
  function updateLegalFeePreview() {
    if (!feeCount || !feeTotal || !feeBreakdown) return;
    const count = Math.max(1, Math.min(5, Number(feeCount.value) || 1));
    const delivery = count * 20, total = 20 + delivery;
    feeTotal.textContent = "$" + total;
    feeBreakdown.textContent = "$20 processing + $" + delivery + " for " + count + " document" + (count === 1 ? "" : "s");
  }
  feeCount?.addEventListener("change", updateLegalFeePreview);
  updateLegalFeePreview();

}
export function destroy() {}
