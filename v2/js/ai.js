/* ============================================================================
   MEECHIE AI — the shell-wide assistant (Law 17), a lazy module.
   ----------------------------------------------------------------------------
   The live site's js/ai-widget.js, ported to the v2 shell: the gold
   bubble on every view, the chat panel (POST /api/ai with the running
   history — the same door, the same request shape, never forked),
   the arrival greeting bubble (~4.5 s, once per session), spoken
   answers (default ON, per-device toggle), mic dictation, and Talk
   Mode (his portrait, server ears + server voice through /api/ai).

   Core lazy-loads this module after the frame paints (js/core.js
   loadAI); it never counts against the shell boot budget, and it is
   a permanent fixture of the device-saved skeleton (v2/sw.js
   PRECACHE — heart + brain audit, owner 2026-10-30).

   Privacy (Law 16/17): chat history is THIS visitor's own, kept on
   this device (localStorage "mw_ai2", the live key). One member's
   questions are never fed into another's chat — the /api/ai door
   enforces that server-side and nothing here weakens it.

   Named simplifications vs the live widget (recorded in the README
   differences list): the model picker, photo send / image makers,
   and the Double-check action are not ported in this pass; the
   guest Join button hands sign-in to the main site, exactly like
   the v2 guest wall does in this phase.
   ============================================================================ */

import { esc as E } from "./platform.js";

/* ---- pure rules (harness-pinned) ---------------------------------- */
export const AI_GREET_DELAY_MS = 4500;
export const AI_TTS_MODEL = "@cf/deepgram/aura-1";
export const AI_STT_MODEL = "@cf/openai/whisper-large-v3-turbo";
export const AI_VOICE_KEY = "mw_ai_voice";
export const AI_HI_KEY = "mw_ai_hi";
export const AI_SPOKE_KEY = "mw_ai_spoke";
export const AI_HIST_KEY = "mw_ai2";

/* Pop-ups (the greeting bubble + the spoken hello) follow Law 10:
   never in app mode — except the AI app itself, where Meechie is
   the point (the live widget's appmode-ai exception). A standalone
   installed app counts as app mode, as on the live site. */
export function popupsAllowedFor(appModeId, standalone) {
  if (standalone) return appModeId === "ai";
  return !appModeId || appModeId === "ai";
}

/* Spoken answers default ON; the per-device toggle persists in
   localStorage "mw_ai_voice" ("1"/"0"), the live key. */
export function readVoicePref(store) {
  try {
    const v = store.getItem(AI_VOICE_KEY);
    return v === null ? true : v === "1";
  } catch (_) { return true; }
}
export function writeVoicePref(store, on) {
  try { store.setItem(AI_VOICE_KEY, on ? "1" : "0"); } catch (_) {}
}

/* The greeting bubble fires once per session: claiming the key is
   the gate — first claim wins, every later claim in the session
   is refused. sessionStorage is the store. */
export function claimGreeting(store) {
  try {
    if (store.getItem(AI_HI_KEY)) return false;
    store.setItem(AI_HI_KEY, "1");
    return true;
  } catch (_) { return false; }
}

