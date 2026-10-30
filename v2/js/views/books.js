/* v2 BOOKS VIEW (Phase 5) — the live js/books.js, ported: the
   shelf (uploaded books + the site's own published books from
   /books/index.json, static titles suppress uploaded duplicates),
   the protected reader (watermarked pages from bookpages docs,
   no select/copy/print, blur on focus loss — the live rules), the
   Shopify buy panel for paid eBooks, and the owner's add-book
   flow (PDF/TXT turned into pages on device). Styles in
   css/books.css. */
import { MARKUP } from "./books-markup.js";
import { firestore } from "../platform.js";
import { toast } from "../commerce.js";
import { compress } from "../social.js";

let stopFn = null;
export function render(viewRoot, ctx) {
  viewRoot.innerHTML = MARKUP;
  const fdb = firestore(ctx);
  let myDocCache = null;
  fdb.base.listDocs("members", { limit: 200 }).then((rows) => { const m = rows.find((x) => x.id === fdb.base.me()); myDocCache = m || null; }).catch(() => {});

  "use strict";
  const root = viewRoot.querySelector("#bk-root");
  if (!root) return;
  const E = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const say = toast;
  const ME = () => fdb.base.me();
  const OWNER = () => fdb.base.isOwner();
  const DB = () => fdb;
  const okImg = (u) => /^(https:\/\/[^\s"'<>()]+|data:image\/(png|jpe?g|webp);base64,[A-Za-z0-9+/=]+|img\/books\/[a-z0-9-]+\.(jpg|png|webp))$/.test(u || "");
  /* Paid eBooks sold through the Meechie's World Shopify store: the card opens a buy panel instead of the reader. */
  const okBuy = (u) => /^https:\/\/meechiesworldinc\.myshopify\.com\/[^\s"'<>]*$/.test(u || "");
  function buyPanel(b) {
    root.innerHTML = `<div class="bk-buy"><button class="btn ghost sm" type="button" data-shelf="1">← Books</button>
      <div class="bk-buy-in"><div class="bk-cover" style="${okImg(b.cover) ? `background-image:url('${E(b.cover)}')` : ""}">${okImg(b.cover) ? "" : E(b.title)}</div>
      <div><p class="eyebrow">eBook · ${b.pages || 0} pages · PDF</p><h3>${E(b.title)}</h3><p class="muted">${E(b.blurb || "")}</p>
      <p><a class="btn" href="${E(b.buy)}" target="_blank" rel="noopener">Buy &amp; download · ${E(b.price || "")}</a>${okBuy(b.url) ? ` <a class="btn ghost" href="${E(b.url)}" target="_blank" rel="noopener">Details</a>` : ""}</p>
      <small class="muted">Secure checkout by Shopify. Your download link appears right after you pay and is emailed to you.</small></div></div></div>`;
  }
  let books = [], dbBooks = [], staticBooks = [], open = null, page = 0, cache = {}, fontSize = 19;
  /* Books published as files in the site itself (books/index.json). They show on the shelf next to
     books the owner uploads, and read in the same reader. */
  const staticPages = {};
  const mergeBooks = () => {
    const key = (b) => String(b.title || "").split(":")[0].trim().toLowerCase();
    const staticKeys = new Set(staticBooks.map(key));
    books = [...dbBooks.filter((b) => !staticKeys.has(key(b))), ...staticBooks];
    if (!open) shelf();
  };
  fetch("/books/index.json", { cache: "no-cache" }).then((r) => (r.ok ? r.json() : [])).then((list) => {
    staticBooks = (Array.isArray(list) ? list : []).map((b) => ({ ...b, static: true })); mergeBooks();
  }).catch(() => {});
  try { fontSize = +localStorage.getItem("mw_bk_fs") || 19; } catch (_) {}

  
  // The Conscientia emblem from the site's own artwork, used behind every book page
  try {
    const sym = document.querySelector("symbol#emblem"), grad = document.getElementById("g");
    if (sym) {
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200"><defs>${grad ? grad.outerHTML : ""}</defs>${sym.innerHTML}</svg>`;
      document.documentElement.style.setProperty("--bk-emb", `url("data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}")`);
    }
  } catch (_) {}

  const featuredBook = `<div class="bk-featured"><img src="/img/book-cover-640.webp" alt="Meechies World — The Book cover" loading="lazy" width="1536" height="1024"><div class="bk-featured-in"><div><h3>Meechies World — The Book</h3><p>Real Life · Real Hustle · Real Legacy</p></div><a class="btn" href="#shop" data-go="shop">Get your copy</a></div></div>`;
  function shelf() {
    const own = OWNER();
    root.innerHTML = featuredBook + `<div class="bk-shelf">${books.map((b) => `<button class="bk-card" type="button" data-book="${E(b.id)}"><div class="bk-cover" style="${okImg(b.cover) ? `background-image:url('${E(b.cover)}')` : ""}">${okImg(b.cover) ? "" : E(b.title)}</div><b>${E(b.title)}</b><small>${E(b.author || "Meechie's World Inc")} · ${b.pages || 0} pages${okBuy(b.buy) && b.price ? " · " + E(b.price) : ""}</small></button>`).join("") || '<p class="muted">Books are coming soon.</p>'}</div>` +
      books.filter((b) => /^[a-z0-9-]+\.html$/.test(b.media || "")).map((b) => `<p class="bk-listen"><a class="btn" href="${E(b.media)}">🎧 Listen to &amp; watch “${E(String(b.title).split(":")[0])}”</a></p>`).join("") +
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
    if (okBuy(open.buy) && !open.src) { buyPanel(open); return; }
    if (!ME()) { if (typeof openAuth === "function") openAuth("signup"); say("Join free to read Meechie's books."); return; }
    try { page = Math.min(open.pages - 1, +(localStorage.getItem("mw_bk_" + id) || 0)); } catch (_) { page = 0; }
    render();
  }
  async function getPage(n) {
    const key = open.id + "_" + n; if (cache[key]) return cache[key];
    if (open.static) {
      const bid = open.id; if (!staticPages[bid]) staticPages[bid] = fetch(open.src).then((r) => { if (!r.ok) throw new Error("HTTP " + r.status); return r.json(); }).then((j) => j.html || []).catch((e) => { delete staticPages[bid]; throw e; });
      const all = await staticPages[open.id];
      return (cache[key] = String(all[n] ?? "<p>(This page is missing.)</p>"));
    }
    const s = await DB().doc("bookpages/" + key).get(); const html = s.exists ? String(s.data().html || "") : "<p>(This page is missing.)</p>";
    cache[key] = html; return html;
  }
  async function render() {
    if (!open) { shelf(); return; }
    const who = (myDocCache && myDocCache.handle) || "Member";
    const stamp = who + " · " + new Date().toLocaleDateString();
    root.innerHTML = `<div class="bk-reader bk-shield" id="bk-shield">
      <div class="bk-top"><button class="btn ghost sm" type="button" data-shelf="1">← Books</button><b>${E(open.title)}</b>
        <button class="btn ghost sm" type="button" data-fs="-1" aria-label="Smaller text">A−</button><button class="btn ghost sm" type="button" data-fs="1" aria-label="Bigger text">A+</button>
        ${/^[a-z0-9-]+\.html$/.test(open.media || "") ? `<a class="btn ghost sm" href="${E(open.media)}">🎧 Listen</a>` : ""}
        ${OWNER() && !open.static ? `<button class="act" type="button" data-delbook="${E(open.id)}">Delete book</button>` : ""}</div>
      <div class="bk-sheet"><div class="bk-orn" aria-hidden="true"><i></i><i></i><i></i><i></i></div>
        <div class="bk-head" aria-hidden="true"><span class="em"></span><small>MEECHIE'S WORLD INC • CONSCIENTIA</small><hr></div>
        <div class="bk-page" id="bk-page" style="font-size:${fontSize}px"><p style="opacity:.6">Loading page...</p></div>
        <div class="bk-foot"><span>Page ${page + 1}</span><hr></div></div>
      <div class="bk-wm" aria-hidden="true">${Array(30).fill(`<span>${E(stamp)}</span>`).join("")}</div>
      <div class="bk-nav"><button class="btn sm" type="button" data-pg="-1">‹ Back</button><input type="range" min="1" max="${open.pages}" value="${page + 1}" id="bk-range" aria-label="Page"><span id="bk-num">${page + 1} / ${open.pages}</span><button class="btn sm" type="button" data-pg="1">Next ›</button></div></div>`;
    const want = page, book = open; let html;
    try { html = await getPage(want); } catch (_) { html = "<p>Couldn't load this page. Check your connection and tap Next or Back to try again.</p>"; }
    if (want !== page || book !== open) return; // you turned the page again while this one loaded
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
    if (!open || !root.isConnected) return;
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
  // A heading is a short line like "CHAPTER 12", "Part III", "Prologue" — not a sentence that starts with "Chapter 10 returns..."
  const isHeading = (p) => p.length < 60 && !/[.,;:]$/.test(p) &&
    (/^(chapter|part)\s+([0-9]+|[ivxlc]+|one|two|three|four|five|six|seven|eight|nine|ten)\b/i.test(p) || /^(prologue|epilogue|introduction|preface|afterword|acknowledg(e)?ments|contents)$/i.test(p));
  const paraHtml = (p) => (isHeading(p) ? `<h2>${clean(p)}</h2>` : `<p>${clean(p)}</p>`);
  function toPages(text) {
    // Text files: ~2,000 characters per page, never splitting a paragraph unless it's huge
    const paras = text.split(/\n\s*\n|\n(?=\s*(?:chapter|part)\s+\S+\s*\n)/i).map((p) => p.replace(/\s*\n\s*/g, " ").trim()).filter(Boolean);
    const pages = []; let cur = "";
    for (const p of paras) {
      const html = paraHtml(p), head = html.startsWith("<h2>");
      if ((cur.length + html.length > 2200 && cur) || (head && cur.length > 400)) { pages.push(cur); cur = ""; }
      cur += html;
    }
    if (cur) pages.push(cur);
    return pages;
  }
  /* PDFs: one site page per PDF page, so page numbers (and the table of contents) match the printed book.
     Lines that repeat on most pages (running headers, "Page 12" footers) are left out. */
  function pdfToPages(pageTexts) {
    // Only short lines at the very top or bottom of a page that show up on most pages count as headers/footers.
    const norm = (l) => l.trim().replace(/\d+/g, "#").toLowerCase();
    const edges = (t) => { const ls = t.split("\n").map((l) => l.trim()).filter(Boolean); return [...ls.slice(0, 2), ...ls.slice(-2)]; };
    const count = {};
    pageTexts.forEach((t) => new Set(edges(t).map(norm)).forEach((l) => { count[l] = (count[l] || 0) + 1; }));
    const repeated = (l) => { const n = norm(l); return n.length > 0 && n.length < 60 && !/[.!?,;:"”]$/.test(n) && pageTexts.length >= 8 && count[n] >= pageTexts.length * 0.6; };
    return pageTexts.map((t) => {
      const ls = t.split("\n"), nonEmpty = ls.map((l, i) => (l.trim() ? i : -1)).filter((i) => i >= 0);
      const edge = new Set([...nonEmpty.slice(0, 2), ...nonEmpty.slice(-2)]);
      const lines = ls.filter((l, i) => !(edge.has(i) && (repeated(l) || /^\s*(page\s+)?\d{1,4}\s*$/i.test(l))));
      const paras = lines.join("\n").split(/\n\s*\n/).map((p) => p.replace(/\s*\n\s*/g, " ").trim()).filter(Boolean);
      return paras.length ? paras.map(paraHtml).join("") : '<p style="opacity:.55;text-align:center">(This page is a picture or blank in the printed book.)</p>';
    });
  }
  async function pdfText(file) {
    if (!window.pdfjsLib) await new Promise((res, rej) => { const s = document.createElement("script"); s.src = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js"; s.onload = res; s.onerror = rej; document.head.appendChild(s); });
    pdfjsLib.GlobalWorkerOptions.workerSrc = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";
    const doc = await pdfjsLib.getDocument({ data: await file.arrayBuffer() }).promise; const out = [];
    for (let i = 1; i <= doc.numPages; i++) {
      const pg = await doc.getPage(i), tc = await pg.getTextContent(); let lastY = null, line = "", txt = "";
      for (const it of tc.items) { const y = Math.round(it.transform[5]); if (lastY !== null && Math.abs(y - lastY) > 2) { txt += line.trimEnd() + "\n"; line = ""; if (Math.abs(y - lastY) > 18) txt += "\n"; } line += it.str; lastY = y; }
      out.push(scrub(txt + line)); const st = document.getElementById("bk-st"); if (st) st.textContent = "Reading PDF page " + i + " of " + doc.numPages + "...";
    }
    return out;
  }
  /* PDFs often carry invisible control characters (like the "null" character). The database refuses to
     save text that contains them, which used to stop an upload part-way through. Strip them first. */
  const scrub = (t) => String(t)
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F￾￿]/g, "")
    .replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, "");
  async function publish() {
    const st = root.querySelector("#bk-st"), title = root.querySelector("#bk-t").value.trim(), f = root.querySelector("#bk-f").files[0];
    if (!title || !f) { st.textContent = "Add a title and the book file."; say("Add a title and the book file."); return; }
    const btn = root.querySelector("#bk-go"); btn.disabled = true;
    let id = "", saved = 0;
    try {
      const isPdf = /pdf$/i.test(f.name) || f.type === "application/pdf";
      let pages;
      if (isPdf) { const pt = await pdfText(f); if (!pt.some((t) => t.trim())) throw new Error("No text found in that file. If it's a scanned PDF, send it to Claude to convert."); pages = pdfToPages(pt); }
      else pages = toPages(scrub(await f.text()));
      if (!pages.length) throw new Error("No text found in that file. If it's a scanned PDF, send it to Claude to convert.");
      let cover = ""; const cf = root.querySelector("#bk-c").files[0];
      if (cf) { const d = await (compress(cf, 700)); if (d) { const blob = await (await fetch(d)).blob(); cover = (await fdb.base.uploadMedia(blob, { type: "image/jpeg" })).url; } }
      id = (title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "book") + "-" + Date.now().toString(36);
      for (let i = 0; i < pages.length; i++) {
        try { await DB().doc("bookpages/" + id + "_" + i).set({ book: id, n: i, html: pages[i] }); }
        catch (e) { throw new Error("Page " + (i + 1) + " of " + pages.length + " wouldn't save (" + (e.message || e) + ")."); }
        saved = i + 1; if (i % 5 === 0 || saved === pages.length) st.textContent = "Publishing page " + saved + " of " + pages.length + "...";
      }
      await DB().doc("books/" + id).set({ title, author: scrub(root.querySelector("#bk-a").value.trim()) || "Meechie's World Inc", blurb: scrub(root.querySelector("#bk-b").value.trim()), cover, pages: pages.length, free: root.querySelector("#bk-free").checked, order: Date.now(), createdAt: Date.now() });
      st.textContent = "Published! " + pages.length + " pages."; say("Your book is live in Books");
    } catch (err) {
      // Clean up a half-finished upload so it doesn't leave stray pages behind
      for (let i = 0; i < saved; i++) await DB().doc("bookpages/" + id + "_" + i).delete().catch(() => {});
      const msg = "Your book didn't publish: " + (err.message || "something went wrong") + " Nothing was saved. Try again, or send the file to Claude.";
      st.textContent = msg; st.style.color = "var(--warn)"; say(msg);
    }
    btn.disabled = false;
  }

  async function init() {
    const d = fdb;
    d.collection("books").orderBy("order", "desc").limit(50).onSnapshot((s) => { dbBooks = s.docs.map((x) => ({ id: x.id, ...x.data() })); mergeBooks(); }, () => {});
  }
  stopFn = init();
}
export function destroy() { if (stopFn) { try { stopFn(); } catch (_) {} stopFn = null; } }
