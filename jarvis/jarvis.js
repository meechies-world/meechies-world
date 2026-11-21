"use strict";
/* ============================================================
   MEECHIE JARVIS — phone PWA (Samsung S24 Ultra, Chrome)
   Talks to the PC hub per ARCHITECTURE.md §3:
     GET  {hubUrl}/jarvis/status
     POST {hubUrl}/jarvis/chat   {text, speaker:"Malik", session}
     POST {hubUrl}/jarvis/speak  {text, voice?}  -> audio bytes
     POST {hubUrl}/jarvis/remind {text, due}
   Auth: X-Jarvis-Token header. Hub URL + token live ONLY in
   this phone's localStorage — never in this file, never in code.
   Hub offline = LIGHT MODE: catalog.json answers + local reminders
   (stored in localStorage, synced to the hub next time it connects).
   Voice in: Web Speech API (free, Chrome on Android).
   Voice out: hub audio (Meechie's real voice, edge-tts
   en-US-GuyNeural) first; fallback = device SpeechSynthesis,
   labelled in the UI as "device voice" — it is NOT Meechie's voice.
   ============================================================ */

const $ = (s) => document.querySelector(s);
const $$ = (s) => Array.from(document.querySelectorAll(s));
const SITE = "https://meechiesworldinc.com";
const LINKS = {
  site: SITE,
  shop: SITE + "/#v-shop",
  lookup: SITE + "/lookup-app/",
  caprice: SITE + "/caprice/",
  radio: SITE + "/#radio",
  tiktokShop: "https://shop.tiktok.com/us/store/meechies-world-inc/7494976370425890255"
};
const SESSION = "phone-" + (localStorage.getItem("jarvis.session") ||
  (localStorage.setItem("jarvis.session", Math.random().toString(36).slice(2)), localStorage.getItem("jarvis.session")));

// ---------- SETTINGS (localStorage only) ----------
function getSettings() {
  return {
    hubUrl: (localStorage.getItem("jarvis.hubUrl") || "").replace(/\/+$/, ""),
    token: localStorage.getItem("jarvis.token") || ""
  };
}
function saveSettings(hubUrl, token) {
  localStorage.setItem("jarvis.hubUrl", hubUrl.replace(/\/+$/, ""));
  localStorage.setItem("jarvis.token", token);
}

// ---------- STATE ----------
let hubOnline = false;
let hubStatus = null;
let catalog = null;           // loaded from catalog.json
let audioEl = null;           // plays hub audio_b64
let speaking = false;
let recog = null;             // webkitSpeechRecognition
let listening = false;
let statusTimer = null;

// ---------- HELPERS ----------
function esc(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({"&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;"}[c]));
}
function money(n) { return "$" + Number(n).toFixed(2); }
function addMsg(who, html, tag) {
  const log = $("#chatlog");
  const d = document.createElement("div");
  d.className = "msg " + who;
  d.innerHTML = html + (tag ? `<span class="tag">${esc(tag)}</span>` : "");
  log.appendChild(d);
  log.scrollTop = log.scrollHeight;
  return d;
}
function setFaceTalking(on) {
  $("#meechieFace").classList.toggle("talking", !!on);
}
function setVoiceLabel(text, isDevice) {
  $("#voiceLabel").innerHTML = "Voice: <b>" + esc(text) + "</b>" + (isDevice ? " — device voice, not Meechie's" : "");
}

