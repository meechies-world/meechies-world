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
  try { heads = JSON.parse(sessionStorage.getItem("mx_heads") || "[]").filter((x) => typeof x === "string").slice(0, 4); } catch (_) {}

  const E = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const mem = (id) => (typeof members !== "undefined" && members[id]) || {};
  const handle = (id) => mem(id).handle || "Member";
  const ini = (s) => (String(s || "?").trim()[0] || "?").toUpperCase();
  const photo = (id) => { const p = mem(id).photo; return /^https:\/\//.test(p || "") || /^data:image\/(png|jpe?g|webp);base64,/.test(p || "") ? p : ""; };
  const onlineIds = () => { const s = new Set(); try { (typeof room !== "undefined" && room && room.peers ? room.peers() : []).forEach((p) => p.by && s.add(p.by)); } catch (_) {} return s; };
  const av = (id, cls = "") => { const p = photo(id), on = onlineIds().has(id); return `<span class="mx-av ${cls}">${p ? `<img src="${E(p)}" alt="">` : `<b>${E(ini(handle(id)))}</b>`}${on ? '<i class="on" title="Active now"></i>' : ""}</span>`; };
  const when = (iso) => { const ms = new Date(iso).getTime(), s = (Date.now() - ms) / 1000; if (s < 60) return "now"; if (s < 3600) return Math.floor(s / 60) + "m"; if (s < 86400) return Math.floor(s / 3600) + "h"; if (s < 604800) return Math.floor(s / 86400) + "d"; return new Date(ms).toLocaleDateString(); };
  const clock = (iso) => new Date(iso).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  const dayLabel = (iso) => { const d = new Date(iso), t = new Date(); const y = new Date(); y.setDate(t.getDate() - 1);
    if (d.toDateString() === t.toDateString()) return "Today"; if (d.toDateString() === y.toDateString()) return "Yesterday";
    return d.toLocaleDateString([], { weekday: "short", month: "short", day: "numeric", year: d.getFullYear() === t.getFullYear() ? undefined : "numeric" }); };
  const say = (t) => (typeof toast === "function" ? toast(t) : null);

  const STORE = "https:\\/\\/yjouaysczttqbytksejq\\.supabase\\.co\\/storage\\/v1\\/object\\/public\\/media\\/[A-Za-z0-9_\\-\\/]+";
  const VOICE_RE = new RegExp("^🎙️ Voice message ⟦(" + STORE + "\\.(?:webm|m4a|mp4|ogg))⟧$");
  const PHOTO_RE = new RegExp("^📷 Photo ⟦(" + STORE + "\\.(?:jpg|png|webp))⟧$");
  const REACT_RE = /^⟦react:(\d+):(❤️|😂|😮|😢|😡|👍|🔥)⟧$/;
  const REACTS = ["❤️", "😂", "😮", "😢", "😡", "👍"];
  const voiceUrl = (b) => (VOICE_RE.exec(b || "") || [])[1] || "";
  const photoUrl = (b) => (PHOTO_RE.exec(b || "") || [])[1] || "";
  const isReact = (b) => REACT_RE.test(b || "");
  const preview = (r) => { const b = r.body; if (voiceUrl(b)) return "🎙️ Voice message"; if (photoUrl(b)) return "📷 Photo"; const m = REACT_RE.exec(b || ""); if (m) return "Reacted " + m[2] + " to a message"; return b; };
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
    const m = new Map();
    for (const r of all) {
      const o = r.sender === uid ? r.recipient : r.sender;
      let c = m.get(o); if (!c) { c = { id: o, last: r, unread: 0 }; m.set(o, c); }
      if (r.recipient === uid && !r.read_at && !isReact(r.body)) c.unread++;
    }
    return [...m.values()].sort((a, b) => new Date(b.last.created_at) - new Date(a.last.created_at));
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
      if (mini === r.sender && !document.hidden) return; // its chat window is open
      pop(); if (window.MW_NOTIFY) MW_NOTIFY("New message from " + handle(r.sender), String(preview(r)).slice(0, 80));
      fresh.push(r);
    });
    all = data || []; paintDot(); autoPlayVoices(); if (!view.hidden) render();
    fresh.forEach(popIn); fresh.length = 0; paintHeads(); if (mini) paintMini();
  }
  function later() { clearTimeout(timer); timer = setTimeout(load, 200); }

  async function markRead() {
    if (!other || document.hidden) return;
    if (!all.some((r) => r.sender === other && r.recipient === uid && !r.read_at)) return;
    await sb.from("dms").update({ read_at: new Date().toISOString() }).eq("recipient", uid).eq("sender", other).is("read_at", null);
    all.forEach((r) => { if (r.sender === other && r.recipient === uid && !r.read_at) r.read_at = new Date().toISOString(); });
    paintDot();
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
    const v = voiceUrl(r.body), p = photoUrl(r.body);
    if (v) return `<div class="mx-bub voice"><span>🎙️ Walkie</span><audio src="${E(v)}" controls preload="none"></audio></div>`;
    if (p) return `<a class="mx-photo" href="${E(p)}" target="_blank" rel="noopener"><img src="${E(p)}" alt="Photo" loading="lazy"></a>`;
    const big = /^(\p{Extended_Pictographic}|️|‍|\s){1,8}$/u.test(r.body) && r.body.trim().length <= 12;
    return `<div class="mx-bub${big ? " big" : ""}">${linkify(r.body)}</div>`;
  }

  function render() {
    if (!uid) {
      view.querySelector(".dm-app").innerHTML = `<div class="empty" style="grid-column:1/-1">Join free to send private messages.<br><button class="btn" type="button" data-auth="signup" style="margin-top:12px">Join free</button></div>`;
      return;
    }
    const app = view.querySelector(".dm-app");
    app.classList.toggle("has-thread", !!other);
    const list = view.querySelector(".dm-list"), thread = view.querySelector(".dm-thread");
    const ms = typeof members !== "undefined" ? members : {};
    const online = onlineIds();
    // "active now" strip, like Messenger
    const act = Object.keys(ms).filter((id) => id !== uid && online.has(id)).slice(0, 20);
    const strip = view.querySelector(".mx-active");
    if (strip) strip.innerHTML = act.length ? act.map((id) => `<button type="button" data-open="${E(id)}" title="${E(handle(id))}">${av(id)}<small>${E(handle(id).split(" ")[0])}</small></button>`).join("") : "";
    let items = "";
    if (q.trim()) {
      const t = q.trim().toLowerCase();
      const found = Object.keys(ms).filter((id) => id !== uid && String(ms[id].handle || "").toLowerCase().includes(t)).slice(0, 15);
      items = found.length ? found.map((id) => `<button type="button" class="dm-row" data-open="${E(id)}">${av(id)}<span class="dm-t"><b>${E(ms[id].handle)}</b><small>${E(ms[id].bio || "Member")}</small></span></button>`).join("") : `<p class="muted" style="margin:10px 4px">No member found with that name.</p>`;
    } else {
      const cs = convos();
      items = cs.length ? cs.map((c) => `<button type="button" class="dm-row ${c.id === other ? "on" : ""} ${c.unread ? "unread" : ""}" data-open="${E(c.id)}">${av(c.id)}<span class="dm-t"><b>${E(handle(c.id))}</b><small>${c.last.sender === uid ? "You: " : ""}${E(String(preview(c.last)).slice(0, 60))} · ${when(c.last.created_at)}</small></span>${c.unread ? `<span class="dm-m"><i>${c.unread}</i></span>` : c.last.sender === uid && c.last.read_at ? `<span class="dm-m">${av(c.id, "tiny")}</span>` : ""}</button>`).join("") : `<p class="muted" style="margin:10px 4px">No messages yet. Search for a member above, or tap Message on a member card.</p>`;
    }
    list.innerHTML = items;
    if (!other) { thread.innerHTML = `<div class="dm-none"><svg class="sqc-ico" aria-hidden="true" style="width:46px;height:46px"><use href="#sqc"/></svg><b>Your messages</b><span class="muted">Pick a chat, or search for a member to start one. Only you and the other person can read your messages. They aren't end-to-end encrypted, so never send passwords or card numbers.</span></div>`; return; }
    typingChannel();
    const prevIn = document.getElementById("dm-in"), keep = prevIn && thread.dataset.with === other, draft = keep ? prevIn.value : "", hadFocus = keep && document.activeElement === prevIn;
    const box0 = document.getElementById("dm-msgs"), atBottom = !keep || !box0 || box0.scrollHeight - box0.scrollTop - box0.clientHeight < 80, oldTop = box0 ? box0.scrollTop : 0;
    thread.dataset.with = other;
    const openPick = keep ? document.querySelector(".mx-pick")?.dataset.for : null; // keep an open reaction picker through a refresh
    const pair = all.filter((r) => (r.sender === uid && r.recipient === other) || (r.sender === other && r.recipient === uid)).slice().reverse();
    // reactions: the latest reaction from each person on each message
    const reacts = {}; pair.filter((r) => isReact(r.body)).forEach((r) => { const m = REACT_RE.exec(r.body); (reacts[m[1]] = reacts[m[1]] || {})[r.sender] = m[2]; });
    const msgs = pair.filter((r) => !isReact(r.body));
    const lastMineSeen = [...msgs].reverse().find((r) => r.sender === uid && r.read_at);
    let html = "", prev = null;
    msgs.forEach((r, i) => {
      const nx = msgs[i + 1], mine = r.sender === uid;
      const gap = !prev || new Date(r.created_at) - new Date(prev.created_at) > 3600e3;
      if (gap) html += `<div class="mx-day">${E(dayLabel(r.created_at))} · ${E(clock(r.created_at))}</div>`;
      const endOfGroup = !nx || nx.sender !== r.sender || new Date(nx.created_at) - new Date(r.created_at) > 3600e3;
      const rx = reacts[r.id] ? Object.values(reacts[r.id]) : [];
      html += `<div class="mx-msg ${mine ? "me" : ""} ${endOfGroup ? "end" : ""}" data-mid="${r.id}">
        ${!mine ? (endOfGroup ? av(r.sender, "sm") : '<span class="mx-av sm ghost"></span>') : ""}
        <div class="mx-col">${bubble(r)}${rx.length ? `<span class="mx-rx">${E([...new Set(rx)].join(""))}${rx.length > 1 ? " " + rx.length : ""}</span>` : ""}</div>
        <button type="button" class="mx-react-btn" data-rpick="${r.id}" aria-label="React">☺</button>
        <small class="mx-time">${E(clock(r.created_at))}</small></div>`;
      if (lastMineSeen && r.id === lastMineSeen.id) html += `<div class="mx-seen">${av(other, "tiny")}<span>Seen</span></div>`;
      prev = r;
    });
    const st = Date.now() < theyTypeUntil ? "typing…" : online.has(other) ? "Active now" : "";
    thread.innerHTML = `<div class="dm-head"><button type="button" class="act dm-back" data-back aria-label="Back to chats">←</button>${av(other, "md")}<div class="mx-who"><b>${E(handle(other))}</b><small id="mx-status">${st}</small></div></div>
<div class="dm-msgs" id="dm-msgs">${msgs.length ? html : `<div class="mx-hello">${av(other, "lg")}<b>${E(handle(other))}</b><span class="muted">Say hello 👋</span></div>`}
<div class="mx-msg end" id="mx-typing"${Date.now() < theyTypeUntil ? "" : " hidden"}>${av(other, "sm")}<div class="mx-col"><div class="mx-bub dots"><i></i><i></i><i></i></div></div></div></div>
<div class="mx-emoji" id="mx-emoji" hidden>${["😀", "😂", "😍", "🥰", "😎", "🔥", "💯", "🙏", "👏", "💪", "🎶", "👑", "💰", "😢", "😡", "❤️"].map((e) => `<button type="button" data-emo="${e}">${e}</button>`).join("")}</div>
<form class="dm-form" id="dm-form">
  <label class="mx-tool" title="Send a photo" aria-label="Send a photo">📷<input type="file" accept="image/*" id="mx-photo" hidden></label>
  <button type="button" class="dm-walkie" id="dm-walkie" aria-label="Hold to talk (walkie-talkie)">📻</button>
  <div class="mx-in"><input type="text" id="dm-in" aria-label="Message" maxlength="2000" placeholder="Aa" autocomplete="off"><button type="button" class="mx-emo-btn" id="mx-emo" aria-label="Emoji">😊</button></div>
  <button class="mx-send" type="submit" id="mx-send" aria-label="Send">👍</button></form>`;
    const box = document.getElementById("dm-msgs"); if (box) box.scrollTop = atBottom ? box.scrollHeight : oldTop;
    const ni = document.getElementById("dm-in"); if (ni && draft) ni.value = draft; if (ni && hadFocus) ni.focus();
    if (openPick) { const col = view.querySelector(`.mx-msg[data-mid="${CSS.escape(String(openPick))}"] .mx-col`); if (col) { const pk = document.createElement("div"); pk.className = "mx-pick"; pk.dataset.for = openPick; pk.innerHTML = REACTS.map((r) => `<button type="button" data-rx="${r}">${r}</button>`).join(""); col.appendChild(pk); } }
    paintSend(); markRead();
  }
  function paintSend() { const i = document.getElementById("dm-in"), s = document.getElementById("mx-send"); if (i && s) { const has = !!i.value.trim(); s.textContent = has ? "➤" : "👍"; s.classList.toggle("go", has); s.setAttribute("aria-label", has ? "Send" : "Send a thumbs up"); } }

  function open(id) { other = id; q = ""; const s = view.querySelector(".dm-search"); if (s) s.value = ""; if (typeof go === "function") go("messages"); render(); setTimeout(() => { const i = document.getElementById("dm-in"); if (i) i.focus(); }, 50); }
  async function send(body, to = other) {
    if (!body || !to) return false;
    const { error } = await sb.from("dms").insert({ recipient: to, body });
    if (error) { say("Could not send: " + error.message); return false; }
    if (window.MW_pushNotify && !/^⟦react:/.test(body)) MW_pushNotify(to);
    load(); return true;
  }

  function build() {
    const css = document.createElement("style");
    css.textContent = `
.dm-app{display:grid;grid-template-columns:minmax(0,340px) minmax(0,1fr);gap:14px;min-height:560px}
.dm-side,.dm-thread{background:linear-gradient(180deg,#17130c,#0f0d09);border:1px solid var(--line);border-radius:18px;display:flex;flex-direction:column;min-height:0}
.dm-side{padding:12px;gap:10px;max-height:680px}
.dm-search{width:100%;background:var(--ink);border:1px solid var(--line);border-radius:999px;padding:10px 14px;color:var(--text);font:inherit}
.mx-active{display:flex;gap:10px;overflow-x:auto;scrollbar-width:none;padding:2px 2px 4px}.mx-active:empty{display:none}
.mx-active button{display:grid;justify-items:center;gap:3px;background:none;border:0;color:var(--text);cursor:pointer;font:inherit;flex:none;width:58px}
.mx-active small{font-size:11px;max-width:58px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--muted)}
.mx-active .mx-av{width:48px;height:48px}
.dm-list{display:grid;gap:2px;overflow:auto;align-content:start}
.dm-row{display:flex;gap:11px;align-items:center;text-align:left;background:none;border:0;border-radius:12px;padding:8px;color:var(--text);cursor:pointer;font:inherit;width:100%}
.dm-row:hover,.dm-row.on{background:var(--panel-2)}
.dm-row.unread b,.dm-row.unread small{color:var(--text);font-weight:800}
.dm-t{display:grid;min-width:0;flex:1}.dm-t b,.dm-t small{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.dm-t small{color:var(--muted)}
.dm-m{display:grid;justify-items:end;gap:4px;font-size:12px;color:var(--muted)}
.dm-m i{font-style:normal;background:var(--gold);color:var(--ink);border-radius:999px;padding:1px 7px;font-weight:800}
.mx-av{position:relative;flex:none;width:46px;height:46px;border-radius:50%;display:grid;place-items:center;background:linear-gradient(135deg,#3a2c14,#1d1810);border:1px solid var(--gold-lo)}
.mx-av img{width:100%;height:100%;border-radius:50%;object-fit:cover}.mx-av b{color:var(--gold-hi);font:800 17px var(--body)}
.mx-av .on{position:absolute;right:-1px;bottom:-1px;width:13px;height:13px;border-radius:50%;background:#31d158;border:2.5px solid #12100c}
.mx-av.md{width:40px;height:40px}.mx-av.sm{width:28px;height:28px}.mx-av.sm b{font-size:12px}.mx-av.sm .on{width:9px;height:9px;border-width:2px}
.mx-av.tiny{width:16px;height:16px;border:0}.mx-av.tiny b{font-size:9px}.mx-av.tiny .on{display:none}.mx-av.lg{width:84px;height:84px}.mx-av.lg b{font-size:32px}
.mx-av.ghost{visibility:hidden}
.dm-thread{min-height:560px;max-height:680px}
.dm-head{display:flex;align-items:center;gap:10px;padding:10px 14px;border-bottom:1px solid var(--line)}
.mx-who{display:grid}.mx-who small{color:#31d158;font-size:12px;min-height:1em}
.dm-back{display:none;font-size:20px}
.dm-msgs{flex:1;overflow:auto;padding:14px 12px;display:flex;flex-direction:column;gap:2px}
.mx-day{align-self:center;color:var(--muted);font-size:12px;margin:12px 0 6px}
.mx-msg{display:flex;align-items:flex-end;gap:7px;max-width:100%;position:relative}
.mx-msg.end{margin-bottom:8px}.mx-msg.me{flex-direction:row-reverse}
.mx-col{display:grid;max-width:min(72%,520px);position:relative}
.mx-bub{background:#2a2418;color:var(--text);padding:8px 13px;border-radius:18px;overflow-wrap:anywhere;line-height:1.4;font-size:15px;white-space:pre-wrap}
.mx-msg.me .mx-bub{background:linear-gradient(135deg,#e2b54e,#c99a3a);color:#0b0a08}
.mx-msg.me .mx-bub a{color:#0b0a08}.mx-bub a{color:var(--gold-hi)}
.mx-bub.big{background:none!important;font-size:38px;padding:0 2px;line-height:1.15}
.mx-bub.voice{display:grid;gap:4px}.mx-bub.voice audio{max-width:240px}
.mx-photo img{display:block;max-width:240px;max-height:320px;border-radius:16px;border:1px solid var(--line)}
.mx-rx{position:absolute;bottom:-10px;right:6px;background:#1d1810;border:1px solid var(--line);border-radius:999px;font-size:13px;padding:0 5px;line-height:18px}
.mx-msg.me .mx-rx{right:auto;left:6px}
.mx-msg:has(.mx-rx){margin-bottom:12px}
.mx-react-btn{opacity:0;background:none;border:0;color:var(--muted);font-size:18px;cursor:pointer;padding:0 2px;align-self:center}
.mx-msg:hover .mx-react-btn,.mx-msg:focus-within .mx-react-btn{opacity:1}
.mx-time{display:none;color:var(--muted);font-size:11px;align-self:center}.mx-msg:hover .mx-time{display:block}
.mx-seen{display:flex;justify-content:flex-end;align-items:center;gap:4px;color:var(--muted);font-size:11px;margin:-4px 0 6px}
.mx-pick{position:absolute;z-index:5;bottom:100%;display:flex;gap:4px;background:#1d1810;border:1px solid var(--gold-lo);border-radius:999px;padding:4px 6px;box-shadow:0 8px 24px rgba(0,0,0,.5)}
.mx-msg.me .mx-pick{right:0}.mx-pick button{background:none;border:0;font-size:22px;cursor:pointer;padding:2px;transition:transform .1s}.mx-pick button:hover{transform:scale(1.25)}
.mx-bub.dots{display:flex;gap:4px;padding:12px 14px}.mx-bub.dots i{width:7px;height:7px;border-radius:50%;background:var(--muted);animation:mxB 1.2s infinite}.mx-bub.dots i:nth-child(2){animation-delay:.15s}.mx-bub.dots i:nth-child(3){animation-delay:.3s}
@keyframes mxB{0%,60%,100%{opacity:.3;transform:none}30%{opacity:1;transform:translateY(-3px)}}
.mx-hello{margin:auto;display:grid;justify-items:center;gap:8px;text-align:center}
.mx-emoji{display:flex;flex-wrap:wrap;gap:4px;padding:8px 12px;border-top:1px solid var(--line)}.mx-emoji button{background:none;border:0;font-size:24px;cursor:pointer;padding:2px}
.dm-form{display:flex;gap:8px;padding:10px 12px;border-top:1px solid var(--line);align-items:center}
.mx-tool{display:grid;place-items:center;width:40px;height:40px;flex:none;border-radius:50%;cursor:pointer;font-size:20px}
.mx-tool:hover{background:var(--panel-2)}
.dm-walkie{width:40px;height:40px;flex:none;border-radius:50%;border:2px solid var(--gold);background:#1d1810;color:#fff;font-size:18px;cursor:pointer;touch-action:none;user-select:none;-webkit-user-select:none}
.dm-walkie.on{background:#e5484d;border-color:#e5484d;box-shadow:0 0 0 6px rgba(229,72,77,.3)}
.mx-in{flex:1;min-width:0;display:flex;align-items:center;background:var(--ink);border:1px solid var(--line);border-radius:999px;padding-right:4px}
.mx-in input{flex:1;min-width:0;background:none;border:0;padding:11px 14px;color:var(--text);font:inherit;outline:none}
.mx-emo-btn{background:none;border:0;font-size:20px;cursor:pointer;padding:4px}
.mx-send{width:42px;height:42px;flex:none;border-radius:50%;border:0;background:none;font-size:24px;cursor:pointer;color:var(--gold-hi)}
.mx-send.go{background:var(--gold);color:#0b0a08;font-size:18px}
.dm-none{margin:auto;display:grid;gap:10px;justify-items:center;text-align:center;padding:24px;max-width:30em}
.dm-dot{display:inline-block;margin-left:6px;background:#e5484d;color:#fff;border-radius:999px;font-size:11px;font-weight:800;padding:0 6px;line-height:16px}
.dm-btn{margin-left:auto}
#mx-fab{position:fixed;right:16px;bottom:calc(var(--tabbar,0px) + 64px + env(safe-area-inset-bottom,0px));z-index:9996;width:54px;height:54px;border-radius:50%;border:1px solid var(--gold-hi,#f0cf78);background:linear-gradient(135deg,#e2b54e,#a87a22);color:#0b0a08;font-size:24px;cursor:pointer;box-shadow:0 10px 28px rgba(0,0,0,.55);display:grid;place-items:center}
body.has-player #mx-fab{bottom:calc(var(--tabbar,0px) + 140px + env(safe-area-inset-bottom,0px))}
#mx-fab svg{width:26px;height:26px}
#mx-fab i{position:absolute;top:-4px;right:-4px;min-width:20px;height:20px;border-radius:999px;background:#e5484d;color:#fff;font:800 11px/20px system-ui,sans-serif;font-style:normal;padding:0 5px;border:2px solid #0b0a08}

body.mw-editing #mx-fab{display:none}
@media (max-width:760px){.dm-app{grid-template-columns:1fr}.dm-app.has-thread .dm-side{display:none}.dm-app:not(.has-thread) .dm-thread{display:none}.dm-back{display:inline-block}.dm-thread{min-height:calc(100vh - 220px)}.mx-react-btn{opacity:.6}}`;
    document.head.appendChild(css);
    // the "active now" strip goes above the chat list
    const side = view.querySelector(".dm-side"); if (side && !side.querySelector(".mx-active")) { const a = document.createElement("div"); a.className = "mx-active"; side.querySelector(".dm-search").after(a); }
    view.querySelector(".dm-search").addEventListener("input", (e) => { q = e.target.value; render(); });
    view.addEventListener("click", async (e) => {
      const o = e.target.closest("[data-open]"); if (o) { open(o.dataset.open); return; }
      if (e.target.closest("[data-back]")) { other = null; render(); return; }
      const em = e.target.closest("[data-emo]"); if (em) { const i = document.getElementById("dm-in"); i.value += em.dataset.emo; i.focus(); paintSend(); sendTyping(); return; }
      if (e.target.closest("#mx-emo")) { const p = document.getElementById("mx-emoji"); p.hidden = !p.hidden; return; }
      const rp = e.target.closest("[data-rpick]"); if (rp) { showPick(rp.dataset.rpick); return; }
      const rx = e.target.closest("[data-rx]"); if (rx) { const id = rx.closest(".mx-pick").dataset.for; document.querySelector(".mx-pick")?.remove(); await send("⟦react:" + id + ":" + rx.dataset.rx + "⟧"); return; }
      if (!e.target.closest(".mx-pick")) document.querySelector(".mx-pick")?.remove();
    });
    // long-press (phone) or double-click a message to react
    let lp = 0; view.addEventListener("pointerdown", (e) => { const m = e.target.closest(".mx-msg[data-mid]"); if (!m || e.target.closest("audio,a,button")) return; clearTimeout(lp); lp = setTimeout(() => showPick(m.dataset.mid), 450); });
    ["pointerup", "pointerleave", "pointercancel"].forEach((ev) => view.addEventListener(ev, () => clearTimeout(lp)));
    view.addEventListener("dblclick", (e) => { const m = e.target.closest(".mx-msg[data-mid]"); if (m) showPick(m.dataset.mid); });
    function showPick(id) {
      document.querySelector(".mx-pick")?.remove();
      const m = view.querySelector(`.mx-msg[data-mid="${CSS.escape(String(id))}"] .mx-col`); if (!m) return;
      const p = document.createElement("div"); p.className = "mx-pick"; p.dataset.for = id; p.innerHTML = REACTS.map((r) => `<button type="button" data-rx="${r}">${r}</button>`).join(""); m.appendChild(p);
    }
    view.addEventListener("input", (e) => { if (e.target.id === "dm-in") { paintSend(); if (e.target.value.trim()) sendTyping(); } });
    view.addEventListener("submit", async (e) => {
      if (e.target.id !== "dm-form") return; e.preventDefault();
      const i = document.getElementById("dm-in"), body = i.value.trim() || "👍"; if (!other) return;
      i.value = ""; paintSend(); document.getElementById("mx-emoji").hidden = true;
      const ok = await send(body); if (!ok && body !== "👍") i.value = body; i.focus();
    });
    // photos
    view.addEventListener("change", async (e) => {
      if (e.target.id !== "mx-photo") return; const f = e.target.files[0]; e.target.value = ""; if (!f || !other) return;
      say("Sending photo...");
      try {
        let blob = f;
        if (typeof compress === "function") { const d = await compress(f, 1400); blob = await (await fetch(d)).blob(); }
        const type = /png|webp|jpeg/.test(blob.type) ? blob.type : "image/jpeg";
        const up = await MW.uploadMedia(blob, { type, ext: type === "image/png" ? "png" : type === "image/webp" ? "webp" : "jpg" });
        if (await send("📷 Photo ⟦" + up.url + "⟧")) say("📷 Sent");
      } catch (err) { say("Couldn't send the photo: " + (err.message || err)); }
    });
    /* walkie-talkie: hold the 📻 button, talk, let go */
    let rec = null, chunks = [], stream = null, t0 = 0, held = false;
    const wBtn = () => document.getElementById("dm-walkie");
    view.addEventListener("pointerdown", async (e) => {
      if (!e.target.closest("#dm-walkie") || rec || !other) return; e.preventDefault();
      held = true;
      try { stream = stream || await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } }); }
      catch (_) { held = false; say("Allow the microphone to use the walkie-talkie."); return; }
      // let go while the microphone permission was being asked: don't start recording (it would send on the next tap anywhere)
      if (!held || rec) { if (!rec) { try { stream.getTracks().forEach((t) => t.stop()); } catch (_) {} stream = null; } if (!held) say("Microphone ready. Hold the 📻 button while you talk."); return; }
      const type = ["audio/webm;codecs=opus", "audio/mp4", "audio/webm"].find((x) => window.MediaRecorder && MediaRecorder.isTypeSupported(x)) || "";
      rec = new MediaRecorder(stream, type ? { mimeType: type } : undefined); chunks = []; rec.ondataavailable = (ev) => ev.data.size && chunks.push(ev.data);
      rec.start(); t0 = Date.now(); wBtn()?.classList.add("on"); const i = document.getElementById("dm-in"); if (i) i.placeholder = "Talking... let go to send";
    });
    const release = async () => {
      held = false;
      if (!rec) return; const r = rec; rec = null; wBtn()?.classList.remove("on");
      const i = document.getElementById("dm-in"); if (i) i.placeholder = "Aa";
      await new Promise((res) => { r.onstop = res; try { r.stop(); } catch (_) { res(); } });
      try { stream && stream.getTracks().forEach((t) => t.stop()); } catch (_) {} stream = null;
      if (Date.now() - t0 < 500) { say("Hold the 📻 button while you talk."); return; }
      const mime = (r.mimeType || "audio/webm").split(";")[0], ext = /mp4/.test(mime) ? "m4a" : "webm";
      try { const up = await MW.uploadMedia(new Blob(chunks, { type: mime }), { type: mime, ext }); if (await send("🎙️ Voice message ⟦" + up.url + "⟧")) say("📻 Sent"); }
      catch (err) { say("Couldn't send: " + (err.message || err)); }
    };
    ["pointerup", "pointercancel"].forEach((ev) => document.addEventListener(ev, release));
    view.addEventListener("contextmenu", (e) => { if (e.target.closest("#dm-walkie, .mx-msg")) e.preventDefault(); });

    /* "Message" buttons anywhere on the site */
    document.addEventListener("click", (e) => {
      const b = e.target.closest("[data-dm]"); if (!b) return; e.preventDefault();
      if (!uid) { if (typeof openAuth === "function") openAuth("signup"); return; }
      if (b.dataset.dm === uid) { say("That's you."); return; }
      open(b.dataset.dm);
    });
    new MutationObserver(() => { if (!view.hidden) render(); paintFab(); }).observe(view, { attributes: true, attributeFilter: ["hidden"] });
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
    let card = document.getElementById("mx-pop");
    if (!card) { card = document.createElement("div"); card.id = "mx-pop"; card.setAttribute("role", "status"); document.body.appendChild(card); }
    card.dataset.from = id;
    card.innerHTML = `<button type="button" class="mx-pop-x" data-popx aria-label="Dismiss">×</button>
<button type="button" class="mx-pop-main" data-head="${E(id)}">${av(id, "md")}<span><b>${E(handle(id))}</b><small>${E(String(preview(r)).slice(0, 90))}</small></span></button>
<form class="mx-pop-reply" data-popreply="${E(id)}"><input type="text" maxlength="2000" placeholder="Reply to ${E(handle(id).split(" ")[0])}…" aria-label="Quick reply" autocomplete="off"><button type="submit" aria-label="Send">➤</button></form>`;
    card.hidden = false; card.classList.remove("in"); void card.offsetWidth; card.classList.add("in");
    clearTimeout(card._t); const hide = () => { if (!card.matches(":hover,:focus-within")) card.hidden = true; else card._t = setTimeout(hide, 3000); };
    card._t = setTimeout(hide, 8000);
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
    const msgs = all.filter((r) => ((r.sender === uid && r.recipient === mini) || (r.sender === mini && r.recipient === uid)) && !isReact(r.body)).slice(0, 40).reverse();
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
      if (e.target.closest("[data-popx]")) { document.getElementById("mx-pop").hidden = true; return; }
      if (e.target.closest("[data-mmclose]")) { closeMini(); return; }
      if (e.target.closest("[data-mmfull]")) { const id = mini; closeMini(); open(id); return; }
    });
    document.addEventListener("submit", async (e) => {
      const f = e.target.closest("[data-popreply],[data-mmform]"); if (!f) return; e.preventDefault();
      const to = f.dataset.popreply || mini, i = f.querySelector("input"), body = i.value.trim(); if (!body || !to) return;
      i.value = ""; const ok = await send(body, to);
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

  async function init() {
    await MW.sessionReady;
    const s = MW.session(); uid = s && s.user ? s.user.id : null;
    build(); if (!uid) { render(); return; }
    fab(); wireHeads();
    await load(); paintHeads();
    sb.channel("dms-live").on("postgres_changes", { event: "*", schema: "public", table: "dms" }, later).subscribe();
    started = true; setInterval(() => { if (!document.hidden) load(); }, 45000);
    // keep "active now" dots fresh
    setInterval(() => { if (!view.hidden && !document.getElementById("dm-in")?.matches(":focus")) { const l = view.querySelector(".dm-list"); if (l && !q) render(); } }, 30000);
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init); else init();
})();
