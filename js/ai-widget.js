/* Meechie's AI chat bubble: available on every page. Uses /api/ai (signed-in members). */
(function () {
  "use strict";
  const E = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const fmt = (t) => E(t).replace(/^#{1,4}\s*(.+)$/gm, "<b>$1</b>").replace(/^\s*[-*•]\s+/gm, "• ").replace(/\*\*(.+?)\*\*/g, "<b>$1</b>").replace(/(^|[\s(])(https:\/\/[^\s<)]+)(?=$|[\s)])/g, (m, p, u) => p + `<a href="${u}" target="_blank" rel="noopener" style="color:var(--gold-hi,#f0cf78)">${u.replace(/^https:\/\/(www\.)?/, "").slice(0, 40)}</a>`).replace(/\((https:\/\/[^\s)]+)\)/g, (m, u) => `(<a href="${u}" target="_blank" rel="noopener" style="color:var(--gold-hi,#f0cf78)">link</a>)`).replace(/\n/g, "<br>");
  const CHIPS = ["🧭 Take me to the radio", "⚖️ Help with my court case", "What services do you offer?", "How do I promote my business?", "What's in the shop?", "How do I submit a clothing design?", "How do I pay or book?"];
  let hist = [];
  try { hist = JSON.parse(localStorage.getItem("mw_ai2") || sessionStorage.getItem("mw_ai") || "[]"); } catch (_) { hist = []; }

  const css = document.createElement("style");
  css.textContent = `
#ai-fab{position:fixed;right:16px;bottom:16px;z-index:9997;display:flex;align-items:center;gap:8px;border:1px solid var(--gold-hi,#f0cf78);background:linear-gradient(180deg,#1d1810,#0f0d09);color:var(--gold-hi,#f0cf78);font:700 14px system-ui,sans-serif;padding:11px 16px;border-radius:999px;cursor:pointer;box-shadow:0 10px 28px rgba(0,0,0,.55)}
.ai-av{width:28px;height:28px;border-radius:50%;object-fit:cover;border:1.5px solid var(--gold-hi,#f0cf78);flex:none;margin:-4px 0 -4px -6px}.ai-av.lg{width:38px;height:38px;margin:0}.ai-av.sm{width:26px;height:26px;margin:2px 0 0}
.ai-row{display:flex;gap:7px;align-items:flex-start;max-width:92%}.ai-row .ai-m{max-width:100%}
.ai-acts{display:flex;gap:12px;margin-top:6px}.ai-check{margin-top:8px;padding:8px 10px;border-radius:10px;border:1px dashed var(--gold-lo,#8c6d26);background:rgba(212,168,67,.06);font-size:13px}
.ai-copy{display:block;background:none;border:0;color:var(--muted,#a99f8b);font:600 11px system-ui,sans-serif;cursor:pointer;padding:0;text-decoration:underline}
#ai-fab .dot{width:9px;height:9px;border-radius:50%;background:#6fbf8b;box-shadow:0 0 0 3px rgba(111,191,139,.25)}
body.has-player #ai-fab,body.has-player #ai-panel{bottom:calc(96px + env(safe-area-inset-bottom,0px))}
body.has-player #ai-panel{height:min(520px,calc(100vh - 180px))}
@media(max-width:600px){#ai-fab{padding:9px 13px;font-size:13px}}
#ai-hi{position:fixed;right:16px;bottom:78px;z-index:9996;max-width:272px;background:#171208;border:1px solid var(--gold-hi,#f0cf78);color:#f3e6c8;border-radius:14px;padding:10px 34px 10px 12px;font:500 13px/1.45 system-ui,sans-serif;box-shadow:0 10px 28px rgba(0,0,0,.55);cursor:pointer}body.has-player #ai-hi{bottom:calc(152px + env(safe-area-inset-bottom,0px))}#ai-hi button{position:absolute;top:2px;right:7px;background:none;border:0;color:#cbb26a;font-size:17px;cursor:pointer;padding:2px}
#ai-panel{position:fixed;right:16px;bottom:16px;z-index:9998;width:min(380px,calc(100vw - 32px));height:min(560px,calc(100vh - 100px));display:flex;flex-direction:column;background:#100e0a;border:1px solid var(--gold,#d4a843);border-radius:18px;box-shadow:0 24px 60px rgba(0,0,0,.7);overflow:hidden;color:var(--text,#f3ecdc)}
#ai-panel[hidden],#ai-fab[hidden]{display:none!important}
#ai-panel header{display:flex;flex-wrap:wrap;align-items:center;gap:10px;padding:12px 14px;border-bottom:1px solid var(--line,#3a3223);background:linear-gradient(180deg,#1d1810,#100e0a)}
#ai-panel header>div{flex:1 1 150px;min-width:0}
#ai-panel header b{color:var(--gold-hi,#f0cf78);font-family:var(--display,Georgia,serif);font-size:17px}
#ai-panel header small{color:var(--muted,#a99f8b);display:block;font-size:12px}
#ai-panel header button{margin-left:auto;background:none;border:0;color:var(--muted,#a99f8b);font-size:22px;cursor:pointer;line-height:1}
#ai-log2{flex:1;overflow:auto;padding:14px;display:flex;flex-direction:column;gap:8px}
.ai-m{max-width:85%;padding:9px 12px;border-radius:14px 14px 14px 4px;background:var(--panel-2,#1d1a14);border:1px solid var(--line,#3a3223);font-size:14px;line-height:1.45;align-self:flex-start;overflow-wrap:anywhere}
.ai-m.me{align-self:flex-end;background:rgba(212,168,67,.16);border-color:var(--gold-lo,#8c6d26);border-radius:14px 14px 4px 14px}
.ai-chips{display:flex;flex-wrap:wrap;gap:6px;padding:0 14px 10px}
.ai-chips button{background:none;border:1px solid var(--gold-lo,#8c6d26);color:var(--gold-hi,#f0cf78);border-radius:999px;padding:6px 10px;font:600 12px system-ui,sans-serif;cursor:pointer}
.ai-nav{display:flex;gap:6px;overflow-x:auto;padding:2px 14px 10px;scrollbar-width:none;align-items:center}
.ai-nav::-webkit-scrollbar{display:none}
.ai-nav .ai-navlead{flex:none;font-size:14px}
.ai-nav button{flex:none;background:none;border:1px solid var(--line,#3a3223);color:var(--text,#f3ecdc);border-radius:999px;padding:6px 11px;font:600 12px system-ui,sans-serif;cursor:pointer}
.ai-navb{display:inline-block;margin-top:8px;background:var(--gold,#d4a843);color:#0b0a08;border:0;border-radius:999px;padding:8px 14px;font:800 13px system-ui,sans-serif;cursor:pointer}
#ai-form2{display:flex;gap:8px;padding:10px;border-top:1px solid var(--line,#3a3223)}
#ai-form2 input{flex:1;min-width:0;background:var(--ink,#0b0a08);border:1px solid var(--line,#3a3223);border-radius:999px;padding:10px 14px;color:var(--text,#f3ecdc);font:inherit}
#ai-form2 button{background:var(--gold,#d4a843);color:#0b0a08;border:0;border-radius:999px;padding:0 16px;font-weight:800;cursor:pointer}
#ai-form2 .ai-tool{display:grid;place-items:center;border-radius:999px;cursor:pointer;position:relative;background:none;border:1px solid var(--line,#3a3223);color:var(--text,#f3ecdc);width:40px;padding:0;font-size:17px;flex:none;overflow:hidden}
#ai-form2 .ai-tool.on{background:#e5484d;border-color:#e5484d;color:#fff}
#ai-form2 .ai-tool input{position:absolute;inset:0;opacity:0;cursor:pointer}
#ai-attach{display:flex;align-items:center;gap:8px;padding:6px 12px 0;font-size:12px;color:var(--muted,#a99f8b)}#ai-attach img{width:44px;height:44px;object-fit:cover;border-radius:8px;border:1px solid var(--line,#3a3223)}
#ai-panel header .ai-spk{margin-left:auto;font-size:18px}#ai-panel header #ai-new+.ai-spk{margin-left:6px}#ai-panel header #ai-new{color:var(--gold-hi,#f0cf78);white-space:nowrap;flex:none}#ai-panel header .ai-spk+button{margin-left:6px}
#ai-model{background:var(--ink,#0b0a08);color:var(--gold-hi,#f0cf78);border:1px solid var(--line,#3a3223);border-radius:999px;padding:5px 6px;font:600 11px system-ui,sans-serif;max-width:none;flex:1 1 100%;order:9;width:100%}
.ai-m img{max-width:100%;border-radius:10px;display:block;margin-bottom:6px}
.ai-typing{display:inline-flex;gap:4px}.ai-typing i{width:6px;height:6px;border-radius:50%;background:var(--gold,#d4a843);animation:aiB 1s infinite}.ai-typing i:nth-child(2){animation-delay:.15s}.ai-typing i:nth-child(3){animation-delay:.3s}
@keyframes aiB{0%,80%,100%{opacity:.25}40%{opacity:1}}
#ai-talkbtn{display:block;width:100%;text-align:center;background:linear-gradient(180deg,#241c0e,#171208);border:0;border-bottom:1px solid var(--line,#3a3223);color:var(--gold-hi,#f0cf78);font:700 13.5px system-ui,sans-serif;padding:9px;cursor:pointer;flex:none}
#ai-stage{display:grid;justify-items:center;gap:9px;padding:16px 14px 12px;border-bottom:1px solid var(--line,#3a3223);background:radial-gradient(ellipse 90% 120% at 50% 0,rgba(212,168,67,.14),transparent 70%);flex:none}
#ai-stage[hidden]{display:none}
.ai-face{position:relative;width:148px;height:148px;flex:none}
.ai-face img{width:100%;height:100%;object-fit:cover;border-radius:50%;border:3px solid var(--gold,#d4a843);position:relative;z-index:2;background:#1d1810}
.ai-face .rg{position:absolute;inset:0;border-radius:50%;border:2px solid rgba(212,168,67,.55);z-index:1;pointer-events:none}
#ai-stage[data-state="listening"] .rg.a{animation:aiPulse 1.3s ease-out infinite}
#ai-stage[data-state="listening"] .rg.b{animation:aiPulse 1.3s ease-out .45s infinite}
#ai-stage[data-state="idle"] .ai-face img{animation:aiBreath 4s ease-in-out infinite}
#ai-stage[data-state="thinking"] .rg.a{border-style:dashed;animation:aiSpin 2.4s linear infinite}
#ai-stage[data-state="speaking"] .ai-face img{animation:aiTalk .5s ease-in-out infinite alternate}
@keyframes aiPulse{0%{transform:scale(1);opacity:.85}100%{transform:scale(1.5);opacity:0}}
@keyframes aiSpin{to{transform:rotate(360deg)}}
@keyframes aiBreath{0%,100%{transform:scale(1)}50%{transform:scale(1.025)}}
@keyframes aiTalk{from{transform:scale(1)}to{transform:scale(1.05)}}
.ai-wave{display:none;gap:3px;align-items:center;height:22px}
#ai-stage[data-state="speaking"] .ai-wave{display:flex}
.ai-wave i{width:4px;height:14px;background:var(--gold,#d4a843);border-radius:2px;animation:aiWv .7s ease-in-out infinite}
.ai-wave i:nth-child(2){animation-delay:.1s}.ai-wave i:nth-child(3){animation-delay:.2s}.ai-wave i:nth-child(4){animation-delay:.3s}.ai-wave i:nth-child(5){animation-delay:.4s}.ai-wave i:nth-child(6){animation-delay:.5s}.ai-wave i:nth-child(7){animation-delay:.6s}
@keyframes aiWv{0%,100%{transform:scaleY(.4)}50%{transform:scaleY(1.5)}}
#ai-stage-st{margin:0;color:var(--muted,#a99f8b);font-size:13.5px;text-align:center;min-height:2.5em;max-width:300px;line-height:1.35}
.ai-stage-row{display:flex;gap:8px}
#ai-panel.talking{height:min(720px,calc(100vh - 56px))}
body.mw-editing #ai-fab{display:none!important}`;
  document.head.appendChild(css);

  const fab = document.createElement("button");
  fab.id = "ai-fab"; fab.type = "button"; fab.innerHTML = '<img class="ai-av" src="/img/meechie-ai.jpg" alt=""><span class="dot"></span>Ask Meechie (AI)';
  const panel = document.createElement("section");
  panel.id = "ai-panel"; panel.hidden = true; panel.setAttribute("aria-label", "Chat with Meechie, the AI assistant");
  panel.innerHTML = `<header><img class="ai-av lg" src="/img/meechie-ai.jpg" alt="Meechie"><div><b>Meechie · AI</b><small>Answers 24/7 · talk, type, send a photo, or draft legal papers</small></div><select id="ai-model" aria-label="Choose Meechie's brain or an image maker" title="Pick a brain — every AI model on Cloudflare, wired in"><option value="auto">✨ Auto</option><option value="quick">⚡ Quick</option><option value="deep">🧠 Deep</option></select><button type="button" id="ai-new" title="Start a new chat" aria-label="Start a new chat" style="font-size:14px;border:1px solid var(--line,#3a3223);border-radius:999px;padding:4px 10px;margin-left:auto">＋ New</button><button type="button" class="ai-spk" id="ai-spk" aria-label="Read answers out loud" title="Read answers out loud">🔈</button><button type="button" id="ai-close" aria-label="Close">×</button></header>
<button type="button" id="ai-talkbtn">🎙️ Talk to Meechie — tap for a voice chat</button>
<div id="ai-stage" data-state="idle" hidden>
<div class="ai-face"><img src="/img/meechie-ai.jpg" alt="Meechie"><span class="rg a"></span><span class="rg b"></span></div>
<div class="ai-wave" aria-hidden="true"><i></i><i></i><i></i><i></i><i></i><i></i><i></i></div>
<p id="ai-stage-st">A real conversation: talk, and Meechie listens, answers out loud, then listens again.</p>
<div class="ai-stage-row"><button type="button" id="ai-talk-go" class="btn">🎙️ Start talking</button><button type="button" id="ai-talk-stop" class="btn ghost" hidden>⏹ End call</button></div>
</div>
<div id="ai-log2" aria-live="polite"></div><div class="ai-chips" id="ai-chips"></div>
<div class="ai-nav" id="ai-nav" aria-label="Jump to a section"></div>
<div id="ai-attach" hidden></div>
<form id="ai-form2"><label class="ai-tool" id="ai-pic" aria-label="Send a photo">📷<input type="file" accept="image/*" id="ai-file" aria-label="Choose a photo"></label><button type="button" class="ai-tool" id="ai-mic" aria-label="Talk to the AI">🎙️</button><input id="ai-in2" aria-label="Ask Meechie" maxlength="1500" autocomplete="off" placeholder="Ask me anything"><button type="submit">Send</button></form>`;
  document.body.append(fab, panel);
  const log = panel.querySelector("#ai-log2"), chips = panel.querySelector("#ai-chips"), inp = panel.querySelector("#ai-in2");
  /* site navigation: a jump-to row in the panel, plus [[nav:view]] markers in Meechie's
     answers that render as Go buttons — ask "where is X" or "take me to X" and he sends you */
  const NAVS = [["🏠", "home", "Home"], ["📖", "community", "Book"], ["🛠️", "services", "Services"], ["🛍️", "shop", "Shop"], ["📻", "radio", "Radio"], ["🎛️", "dj", "DJ"], ["🎬", "clips", "Clips"], ["📺", "videos", "Videos"], ["🔴", "live", "Live"], ["❤️", "dating", "Dating"], ["💬", "messages", "Messages"], ["🪙", "coin", "Coin"], ["🌍", "world", "World"], ["🎮", "games", "Games"], ["⚖️", "legal", "Legal"], ["🖤", "amani", "Amani"]];
  const NAVLBL = { home: "Home", community: "Meechie's Book", services: "Services", shop: "the Shop", radio: "Radio", dj: "the DJ Station", clips: "Clips", videos: "Videos", live: "Live", livetv: "Live TV", liveradio: "Live Radio", friends: "Friends", dating: "Dating", coin: "Meechie's Coin", world: "the Virtual World", games: "Games", creators: "Creators", legal: "Legal Help", amani: "Amani", mwtv: "MW TV", tv: "Movies & TV", watch: "Watch the Setup", chat: "Chat & Walkie", messages: "Messages", connect: "Connect", books: "Books", studio: "Studio", markets: "Markets", predict: "Predictions", promote: "Promote", contact: "Contact" };
  const navRow = panel.querySelector("#ai-nav");
  navRow.innerHTML = '<span class="ai-navlead" aria-hidden="true">🧭</span>' + NAVS.map(([em, v, t]) => `<button type="button" data-navgo="${v}">${em} ${t}</button>`).join("");
  function goTo(v) { if (typeof go === "function") { go(v); panel.hidden = true; sync(); } }
  navRow.addEventListener("click", (e) => { const b = e.target.closest("[data-navgo]"); if (b) goTo(b.dataset.navgo); });
  const GREET = "Hey, I'm Meechie — Meechie's AI assistant. I look after his people here, and I talk out loud: tap Talk to Meechie up top for a full voice chat, tap the mic and speak, or just type below. I can take you anywhere here: the live radio and DJ tables, the shop, the videos and movies, your messages — or help you book and buy. What are you looking for today?";
  /* Host brain (PR-B3): a signed-in member with memory gets a welcome-back
     greeting — their name, the artist who was on the decks last time — in
     the panel, in the arrival bubble, and spoken out loud. The memory is
     theirs alone (GET /api/brain/me answers only the caller's own session),
     the visit is reported once per session through the same door the booth
     uses, and ANY failure or absence of memory leaves every greeting below
     exactly as it has always been, word for word. Guests never trigger any
     of this: there is no session, so there is nothing to look up. */
  const memGreet = { greet: null, hello: null };
  try {
    const mg = sessionStorage.getItem("mw_mem_greet");
    if (mg) { const j = JSON.parse(mg); if (j && j.greet) { memGreet.greet = j.greet; memGreet.hello = j.hello || null; } }
  } catch (_) {}
  (async () => {
    try {
      const s = window.MW && MW.session && MW.session();
      if (!s || !s.access_token || !s.user) return;
      try {
        const r = await fetch("/api/brain/me", { headers: { authorization: "Bearer " + s.access_token } });
        const j = await r.json().catch(() => ({}));
        if (j && j.ok && j.has && j.greet) { memGreet.greet = j.greet; memGreet.hello = j.hello || null; try { sessionStorage.setItem("mw_mem_greet", JSON.stringify({ greet: memGreet.greet, hello: memGreet.hello })); } catch (_) {} }
      } catch (_) {}
      try {
        if (!sessionStorage.getItem("mw_mem_visit")) { sessionStorage.setItem("mw_mem_visit", "1"); await fetch("/api/brain/event", { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer " + s.access_token }, body: JSON.stringify({ events: [{ type: "visit", at: Date.now() }] }) }); }
      } catch (_) {}
    } catch (_) {}
  })();
  const greetNow = () => memGreet.greet || GREET;
  /* ---------- Lever 3 (max-speed, 2026-11-02): the chat machinery lives in
   * js/ai-widget-machinery.js and loads on first AI need — the first tap on
   * the bubble, or the first gesture that triggers the spoken hello below.
   * This shell keeps everything first paint needs: the bubble, the panel
   * skeleton, the arrival card, the member greeting + visit ping. It also
   * fetch-warms the machinery at idle (bytes only, like mwPrefetchLazy, so
   * the first tap is usually instant) — the file executes only on a kick.
   * The machinery registers through __mwAiAttach and receives the shared
   * pieces via aiCtx(); a failed fetch just means a later need retries. */
  const AI_MACH_URL = (() => { try { const s = document.currentScript && document.currentScript.src; if (s) return s.replace(/\/ai-widget\.js(\?|#|$)/, "/ai-widget-machinery.js$1"); } catch (_) {} return "js/ai-widget-machinery.js"; })();
  let aiApi = null, aiLoading = false; const aiWaiters = [];
  function aiCtx() { return { E, fmt, CHIPS, NAVLBL, hist, fab, panel, log, chips, inp, goTo, sync, greetNow }; }
  function aiLoad() {
    if (aiApi || aiLoading) return; aiLoading = true;
    const s = document.createElement("script"); s.src = AI_MACH_URL;
    s.onload = () => { aiLoading = false; };
    s.onerror = () => { aiLoading = false; }; /* a later need retries */
    document.head.appendChild(s);
  }
  function aiKick(cb) { if (aiApi) { if (cb) cb(aiApi); return; } if (cb) aiWaiters.push(cb); aiLoad(); }
  window.__mwAiAttach = function (register) {
    if (aiApi) return;
    let api = null; try { api = register(aiCtx()); } catch (_) {}
    if (!api) return;
    aiApi = api;
    const w = aiWaiters.splice(0);
    for (const cb of w) { try { cb(aiApi); } catch (_) {} }
  };
  try {
    const warm = () => { try { const c = navigator.connection; if (c && (c.saveData || /2g/.test(c.effectiveType || ""))) return; } catch (_) {} try { fetch(AI_MACH_URL).catch(() => {}); } catch (_) {} };
    const arm = () => { if ("requestIdleCallback" in window) requestIdleCallback(warm, { timeout: 4000 }); else setTimeout(warm, 2500); };
    if (document.readyState === "complete") arm(); else window.addEventListener("load", arm);
  } catch (_) {}
  fab.addEventListener("click", () => { panel.hidden = false; fab.hidden = true; aiKick((api) => api.open()); });
  /* says hello when people arrive: one small bubble by the button, once per visit */
  const aiAppMode = (() => { try { const h = document.documentElement.classList; if (h.contains("appmode-ai")) return false; return h.contains("appmode") || (window.matchMedia && matchMedia("(display-mode: standalone)").matches) || !!window.navigator.standalone; } catch (_) { return false; } })(); /* no pop-up greetings inside his apps (owner, 2026-10-28), except the AI app itself where Meechie is the point */
  try { if (!aiAppMode && !sessionStorage.getItem("mw_ai_hi")) { setTimeout(function hiTry(n) { if (!panel.hidden || fab.hidden || document.getElementById("ai-hi") || (window.MW_screenClear && !MW_screenClear("ai-hi")) || (window.MW_popGate && !MW_popGate())) { if ((n|0) < 20) setTimeout(() => hiTry((n|0) + 1), 8000); return; } /* pop-up spacing (owner, 2026-11-02): the gate is checked LAST so a claim only happens when the bubble really shows */ try { sessionStorage.setItem("mw_ai_hi", "1"); } catch (_) {} /* one card at a time (owner rule) */ const bub = document.createElement("div"); bub.id = "ai-hi"; bub.setAttribute("role", "button"); bub.innerHTML = memGreet.hello ? "<b>Meechie AI</b> " + E(memGreet.hello) + " <button type=\"button\" aria-label=\"Dismiss\">×</button>" : "<b>Meechie AI</b> is here. Tap me and I will show you around, and we can talk out loud. <button type=\"button\" aria-label=\"Dismiss\">×</button>"; bub.addEventListener("click", (e) => { bub.remove(); if (!e.target.closest("button")) fab.click(); }); document.body.appendChild(bub); setTimeout(() => { bub.remove(); }, 16000); }, 4500); } } catch (_) {}
  /* and he actually talks to people (owner, 2026-10-27): browsers only allow
     sound after a person touches the page, so on a visitor's very first tap or
     keypress — if they have not opened him yet — he says one short hello out
     loud, once per visit. His voice toggle (🔊) still rules. */
  try { if (!aiAppMode && !sessionStorage.getItem("mw_ai_spoke")) { const hello = () => { window.removeEventListener("pointerdown", hello); window.removeEventListener("keydown", hello); if (!panel.hidden || hist.length) return; try { sessionStorage.setItem("mw_ai_spoke", "1"); } catch (_) {} aiKick((api) => api.speak(memGreet.hello || "Hey, I'm Meechie, Meechie's assistant. I look after everybody here — tap my gold button and I'll show you around.")); }; window.addEventListener("pointerdown", hello); window.addEventListener("keydown", hello); } } catch (_) {}
  panel.querySelector("#ai-close").addEventListener("click", () => { if (aiApi) aiApi.stopTalk(); panel.hidden = true; sync(); });
  // hide the bubble on the Contact page, which already has the full AI box
  const contact = document.getElementById("v-contact"), msgs = document.getElementById("v-messages");
  // also hidden in Messenger, where it would cover the Send button
  const sync = () => { if (panel.hidden) fab.hidden = !!(contact && !contact.hidden) || !!(msgs && !msgs.hidden); };
  [contact, msgs].forEach((v) => v && new MutationObserver(sync).observe(v, { attributes: true, attributeFilter: ["hidden"] }));
  sync();
})();
