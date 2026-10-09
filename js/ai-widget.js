/* Meechie's AI chat bubble: available on every page. Uses /api/ai (signed-in members). */
(function () {
  "use strict";
  const E = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const fmt = (t) => E(t).replace(/\*\*(.+?)\*\*/g, "<b>$1</b>").replace(/\((https:\/\/[^\s)]+)\)/g, (m, u) => `(<a href="${u}" target="_blank" rel="noopener" style="color:var(--gold-hi,#f0cf78)">link</a>)`).replace(/\n/g, "<br>");
  const CHIPS = ["What services do you offer?", "How do I promote my business?", "What's in the shop?", "How do I submit a clothing design?", "How do I pay or book?"];
  let hist = [];
  try { hist = JSON.parse(sessionStorage.getItem("mw_ai") || "[]"); } catch (_) { hist = []; }
  let busy = false;

  const css = document.createElement("style");
  css.textContent = `
#ai-fab{position:fixed;right:16px;bottom:16px;z-index:9997;display:flex;align-items:center;gap:8px;border:1px solid var(--gold-hi,#f0cf78);background:linear-gradient(180deg,#1d1810,#0f0d09);color:var(--gold-hi,#f0cf78);font:700 14px system-ui,sans-serif;padding:11px 16px;border-radius:999px;cursor:pointer;box-shadow:0 10px 28px rgba(0,0,0,.55)}
#ai-fab .dot{width:9px;height:9px;border-radius:50%;background:#6fbf8b;box-shadow:0 0 0 3px rgba(111,191,139,.25)}
body.has-player #ai-fab,body.has-player #ai-panel{bottom:calc(96px + env(safe-area-inset-bottom,0px))}
body.has-player #ai-panel{height:min(520px,calc(100vh - 180px))}
@media(max-width:600px){#ai-fab{padding:9px 13px;font-size:13px}}
#ai-panel{position:fixed;right:16px;bottom:16px;z-index:9998;width:min(380px,calc(100vw - 32px));height:min(560px,calc(100vh - 100px));display:flex;flex-direction:column;background:#100e0a;border:1px solid var(--gold,#d4a843);border-radius:18px;box-shadow:0 24px 60px rgba(0,0,0,.7);overflow:hidden;color:var(--text,#f3ecdc)}
#ai-panel[hidden],#ai-fab[hidden]{display:none!important}
#ai-panel header{display:flex;align-items:center;gap:10px;padding:12px 14px;border-bottom:1px solid var(--line,#3a3223);background:linear-gradient(180deg,#1d1810,#100e0a)}
#ai-panel header b{color:var(--gold-hi,#f0cf78);font-family:var(--display,Georgia,serif);font-size:17px}
#ai-panel header small{color:var(--muted,#a99f8b);display:block;font-size:12px}
#ai-panel header button{margin-left:auto;background:none;border:0;color:var(--muted,#a99f8b);font-size:22px;cursor:pointer;line-height:1}
#ai-log2{flex:1;overflow:auto;padding:14px;display:flex;flex-direction:column;gap:8px}
.ai-m{max-width:85%;padding:9px 12px;border-radius:14px 14px 14px 4px;background:var(--panel-2,#1d1a14);border:1px solid var(--line,#3a3223);font-size:14px;line-height:1.45;align-self:flex-start;overflow-wrap:anywhere}
.ai-m.me{align-self:flex-end;background:rgba(212,168,67,.16);border-color:var(--gold-lo,#8c6d26);border-radius:14px 14px 4px 14px}
.ai-chips{display:flex;flex-wrap:wrap;gap:6px;padding:0 14px 10px}
.ai-chips button{background:none;border:1px solid var(--gold-lo,#8c6d26);color:var(--gold-hi,#f0cf78);border-radius:999px;padding:6px 10px;font:600 12px system-ui,sans-serif;cursor:pointer}
#ai-form2{display:flex;gap:8px;padding:10px;border-top:1px solid var(--line,#3a3223)}
#ai-form2 input{flex:1;min-width:0;background:var(--ink,#0b0a08);border:1px solid var(--line,#3a3223);border-radius:999px;padding:10px 14px;color:var(--text,#f3ecdc);font:inherit}
#ai-form2 button{background:var(--gold,#d4a843);color:#0b0a08;border:0;border-radius:999px;padding:0 16px;font-weight:800;cursor:pointer}
.ai-typing{display:inline-flex;gap:4px}.ai-typing i{width:6px;height:6px;border-radius:50%;background:var(--gold,#d4a843);animation:aiB 1s infinite}.ai-typing i:nth-child(2){animation-delay:.15s}.ai-typing i:nth-child(3){animation-delay:.3s}
@keyframes aiB{0%,80%,100%{opacity:.25}40%{opacity:1}}
body.mw-editing #ai-fab{display:none!important}`;
  document.head.appendChild(css);

  const fab = document.createElement("button");
  fab.id = "ai-fab"; fab.type = "button"; fab.innerHTML = '<span class="dot"></span>Ask Meechie\'s AI';
  const panel = document.createElement("section");
  panel.id = "ai-panel"; panel.hidden = true; panel.setAttribute("aria-label", "Meechie's AI chat");
  panel.innerHTML = `<header><svg class="sqc-ico" aria-hidden="true" style="width:30px;height:30px"><use href="#sqc"/></svg><div><b>Meechie's AI</b><small>Answers 24/7 · any language</small></div><button type="button" id="ai-close" aria-label="Close">×</button></header>
<div id="ai-log2" aria-live="polite"></div><div class="ai-chips" id="ai-chips"></div>
<form id="ai-form2"><input id="ai-in2" aria-label="Ask Meechie's AI" maxlength="500" autocomplete="off" placeholder="Ask anything about Meechie's World"><button type="submit">Send</button></form>`;
  document.body.append(fab, panel);
  const log = panel.querySelector("#ai-log2"), chips = panel.querySelector("#ai-chips"), inp = panel.querySelector("#ai-in2");

  function signedIn() { const s = window.MW && MW.session && MW.session(); return !!(s && s.user); }
  function draw(thinking) {
    const hello = `<div class="ai-m">Hi! I'm Meechie's AI. Ask me about services and prices, promotion, the shop, clothing designs, or how anything on the site works.</div>`;
    log.innerHTML = hello + hist.map((m) => `<div class="ai-m ${m.role === "user" ? "me" : ""}">${fmt(m.content)}</div>`).join("") + (thinking ? `<div class="ai-m"><span class="ai-typing"><i></i><i></i><i></i></span></div>` : "");
    if (!signedIn()) log.innerHTML += `<div class="ai-m">Join free (it takes 20 seconds) to chat with me.<br><button class="btn sm" type="button" data-auth="signup" style="margin-top:8px">Join free</button> <button class="btn sm ghost" type="button" data-auth="signin" style="margin-top:8px">Sign in</button></div>`;
    chips.innerHTML = hist.length ? "" : CHIPS.map((c) => `<button type="button">${E(c)}</button>`).join("");
    log.scrollTop = log.scrollHeight;
  }
  async function ask(q) {
    if (busy || !q.trim()) return;
    if (!signedIn()) { if (typeof openAuth === "function") openAuth("signup"); return; }
    hist.push({ role: "user", content: q.trim().slice(0, 500) }); busy = true; draw(true);
    let reply;
    try {
      const tok = MW.session().access_token;
      const r = await fetch("/api/ai", { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer " + tok }, body: JSON.stringify({ messages: hist.slice(-12) }) });
      const j = await r.json().catch(() => ({}));
      reply = r.ok && j.reply ? j.reply + (j.sources && j.sources.length ? "\n\nSources: " + j.sources.map((x, i) => "[" + (i + 1) + "] " + x.title + " (" + x.url + ")").join("  ") : "") : (j.error === "busy" ? "I'm getting a lot of questions right now. Try again in a minute, or DM @meechiesworldinc on TikTok." : "I can't answer right now. DM @meechiesworldinc on TikTok or email meechiesworldinc@aol.com.");
    } catch (_) { reply = "I can't connect right now. Check your internet and try again."; }
    hist.push({ role: "assistant", content: reply }); hist = hist.slice(-24);
    try { sessionStorage.setItem("mw_ai", JSON.stringify(hist)); } catch (_) {}
    busy = false; draw(false);
  }
  fab.addEventListener("click", () => { panel.hidden = false; fab.hidden = true; draw(false); setTimeout(() => inp.focus(), 50); });
  panel.querySelector("#ai-close").addEventListener("click", () => { panel.hidden = true; fab.hidden = false; });
  chips.addEventListener("click", (e) => { const b = e.target.closest("button"); if (b) ask(b.textContent); });
  panel.querySelector("#ai-form2").addEventListener("submit", (e) => { e.preventDefault(); const q = inp.value; inp.value = ""; ask(q); });
  // hide the bubble on the Contact page, which already has the full AI box
  const contact = document.getElementById("v-contact");
  const sync = () => { if (panel.hidden) fab.hidden = !!(contact && !contact.hidden); };
  if (contact) new MutationObserver(sync).observe(contact, { attributes: true, attributeFilter: ["hidden"] });
  sync();
})();