// ---------- HUB CALLS ----------
async function hubFetch(path, opts) {
  const { hubUrl, token } = getSettings();
  if (!hubUrl || !token) throw new Error("no-settings");
  const res = await fetch(hubUrl + path, Object.assign({}, opts, {
    headers: Object.assign({ "X-Jarvis-Token": token, "Content-Type": "application/json" }, (opts && opts.headers) || {})
  }));
  if (!res.ok) throw new Error("http-" + res.status);
  return res;
}
async function checkHub() {
  const pill = $("#statusPill"), txt = $("#statusText"), banner = $("#modeBanner");
  const { hubUrl, token } = getSettings();
  if (!hubUrl || !token) {
    hubOnline = false;
    pill.className = "pill offline";
    txt.textContent = "Hub not set up";
    banner.className = "show";
    banner.innerHTML = "<b>Hub is offline — light mode.</b> Tap ⚙️ and enter your tunnel URL + token. Until then I can still answer from my product catalog and take reminders — they'll sync to the hub when it connects.";
    setVoiceLabel("device voice", true);
    return false;
  }
  try {
    const res = await hubFetch("/jarvis/status", { method: "GET" });
    hubStatus = await res.json();
    hubOnline = true;
    pill.className = "pill online";
    txt.textContent = "Hub online" + (hubStatus && hubStatus.model ? " · " + hubStatus.model : "");
    banner.className = "";
    banner.innerHTML = "";
    setVoiceLabel("Meechie's voice", false);
    syncRemindersToHub();
    return true;
  } catch (e) {
    hubOnline = false;
    pill.className = "pill offline";
    txt.textContent = "Hub offline — light mode";
    banner.className = "show";
    banner.innerHTML = "<b>Hub is offline — light mode.</b> Your PC is off or the tunnel is down. I can still answer from my product catalog and take reminders — they'll sync to the hub when it connects.";
    setVoiceLabel("device voice", true);
    return false;
  }
}
function startStatusLoop() {
  if (statusTimer) clearInterval(statusTimer);
  checkHub();
  statusTimer = setInterval(checkHub, 30000);
}

