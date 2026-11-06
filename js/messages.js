/*
 * Messenger: private messages between members, like Facebook Messenger.
 * Stored in the `dms` table. Row-level security means only the sender and the recipient can ever read a message.
 * Not end-to-end encrypted.
 *  - profile photos + green "active now" dot (site presence)
 *  - "typing..." (live broadcast between the two people, nothing saved)
 *  - photos, walkie-talkie voice notes, emoji reactions, quick 👍, "Seen"
 *  - messages grouped by person and day, a floating chat bubble on every page with the unread count
 * Special bodies (so no database change was needed):
 *   "🎙️ Voice message ⟦url⟧", "📷 Photo ⟦url⟧", "⟦react:<message id>:<emoji>⟧"
 */
(function () {
  "use strict";
  const view = document.getElementById("v-messages");
  if (!view || !window.MW || !MW.ready) return;
  const sb = MW.sb;
  let seenIds = null, uid = null, all = [], other = null, q = "", timer = null, started = false;
  let typingCh = null, typingWith = null, theyTypeUntil = 0, lastTypeSent = 0, pickFor = null;
  let mini = null, heads = []; const fresh = [];
  let tab = "chats", replyTo = null, forwardBody = null, showArch = false;
  let prefs = { pin: [], mute: [], arch: [], hideReq: [], vanish: {}, leftGroups: [] };
  try { const p = JSON.parse(localStorage.getItem("mw_mx_prefs") || "{}"); if (p && typeof p === "object") prefs = Object.assign(prefs, p); } catch (_) {}
  const savePrefs = () => { try { localStorage.setItem("mw_mx_prefs", JSON.stringify(prefs)); } catch (_) {} };
  const inList = (k, id) => (prefs[k] || []).includes(id);
  const toggleIn = (k, id) => { prefs[k] = inList(k, id) ? prefs[k].filter((x) => x !== id) : [...(prefs[k] || []), id]; savePrefs(); };
  try { heads = JSON.parse(sessionStorage.getItem("mx_heads") || "[]").filter((x) => typeof x === "string").slice(0, 4); } catch (_) {}
  /* the view-core fragment (js/messages-view.js) is fetched and eval'd
   * inside this closure (see kickView below); its URL derives from
   * this script's own stamped src, like the owner editor chunk */
  const MX_SELF = (document.currentScript && document.currentScript.src) || "";

  const E = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const mem = (id) => (typeof members !== "undefined" && members[id]) || {};
  const handle = (id) => mem(id).handle || "Member";
  const ini = (s) => (String(s || "?").trim()[0] || "?").toUpperCase();
  const photo = (id) => { const p = mem(id).photo; return /^https:\/\//.test(p || "") || /^data:image\/(png|jpe?g|webp);base64,/.test(p || "") ? p : ""; };
  const onlineIds = () => { const s = new Set(); try { (typeof room !== "undefined" && room && room.peers ? room.peers() : []).forEach((p) => p.by && s.add(p.by)); } catch (_) {} return s; };
  const av = (id, cls = "") => { const p = photo(id), on = onlineIds().has(id), pp = (mem(id) || {}).photoPos, ps = /^\d{1,3}% \d{1,3}%$/.test(pp || "") ? ` style="object-position:${pp}"` : ""; return `<span class="mx-av ${cls}">${p ? `<img src="${E(p)}" alt=""${ps}>` : `<b>${E(ini(handle(id)))}</b>`}${on ? '<i class="on" title="Active now"></i>' : ""}</span>`; };
  const when = (iso) => { const ms = new Date(iso).getTime(), s = (Date.now() - ms) / 1000; if (s < 60) return "now"; if (s < 3600) return Math.floor(s / 60) + "m"; if (s < 86400) return Math.floor(s / 3600) + "h"; if (s < 604800) return Math.floor(s / 86400) + "d"; return new Date(ms).toLocaleDateString(); };
  const clock = (iso) => new Date(iso).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  const dayLabel = (iso) => { const d = new Date(iso), t = new Date(); const y = new Date(); y.setDate(t.getDate() - 1);
    if (d.toDateString() === t.toDateString()) return "Today"; if (d.toDateString() === y.toDateString()) return "Yesterday";
    return d.toLocaleDateString([], { weekday: "short", month: "short", day: "numeric", year: d.getFullYear() === t.getFullYear() ? undefined : "numeric" }); };
  const say = (t) => (typeof toast === "function" ? toast(t) : null);

  const STORE = "https:\\/\\/yjouaysczttqbytksejq\\.supabase\\.co\\/storage\\/v1\\/object\\/public\\/media\\/[A-Za-z0-9_\\-\\/]+";
  const VOICE_RE = new RegExp("^🎙️ Voice message ⟦(" + STORE + "\\.(?:webm|m4a|mp4|ogg))⟧$");
  const PHOTO_RE = new RegExp("^📷 Photo ⟦(" + STORE + "\\.(?:jpg|png|webp))⟧$");
  const REACTS = ["❤️", "😂", "😮", "😢", "😡", "👍"];
  const voiceUrl = (b) => (VOICE_RE.exec(b || "") || [])[1] || "";
  const photoUrl = (b) => (PHOTO_RE.exec(b || "") || [])[1] || "";
  /* Message bodies can carry bracket tags in any order, stripped before display:
   * ⟦g:<groupId>⟧ group copy · ⟦m:<msgId>⟧ one shared id on every group copy ·
   * ⟦x:<epochMs>⟧ disappearing expiry · ⟦q:<id>⟧ quote · ⟦react:…⟧ reaction */
  const REACT_TAIL = /^⟦react:(@?)([a-z0-9-]+):(❤️|😂|😮|😢|😡|👍|🔥)⟧$/;
  const TAG_RES = [["g", /^⟦g:([a-z0-9-]{1,48})⟧/i], ["m", /^⟦m:([a-z0-9-]{6,48})⟧/i], ["x", /^⟦x:(\d{10,16})⟧/], ["q", /^⟦q:([a-z0-9-]+)⟧/i]];
  const tagsOf = (b) => { const t = {}; let s = String(b || ""); let again = true; while (again) { again = false; for (const [k, re] of TAG_RES) { const m = re.exec(s); if (m) { t[k] = m[1]; s = s.slice(m[0].length); again = true; } } } return { t, s }; };
  const bareText = (b) => tagsOf(b).s;
  const quoteOf = (b) => tagsOf(b).t.q || null;
  const groupOfRow = (r) => tagsOf(r.body).t.g || null;
  const muidOf = (r) => tagsOf(r.body).t.m || null;
  const expired = (r) => { const x = +tagsOf(r.body).t.x || 0; return x > 0 && x <= Date.now(); };
  const reactOf = (b) => { const m = REACT_TAIL.exec(tagsOf(b).s); return m ? { target: m[2], emoji: m[3] } : null; };
  const isReact = (b) => !!reactOf(b);
  const preview = (r) => { const b = bareText(r.body); if (voiceUrl(b)) return "🎙️ Voice message"; if (photoUrl(b)) return "📷 Photo"; const m = reactOf(r.body); if (m) return "Reacted " + m.emoji + " to a message"; return b; };
  /* ---------- Stage 2: group chats + disappearing messages ---------- */
  const DB = () => (typeof db !== "undefined" ? db : null);
  let groups = {}; // gid -> {name, members:[uids], owner}
  const curGid = () => (other && other.startsWith("g:") ? other.slice(2) : null);
  const gname = (gid) => (groups[gid] && groups[gid].name) || "Group chat";
  const gav = (gid, cls = "") => `<span class="mx-av grp ${cls}">👥</span>`;
  const VANISH_STEPS = [0, 86400000, 604800000];
  const vanishMs = (chatId) => (prefs.vanish && prefs.vanish[chatId]) || 0;
  const vanishLabel = (chatId) => (vanishMs(chatId) === 86400000 ? "24h" : vanishMs(chatId) === 604800000 ? "7d" : "");
  const vPrefix = (chatId) => (vanishMs(chatId) ? "⟦x:" + (Date.now() + vanishMs(chatId)) + "⟧" : "");
  const vanishLeft = (r) => { const x = +tagsOf(r.body).t.x || 0; if (!x) return ""; const ms = x - Date.now(); if (ms <= 0) return ""; const h = Math.floor(ms / 3600e3), m = Math.floor((ms % 3600e3) / 60e3); return " · ⏳ " + (h >= 24 ? Math.floor(h / 24) + "d left" : h >= 1 ? h + "h left" : Math.max(1, m) + "m left"); };
  const linkify = (t) => E(t).replace(/(^|\s)(https:\/\/[^\s<]+)/g, (m, p, u) => `${p}<a href="${u}" target="_blank" rel="noopener nofollow">${u.length > 48 ? u.slice(0, 46) + "…" : u}</a>`)
    // phone numbers in a message can be tapped to call
    .replace(/(^|[\s(:])(\+?1?[\s.-]?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4})(?=$|[\s.,!?)])/g, (m, p, n) => `${p}<a href="tel:${n.replace(/[^\d+]/g, "")}">📞 ${n}</a>`);

  /* walkie-talkie voice notes from friends play right away */
  const bootAt = Date.now(); const heard = new Set();
  function autoPlayVoices() {
    let walkieOn = true; try { walkieOn = localStorage.getItem("mw_walkie_auto") !== "0"; } catch (_) {}
    for (const r of all) {
      const u = voiceUrl(r.body); if (!u || r.sender === uid || heard.has(r.id) || new Date(r.created_at).getTime() < bootAt - 5000) continue;
      heard.add(r.id);
      const isFriend = window.MW_FRIENDS && MW_FRIENDS.isFriend(r.sender);
      if (!walkieOn || !(isFriend || r.sender === other)) continue;
      say("📻 Walkie from " + handle(r.sender));
      try { if (typeof media !== "undefined" && !media.paused) { if (window.MW_duck) MW_duck(0.25); else media.volume = 0.25; } } catch (_) {}
      const a = new Audio(u); a.play().catch(() => {}); a.onended = a.onerror = () => { try { if (window.MW_duck) MW_duck(1); else media.volume = 1; } catch (_) {} };
    }
  }

  function convos() {
    const m = new Map(), gm = new Map();
    for (const r of all) {
      const gid = groupOfRow(r);
      if (gid) {
        if (inList("leftGroups", gid) || !groups[gid]) continue;
        let c = gm.get(gid); if (!c) { c = { id: "g:" + gid, gid, group: true, last: r, unread: 0 }; gm.set(gid, c); }
        if (r.recipient === uid && !r.read_at && !isReact(r.body)) c.unread++;
        continue;
      }
      const o = r.sender === uid ? r.recipient : r.sender;
      let c = m.get(o); if (!c) { c = { id: o, last: r, unread: 0 }; m.set(o, c); }
      if (r.recipient === uid && !r.read_at && !isReact(r.body)) c.unread++;
    }
    return [...gm.values(), ...m.values()].sort((a, b) => new Date(b.last.created_at) - new Date(a.last.created_at));
  }
  const unreadCount = () => all.filter((r) => r.recipient === uid && !r.read_at && !isReact(r.body)).length;
  function paintDot() {
    const n = unreadCount();
    document.querySelectorAll("[data-go=messages] .dm-dot").forEach((d) => { d.hidden = !n; d.textContent = n > 9 ? "9+" : n; });
    const f = document.getElementById("mx-fab"); if (f) { const b = f.querySelector("i"); b.hidden = !n; b.textContent = n > 9 ? "9+" : n; }
  }
  function pop() { try { const c = new (window.AudioContext || window.webkitAudioContext)(), o = c.createOscillator(), g = c.createGain(); o.type = "sine"; o.frequency.setValueAtTime(660, c.currentTime); o.frequency.exponentialRampToValueAtTime(990, c.currentTime + 0.08); g.gain.setValueAtTime(0.0001, c.currentTime); g.gain.exponentialRampToValueAtTime(0.14, c.currentTime + 0.01); g.gain.exponentialRampToValueAtTime(0.0001, c.currentTime + 0.25); o.connect(g).connect(c.destination); o.start(); o.stop(c.currentTime + 0.3); setTimeout(() => c.close(), 500); } catch (_) {} }

  async function load() {
    const { data, error } = await sb.from("dms").select("*").order("created_at", { ascending: false }).limit(800);
    if (error) { console.warn(error); return; }
    const prevIds = seenIds; seenIds = new Set((data || []).map((r) => r.id));
    if (prevIds) (data || []).forEach((r) => {
      if (prevIds.has(r.id) || r.recipient !== uid || r.sender === uid) return;
      if (r.sender === other && !view.hidden && !document.hidden) { theyTypeUntil = 0; return; } // you're looking at it
      if (isReact(r.body)) return;
      if (groupOfRow(r) || expired(r)) return; // group + vanishing mail: no banner or pop — the unread badge still counts it
      if (inList("mute", r.sender)) { addHead(r.sender); return; } // muted: head badge only, no sound, no banner
      if (mini === r.sender && !document.hidden) return; // its chat window is open
      pop(); if (window.MW_NOTIFY) MW_NOTIFY("New message from " + handle(r.sender), String(preview(r)).slice(0, 80));
      fresh.push(r);
    });
    let rows = data || [];
    // disappearing messages: once expired they vanish — delete my copies for real (the other
    // person's copy vanishes from their screen on their next load the same way)
    rows = rows.filter((r) => { if (!expired(r)) return true; try { sb.from("dms").delete().eq("id", r.id).then(() => {}, () => {}); } catch (_) {} return false; });
    // group fan-out: my own sent messages exist once per member — keep one copy of each
    const seenM = new Set();
    rows = rows.filter((r) => { if (r.sender !== uid) return true; const mu = muidOf(r); if (!mu) return true; if (seenM.has(mu)) return false; seenM.add(mu); return true; });
    all = rows; paintDot(); autoPlayVoices(); if (!view.hidden) renderGate();
    fresh.forEach(popIn); fresh.length = 0; paintHeads(); if (mini) paintMini();
  }
  /* D1 BURN FIX (2026-11-06): the dms-live channel already reloads on every
     change; the 45s timer below now only fires when a change was signalled
     but its debounced load has not completed — it is a safety net, not a
     second full reload of the whole mailbox every 45s per signed-in tab. */
  let dmDirty = false;
  function later() { dmDirty = true; clearTimeout(timer); timer = setTimeout(() => { dmDirty = false; load(); }, 200); }

  async function markRead() {
    if (!other || document.hidden) return;
    if (!all.some((r) => r.sender === other && r.recipient === uid && !r.read_at)) return;
    await sb.from("dms").update({ read_at: new Date().toISOString() }).eq("recipient", uid).eq("sender", other).is("read_at", null);
    all.forEach((r) => { if (r.sender === other && r.recipient === uid && !r.read_at) r.read_at = new Date().toISOString(); });
    paintDot();
  }
  async function markReadGroup(gid) {
    if (document.hidden) return;
    const senders = [...new Set(all.filter((r) => groupOfRow(r) === gid && r.recipient === uid && !r.read_at).map((r) => r.sender))];
    for (const s of senders) { try { await sb.from("dms").update({ read_at: new Date().toISOString() }).eq("recipient", uid).eq("sender", s).is("read_at", null); } catch (_) {} }
    if (senders.length) { all.forEach((r) => { if (groupOfRow(r) === gid && r.recipient === uid && !r.read_at) r.read_at = new Date().toISOString(); }); paintDot(); }
  }

  /* ---------- typing indicator (live, nothing saved) ---------- */
  function typingChannel() {
    if (!other || typingWith === other) return;
    try { if (typingCh) sb.removeChannel(typingCh); } catch (_) {}
    typingWith = other; theyTypeUntil = 0;
    const name = "mx-typing:" + [uid, other].sort().join(":");
    typingCh = sb.channel(name, { config: { broadcast: { self: false } } }).on("broadcast", { event: "typing" }, (p) => {
      if (!p || !p.payload || p.payload.from !== other) return;
      theyTypeUntil = Date.now() + 4000; paintTyping();
    }).subscribe();
  }
  function sendTyping() { if (!typingCh || Date.now() - lastTypeSent < 2000) return; lastTypeSent = Date.now(); try { typingCh.send({ type: "broadcast", event: "typing", payload: { from: uid } }); } catch (_) {} }
  function paintTyping() {
    const t = document.getElementById("mx-typing"); if (!t) return;
    const on = Date.now() < theyTypeUntil; t.hidden = !on;
    const st = document.getElementById("mx-status"); if (st) st.textContent = on ? "typing…" : onlineIds().has(other) ? "Active now" : "";
    if (on) { const box = document.getElementById("dm-msgs"); if (box && box.scrollHeight - box.scrollTop - box.clientHeight < 120) box.scrollTop = box.scrollHeight; setTimeout(paintTyping, 1200); }
  }

  function bubble(r) {
    const body = bareText(r.body), v = voiceUrl(body), p = photoUrl(body);
    const qid = quoteOf(r.body);
    const qrow = qid ? all.find((x) => String(x.id) === String(qid)) || all.find((x) => muidOf(x) === qid) : null;
    const q = qrow ? `<div class="mx-quote"><b>${E(handle(qrow.sender))}</b><span>${E(String(preview(qrow)).slice(0, 90))}</span></div>` : "";
    if (v) return q + `<div class="mx-bub voice"><span>🎙️ Walkie</span><audio src="${E(v)}" controls preload="none"></audio></div>`;
    if (p) return q + `<a class="mx-photo" href="${E(p)}" target="_blank" rel="noopener"><img src="${E(p)}" alt="Photo" loading="lazy"></a>`;
    const big = /^(\p{Extended_Pictographic}|️|‍|\s){1,8}$/u.test(body) && body.trim().length <= 12;
    return q + `<div class="mx-bub${big ? " big" : ""}">${linkify(body)}</div>`;
  }

  function open(id) { if (forwardBody) { const b = forwardBody; forwardBody = null; (id.startsWith("g:") ? sendGroup(id.slice(2), b, null) : send(vPrefix(id) + b, id)).then((ok) => say(ok ? "Forwarded" : "Could not forward")); return; } other = id; replyTo = null; q = ""; const s = view.querySelector(".dm-search"); if (s) s.value = ""; if (typeof go === "function") go("messages"); renderGate(); if (!mxView) mxPendFocus = true; setTimeout(() => { const i = document.getElementById("dm-in"); if (i) i.focus(); }, 50); }
  async function send(body, to = other) {
    if (!body || !to) return false;
    const { error } = await sb.from("dms").insert({ recipient: to, body });
    if (error) { say("Could not send: " + error.message); return false; }
    if (window.MW_pushNotify && !/^⟦react:/.test(body)) MW_pushNotify(to);
    load(); return true;
  }
  /* group fan-out: one body, one copy per member. Every copy carries the group tag; my own
   * copies share the ⟦m:⟧ id, so my screens show the message once */
  async function fanOut(gid, body) {
    const g = groups[gid]; if (!g) return false;
    const targets = (g.members || []).filter((x) => x !== uid).slice(0, 10);
    if (!targets.length) { say("You're the only one in this group."); return false; }
    let ok = false;
    for (const to of targets) { const { error } = await sb.from("dms").insert({ recipient: to, body }); if (!error) { ok = true; if (window.MW_pushNotify) MW_pushNotify(to); } }
    if (ok) load();
    return ok;
  }
  async function sendGroup(gid, text, rp) {
    if (!text) return false;
    const muid = "m" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
    const body = "⟦g:" + gid + "⟧⟦m:" + muid + "⟧" + vPrefix(other) + (rp ? "⟦q:" + rp + "⟧" : "") + text;
    return fanOut(gid, body);
  }
  const sendCore = (core) => (curGid() ? sendGroup(curGid(), core, null) : send(vPrefix(other) + core));

  function buildCore() {
    const css = document.createElement("style");
    css.textContent = `
.mx-av{position:relative;flex:none;width:46px;height:46px;border-radius:50%;display:grid;place-items:center;background:linear-gradient(135deg,#3a2c14,#1d1810);border:1px solid var(--gold-lo)}
.mx-av img{width:100%;height:100%;border-radius:50%;object-fit:cover}.mx-av b{color:var(--gold-hi);font:800 17px var(--body)}
.mx-av .on{position:absolute;right:-1px;bottom:-1px;width:13px;height:13px;border-radius:50%;background:#31d158;border:2.5px solid #12100c}
.mx-av.md{width:40px;height:40px}.mx-av.sm{width:28px;height:28px}.mx-av.sm b{font-size:12px}.mx-av.sm .on{width:9px;height:9px;border-width:2px}
.mx-msg{display:flex;align-items:flex-end;gap:7px;max-width:100%;position:relative}
.mx-msg.end{margin-bottom:8px}.mx-msg.me{flex-direction:row-reverse}
.mx-col{display:grid;max-width:min(72%,520px);position:relative}
.mx-bub{background:#2a2418;color:var(--text);padding:8px 13px;border-radius:18px;overflow-wrap:anywhere;line-height:1.4;font-size:15px;white-space:pre-wrap}
.mx-msg.me .mx-bub{background:linear-gradient(135deg,#e2b54e,#c99a3a);color:#0b0a08}
.mx-msg.me .mx-bub a{color:#0b0a08}.mx-bub a{color:var(--gold-hi)}
.mx-bub.big{background:none!important;font-size:38px;padding:0 2px;line-height:1.15}
.mx-bub.voice{display:grid;gap:4px}.mx-bub.voice audio{max-width:240px}
.mx-photo img{display:block;max-width:240px;max-height:320px;border-radius:16px;border:1px solid var(--line)}
.dm-dot{display:inline-block;margin-left:6px;background:#e5484d;color:#fff;border-radius:999px;font-size:11px;font-weight:800;padding:0 6px;line-height:16px}
.dm-btn{margin-left:auto}
#mx-fab{position:fixed;right:16px;bottom:calc(var(--tabbar,0px) + 64px + env(safe-area-inset-bottom,0px));z-index:9996;width:54px;height:54px;border-radius:50%;border:1px solid var(--gold-hi,#f0cf78);background:linear-gradient(135deg,#e2b54e,#a87a22);color:#0b0a08;font-size:24px;cursor:pointer;box-shadow:0 10px 28px rgba(0,0,0,.55);display:grid;place-items:center}
body.has-player #mx-fab{bottom:calc(var(--tabbar,0px) + 140px + env(safe-area-inset-bottom,0px))}
#mx-fab svg{width:26px;height:26px}
#mx-fab i{position:absolute;top:-4px;right:-4px;min-width:20px;height:20px;border-radius:999px;background:#e5484d;color:#fff;font:800 11px/20px system-ui,sans-serif;font-style:normal;padding:0 5px;border:2px solid #0b0a08}

body.mw-editing #mx-fab{display:none}
.mx-quote{display:grid;gap:1px;background:rgba(0,0,0,.28);border-left:3px solid var(--gold);border-radius:8px;padding:6px 9px;margin-bottom:5px;font-size:12.5px}
.mx-quote b{color:var(--gold-hi);font-size:11.5px}.mx-quote span{opacity:.85;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}`;
    document.head.appendChild(css);

    /* "Message" buttons anywhere on the site */
    document.addEventListener("click", (e) => {
      const b = e.target.closest("[data-dm]"); if (!b) return; e.preventDefault();
      if (!uid) { if (typeof openAuth === "function") openAuth("signup"); return; }
      if (b.dataset.dm === uid) { say("That's you."); return; }
      open(b.dataset.dm);
    });
    new MutationObserver(() => { if (!view.hidden) renderGate(); paintFab(); }).observe(view, { attributes: true, attributeFilter: ["hidden"] });
    document.addEventListener("visibilitychange", () => { if (!document.hidden && !view.hidden) markRead(); });
  }

  /* floating chat bubble on every page */
  function fab() {
    const f = document.createElement("button"); f.id = "mx-fab"; f.type = "button"; f.setAttribute("aria-label", "Open Messenger"); f.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3C6.9 3 3 6.6 3 11.1c0 2.4 1.1 4.6 3 6.1V21l3.3-1.8c.9.2 1.8.4 2.7.4 5.1 0 9-3.6 9-8.1S17.1 3 12 3z" fill="#0b0a08"/><path d="M7.5 13.2 10.6 9.9l2 2 3.4-2-3.1 3.3-2-2z" fill="#e2b54e"/></svg><i hidden></i>';
    f.addEventListener("click", () => { if (typeof go === "function") go("messages"); });
    document.body.appendChild(f); paintDot(); paintFab();
  }
  function paintFab() { const f = document.getElementById("mx-fab"); if (f) f.hidden = !uid || !view.hidden; paintHeads(); if (!view.hidden && mini) closeMini(); }

  /* ---------- Facebook-style chat heads, pop-up preview card and mini chat windows ---------- */
  const saveHeads = () => { try { sessionStorage.setItem("mx_heads", JSON.stringify(heads)); } catch (_) {} };
  const unreadFrom = (id) => all.filter((r) => r.sender === id && r.recipient === uid && !r.read_at && !isReact(r.body)).length;
  function addHead(id) { heads = [id, ...heads.filter((h) => h !== id)].slice(0, 4); saveHeads(); }
  function paintHeads() {
    let box = document.getElementById("mx-heads");
    if (!box) { box = document.createElement("div"); box.id = "mx-heads"; document.body.appendChild(box); }
    box.hidden = !uid || !view.hidden || !heads.length;
    box.innerHTML = heads.map((id) => { const n = unreadFrom(id);
      return `<div class="mx-head${mini === id ? " on" : ""}"><button type="button" class="mx-head-b" data-head="${E(id)}" title="${E(handle(id))}" aria-label="Chat with ${E(handle(id))}">${av(id)}${n ? `<i>${n > 9 ? "9+" : n}</i>` : ""}</button><button type="button" class="mx-head-x" data-headx="${E(id)}" aria-label="Close chat head">×</button></div>`; }).join("");
  }
  function popIn(r) {
    const id = r.sender; addHead(id);
    if (window.MW_screenClear && !MW_screenClear("mx-pop")) { setTimeout(() => popIn(r), 5000); return; } // one card at a time: wait your turn instead of covering the page
    let card = document.getElementById("mx-pop");
    if (!card) { card = document.createElement("div"); card.id = "mx-pop"; card.setAttribute("role", "status"); document.body.appendChild(card); }
    card.dataset.from = id;
    card.innerHTML = `<button type="button" class="mx-pop-x" data-popx aria-label="Dismiss">×</button>
<button type="button" class="mx-pop-main" data-head="${E(id)}">${av(id, "md")}<span><b>${E(handle(id))}</b><small>${E(String(preview(r)).slice(0, 90))}</small></span></button>
<form class="mx-pop-reply" data-popreply="${E(id)}"><input type="text" maxlength="2000" placeholder="Reply to ${E(handle(id).split(" ")[0])}…" aria-label="Quick reply" autocomplete="off"><button type="submit" aria-label="Send">➤</button></form>`;
    card.hidden = false; card.classList.remove("in"); void card.offsetWidth; card.classList.add("in");
    clearTimeout(card._t); const hide = () => { const inp = card.querySelector("input"); if (inp && document.activeElement === inp && inp.value.trim()) { card._t = setTimeout(hide, 3000); return; } card.hidden = true; };
    card._t = setTimeout(hide, 8000); // touch-safe: only a half-typed reply holds the banner open, never a sticky :hover
  }
  function openMini(id) {
    if (!view.hidden) { open(id); return; }
    if (window.innerWidth < 520) { open(id); return; } // phones: full Messenger is easier to use
    mini = id; addHead(id);
    const p = document.getElementById("mx-pop"); if (p && p.dataset.from === id) p.hidden = true;
    paintMini(true); paintHeads(); markMiniRead();
    setTimeout(() => document.querySelector("#mx-mini input")?.focus(), 30);
  }
  function closeMini() { mini = null; const w = document.getElementById("mx-mini"); if (w) w.hidden = true; paintHeads(); }
  async function markMiniRead() {
    if (!mini || document.hidden || !unreadFrom(mini)) return;
    await sb.from("dms").update({ read_at: new Date().toISOString() }).eq("recipient", uid).eq("sender", mini).is("read_at", null);
    all.forEach((r) => { if (r.sender === mini && r.recipient === uid && !r.read_at) r.read_at = new Date().toISOString(); });
    paintDot(); paintHeads();
  }
  function paintMini(first) {
    let w = document.getElementById("mx-mini");
    if (!w) { w = document.createElement("div"); w.id = "mx-mini"; document.body.appendChild(w); }
    if (!mini) { w.hidden = true; return; }
    const box0 = w.querySelector(".mm-msgs"), atBottom = first || !box0 || box0.scrollHeight - box0.scrollTop - box0.clientHeight < 60;
    const draft = w.querySelector("input")?.value || "", focused = document.activeElement && w.contains(document.activeElement);
    const msgs = all.filter((r) => !groupOfRow(r) && ((r.sender === uid && r.recipient === mini) || (r.sender === mini && r.recipient === uid)) && !isReact(r.body)).slice(0, 40).reverse();
    w.innerHTML = `<div class="mm-head">${av(mini, "sm")}<b>${E(handle(mini))}</b><small>${onlineIds().has(mini) ? "Active now" : ""}</small>
<button type="button" data-mmfull title="Open in Messenger" aria-label="Open in Messenger">⤢</button><button type="button" data-mmclose aria-label="Close chat">×</button></div>
<div class="mm-msgs">${msgs.length ? msgs.map((r) => `<div class="mx-msg ${r.sender === uid ? "me" : ""} end">${r.sender !== uid ? av(r.sender, "sm") : ""}<div class="mx-col">${bubble(r)}</div></div>`).join("") : `<p class="muted" style="text-align:center;margin:auto">Say hello 👋</p>`}</div>
<form class="mm-form" data-mmform><input type="text" maxlength="2000" placeholder="Aa" aria-label="Message" autocomplete="off"><button type="submit" aria-label="Send">➤</button></form>`;
    w.hidden = false;
    const i = w.querySelector("input"); if (draft) i.value = draft; if (focused) i.focus();
    const b = w.querySelector(".mm-msgs"); if (atBottom) b.scrollTop = b.scrollHeight;
    markMiniRead();
  }
  function wireHeads() {
    document.addEventListener("click", (e) => {
      const h = e.target.closest("[data-head]"); if (h) { e.preventDefault(); const id = h.dataset.head; if (mini === id && h.classList.contains("mx-head-b")) closeMini(); else openMini(id); return; }
      const x = e.target.closest("[data-headx]"); if (x) { heads = heads.filter((id) => id !== x.dataset.headx); saveHeads(); if (mini === x.dataset.headx) closeMini(); paintHeads(); return; }
      if (e.target.closest("[data-popx]")) { const card = document.getElementById("mx-pop"); if (card) { card.hidden = true; const id = card.dataset.from; if (id) { heads = heads.filter((h) => h !== id); saveHeads(); if (mini === id) closeMini(); paintHeads(); } } return; }
      if (e.target.closest("[data-mmclose]")) { const id = mini; closeMini(); if (id) { heads = heads.filter((h) => h !== id); saveHeads(); paintHeads(); } return; }
      if (e.target.closest("[data-mmfull]")) { const id = mini; closeMini(); open(id); return; }
    });
    document.addEventListener("submit", async (e) => {
      const f = e.target.closest("[data-popreply],[data-mmform]"); if (!f) return; e.preventDefault();
      const to = f.dataset.popreply || mini, i = f.querySelector("input"), body = i.value.trim(); if (!body || !to) return;
      i.value = ""; const ok = await send(vPrefix(to) + body, to);
      if (!ok) { i.value = body; return; }
      if (f.dataset.popreply) { document.getElementById("mx-pop").hidden = true; say("Sent to " + handle(to)); await markReadFrom(to); }
    });
    document.addEventListener("visibilitychange", () => { if (!document.hidden) markMiniRead(); });
    const css = document.createElement("style");
    css.textContent = `
#mx-heads{position:fixed;right:16px;bottom:calc(var(--tabbar,0px) + 128px + env(safe-area-inset-bottom,0px));z-index:9996;display:flex;flex-direction:column-reverse;gap:10px}
body.has-player #mx-heads{bottom:calc(var(--tabbar,0px) + 204px + env(safe-area-inset-bottom,0px))}
.mx-head{position:relative}.mx-head-b{background:none;border:0;padding:0;cursor:pointer;position:relative;display:block;animation:mxHead .35s cubic-bezier(.2,1.6,.4,1)}
.mx-head-b .mx-av{width:54px;height:54px;box-shadow:0 8px 22px rgba(0,0,0,.55);border:2px solid var(--gold,#e2b54e)}
.mx-head.on .mx-av{box-shadow:0 0 0 3px var(--gold-hi,#f0cf78),0 8px 22px rgba(0,0,0,.55)}
.mx-head-b>i{position:absolute;top:-4px;right:-4px;min-width:20px;height:20px;border-radius:999px;background:#e5484d;color:#fff;font:800 11px/20px system-ui,sans-serif;font-style:normal;padding:0 5px;border:2px solid #0b0a08;text-align:center}
.mx-head-x{position:absolute;left:-6px;top:-6px;width:20px;height:20px;border-radius:50%;border:0;background:#2a2418;color:#fff;font-size:13px;line-height:20px;cursor:pointer;opacity:0;transition:opacity .15s}
.mx-head:hover .mx-head-x,.mx-head:focus-within .mx-head-x{opacity:1}
@media (hover:none){.mx-head-x{opacity:.85}}
@keyframes mxHead{from{transform:scale(.2);opacity:0}to{transform:none;opacity:1}}
#mx-pop{position:fixed;right:16px;top:calc(env(safe-area-inset-top,0px) + 14px);z-index:9999;width:min(340px,calc(100vw - 32px));background:linear-gradient(180deg,#1f1a10,#13110c);border:1px solid var(--gold-lo,#8a6a2a);border-radius:18px;box-shadow:0 18px 44px rgba(0,0,0,.6);padding:10px;display:grid;gap:8px}
#mx-pop.in{animation:mxPop .4s cubic-bezier(.2,1.4,.4,1)}@keyframes mxPop{from{transform:translateY(-24px) scale(.94);opacity:0}to{transform:none;opacity:1}}
.mx-pop-main{display:flex;gap:10px;align-items:center;background:none;border:0;color:var(--text,#fff);text-align:left;cursor:pointer;font:inherit;padding:2px 22px 2px 2px}
.mx-pop-main span{display:grid;min-width:0}.mx-pop-main small{color:var(--muted,#aaa);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.mx-pop-x{position:absolute;right:8px;top:6px;background:none;border:0;color:var(--muted,#aaa);font-size:20px;cursor:pointer}
.mx-pop-reply,.mm-form{display:flex;gap:6px}.mx-pop-reply input,.mm-form input{flex:1;min-width:0;background:var(--ink,#0b0a08);border:1px solid var(--line,#333);border-radius:999px;padding:9px 13px;color:var(--text,#fff);font:inherit}
.mx-pop-reply button,.mm-form button{width:38px;height:38px;flex:none;border-radius:50%;border:0;background:var(--gold,#e2b54e);color:#0b0a08;font-size:16px;cursor:pointer}
#mx-mini{position:fixed;right:84px;bottom:calc(var(--tabbar,0px) + 16px + env(safe-area-inset-bottom,0px));z-index:9997;width:330px;height:min(440px,calc(100vh - 120px));background:linear-gradient(180deg,#17130c,#0f0d09);border:1px solid var(--gold-lo,#8a6a2a);border-radius:16px 16px 12px 12px;box-shadow:0 20px 50px rgba(0,0,0,.6);display:flex;flex-direction:column;overflow:hidden;animation:mxPop .3s ease-out}
#mx-mini[hidden]{display:none}
.mm-head{display:flex;align-items:center;gap:8px;padding:8px 10px;border-bottom:1px solid var(--line,#333);background:#1d1810}
.mm-head b{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.mm-head small{color:#31d158;font-size:11px}
.mm-head button{background:none;border:0;color:var(--gold-hi,#f0cf78);font-size:18px;cursor:pointer;padding:2px 6px}
.mm-msgs{flex:1;overflow:auto;padding:10px;display:flex;flex-direction:column;gap:2px}.mm-msgs .mx-col{max-width:80%}.mm-msgs .mx-bub{font-size:14px;padding:7px 11px}
.mm-msgs .mx-photo img{max-width:180px}.mm-form{padding:8px;border-top:1px solid var(--line,#333)}
body.mw-editing #mx-heads,body.mw-editing #mx-mini{display:none}`;
    document.head.appendChild(css);
  }
  async function markReadFrom(id) {
    await sb.from("dms").update({ read_at: new Date().toISOString() }).eq("recipient", uid).eq("sender", id).is("read_at", null);
    all.forEach((r) => { if (r.sender === id && r.recipient === uid && !r.read_at) r.read_at = new Date().toISOString(); });
    paintDot(); paintHeads();
  }
  /* ---------- view core (js/messages-view.js) ----------
   * render() and the #v-messages wiring live in the fragment, eval'd
   * inside this closure (the dj-booth pattern) on first need, so the
   * moved code shares this scope untouched. Until it lands,
   * renderGate() holds one pending render — and open() one pending
   * focus — and mxAttach() replays them; a failed fetch clears the
   * busy flag and the next need retries, while a fragment that
   * throws is not retried (a fresh page load is). The always-on
   * layer above (arrival pop, chat heads, mini chat, the unread
   * dot) never waits on any of it. */
  let mxView = null, mxViewBusy = false, mxViewFailed = false, mxPendRender = false, mxPendFocus = false;
  function renderGate() { if (mxView) { mxView.render(); return; } mxPendRender = true; if (!view.hidden) kickView(); }
  function mxAttach(render) { if (mxView || typeof render !== "function") return; mxView = { render }; if (mxPendRender) { mxPendRender = false; render(); } if (mxPendFocus) { mxPendFocus = false; setTimeout(() => { const i = document.getElementById("dm-in"); if (i) i.focus(); }, 50); } }
  function kickView() {
    if (mxView || mxViewBusy || mxViewFailed) return; mxViewBusy = true;
    let url = "";
    try { const sc = MX_SELF ? { src: MX_SELF } : [...document.scripts].find((s) => /\/js\/messages\.js(\?|$)/.test(s.src || "")); if (sc && sc.src) url = sc.src.replace(/messages\.js(\?|$)/, "messages-view.js$1"); } catch (_) {}
    if (!url) { mxViewBusy = false; return; }
    fetch(url).then((r) => (r.ok ? r.text() : "")).then((t) => { mxViewBusy = false; if (t) { try { eval(t); } catch (_) { mxViewFailed = true; } } }).catch(() => { mxViewBusy = false; });
  }

  async function init() {
    await MW.sessionReady;
    const s = MW.session(); uid = s && s.user ? s.user.id : null;
    buildCore(); if (!uid) { renderGate(); return; }
    fab(); wireHeads();
    await load(); paintHeads();
    // group registry: my groups live in docs (groups/<gid> = {name, members, owner})
    const d0 = DB();
    if (d0) d0.collection("groups").limit(500).onSnapshot((s) => { const nx = {}; s.docs.forEach((x) => { const v = x.data(); if (v && !v.deleted && Array.isArray(v.members) && v.members.includes(uid)) nx[x.id] = { name: String(v.name || "Group chat"), members: v.members.filter((i) => typeof i === "string"), owner: v.owner || "" }; }); groups = nx; if (!view.hidden) renderGate(); }, () => {});
    sb.channel("dms-live").on("postgres_changes", { event: "*", schema: "public", table: "dms" }, later).subscribe();
    started = true; setInterval(() => { if (!document.hidden && dmDirty) { dmDirty = false; load(); } }, 45000);
    // keep "active now" dots fresh
    setInterval(() => { if (!view.hidden && !document.getElementById("dm-in")?.matches(":focus")) { const l = view.querySelector(".dm-list"); if (l && !q) renderGate(); } }, 30000);
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init); else init();
})();
