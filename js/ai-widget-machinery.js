/* Meechie AI — the chat machinery (max-speed Lever 3, 2026-11-02).
 * Split out of js/ai-widget.js: that file stays eager as the shell
 * (bubble, panel skeleton, greetings, visit ping) and loads this file
 * on first AI need, handing over the shared pieces through
 * __mwAiAttach. Everything below is the original widget code — the
 * panel's ask/answer flow, the speech stack, mic, photo and talk
 * mode — moved, not rewritten; the only text edits are the two
 * in-place history trims (the history array is shared with the
 * shell, so it is trimmed, never re-bound). */
(function () {
  "use strict";
  if (!window.__mwAiAttach) return;
  window.__mwAiAttach(function (ctx) {
  const E = ctx.E, fmt = ctx.fmt, CHIPS = ctx.CHIPS, NAVLBL = ctx.NAVLBL, hist = ctx.hist;
  const fab = ctx.fab, panel = ctx.panel, log = ctx.log, chips = ctx.chips, inp = ctx.inp;
  const goTo = ctx.goTo, sync = ctx.sync, greetNow = ctx.greetNow;
  let busy = false;
  /* every Cloudflare AI model, wired in: pick a brain, or pick an image maker and describe a picture */
  const sel = panel.querySelector("#ai-model");
  const kindOf = {};
  let picked = ""; try { picked = localStorage.getItem("mw_ai_model") || ""; } catch (_) {}
  /* PR-B4: the top three picker entries are routing modes, not models —
   * Auto lets the server router choose per job, Quick pins the fast tier,
   * Deep pins the deep tier. Everything below them is a real model id. */
  const AI_TIERS = new Set(["auto", "quick", "deep"]);
  if (!picked) picked = "auto";
  fetch("/api/ai").then((r) => r.json()).then((j) => {
    const brains = (j.models || []).filter((m) => ["chat", "reasoning", "code", "vision"].includes(m.kind));
    const makers = (j.models || []).filter((m) => m.kind === "image");
    brains.forEach((m) => { kindOf[m.id] = m.kind; }); makers.forEach((m) => { kindOf[m.id] = m.kind; });
    const grp = (label, list) => list.length ? `<optgroup label="${label}">` + list.map((m) => `<option value="${E(m.id)}">${E(m.name)}</option>`).join("") + "</optgroup>" : "";
    sel.innerHTML = `<option value="auto">✨ Auto</option><option value="quick">⚡ Quick</option><option value="deep">🧠 Deep</option>` + grp("🧠 Brains", brains) + grp("🎨 Image makers", makers);
    if ((picked && kindOf[picked]) || AI_TIERS.has(picked)) sel.value = picked; else { picked = "auto"; sel.value = "auto"; }
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
      hist.push({ role: "assistant", content: pic ? "🎨 Here's your picture — long-press it (or right-click) to save it." : errText, ...(pic ? { pic } : {}) }); if (hist.length > 40) hist.splice(0, hist.length - 40);
      busy = false; draw(false); return;
    }
    let reply;
    try {
      const tok = MW.session().access_token;
      const r = await fetch("/api/ai", { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer " + tok }, body: JSON.stringify({ messages: hist.slice(-20).map((m) => ({ role: m.role, content: m.content })), image: img || undefined, ...(picked && !viaTalk ? (AI_TIERS.has(picked) ? { tier: picked } : { model: picked }) : {}), ...(viaTalk ? { voice: true } : {}) }) });
      const j = await r.json().catch(() => ({}));
      reply = r.ok && j.reply ? j.reply + (j.sources && j.sources.length ? "\n\nSources: " + j.sources.map((x, i) => "[" + (i + 1) + "] " + x.title + " (" + x.url + ")").join("  ") : "") : (j.error === "busy" ? "I'm getting a lot of questions right now. Try again in a minute, or DM @meechiesworldinc on TikTok." : "I can't answer right now. DM @meechiesworldinc on TikTok or email meechiesworldinc@aol.com.");
    } catch (_) { reply = "I can't connect right now. Check your internet and try again."; }
    // a [[nav:view]] marker at the end of the answer becomes a Go button; it never shows as text
    let navTo = ""; const nm = /\[\[nav:([a-z]+)\]\]/.exec(reply || "");
    if (nm) { navTo = nm[1]; reply = reply.replace(/\s*\[\[nav:[a-z]+\]\]/g, "").trim(); }
    hist.push({ role: "assistant", content: reply, ...(navTo ? { nav: navTo } : {}) }); if (hist.length > 40) hist.splice(0, hist.length - 40);
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
  chips.addEventListener("click", (e) => { const b = e.target.closest("button"); if (!b) return; if (/take me to the radio/.test(b.textContent)) { goTo("radio"); return; } if (/court case/.test(b.textContent)) { if (typeof go === "function") go("legal"); panel.hidden = true; sync(); return; } ask(b.textContent); });
  panel.querySelector("#ai-new").addEventListener("click", () => { hist.length = 0; try { localStorage.removeItem("mw_ai2"); sessionStorage.removeItem("mw_ai"); } catch (_) {} haltSpeak(); draw(false); inp.focus(); });
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
  function openPanel() { if (!hist.length) { const g = greetNow(); hist.push({ role: "assistant", content: g }); try { localStorage.setItem("mw_ai2", JSON.stringify(hist)); } catch (_) {} draw(false); speak(g); } else draw(false); setTimeout(() => inp.focus(), 50); }
  return { open: openPanel, speak: speak, stopTalk: stopTalk };
  });
})();
