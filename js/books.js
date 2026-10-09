/* Books: Meechie's World Inc publications, readable on the site.
 * Owner uploads a PDF (or TXT) and it is turned into readable pages (stored as text, one doc per page group).
 * Docs: books/<id> = { title, author, blurb, cover, pages, free, order, createdAt }, bookpages/<id>_<n> = { book, n, html }
 * Protection: no selecting, copying, right-click or printing; the reader's name is watermarked across every page;
 * the page blurs when the window loses focus. (No website can fully stop a phone screenshot; this makes it hard and traceable.) */
(function () {
  "use strict";
  const view = document.getElementById("v-books");
  if (!view) return;
  const root = view.querySelector("#bk-root");
  const E = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const say = (t) => (typeof toast === "function" ? toast(t) : null);
  const ME = () => (typeof me !== "undefined" ? me : null);
  const OWNER = () => typeof isOwner !== "undefined" && isOwner;
  const DB = () => (typeof db !== "undefined" ? db : null);
  const okImg = (u) => /^(https:\/\/[^\s"'<>()]+|data:image\/(png|jpe?g|webp);base64,[A-Za-z0-9+/=]+)$/.test(u || "");
  let books = [], open = null, page = 0, cache = {}, fontSize = 19;
  try { fontSize = +localStorage.getItem("mw_bk_fs") || 19; } catch (_) {}

  const css = document.createElement("style");
  css.textContent = `
#bk-root{display:grid;gap:18px}
.bk-shelf{display:grid;grid-template-columns:repeat(auto-fill,minmax(170px,1fr));gap:18px}
.bk-card{display:grid;gap:8px;text-align:left;background:none;border:0;color:var(--text);cursor:pointer;padding:0}
.bk-cover{aspect-ratio:2/3;border-radius:6px 12px 12px 6px;background:linear-gradient(135deg,#2a2112,#0b0a08) center/cover;border:1px solid var(--gold-lo);box-shadow:6px 8px 22px rgba(0,0,0,.6),inset 6px 0 10px rgba(0,0,0,.45);display:grid;place-items:center;padding:14px;text-align:center;font:700 18px var(--display,Georgia,serif);color:var(--gold-hi)}
.bk-card b{font-size:15px}.bk-card small{color:var(--muted)}
.bk-reader{position:relative;border:1px solid var(--line);border-radius:16px;background:#f6efe0;color:#1b1610;overflow:hidden;-webkit-user-select:none;user-select:none;-webkit-touch-callout:none}
.bk-top{display:flex;gap:8px;align-items:center;flex-wrap:wrap;padding:10px 12px;background:#0f0d09;color:var(--text);border-bottom:1px solid var(--line)}
.bk-top b{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.bk-page{position:relative;padding:28px clamp(18px,6vw,70px) 40px;min-height:60vh;font-family:Georgia,"Times New Roman",serif;line-height:1.7;max-width:820px;margin:0 auto}
.bk-page p{margin:0 0 1em}
.bk-page h2,.bk-page h3{font-family:Georgia,serif;color:#5a4410}
.bk-wm{position:absolute;inset:0;pointer-events:none;overflow:hidden;opacity:.09;z-index:2;display:grid;grid-template-columns:repeat(3,1fr);grid-auto-rows:120px;transform:rotate(-24deg) scale(1.4);font:700 15px system-ui,sans-serif;color:#000;align-items:center;justify-items:center}
.bk-nav{display:flex;justify-content:space-between;align-items:center;gap:10px;padding:10px 12px;background:#0f0d09;color:var(--text);border-top:1px solid var(--line)}
.bk-nav input[type=range]{flex:1;accent-color:var(--gold)}
.bk-shield.blur .bk-page{filter:blur(14px)}
.bk-lock{text-align:center;padding:40px 20px;display:grid;gap:12px;justify-items:center}
.bk-admin{border:1px dashed var(--gold-lo);border-radius:14px;padding:14px;display:grid;gap:8px}
.bk-admin input,.bk-admin textarea{width:100%;background:var(--ink);border:1px solid var(--line);border-radius:10px;padding:10px;color:var(--text);font:16px var(--body)}
@media print{#v-books{display:none!important}body::after{content:"Printing is turned off for Meechie's World books.";display:block;padding:40px;font:20px sans-serif}}`;
  document.head.appendChild(css);

  function shelf() {
    const own = OWNER();
    root.innerHTML = `<div class="bk-shelf">${books.map((b) => `<button class="bk-card" type="button" data-book="${E(b.id)}"><div class="bk-cover" style="${okImg(b.cover) ? `background-image:url('${E(b.cover)}')` : ""}">${okImg(b.cover) ? "" : E(b.title)}</div><b>${E(b.title)}</b><small>${E(b.author || "Meechie's World Inc")} · ${b.pages || 0} pages</small></button>`).join("") || '<p class="muted">Books are coming soon.</p>'}</div>` +
      (own ? `<div class="bk-admin"><b>Owner: publish a book</b>
        <input type="text" id="bk-t" maxlength="120" placeholder="Book title">
        <input type="text" id="bk-a" maxlength="80" placeholder="Author" value="Meechie's World Inc">
        <textarea id="bk-b" maxlength="600" rows="2" placeholder="Short description"></textarea>
        <label>Cover picture (optional) <input type="file" id="bk-c" accept="image/*"></label>
        <label>The book: PDF or text file <input type="file" id="bk-f" accept=".pdf,.txt,application/pdf,text/plain"></label>
        <label style="display:flex;gap:8px;align-items:center"><input type="checkbox" id="bk-free" checked style="width:auto"> Free to read for members</label>
        <button class="btn" type="button" id="bk-go">Publish book</button><small class="muted" id="bk-st"></small></div>` : "");
  }
  async function readerOpen(id) {
    open = books.find((b) => b.id === id); if (!open) return;
    if (!ME()) { if (typeof openAuth === "function") openAuth("signup"); say("Join free to read Meechie's books."); return; }
    try { page = Math.min(open.pages - 1, +(localStorage.getItem("mw_bk_" + id) || 0)); } catch (_) { page = 0; }
    render();
  }
  async function getPage(n) {
    const key = open.id + "_" + n; if (cache[key]) return cache[key];
    const s = await DB().doc("bookpages/" + key).get(); const html = s.exists ? String(s.data().html || "") : "<p>(This page is missing.)</p>";
    cache[key] = html; return html;
  }
  async function render() {
    if (!open) { shelf(); return; }
    const who = (typeof members !== "undefined" && members[ME()]?.handle) || "Member";
    const stamp = who + " · " + new Date().toLocaleDateString();
    root.innerHTML = `<div class="bk-reader bk-shield" id="bk-shield">
      <div class="bk-top"><button class="btn ghost sm" type="button" data-shelf="1">← Books</button><b>${E(open.title)}</b>
        <button class="btn ghost sm" type="button" data-fs="-1" aria-label="Smaller text">A−</button><button class="btn ghost sm" type="button" data-fs="1" aria-label="Bigger text">A+</button>
        ${OWNER() ? `<button class="act" type="button" data-delbook="${E(open.id)}">Delete book</button>` : ""}</div>
      <div class="bk-page" id="bk-page" style="font-size:${fontSize}px"><p style="opacity:.6">Loading page...</p></div>
      <div class="bk-wm" aria-hidden="true">${Array(30).fill(`<span>${E(stamp)}</span>`).join("")}</div>
      <div class="bk-nav"><button class="btn sm" type="button" data-pg="-1">‹ Back</button><input type="range" min="1" max="${open.pages}" value="${page + 1}" id="bk-range" aria-label="Page"><span id="bk-num">${page + 1} / ${open.pages}</span><button class="btn sm" type="button" data-pg="1">Next ›</button></div></div>`;
    const html = await getPage(page);
    const pg = root.querySelector("#bk-page"); if (!pg) return;
    pg.innerHTML = html; // pages are written by the owner's upload and cleaned below before saving
    try { localStorage.setItem("mw_bk_" + open.id, page); } catch (_) {}
    if (page + 1 < open.pages) getPage(page + 1).catch(() => {});
  }
  root.addEventListener("click", async (e) => {
    const b = e.target.closest("button"); if (!b) return;
    if (b.dataset.book) return readerOpen(b.dataset.book);
    if (b.dataset.shelf) { open = null; shelf(); return; }
    if (b.dataset.pg) { const n = page + +b.dataset.pg; if (n >= 0 && n < open.pages) { page = n; render(); view.scrollIntoView({ behavior: "smooth" }); } return; }
    if (b.dataset.fs) { fontSize = Math.max(14, Math.min(30, fontSize + 2 * +b.dataset.fs)); try { localStorage.setItem("mw_bk_fs", fontSize); } catch (_) {} const p = root.querySelector("#bk-page"); if (p) p.style.fontSize = fontSize + "px"; return; }
    if (b.dataset.delbook) { if (!b.dataset.confirm) { b.dataset.confirm = 1; b.textContent = "Tap again"; return; } await DB().doc("books/" + b.dataset.delbook).delete().catch(() => {}); open = null; say("Book removed"); return; }
    if (b.id === "bk-go") publish();
  });
  root.addEventListener("change", (e) => { if (e.target.id === "bk-range") { page = +e.target.value - 1; render(); } });

  /* ---------- protection ---------- */
  const inReader = (t) => t && t.closest && t.closest("#bk-shield");
  ["copy", "cut", "contextmenu", "dragstart", "selectstart"].forEach((ev) => document.addEventListener(ev, (e) => { if (inReader(e.target)) { e.preventDefault(); if (ev === "copy" || ev === "contextmenu") say("Copying is turned off for Meechie's books."); } }));
  document.addEventListener("keydown", (e) => {
    if (!open || view.hidden) return;
    const k = (e.key || "").toLowerCase();
    if (k === "printscreen" || ((e.ctrlKey || e.metaKey) && ["p", "s", "c", "a"].includes(k)) || (e.metaKey && e.shiftKey && ["3", "4", "5", "s"].includes(k))) {
      e.preventDefault(); const sh = document.getElementById("bk-shield"); sh && sh.classList.add("blur");
      try { navigator.clipboard && navigator.clipboard.writeText("Meechie's World books can't be screenshotted."); } catch (_) {}
      say("Screenshots and copying are turned off for Meechie's books."); setTimeout(() => sh && sh.classList.remove("blur"), 1500);
    }
  });
  const blurOn = () => { const sh = document.getElementById("bk-shield"); if (sh) sh.classList.add("blur"); };
  const blurOff = () => { const sh = document.getElementById("bk-shield"); if (sh) sh.classList.remove("blur"); };
  window.addEventListener("blur", blurOn); window.addEventListener("focus", blurOff);
  document.addEventListener("visibilitychange", () => (document.hidden ? blurOn() : blurOff()));

  /* ---------- owner publishing ---------- */
  const clean = (t) => E(t).replace(/\r/g, "");
  function toPages(text) {
    // ~1800 characters per page, never splitting a paragraph unless it's huge
    const paras = text.split(/\n\s*\n|\n(?=\s*(?:chapter|part)\b)/i).map((p) => p.replace(/\s*\n\s*/g, " ").trim()).filter(Boolean);
    const pages = []; let cur = "";
    for (const p of paras) {
      const isHead = /^(chapter|part|prologue|epilogue|introduction|preface)\b/i.test(p) && p.length < 90;
      const html = isHead ? `<h2>${clean(p)}</h2>` : `<p>${clean(p)}</p>`;
      if ((cur.length + html.length > 2200 && cur) || (isHead && cur.length > 400)) { pages.push(cur); cur = ""; }
      cur += html;
    }
    if (cur) pages.push(cur);
    return pages;
  }
  async function pdfText(file) {
    if (!window.pdfjsLib) await new Promise((res, rej) => { const s = document.createElement("script"); s.src = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js"; s.onload = res; s.onerror = rej; document.head.appendChild(s); });
    pdfjsLib.GlobalWorkerOptions.workerSrc = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";
    const doc = await pdfjsLib.getDocument({ data: await file.arrayBuffer() }).promise; let out = "";
    for (let i = 1; i <= doc.numPages; i++) {
      const pg = await doc.getPage(i), tc = await pg.getTextContent(); let lastY = null, line = "";
      for (const it of tc.items) { const y = Math.round(it.transform[5]); if (lastY !== null && Math.abs(y - lastY) > 2) { out += line.trimEnd() + "\n"; line = ""; if (Math.abs(y - lastY) > 18) out += "\n"; } line += it.str; lastY = y; }
      out += line + "\n\n"; const st = document.getElementById("bk-st"); if (st) st.textContent = "Reading PDF page " + i + " of " + doc.numPages + "...";
    }
    return out;
  }
  async function publish() {
    const st = root.querySelector("#bk-st"), title = root.querySelector("#bk-t").value.trim(), f = root.querySelector("#bk-f").files[0];
    if (!title || !f) { st.textContent = "Add a title and the book file."; return; }
    const btn = root.querySelector("#bk-go"); btn.disabled = true;
    try {
      const text = /pdf$/i.test(f.name) || f.type === "application/pdf" ? await pdfText(f) : await f.text();
      const pages = toPages(text); if (!pages.length) throw new Error("No text found in that file. If it's a scanned PDF, send it to Claude to convert.");
      let cover = ""; const cf = root.querySelector("#bk-c").files[0];
      if (cf) { const d = await (typeof compress === "function" ? compress(cf, 700) : null); if (d) { const blob = await (await fetch(d)).blob(); cover = (await MW.uploadMedia(blob, { type: "image/jpeg" })).url; } }
      const id = (title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "book") + "-" + Date.now().toString(36);
      for (let i = 0; i < pages.length; i++) { await DB().doc("bookpages/" + id + "_" + i).set({ book: id, n: i, html: pages[i] }); if (i % 5 === 0) st.textContent = "Publishing page " + (i + 1) + " of " + pages.length + "..."; }
      await DB().doc("books/" + id).set({ title, author: root.querySelector("#bk-a").value.trim() || "Meechie's World Inc", blurb: root.querySelector("#bk-b").value.trim(), cover, pages: pages.length, free: root.querySelector("#bk-free").checked, order: Date.now(), createdAt: Date.now() });
      st.textContent = "Published! " + pages.length + " pages."; say("Your book is live in Books");
    } catch (err) { st.textContent = err.message || "Couldn't publish."; }
    btn.disabled = false;
  }

  async function init() {
    if (!window.claude) return;
    const d = await claude.use("db"); if (!d) { shelf(); return; }
    d.collection("books").orderBy("order", "desc").limit(50).onSnapshot((s) => { books = s.docs.map((x) => ({ id: x.id, ...x.data() })); if (!open) shelf(); }, () => {});
    new MutationObserver(() => { if (!view.hidden && !open) shelf(); }).observe(view, { attributes: true, attributeFilter: ["hidden"] });
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init); else init();
})();
