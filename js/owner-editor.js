/*
 * Owner editor chunk for Meechie's World — the "Edit site" UI: buildUI,
 * edit mode and the owner AI assist. Split out of js/owner.js (lever 4):
 * the core kicks this file ONLY for owner sessions, so guests and members
 * never fetch it. It registers through window.__mwOwnerAttach and works
 * on the core's shared state — the same objects, which the core updates
 * in place (see load() in owner.js).
 */
(function () {
  "use strict";
  if (!window.__mwOwnerAttach) return;
  const CODER_SRC = (() => { const s = document.currentScript && document.currentScript.src; return s ? s.replace(/owner-editor\.js([?#].*)?$/, "site-coder-ui.js$1") : "js/site-coder-ui.js"; })();
  window.__mwOwnerAttach((C) => {
    const map = C.map, links = C.links, theme = C.theme, hidden = C.hidden, pay = C.pay, blocks = C.blocks, tagged = C.tagged;
    const THEME = C.THEME, PAY = C.PAY, DEFAULTS = C.DEFAULTS;
    const save = C.save, status = C.status, applyAll = C.applyAll, applyPay = C.applyPay;
    let aiPending = null, bar = null, editing = false;

  /* ---- edit mode ---- */
  function setEditing(on) {
    editing = on; C.setEditing(on); document.body.classList.toggle("mw-editing", on);
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
        body: JSON.stringify({ request: q, view: currentView(), views, hidden, theme, autoplay: C.autoplay, blocks: blocks.map((b) => ({ id: b.id, view: b.view, title: b.title })), texts: texts.map(({ id, text }) => ({ id, text })) }) });
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
    const nhA = hidden.filter((v) => !p.show.includes(v)); hidden.splice(0, hidden.length, ...nhA); p.hide.forEach((v) => { if (!hidden.includes(v)) hidden.push(v); });
    const nbA = blocks.filter((b) => !p.rem.includes(b.id)).concat(p.add); blocks.splice(0, blocks.length, ...nbA);
    if (p.ap !== null) C.autoplay = p.ap;
    aiPending = null; applyAll(); save();
    const out = document.getElementById("mw-ai-out"); out.innerHTML = "<span style='color:#8fd6a8'>Done ✓ Changes are live. Use “Undo all my edits” if you don't like them.</span>";
    document.getElementById("mw-ai-in").value = "";
    if (bar) { bar.querySelectorAll("input[type=color]").forEach((i) => (i.value = theme[i.dataset.var] || DEFAULTS[i.dataset.var])); bar.querySelectorAll("input[data-pg]").forEach((i) => (i.checked = !hidden.includes(i.dataset.pg))); const a = bar.querySelector("#mw-autoplay"); if (a) a.checked = C.autoplay; }
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
    const ap = bar.querySelector("#mw-autoplay"); ap.checked = C.autoplay;
    ap.addEventListener("change", () => { C.autoplay = ap.checked; if (window.MW_SITE) window.MW_SITE.autoplay = C.autoplay; save(); });
    bar.querySelector("#mw-ai-go").addEventListener("click", askAI);
    bar.querySelector("#mw-ai-in").addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); e.stopPropagation(); askAI(); } });
    bar.querySelector("#mw-go").addEventListener("change", (e) => { if (typeof window.go === "function") window.go(e.target.value); });
    bar.querySelectorAll("input[type=color]").forEach((i) => i.addEventListener("input", () => {
      theme[i.dataset.var] = i.value; applyAll(); save();
    }));
    bar.querySelector("#mw-rc").addEventListener("click", () => { for (const k in theme) delete theme[k]; applyAll(); bar.querySelectorAll("input[type=color]").forEach((i) => (i.value = DEFAULTS[i.dataset.var])); save(); });
    const ra = bar.querySelector("#mw-ra");
    ra.addEventListener("click", () => { if (ra.dataset.sure) { for (const k in map) delete map[k]; for (const k in links) delete links[k]; blocks.length = 0; delete ra.dataset.sure; ra.textContent = "Undo all my edits"; applyAll(); save(); } else { ra.dataset.sure = "1"; ra.textContent = "Tap again to undo everything"; setTimeout(() => { delete ra.dataset.sure; ra.textContent = "Undo all my edits"; }, 4000); } });
    bar.querySelectorAll("input[data-pg]").forEach((i) => i.addEventListener("change", () => {
      const nhB = hidden.filter((v) => v !== i.dataset.pg); hidden.splice(0, hidden.length, ...nhB); if (!i.checked) hidden.push(i.dataset.pg); save();
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

    /* the AI-coder box rides the same owner-only kick: it mounts only
       into #mw-bar, which buildUI creates, and observes for it */
    try { const cs = document.createElement("script"); cs.src = CODER_SRC; (document.head || document.documentElement).appendChild(cs); } catch (_) {}
    return { buildUI, setEditing };
  });
})();