/* ---- the assistant ------------------------------------------------ */
const fmt = (t) => E(t).replace(/^#{1,4}\s*(.+)$/gm, "<b>$1</b>").replace(/^\s*[-*•]\s+/gm, "• ").replace(/\*\*(.+?)\*\*/g, "<b>$1</b>").replace(/(^|[\s(])(https:\/\/[^\s<)]+)(?=$|[\s)])/g, (m, p, u) => p + `<a href="${u}" target="_blank" rel="noopener" style="color:var(--gold-hi,#f0cf78)">${u.replace(/^https:\/\/(www\.)?/, "").slice(0, 40)}</a>`).replace(/\((https:\/\/[^\s)]+)\)/g, (m, u) => `(<a href="${u}" target="_blank" rel="noopener" style="color:var(--gold-hi,#f0cf78)">link</a>)`).replace(/\n/g, "<br>");
const CHIPS = ["🧭 Take me to the radio", "⚖️ Help with my court case", "What services do you offer?", "How do I promote my business?", "What's in the shop?", "How do I submit a clothing design?", "How do I pay or book?"];
const GREET = "Hey, I'm Meechie — Meechie's AI assistant. I look after his people here, and I talk out loud: tap Talk to Meechie up top for a full voice chat, tap the mic and speak, or just type below. I can take you anywhere here: the live radio and DJ tables, the shop, the videos and movies, your messages — or help you book and buy. What are you looking for today?";

const CSS = `
#ai-fab{position:fixed;right:16px;bottom:16px;z-index:9997;display:flex;align-items:center;gap:8px;border:1px solid var(--gold-hi,#f0cf78);background:linear-gradient(180deg,#1d1810,#0f0d09);color:var(--gold-hi,#f0cf78);font:700 14px system-ui,sans-serif;padding:11px 16px;border-radius:999px;cursor:pointer;box-shadow:0 10px 28px rgba(0,0,0,.55)}
.ai-av{width:28px;height:28px;border-radius:50%;object-fit:cover;border:1.5px solid var(--gold-hi,#f0cf78);flex:none;margin:-4px 0 -4px -6px}.ai-av.lg{width:38px;height:38px;margin:0}.ai-av.sm{width:26px;height:26px;margin:2px 0 0}
.ai-row{display:flex;gap:7px;align-items:flex-start;max-width:92%}.ai-row .ai-m{max-width:100%}
.ai-acts{display:flex;gap:12px;margin-top:6px}
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
#ai-panel header .ai-spk{margin-left:auto;font-size:18px}
#ai-panel header #ai-new{color:var(--gold-hi,#f0cf78);white-space:nowrap;flex:none;font-size:14px;border:1px solid var(--line,#3a3223);border-radius:999px;padding:4px 10px}
#ai-panel header .ai-spk+button{margin-left:6px}
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
#ai-panel.talking{height:min(720px,calc(100vh - 56px))}`;

let inited = null;

export function initAI(ctx) {
  if (inited) return inited;
  const Session = ctx.session;
  const AppMode = ctx.appMode || { id: null, active: false };
  let hist = [];
  try { hist = JSON.parse(localStorage.getItem(AI_HIST_KEY) || sessionStorage.getItem("mw_ai") || "[]"); } catch (_) { hist = []; }
  if (!Array.isArray(hist)) hist = [];
  let busy = false;

  const css = document.createElement("style");
  css.textContent = CSS;
  document.head.appendChild(css);

  const fab = document.createElement("button");
  fab.id = "ai-fab"; fab.type = "button";
  fab.innerHTML = '<img class="ai-av" src="/img/meechie-ai.jpg" alt=""><span class="dot"></span>Ask Meechie (AI)';
  const panel = document.createElement("section");
  panel.id = "ai-panel"; panel.hidden = true;
  panel.setAttribute("aria-label", "Chat with Meechie, the AI assistant");
  panel.innerHTML = `<header><img class="ai-av lg" src="/img/meechie-ai.jpg" alt="Meechie"><div><b>Meechie · AI</b><small>Answers 24/7 · talk or type</small></div><button type="button" id="ai-new" title="Start a new chat" aria-label="Start a new chat">＋ New</button><button type="button" class="ai-spk" id="ai-spk" aria-label="Read answers out loud" title="Read answers out loud">🔈</button><button type="button" id="ai-close" aria-label="Close">×</button></header>
<button type="button" id="ai-talkbtn">🎙️ Talk to Meechie — tap for a voice chat</button>
<div id="ai-stage" data-state="idle" hidden>
<div class="ai-face"><img src="/img/meechie-ai.jpg" alt="Meechie"><span class="rg a"></span><span class="rg b"></span></div>
<div class="ai-wave" aria-hidden="true"><i></i><i></i><i></i><i></i><i></i><i></i><i></i></div>
<p id="ai-stage-st">A real conversation: talk, and Meechie listens, answers out loud, then listens again.</p>
<div class="ai-stage-row"><button type="button" id="ai-talk-go" class="btn">🎙️ Start talking</button><button type="button" id="ai-talk-stop" class="btn ghost" hidden>⏹ End call</button></div>
</div>
<div id="ai-log2" aria-live="polite"></div><div class="ai-chips" id="ai-chips"></div>
<div class="ai-nav" id="ai-nav" aria-label="Jump to a section"></div>
<form id="ai-form2"><button type="button" class="ai-tool" id="ai-mic" aria-label="Talk to the AI">🎙️</button><input id="ai-in2" aria-label="Ask Meechie" maxlength="1500" autocomplete="off" placeholder="Ask me anything"><button type="submit">Send</button></form>`;
  document.body.append(fab, panel);
  const log = panel.querySelector("#ai-log2"), chips = panel.querySelector("#ai-chips"), inp = panel.querySelector("#ai-in2");

  /* navigation: the jump-to row, plus [[nav:view]] markers in answers */
  const NAVS = [["🏠", "home", "Home"], ["📖", "community", "Book"], ["🛠️", "services", "Services"], ["🛍️", "shop", "Shop"], ["📻", "radio", "Radio"], ["🎛️", "dj", "DJ"], ["🎬", "clips", "Clips"], ["📺", "videos", "Videos"], ["🔴", "live", "Live"], ["❤️", "dating", "Dating"], ["💬", "messages", "Messages"], ["🪙", "coin", "Coin"], ["🌍", "world", "World"], ["🎮", "games", "Games"], ["⚖️", "legal", "Legal"]];
  const NAVLBL = { home: "Home", community: "Meechie's Book", services: "Services", shop: "the Shop", radio: "Radio", dj: "the DJ Station", clips: "Clips", videos: "Videos", live: "Live", livetv: "Live TV", liveradio: "Live Radio", friends: "Friends", dating: "Dating", coin: "Meechie's Coin", world: "the Virtual World", games: "Games", creators: "Creators", legal: "Legal Help", chat: "Chat & Walkie", messages: "Messages", connect: "Connect", books: "Books", studio: "Studio", markets: "Markets", predict: "Predictions", promote: "Promote", contact: "Contact" };
  const navRow = panel.querySelector("#ai-nav");
  navRow.innerHTML = '<span class="ai-navlead" aria-hidden="true">🧭</span>' + NAVS.map(([em, v, t]) => `<button type="button" data-navgo="${v}">${em} ${t}</button>`).join("");
  function goTo(v) { location.hash = "#" + v; closePanel(); }
  navRow.addEventListener("click", (e) => { const b = e.target.closest("[data-navgo]"); if (b) goTo(b.dataset.navgo); });

  const signedIn = () => !!Session.user();
  const aiTok = () => { const s = Session.get(); return (s && s.access_token) || ""; };

  function draw(thinking) {
    const hello = `<div class="ai-row"><img class="ai-av sm" src="/img/meechie-ai.jpg" alt=""><div class="ai-m">Hey! I'm Meechie, the AI assistant for Meechie's World. Ask me about services and prices, promotion, the shop, clothing designs, or how anything on the site works. I can also explain court procedure and help you draft motions on the Legal Help tab. And I can take you places, too — just say "take me to the shop" and I'll send you there.</div></div>`;
    log.innerHTML = hello + hist.map((m, i) => m.role === "user" ? `<div class="ai-m me">${fmt(m.content)}</div>` : `<div class="ai-row"><img class="ai-av sm" src="/img/meechie-ai.jpg" alt=""><div class="ai-m">${fmt(m.content)}<span class="ai-acts"><button type="button" class="ai-copy" data-copy-i="${i}" aria-label="Copy this answer">Copy</button></span>${m.nav ? `<br><button type="button" class="ai-navb" data-nav="${m.nav}">➡️ Go to ${NAVLBL[m.nav] || m.nav}</button>` : ""}</div></div>`).join("") + (thinking ? `<div class="ai-m"><span class="ai-typing"><i></i><i></i><i></i></span></div>` : "");
    if (!signedIn()) log.innerHTML += `<div class="ai-m">Join free (it takes 20 seconds) to chat with me.<br><button class="btn sm" type="button" data-auth="signup" style="margin-top:8px">Join free</button></div>`;
    chips.innerHTML = hist.length ? "" : CHIPS.map((c) => `<button type="button">${E(c)}</button>`).join("");
    log.scrollTop = log.scrollHeight;
  }

  async function ask(q, viaTalk) {
    if (busy || !q.trim()) return;
    if (!signedIn()) { draw(false); return; }
    hist.push({ role: "user", content: q.trim().slice(0, 4000) });
    busy = true; draw(true);
    let reply;
    try {
      const r = await fetch("/api/ai", { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer " + aiTok() }, body: JSON.stringify({ messages: hist.slice(-20).map((m) => ({ role: m.role, content: m.content })), ...(viaTalk ? { voice: true } : {}) }) });
      const j = await r.json().catch(() => ({}));
      reply = r.ok && j.reply ? j.reply + (j.sources && j.sources.length ? "\n\nSources: " + j.sources.map((x, i) => "[" + (i + 1) + "] " + x.title + " (" + x.url + ")").join("  ") : "") : (j.error === "busy" ? "I'm getting a lot of questions right now. Try again in a minute, or DM @meechiesworldinc on TikTok." : "I can't answer right now. DM @meechiesworldinc on TikTok or email meechiesworldinc@aol.com.");
    } catch (_) { reply = "I can't connect right now. Check your internet and try again."; }
    let navTo = ""; const nm = /\[\[nav:([a-z]+)\]\]/.exec(reply || "");
    if (nm) { navTo = nm[1]; reply = reply.replace(/\s*\[\[nav:[a-z]+\]\]/g, "").trim(); }
    hist.push({ role: "assistant", content: reply, ...(navTo ? { nav: navTo } : {}) });
    hist = hist.slice(-40);
    try { localStorage.setItem(AI_HIST_KEY, JSON.stringify(hist.map((m) => ({ role: m.role, content: m.content, ...(m.nav ? { nav: m.nav } : {}) })))); } catch (_) {}
    busy = false; draw(false);
    if (viaTalk && navTo) goTo(navTo);
    if (viaTalk) playReply(reply); else speak(reply);
  }

  /* ---- spoken answers (live path): the server voice (Deepgram
     Aura, arcas) through /api/ai on iPhone when signed in; the
     device voice elsewhere, a man's voice preferred by name and
     novelty voices excluded — the live 2026-10-27/28 rules. ---- */
  let talkBack = readVoicePref(localStorage);
  const spk = panel.querySelector("#ai-spk");
  const paintSpk = () => { spk.textContent = talkBack ? "🔊" : "🔈"; spk.title = talkBack ? "Reading answers out loud (tap to stop)" : "Read answers out loud"; };
  paintSpk();
  spk.addEventListener("click", () => { talkBack = !talkBack; writeVoicePref(localStorage, talkBack); if (!talkBack) haltSpeak(); else unlockSpeech(); paintSpk(); });
  function unlockSpeech() { try { primeSpeakAudio(); if (window.speechSynthesis && !unlockSpeech.done) { unlockSpeech.done = true; speechSynthesis.speak(new SpeechSynthesisUtterance("")); } } catch (_) {} }
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
  let spkAudio = null, spkPrimed = false, speakSeq = 0;
  function primeSpeakAudio() { try { if (spkPrimed) return; if (!spkAudio) { spkAudio = new Audio(); spkAudio.preload = "auto"; spkAudio.playsInline = true; spkAudio.src = "data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQAAAAA="; } spkAudio.muted = true; const p = spkAudio.play(); const settle = () => { try { spkAudio.pause(); spkAudio.muted = false; } catch (_) {} }; if (p && p.then) p.then(() => { spkPrimed = true; settle(); }).catch(settle); else { spkPrimed = true; settle(); } } catch (_) {} }
  function haltSpeak() { speakSeq++; try { if (spkAudio) spkAudio.pause(); } catch (_) {} try { window.speechSynthesis && speechSynthesis.cancel(); } catch (_) {} }
  function speakDevice(clean, seq) {
    if (seq !== speakSeq || !("speechSynthesis" in window)) return;
    speechSynthesis.cancel(); const u = new SpeechSynthesisUtterance(clean);
    const v = maleVoice(); if (v) u.voice = v;
    u.pitch = 1; u.rate = 1; speechSynthesis.speak(u);
  }
  /* one sentence-chunker for both spoken paths (was copy-pasted in
     speakServer and playReply): split on sentence ends, ~850 chars each */
  const chunkText = (clean) => {
    const chunks = []; let cur = "";
    for (const s of clean.split(/(?<=[.!?])\s+/)) { if ((cur + " " + s).length > 850 && cur) { chunks.push(cur); cur = s; } else cur = cur ? cur + " " + s : s; }
    if (cur) chunks.push(cur);
    return chunks;
  };
  async function speakServer(clean, seq) {
    const chunks = chunkText(clean);
    primeSpeakAudio();
    for (const part of chunks.slice(0, 4)) {
      if (seq !== speakSeq || !talkBack) return;
      const r = await fetch("/api/ai", { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer " + aiTok() }, body: JSON.stringify({ model: AI_TTS_MODEL, text: part }) });
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
    if (!voiceCache.length) {
      let fired = false; const go = () => { if (fired) return; fired = true; speakDevice(clean, seq); };
      try { speechSynthesis.addEventListener("voiceschanged", function h() { try { speechSynthesis.removeEventListener("voiceschanged", h); } catch (_) {} refreshVoices(); go(); }); } catch (_) {}
      setTimeout(go, 700); return;
    }
    speakDevice(clean, seq);
  }

  /* ---- mic dictation (where the platform offers it) ---- */
  const mic = panel.querySelector("#ai-mic"), SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  let recog = null;
  if (!SR) mic.hidden = true;
  mic.addEventListener("click", () => {
    if (!SR) return; if (recog) { recog.stop(); return; }
    recog = new SR(); recog.lang = navigator.language || "en-US"; recog.interimResults = true; recog.continuous = false;
    mic.classList.add("on"); inp.placeholder = "Listening... talk now";
    let finalText = "";
    recog.onresult = (e) => { let t = ""; for (const r of e.results) { t += r[0].transcript; if (r.isFinal) finalText = t; } inp.value = t; };
    recog.onend = () => { mic.classList.remove("on"); inp.placeholder = "Ask me anything"; recog = null; const q = (finalText || inp.value).trim(); if (q) { inp.value = ""; if (!talkBack) { talkBack = true; writeVoicePref(localStorage, true); paintSpk(); } ask(q); } };
    recog.onerror = () => { mic.classList.remove("on"); recog = null; inp.placeholder = "Ask me anything"; };
    try { unlockSpeech(); window.speechSynthesis?.cancel(); recog.start(); } catch (_) { mic.classList.remove("on"); recog = null; }
  });

  /* ---- panel open/close ---- */
  function openPanel() {
    panel.hidden = false; syncFab(); unlockSpeech();
    if (!hist.length) {
      hist.push({ role: "assistant", content: GREET });
      try { localStorage.setItem(AI_HIST_KEY, JSON.stringify(hist)); } catch (_) {}
      draw(false); speak(GREET);
    } else draw(false);
    setTimeout(() => inp.focus(), 50);
  }
  /* Hide FIRST, talk teardown second: closePanel used to run stopTalk()
     before panel.hidden was set, so any throw in the recorder / stream /
     speech teardown (real-browser Talk Mode state) aborted the close and
     the panel stayed open no matter how often × was tapped (Gate T gap 3). */
  function closePanel() { panel.hidden = true; syncFab(); stopTalk(); }
  fab.addEventListener("click", openPanel);
  panel.querySelector("#ai-close").addEventListener("click", closePanel);
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !panel.hidden) closePanel(); });
  panel.querySelector("#ai-new").addEventListener("click", () => { hist = []; try { localStorage.removeItem(AI_HIST_KEY); sessionStorage.removeItem("mw_ai"); } catch (_) {} haltSpeak(); draw(false); inp.focus(); });
  chips.addEventListener("click", (e) => { const b = e.target.closest("button"); if (!b) return; if (/take me to the radio/.test(b.textContent)) { goTo("radio"); return; } if (/court case/.test(b.textContent)) { goTo("legal"); return; } ask(b.textContent); });
  log.addEventListener("click", (e) => {
    const nb = e.target.closest("[data-nav]"); if (nb) { goTo(nb.dataset.nav); return; }
    const au = e.target.closest("[data-auth]"); if (au) { location.href = "/"; return; }
    const c = e.target.closest("[data-copy-i]"); if (!c) return; const m = hist[+c.dataset.copyI]; if (m) navigator.clipboard?.writeText(m.content).then(() => { c.textContent = "Copied ✓"; setTimeout(() => (c.textContent = "Copy"), 1500); }).catch(() => {});
  });
  panel.querySelector("#ai-form2").addEventListener("submit", (e) => { e.preventDefault(); const q = inp.value; inp.value = ""; ask(q); });

  /* the bubble steps aside on Contact (its own AI box) and Messages
     (it would cover the Send button) — in v2 the router's current
     view on body[data-view] is the signal */
  function syncFab() {
    if (!panel.hidden) { fab.hidden = true; return; }
    const v = document.body.dataset.view || "";
    fab.hidden = v === "contact" || v === "messages";
  }
  try { new MutationObserver(syncFab).observe(document.body, { attributes: true, attributeFilter: ["data-view"] }); } catch (_) {}
  syncFab();

  /* ---- arrival greeting (Law 10): one small bubble by the button
     ~4.5 s after arrival, once per session, never in app mode
     (except the AI app); it defers while the Enter screen or the
     guest wall is up, like the live one-card-at-a-time rule. ---- */
  const standalone = (() => { try { return (window.matchMedia && matchMedia("(display-mode: standalone)").matches) || !!window.navigator.standalone; } catch (_) { return false; } })();
  const popups = popupsAllowedFor(AppMode.id, standalone);
  function screenBusy() {
    const en = document.getElementById("enter"), gt = document.getElementById("gate");
    return (en && !en.hidden) || (gt && !gt.hidden);
  }
  try {
    if (popups && !sessionStorage.getItem(AI_HI_KEY)) {
      setTimeout(function hiTry(n) {
        if (!panel.hidden || fab.hidden || document.getElementById("ai-hi") || screenBusy()) {
          if ((n | 0) < 20) setTimeout(() => hiTry((n | 0) + 1), 8000);
          return;
        }
        if (!claimGreeting(sessionStorage)) return;
        const bub = document.createElement("div");
        bub.id = "ai-hi"; bub.setAttribute("role", "button");
        bub.innerHTML = "<b>Meechie AI</b> is here. Tap me and I will show you around, and we can talk out loud. <button type=\"button\" aria-label=\"Dismiss\">×</button>";
        bub.addEventListener("click", (e) => { bub.remove(); if (!e.target.closest("button")) openPanel(); });
        document.body.appendChild(bub);
        setTimeout(() => { bub.remove(); }, 16000);
      }, AI_GREET_DELAY_MS);
    }
  } catch (_) {}
  /* and he says hello out loud on the visitor's first tap or
     keypress, once per visit — browsers only allow sound after a
     touch; the voice toggle still rules */
  try {
    if (popups && !sessionStorage.getItem(AI_SPOKE_KEY)) {
      const hello = () => {
        window.removeEventListener("pointerdown", hello); window.removeEventListener("keydown", hello);
        if (!panel.hidden || hist.length) return;
        try { sessionStorage.setItem(AI_SPOKE_KEY, "1"); } catch (_) {}
        speak("Hey, I'm Meechie, Meechie's assistant. I look after everybody here — tap my gold button and I'll show you around.");
      };
      window.addEventListener("pointerdown", hello); window.addEventListener("keydown", hello);
    }
  } catch (_) {}

  /* ---------- Talk Mode: a real voice conversation ----------
     His picture is the face. Your voice → server ears (Whisper) →
     the brain in voice style → server voice (Deepgram Aura) → he
     listens again, like a call. The live loop, ported whole. */
  const stage = panel.querySelector("#ai-stage"), stEl = panel.querySelector("#ai-stage-st"), goBtn = panel.querySelector("#ai-talk-go"), stopBtn = panel.querySelector("#ai-talk-stop");
  const talk = { on: false, stream: null, rec: null, audio: null, vadTimer: null, ac: null, empties: 0 };
  function setState(s, msg) { stage.dataset.state = s; if (msg) stEl.textContent = msg; }
  panel.querySelector("#ai-talkbtn").addEventListener("click", () => {
    const show = stage.hidden;
    stage.hidden = !show; panel.classList.toggle("talking", show);
    if (!show) stopTalk(); else if (!talk.on) setState("idle", "Tap Start talking, allow the microphone, and just talk to Meechie.");
  });
  goBtn.addEventListener("click", async () => {
    if (!signedIn()) { draw(false); return; }
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
        const r = await fetch("/api/ai", { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer " + aiTok() }, body: JSON.stringify({ model: AI_TTS_MODEL, text: part }) });
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
      if (!played) await new Promise((res) => {
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
    speakChunks(chunkText(clean).slice(0, 4)).then(() => { if (talk.on) listen(); });
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
        const r = await fetch("/api/ai", { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer " + aiTok() }, body: JSON.stringify({ model: AI_STT_MODEL, audio: dataUrl }) });
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

  inited = { openPanel, closePanel };
  return inited;
}
