/* ============================================================================
   v2 VIEW — MESSAGES (#messages). MAP §4.4: "MESSAGES (messages.js):
   dms TABLE (not docs — id, sender, recipient, body, created_at,
   read_at; sender set server-side; select limit 800 desc). Bodies carry
   prefix tags: ⟦g:<gid>⟧ ⟦m:<id>⟧ ⟦x:<expiry>⟧ ⟦q:<id>⟧ and reaction
   tails ⟦react:<id>:<emoji>⟧. Voice/photo bodies: '🎙️ Voice message
   ⟦<url>⟧' / '📷 Photo ⟦<url>⟧'. Groups = docs groups/<gid>
   {name, members, owner}; group sends fan out one dms row per member."

   The live Messenger, ported onto the shell through the shared social
   layer: same table, same tag protocol (parsed by js/social.js, the
   fixture-tested half), same groups, same local prefs key
   (mw_mx_prefs — pins, mutes, archives and vanish settings carry over
   from the live site on the same device). Two honest deviations, both
   flagged in the Phase 3 differences list: the bubble reader also
   recognizes today's /m/media/ photo+voice URLs (the live reader only
   matches the retired storage host, so fresh media DMs show as raw
   text there), and "Active now" comes from the shell's presence feed
   instead of the lobby room.
   ============================================================================ */
import { createSocial, esc, say, compress, emailHash, isEmail, bareText, quoteOf, dmPreview, dmExpired, voiceUrl, photoUrl, groupConvos, threadSplit, msgKey } from "../social.js";

const $ = (s, r) => (r || document).querySelector(s);
const $$ = (s, r) => [...(r || document).querySelectorAll(s)];
const REACTS = ["❤️", "😂", "😮", "😢", "😡", "👍"];
const VANISH_STEPS = [[0, "Off"], [864e5, "24h"], [6048e5, "7d"]];

let cur = null;
export function destroy() { if (cur) { cur.teardown(); cur = null; } }

const rel = (ts) => { if (!ts) return ""; const t = new Date(ts).getTime(), s = (Date.now() - t) / 1000; if (s < 60) return "now"; if (s < 3600) return Math.floor(s / 60) + "m"; if (s < 86400) return Math.floor(s / 3600) + "h"; if (s < 7 * 86400) return Math.floor(s / 86400) + "d"; return new Date(ts).toLocaleDateString([], { month: "numeric", day: "numeric", year: "2-digit" }); };
const dayLabel = (ts) => { const d = new Date(ts), now = new Date(), y = new Date(now); y.setDate(now.getDate() - 1); const same = (a, b) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate(); return same(d, now) ? "Today" : same(d, y) ? "Yesterday" : d.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" }); };
const clock = (ts) => new Date(ts).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
const linkify = (t) => esc(t)
  .replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1" target="_blank" rel="noopener">$1</a>')
  .replace(/(^|\s)(\+?1?[\s.-]?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4})\b/g, (m, pre, num) => pre + `<a href="tel:${num.replace(/[^+\d]/g, "")}">${num.trim()}</a>`);
const isBigEmoji = (t) => { const s = String(t || "").trim(); if (!s || s.length > 12) return false; const n = (s.match(/\p{Extended_Pictographic}/gu) || []).length; return n > 0 && n <= 8 && /^[\p{Extended_Pictographic}\s️‍]+$/u.test(s); };

