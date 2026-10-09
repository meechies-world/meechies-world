/*
 * Owner editor for Meechie's World.
 * Everyone sees the saved edits. Only the owner (admin) sees the "Edit site" button.
 * Saved in one document, site/content:
 *   t     -> { "original text": "new text" }   (every spot that had that text changes)
 *   l     -> { "original link text": "new url" }
 *   theme -> { "--gold": "#d4a843", ... }
 *   hidden-> ["games", ...]   pages hidden from visitors
 */
(function () {
  "use strict";
  const SEL = "h1,h2,h3,h4,p,li,small,label,span,a,button,b,strong,em,td,th,div,summary,legend";
  const SKIP = "input,textarea,select,option,script,style,svg,canvas,dialog,.toast,#authbar,#mw-bar,#mw-fab,[data-noedit]";
  const PAY = [["spotlight", "Spotlight $50"], ["featured", "Featured $150"], ["takeover", "Takeover $400"], ["deposit", "Service deposit $50"], ["custom", "Any amount (invoice or quote)"], ["donate", "Donations (support)"], ["plugins", "Studio Plugin Pack"]];
  const THEME = [["--gold", "Gold"], ["--ink", "Background"], ["--panel", "Cards"], ["--text", "Text"]];
  const DEFAULTS = { "--gold": "#d4a843", "--ink": "#0b0a08", "--panel": "#15130f", "--text": "#f3ecdc" };
  const root = document.documentElement;
  let map = {}, links = {}, theme = {}, hidden = [], pay = {}, blocks = [], autoplay = true, aiPending = null, editing = false, admin = false, db = null, saveTimer = null, bar = null, hideStyle = null;
  const tagged = [];

  const safe = (f) => { try { return f(); } catch (_) { return null; } };
  const mix = (hex, to, a) => {
    const p = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
    const A = p(hex), B = p(to);
    return "#" + A.map((v, i) => Math.round(v + (B[i] - v) * a).toString(16).padStart(2, "0")).join("");
  };

  /* ---- tag every plain-text element so it can be matched and edited ---- */
  function tagAll() {
    document.body.querySelectorAll(SEL).forEach((el) => {
      if (el.childElementCount || el.id || el.closest(SKIP) || el.dataset.orig !== undefined) return;
      const txt = el.textContent.trim();
      if (!txt || txt.length > 300) return;
      el.dataset.orig = txt;
      tagged.push(el);
    });
  }

  /* ---- apply saved edits ---- */
  function applyAll() {
    root.style.removeProperty("--gold"); root.style.removeProperty("--gold-hi"); root.style.removeProperty("--gold-lo");
    THEME.forEach(([k]) => root.style.removeProperty(k));
    for (const k in theme) {
      root.style.setProperty(k, theme[k]);
      if (k === "--gold") { root.style.setProperty("--gold-hi", mix(theme[k], "#ffffff", 0.35)); root.style.setProperty("--gold-lo", mix(theme[k], "#000000", 0.45)); }
    }
    tagged.forEach((el) => {
      if (!el.isConnected || el === document.activeElement) return;
      const o = el.dataset.orig;
      el.textContent = map[o] !== undefined ? map[o] : o;
      if (el.tagName === "A" && links[o]) el.setAttribute("href", links[o]);
    });
    if (!hideStyle) { hideStyle = document.createElement("style"); document.head.appendChild(hideStyle); }
    hideStyle.textContent = admin ? "" : hidden.map((v) => `[data-go="${v}"]{display:none!important}`).join("");
    applyPay(); renderBlocks();
    if (window.MW_SITE) window.MW_SITE.autoplay = autoplay;
  }
  /* ---- custom sections the owner (or the AI) adds ---- */
  function renderBlocks() {
    document.querySelectorAll(".mw-blocks").forEach((b) => b.remove());
    const byView = {};
    blocks.forEach((b) => { (byView[b.view] = byView[b.view] || []).push(b); });
    for (const v in byView) {
      const sec = document.getElementById("v-" + v); if (!sec) continue;
      const wrap = sec.querySelector(".wrap") || sec;
      const box = document.createElement("div"); box.className = "mw-blocks";
      byView[v].forEach((b) => {
        const card = document.createElement("div"); card.className = "card mw-block";
        if (b.title) { const h = document.createElement("h3"); h.textContent = b.title; card.appendChild(h); }
        if (b.body) { const p = document.createElement("p"); p.textContent = b.body; card.appendChild(p); }
        if (b.btn && /^(https:\/\/|#|mailto:|tel:)/.test(b.url || "")) {
          const a = document.createElement("a"); a.className = "btn"; a.textContent = b.btn; a.href = b.url;
          if (/^#/.test(b.url)) a.dataset.go = b.url.slice(1); else { a.target = "_blank"; a.rel = "noopener"; }
          card.appendChild(a);
        }
        if (admin) { const x = document.createElement("button"); x.type = "button"; x.className = "act mw-bdel"; x.textContent = "Remove this section"; x.dataset.bdel = b.id; card.appendChild(x); }
        box.appendChild(card);
      });
      if (byView[v][0].top) wrap.insertBefore(box, wrap.children[1] || null); else wrap.appendChild(box);
    }
  }
  document.addEventListener("click", (e) => {
    const x = e.target.closest("[data-bdel]"); if (!x || !admin) return;
    if (!x.dataset.sure) { x.dataset.sure = "1"; x.textContent = "Tap again to remove"; return; }
    blocks = blocks.filter((b) => b.id !== x.dataset.bdel); renderBlocks(); save();
  });
  function applyPay() {
    document.querySelectorAll("[data-pay]").forEach((a) => {
      const u = pay[a.dataset.pay];
      a.hidden = !u && !admin; a.classList.toggle("pay-unset", !u);
      a.title = !u && admin ? "Owner: add your Stripe payment link in Edit site → Payments" : "";
    });
    document.querySelectorAll("[data-paybox]").forEach((b) => { b.hidden = !admin && ![...b.querySelectorAll("[data-pay]")].some((a) => pay[a.dataset.pay]); });
  }
  function load(data) {
    window.MW_SITE = data || {}; blocks = (data && Array.isArray(data.blocks)) ? data.blocks : []; autoplay = !(data && data.autoplay === false); pay = (data && data.pay) || {}; map = (data && data.t) || {}; links = (data && data.l) || {}; theme = (data && data.theme) || {}; hidden = (data && data.hidden) || [];
  }
  function cache() { safe(() => localStorage.setItem("mw_site", JSON.stringify({ t: map, l: links, theme, hidden, pay, blocks, autoplay }))); }

  /* ---- saving ---- */
  function status(msg, bad) { const s = document.getElementById("mw-status"); if (s) { s.textContent = msg; s.style.color = bad ? "#ff9b8a" : "#8fd6a8"; } }
  function save() {
    status("Saving...", false); clearTimeout(saveTimer);
    saveTimer = setTimeout(async () => {
      try { await db.doc("site/content").set({ t: map, l: links, theme, hidden, pay, blocks, autoplay, updatedAt: Date.now() }); cache(); status("Saved ✓", false); }
      catch (e) { status("Could not save: " + (e.message || e.code), true); }
    }, 500);
  }

  /* ---- edit mode ---- */
  function setEditing(on) {
    editing = on; document.body.classList.toggle("mw-editing", on);
    tagged.forEach((el) => {
      if (on) { el.contentEditable = "plaintext-only"; if (el.contentEditable !== "plaintext-only") el.contentEditable = "true"; el.spellcheck = true; }
      else { el.removeAttribute("contenteditable"); el.removeAttribute("spellcheck"); }
    });
    document.getElementById("mw-fab").hidden = on; bar.hidden = !on; if (!on) applyAll();
  }
  function commit(el) {
    const o = el.dataset.orig, v = el.textContent.replace(/\s+/g, " ").trim();
    if (v === (map[o] !== undefined ? map[o] : o)) return;
    if (!v || v === o) delete map[o]; else map[o] = v;
    tagged.forEach((t) => { if (t.dataset.orig === o && t !== el) t.textContent = map[o] !== undefined ? map[o] : o; });
    save();
  }
  function showLink(el) {
    const row = document.getElementById("mw-linkrow"), inp = document.getElementById("mw-link");
    const a = el && el.closest && el.closest("a[href]");
    if (!a || !a.dataset.orig || a.dataset.go || (a.getAttribute("href") || "").startsWith("#")) { row.hidden = true; return; }
    row.hidden = false; inp.value = a.getAttribute("href"); inp.dataset.orig = a.dataset.orig;
  }

  /* ---- owner AI: describe a change, review it, apply it ---- */
  function currentView() { const v = [...document.querySelectorAll("section.view")].find((x) => !x.hidden); return v ? v.id.replace(/^v-/, "") : "home"; }
  function collectTexts() {
    const v = document.querySelector("section.view:not([hidden])"), seen = new Set(), out = [];
    const scope = (el) => (v && v.contains(el)) || el.closest("header,footer,nav");
    tagged.forEach((el) => {
      if (!el.isConnected || !scope(el)) return;
      const o = el.dataset.orig; if (seen.has(o)) return; seen.add(o);
      out.push({ id: "t" + out.length, o, text: (map[o] !== undefined ? map[o] : o).slice(0, 160) });
    });
    return out.slice(0, 220);
  }
  async function askAI() {
    const inp = document.getElementById("mw-ai-in"), out = document.getElementById("mw-ai-out"), q = inp.value.trim();
    if (!q) return;
    const s = window.MW && MW.session && MW.session(); if (!s) return;
    out.hidden = false; out.innerHTML = "<span style='color:#a99f8b'>Thinking...</span>";
    const texts = collectTexts(), views = [...document.querySelectorAll("section.view")].map((x) => x.id.replace(/^v-/, ""));
    try {
      const r = await fetch("/api/site-ai", { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer " + s.access_token },
        body: JSON.stringify({ request: q, view: currentView(), views, hidden, theme, autoplay, blocks: blocks.map((b) => ({ id: b.id, view: b.view, title: b.title })), texts: texts.map(({ id, text }) => ({ id, text })) }) });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error === "owner_only" ? "Only the owner can use this." : (j.error || "The AI couldn't answer. Try again."));
      const ops = j.ops || {}, lines = [];
      const tmap = {}; texts.forEach((t) => (tmap[t.id] = t));
      const textChanges = Object.entries(ops.texts || {}).filter(([id, v]) => tmap[id] && typeof v === "string" && v.trim()).map(([id, v]) => [tmap[id].o, v.trim().slice(0, 300), tmap[id].text]);
      textChanges.forEach(([, nv, ov]) => lines.push(`Text: "${ov.slice(0, 50)}" → "${nv.slice(0, 80)}"`));
      const okHex = (h) => /^#[0-9a-f]{6}$/i.test(h);
      const themeCh = Object.entries(ops.theme || {}).filter(([k, v]) => ["--gold", "--ink", "--panel", "--text"].includes(k) && okHex(v));
      themeCh.forEach(([k, v]) => lines.push(`Color ${({ "--gold": "Gold", "--ink": "Background", "--panel": "Cards", "--text": "Text" })[k]} → ${v}`));
      const hide = (ops.hide || []).filter((v) => views.includes(v) && v !== "home"), show = (ops.show || []).filter((v) => views.includes(v));
      hide.forEach((v) => lines.push(`Hide page: ${v}`)); show.forEach((v) => lines.push(`Show page: ${v}`));
      const add = (ops.add_blocks || []).filter((b) => b && views.includes(b.view) && (b.title || b.body)).slice(0, 5).map((b) => ({ id: "b" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6), view: b.view, title: String(b.title || "").slice(0, 120), body: String(b.body || "").slice(0, 1200), btn: String(b.button || "").slice(0, 40), url: String(b.url || "").slice(0, 300), top: !!b.top }));
      add.forEach((b) => lines.push(`Add section on ${b.view}: "${b.title || b.body.slice(0, 40)}"`));
      const rem = (ops.remove_blocks || []).filter((id) => blocks.some((b) => b.id === id));
      rem.forEach((id) => lines.push(`Remove section: "${(blocks.find((b) => b.id === id) || {}).title || id}"`));
      const ap = typeof ops.autoplay === "boolean" ? ops.autoplay : null; if (ap !== null) lines.push(`Radio auto-start: ${ap ? "on" : "off"}`);
      aiPending = { textChanges, themeCh, hide, show, add, rem, ap };
      const reply = E(j.reply || "");
      out.innerHTML = `<div>${reply || (lines.length ? "Here's what I'll change:" : "")}</div>` + (lines.length ? `<ul style="margin:0;padding-left:18px">${lines.map((l) => `<li>${E(l)}</li>`).join("")}</ul><div style="display:flex;gap:8px"><button class="p" type="button" id="mw-ai-apply">Apply changes</button><button type="button" id="mw-ai-cancel">Cancel</button></div>` : `<div style="color:#a99f8b">No changes to make. Try saying exactly which words or color to change. For bigger changes (new features), ask Claude.</div>`);
      const ap2 = document.getElementById("mw-ai-apply"); if (ap2) ap2.addEventListener("click", applyAI);
      const cn = document.getElementById("mw-ai-cancel"); if (cn) cn.addEventListener("click", () => { aiPending = null; out.hidden = true; });
    } catch (e) { out.innerHTML = `<span style="color:#ff9b8a">${E(e.message)}</span>`; }
  }
  function applyAI() {
    const p = aiPending; if (!p) return;
    p.textChanges.forEach(([o, nv]) => { if (nv === o) delete map[o]; else map[o] = nv; });
    p.themeCh.forEach(([k, v]) => (theme[k] = v));
    hidden = hidden.filter((v) => !p.show.includes(v)); p.hide.forEach((v) => { if (!hidden.includes(v)) hidden.push(v); });
    blocks = blocks.filter((b) => !p.rem.includes(b.id)).concat(p.add);
    if (p.ap !== null) autoplay = p.ap;
    aiPending = null; applyAll(); save();
    const out = document.getElementById("mw-ai-out"); out.innerHTML = "<span style='color:#8fd6a8'>Done ✓ Changes are live. Use “Undo all my edits” if you don't like them.</span>";
    document.getElementById("mw-ai-in").value = "";
    if (bar) { bar.querySelectorAll("input[type=color]").forEach((i) => (i.value = theme[i.dataset.var] || DEFAULTS[i.dataset.var])); bar.querySelectorAll("input[data-pg]").forEach((i) => (i.checked = !hidden.includes(i.dataset.pg))); const a = bar.querySelector("#mw-autoplay"); if (a) a.checked = autoplay; }
  }
  const E = (t) => String(t ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  function buildUI() {
    const css = document.createElement("style");
    css.textContent = `
#mw-fab{position:fixed;left:16px;bottom:16px;z-index:9998;border:1px solid #f0cf78;background:#d4a843;color:#0b0a08;font:700 14px system-ui,sans-serif;padding:11px 18px;border-radius:999px;cursor:pointer;box-shadow:0 8px 24px rgba(0,0,0,.5)}
body.has-player #mw-fab{bottom:calc(96px + env(safe-area-inset-bottom,0px))}
@media(max-width:600px){#mw-fab{padding:9px 14px;font-size:13px}}
#mw-bar{position:fixed;left:0;right:0;bottom:0;z-index:9999;background:#100e0a;border-top:2px solid #d4a843;color:#f3ecdc;font:14px system-ui,sans-serif;padding:12px 16px calc(12px + env(safe-area-inset-bottom,0px));display:grid;gap:10px;box-shadow:0 -12px 30px rgba(0,0,0,.6);max-height:55vh;overflow:auto}
#mw-bar[hidden],#mw-fab[hidden],#mw-linkrow[hidden]{display:none!important}
#mw-bar .r{display:flex;flex-wrap:wrap;gap:10px;align-items:center}
#mw-bar button,#mw-bar select,#mw-bar input[type=text]{font:600 16px system-ui,sans-serif;border:1px solid #3a3223;background:#1d1a14;color:#f3ecdc;border-radius:8px;padding:8px 12px}
#mw-bar button.p{background:#d4a843;color:#0b0a08;border-color:#f0cf78}
#mw-bar input[type=color]{width:34px;height:30px;border:1px solid #3a3223;border-radius:6px;background:none;padding:0}
#mw-bar label{display:inline-flex;gap:6px;align-items:center;color:#a99f8b}
#mw-bar #mw-link{flex:1;min-width:220px}
body.mw-editing [data-orig]{outline:1px dashed rgba(212,168,67,.55);outline-offset:2px;cursor:text}
body.mw-editing [data-orig]:focus{outline:2px solid #f0cf78;background:rgba(212,168,67,.12)}
body.mw-editing{padding-bottom:300px}
.mw-blocks{display:grid;gap:14px;margin:24px auto 0;max-width:880px}
.mw-block{display:grid;gap:10px;text-align:center;justify-items:center}
.mw-block h3{font-family:var(--display,Georgia,serif);color:var(--gold-hi,#f0cf78);font-size:24px;margin:0}
.mw-block p{margin:0;white-space:pre-wrap;color:var(--text,#f3ecdc)}`;
    document.head.appendChild(css);
    const fab = document.createElement("button"); fab.id = "mw-fab"; fab.type = "button"; fab.hidden = true; fab.textContent = "✎ Edit site";
    bar = document.createElement("div"); bar.id = "mw-bar"; bar.hidden = true;
    const views = [...document.querySelectorAll("section.view")].map((s) => s.id.replace(/^v-/, ""));
    const name = (v) => v.charAt(0).toUpperCase() + v.slice(1);
    bar.innerHTML = `
<div class="r"><b style="color:#f0cf78">Editing Meechie's World</b>
 <span style="color:#a99f8b">Tap any text on the page and type. Changes save by themselves.</span>
 <span id="mw-status" style="margin-left:auto"></span>
 <button class="p" type="button" id="mw-done">Done</button></div>
<div class="r" style="display:grid;gap:8px"><b style="color:#f0cf78">✨ Tell the AI what to change</b>
 <div style="display:flex;gap:8px"><input type="text" id="mw-ai-in" placeholder="e.g. Change the home title to Welcome to Meechie's World and make the gold more orange" style="flex:1;min-width:0"><button class="p" type="button" id="mw-ai-go">Ask</button></div>
 <div id="mw-ai-out" hidden style="background:#1d1a14;border:1px solid #3a3223;border-radius:10px;padding:10px 12px;display:grid;gap:8px"></div></div>
<div class="r"><label><input type="checkbox" id="mw-autoplay"> Radio starts when someone opens the site</label></div>
<div class="r"><label>Go to page <select id="mw-go">${views.map((v) => `<option value="${v}">${name(v)}</option>`).join("")}</select></label>
 ${THEME.map(([k, n]) => `<label>${n} <input type="color" data-var="${k}" value="${theme[k] || DEFAULTS[k]}"></label>`).join("")}
 <button type="button" id="mw-rc">Reset colors</button>
 <button type="button" id="mw-ra">Undo all my edits</button></div>
<div class="r" style="display:grid;gap:8px"><b style="color:#f0cf78">Payments: paste your Stripe payment links</b>
 ${PAY.map(([k, n]) => `<label style="display:grid;grid-template-columns:minmax(120px,190px) 1fr;gap:8px;color:#a99f8b">${n}<input type="text" data-paylink="${k}" placeholder="https://buy.stripe.com/..." value="${(pay[k] || "").replace(/"/g, "&quot;")}"></label>`).join("")}</div>
<div class="r" id="mw-linkrow" hidden><label style="flex:1">Link for this button/text <input type="text" id="mw-link" placeholder="https://"></label></div>
<div class="r"><span style="color:#a99f8b">Show these pages to visitors:</span>
 ${views.filter((v) => v !== "home").map((v) => `<label><input type="checkbox" data-pg="${v}" ${hidden.includes(v) ? "" : "checked"}> ${name(v)}</label>`).join("")}</div>`;
    document.body.append(fab, bar);

    fab.addEventListener("click", () => setEditing(true));
    bar.querySelector("#mw-done").addEventListener("click", () => setEditing(false));
    const ap = bar.querySelector("#mw-autoplay"); ap.checked = autoplay;
    ap.addEventListener("change", () => { autoplay = ap.checked; if (window.MW_SITE) window.MW_SITE.autoplay = autoplay; save(); });
    bar.querySelector("#mw-ai-go").addEventListener("click", askAI);
    bar.querySelector("#mw-ai-in").addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); e.stopPropagation(); askAI(); } });
    bar.querySelector("#mw-go").addEventListener("change", (e) => { if (typeof window.go === "function") window.go(e.target.value); });
    bar.querySelectorAll("input[type=color]").forEach((i) => i.addEventListener("input", () => {
      theme[i.dataset.var] = i.value; applyAll(); save();
    }));
    bar.querySelector("#mw-rc").addEventListener("click", () => { theme = {}; applyAll(); bar.querySelectorAll("input[type=color]").forEach((i) => (i.value = DEFAULTS[i.dataset.var])); save(); });
    const ra = bar.querySelector("#mw-ra");
    ra.addEventListener("click", () => { if (ra.dataset.sure) { map = {}; links = {}; blocks = []; delete ra.dataset.sure; ra.textContent = "Undo all my edits"; applyAll(); save(); } else { ra.dataset.sure = "1"; ra.textContent = "Tap again to undo everything"; setTimeout(() => { delete ra.dataset.sure; ra.textContent = "Undo all my edits"; }, 4000); } });
    bar.querySelectorAll("input[data-pg]").forEach((i) => i.addEventListener("change", () => {
      hidden = hidden.filter((v) => v !== i.dataset.pg); if (!i.checked) hidden.push(i.dataset.pg); save();
    }));
    bar.querySelectorAll("input[data-paylink]").forEach((i) => i.addEventListener("change", () => {
      const v = i.value.trim();
      if (v && !/^https:\/\/(buy\.stripe\.com|checkout\.stripe\.com|donate\.stripe\.com)\//.test(v)) { status("That doesn't look like a Stripe payment link (it should start with https://buy.stripe.com/)", true); return; }
      if (v) pay[i.dataset.paylink] = v; else delete pay[i.dataset.paylink];
      applyPay(); save();
    }));
    bar.querySelector("#mw-link").addEventListener("change", (e) => {
      const o = e.target.dataset.orig, v = e.target.value.trim(); if (!o) return;
      if (v) links[o] = v; else delete links[o];
      tagged.forEach((t) => { if (t.dataset.orig === o && t.tagName === "A" && v) t.setAttribute("href", v); }); save();
    });

    /* block navigation while editing, but allow typing */
    window.addEventListener("click", (e) => {
      if (!editing || e.target.closest("#mw-bar")) return;
      if (e.target.closest("a,button,[data-go],[role=button],label,summary")) { e.preventDefault(); e.stopPropagation(); }
    }, true);
    document.addEventListener("focusin", (e) => { if (editing && e.target.dataset && e.target.dataset.orig !== undefined) showLink(e.target); });
    document.addEventListener("focusout", (e) => { if (editing && e.target.dataset && e.target.dataset.orig !== undefined) commit(e.target); });
    document.addEventListener("keydown", (e) => {
      if (!editing || !e.target.dataset || e.target.dataset.orig === undefined) return;
      if (e.key === "Enter") { e.preventDefault(); e.target.blur(); }
      if (e.key === " " || e.key === "Enter") e.stopPropagation(); // keep spaces from "pressing" buttons
    }, true);
    document.addEventListener("keyup", (e) => { if (editing && e.key === " " && e.target.tagName === "BUTTON") e.preventDefault(); }, true);
  }

  document.addEventListener("click", (e) => {
    const a = e.target.closest("[data-pay]"); if (!a || editing) return;
    e.preventDefault();
    const u = pay[a.dataset.pay];
    if (!u) { if (admin) { setEditing(true); const f = document.querySelector(`[data-paylink="${a.dataset.pay}"]`); if (f) { f.scrollIntoView({ block: "center" }); f.focus(); } } return; }
    const url = new URL(u); const s = window.MW && MW.session && MW.session();
    if (s && s.user) { url.searchParams.set("client_reference_id", s.user.id); if (s.user.email) url.searchParams.set("prefilled_email", s.user.email); }
    window.open(url.toString(), "_blank", "noopener");
  });
  async function init() {
    if (new URLSearchParams(location.search).get("paid")) {
      history.replaceState(null, "", location.pathname + location.hash);
      setTimeout(() => { if (typeof toast === "function") toast("Payment received. Thank you! We'll be in touch."); }, 600);
    }
    tagAll();
    const c = safe(() => JSON.parse(localStorage.getItem("mw_site") || "null"));
    if (c) { load(c); applyAll(); }
    if (!window.claude) return;
    db = await window.claude.use("db");
    if (!db) return;
    const user = await window.claude.use("user");
    admin = !!(user && user.isOwner && user.isOwner());
    db.doc("site/content").onSnapshot((snap) => {
      if (editing) return; // never overwrite while the owner is typing
      load(snap.exists ? snap.data() : null); cache(); applyAll();
    }, () => {});
    if (admin) { safe(() => localStorage.setItem("mw_owner_device", "1")); buildUI(); document.getElementById("mw-fab").hidden = false; }
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init); else init();
})();
