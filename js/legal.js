/* Legal Help: tools for people representing themselves (pro se).
 *  1. Your case (kept only on this device — never posted to the site)
 *  2. What happened + what you want the court to do
 *  3. Pick the document -> find real case law (CourtListener, free) -> Meechie's AI drafts it (/api/legal)
 *  4. Verify every citation against the court database, AI review, revise, download a court-format PDF
 * Legal document preparation, not legal advice. */
(function () {
  const view = document.getElementById("v-legal"); if (!view) return;
  const $ = (s) => view.querySelector(s);
  const E = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const CL = "https://www.courtlistener.com";
  const KEY = "mw_legal_case_v1";
  const tok = () => (window.MW && MW.session && MW.session() && MW.session().access_token) || "";
  const say = (t) => (typeof toast === "function" ? toast(t) : alert(t));

  const DOCS = {
    "Criminal": ["Motion to Dismiss", "Motion to Suppress Evidence", "Motion for Discovery / Brady Material", "Motion to Compel Discovery", "Motion for Bond Reduction / Pretrial Release", "Motion for Speedy Trial", "Motion to Dismiss for Speedy Trial Violation", "Motion for Continuance", "Motion in Limine", "Motion for a Bill of Particulars", "Motion for Appointment of New Counsel", "Motion to Withdraw Guilty Plea", "Motion for Reconsideration of Sentence", "Motion for Sentence Reduction", "Motion for Judgment of Acquittal", "Motion for New Trial"],
    "Post-conviction & appeals": ["Petition for Writ of Habeas Corpus", "Motion to Vacate Sentence (28 U.S.C. § 2255)", "Notice of Appeal", "Motion for Extension of Time to File Appeal", "Petition for Writ of Mandamus", "Motion for Expungement / Record Sealing"],
    "Civil & civil rights": ["Civil Rights Complaint (42 U.S.C. § 1983)", "Complaint (general civil)", "Answer to Complaint", "Motion to Dismiss (civil)", "Motion for Summary Judgment", "Response in Opposition to Motion", "Motion for Default Judgment", "Motion to Proceed In Forma Pauperis (fee waiver)", "Motion for Appointment of Counsel", "Motion for Preliminary Injunction / TRO", "Small Claims Complaint", "Answer to Eviction / Unlawful Detainer"],
    "Family": ["Petition for Custody / Visitation", "Motion to Modify Child Support", "Petition for Protective Order Response", "Motion for Contempt"],
    "Other papers": ["Affidavit / Sworn Declaration", "Letter to the Judge", "Letter to the Clerk of Court", "Prison Grievance", "Notice of Change of Address", "Certificate of Service", "Freedom of Information / Records Request", "Other (describe in instructions)"],
  };
  // CourtListener court ids: [state high court(s), federal circuit]
  const COURTS = { Alabama: ["ala", "ca11"], Alaska: ["alaska", "ca9"], Arizona: ["ariz", "ca9"], Arkansas: ["ark", "ca8"], California: ["cal", "ca9"], Colorado: ["colo", "ca10"], Connecticut: ["conn", "ca2"], Delaware: ["del", "ca3"], "District of Columbia": ["dc", "cadc"], Florida: ["fla", "ca11"], Georgia: ["ga", "ca11"], Hawaii: ["haw", "ca9"], Idaho: ["idaho", "ca9"], Illinois: ["ill", "ca7"], Indiana: ["ind", "ca7"], Iowa: ["iowa", "ca8"], Kansas: ["kan", "ca10"], Kentucky: ["ky", "ca6"], Louisiana: ["la", "ca5"], Maine: ["me", "ca1"], Maryland: ["md", "ca4"], Massachusetts: ["mass", "ca1"], Michigan: ["mich", "ca6"], Minnesota: ["minn", "ca8"], Mississippi: ["miss", "ca5"], Missouri: ["mo", "ca8"], Montana: ["mont", "ca9"], Nebraska: ["neb", "ca8"], Nevada: ["nev", "ca9"], "New Hampshire": ["nh", "ca1"], "New Jersey": ["nj", "ca3"], "New Mexico": ["nm", "ca10"], "New York": ["ny", "ca2"], "North Carolina": ["nc", "ca4"], "North Dakota": ["nd", "ca8"], Ohio: ["ohio", "ca6"], Oklahoma: ["okla oklacrimapp", "ca10"], Oregon: ["or", "ca9"], Pennsylvania: ["pa pasuperct", "ca3"], "Rhode Island": ["ri", "ca1"], "South Carolina": ["sc", "ca4"], "South Dakota": ["sd", "ca8"], Tennessee: ["tenn tenncrimapp", "ca6"], Texas: ["tex texcrimapp", "ca5"], Utah: ["utah", "ca10"], Vermont: ["vt", "ca2"], Virginia: ["va", "ca4"], Washington: ["wash", "ca9"], "West Virginia": ["wva", "ca4"], Wisconsin: ["wis", "ca7"], Wyoming: ["wyo", "ca10"] };

  const css = document.createElement("style");
  css.textContent = `
#v-legal .lg-warn{border:1px solid var(--gold-lo);background:rgba(147,180,255,.06);border-radius:14px;padding:14px 16px;font-size:14px;margin-bottom:16px}
#v-legal .lg-steps{display:grid;gap:16px}
#v-legal .lg-card{background:var(--panel);border:1px solid var(--line);border-radius:16px;padding:18px}
#v-legal .lg-card h3{margin:0 0 4px;font-size:19px;display:flex;align-items:center;gap:10px}
#v-legal .lg-card h3 .n{display:inline-grid;place-items:center;width:28px;height:28px;border-radius:50%;background:var(--gold);color:#0b0a08;font:800 14px var(--body)}
#v-legal .lg-card>p{margin:0 0 12px;color:var(--muted);font-size:14px}
#v-legal .lg-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:12px}
#v-legal label{display:grid;gap:5px;font-size:13px;font-weight:600}
#v-legal label small{font-weight:400;color:var(--muted)}
#v-legal input,#v-legal select,#v-legal textarea{font:15px var(--body);padding:10px 11px;border-radius:10px;border:1px solid var(--line);background:var(--ink);color:var(--text);width:100%}
#v-legal textarea{resize:vertical;line-height:1.5}
#v-legal .full{grid-column:1/-1}
#v-legal .acts{display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-top:12px}
#v-legal .lg-msg{font-size:14px;color:var(--gold-hi)}
#v-legal .lg-res{display:grid;gap:8px;margin-top:10px;max-height:420px;overflow:auto}
#v-legal .lg-res label{display:flex;gap:10px;align-items:flex-start;font-weight:500;background:var(--ink);border:1px solid var(--line);border-radius:10px;padding:10px}
#v-legal .lg-res input{width:auto;margin-top:3px}
#v-legal .lg-res b{display:block}#v-legal .lg-res small{color:var(--muted)}
#v-legal #lg-draft{min-height:520px;font:15px/1.6 "Times New Roman",Times,serif;background:#fbf8f1;color:#111;border-color:#c9b98f}
#v-legal .lg-ver{display:grid;gap:6px;margin-top:10px}
#v-legal .lg-ver div{display:flex;gap:10px;align-items:flex-start;padding:9px 11px;border-radius:10px;border:1px solid var(--line);background:var(--ink);font-size:14px}
#v-legal .lg-ver .ok{border-color:#2f7d4a}#v-legal .lg-ver .bad{border-color:#a2412f}#v-legal .lg-ver .info{border-color:var(--gold-lo)}
#v-legal .lg-out{white-space:pre-wrap;background:var(--ink);border:1px solid var(--line);border-radius:12px;padding:14px;font-size:14px;line-height:1.55;margin-top:10px}
#v-legal .lg-links{display:grid;grid-template-columns:repeat(auto-fit,minmax(230px,1fr));gap:10px}
#v-legal .lg-links a{display:block;padding:12px 14px;border:1px solid var(--line);border-radius:12px;background:var(--ink);text-decoration:none;color:var(--text)}
#v-legal .lg-links a b{color:var(--gold-hi);display:block}#v-legal .lg-links a small{color:var(--muted)}
#v-legal .busy{opacity:.6;pointer-events:none}`;
  document.head.appendChild(css);

  // fill the pickers
  $("#lg-doc").innerHTML = Object.entries(DOCS).map(([g, list]) => `<optgroup label="${E(g)}">${list.map((d) => `<option>${E(d)}</option>`).join("")}</optgroup>`).join("");
  $("#lg-state").innerHTML = '<option value="">Pick a state</option>' + Object.keys(COURTS).map((s) => `<option>${E(s)}</option>`).join("");

  /* ---------- the case file: saved only on this device ---------- */
  const FIELDS = ["system", "state", "county", "court", "caseNo", "type", "judge", "name", "role", "other", "otherCounsel", "charges", "status", "address", "contact", "facts", "relief", "issues", "instructions", "doc", "draft"];
  const el = (k) => view.querySelector(`[data-k="${k}"]`);
  function read() { const o = {}; FIELDS.forEach((k) => { const x = el(k); if (x) o[k] = x.value; }); return o; }
  function write(o) { FIELDS.forEach((k) => { const x = el(k); if (x && o && o[k] != null) x.value = o[k]; }); }
  function save() { try { localStorage.setItem(KEY, JSON.stringify(read())); } catch (_) {} }
  try { const o = JSON.parse(localStorage.getItem(KEY) || "null"); if (o) write(o); } catch (_) {}
  let st = 0; view.addEventListener("input", () => { clearTimeout(st); st = setTimeout(save, 400); });
  const caseObj = () => { const o = read(); return { system: o.system, state: o.state, county: o.county, court: o.court, caseNo: o.caseNo, type: o.type, judge: o.judge, name: o.name, role: o.role, other: o.other, otherCounsel: o.otherCounsel, charges: o.charges, status: o.status, address: o.address, contact: o.contact }; };

  $("#lg-export").addEventListener("click", () => {
    const blob = new Blob([JSON.stringify({ meechiesWorldCase: 1, savedAt: new Date().toISOString(), ...read() }, null, 2)], { type: "application/json" });
    const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = "my-case-" + (el("caseNo").value || "file").replace(/[^\w-]+/g, "_") + ".json"; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  });
  $("#lg-import").addEventListener("change", async (e) => {
    const f = e.target.files[0]; e.target.value = ""; if (!f) return;
    try { const o = JSON.parse(await f.text()); write(o); save(); say("Case file opened"); } catch (_) { say("That file isn't a saved case file."); }
  });
  $("#lg-clear").addEventListener("click", (e) => {
    const b = e.currentTarget; if (!b.dataset.sure) { b.dataset.sure = "1"; b.textContent = "Tap again to erase"; setTimeout(() => { delete b.dataset.sure; b.textContent = "Start a new case"; }, 3000); return; }
    FIELDS.forEach((k) => { const x = el(k); if (x && x.tagName !== "SELECT") x.value = ""; }); save(); delete b.dataset.sure; b.textContent = "Start a new case"; $("#lg-res").innerHTML = ""; $("#lg-ver").innerHTML = ""; $("#lg-review").hidden = true;
  });

  /* ---------- case law research (CourtListener) ---------- */
  let found = [];
  const clean = (t) => String(t || "").replace(/<\/?mark>/g, "").replace(/\s+/g, " ").trim();
  async function clSearch(q, courts) {
    const u = CL + "/api/rest/v4/search/?type=o&order_by=score%20desc&q=" + encodeURIComponent(q) + (courts ? "&court=" + encodeURIComponent(courts) : "");
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
      url: CL + x.absolute_url, snippet: clean(x.syllabus || (x.opinions && x.opinions[0] && x.opinions[0].snippet) || "").slice(0, 300), cited: x.citeCount || 0 }));
    if (!found.length) { msg.textContent = "No published cases matched. Try fewer, simpler words."; box.innerHTML = ""; return; }
    msg.textContent = found.length + " real cases found. Check the ones to give the AI, then draft. Tap a name to read the case.";
    box.innerHTML = found.map((f, i) => `<label><input type="checkbox" data-i="${i}" ${i < 6 ? "checked" : ""}><span><b><a href="${E(f.url)}" target="_blank" rel="noopener">${E(f.name)}</a></b><small>${E(f.cite)} · ${E(f.court)} ${E(f.year)}${f.cited ? " · cited " + f.cited + " times" : ""}</small>${f.snippet ? `<small style="display:block;margin-top:4px">${E(f.snippet)}</small>` : ""}</span></label>`).join("");
  });
  function pickCite(list) { // prefer official reporters
    const order = [/ U\.S\. /, / S\. ?Ct\. /, / F\.4th /, / F\.3d /, / F\.2d /, / F\. Supp/, / S\.E\.2d /, / N\.E\.2d /, / N\.W\.2d /, / A\.3d /, / A\.2d /, / P\.3d /, / So\. ?3d /, / S\.W\.3d /];
    for (const re of order) { const c = list.find((x) => re.test(" " + x + " ")); if (c) return c; }
    return list.find((x) => !/LEXIS|WL/.test(x)) || list[0];
  }
  const chosen = () => [...view.querySelectorAll("#lg-res input:checked")].map((x) => found[+x.dataset.i]).filter(Boolean);

  /* ---------- AI: draft / revise / review / ask ---------- */
  async function callAI(body, btn, msgEl, wait) {
    if (!tok()) { if (typeof openAuth === "function") openAuth("signin"); return null; }
    btn.classList.add("busy"); msgEl.textContent = wait;
    const t0 = Date.now(); const tick = setInterval(() => { msgEl.textContent = wait + " (" + Math.round((Date.now() - t0) / 1000) + "s)"; }, 1000);
    try {
      const r = await fetch("/api/legal", { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer " + tok() }, body: JSON.stringify(body) });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || !j.text) { msgEl.textContent = j.error === "busy" ? "The AI is busy right now. Wait a minute and try again." : j.error === "sign_in" ? "Sign in first." : "Couldn't finish. Try again."; return null; }
      msgEl.textContent = "Done."; return j.text;
    } catch (_) { msgEl.textContent = "Couldn't connect. Check your internet and try again."; return null; }
    finally { clearInterval(tick); btn.classList.remove("busy"); }
  }
  $("#lg-go").addEventListener("click", async (e) => {
    const o = read();
    if (!o.facts.trim()) { $("#lg-go-msg").textContent = "Fill in step 2 (what happened) first."; el("facts").focus(); return; }
    if (!o.relief.trim()) { $("#lg-go-msg").textContent = "Say what you want the court to do (step 2)."; el("relief").focus(); return; }
    const t = await callAI({ mode: "draft", docType: o.doc, case: caseObj(), facts: o.facts, relief: o.relief, issues: o.issues, instructions: o.instructions, research: chosen() }, e.currentTarget, $("#lg-go-msg"), "Meechie's AI is writing your " + o.doc + "... this can take a minute");
    if (t) { el("draft").value = t; save(); $("#lg-ver").innerHTML = ""; $("#lg-draft-card").scrollIntoView({ behavior: "smooth", block: "start" }); verify(); }
  });
  $("#lg-revise").addEventListener("click", async (e) => {
    const ins = $("#lg-rev-ins").value.trim(); if (!ins) { $("#lg-tools-msg").textContent = "Type what to change, then tap Revise."; $("#lg-rev-ins").focus(); return; }
    if (!el("draft").value.trim()) { $("#lg-tools-msg").textContent = "Draft a document first."; return; }
    const t = await callAI({ mode: "revise", case: caseObj(), draft: el("draft").value, instructions: ins, research: chosen() }, e.currentTarget, $("#lg-tools-msg"), "Revising...");
    if (t) { el("draft").value = t; $("#lg-rev-ins").value = ""; save(); verify(); }
  });
  $("#lg-check").addEventListener("click", async (e) => {
    if (!el("draft").value.trim()) { $("#lg-tools-msg").textContent = "Draft or paste a document first."; return; }
    const t = await callAI({ mode: "review", case: caseObj(), draft: el("draft").value, research: chosen() }, e.currentTarget, $("#lg-tools-msg"), "Reviewing your document...");
    if (t) { $("#lg-review").hidden = false; $("#lg-review").textContent = t; }
  });
  $("#lg-ask-go").addEventListener("click", async (e) => {
    const q = $("#lg-ask").value.trim(); if (!q) { $("#lg-ask-msg").textContent = "Type your question."; return; }
    let research = [];
    try { const st = el("state").value, c = COURTS[st]; const res = await clSearch(q.slice(0, 120), ["scotus", c ? c[0] + " " + c[1] : ""].join(" ").trim()); research = res.filter((x) => x.citation && x.citation.length).slice(0, 6).map((x) => ({ name: clean(x.caseName), cite: pickCite(x.citation), court: x.court_citation_string || "", year: String(x.dateFiled || "").slice(0, 4), snippet: clean(x.syllabus || "").slice(0, 300), url: CL + x.absolute_url })); } catch (_) {}
    const t = await callAI({ mode: "ask", question: q, case: caseObj(), research }, e.currentTarget, $("#lg-ask-msg"), "Looking into it...");
    if (t) { const out = $("#lg-ask-out"); out.hidden = false; out.textContent = t + (research.length ? "\n\nCases found:\n" + research.map((r, i) => "[" + (i + 1) + "] " + r.name + ", " + r.cite + " — " + r.url).join("\n") : ""); }
  });

  /* ---------- verify citations against the court database ---------- */
  const CITE_RE = /\b(\d{1,4})\s+(U\.\s?S\.|S\.\s?Ct\.|L\.\s?Ed\.(?:\s?2d)?|F\.(?:\s?(?:2d|3d|4th))?|F\.\s?Supp\.(?:\s?(?:2d|3d))?|F\.\s?App'?x|S\.E\.(?:2d)?|N\.E\.(?:2d|3d)?|N\.W\.(?:2d)?|S\.W\.(?:2d|3d)?|So\.(?:\s?(?:2d|3d))?|A\.(?:2d|3d)?|P\.(?:2d|3d)?|Cal\.\s?Rptr\.(?:\s?(?:2d|3d))?|N\.Y\.S\.(?:2d|3d)?|W\.\s?Va\.|Md\.|Pa\.|Va\.)\s+(\d{1,5})\b/g;
  const STAT_RE = /\b(\d{1,2})\s+U\.S\.C\.?\s*§+\s*([\d\w.-]+)/g;
  async function verify() {
    const text = el("draft").value, box = $("#lg-ver"); box.innerHTML = "";
    const cites = [...new Set([...text.matchAll(CITE_RE)].map((m) => (m[1] + " " + m[2].replace(/\s+/g, " ") + " " + m[3]).replace(/\s+/g, " ")))].slice(0, 25);
    const stats = [...new Set([...text.matchAll(STAT_RE)].map((m) => m[1] + "|" + m[2].replace(/[.,;:]$/, "")))].slice(0, 15);
    const need = (text.match(/\[CITATION NEEDED[^\]]*\]/gi) || []).length, holes = [...new Set(text.match(/\[[A-Z][A-Z0-9 ,'/&-]{2,60}\]/g) || [])].filter((x) => !/CITATION NEEDED/i.test(x));
    if (!cites.length && !stats.length) box.innerHTML = '<div class="info">No case citations found in the document to check.</div>';
    for (const c of cites) {
      const row = document.createElement("div"); row.className = "info"; row.innerHTML = `<span>⏳</span><span><b>${E(c)}</b> — checking the court database...</span>`; box.appendChild(row);
      try {
        const j = await fetch(CL + "/api/rest/v4/search/?type=o&q=" + encodeURIComponent('citation:("' + c + '")')).then((r) => r.json());
        const hit = j.results && j.results[0];
        if (hit) {
          // what case name did the document put next to this citation?
          const at = text.indexOf(c.split(" ")[0] + " " + c.split(" ")[1]); const before = text.slice(Math.max(0, at - 140), at);
          const realName = clean(hit.caseName), first = realName.split(/\s+v\.?\s+/i)[0].split(/[\s,]+/).filter((w) => w.length > 2 && !/^(the|state|united|states|people|of|in|re|ex|rel|commonwealth|city|county)$/i.test(w))[0] || "";
          const nameOk = !first || new RegExp(first.replace(/[^\w]/g, ""), "i").test(before);
          row.className = nameOk ? "ok" : "bad";
          row.innerHTML = `<span>${nameOk ? "✅" : "⚠️"}</span><span><b>${E(c)}</b> is real: <a href="${E(CL + hit.absolute_url)}" target="_blank" rel="noopener">${E(realName)}</a> (${E(hit.court_citation_string || hit.court || "")} ${E(String(hit.dateFiled || "").slice(0, 4))}).${nameOk ? " Read it to make sure it says what your document says." : " But the case name in your document doesn't match. Fix the name or the citation."}</span>`;
        } else { row.className = "bad"; row.innerHTML = `<span>❌</span><span><b>${E(c)}</b> was not found in the court database. It may be wrong or made up. Look it up before filing, or remove it.</span>`; }
      } catch (_) { row.innerHTML = `<span>❔</span><span><b>${E(c)}</b> couldn't be checked right now. Try Verify again.</span>`; }
      await new Promise((r) => setTimeout(r, 250));
    }
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
  /* ---------- hire Meechie: $50 per document ---------- */
  $("#lg-hire-go").addEventListener("click", async (e) => {
    const msg = $("#lg-hire-msg"), o = read(), n = +$("#lg-hire-n").value || 1, how = $("#lg-hire-how").value.trim();
    if (!tok()) { if (typeof openAuth === "function") openAuth("signin"); return; }
    if (!how) { msg.textContent = "Add the best way to reach you."; $("#lg-hire-how").focus(); return; }
    if (!o.facts.trim()) { msg.textContent = "Fill in step 2 (what happened) so Meechie knows the case."; el("facts").focus(); return; }
    const lines = ["⚖️ LEGAL DOCUMENT REQUEST — " + n + " document" + (n > 1 ? "s" : "") + " ($" + n * 50 + ")",
      "Document: " + o.doc, o.name && "Name: " + o.name + (o.role ? " (" + o.role + ")" : ""),
      [o.court, o.county, o.state].filter(Boolean).length && "Court: " + [o.court, o.county, o.state].filter(Boolean).join(", ") + " (" + o.system + ")",
      o.caseNo && "Case no.: " + o.caseNo, o.judge && "Judge: " + o.judge, o.other && "Other side: " + o.other + (o.otherCounsel ? " — " + o.otherCounsel : ""),
      o.charges && "Charges/claims: " + o.charges, o.status && "Status: " + o.status, "Reach me: " + how,
      "", "WHAT HAPPENED:", o.facts.trim().slice(0, 2500), "", "WANTS THE COURT TO: " + o.relief.trim().slice(0, 600),
      o.issues && "ISSUES: " + o.issues.trim().slice(0, 500), $("#lg-hire-note").value.trim() && "NOTE: " + $("#lg-hire-note").value.trim().slice(0, 600)].filter(Boolean).join("\n").slice(0, 4800);
    e.currentTarget.classList.add("busy"); msg.textContent = "Sending...";
    try {
      const a = await MW.sb.from("admins").select("user_id").limit(1); const owner = a.data && a.data[0] && a.data[0].user_id;
      if (!owner) throw new Error("Couldn't reach Meechie right now.");
      const r = await MW.sb.from("dms").insert({ recipient: owner, body: lines }); if (r.error) throw r.error;
      try { window.MW_VISIT && MW_VISIT("contact"); } catch (_) {}
      const pay = view.querySelector('[data-pay="legal"]'); const canPay = pay && !pay.hidden && /^https:/.test(pay.href);
      msg.textContent = "Sent! Meechie will reach out." + (canPay ? " Tap Pay to pay $" + n * 50 + " (set the quantity to " + n + " at checkout)." : " He'll send you how to pay.");
    } catch (err) { msg.textContent = (err && err.message) || "Couldn't send. Try again."; }
    finally { e.currentTarget.classList.remove("busy"); }
  });
})();
