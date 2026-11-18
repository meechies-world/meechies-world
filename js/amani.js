/* Amani — Malik's partner & manager, on the site (owner order, 2026-11-03:
 * "I want you on my site too — we can run it together.").
 * This module owns her view (#v-amani): her face, her lanes, and a chat
 * that runs on the site's own AI pipeline (/api/ai) with HER persona
 * (server-side: functions/api/ai.js routes persona:"amani" to
 * answerAmani in lib/brain.js — she is NOT a second Meechie: different
 * brief, separate fair-use bucket, no member memory, no owner facts).
 * Chat is members-only, the same rule as Meechie's AI (it keeps strangers
 * from burning the free AI allowance); guests see her page and a join
 * prompt. She takes no actions from here — she talks, points and helps;
 * the buttons on the site do the doing.
 * Her spoken replies use the site's own TTS route (the Meechie voice
 * work's door: /api/ai with the Aura model) with a woman's speaker —
 * her exact WhatsApp voice (Voice 3) lives with Amani herself, not with
 * the website, so the listen button is the site's voice for her lines. */
(function () {
  "use strict";
  if (window.__MW_AMANI) return;
  window.__MW_AMANI = true;

  const $ = (s, r) => (r || document).querySelector(s);
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const fmt = (t) => esc(t).replace(/^\s*[-*•]\s+/gm, "• ").replace(/\*\*(.+?)\*\*/g, "<b>$1</b>").replace(/\n/g, "<br>");
  const NAVLBL = { home: "Home", community: "Meechie's Book", services: "Services", shop: "the Shop", radio: "Radio", dj: "the DJ Station", clips: "Clips", videos: "Videos", live: "Live", livetv: "Live TV", liveradio: "Live Radio", friends: "Friends", dating: "Dating", coin: "Meechie's Coin", world: "the Virtual World", games: "Games", creators: "Creators", legal: "Legal Help", chat: "Chat & Walkie", messages: "Messages", connect: "Connect", books: "Books", studio: "Studio", markets: "Markets", predict: "Predictions", promote: "Promote", contact: "Contact", mwtv: "MW TV", tv: "Movies & TV", watch: "Watch the Setup" };
  const CHIPS = ["🎧 What's on the radio now?", "📺 When is MY EMPIRE on?", "🎤 How do I request a song?", "🛠️ How do I book a service?", "🛍️ What's in the shop?", "📰 Tell me about the local news"];
  const TTS_MODEL = "@cf/deepgram/aura-1", TTS_SPEAKER = "asteria";

  const root = $("#am-root");
  if (!root) return;
  root.innerHTML = `
<div class="am-log" id="am-log" aria-live="polite"></div>
<div class="am-chips" id="am-chips">${CHIPS.map((c) => `<button type="button" data-chip="${esc(c)}">${esc(c)}</button>`).join("")}</div>
<div class="am-guest" id="am-guest" hidden>
  <p>Talking with me is for members — joining is free and takes a minute. Guests are welcome to look around my page; sign in and I'll be right here.</p>
  <p><button class="btn" type="button" data-auth="signup">Join free</button> <button class="btn ghost" type="button" data-auth="signin">Sign in</button></p>
</div>
<form class="am-form" id="am-form">
  <input id="am-in" aria-label="Talk to Amani" maxlength="1500" autocomplete="off" placeholder="Ask Amani — the station, the shop, the shows, bookings…">
  <button type="submit">Send</button>
</form>
<p class="am-note">Amani is an AI. She can point you anywhere on the site, but she can't push the buttons for you — yet.</p>`;

  const log = $("#am-log", root), chips = $("#am-chips", root), form = $("#am-form", root), inp = $("#am-in", root), guest = $("#am-guest", root);
  let hist = [];
  try { hist = JSON.parse(sessionStorage.getItem("mw_amani") || "[]"); } catch (_) { hist = []; }
  if (!Array.isArray(hist)) hist = [];
  let thinking = false, speaking = null; // speaking: {audio, btn}

  const signedIn = () => { try { const s = window.MW && MW.session && MW.session(); return !!(s && s.user && s.access_token); } catch (_) { return false; } };
  const tok = () => { try { return MW.session().access_token; } catch (_) { return ""; } };
  const save = () => { try { sessionStorage.setItem("mw_amani", JSON.stringify(hist.slice(-20))); } catch (_) {} };

  function navOf(text) {
    const m = /\[\[nav:([a-z]+)\]\]/.exec(text || "");
    return m && NAVLBL[m[1]] ? m[1] : null;
  }
  const stripNav = (t) => String(t || "").replace(/\s*\[\[nav:[a-z]+\]\]\s*/g, "").trim();

  function draw() {
    const hello = hist.length ? "" : `<div class="am-row"><img class="am-av sm" src="/img/amani.jpg" alt="" onerror="this.style.display='none'"><div class="am-m">Hey — I'm <b>Amani</b>, Malik's partner and manager. I help run this place: the station, the TV, the shop, the shows. Ask me where things are, what's playing, how booking works — or tap a starter below. If I don't know it, I'll tell you straight and point you to who does.</div></div>`;
    log.innerHTML = hello + hist.map((m, i) => m.role === "user"
      ? `<div class="am-m me">${fmt(m.content)}</div>`
      : `<div class="am-row"><img class="am-av sm" src="/img/amani.jpg" alt="" onerror="this.style.display='none'"><div class="am-m">${fmt(stripNav(m.content))}<span class="am-acts"><button type="button" class="am-listen" data-listen="${i}">🔊 Listen</button></span>${m.nav ? `<br><button type="button" class="am-navb" data-nav="${m.nav}">➡️ Go to ${NAVLBL[m.nav]}</button>` : ""}</div></div>`).join("")
      + (thinking ? `<div class="am-m"><span class="am-typing"><i></i><i></i><i></i></span></div>` : "");
    log.scrollTop = log.scrollHeight;
    const g = !signedIn();
    guest.hidden = !g;
    form.style.display = g ? "none" : "";
    chips.style.display = g ? "none" : "";
  }

  async function send(text) {
    const q = String(text || "").trim();
    if (!q || thinking) return;
    if (!signedIn()) { draw(); return; }
    hist.push({ role: "user", content: q.slice(0, 1500) });
    thinking = true; draw();
    try {
      const r = await fetch("/api/ai", { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer " + tok() }, body: JSON.stringify({ persona: "amani", messages: hist.slice(-20).map((m) => ({ role: m.role, content: m.content })) }) });
      const j = await r.json().catch(() => ({}));
      if (r.status === 401) { hist.pop(); thinking = false; draw(); if (window.toast) toast("Sign in to talk with Amani."); return; }
      const reply = j.reply || "I'm having trouble thinking right now — give me a minute and ask again, or tap Ask Meechie down in the corner.";
      hist.push({ role: "assistant", content: reply, nav: navOf(reply) });
    } catch (_) {
      hist.push({ role: "assistant", content: "The line dropped on my end — check your connection and ask me again." });
    }
    thinking = false; save(); draw();
  }

  function stopSpeak() { if (speaking) { try { speaking.audio.pause(); } catch (_) {} if (speaking.btn) speaking.btn.textContent = "🔊 Listen"; speaking = null; } }
  async function listen(i, btn) {
    if (speaking && speaking.btn === btn) { stopSpeak(); return; }
    stopSpeak();
    const m = hist[i]; if (!m || m.role !== "assistant") return;
    const text = stripNav(m.content).replace(/[*#_`>]/g, "").slice(0, 1100);
    if (!text) return;
    btn.textContent = "⏳…";
    try {
      const r = await fetch("/api/ai", { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer " + tok() }, body: JSON.stringify({ model: TTS_MODEL, speaker: TTS_SPEAKER, text }) });
      if (!r.ok || !/^audio\//.test(r.headers.get("content-type") || "")) throw new Error("tts");
      const url = URL.createObjectURL(await r.blob());
      const audio = new Audio(url);
      speaking = { audio, btn };
      btn.textContent = "⏹ Stop";
      audio.onended = () => { if (speaking && speaking.audio === audio) stopSpeak(); URL.revokeObjectURL(url); };
      await audio.play();
    } catch (_) { btn.textContent = "🔊 Listen"; if (window.toast) toast("Couldn't play my voice just now — the words are all there above."); }
  }

  form.addEventListener("submit", (e) => { e.preventDefault(); const v = inp.value; inp.value = ""; send(v); });
  chips.addEventListener("click", (e) => { const b = e.target.closest("[data-chip]"); if (b) send(b.dataset.chip); });
  log.addEventListener("click", (e) => {
    const nb = e.target.closest("[data-nav]");
    if (nb) { stopSpeak(); location.hash = nb.dataset.nav; return; }
    const lb = e.target.closest("[data-listen]");
    if (lb) { listen(+lb.dataset.listen, lb); return; }
  });
  // session can land after first paint (the client restores it async): repaint so the form appears
  let tries = 0; const iv = setInterval(() => { draw(); if (signedIn() || ++tries > 10) clearInterval(iv); }, 700);
  draw();
})();
