/* Meechie's AI chat bubble: available on every page. Uses /api/ai (signed-in members). */
(function () {
  "use strict";
  const E = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const fmt = (t) => E(t).replace(/^#{1,4}\s*(.+)$/gm, "<b>$1</b>").replace(/^\s*[-*•]\s+/gm, "• ").replace(/\*\*(.+?)\*\*/g, "<b>$1</b>").replace(/(^|[\s(])(https:\/\/[^\s<)]+)(?=$|[\s)])/g, (m, p, u) => p + `<a href="${u}" target="_blank" rel="noopener" style="color:var(--gold-hi,#f0cf78)">${u.replace(/^https:\/\/(www\.)?/, "").slice(0, 40)}</a>`).replace(/\((https:\/\/[^\s)]+)\)/g, (m, u) => `(<a href="${u}" target="_blank" rel="noopener" style="color:var(--gold-hi,#f0cf78)">link</a>)`).replace(/\n/g, "<br>");
  const CHIPS = ["🧭 Take me to the radio", "⚖️ Help with my court case", "What services do you offer?", "How do I promote my business?", "What's in the shop?", "How do I submit a clothing design?", "How do I pay or book?"];
  let hist = [];
  try { hist = JSON.parse(localStorage.getItem("mw_ai2") || sessionStorage.getItem("mw_ai") || "[]"); } catch (_) { hist = []; }
  let busy = false;

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
  panel.innerHTML = `<header><img class="ai-av lg" src="/img/meechie-ai.jpg" alt="Meechie"><div><b>Meechie · AI</b><small>Answers 24/7 · talk, type, send a photo, or draft legal papers</small></div><select id="ai-model" aria-label="Choose Meechie's brain or an image maker" title="Pick a brain — every AI model on Cloudflare, wired in"><option value="">✨ Auto brain</option></select><button type="button" id="ai-new" title="Start a new chat" aria-label="Start a new chat" style="font-size:14px;border:1px solid var(--line,#3a3223);border-radius:999px;padding:4px 10px;margin-left:auto">＋ New</button><button type="button" class="ai-spk" id="ai-spk" aria-label="Read answers out loud" title="Read answers out loud">🔈</button><button type="button" id="ai-close" aria-label="Close">×</button></header>
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
  const NAVS = [["🏠", "home", "Home"], ["📖", "community", "Book"], ["🛠️", "services", "Services"], ["🛍️", "shop", "Shop"], ["📻", "radio", "Radio"], ["🎛️", "dj", "DJ"], ["🎬", "clips", "Clips"], ["📺", "videos", "Videos"], ["🔴", "live", "Live"], ["❤️", "dating", "Dating"], ["💬", "messages", "Messages"], ["🪙", "coin", "Coin"], ["🌍", "world", "World"], ["🎮", "games", "Games"], ["⚖️", "legal", "Legal"]];
  const NAVLBL = { home: "Home", community: "Meechie's Book", services: "Services", shop: "the Shop", radio: "Radio", dj: "the DJ Station", clips: "Clips", videos: "Videos", live: "Live", livetv: "Live TV", liveradio: "Live Radio", friends: "Friends", dating: "Dating", coin: "Meechie's Coin", world: "the Virtual World", games: "Games", creators: "Creators", legal: "Legal Help", chat: "Chat & Walkie", messages: "Messages", connect: "Connect", books: "Books", studio: "Studio", markets: "Markets", predict: "Predictions", promote: "Promote", contact: "Contact" };
  const navRow = panel.querySelector("#ai-nav");
  navRow.innerHTML = '<span class="ai-navlead" aria-hidden="true">🧭</span>' + NAVS.map(([em, v, t]) => `<button type="button" data-navgo="${v}">${em} ${t}</button>`).join("");
  function goTo(v) { if (typeof go === "function") { go(v); panel.hidden = true; sync(); } }
  navRow.addEventListener("click", (e) => { const b = e.target.closest("[data-navgo]"); if (b) goTo(b.dataset.navgo); });
  /* every Cloudflare AI model, wired in: pick a brain, or pick an image maker and describe a picture */
  const sel = panel.querySelector("#ai-model");
  const kindOf = {};
  let picked = ""; try { picked = localStorage.getItem("mw_ai_model") || ""; } catch (_) {}
  fetch("/api/ai").then((r) => r.json()).then((j) => {
    const brains = (j.models || []).filter((m) => ["chat", "reasoning", "code", "vision"].includes(m.kind));
    const makers = (j.models || []).filter((m) => m.kind === "image");
    brains.forEach((m) => { kindOf[m.id] = m.kind; }); makers.forEach((m) => { kindOf[m.id] = m.kind; });
    const grp = (label, list) => list.length ? `<optgroup label="${label}">` + list.map((m) => `<option value="${E(m.id)}">${E(m.name)}</option>`).join("") + "</optgroup>" : "";
    sel.innerHTML = `<option value="">✨ Auto brain</option>` + grp("🧠 Brains", brains) + grp("🎨 Image makers", makers);
    if (picked && kindOf[picked]) sel.value = picked; else picked = "";
    if (kindOf[picked] === "image") inp.placeholder = "Describe a picture to draw…";
  }).catch(() => {});
  sel.addEventListener("change", () => { picked = sel.value; try { localStorage.setItem("mw_ai_model", picked); } catch (_) {} inp.placeholder = kindOf[picked] === "image" ? "Describe a picture to draw…" : "Ask me anything"; });

  function signedIn() { const s = window.MW && MW.session && MW.session(); return !!(s && s.user); }
  function draw(thinking) {
    const hello = `<div class="ai-row"><img class="ai-av sm" src="/img/meechie-ai.jpg" alt=""><div class="ai-m">Hey! I'm Meechie, the AI assistant for Meechie's World. Ask me about services and prices, promotion, the shop, clothing designs, or how anything on the site works. I can also explain court procedure and help you draft motions on the Legal Help tab. And I can take you places, too — just say "take me to the shop" and I'll send you there.</div></div>`;
    log.innerHTML = hello + hist.map((m, i) => m.role === "user" ? `<div class="ai-m me">${m.pic ? `<img src="${E(m.pic)}" alt="Photo you sent">` : ""}${fmt(m.content)}</div>` : `<div class="ai-row"><img class="ai-av sm" src="/img/meechie-ai.jpg" alt=""><div class="ai-m">${m.pic ? `<img src="${E(m.pic)}" alt="Picture Meechie AI made">` : ""}${fmt(m.content)}<span class="ai-acts"><button type="button" class="ai-copy" data-copy-i="${i}" aria-label="Copy this answer">Copy</button><button type="button" class="ai-copy" data-check-i="${i}" aria-label="Double-check this answer">🔍 Double-check</button></span>${m.nav ? `<br><button type="button" class="ai-navb" data-nav="${m.nav}">➡️ Go to ${NAVLBL[m.nav] || m.nav}</button>` : ""}${m.check ? `<div class="ai-check">${fmt(m.check)}</div>` : ""}</div></div>`).join("") + (thinking ? `<div class="ai-m"><span class="ai-typing"><i></i><i></i><i></i></span></div>` : "");
    if (!signedIn()) log.innerHTML += `<div class="ai-m">Join free (it takes 20 seconds) to chat with me.<br><button class="btn sm" type="button" data-auth="signup" style="margin-top:8px">Join free</button> <button class="btn sm ghost" type="button" data-auth="signin" style="margin-top:8px">Sign in</button></div>`;
    chips.innerHTML = hist.length ? "" : CHIPS.map((c) => `<button type="button">${E(c)}</button>`).join("");
    log.scrollTop = log.scrollHeight;
  }
  async function ask(q, viaTalk) {
    if (busy || !q.trim()) return;
    if (!signedIn()) { if (typeof openAuth === "function") openAuth("signup"); return; }
    const img = pending; pending = ""; attach.hidden = true;
    hist.push({ role: "user", content: q.trim().slice(0, 4000), ...(img ? { pic: img } : {}) }); busy = true; draw(true);
    if (kindOf[picked] === "image") { // an image maker is picked: the message is a drawing prompt
      let pic = "", errText = "";
      try {
        const r = await fetch("/api/ai", { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer " + MW.session().access_token }, body: JSON.stringify({ model: picked, prompt: q.trim() }) });
        if (r.ok && /^image\//.test(r.headers.get("content-type") || "")) { const b = await r.blob(); pic = await new Promise((res) => { const fr = new FileReader(); fr.onload = () => res(fr.result); fr.onerror = () => res(""); fr.readAsDataURL(b); }); }
        else { const j = await r.json().catch(() => ({})); errText = j.message || "The image maker is busy right now. Try again in a moment."; }
      } catch (_) { errText = "I can't reach the image maker right now. Check your internet and try again."; }
      hist.push({ role: "assistant", content: pic ? "🎨 Here's your picture — long-press it (or right-click) to save it." : errText, ...(pic ? { pic } : {}) }); hist = hist.slice(-40);
      busy = false; draw(false); return;
    }
    let reply;
    try {
      const tok = MW.session().access_token;
      const r = await fetch("/api/ai", { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer " + tok }, body: JSON.stringify({ messages: hist.slice(-20).map((m) => ({ role: m.role, content: m.content })), image: img || undefined, ...(picked && !viaTalk ? { model: picked } : {}), ...(viaTalk ? { voice: true } : {}) }) });
      const j = await r.json().catch(() => ({}));
      reply = r.ok && j.reply ? j.reply + (j.sources && j.sources.length ? "\n\nSources: " + j.sources.map((x, i) => "[" + (i + 1) + "] " + x.title + " (" + x.url + ")").join("  ") : "") : (j.error === "busy" ? "I'm getting a lot of questions right now. Try again in a minute, or DM @meechiesworldinc on TikTok." : "I can't answer right now. DM @meechiesworldinc on TikTok or email meechiesworldinc@aol.com.");
    } catch (_) { reply = "I can't connect right now. Check your internet and try again."; }
    // a [[nav:view]] marker at the end of the answer becomes a Go button; it never shows as text
    let navTo = ""; const nm = /\[\[nav:([a-z]+)\]\]/.exec(reply || "");
    if (nm) { navTo = nm[1]; reply = reply.replace(/\s*\[\[nav:[a-z]+\]\]/g, "").trim(); }
    hist.push({ role: "assistant", content: reply, ...(navTo ? { nav: navTo } : {}) }); hist = hist.slice(-40);
    try { localStorage.setItem("mw_ai2", JSON.stringify(hist.map((m) => ({ role: m.role, content: m.content, ...(m.check ? { check: m.check } : {}), ...(m.nav ? { nav: m.nav } : {}) })))); } catch (_) {}
    busy = false; draw(false);
    if (viaTalk && navTo) goTo(navTo); // hands-free: in talk mode he takes you there right away
    if (viaTalk) playReply(reply); else speak(reply);
  }
  /* read answers out loud */
  let talkBack = true; try { const v0 = localStorage.getItem("mw_ai_voice"); talkBack = v0 === null ? true : v0 === "1"; } catch (_) {}
  const spk = panel.querySelector("#ai-spk"); const paintSpk = () => { spk.textContent = talkBack ? "🔊" : "🔈"; spk.title = talkBack ? "Reading answers out loud (tap to stop)" : "Read answers out loud"; };
  paintSpk();
  spk.addEventListener("click", () => { talkBack = !talkBack; try { localStorage.setItem("mw_ai_voice", talkBack ? "1" : "0"); } catch (_) {} if (!talkBack) haltSpeak(); else unlockSpeech(); paintSpk(); });
  function unlockSpeech() { try { primeSpeakAudio(); if (window.speechSynthesis && !unlockSpeech.done) { unlockSpeech.done = true; speechSynthesis.speak(new SpeechSynthesisUtterance("")); } } catch (_) {} }
  /* Meechie speaks with a man's voice (owner, 2026-10-27): prefer a male device
     voice by name, and never land on a known female voice when a natural
     alternative exists.
     iPhone fix (2026-10-28, owner: the AI voice "sounds crazy" on iPhone):
     Apple ships NOVELTY voices (Zarvox, Trinoids, Bells, Bubbles, Cellos,
     Organ, Wobble, Deranged, Hysterical, Whisper, Good News and friends) plus
     legacy robotic ones — and the old picker could actually CHOOSE the
     robotic set, because its male-name list included Fred, Ralph, Bruce and
     Albert. It also returned nothing whenever the voice list had not loaded
     yet (iOS fills it late, through voiceschanged), leaving the utterance
     voiceless so iOS picked a fallback by itself. Now novelty and legacy
     voices are excluded by name at every step, the list is cached and kept
     fresh on voiceschanged, the first speak waits briefly for the list, and
     pitch and rate are pinned to a natural 1. On iPhone his spoken answers
     use the server voice instead (see speakServer below). */
  const NOVELTY = /zarvox|trinoids|bells|bubbles|cellos|organ|wobble|superstar|bahh|boing|deranged|hysterical|whisper|good news|bad news|\bfred\b|junior|\bralph\b|kathy|\balbert\b|\bbruce\b|grandma|grandpa|\beddy\b|\bflo\b|rocko|sandy|shelley|\breed\b/i;
  let voiceCache = [];
  function refreshVoices() { try { voiceCache = speechSynthesis.getVoices() || []; } catch (_) {} }
  if ("speechSynthesis" in window) { refreshVoices(); try { speechSynthesis.addEventListener("voiceschanged", refreshVoices); } catch (_) { try { speechSynthesis.onvoiceschanged = refreshVoices; } catch (_) {} } }
  function maleVoice() {
    try {
      const vs = voiceCache.length ? voiceCache : (speechSynthesis.getVoices() || []), MALE = /aaron|\bguy\b|david|mark|daniel|george|james|christopher|\beric\b|andrew|brian|\btom\b|\balex\b|arthur|\bmale\b/i, FEM = /samantha|\baria\b|jenny|zira|susan|catherine|allison|\bava\b|joanna|salli|kimberly|\bamy\b|\bemma\b|female/i;
      const ok = (x) => !NOVELTY.test(x.name) && !FEM.test(x.name);
      return vs.find((x) => /en[-_]US/i.test(x.lang) && MALE.test(x.name) && ok(x)) || vs.find((x) => /^en/i.test(x.lang) && MALE.test(x.name) && ok(x)) || vs.find((x) => /en[-_]US/i.test(x.lang) && ok(x) && /natural|neural|google/i.test(x.name)) || null;
    } catch (_) { return null; }
  }
  const IS_IOS = /iP(hone|ad|od)/.test(navigator.userAgent || "") || ((navigator.platform || "") === "MacIntel" && (navigator.maxTouchPoints || 0) > 1);
  /* One reusable audio element plays the server voice for spoken answers.
     It is primed with a silent clip inside real taps (unlockSpeech, the
     speaker toggle, Talk start): that priming is what lets iOS allow the
     same element to play the real answer when it arrives a moment later. */
  let spkAudio = null, spkPrimed = false, speakSeq = 0;
  function primeSpeakAudio() { try { if (spkPrimed) return; if (!spkAudio) { spkAudio = new Audio(); spkAudio.preload = "auto"; spkAudio.playsInline = true; spkAudio.src = "data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQAAAAA="; } spkAudio.muted = true; const p = spkAudio.play(); const settle = () => { try { spkAudio.pause(); spkAudio.muted = false; } catch (_) {} }; if (p && p.then) p.then(() => { spkPrimed = true; settle(); }).catch(settle); else { spkPrimed = true; settle(); } } catch (_) {} }
  function haltSpeak() { speakSeq++; try { if (spkAudio) spkAudio.pause(); } catch (_) {} try { window.speechSynthesis && speechSynthesis.cancel(); } catch (_) {} }
  function speakDevice(clean, seq) {
    if (seq !== speakSeq || !("speechSynthesis" in window)) return;
    speechSynthesis.cancel(); const u = new SpeechSynthesisUtterance(clean);
    const v = maleVoice(); if (v) u.voice = v;
    u.pitch = 1; u.rate = 1; speechSynthesis.speak(u);
  }
  /* the server voice (same Deepgram Aura man, arcas, as Talk Mode): used for
     spoken answers on iPhone when he is signed in, because the iPhone device
     voices are the crazy-sounding part. Any failure drops back to the device
     voice instead of going silent. */
  async function speakServer(clean, seq) {
    const chunks = []; let cur = "";
    for (const s of clean.split(/(?<=[.!?])\s+/)) { if ((cur + " " + s).length > 850 && cur) { chunks.push(cur); cur = s; } else cur = cur ? cur + " " + s : s; }
    if (cur) chunks.push(cur);
    primeSpeakAudio();
    for (const part of chunks.slice(0, 4)) {
      if (seq !== speakSeq || !talkBack) return;
      const r = await fetch("/api/ai", { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer " + aiTok() }, body: JSON.stringify({ model: TTS_MODEL, text: part }) });
      if (seq !== speakSeq) return;
      if (!r.ok || !/^audio\//.test(r.headers.get("content-type") || "")) throw new Error("tts");
      const url = URL.createObjectURL(await r.blob());
      await new Promise((res, rej) => { if (!spkAudio) return rej(new Error("noaudio")); const a = spkAudio; a.muted = false; a.onended = () => { URL.revokeObjectURL(url); res(); }; a.onerror = () => { URL.revokeObjectURL(url); rej(new Error("play")); }; a.src = url; const p = a.play(); if (p && p.catch) p.catch(() => { URL.revokeObjectURL(url); rej(new Error("blocked")); }); });
    }
  }
  function speak(t) {
    if (!talkBack) return;
    const clean = String(t).split("\n\nSources:")[0].replace(/\[\d+\]/g, "").replace(/https?:\/\/\S+/g, "").replace(/[*#_`]/g, "").trim().slice(0, 1200);
    if (!clean) return;
    const seq = ++speakSeq;
    try { if (spkAudio) spkAudio.pause(); } catch (_) {}
    try { window.speechSynthesis && speechSynthesis.cancel(); } catch (_) {}
    if (IS_IOS && signedIn() && aiTok()) { speakServer(clean, seq).catch(() => speakDevice(clean, seq)); return; }
    if (!("speechSynthesis" in window)) return;
    if (!voiceCache.length) { // iOS loads its voices late: give the list a brief moment so the first words do not land on a fallback voice
      let fired = false; const go = () => { if (fired) return; fired = true; speakDevice(clean, seq); };
      try { speechSynthesis.addEventListener("voiceschanged", function h() { try { speechSynthesis.removeEventListener("voiceschanged", h); } catch (_) {} refreshVoices(); go(); }); } catch (_) {}
      setTimeout(go, 700); return;
    }
    speakDevice(clean, seq);
  }
  /* talk instead of typing */
  const mic = panel.querySelector("#ai-mic"), SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  let recog = null;
  if (!SR) mic.hidden = true;
  mic.addEventListener("click", () => {
    if (!SR) return; if (recog) { recog.stop(); return; }
    recog = new SR(); recog.lang = navigator.language || "en-US"; recog.interimResults = true; recog.continuous = false;
    mic.classList.add("on"); inp.placeholder = "Listening... talk now";
    let finalText = "";
    recog.onresult = (e) => { let t = ""; for (const r of e.results) { t += r[0].transcript; if (r.isFinal) finalText = t; } inp.value = t; };
    recog.onend = () => { mic.classList.remove("on"); inp.placeholder = "Ask me anything"; recog = null; const q = (finalText || inp.value).trim(); if (q) { inp.value = ""; if (!talkBack) { talkBack = true; paintSpk(); } ask(q); } };
    recog.onerror = () => { mic.classList.remove("on"); recog = null; inp.placeholder = "Ask me anything"; };
    try { unlockSpeech(); window.speechSynthesis?.cancel(); recog.start(); } catch (_) { mic.classList.remove("on"); recog = null; }
  });
  /* send a photo */
  const attach = panel.querySelector("#ai-attach"); let pending = "";
  panel.querySelector("#ai-file").addEventListener("change", async (e) => {
    const f = e.target.files[0]; e.target.value = ""; if (!f) return;
    try {
      pending = await (typeof compress === "function" ? compress(f, 1024) : new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = rej; r.readAsDataURL(f); }));
      attach.innerHTML = `<img src="${E(pending)}" alt=""><span>Photo ready. Ask a question about it, then tap Send.</span><button type="button" class="btn ghost sm" id="ai-unpic">Remove</button>`; attach.hidden = false;
      attach.querySelector("#ai-unpic").onclick = () => { pending = ""; attach.hidden = true; };
      inp.focus();
    } catch (_) { pending = ""; }
  });
  const GREET = "Hey, I'm Meechie — Meechie's AI assistant. I look after his people here, and I talk out loud: tap Talk to Meechie up top for a full voice chat, tap the mic and speak, or just type below. I can take you anywhere here: the live radio and DJ tables, the shop, the videos and movies, your messages — or help you book and buy. What are you looking for today?";
  fab.addEventListener("click", () => { panel.hidden = false; fab.hidden = true; if (!hist.length) { hist.push({ role: "assistant", content: GREET }); try { localStorage.setItem("mw_ai2", JSON.stringify(hist)); } catch (_) {} draw(false); speak(GREET); } else draw(false); setTimeout(() => inp.focus(), 50); });
  /* says hello when people arrive: one small bubble by the button, once per visit */
  const aiAppMode = (() => { try { const h = document.documentElement.classList; if (h.contains("appmode-ai")) return false; return h.contains("appmode") || (window.matchMedia && matchMedia("(display-mode: standalone)").matches) || !!window.navigator.standalone; } catch (_) { return false; } })(); /* no pop-up greetings inside his apps (owner, 2026-10-28), except the AI app itself where Meechie is the point */
  try { if (!aiAppMode && !sessionStorage.getItem("mw_ai_hi")) { sessionStorage.setItem("mw_ai_hi", "1"); setTimeout(function hiTry(n) { if (!panel.hidden || fab.hidden || document.getElementById("ai-hi")) return; if (window.MW_screenClear && !MW_screenClear("ai-hi")) { if ((n|0) < 20) setTimeout(() => hiTry((n|0) + 1), 8000); return; } /* one card at a time (owner rule) */ const bub = document.createElement("div"); bub.id = "ai-hi"; bub.setAttribute("role", "button"); bub.innerHTML = "<b>Meechie AI</b> is here. Tap me and I will show you around, and we can talk out loud. <button type=\"button\" aria-label=\"Dismiss\">×</button>"; bub.addEventListener("click", (e) => { bub.remove(); if (!e.target.closest("button")) fab.click(); }); document.body.appendChild(bub); setTimeout(() => { bub.remove(); }, 16000); }, 4500); } } catch (_) {}
  /* and he actually talks to people (owner, 2026-10-27): browsers only allow
     sound after a person touches the page, so on a visitor's very first tap or
     keypress — if they have not opened him yet — he says one short hello out
     loud, once per visit. His voice toggle (🔊) still rules. */
  try { if (!aiAppMode && !sessionStorage.getItem("mw_ai_spoke")) { const hello = () => { window.removeEventListener("pointerdown", hello); window.removeEventListener("keydown", hello); if (!panel.hidden || hist.length) return; try { sessionStorage.setItem("mw_ai_spoke", "1"); } catch (_) {} speak("Hey, I'm Meechie, Meechie's assistant. I look after everybody here — tap my gold button and I'll show you around."); }; window.addEventListener("pointerdown", hello); window.addEventListener("keydown", hello); } } catch (_) {}
  panel.querySelector("#ai-close").addEventListener("click", () => { stopTalk(); panel.hidden = true; sync(); });
  chips.addEventListener("click", (e) => { const b = e.target.closest("button"); if (!b) return; if (/take me to the radio/.test(b.textContent)) { goTo("radio"); return; } if (/court case/.test(b.textContent)) { if (typeof go === "function") go("legal"); panel.hidden = true; sync(); return; } ask(b.textContent); });
  panel.querySelector("#ai-new").addEventListener("click", () => { hist = []; try { localStorage.removeItem("mw_ai2"); sessionStorage.removeItem("mw_ai"); } catch (_) {} haltSpeak(); draw(false); inp.focus(); });
  log.addEventListener("click", async (e) => {
    const nb = e.target.closest("[data-nav]"); if (nb) { goTo(nb.dataset.nav); return; }
    const k = e.target.closest("[data-check-i]"); if (k) {
      const i = +k.dataset.checkI, m = hist[i], q = [...hist.slice(0, i)].reverse().find((x) => x.role === "user"); if (!m || k.dataset.busy) return;
      k.dataset.busy = "1"; k.textContent = "Checking...";
      try {
        const r = await fetch("/api/ai", { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer " + MW.session().access_token }, body: JSON.stringify({ verify: { question: q ? q.content : "", answer: m.content } }) });
        const j = await r.json().catch(() => ({}));
        m.check = r.ok && j.text ? (j.by === "claude" ? "Double-checked by Claude:\n" : "Double-checked by a second AI:\n") + j.text + (j.sources && j.sources.length ? "\nSources: " + j.sources.map((x) => x.url).join("  ") : "") : j.error === "limit" && j.message ? j.message : "Couldn't double-check right now. Try again in a minute.";
      } catch (_) { m.check = "Couldn't double-check right now."; }
      try { localStorage.setItem("mw_ai2", JSON.stringify(hist.map((x) => ({ role: x.role, content: x.content, ...(x.check ? { check: x.check } : {}), ...(x.nav ? { nav: x.nav } : {}) })))); } catch (_) {}
      draw(false); return;
    }
    const c = e.target.closest("[data-copy-i]"); if (!c) return; const m = hist[+c.dataset.copyI]; if (m) navigator.clipboard?.writeText(m.content).then(() => { c.textContent = "Copied ✓"; setTimeout(() => (c.textContent = "Copy"), 1500); }).catch(() => {}); });
  panel.querySelector("#ai-form2").addEventListener("submit", (e) => { e.preventDefault(); let q = inp.value; if (!q.trim() && pending) q = "What is in this picture?"; inp.value = ""; ask(q); });
  /* ---------- Talk mode: a real voice conversation with Meechie ----------
   * His picture is the face. Your voice → server ears (Whisper) → the brain in voice style
   * (short spoken answers) → server voice (Deepgram Aura) → he listens again, like a call. */
  const STT_MODEL = "@cf/openai/whisper-large-v3-turbo", TTS_MODEL = "@cf/deepgram/aura-1";
  const stage = panel.querySelector("#ai-stage"), stEl = panel.querySelector("#ai-stage-st"), goBtn = panel.querySelector("#ai-talk-go"), stopBtn = panel.querySelector("#ai-talk-stop");
  const talk = { on: false, stream: null, rec: null, audio: null, vadTimer: null, ac: null, empties: 0 };
  const aiTok = () => MW.session().access_token;
  function setState(s, msg) { stage.dataset.state = s; if (msg) stEl.textContent = msg; }
  panel.querySelector("#ai-talkbtn").addEventListener("click", () => {
    const show = stage.hidden;
    stage.hidden = !show; panel.classList.toggle("talking", show);
    if (!show) stopTalk(); else if (!talk.on) setState("idle", "Tap Start talking, allow the microphone, and just talk to Meechie.");
  });
  goBtn.addEventListener("click", async () => {
    if (!signedIn()) { if (typeof openAuth === "function") openAuth("signup"); return; }
    if (kindOf[picked] === "image") { setState("idle", "First pick a brain (not an image maker) in the picker up top, then start talking."); return; }
    talk.on = true; talk.empties = 0; goBtn.hidden = true; stopBtn.hidden = false; unlockSpeech();
    setState("speaking", "Meechie is talking…");
    await speakChunks(["Hey! Talk to me — ask me anything."]);
    if (talk.on) listen();
  });
  stopBtn.addEventListener("click", stopTalk);
  function stopTalk() {
    talk.on = false;
    if (talk.rec) { try { talk.rec.ondataavailable = null; talk.rec.onstop = null; talk.rec.stop(); } catch (_) {} talk.rec = null; }
    if (talk.vadTimer) { clearInterval(talk.vadTimer); talk.vadTimer = null; }
    if (talk.stream) { try { talk.stream.getTracks().forEach((t) => t.stop()); } catch (_) {} talk.stream = null; }
    if (talk.ac) { try { talk.ac.close(); } catch (_) {} talk.ac = null; }
    if (talk.audio) { try { talk.audio.pause(); } catch (_) {} talk.audio = null; }
    haltSpeak();
    if (goBtn) { goBtn.hidden = false; stopBtn.hidden = true; }
    if (stage && !stage.hidden) setState("idle", "Call ended. Tap Start talking whenever you're ready.");
  }
  async function speakChunks(parts) {
    for (const part of parts) {
      if (!talk.on) return;
      let played = false;
      try {
        const r = await fetch("/api/ai", { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer " + aiTok() }, body: JSON.stringify({ model: TTS_MODEL, text: part }) });
        if (r.ok && /^audio\//.test(r.headers.get("content-type") || "")) {
          const url = URL.createObjectURL(await r.blob());
          played = await new Promise((res) => {
            const a = new Audio(url); talk.audio = a;
            a.onended = () => { URL.revokeObjectURL(url); res(true); };
            a.onerror = () => { URL.revokeObjectURL(url); res(false); };
            a.play().catch(() => res(false));
          });
          talk.audio = null;
        }
      } catch (_) {}
      if (!talk.on) return;
      if (!played) await new Promise((res) => { // device voice as a fallback
        if (!("speechSynthesis" in window)) return res();
        const u = new SpeechSynthesisUtterance(part); const mv = maleVoice(); if (mv) u.voice = mv; u.pitch = 1; u.rate = 1; u.onend = () => res(); u.onerror = () => res();
        try { speechSynthesis.speak(u); } catch (_) { res(); }
      });
    }
  }
  function playReply(reply) {
    if (!talk.on) return;
    const clean = String(reply || "").split("\n\nSources:")[0].replace(/\[\d+\]/g, "").replace(/https?:\/\/\S+/g, "").replace(/[*#_`>]/g, "").trim();
    if (!clean) { listen(); return; }
    setState("speaking", "Meechie is talking…");
    const chunks = []; let cur = "";
    for (const s of clean.split(/(?<=[.!?])\s+/)) { if ((cur + " " + s).length > 850 && cur) { chunks.push(cur); cur = s; } else cur = cur ? cur + " " + s : s; }
    if (cur) chunks.push(cur);
    speakChunks(chunks.slice(0, 4)).then(() => { if (talk.on) listen(); });
  }
  async function listen() {
    if (!talk.on) return;
    setState("listening", "🎙️ Listening… talk now. He answers when you pause.");
    let stream;
    try { stream = talk.stream || await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } }); talk.stream = stream; }
    catch (_) { talk.on = false; goBtn.hidden = false; stopBtn.hidden = true; setState("idle", "The microphone is blocked. Allow mic access for this site, then tap Start talking."); return; }
    const type = ["audio/webm;codecs=opus", "audio/mp4", "audio/webm"].find((x) => window.MediaRecorder && MediaRecorder.isTypeSupported(x)) || "";
    const rec = new MediaRecorder(stream, type ? { mimeType: type } : undefined); talk.rec = rec;
    const chunks = []; rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
    let heard = false, quietSince = 0; const t0 = Date.now();
    try {
      const ac = new (window.AudioContext || window.webkitAudioContext)(); talk.ac = ac;
      const an = ac.createAnalyser(); an.fftSize = 512; ac.createMediaStreamSource(stream).connect(an);
      const buf = new Uint8Array(an.frequencyBinCount);
      talk.vadTimer = setInterval(() => {
        if (!talk.on || talk.rec !== rec) { clearInterval(talk.vadTimer); return; }
        an.getByteTimeDomainData(buf);
        let peak = 0; for (let i = 0; i < buf.length; i += 4) peak = Math.max(peak, Math.abs(buf[i] - 128) / 128);
        const now = Date.now();
        if (peak > 0.06) { heard = true; quietSince = now; }
        if ((heard && now - quietSince > 1100) || now - t0 > 12000 || (!heard && now - t0 > 7000)) { try { rec.stop(); } catch (_) {} }
      }, 120);
    } catch (_) { setTimeout(() => { try { rec.stop(); } catch (_) {} }, 6000); }
    rec.onstop = async () => {
      if (talk.vadTimer) { clearInterval(talk.vadTimer); talk.vadTimer = null; }
      if (talk.ac) { try { talk.ac.close(); } catch (_) {} talk.ac = null; }
      talk.rec = null;
      if (!talk.on) return;
      const blob = new Blob(chunks, { type: type || "audio/webm" });
      if (!heard || blob.size < 1200) { if (++talk.empties >= 3) { stopTalk(); setState("idle", "I couldn't hear you — tap Start talking to try again."); } else listen(); return; }
      talk.empties = 0;
      setState("thinking", "Meechie is thinking…");
      let text = "";
      try {
        const dataUrl = await new Promise((res, rej) => { const fr = new FileReader(); fr.onload = () => res(fr.result); fr.onerror = rej; fr.readAsDataURL(blob); });
        const r = await fetch("/api/ai", { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer " + aiTok() }, body: JSON.stringify({ model: STT_MODEL, audio: dataUrl }) });
        const j = await r.json().catch(() => ({}));
        text = (j.text || "").trim();
        if (!r.ok && j.error === "limit") { stopTalk(); setState("idle", j.message || "Voice allowance used up for now — you can still type below."); return; }
      } catch (_) {}
      if (!talk.on) return;
      if (text) ask(text, true);
      else if (++talk.empties >= 3) { stopTalk(); setState("idle", "I couldn't make that out — tap Start talking to try again."); }
      else listen();
    };
    try { rec.start(); } catch (_) { if (talk.on) listen(); }
  }
  // hide the bubble on the Contact page, which already has the full AI box
  const contact = document.getElementById("v-contact"), msgs = document.getElementById("v-messages");
  // also hidden in Messenger, where it would cover the Send button
  const sync = () => { if (panel.hidden) fab.hidden = !!(contact && !contact.hidden) || !!(msgs && !msgs.hidden); };
  [contact, msgs].forEach((v) => v && new MutationObserver(sync).observe(v, { attributes: true, attributeFilter: ["hidden"] }));
  sync();
})();