// ---------- CATALOG (offline / light mode) ----------
async function loadCatalog() {
  try {
    const res = await fetch("./catalog.json");
    catalog = await res.json();
  } catch (e) {
    catalog = { products: [], faq: [], links: LINKS };
  }
}
function findProduct(q) {
  if (!catalog) return null;
  const words = q.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 2);
  let best = null, bestScore = 0;
  for (const p of catalog.products) {
    const n = p.name.toLowerCase();
    let s = 0;
    words.forEach((w) => { if (n.includes(w)) s += w.length; });
    if (s > bestScore) { bestScore = s; best = p; }
  }
  return bestScore >= 3 ? best : null;
}
const FAQ_STOP = ["much", "what", "where", "meechie", "meechies", "world"];
function lightAnswer(q) {
  const lq = q.toLowerCase();
  // FAQ first
  if (catalog && catalog.faq) {
    for (const f of catalog.faq) {
      const keys = f.q.toLowerCase().replace(/[^a-z0-9 ]/g, "").split(/\s+/).filter((w) => w.length > 3 && !FAQ_STOP.includes(w));
      if (keys.length && keys.some((k) => lq.includes(k))) return f.a;
    }
  }
  // Lookup pricing
  if (/lookup|phone number|reverse/.test(lq)) {
    return "MW Reverse Lookup — <a href='" + LINKS.lookup + "' target='_blank'>meechiesworldinc.com/lookup-app/</a>. First lookup <b>$1.99</b>, second <b>$5</b>, then <b>$10</b> unlocks unlimited. Never charged for an empty report, and reports stay private to the signed-in account.";
  }
  // Books
  if (/book/.test(lq)) {
    const books = ((catalog && catalog.products) || []).filter((p) => p.section === "books");
    let out = "Your books — paid ones are <b>$10</b> each:\n";
    books.forEach((b) => { out += "• <b>" + esc(b.name) + "</b> — " + (b.price > 0 ? "$10.00" : "FREE") + "\n"; });
    return out;
  }
  // Doty line
  if (/doty|caprice/.test(lq)) {
    return "Doty's World — Caprice's line at <a href='" + LINKS.caprice + "' target='_blank'>meechiesworldinc.com/caprice/</a>. In my offline list: Accent Coffee Mug <b>$10.67</b>, Plush Blanket <b>$22.73</b>, Softstyle T-Shirt <b>$18.02</b>, Hoodie white crown <b>$60.20</b>, Hoodie black Caprice <b>$62.00</b>, Shower Curtains <b>$67.95</b>. Full 12-piece line on the site.";
  }
  // Product price
  if (/how much|price|cost|hoodie|mug|blanket|shirt|tee|parka|jacket|wallet|slippers|poster|quilt|sherpa|umbrella|suitcase|mats|clock|pillow|patches|vacuum|cable|nails|oil|light|brush|comb|mat|peeler|warmer|t-shirt/.test(lq)) {
    const p = findProduct(q);
    if (p) return "The <b>" + esc(p.name) + "</b> is <b>" + money(p.price) + "</b>. Shop it at <a href='" + LINKS.shop + "' target='_blank'>meechiesworldinc.com</a>, Shop section.";
    return "That's not in my offline list of 30 — check the exact price on the site. I won't guess a price. My full brain is on the PC hub when it's online.";
  }
  // Site / shop
  if (/site|website|shop|store|meechiesworldinc/.test(lq)) {
    return "Your site is <a href='" + LINKS.site + "' target='_blank'>meechiesworldinc.com</a> — radio, MWTV, shop, books, lookup, Doty's World.";
  }
  if (/radio|play music|music/.test(lq)) {
    return "Radio lives on the site — <a href='" + LINKS.radio + "' target='_blank'>open the radio on meechiesworldinc.com</a>. When the hub is online I can drive it from here too.";
  }
  if (/^(hi|hey|hello|yo|what'?s up|wassup|good morning|good evening)\b/.test(lq)) {
    return "Yo, what's good? It's Meechie — your JARVIS, in light mode right now 'cause the hub is offline. I can still look up products, take a reminder, or open your site. What we doing?";
  }
  if (/thank/.test(lq)) return "You got it. Meechie to the world.";
  return null;
}

// ---------- REMINDERS (local first, sync to hub when online) ----------
function getLocalReminders() {
  try { return JSON.parse(localStorage.getItem("jarvis.reminders") || "[]"); } catch (e) { return []; }
}
function saveLocalReminders(list) {
  localStorage.setItem("jarvis.reminders", JSON.stringify(list));
}
async function addReminder(text, due) {
  const list = getLocalReminders();
  const item = { id: "r" + Date.now(), text, due: due || null, done: false, synced: false, created: new Date().toISOString() };
  list.push(item);
  saveLocalReminders(list);
  if (hubOnline) {
    try {
      await hubFetch("/jarvis/remind", { method: "POST", body: JSON.stringify({ text, due: due || null }) });
      item.synced = true;
      saveLocalReminders(list);
    } catch (e) { /* stays unsynced, retries on next connect */ }
  }
  renderReminders();
  return item;
}
async function syncRemindersToHub() {
  if (!hubOnline) return;
  const list = getLocalReminders();
  const pending = list.filter((r) => !r.synced && !r.done);
  if (!pending.length) return;
  for (const r of pending) {
    try {
      await hubFetch("/jarvis/remind", { method: "POST", body: JSON.stringify({ text: r.text, due: r.due || null }) });
      r.synced = true;
    } catch (e) { break; }
  }
  saveLocalReminders(list);
}
function renderReminders() {
  const list = getLocalReminders();
  const box = $("#drawer");
  if (!box.dataset.view || box.dataset.view !== "reminders") return;
  const rows = list.length ? list.slice().reverse().map((r) =>
    `<div class="item${r.done ? " done" : ""}"><b>${esc(r.text)}</b><br>` +
    (r.due ? `<span class="when">${esc(new Date(r.due).toLocaleString())}</span><br>` : "") +
    `<span style="color:var(--muted); font-size:12px;">${r.synced ? "✓ synced to hub" : "• saved on this phone — syncs when hub connects"}</span> ` +
    (r.done ? "" : ` <button class="ghost" data-done="${r.id}" style="padding:4px 8px; font-size:12px;">Done</button>`) +
    `</div>`).join("") : `<div class="item">No reminders yet. Tell Meechie "remind me to…" and he'll keep it here.</div>`;
  box.innerHTML = `<h2>⏰ Reminders</h2>` + rows +
    `<h3>New reminder</h3><input type="text" id="remText" placeholder="Remind me to…">` +
    `<input type="datetime-local" id="remDue"><div class="row"><button class="action" id="remAdd">Save reminder</button></div>` +
    `<p class="sync-note">Reminders live on this phone first. When the hub is online they sync to your PC too.</p>`;
  $("#remAdd").onclick = async () => {
    const t = $("#remText").value.trim();
    if (!t) return;
    await addReminder(t, $("#remDue").value ? new Date($("#remDue").value).toISOString() : null);
    addMsg("meechie", "Got it — I'll remind you: <b>" + esc(t) + "</b>." + (hubOnline ? "" : " (Saved on this phone — it'll sync to the hub when it connects.)"));
    speakText("Got it. I'll remind you: " + t);
  };
  box.querySelectorAll("[data-done]").forEach((b) => {
    b.onclick = () => {
      const l = getLocalReminders();
      const it = l.find((x) => x.id === b.getAttribute("data-done"));
      if (it) { it.done = true; saveLocalReminders(l); renderReminders(); }
    };
  });
}
function showReminders() {
  const box = $("#drawer");
  box.dataset.view = "reminders";
  box.classList.add("show");
  renderReminders();
}
function showCatalog() {
  const box = $("#drawer");
  box.dataset.view = "catalog";
  box.classList.add("show");
  const groups = {};
  ((catalog && catalog.products) || []).forEach((p) => { (groups[p.section] = groups[p.section] || []).push(p); });
  const labels = { printify: "Printify", doty: "Doty's World", cj_cheap_deals: "CJ Cheap Deals", books: "Books" };
  let html = "<h2>🛍️ Products (offline list — 30)</h2>";
  html += `<p style="font-size:12px; color:var(--muted); margin-bottom:8px;">Exact prices from the store catalog. Full range (88 items) lives on the hub + site.</p>`;
  for (const key of Object.keys(groups)) {
    html += `<h3>${esc(labels[key] || key)}</h3>`;
    groups[key].forEach((p) => {
      html += `<div class="item"><b>${esc(p.name)}</b><br><span class="price">${p.price > 0 ? money(p.price) : "FREE"}</span></div>`;
    });
  }
  html += `<div class="row" style="margin-top:10px;"><button class="action" id="openShopBtn">Open the Shop</button></div>`;
  box.innerHTML = html;
  $("#openShopBtn").onclick = () => window.open(LINKS.shop, "_blank");
}

// ---------- VOICE OUT ----------
function playHubAudio(b64, mime) {
  return new Promise((resolve) => {
    try {
      if (!audioEl) audioEl = new Audio();
      audioEl.onended = () => { speaking = false; setFaceTalking(false); resolve(); };
      audioEl.onerror = () => { speaking = false; setFaceTalking(false); resolve(); };
      audioEl.src = "data:" + (mime || "audio/mpeg") + ";base64," + b64;
      speaking = true; setFaceTalking(true);
      audioEl.play().catch(() => { speaking = false; setFaceTalking(false); resolve(); });
    } catch (e) { speaking = false; setFaceTalking(false); resolve(); }
  });
}
function speakDevice(text) {
  // Fallback only. Labelled in the UI as "device voice" — NOT Meechie's voice.
  setVoiceLabel("device voice", true);
  if (!("speechSynthesis" in window)) return;
  try {
    window.speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text.replace(/[*#`]/g, ""));
    u.rate = 1.0; u.pitch = 0.9;
    const voices = window.speechSynthesis.getVoices();
    u.voice = voices.find((v) => /en[-_]US/i.test(v.lang) && /male|david|guy|james/i.test(v.name)) ||
              voices.find((v) => /en[-_]US/i.test(v.lang)) || voices[0];
    u.onstart = () => setFaceTalking(true);
    u.onend = () => setFaceTalking(false);
    u.onerror = () => setFaceTalking(false);
    window.speechSynthesis.speak(u);
  } catch (e) { setFaceTalking(false); }
}
async function speakText(text) {
  const plain = text.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  if (!plain) return;
  if (hubOnline) {
    // Ask the hub for Meechie's real voice first.
    try {
      const res = await hubFetch("/jarvis/speak", { method: "POST", body: JSON.stringify({ text: plain }) });
      const data = await res.clone().json().catch(() => null);
      if (data && data.audio_b64) {
        setVoiceLabel("Meechie's voice", false);
        await playHubAudio(data.audio_b64, data.audio_mime || "audio/mpeg");
        return;
      }
      // Hub may return raw audio bytes instead of JSON.
      const buf = await res.arrayBuffer().catch(() => null);
      if (buf && buf.byteLength > 100) {
        const b64 = btoa(String.fromCharCode.apply(null, new Uint8Array(buf).slice(0, 65536)));
        setVoiceLabel("Meechie's voice", false);
        await playHubAudio(b64, "audio/mpeg");
        return;
      }
    } catch (e) { /* fall through to device voice */ }
  }
  speakDevice(plain);
}

// ---------- VOICE IN (Web Speech API — free, Chrome on Android) ----------
function startListening() {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) {
    addMsg("sys", "Voice input isn't available in this browser — type it instead. (Chrome on Android supports it.)");
    return;
  }
  if (recog) { try { recog.stop(); } catch (e) {} recog = null; listening = false; updateMicUI(); return; }
  recog = new SR();
  recog.lang = "en-US"; recog.interimResults = false; recog.maxAlternatives = 1;
  listening = true; updateMicUI();
  $("#reactor").classList.add("listening");
  recog.onresult = (e) => {
    const text = e.results[0][0].transcript;
    $("#chatInput").value = text;
    sendChat(text);
  };
  recog.onerror = () => { listening = false; recog = null; updateMicUI(); $("#reactor").classList.remove("listening"); };
  recog.onend = () => { listening = false; recog = null; updateMicUI(); $("#reactor").classList.remove("listening"); };
  try { recog.start(); } catch (e) { listening = false; recog = null; updateMicUI(); }
}
function updateMicUI() {
  $("#micBtn").classList.toggle("listening", listening);
  $("#micBtn").textContent = listening ? "⏹️" : "🎤";
  $("#reactorHint").textContent = listening ? "LISTENING… SPEAK NOW" : "HOLD THE REACTOR TO TALK";
}

// ---------- ACTIONS from hub replies ----------
function handleActions(actions) {
  if (!Array.isArray(actions)) return;
  for (const a of actions) {
    if (!a || !a.type) continue;
    if (a.type === "open_url" && a.url) window.open(a.url, "_blank");
    else if (a.type === "open_site") window.open(LINKS.site, "_blank");
    else if (a.type === "open_shop") window.open(LINKS.shop, "_blank");
    else if (a.type === "open_lookup") window.open(LINKS.lookup, "_blank");
    else if (a.type === "open_radio") window.open(LINKS.radio, "_blank");
    else if (a.type === "call" && a.number) window.location.href = "tel:" + a.number;
    else if (a.type === "text" && a.number) window.location.href = "sms:" + a.number + (a.body ? "?body=" + encodeURIComponent(a.body) : "");
    else if (a.type === "email" && a.to) window.location.href = "mailto:" + a.to + (a.subject ? "?subject=" + encodeURIComponent(a.subject) : "") + (a.body ? (a.subject ? "&" : "?") + "body=" + encodeURIComponent(a.body) : "");
    else if (a.type === "remind" && a.text) addReminder(a.text, a.due || null);
    else if (a.type === "show_reminders") showReminders();
    else if (a.type === "show_catalog") showCatalog();
    // Calls/texts/emails are DRAFTS only — JARVIS drafts, Malik taps send.
  }
}

// ---------- CHAT ----------
async function sendChat(text) {
  text = (text || $("#chatInput").value || "").trim();
  if (!text) return;
  $("#chatInput").value = "";
  $("#drawer").classList.remove("show");
  addMsg("user", esc(text));

  // Local quick commands that don't need the brain.
  const lq = text.toLowerCase();
  if (/^remind me/.test(lq)) {
    const what = text.replace(/^remind me( to)?/i, "").trim() || text;
    await addReminder(what, null);
    const reply = "Got it — I'll remind you: <b>" + esc(what) + "</b>." + (hubOnline ? "" : " (Saved on this phone — it'll sync to the hub when it connects.)");
    addMsg("meechie", reply, hubOnline ? "hub" : "light mode");
    speakText(reply);
    return;
  }
  if (/^(show )?(my )?reminders/.test(lq)) { showReminders(); return; }
  if (/^(show )?(products|catalog|shop)/.test(lq)) { showCatalog(); return; }
  if (/open (the )?site/.test(lq)) { window.open(LINKS.site, "_blank"); addMsg("meechie", "Opened your site. <a href='" + LINKS.site + "' target='_blank'>meechiesworldinc.com</a>", "light mode"); return; }
  if (/play (the )?radio/.test(lq)) { window.open(LINKS.radio, "_blank"); addMsg("meechie", "Radio's on the site — opened it for you. <a href='" + LINKS.radio + "' target='_blank'>Tap to listen</a>", hubOnline ? "hub" : "light mode"); return; }

  // Hub first (full brain, Meechie's real voice).
  if (hubOnline) {
    try {
      const res = await hubFetch("/jarvis/chat", {
        method: "POST",
        body: JSON.stringify({ text, speaker: "Malik", session: SESSION })
      });
      const data = await res.json();
      if (data && data.ok) {
        addMsg("meechie", esc(data.reply || ""), data.source ? "hub · " + data.source : "hub");
        handleActions(data.actions);
        if (data.audio_b64) {
          setVoiceLabel("Meechie's voice", false);
          await playHubAudio(data.audio_b64, data.audio_mime || "audio/mpeg");
        } else {
          speakText(data.reply || "");
        }
        return;
      }
    } catch (e) {
      hubOnline = false;
      checkHub();
    }
  }

  // Light mode: catalog + FAQ only, honest about it.
  const answer = lightAnswer(text);
  if (answer) {
    addMsg("meechie", answer, "light mode — hub offline");
    speakText(answer);
    return;
  }
  addMsg("meechie", "Hub is offline, so I'm in <b>light mode</b> — I can look up products and prices from my offline list, take reminders, and open your site. For the full brain (sales, Gmail, real talk), turn the PC on and make sure the tunnel is up, then tap ⚙️ to check the hub. What product you asking about?", "light mode — hub offline");
  speakText("Hub is offline, so I'm in light mode. I can look up products and prices from my offline list, take reminders, and open your site.");
}

// ---------- SETTINGS UI ----------
function openSettings() {
  const s = getSettings();
  $("#hubUrl").value = s.hubUrl;
  $("#hubToken").value = s.token;
  $("#settingsStatus").textContent = "";
  $("#settingsStatus").className = "";
  $("#settings").classList.add("show");
  $("#settings").scrollIntoView({ behavior: "smooth", block: "nearest" });
}
async function saveSettingsUI() {
  const url = $("#hubUrl").value.trim().replace(/\/+$/, "");
  const token = $("#hubToken").value.trim();
  const st = $("#settingsStatus");
  if (!url || !token) { st.textContent = "Enter both the tunnel URL and the token."; st.className = "err"; return; }
  if (!/^https?:\/\//.test(url)) { st.textContent = "The hub URL must start with https:// (the tunnel URL)."; st.className = "err"; return; }
  saveSettings(url, token);
  st.textContent = "Saved. Testing the hub…";
  st.className = "";
  const ok = await checkHub();
  if (ok) {
    st.textContent = "✓ Hub online — Meechie's voice is live. You're good.";
    st.className = "ok";
    addMsg("meechie", "Yo, we connected. I'm live on your phone now — full brain, my real voice. Talk to me anywhere.", "hub");
    speakText("Yo, we connected. I'm live on your phone now.");
  } else {
    st.textContent = "Saved, but the hub didn't answer. Check the URL + token, and make sure the PC is on and the tunnel is running (see TUNNEL.md). Light mode still works.";
    st.className = "err";
  }
}

// ---------- WIRING ----------
function init() {
  loadCatalog();
  startStatusLoop();

  $("#sendBtn").onclick = () => sendChat();
  $("#chatInput").addEventListener("keydown", (e) => { if (e.key === "Enter") sendChat(); });
  $("#micBtn").onclick = startListening;

  // Arc reactor: hold-to-talk (press & hold), tap = toggle listen.
  const reactor = $("#reactor");
  let holdTimer = null, held = false;
  reactor.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    held = false;
    holdTimer = setTimeout(() => { held = true; if (!listening) startListening(); }, 250);
  });
  const endHold = () => {
    clearTimeout(holdTimer);
    if (held) { if (listening) startListening(); } // release stops listening
    else { if (!listening) startListening(); }     // plain tap toggles
    held = false;
  };
  reactor.addEventListener("pointerup", endHold);
  reactor.addEventListener("pointerleave", () => { clearTimeout(holdTimer); });

  $$("#quick [data-quick]").forEach((b) => {
    b.onclick = () => {
      const q = b.getAttribute("data-quick");
      if (q === "catalog") { showCatalog(); return; }
      if (q === "remind me") { showReminders(); return; }
      if (q === "open site") { window.open(LINKS.site, "_blank"); return; }
      if (q === "play radio") { window.open(LINKS.radio, "_blank"); return; }
      sendChat(q === "check sales" ? "Check my sales" : q === "check gmail" ? "Check my Gmail" : q);
    };
  });

  $("#settingsBtn").onclick = () => {
    const s = $("#settings");
    if (s.classList.contains("show")) s.classList.remove("show");
    else openSettings();
  };
  $("#saveSettingsBtn").onclick = saveSettingsUI;
  $("#closeSettingsBtn").onclick = () => $("#settings").classList.remove("show");
  $("#hubToken").addEventListener("keydown", (e) => { if (e.key === "Enter") saveSettingsUI(); });
  $("#hubUrl").addEventListener("keydown", (e) => { if (e.key === "Enter") saveSettingsUI(); });

  // First-run greeting.
  const s = getSettings();
  setTimeout(() => {
    if (!s.hubUrl || !s.token) {
      addMsg("meechie", "Yo, it's Meechie — your JARVIS, on your phone now. 👊<br><br>Tap the <b>⚙️</b> up top and enter your <b>tunnel URL + token</b> (from the PC hub install) to wake up my full brain and my real voice.<br><br>Until then I'm in <b>light mode</b>: I can still look up your products and prices, take reminders, and open your site. Hold the reactor and talk to me.", "light mode — first run");
    } else {
      addMsg("meechie", "Yo, what's good? It's Meechie. Checking the hub…", "starting up");
    }
  }, 400);

  // Service worker (installable PWA). Served from /jarvis/, so scope is local.
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("./sw.js").catch(() => {});
  }
  // Warm up device voices list (needed before first speak).
  if ("speechSynthesis" in window) window.speechSynthesis.getVoices();
}
document.addEventListener("DOMContentLoaded", init);
