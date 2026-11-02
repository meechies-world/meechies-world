/*
 * Messages VIEW CORE — a closure fragment of js/messages.js, NOT a
 * standalone script. messages.js fetches this file and evals it
 * inside its own IIFE (the dj-booth pattern), so everything below
 * shares that scope: state, helpers, the send path, all of it.
 * Never load this file with a <script> tag or lazyKick — at window
 * scope it cannot work. It registers exactly one thing back to the
 * core: render(), via mxAttach().
 */
  const pickHTML = (id) => REACTS.map((r) => `<button type="button" data-rx="${r}">${r}</button>`).join("") + `<span class="mx-pick-acts"><button type="button" data-rp="${id}">↩ Reply</button><button type="button" data-fw="${id}">↪ Forward</button><button type="button" data-cp="${id}">📋 Copy</button></span>`;
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
    view.querySelectorAll(".mx-tabs [data-tab]").forEach((b) => b.classList.toggle("on", b.dataset.tab === tab));
    const reqs = (window.MW_FRIENDS && MW_FRIENDS.requests ? MW_FRIENDS.requests() : []).filter((id) => !inList("hideReq", id));
    const tn = view.querySelector(".mx-tab-n"); if (tn) { tn.hidden = !reqs.length; tn.textContent = reqs.length; }
    if (strip) strip.style.display = tab === "chats" && !q.trim() ? "" : "none";
    let items = "";
    if (q.trim()) {
      const t = q.trim().toLowerCase();
      const found = Object.keys(ms).filter((id) => id !== uid && String(ms[id].handle || "").toLowerCase().includes(t)).slice(0, 15);
      items = found.length ? found.map((id) => `<button type="button" class="dm-row" data-open="${E(id)}">${av(id)}<span class="dm-t"><b>${E(ms[id].handle)}</b><small>${E(ms[id].bio || "Member")}</small></span></button>`).join("") : `<p class="muted" style="margin:10px 4px">No member found with that name.</p>`;
    } else if (tab === "friends") {
      const F = window.MW_FRIENDS;
      const fr = F && F.list ? F.list() : [];
      items = fr.length ? fr.map((id) => `<button type="button" class="dm-row ${id === other ? "on" : ""}" data-open="${E(id)}">${av(id)}<span class="dm-t"><b>${E(handle(id))}</b><small>${online.has(id) ? "Active now" : E((ms[id] && ms[id].bio) || "Friend")}</small></span></button>`).join("") : `<p class="muted" style="margin:10px 4px">No friends yet. Search above to message any member, or open the Friends page to add people.</p>`;
    } else if (tab === "requests") {
      items = reqs.length ? reqs.map((id) => `<div class="dm-row fr-row">${av(id)}<span class="dm-t"><b>${E(handle(id))}</b><small>Wants to be friends</small></span><span class="fr-acts"><button type="button" class="btn sm" data-facc="${E(id)}">Accept</button><button type="button" class="btn ghost sm" data-fign="${E(id)}">Ignore</button></span></div>`).join("") : `<p class="muted" style="margin:10px 4px">No friend requests right now.</p>`;
    } else {
      let cs = convos().filter((c) => showArch ? inList("arch", c.id) : !inList("arch", c.id));
      cs.sort((a, b) => (inList("pin", b.id) ? 1 : 0) - (inList("pin", a.id) ? 1 : 0) || new Date(b.last.created_at) - new Date(a.last.created_at));
      const rowFor = (c) => c.group
        ? `<button type="button" class="dm-row ${c.id === other ? "on" : ""} ${c.unread ? "unread" : ""}" data-open="${E(c.id)}">${gav(c.gid)}<span class="dm-t"><b>${E(gname(c.gid))}</b><small>${c.last.sender === uid ? "You: " : E(handle(c.last.sender)) + ": "}${E(String(preview(c.last)).slice(0, 48))} · ${when(c.last.created_at)}</small></span><span class="dm-x">${inList("pin", c.id) ? "📌" : ""}<span class="dm-menu-b" data-menu="${E(c.id)}" role="button" aria-label="Chat options">⋯</span></span>${c.unread ? `<span class="dm-m"><i>${c.unread}</i></span>` : ""}</button>`
        : `<button type="button" class="dm-row ${c.id === other ? "on" : ""} ${c.unread ? "unread" : ""}" data-open="${E(c.id)}">${av(c.id)}<span class="dm-t"><b>${E(handle(c.id))}</b><small>${c.last.sender === uid ? "You: " : ""}${E(String(preview(c.last)).slice(0, 60))} · ${when(c.last.created_at)}</small></span><span class="dm-x">${inList("pin", c.id) ? "📌" : ""}${inList("mute", c.id) ? "🔕" : ""}<span class="dm-menu-b" data-menu="${E(c.id)}" role="button" aria-label="Chat options">⋯</span></span>${c.unread ? `<span class="dm-m"><i>${c.unread}</i></span>` : c.last.sender === uid && c.last.read_at ? `<span class="dm-m">${av(c.id, "tiny")}</span>` : ""}</button>`;
      items = `<button type="button" class="dm-row dm-newgroup" data-newgroup>👥 Start a group chat</button>` + (cs.length ? cs.map(rowFor).join("") : `<p class="muted" style="margin:10px 4px">${showArch ? "No archived chats." : "No messages yet. Search for a member above, or tap Message on a member card."}</p>`);
      if (showArch || prefs.arch.length) items += `<button type="button" class="dm-row dm-arch-toggle" data-archtoggle>${showArch ? "← Back to chats" : "🗄 Archived (" + prefs.arch.length + ")"}</button>`;
    }
    list.innerHTML = items;
    if (!other) { thread.innerHTML = `<div class="dm-none"><svg class="sqc-ico" aria-hidden="true" style="width:46px;height:46px"><use href="#sqc"/></svg><b>Your messages</b><span class="muted">Pick a chat, or search for a member to start one. Only you and the other person can read your messages. They aren't end-to-end encrypted, so never send passwords or card numbers.</span></div>`; return; }
    const gid = curGid();
    if (!gid) typingChannel();
    const prevIn = document.getElementById("dm-in"), keep = prevIn && thread.dataset.with === other, draft = keep ? prevIn.value : "", hadFocus = keep && document.activeElement === prevIn;
    const box0 = document.getElementById("dm-msgs"), atBottom = !keep || !box0 || box0.scrollHeight - box0.scrollTop - box0.clientHeight < 80, oldTop = box0 ? box0.scrollTop : 0;
    thread.dataset.with = other;
    const openPick = keep ? document.querySelector(".mx-pick")?.dataset.for : null; // keep an open reaction picker through a refresh
    const pair = gid ? all.filter((r) => groupOfRow(r) === gid).slice().reverse()
      : all.filter((r) => !groupOfRow(r) && ((r.sender === uid && r.recipient === other) || (r.sender === other && r.recipient === uid))).slice().reverse();
    // reactions: the latest reaction from each person on each message (group messages key on their shared id)
    const reacts = {}; pair.filter((r) => isReact(r.body)).forEach((r) => { const m = reactOf(r.body); if (m) (reacts[m.target] = reacts[m.target] || {})[r.sender] = m.emoji; });
    const msgs = pair.filter((r) => !isReact(r.body));
    const lastMineSeen = [...msgs].reverse().find((r) => r.sender === uid && r.read_at);
    let html = "", prev = null;
    msgs.forEach((r, i) => {
      const nx = msgs[i + 1], mine = r.sender === uid, mid = gid ? (muidOf(r) || String(r.id)) : String(r.id);
      const gap = !prev || new Date(r.created_at) - new Date(prev.created_at) > 3600e3;
      if (gap) html += `<div class="mx-day">${E(dayLabel(r.created_at))} · ${E(clock(r.created_at))}</div>`;
      const endOfGroup = !nx || nx.sender !== r.sender || new Date(nx.created_at) - new Date(r.created_at) > 3600e3;
      const rx = reacts[mid] ? Object.values(reacts[mid]) : [];
      html += `<div class="mx-msg ${mine ? "me" : ""} ${endOfGroup ? "end" : ""}" data-mid="${E(mid)}">
        ${!mine ? (endOfGroup ? av(r.sender, "sm") : '<span class="mx-av sm ghost"></span>') : ""}
        <div class="mx-col">${gid && !mine ? `<div class="mx-gname">${E(handle(r.sender))}</div>` : ""}${bubble(r)}${rx.length ? `<span class="mx-rx">${E([...new Set(rx)].join(""))}${rx.length > 1 ? " " + rx.length : ""}</span>` : ""}</div>
        <button type="button" class="mx-react-btn" data-rpick="${E(mid)}" aria-label="React">☺</button>
        <small class="mx-time">${E(clock(r.created_at))}${E(vanishLeft(r))}</small></div>`;
      if (!gid && lastMineSeen && r.id === lastMineSeen.id) html += `<div class="mx-seen">${av(other, "tiny")}<span>Seen</span></div>`;
      prev = r;
    });
    const qrow2 = replyTo ? msgs.find((x) => String(x.id) === String(replyTo)) : null;
    if (replyTo && !qrow2) replyTo = null;
    const st = Date.now() < theyTypeUntil ? "typing…" : online.has(other) ? "Active now" : "";
    const vBtn = `<button type="button" class="act mx-vanish" data-vanish title="Disappearing messages: ${vanishLabel(other) ? "ON — new messages vanish after " + vanishLabel(other) : "off — tap to turn on"}" aria-label="Disappearing messages">⏱${vanishLabel(other) ? `<i>${vanishLabel(other)}</i>` : ""}</button>`;
    const headHtml = gid
      ? `<div class="dm-head"><button type="button" class="act dm-back" data-back aria-label="Back to chats">←</button>${gav(gid, "md")}<div class="mx-who"><b>${E(gname(gid))}</b><small>${((groups[gid] || {}).members || []).length} members</small></div><span class="dm-calls">${vBtn}<button type="button" class="act" data-ginfo aria-label="Group details" title="Group details">ℹ️</button></span></div>`
      : `<div class="dm-head"><button type="button" class="act dm-back" data-back aria-label="Back to chats">←</button>${av(other, "md")}<div class="mx-who"><b>${E(handle(other))}</b><small id="mx-status">${st}</small></div><span class="dm-calls">${vBtn}<button type="button" class="act" data-call aria-label="Voice call on Live" title="Voice call — opens Live">📞</button><button type="button" class="act" data-call aria-label="Video call on Live" title="Video call — opens Live">🎥</button></span></div>`;
    thread.innerHTML = `${headHtml}
<div class="dm-msgs" id="dm-msgs">${msgs.length ? html : `<div class="mx-hello">${gid ? gav(gid, "lg") : av(other, "lg")}<b>${E(gid ? gname(gid) : handle(other))}</b><span class="muted">Say hello 👋</span></div>`}
<div class="mx-msg end" id="mx-typing"${Date.now() < theyTypeUntil ? "" : " hidden"}>${gid ? gav(gid, "sm") : av(other, "sm")}<div class="mx-col"><div class="mx-bub dots"><i></i><i></i><i></i></div></div></div></div>
<div class="mx-emoji" id="mx-emoji" hidden>${["😀", "😂", "😍", "🥰", "😎", "🔥", "💯", "🙏", "👏", "💪", "🎶", "👑", "💰", "😢", "😡", "❤️"].map((e) => `<button type="button" data-emo="${e}">${e}</button>`).join("")}</div>
${qrow2 ? `<div class="mx-replybar"><span>↩ Replying to <b>${E(handle(qrow2.sender))}</b>: ${E(String(preview(qrow2)).slice(0, 60))}</span><button type="button" data-rx-cancel aria-label="Cancel reply">×</button></div>` : ""}
<form class="dm-form" id="dm-form">
  <label class="mx-tool" title="Send a photo" aria-label="Send a photo">📷<input type="file" accept="image/*" id="mx-photo" hidden></label>
  <button type="button" class="dm-walkie" id="dm-walkie" aria-label="Hold to talk (walkie-talkie)">📻</button>
  <div class="mx-in"><input type="text" id="dm-in" aria-label="Message" maxlength="2000" placeholder="Aa" autocomplete="off"><button type="button" class="mx-emo-btn" id="mx-emo" aria-label="Emoji">😊</button></div>
  <button class="mx-send" type="submit" id="mx-send" aria-label="Send">👍</button></form>`;
    const box = document.getElementById("dm-msgs"); if (box) box.scrollTop = atBottom ? box.scrollHeight : oldTop;
    const ni = document.getElementById("dm-in"); if (ni && draft) ni.value = draft; if (ni && hadFocus) ni.focus();
    if (openPick) { const col = view.querySelector(`.mx-msg[data-mid="${CSS.escape(String(openPick))}"] .mx-col`); if (col) { const pk = document.createElement("div"); pk.className = "mx-pick"; pk.dataset.for = openPick; pk.innerHTML = pickHTML(openPick); col.appendChild(pk); } }
    paintSend(); if (gid) markReadGroup(gid); else markRead();
  }
  function paintSend() { const i = document.getElementById("dm-in"), s = document.getElementById("mx-send"); if (i && s) { const has = !!i.value.trim(); s.textContent = has ? "➤" : "👍"; s.classList.toggle("go", has); s.setAttribute("aria-label", has ? "Send" : "Send a thumbs up"); } }

  function cycleVanish() {
    if (!other) return;
    const cur = vanishMs(other), nx = VANISH_STEPS[(VANISH_STEPS.indexOf(cur) + 1) % VANISH_STEPS.length];
    prefs.vanish = prefs.vanish || {};
    if (nx) prefs.vanish[other] = nx; else delete prefs.vanish[other];
    savePrefs();
    say(nx ? "⏳ Disappearing messages ON — new messages here vanish after " + (nx === 86400000 ? "24 hours" : "7 days") + ", for everyone in the chat." : "Disappearing messages off.");
    render();
  }
  function groupPicker() {
    document.getElementById("mx-group")?.remove();
    const cands = new Map();
    const F = window.MW_FRIENDS; (F && F.list ? F.list() : []).forEach((id) => cands.set(id, 1));
    convos().forEach((c) => { if (!c.group) cands.set(c.id, 1); });
    const box = document.createElement("div"); box.id = "mx-group";
    box.innerHTML = `<div class="gp"><h4>👥 New group chat</h4>
      <input type="text" id="gp-name" maxlength="60" placeholder="Group name (e.g. Family, The Shop Crew)" aria-label="Group name">
      <div>${cands.size ? [...cands.keys()].map((id) => `<label class="gm"><input type="checkbox" value="${E(id)}">${av(id, "sm")}<span>${E(handle(id))}</span></label>`).join("") : `<p class="muted">No friends or chats yet — message someone first, then start a group with them.</p>`}</div>
      <small class="muted">Up to 10 people including you. Everyone in the group sees every message.</small>
      <div class="row"><button type="button" class="btn ghost" data-gp="x">Cancel</button><button type="button" class="btn" data-gp="go">Create group</button></div></div>`;
    document.body.appendChild(box);
    box.addEventListener("click", async (e) => {
      const b = e.target.closest("[data-gp]"); if (!b) { if (e.target === box) box.remove(); return; }
      if (b.dataset.gp === "x") { box.remove(); return; }
      const name = box.querySelector("#gp-name").value.trim();
      const picked = [...box.querySelectorAll("input[type=checkbox]:checked")].map((i) => i.value);
      if (!name) { say("Give the group a name first."); return; }
      if (!picked.length) { say("Pick at least one person for the group."); return; }
      if (picked.length + 1 > 10) { say("Groups hold up to 10 people — untick a few."); return; }
      const d = DB(); if (!d) { say("Groups aren't available right now."); return; }
      const gid = "g" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
      b.disabled = true;
      try { await d.doc("groups/" + gid).set({ name, members: [uid, ...picked], owner: uid }); }
      catch (err) { say("Couldn't create the group: " + (err.message || err)); b.disabled = false; return; }
      groups[gid] = { name, members: [uid, ...picked], owner: uid };
      box.remove(); say("Group created 🎉"); open("g:" + gid);
    });
  }
  function groupInfo() {
    const gid = curGid(); if (!gid) return;
    const g = groups[gid]; if (!g) return;
    document.getElementById("mx-group")?.remove();
    const box = document.createElement("div"); box.id = "mx-group";
    const vl = vanishLabel(other);
    box.innerHTML = `<div class="gp"><h4>👥 ${E(g.name)}</h4>
      <div>${g.members.map((id) => `<div class="gm">${av(id, "sm")}<span>${E(handle(id))}${id === uid ? " (you)" : ""}${id === g.owner ? " · creator" : ""}</span></div>`).join("")}</div>
      <small class="muted">Disappearing messages here: ${vl ? "on (" + vl + ")" : "off"} — set them with the ⏱ button in the chat.</small>
      <div class="row">${g.owner === uid ? `<button type="button" class="btn ghost" data-gi="del">Delete group for everyone</button>` : ""}<button type="button" class="btn ghost" data-gi="leave">Leave group</button><button type="button" class="btn" data-gi="x">Close</button></div></div>`;
    document.body.appendChild(box);
    box.addEventListener("click", async (e) => {
      const b = e.target.closest("[data-gi]"); if (!b) { if (e.target === box) box.remove(); return; }
      if (b.dataset.gi === "x") { box.remove(); return; }
      if (b.dataset.gi === "leave") { prefs.leftGroups = [...(prefs.leftGroups || []), gid]; savePrefs(); delete groups[gid]; box.remove(); other = null; say("You left the group — it's hidden for you now."); render(); return; }
      if (b.dataset.gi === "del") { const d = DB(); if (d) { try { await d.doc("groups/" + gid).update({ members: [], deleted: true }); } catch (_) {} } delete groups[gid]; box.remove(); other = null; say("Group deleted."); render(); }
    });
  }

  function buildView() {
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
.mx-av.tiny{width:16px;height:16px;border:0}.mx-av.tiny b{font-size:9px}.mx-av.tiny .on{display:none}.mx-av.lg{width:84px;height:84px}.mx-av.lg b{font-size:32px}
.mx-av.ghost{visibility:hidden}
.dm-thread{min-height:560px;max-height:680px}
.dm-head{display:flex;align-items:center;gap:10px;padding:10px 14px;border-bottom:1px solid var(--line)}
.mx-who{display:grid}.mx-who small{color:#31d158;font-size:12px;min-height:1em}
.dm-back{display:none;font-size:20px}
.dm-msgs{flex:1;overflow:auto;padding:14px 12px;display:flex;flex-direction:column;gap:2px}
.mx-day{align-self:center;color:var(--muted);font-size:12px;margin:12px 0 6px}
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
.mx-tabs{display:flex;gap:6px}
.mx-tabs button{flex:1;background:var(--panel-2);border:1px solid var(--line);color:var(--muted);border-radius:999px;padding:7px 4px;font:700 13px var(--body);cursor:pointer;position:relative}
.mx-tabs button.on{background:var(--gold);color:#0b0a08;border-color:var(--gold)}
.mx-tab-n{position:absolute;top:-5px;right:2px;background:#e5484d;color:#fff;border-radius:999px;font:800 10px var(--body);font-style:normal;padding:1px 6px}
.dm-x{display:flex;align-items:center;gap:5px;font-size:12px;flex:none}
.dm-menu-b{cursor:pointer;font-size:19px;line-height:1;padding:2px 5px;border-radius:8px;color:var(--muted)}
.dm-menu-b:hover{background:var(--panel-2);color:var(--text)}
#mx-menu{position:fixed;z-index:10001;width:200px;background:#1d1810;border:1px solid var(--gold-lo);border-radius:14px;box-shadow:0 16px 40px rgba(0,0,0,.6);padding:6px;display:grid;gap:2px}
#mx-menu button{background:none;border:0;color:var(--text);text-align:left;font:600 14px var(--body);padding:9px 10px;border-radius:9px;cursor:pointer}
#mx-menu button:hover{background:var(--panel-2)}
.fr-row{cursor:default}.fr-acts{display:flex;gap:6px;flex:none}
.mx-replybar{display:flex;align-items:center;gap:8px;padding:7px 12px;border-top:1px solid var(--line);background:#1d1810;font-size:13px}
.mx-replybar span{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.mx-replybar button{background:none;border:0;color:var(--muted);font-size:18px;cursor:pointer}
.mx-pick{flex-wrap:wrap;max-width:262px;border-radius:18px}.mx-pick-acts{display:flex;gap:4px;width:100%;border-top:1px solid var(--line);padding-top:4px}
.mx-pick-acts button{font-size:12px!important;color:var(--gold-hi);background:var(--panel-2);border-radius:999px;padding:4px 9px}
.dm-calls{margin-left:auto;display:flex;gap:2px}.dm-calls .act{font-size:19px;background:none;border:0;cursor:pointer;padding:6px}
.dm-arch-toggle{justify-content:center;color:var(--muted);font-weight:700}
.mx-gname{font:700 11px var(--body);color:var(--gold-hi);margin:0 0 2px 4px}
.mx-av.grp{font-size:20px}.mx-av.grp.md{font-size:17px}.mx-av.grp.lg{font-size:36px}.mx-av.grp.sm{font-size:12px}
.mx-vanish{position:relative}
.mx-vanish i{position:absolute;top:-2px;right:-4px;background:var(--gold);color:#0b0a08;border-radius:999px;font:800 9px var(--body);font-style:normal;padding:1px 4px}
.dm-newgroup{justify-content:center;color:var(--gold-hi);font-weight:700;border:1px dashed var(--gold-lo);margin-bottom:6px}
#mx-group{position:fixed;inset:0;z-index:100003;display:grid;place-items:center;background:rgba(0,0,0,.65)}
#mx-group .gp{width:min(420px,calc(100vw - 28px));max-height:calc(100vh - 60px);overflow:auto;background:linear-gradient(180deg,#1d1810,#100e0a);border:1px solid var(--gold-lo);border-radius:18px;padding:16px;display:grid;gap:12px}
#mx-group h4{margin:0;color:var(--gold-hi);font-size:18px}
#mx-group input[type=text]{background:var(--ink);border:1px solid var(--line);border-radius:10px;padding:10px 12px;color:var(--text);font:inherit;width:100%}
#mx-group .gm{display:flex;align-items:center;gap:10px;padding:7px 8px;border-radius:10px;cursor:pointer}
#mx-group .gm:hover{background:var(--panel-2)}
#mx-group .gm input{width:18px;height:18px;accent-color:var(--gold)}
#mx-group .row{display:flex;gap:8px;justify-content:flex-end;flex-wrap:wrap}
@media (max-width:760px){.dm-app{grid-template-columns:1fr}.dm-app.has-thread .dm-side{display:none}.dm-app:not(.has-thread) .dm-thread{display:none}.dm-back{display:inline-block}.dm-thread{min-height:calc(100vh - 220px)}.mx-react-btn{opacity:.6}}`;
    document.head.appendChild(css);
    // the "active now" strip goes above the chat list
    const side = view.querySelector(".dm-side"); if (side && !side.querySelector(".mx-active")) { const a = document.createElement("div"); a.className = "mx-active"; side.querySelector(".dm-search").after(a); }
    if (side && !side.querySelector(".mx-tabs")) { const t = document.createElement("div"); t.className = "mx-tabs"; t.innerHTML = `<button type="button" data-tab="chats">Chats</button><button type="button" data-tab="friends">Friends</button><button type="button" data-tab="requests">Requests<i class="mx-tab-n" hidden></i></button>`; side.querySelector(".dm-search").after(t); }
    view.querySelector(".dm-search").addEventListener("input", (e) => { q = e.target.value; render(); });
    function closeMenu() { const m = document.getElementById("mx-menu"); if (m) m.remove(); }
    function openMenu(id, anchor) {
      closeMenu();
      const m = document.createElement("div"); m.id = "mx-menu";
      m.innerHTML = `<button type="button" data-mact="pin">${inList("pin", id) ? "📌 Unpin" : "📌 Pin to top"}</button><button type="button" data-mact="mute">${inList("mute", id) ? "🔔 Unmute" : "🔕 Mute notifications"}</button><button type="button" data-mact="arch">${inList("arch", id) ? "🗄 Unarchive" : "🗄 Archive"}</button>`;
      document.body.appendChild(m);
      const r = anchor.getBoundingClientRect();
      m.style.top = Math.max(8, Math.min(innerHeight - 170, r.bottom + 6)) + "px";
      m.style.left = Math.max(8, Math.min(innerWidth - 208, r.right - 200)) + "px";
      m.addEventListener("click", (ev) => { const b = ev.target.closest("[data-mact]"); if (!b) return; const act = b.dataset.mact; closeMenu(); toggleIn(act, id); if (act === "arch" && inList("arch", id) && other === id) other = null; render(); });
      setTimeout(() => document.addEventListener("click", function away(ev) { if (!ev.target.closest("#mx-menu")) { closeMenu(); document.removeEventListener("click", away, { capture: true }); } }, { capture: true }), 0);
    }
    view.addEventListener("click", async (e) => {
      const tb = e.target.closest("[data-tab]"); if (tb) { tab = tb.dataset.tab; render(); return; }
      const fa = e.target.closest("[data-facc]"); if (fa) { if (window.MW_FRIENDS && MW_FRIENDS.add) await MW_FRIENDS.add(fa.dataset.facc); say("You are now friends"); render(); return; }
      const fi = e.target.closest("[data-fign]"); if (fi) { prefs.hideReq = [...(prefs.hideReq || []), fi.dataset.fign]; savePrefs(); render(); return; }
      const mn = e.target.closest("[data-menu]"); if (mn) { e.preventDefault(); e.stopPropagation(); openMenu(mn.dataset.menu, mn); return; }
      if (e.target.closest("[data-archtoggle]")) { showArch = !showArch; render(); return; }
      if (e.target.closest("[data-call]")) { say("Opening Live — start your room there and they'll see you live"); if (typeof go === "function") go("live"); return; }
      if (e.target.closest("[data-vanish]")) { cycleVanish(); return; }
      if (e.target.closest("[data-newgroup]")) { groupPicker(); return; }
      if (e.target.closest("[data-ginfo]")) { groupInfo(); return; }
      if (e.target.closest("[data-rx-cancel]")) { replyTo = null; render(); return; }
      const rpb = e.target.closest("[data-rp]"); if (rpb) { replyTo = rpb.dataset.rp; document.querySelector(".mx-pick")?.remove(); render(); const i2 = document.getElementById("dm-in"); if (i2) i2.focus(); return; }
      const fwb = e.target.closest("[data-fw]"); if (fwb) { const row = all.find((x) => String(x.id) === String(fwb.dataset.fw)) || all.find((x) => muidOf(x) === fwb.dataset.fw); document.querySelector(".mx-pick")?.remove(); if (row && bareText(row.body)) { forwardBody = bareText(row.body); other = null; tab = "chats"; say("Pick a chat to forward it to"); render(); } return; }
      const cpb = e.target.closest("[data-cp]"); if (cpb) { const row = all.find((x) => String(x.id) === String(cpb.dataset.cp)) || all.find((x) => muidOf(x) === cpb.dataset.cp); document.querySelector(".mx-pick")?.remove(); if (row) { try { await navigator.clipboard.writeText(bareText(row.body)); say("Copied"); } catch (_) { say("Copy isn't available here"); } } return; }
      const o = e.target.closest("[data-open]"); if (o) { open(o.dataset.open); return; }
      if (e.target.closest("[data-back]")) { other = null; render(); return; }
      const em = e.target.closest("[data-emo]"); if (em) { const i = document.getElementById("dm-in"); i.value += em.dataset.emo; i.focus(); paintSend(); sendTyping(); return; }
      if (e.target.closest("#mx-emo")) { const p = document.getElementById("mx-emoji"); p.hidden = !p.hidden; return; }
      const rp = e.target.closest("[data-rpick]"); if (rp) { showPick(rp.dataset.rpick); return; }
      const rx = e.target.closest("[data-rx]"); if (rx) { const id = rx.closest(".mx-pick").dataset.for; document.querySelector(".mx-pick")?.remove(); const gid2 = curGid(); if (gid2) await fanOut(gid2, "⟦g:" + gid2 + "⟧⟦react:@" + id + ":" + rx.dataset.rx + "⟧"); else await send("⟦react:" + id + ":" + rx.dataset.rx + "⟧"); return; }
      if (!e.target.closest(".mx-pick")) document.querySelector(".mx-pick")?.remove();
    });
    // long-press (phone) or double-click a message to react
    let lp = 0; view.addEventListener("pointerdown", (e) => { const m = e.target.closest(".mx-msg[data-mid]"); if (!m || e.target.closest("audio,a,button")) return; clearTimeout(lp); lp = setTimeout(() => showPick(m.dataset.mid), 450); });
    ["pointerup", "pointerleave", "pointercancel"].forEach((ev) => view.addEventListener(ev, () => clearTimeout(lp)));
    view.addEventListener("dblclick", (e) => { const m = e.target.closest(".mx-msg[data-mid]"); if (m) showPick(m.dataset.mid); });
    function showPick(id) {
      document.querySelector(".mx-pick")?.remove();
      const m = view.querySelector(`.mx-msg[data-mid="${CSS.escape(String(id))}"] .mx-col`); if (!m) return;
      const p = document.createElement("div"); p.className = "mx-pick"; p.dataset.for = id; p.innerHTML = pickHTML(id); m.appendChild(p);
    }
    view.addEventListener("input", (e) => { if (e.target.id === "dm-in") { paintSend(); if (e.target.value.trim()) sendTyping(); } });
    view.addEventListener("submit", async (e) => {
      if (e.target.id !== "dm-form") return; e.preventDefault();
      const i = document.getElementById("dm-in"); const raw = i.value.trim(); if (!other) return;
      const rp = replyTo; replyTo = null;
      i.value = ""; paintSend(); document.getElementById("mx-emoji").hidden = true;
      const ok = curGid() ? await sendGroup(curGid(), raw || "👍", rp) : await send((rp && raw ? "⟦q:" + rp + "⟧" : "") + vPrefix(other) + (raw || "👍"));
      if (!ok && raw) i.value = raw;
      i.focus(); render();
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
        if (await sendCore("📷 Photo ⟦" + up.url + "⟧")) say("📷 Sent");
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
      try { const up = await MW.uploadMedia(new Blob(chunks, { type: mime }), { type: mime, ext }); if (await sendCore("🎙️ Voice message ⟦" + up.url + "⟧")) say("📻 Sent"); }
      catch (err) { say("Couldn't send: " + (err.message || err)); }
    };
    ["pointerup", "pointercancel"].forEach((ev) => document.addEventListener(ev, release));
    view.addEventListener("contextmenu", (e) => { if (e.target.closest("#dm-walkie, .mx-msg")) e.preventDefault(); });
  }
  buildView();
  mxAttach(render);