export async function render(root, ctx) {
  const S = createSocial(ctx);
  const me = S.me();

  if (!me) {
    root.innerHTML = `<div class="section-head"><div><p class="kicker">Private</p><h2>Messages</h2></div></div>
    <div class="dm-join"><h3 style="margin-top:0">Join free to send private messages.</h3><p class="muted">Members message each other right here — text, photos, walkie-talkie voice and group chats.</p><a class="btn" href="/">Join free</a></div>`;
    cur = { teardown() { S.destroy(); } };
    return;
  }

  const prefs = (() => { try { return { pin: {}, mute: {}, arch: {}, hideReq: [], vanish: {}, leftGroups: [], ...JSON.parse(localStorage.getItem("mw_mx_prefs") || "{}") }; } catch (_) { return { pin: {}, mute: {}, arch: {}, hideReq: [], vanish: {}, leftGroups: [] }; } })();
  const savePrefs = () => { try { localStorage.setItem("mw_mx_prefs", JSON.stringify(prefs)); } catch (_) {} };
  const state = {
    rows: [], groups: {}, tab: "chats", open: null, showArch: false,
    replyTo: null, forward: null, theyType: false, typeTimer: null, lastTypeSent: 0,
    online: new Set(), picking: null, rec: null,
  };

  root.innerHTML = `
  <div class="section-head"><div><p class="kicker">Private</p><h2>Messages</h2></div>
  <p class="muted">Your people, one tap away.</p></div>
  <div class="dm-app">
    <aside class="dm-side">
      <input class="dm-search" data-q placeholder="Search people…" aria-label="Search people">
      <div class="mx-tabs" data-tabs></div>
      <div class="mx-active" data-active></div>
      <div class="dm-list" data-list><p class="muted" style="margin:8px 4px">Loading your messages…</p></div>
    </aside>
    <section class="dm-thread" data-thread>
      <div class="dm-empty"><div class="dm-empty-ic">💬</div><h3>Your messages</h3><p class="muted">Pick a person on the left — or start a group chat.<br>Text, photos, walkie-talkie voice notes, reactions and disappearing messages all live here.</p></div>
    </section>
  </div>`;

  await S.loadMembers();
  await S.loadLists();

  const listEl = $("[data-list]", root), threadEl = $("[data-thread]", root), tabsEl = $("[data-tabs]", root), activeEl = $("[data-active]", root);

  /* ---------------- data ------------------------------------------------ */
  async function loadRows() {
    const fresh = await S.dmLoad();
    const keep = [];
    for (const r of fresh) { if (dmExpired(r)) { S.dmDelete(r.id); continue; } keep.push(r); }
    state.rows = keep;
  }
  async function loadGroups() {
    const docs = await S.docs("groups", { limit: 200 });
    const mine = {};
    for (const g of docs) {
      if (g.deleted || prefs.leftGroups.includes(g.id)) continue;
      if (Array.isArray(g.members) && g.members.includes(me)) mine[g.id] = g;
    }
    state.groups = mine;
  }
  const groupName = (gid) => { const g = state.groups[gid]; if (!g) return "Group"; return g.name || (g.members || []).filter((x) => x !== me).map((x) => S.handleOf(x)).slice(0, 3).join(", ") || "Group"; };
  const cidOf = (c) => (c.group ? "g:" + c.gid : c.id);
  const convoList = () => {
    const cs = groupConvos(state.rows, me, state.groups);
    return cs.sort((a, b) => (prefs.pin[cidOf(b)] ? 1 : 0) - (prefs.pin[cidOf(a)] ? 1 : 0));
  };
  const rowByKey = (key, gid) => state.rows.find((r) => msgKey(r, gid) === key);

  /* ---------------- list side ------------------------------------------- */
  function paintTabs() {
    const reqN = S.friendRequests().filter((id) => !prefs.hideReq.includes(id)).length;
    tabsEl.innerHTML = [["chats", "Chats"], ["friends", "Friends"], ["requests", "Requests" + (reqN ? ` <span class="mx-reqct">${reqN}</span>` : "")]]
      .map(([k, l]) => `<button type="button" class="${state.tab === k ? "on" : ""}" data-tab="${k}">${l}</button>`).join("");
  }
  function paintActive() {
    const ids = [...state.online].filter((id) => id !== me && S.members[id]).slice(0, 12);
    activeEl.innerHTML = ids.length ? `<div class="mx-active-h">Active now</div>` + ids.map((id) => `<button type="button" data-open="${esc(id)}">${S.avatarOf(id)}<span>${esc((S.handleOf(id) || "").split(" ")[0])}</span></button>`).join("") : "";
  }
  function convoRow(c) {
    const cid = cidOf(c), last = c.last, mineLast = last.sender === me;
    const name = c.group ? groupName(c.gid) : S.handleOf(c.id);
    const av = c.group ? `<span class="avatar grp">👥</span>` : S.avatarOf(c.id);
    const on = !c.group && state.online.has(c.id);
    return `<div class="dm-rowwrap"><button type="button" class="dm-row${state.open && state.open.cid === cid ? " on" : ""}${c.unread ? " unread" : ""}" data-open="${esc(cid)}">
      <span class="mx-av">${av}${on ? `<span class="on"></span>` : ""}</span>
      <span class="dm-t"><b>${esc(name)}${prefs.pin[cid] ? " 📌" : ""}${prefs.mute[cid] ? " 🔕" : ""}</b>
      <small class="${c.unread ? "un" : ""}">${mineLast ? "You: " : ""}${esc(dmPreview(last))} · ${rel(last.created_at)}</small></span>
      ${c.unread ? `<span class="dm-unread">${c.unread}</span>` : ""}</button>
      <button type="button" class="dm-kebab" data-menu="${esc(cid)}" aria-label="Chat options">⋯</button></div>`;
  }
  function paintList() {
    paintTabs(); paintActive();
    if (state.tab === "friends") {
      const ids = S.friendIds();
      listEl.innerHTML = ids.length ? ids.map((id) => `<button type="button" class="dm-row" data-open="${esc(id)}">${S.avatarOf(id)}<span class="dm-t"><b>${esc(S.handleOf(id))}</b><small>Friends · tap to message</small></span></button>`).join("") : `<p class="muted" style="margin:8px 4px">No friends yet — add people in Friends and they'll show up here.</p>`;
      return;
    }
    if (state.tab === "requests") {
      const ids = S.friendRequests().filter((id) => !prefs.hideReq.includes(id));
      listEl.innerHTML = ids.length ? ids.map((id) => `<div class="dm-rowwrap"><span class="dm-row">${S.avatarOf(id)}<span class="dm-t"><b>${esc(S.handleOf(id))}</b><small>wants to be friends</small></span></span><span class="mx-reqbtns"><button type="button" class="btn sm" data-acc="${esc(id)}">Accept</button><button type="button" class="btn ghost sm" data-ign="${esc(id)}">Ignore</button></span></div>`).join("") : `<p class="muted" style="margin:8px 4px">No friend requests right now.</p>`;
      return;
    }
    const cs = convoList();
    const vis = cs.filter((c) => state.showArch ? prefs.arch[cidOf(c)] : !prefs.arch[cidOf(c)]);
    const archN = cs.filter((c) => prefs.arch[cidOf(c)]).length;
    listEl.innerHTML = `<button type="button" class="dm-row grp" data-newgroup><span class="avatar grp">👥</span><span class="dm-t"><b>Start a group chat</b><small>Message a few friends at once</small></span></button>`
      + (vis.length ? vis.map(convoRow).join("") : `<p class="muted" style="margin:8px 4px">No chats yet. Search for a friend above and say hello.</p>`)
      + (archN ? `<button type="button" class="dm-arch-t" data-archt>${state.showArch ? "Hide" : "Show"} archived (${archN})</button>` : "");
  }

  /* ---------------- thread ---------------------------------------------- */
  let typeRoom = null;
  const vanishMs = (cid) => +prefs.vanish[cid] || 0;
  const vanishLabel = (cid) => { const i = VANISH_STEPS.findIndex(([ms]) => ms === vanishMs(cid)); return VANISH_STEPS[Math.max(0, i)][1]; };

  function quotedHtml(r, gid) {
    const q = quoteOf(r.body); if (!q) return "";
    const t = rowByKey(q, gid); if (!t) return "";
    return `<span class="mx-quote"><b>${esc(S.handleOf(t.sender))}</b>${esc(dmPreview(t).slice(0, 90))}</span>`;
  }
  function bubble(r, gid, reacts) {
    const b = bareText(r.body), vu = voiceUrl(b), pu = photoUrl(b), key = msgKey(r, gid);
    let inner = quotedHtml(r, gid);
    if (vu) inner += `<span class="mx-voice">🎙️ Walkie</span><audio controls src="${esc(vu)}" preload="metadata"></audio>`;
    else if (pu) inner += `<a href="${esc(pu)}" target="_blank" rel="noopener"><img class="mx-photo" src="${esc(pu)}" alt="Photo"></a>`;
    else if (b) inner += `<span class="mx-tx${isBigEmoji(b) ? " big" : ""}">${linkify(b)}</span>`;
    const rx = reacts[key] || {};
    const rxHtml = Object.keys(rx).length ? `<span class="mx-reacts">${[...new Map(Object.values(rx).map((e) => [e, (Object.values(rx).filter((x) => x === e).length)])).entries()].map(([e, n]) => `<span class="rx">${e}${n > 1 ? " " + n : ""}</span>`).join("")}</span>` : "";
    return inner + rxHtml;
  }
  function paintMsgs() {
    const box = $("[data-msgs]", root); if (!box || !state.open) return;
    const { uid, gid } = state.open;
    const { msgs, reacts } = threadSplit(state.rows, me, uid, gid);
    const seenMine = new Set(), list = [];
    for (const r of msgs) { if (gid && r.sender === me) { const k = msgKey(r, gid); if (seenMine.has(k)) continue; seenMine.add(k); } list.push(r); }
    let html = "", prev = null, prevSender = null, lastReadMine = null;
    for (const r of list) {
      if (r.sender === me && r.read_at) lastReadMine = r;
      const t = new Date(r.created_at).getTime();
      if (!prev || t - prev > 3600e3 || dayLabel(r.created_at) !== dayLabel(new Date(prev).toISOString())) html += `<div class="mx-day">${dayLabel(r.created_at)} · ${clock(r.created_at)}</div>`;
      const mine = r.sender === me;
      const showWho = gid && !mine && r.sender !== prevSender;
      html += `<div class="mx-row ${mine ? "mine" : "them"}">${!mine ? S.avatarOf(r.sender) : ""}<div class="mx-msg" data-mid="${esc(msgKey(r, gid))}">${showWho ? `<span class="mx-who">${esc(S.handleOf(r.sender))}</span>` : ""}${bubble(r, gid, reacts)}</div></div>`;
      if (!gid && lastReadMine === r) html += `<div class="mx-seen">${S.avatarOf(uid)}<span>Seen</span></div>`;
      prev = t; prevSender = r.sender;
    }
    const nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 160;
    box.innerHTML = html || `<div class="dm-empty"><p class="muted">No messages yet — say hello 👋</p></div>`;
    if (nearBottom || !box.dataset.once) { box.scrollTop = box.scrollHeight; box.dataset.once = "1"; }
  }
  function paintThreadHead() {
    const st = $("[data-tstatus]", root); if (!st || !state.open) return;
    if (state.theyType) st.textContent = "typing…";
    else if (!state.open.gid && state.online.has(state.open.uid)) st.textContent = "Active now";
    else st.textContent = "";
  }
  function openConvo(cid) {
    closeMenu(); closeMsgMenu();
    const isG = cid.startsWith("g:");
    state.open = isG ? { cid, gid: cid.slice(2) } : { cid, uid: cid };
    state.replyTo = null;
    if (typeRoom) { typeRoom.leave(); typeRoom = null; state.theyType = false; }
    if (!isG) {
      S.dmMarkRead(state.open.uid);
      state.rows.forEach((r) => { if (r.sender === state.open.uid && r.recipient === me) r.read_at = r.read_at || new Date().toISOString(); });
      typeRoom = S.bus.room("mx-typing:" + [me, state.open.uid].sort().join(":"));
      typeRoom.onBroadcast("typing", ({ payload }) => {
        if (payload && payload.from === state.open.uid) {
          state.theyType = true; paintThreadHead();
          clearTimeout(state.typeTimer); state.typeTimer = setTimeout(() => { state.theyType = false; paintThreadHead(); }, 4000);
        }
      });
    }
    const name = isG ? groupName(state.open.gid) : S.handleOf(state.open.uid);
    const av = isG ? `<span class="avatar grp">👥</span>` : S.avatarOf(state.open.uid);
    threadEl.innerHTML = `
      <div class="dm-thead">
        <button type="button" class="dm-back" data-back aria-label="Back">‹</button>
        ${av}<div class="dm-tname"><b>${esc(name)}</b><small data-tstatus></small></div>
        <span class="dm-tsp"></span>
        <button type="button" class="dm-tbtn" data-vanish title="Disappearing messages">⏱ ${vanishLabel(cid)}</button>
        <button type="button" class="dm-tbtn" data-call title="Voice call">📞</button>
        <button type="button" class="dm-tbtn" data-call title="Video call">🎥</button>
        ${isG ? `<button type="button" class="dm-tbtn" data-ginfo title="Group info">ⓘ</button>` : ""}
      </div>
      <div class="dm-msgs" data-msgs></div>
      <div class="mx-qbar" data-qbar hidden><span data-qtxt></span><button type="button" data-qx aria-label="Cancel reply">✕</button></div>
      <div class="dm-input">
        <label class="dm-ph" title="Send a photo">📷<input type="file" accept="image/*" hidden data-photo></label>
        <form class="dm-form" data-form><input data-in maxlength="2000" placeholder="Aa" aria-label="Message" autocomplete="off"><button type="submit" class="dm-send" aria-label="Send">➤</button></form>
        <button type="button" class="dm-walk" data-walk title="Hold to talk">🎙️</button>
      </div>`;
    root.classList.add("thread-open");
    paintList(); paintMsgs(); paintThreadHead();
    const inp = $("[data-in]", root); if (inp) inp.focus();
  }
  function closeThread() {
    state.open = null;
    if (typeRoom) { typeRoom.leave(); typeRoom = null; }
    threadEl.innerHTML = `<div class="dm-empty"><div class="dm-empty-ic">💬</div><h3>Your messages</h3><p class="muted">Pick a person on the left — or start a group chat.</p></div>`;
    root.classList.remove("thread-open");
    paintList();
  }

  /* ---------------- sending ---------------------------------------------- */
  async function sendCore(makeBody) {
    const o = state.open; if (!o) return;
    if (!o.gid) { await S.dmInsert(o.uid, makeBody(null)); return; }
    const g = state.groups[o.gid]; if (!g) throw new Error("This group is gone.");
    const muid = "m" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
    const targets = (g.members || []).filter((x) => x !== me).slice(0, 10);
    for (const t of targets) await S.dmInsert(t, makeBody(muid));
  }
  const withTags = (raw) => {
    const o = state.open; const v = vanishMs(o.cid);
    let pre = v ? `⟦x:${Date.now() + v}⟧` : "";
    if (state.replyTo && raw) pre += `⟦q:${state.replyTo}⟧`;
    return pre + raw;
  };
  async function sendText() {
    const inp = $("[data-in]", root); if (!inp || !state.open) return;
    const raw = inp.value.trim();
    if (!raw && !state.replyTo) { /* an empty send is a thumbs-up, like the live box */
      try { await sendCore((muid) => (muid ? `⟦g:${state.open.gid}⟧⟦m:${muid}⟧` : "") + withTags("👍")); } catch (e) { say(e.message); }
      afterSend(); return;
    }
    if (!raw) return;
    const gidPart = (muid) => (muid ? `⟦g:${state.open.gid}⟧⟦m:${muid}⟧` : "");
    try { await sendCore((muid) => gidPart(muid) + withTags(raw)); inp.value = ""; afterSend(); }
    catch (e) { say(e.message); }
  }
  async function afterSend() {
    state.replyTo = null; paintQbar();
    await loadRows(); paintList(); paintMsgs();
  }
  function paintQbar() {
    const bar = $("[data-qbar]", root); if (!bar) return;
    if (!state.replyTo) { bar.hidden = true; return; }
    const t = rowByKey(state.replyTo, state.open.gid);
    $("[data-qtxt]", root).textContent = t ? "Replying to " + S.handleOf(t.sender) + ": " + dmPreview(t).slice(0, 60) : "Replying to a message";
    bar.hidden = false;
  }

  /* ---------------- message actions (react / reply / forward / copy) ----- */
  let msgMenu = null, menuRow = null;
  function closeMsgMenu() { if (msgMenu) { msgMenu.remove(); msgMenu = null; menuRow = null; } }
  function openMsgMenu(el, key) {
    closeMsgMenu();
    menuRow = rowByKey(key, state.open && state.open.gid); if (!menuRow) return;
    msgMenu = document.createElement("div"); msgMenu.className = "mx-menu";
    msgMenu.innerHTML = `<div class="mx-mreacts">${REACTS.map((e) => `<button type="button" data-mr="${e}">${e}</button>`).join("")}</div>
      <button type="button" data-ma="reply">↩️ Reply</button><button type="button" data-ma="forward">↪️ Forward</button><button type="button" data-ma="copy">📋 Copy</button>`;
    document.body.appendChild(msgMenu);
    const r = el.getBoundingClientRect();
    msgMenu.style.left = Math.max(6, Math.min(innerWidth - 210, r.left)) + "px";
    msgMenu.style.top = Math.max(6, r.top - msgMenu.offsetHeight - 8 + scrollY) + "px";
    if (r.top - msgMenu.offsetHeight - 8 < 0) msgMenu.style.top = (r.bottom + scrollY + 8) + "px";
  }

  /* ---------------- convo kebab menu (pin / mute / archive) -------------- */
  let kebab = null, kebabCid = null;
  function closeMenu() { if (kebab) { kebab.remove(); kebab = null; kebabCid = null; } }
  function openKebab(btn, cid) {
    closeMenu(); kebabCid = cid;
    kebab = document.createElement("div"); kebab.className = "mx-kebab";
    kebab.innerHTML = `
      <button type="button" data-k="pin">${prefs.pin[cid] ? "📌 Unpin" : "📌 Pin to top"}</button>
      <button type="button" data-k="mute">${prefs.mute[cid] ? "🔔 Unmute" : "🔕 Mute notifications"}</button>
      <button type="button" data-k="arch">${prefs.arch[cid] ? "📥 Unarchive" : "🗄️ Archive"}</button>`;
    document.body.appendChild(kebab);
    const r = btn.getBoundingClientRect();
    kebab.style.top = (r.bottom + scrollY + 4) + "px";
    kebab.style.left = Math.max(6, Math.min(innerWidth - 200, r.right - 190)) + "px";
  }

  /* ---------------- groups ------------------------------------------------ */
  function openPicker(mode, gid) {
    /* candidates, the live way: my friends + people I already chat with */
    const candSet = new Set([...S.friendIds(), ...convoList().filter((c) => !c.group).map((c) => c.id), ...(mode === "add" ? Object.keys(S.members).filter((id) => id !== me) : [])]);
    const friendsFirst = [...candSet];
    threadEl.innerHTML = `<div class="mx-picker">
      <div class="dm-thead"><button type="button" class="dm-back" data-back aria-label="Back">‹</button><div class="dm-tname"><b>${mode === "add" ? "Add people" : "👥 New group chat"}</b><small>Up to 10 people including you. Everyone in the group sees every message.</small></div></div>
      ${mode === "create" ? `<input type="text" class="dm-search" data-gname maxlength="60" placeholder="Group name (e.g. Family, The Shop Crew)" aria-label="Group name" style="margin:10px 12px 0">` : ""}
      <div class="mx-picklist">${friendsFirst.length ? friendsFirst.map((id) => `<label class="mx-pickrow"><input type="checkbox" value="${esc(id)}">${S.avatarOf(id)}<span><b>${esc(S.handleOf(id))}</b>${S.members[id] && S.members[id].bio ? `<small>${esc(S.members[id].bio)}</small>` : ""}</span></label>`).join("") : `<p class="muted" style="margin:10px 12px">No friends or chats yet — message someone first, then start a group with them.</p>`}</div>
      <div class="mx-pickfoot"><button type="button" class="btn ghost" data-pcancel>Cancel</button><button type="button" class="btn" data-pcreate>${mode === "add" ? "Add" : "Create group"}</button></div></div>`;
    root.classList.add("thread-open");
    $("[data-pcancel]", threadEl).addEventListener("click", () => { gid && state.groups[gid] ? openConvo("g:" + gid) : closeThread(); });
    $("[data-pcreate]", threadEl).addEventListener("click", async () => {
      const picked = $$(".mx-picklist input:checked", threadEl).map((i) => i.value);
      if (mode === "add") {
        if (!picked.length) return say("Pick at least one person.");
        const g = state.groups[gid];
        try { await S.mergeDoc("groups/" + gid, { members: [...new Set([...(g.members || []), ...picked])] }); say("Added 🎉"); await loadGroups(); openConvo("g:" + gid); }
        catch (e) { say(e.message); }
        return;
      }
      const name = ($("[data-gname]", threadEl).value || "").trim();
      if (!name) return say("Give the group a name first.");
      if (!picked.length) return say("Pick at least one person for the group.");
      if (picked.length + 1 > 10) return say("Groups hold up to 10 people — untick a few.");
      const ngid = "g" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
      try { await S.setDoc("groups/" + ngid, { name, members: [me, ...picked], owner: me }); await loadGroups(); say("Group created 🎉"); openConvo("g:" + ngid); paintList(); }
      catch (e) { say(e.message); }
    });
  }
  function openGroupInfo(gid) {
    const g = state.groups[gid]; if (!g) return;
    threadEl.innerHTML = `<div class="mx-picker">
      <div class="dm-thead"><button type="button" class="dm-back" data-gback aria-label="Back">‹</button><div class="dm-tname"><b>${esc(groupName(gid))}</b><small>${(g.members || []).length} people</small></div></div>
      <div class="mx-picklist">${(g.members || []).map((id) => `<div class="mx-pickrow">${S.avatarOf(id)}<span><b>${esc(S.handleOf(id))}</b>${id === g.owner ? `<small>Group owner</small>` : ""}</span></div>`).join("")}</div>
      <div class="mx-pickfoot" style="flex-wrap:wrap">
        <button type="button" class="btn ghost" data-gadd>Add people</button>
        <button type="button" class="btn ghost" data-gleave>Leave group</button>
        ${g.owner === me ? `<button type="button" class="btn ghost" data-gdel>Delete group</button>` : ""}
      </div></div>`;
    $("[data-gback]", threadEl).addEventListener("click", () => openConvo("g:" + gid));
    $("[data-gadd]", threadEl).addEventListener("click", () => openPicker("add", gid));
    $("[data-gleave]", threadEl).addEventListener("click", async () => {
      try { await S.mergeDoc("groups/" + gid, { members: (g.members || []).filter((x) => x !== me) }); prefs.leftGroups.push(gid); savePrefs(); delete state.groups[gid]; say("You left the group."); closeThread(); paintList(); }
      catch (e) { say(e.message); }
    });
    const del = $("[data-gdel]", threadEl);
    if (del) del.addEventListener("click", async () => {
      if (del.dataset.arm) { try { await S.mergeDoc("groups/" + gid, { members: [], deleted: true }); delete state.groups[gid]; say("Group deleted."); closeThread(); paintList(); } catch (e) { say(e.message); } }
      else { del.dataset.arm = "1"; del.textContent = "Tap again — deletes it for everyone"; }
    });
  }

  /* ---------------- events ------------------------------------------------ */
  const docClick = (e) => { if (msgMenu && !e.target.closest(".mx-menu") && !e.target.closest(".mx-msg")) closeMsgMenu(); if (kebab && !e.target.closest(".mx-kebab") && !e.target.closest("[data-menu]")) closeMenu(); };
  document.addEventListener("click", docClick);

  function paintForwardList() {
    const cs = convoList().filter((c) => !prefs.arch[cidOf(c)]);
    listEl.innerHTML = `<p class="muted" style="margin:8px 4px">↪️ Forward to… <button type="button" class="btn ghost sm" data-fcancel>Cancel</button></p>`
      + cs.map((c) => `<button type="button" class="dm-row" data-fwd="${esc(cidOf(c))}">${c.group ? `<span class="avatar grp">👥</span>` : S.avatarOf(c.id)}<span class="dm-t"><b>${esc(c.group ? groupName(c.gid) : S.handleOf(c.id))}</b></span></button>`).join("");
  }
  async function doForward(cid) {
    const raw = state.forward; state.forward = null; if (!raw) return;
    try {
      if (cid.startsWith("g:")) {
        const g = state.groups[cid.slice(2)]; if (!g) throw new Error("That group is gone.");
        const muid = "m" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
        for (const t of (g.members || []).filter((x) => x !== me).slice(0, 10)) await S.dmInsert(t, `⟦g:${cid.slice(2)}⟧⟦m:${muid}⟧` + raw);
      } else await S.dmInsert(cid, raw);
      say("Forwarded ↪️");
    } catch (e) { say(e.message); }
    await loadRows(); paintList();
  }

  root.addEventListener("click", async (e) => {
    const t = e.target;
    const tab = t.closest("[data-tab]"); if (tab) { state.tab = tab.dataset.tab; state.forward = null; paintList(); return; }
    const acc = t.closest("[data-acc]");
    if (acc) { const id = acc.dataset.acc; await S.ensureList("friends"); await S.setList("friends", [...(S.friends[me] || []), id]); say("You and " + S.handleOf(id) + " are friends now 🎉"); await S.loadLists(); paintList(); return; }
    const ign = t.closest("[data-ign]"); if (ign) { prefs.hideReq.push(ign.dataset.ign); savePrefs(); paintList(); return; }
    if (t.closest("[data-archt]")) { state.showArch = !state.showArch; paintList(); return; }
    if (t.closest("[data-newgroup]")) { openPicker("create"); return; }
    const kb = t.closest("[data-menu]"); if (kb) { openKebab(kb, kb.dataset.menu); return; }
    const kAct = t.closest("[data-k]");
    if (kAct && kebabCid) { const cid = kebabCid, k = kAct.dataset.k; if (k === "pin") prefs.pin[cid] = !prefs.pin[cid]; if (k === "mute") prefs.mute[cid] = !prefs.mute[cid]; if (k === "arch") prefs.arch[cid] = !prefs.arch[cid]; savePrefs(); closeMenu(); paintList(); return; }
    const fw = t.closest("[data-fwd]"); if (fw) { doForward(fw.dataset.fwd); return; }
    if (t.closest("[data-fcancel]")) { state.forward = null; paintList(); return; }
    const op = t.closest("[data-open]"); if (op) { openConvo(op.dataset.open); return; }
    /* thread buttons */
    if (t.closest("[data-back]")) { if (state.open) closeThread(); else closeThread(); return; }
    if (t.closest("[data-ginfo]") && state.open && state.open.gid) { openGroupInfo(state.open.gid); return; }
    const vn = t.closest("[data-vanish]");
    if (vn && state.open) { const cid = state.open.cid; const curI = VANISH_STEPS.findIndex(([ms]) => ms === vanishMs(cid)); const next = VANISH_STEPS[(Math.max(0, curI) + 1) % VANISH_STEPS.length]; prefs.vanish[cid] = next[0]; savePrefs(); vn.textContent = "⏱ " + next[1]; say(next[0] ? "Disappearing messages: on (" + next[1] + ") for this chat ⏱" : "Disappearing messages: off"); return; }
    if (t.closest("[data-call]")) { say("Calls ring through the Live studio — that surface arrives in a later phase."); return; }
    if (t.closest("[data-qx]")) { state.replyTo = null; paintQbar(); return; }
    const mr = t.closest("[data-mr]");
    if (mr && menuRow && state.open) {
      const gid = state.open.gid, target = gid ? (msgKey(menuRow, gid)) : String(menuRow.id);
      const body = gid ? `⟦g:${gid}⟧⟦react:@${target}:${mr.dataset.mr}⟧` : `⟦react:${target}:${mr.dataset.mr}⟧`;
      closeMsgMenu();
      try {
        if (gid) { const g = state.groups[gid]; for (const tt of (g.members || []).filter((x) => x !== me).slice(0, 10)) await S.dmInsert(tt, body); }
        else await S.dmInsert(state.open.uid, body);
        await loadRows(); paintMsgs();
      } catch (err) { say(err.message); }
      return;
    }
    const ma = t.closest("[data-ma]");
    if (ma && menuRow) {
      const act = ma.dataset.ma, row = menuRow; closeMsgMenu();
      if (act === "reply") { state.replyTo = msgKey(row, state.open && state.open.gid); paintQbar(); const inp = $("[data-in]", root); if (inp) inp.focus(); }
      if (act === "copy") { try { await navigator.clipboard.writeText(bareText(row.body)); say("Copied 📋"); } catch (_) { say("Couldn't copy on this device."); } }
      if (act === "forward") { state.forward = bareText(row.body); paintForwardList(); }
      return;
    }
  });

  /* long-press / double-click a bubble → the action menu */
  let pressT = null;
  threadEl.addEventListener("pointerdown", (e) => { const m = e.target.closest(".mx-msg"); if (!m) return; clearTimeout(pressT); pressT = setTimeout(() => openMsgMenu(m, m.dataset.mid), 450); });
  ["pointerup", "pointerleave", "pointercancel"].forEach((ev) => threadEl.addEventListener(ev, () => clearTimeout(pressT)));
  threadEl.addEventListener("dblclick", (e) => { const m = e.target.closest(".mx-msg"); if (m) openMsgMenu(m, m.dataset.mid); });

  threadEl.addEventListener("submit", (e) => { if (e.target.closest("[data-form]")) { e.preventDefault(); sendText(); } });
  threadEl.addEventListener("input", (e) => {
    if (!e.target.closest("[data-in]")) return;
    if (typeRoom && Date.now() - state.lastTypeSent > 2000) { state.lastTypeSent = Date.now(); typeRoom.send("typing", { from: me }); }
  });
  threadEl.addEventListener("change", async (e) => {
    const inp = e.target.closest("[data-photo]"); if (!inp) return;
    const f = inp.files[0]; inp.value = ""; if (!f || !state.open) return;
    try {
      const d = await compress(f, 1400); const blob = await (await fetch(d)).blob();
      const up = await S.uploadMedia(blob, { type: "image/jpeg", ext: "jpg" });
      const raw = "📷 Photo ⟦" + up.url + "⟧", v = vanishMs(state.open.cid), pre = v ? `⟦x:${Date.now() + v}⟧` : "";
      await sendCore((muid) => (muid ? `⟦g:${state.open.gid}⟧⟦m:${muid}⟧` : "") + pre + raw);
      afterSend();
    } catch (err) { say(err.message); }
  });

  /* walkie-talkie: hold to talk, let go to send */
  const walkBtn = () => $("[data-walk]", root);
  async function startRec() {
    const btn = walkBtn(); if (!btn || state.rec || !state.open) return;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mime = ["audio/webm;codecs=opus", "audio/mp4", "audio/webm"].find((m) => window.MediaRecorder && MediaRecorder.isTypeSupported(m)) || "";
      const rec = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
      const chunks = [], t0 = Date.now();
      rec.ondataavailable = (ev) => ev.data.size && chunks.push(ev.data);
      rec.onstop = async () => {
        stream.getTracks().forEach((tr) => tr.stop());
        const held = Date.now() - t0; state.rec = null;
        const b2 = walkBtn(); if (b2) { b2.classList.remove("rec"); b2.textContent = "🎙️"; }
        if (held < 500 || !chunks.length) { if (held >= 120) say("Hold a little longer to send a voice note."); return; }
        const blob = new Blob(chunks, { type: rec.mimeType || "audio/webm" });
        try {
          const up = await S.uploadMedia(blob, { type: blob.type });
          const raw = "🎙️ Voice message ⟦" + up.url + "⟧", v = vanishMs(state.open.cid), pre = v ? `⟦x:${Date.now() + v}⟧` : "";
          await sendCore((muid) => (muid ? `⟦g:${state.open.gid}⟧⟦m:${muid}⟧` : "") + pre + raw);
          afterSend();
        } catch (err) { say(err.message); }
      };
      state.rec = rec; rec.start();
      btn.classList.add("rec"); btn.textContent = "🔴";
    } catch (_) { say("Mic is blocked — allow the microphone to send voice notes."); }
  }
  function stopRec() { if (state.rec && state.rec.state !== "inactive") state.rec.stop(); }
  threadEl.addEventListener("pointerdown", (e) => { if (e.target.closest("[data-walk]")) { e.preventDefault(); startRec(); } });
  threadEl.addEventListener("pointerup", (e) => { if (e.target.closest("[data-walk]")) stopRec(); });
  threadEl.addEventListener("pointerleave", (e) => { if (e.target.closest("[data-walk]")) stopRec(); });

  /* search: names, or an exact email (find-by-email) */
  let searchTimer = null;
  $("[data-q]", root).addEventListener("input", (e) => {
    const v = e.target.value.trim();
    clearTimeout(searchTimer);
    searchTimer = setTimeout(async () => {
      if (!v) { paintList(); return; }
      let ids;
      if (isEmail(v)) { const h = await emailHash(v); ids = Object.keys(S.members).filter((id) => S.members[id] && S.members[id].emailHash === h); }
      else ids = Object.keys(S.members).filter((id) => id !== me && (S.handleOf(id) || "").toLowerCase().includes(v.toLowerCase())).slice(0, 15);
      if ($("[data-q]", root).value.trim() !== v) return;
      listEl.innerHTML = ids.length ? ids.map((id) => `<button type="button" class="dm-row" data-open="${esc(id)}">${S.avatarOf(id)}<span class="dm-t"><b>${esc(S.handleOf(id))}</b><small>${isEmail(v) ? "Found by email · tap to message" : "Tap to message"}</small></span></button>`).join("") : `<p class="muted" style="margin:10px 4px">${isEmail(v) ? "Nobody on Meechie's World has that email (or they turned off \"find me by email\")." : "Nobody matches that name."}</p>`;
    }, 300);
  });

  /* ---------------- refresh + presence ------------------------------------ */
  let dmTimer = null;
  const refreshDm = () => {
    clearTimeout(dmTimer);
    dmTimer = setTimeout(async () => {
      await loadRows();
      if (state.open && !state.open.gid) {
        const o = state.open.uid;
        if (state.rows.some((r) => r.sender === o && r.recipient === me && !r.read_at)) {
          S.dmMarkRead(o);
          state.rows.forEach((r) => { if (r.sender === o && r.recipient === me) r.read_at = r.read_at || new Date().toISOString(); });
        }
      }
      paintList(); if (state.open) paintMsgs();
    }, 400);
  };
  S.bus.watch(null, (row) => { if (row && row.tbl === "dms") refreshDm(); });
  S.bus.watch(["groups"], async () => { await loadGroups(); paintList(); });
  const presenceTimer = setInterval(() => {
    const last = ctx.presence.last;
    if (last && Array.isArray(last.users)) { state.online = new Set(last.users.map((u) => u.uid).filter(Boolean)); paintActive(); paintThreadHead(); }
  }, 15000);
  if (ctx.presence.last && Array.isArray(ctx.presence.last.users)) state.online = new Set(ctx.presence.last.users.map((u) => u.uid).filter(Boolean));

  /* ---------------- first paint + handed-off target ----------------------- */
  await loadRows(); await loadGroups();
  paintList();
  try {
    const target = sessionStorage.getItem("mw2-dm-target");
    if (target) {
      sessionStorage.removeItem("mw2-dm-target");
      openConvo(target);
      if (sessionStorage.getItem("mw2-dm-walkie")) { sessionStorage.removeItem("mw2-dm-walkie"); say("Hold the 🎙️ button to talk — let go to send."); }
    }
  } catch (_) {}

  cur = {
    teardown() {
      document.removeEventListener("click", docClick);
      clearInterval(presenceTimer); clearTimeout(dmTimer); clearTimeout(state.typeTimer); clearTimeout(pressT);
      if (state.rec && state.rec.state !== "inactive") try { state.rec.stop(); } catch (_) {}
      closeMsgMenu(); closeMenu();
      S.destroy();
    },
  };
}
